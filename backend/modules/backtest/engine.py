"""Vectorized backtesting engine.

Uses VectorBT for fast signal-based backtesting of the underlying,
then layers on options P&L simulation for the actual strategy legs.
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
from modules.strategy.models import StrategyRecipe, ExitType
from modules.strategy.builder import compile_signals
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
) -> dict:
    """Run a full backtest: signal generation → trade simulation → metrics.

    Returns a dict with metrics, equity curve, and trade log.
    """
    signals = compile_signals(recipe, df, param_overrides)
    entries = signals["entries"]
    exits = signals["exits"]

    lot_size = LOT_SIZES.get(recipe.underlying, 25)
    bpd = _bars_per_day(interval)

    target_pct = None
    stop_pct = None
    max_bars = None

    for ec in recipe.exit_conditions:
        if ec.type == ExitType.TARGET_PCT and ec.value is not None:
            target_pct = float(ec.value) / 100
        elif ec.type == ExitType.STOP_PCT and ec.value is not None:
            stop_pct = float(ec.value) / 100
        elif ec.type == ExitType.MAX_HOLDING_BARS and ec.value is not None:
            max_bars = int(ec.value)

    close = df["close"].values
    trades = []
    equity = [initial_capital]
    current_capital = initial_capital
    in_trade = False
    entry_idx = 0
    entry_spot = 0.0

    for i in range(len(df)):
        if not in_trade and entries.iloc[i]:
            in_trade = True
            entry_idx = i
            entry_spot = close[i]

        elif in_trade:
            should_exit = exits.iloc[i]

            if not should_exit and max_bars and (i - entry_idx) >= max_bars:
                should_exit = True

            if not should_exit and target_pct:
                leg_pnl_pct = _estimate_position_pnl_pct(
                    recipe, entry_spot, close[i], lot_size,
                    (i - entry_idx) / bpd / 365,
                )
                if leg_pnl_pct >= target_pct:
                    should_exit = True

            if not should_exit and stop_pct:
                leg_pnl_pct = _estimate_position_pnl_pct(
                    recipe, entry_spot, close[i], lot_size,
                    (i - entry_idx) / bpd / 365,
                )
                if leg_pnl_pct <= -stop_pct:
                    should_exit = True

            if should_exit:
                trade_pnl = _compute_trade_pnl(
                    recipe, entry_spot, close[i], lot_size,
                    (i - entry_idx) / bpd / 365,
                )
                # Build a candle window around this trade (15 bars context each side)
                ctx = 15
                ctx_start = max(0, entry_idx - ctx)
                ctx_end = min(len(df), i + ctx + 1)
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
                    "exit_bar": i,
                    "entry_time": str(df["timestamp"].iloc[entry_idx])[:19],
                    "exit_time": str(df["timestamp"].iloc[i])[:19],
                    "entry_price": entry_spot,
                    "exit_price": close[i],
                    "pnl": trade_pnl,
                    "bars_held": i - entry_idx,
                    "entry_offset": entry_idx - ctx_start,
                    "exit_offset": i - ctx_start,
                    "candles": candles,
                })
                current_capital += trade_pnl
                in_trade = False

        equity.append(current_capital)

    # equity is now: [initial_capital, after_bar_0, ..., after_bar_{N-1}]
    # Keep all N+1 points: the seed (initial_capital) is always the correct
    # starting value, and the last element captures the final bar's P&L.
    # (The old equity[:len(df)] slice was dropping the last bar's realized trade.)

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
    recipe: StrategyRecipe,
    entry_spot: float,
    current_spot: float,
    lot_size: int,
    tte_elapsed_years: float,
) -> float:
    """Quick P&L % estimate for target/stop checks."""
    total_pnl = _compute_trade_pnl(recipe, entry_spot, current_spot, lot_size, tte_elapsed_years)
    total_premium = 0
    for leg in recipe.structure.legs:
        strike = _resolve_strike(entry_spot, leg.strike.value, recipe.underlying)
        op = price_option(entry_spot, strike, 5 / 365, leg.option_type.value)
        total_premium += op.premium * lot_size * leg.lots

    if total_premium == 0:
        return 0.0
    return total_pnl / total_premium


def _compute_trade_pnl(
    recipe: StrategyRecipe,
    entry_spot: float,
    exit_spot: float,
    lot_size: int,
    tte_elapsed_years: float,
    initial_tte_years: float = 5 / 365,
    iv: float = 0.20,
) -> float:
    """Compute total P&L across all legs using Black-Scholes."""
    total = 0.0
    for leg in recipe.structure.legs:
        strike = _resolve_strike(entry_spot, leg.strike.value, recipe.underlying)
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
