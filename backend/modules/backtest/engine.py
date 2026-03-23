"""Vectorized backtesting engine.

Uses a direction-based state machine (None → long / short) that enters
the appropriate leg structure when a directional signal fires and exits
on reversal, general exits, target/stop/time conditions.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

import numpy as np


class _NumpyEncoder(json.JSONEncoder):
    """Serialize numpy scalar types that the stdlib encoder chokes on."""
    def default(self, obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


def _dumps(obj) -> str:
    return json.dumps(obj, cls=_NumpyEncoder)
import pandas as pd
import vectorbt as vbt

from db import get_conn
from modules.strategy.models import StrategyRecipe, OptionStructure, ExitType
from modules.strategy.builder import compile_direction_signal, compile_exit_signals, compile_exit_indicator_signals
from modules.backtest.options_pnl import price_option, simulate_leg_pnl
from modules.backtest.metrics import compute_all_metrics

log = logging.getLogger(__name__)

NIFTY_LOT_SIZE = 25
BANKNIFTY_LOT_SIZE = 15
LOT_SIZES = {"NIFTY": 25, "BANKNIFTY": 15, "FINNIFTY": 25, "SENSEX": 10}
STRIKE_GAP = {"NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "SENSEX": 100}


def _resolve_strike(spot: float, strike_ref: str, underlying: str) -> float:
    """Convert 'ATM+2' style reference to an actual strike price."""
    gap = STRIKE_GAP.get(underlying, 50)
    atm = round(spot / gap) * gap

    offset_str = strike_ref.replace("ATM", "").replace("+", "")
    try:
        offset = int(offset_str)
    except ValueError:
        offset = 0

    return atm + offset * gap


def _bars_per_day(interval: str) -> int:
    mapping = {"minute": 375, "5minute": 75, "15minute": 25, "day": 1}
    return mapping.get(interval, 25)


def run_backtest(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
    initial_capital: float = 100_000,
    interval: str = "15minute",
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> dict:
    """Run a full backtest: direction signals → trade simulation → metrics."""
    direction_signal = compile_direction_signal(recipe, df, param_overrides, interval_dfs)
    general_exits = compile_exit_signals(recipe, df, param_overrides, interval_dfs)
    ind_exits = compile_exit_indicator_signals(recipe, df, param_overrides, interval_dfs)
    long_exit_signal  = ind_exits["long_exit"]
    short_exit_signal = ind_exits["short_exit"]

    lot_size = LOT_SIZES.get(recipe.underlying, 25)
    bpd = _bars_per_day(interval)

    target_pct       = None
    stop_pct         = None
    trailing_stop_pct = None
    max_bars         = None

    for ec in recipe.exit_conditions:
        if ec.type == ExitType.TARGET_PCT and ec.value is not None:
            target_pct = float(ec.value) / 100
        elif ec.type == ExitType.STOP_PCT and ec.value is not None:
            stop_pct = float(ec.value) / 100
        elif ec.type == ExitType.TRAILING_STOP_PCT and ec.value is not None:
            trailing_stop_pct = float(ec.value) / 100
        elif ec.type == ExitType.MAX_HOLDING_BARS and ec.value is not None:
            max_bars = int(ec.value)

    # Apply param_overrides for exit conditions (optimizer sweep support).
    # Keys: "exit.target_pct", "exit.stop_pct", "exit.trailing_stop_pct".
    # Values are percentages (e.g. 50 means 50%), consistent with recipe storage.
    _ov = param_overrides or {}
    if "exit.target_pct" in _ov:
        target_pct = float(_ov["exit.target_pct"]) / 100
    if "exit.stop_pct" in _ov:
        stop_pct = float(_ov["exit.stop_pct"]) / 100
    if "exit.trailing_stop_pct" in _ov:
        trailing_stop_pct = float(_ov["exit.trailing_stop_pct"]) / 100

    close = df["close"].values
    trades = []
    equity = [initial_capital]
    current_capital = initial_capital

    active_dir: str | None = None  # "long" or "short"
    entry_idx = 0
    entry_spot = 0.0
    peak_pnl_pct: float = 0.0  # high water mark for trailing stop

    def _get_structure(d: str) -> OptionStructure:
        return recipe.long_structure if d == "long" else recipe.short_structure

    def _close_trade(bar_i: int, reason: str):
        nonlocal current_capital, active_dir, entry_idx, entry_spot, peak_pnl_pct
        structure = _get_structure(active_dir)  # type: ignore[arg-type]
        trade_pnl = _compute_trade_pnl(
            structure, recipe.underlying, entry_spot, close[bar_i],
            lot_size, (bar_i - entry_idx) / bpd / 365,
        )
        ctx = 15
        ctx_start = max(0, entry_idx - ctx)
        ctx_end = min(len(df), bar_i + ctx + 1)
        window = df.iloc[ctx_start:ctx_end]
        candles = [
            {
                "time": int(pd.Timestamp(row["timestamp"]).timestamp()),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
            }
            for _, row in window.iterrows()
        ]
        trades.append({
            "entry_bar": entry_idx,
            "exit_bar": bar_i,
            "entry_time": str(df["timestamp"].iloc[entry_idx])[:19],
            "exit_time": str(df["timestamp"].iloc[bar_i])[:19],
            "entry_price": entry_spot,
            "exit_price": close[bar_i],
            "pnl": trade_pnl,
            "bars_held": bar_i - entry_idx,
            "direction": active_dir,
            "exit_reason": reason,
            "entry_offset": entry_idx - ctx_start,
            "exit_offset": bar_i - ctx_start,
            "candles": candles,
        })
        current_capital += trade_pnl
        active_dir = None
        peak_pnl_pct = 0.0

    def _open_trade(bar_i: int, d: str):
        nonlocal active_dir, entry_idx, entry_spot, peak_pnl_pct
        active_dir = d
        entry_idx = bar_i
        entry_spot = close[bar_i]
        peak_pnl_pct = 0.0

    for i in range(len(df)):
        sig = direction_signal.iloc[i]

        if active_dir is None:
            if sig in ("long", "short"):
                _open_trade(i, sig)
        else:
            # ── Indicator-based directional exit (fires before direction change) ──
            ind_exit = (
                (active_dir == "long"  and bool(long_exit_signal.iloc[i])) or
                (active_dir == "short" and bool(short_exit_signal.iloc[i]))
            )
            if ind_exit:
                _close_trade(i, "indicator_exit")
                # Re-enter if there is also an entry signal in the other direction
                if sig not in ("neutral", active_dir if active_dir else ""):
                    _open_trade(i, sig)
            # ── Direction reversal ────────────────────────────────────────────
            elif sig != "neutral" and sig != active_dir:
                _close_trade(i, "direction_change")
                _open_trade(i, sig)
            else:
                should_exit = bool(general_exits.iloc[i])
                exit_reason = "indicator"

                if not should_exit and max_bars and (i - entry_idx) >= max_bars:
                    should_exit = True
                    exit_reason = "max_bars"

                # Compute option P&L % once if needed by target/stop/trailing
                need_pnl = (target_pct or stop_pct or trailing_stop_pct) and not should_exit
                leg_pnl_pct: float = 0.0
                if need_pnl:
                    leg_pnl_pct = _estimate_position_pnl_pct(
                        _get_structure(active_dir), recipe.underlying,
                        entry_spot, close[i], lot_size, (i - entry_idx) / bpd / 365,
                    )

                if not should_exit and target_pct and leg_pnl_pct >= target_pct:
                    should_exit = True
                    exit_reason = "target"

                if not should_exit and stop_pct and leg_pnl_pct <= -stop_pct:
                    should_exit = True
                    exit_reason = "stop"

                if not should_exit and trailing_stop_pct:
                    if leg_pnl_pct > peak_pnl_pct:
                        peak_pnl_pct = leg_pnl_pct
                    # Only trigger once peak has gone positive (locked in some profit)
                    if peak_pnl_pct > 0 and leg_pnl_pct < peak_pnl_pct - trailing_stop_pct:
                        should_exit = True
                        exit_reason = "trailing_stop"

                if should_exit:
                    _close_trade(i, exit_reason)

        equity.append(current_capital)

    equity_series = pd.Series(equity, dtype=float)
    trade_pnls = [t["pnl"] for t in trades]
    metrics = compute_all_metrics(equity_series, trade_pnls, periods_per_year=bpd * 252)

    return {
        "metrics": metrics,
        "equity_curve": equity,
        "trades": trades,
        "params": param_overrides or {},
    }


def _estimate_position_pnl_pct(
    structure: OptionStructure,
    underlying: str,
    entry_spot: float,
    current_spot: float,
    lot_size: int,
    tte_elapsed_years: float,
) -> float:
    """Quick P&L % estimate for target/stop checks."""
    total_pnl = _compute_trade_pnl(
        structure, underlying, entry_spot, current_spot,
        lot_size, tte_elapsed_years,
    )
    total_premium = 0
    for leg in structure.legs:
        strike = _resolve_strike(entry_spot, leg.strike.value, underlying)
        op = price_option(entry_spot, strike, 5 / 365, leg.option_type.value)
        total_premium += op.premium * lot_size * leg.lots

    if total_premium == 0:
        return 0.0
    return total_pnl / total_premium


def _compute_trade_pnl(
    structure: OptionStructure,
    underlying: str,
    entry_spot: float,
    exit_spot: float,
    lot_size: int,
    tte_elapsed_years: float,
    initial_tte_years: float = 5 / 365,
    iv: float = 0.20,
) -> float:
    """Compute total P&L across all legs in a structure using Black-Scholes."""
    total = 0.0
    for leg in structure.legs:
        strike = _resolve_strike(entry_spot, leg.strike.value, underlying)
        ot = leg.option_type.value
        sign = 1 if leg.action.value == "BUY" else -1

        entry_premium = price_option(entry_spot, strike, initial_tte_years, ot, iv).premium
        exit_tte = max(initial_tte_years - tte_elapsed_years, 0)
        exit_premium = price_option(exit_spot, strike, exit_tte, ot, iv).premium

        total += sign * (exit_premium - entry_premium) * lot_size * leg.lots

    return round(total, 2)


def save_backtest_result(
    strategy_id: str,
    strategy_version: int,
    result: dict,
) -> str:
    """Persist backtest result to DuckDB. Returns the result ID."""
    result_id = uuid4().hex[:12]
    conn = get_conn()
    conn.execute(
        """INSERT INTO backtest_results
        (id, strategy_id, strategy_version, params_json, sharpe, cagr,
         max_drawdown, win_rate, total_trades, profit_factor, calmar,
         equity_curve_json, trade_log_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            result_id,
            strategy_id,
            strategy_version,
            _dumps(result["params"]),
            float(result["metrics"]["sharpe"]),
            float(result["metrics"]["cagr"]),
            float(result["metrics"]["max_drawdown"]),
            float(result["metrics"]["win_rate"]),
            int(result["metrics"]["total_trades"]),
            float(result["metrics"]["profit_factor"]),
            float(result["metrics"]["calmar"]),
            _dumps(result["equity_curve"]),
            _dumps(result["trades"]),
        ],
    )
    return result_id
