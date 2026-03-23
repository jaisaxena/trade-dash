from __future__ import annotations

import time
import logging
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from modules.feed.feed_state import get_state
from modules.feed.replay_feed import load_candles, get_current_candle, get_recent_candles, _row_to_dict, _candle_idx
from modules.feed.live_feed import get_live_quote, get_live_candles, SPOT_TOKENS as LIVE_SPOT_TOKENS
from modules.data.downloader import get_candles
from modules.data.sync import get_token, SPOT_TOKENS
from modules.strategy.builder import compile_direction_signal, get_required_intervals
from modules.vault.store import load_recipe
from modules.data.instruments import get_expiries, get_option_instruments

log = logging.getLogger(__name__)
router = APIRouter()


class ConfigureRequest(BaseModel):
    mode: Literal["live", "replay"]
    underlying: str = "NIFTY"
    interval: str = "15m"
    start_dt: str | None = None
    speed: float = 1.0


@router.post("/configure")
async def configure(body: ConfigureRequest):
    state = get_state()
    state.mode = body.mode
    state.underlying = body.underlying.upper()
    state.interval = body.interval
    state.speed = max(0.1, body.speed)

    # Always reset replay fields on (re)configure
    state.replay_state = "idle"
    state.candles_df = None
    state.virtual_start_dt = None
    state.wall_start_time = None
    state.paused_elapsed = 0.0

    if body.mode == "replay":
        if not body.start_dt:
            raise HTTPException(400, "start_dt required for replay mode")
        start_dt = datetime.fromisoformat(body.start_dt)
        df = load_candles(state.underlying, state.interval, start_dt)
        if df.empty:
            raise HTTPException(
                404,
                f"No candle data for {state.underlying} {state.interval} "
                f"from {start_dt.date()}. Sync data first.",
            )
        state.candles_df = df
        state.virtual_start_dt = df["timestamp"].iloc[0].to_pydatetime()

    return {"status": "configured", "mode": state.mode}


@router.post("/replay/play")
async def replay_play():
    state = get_state()
    if state.mode != "replay":
        raise HTTPException(400, "Not in replay mode")
    if state.candles_df is None:
        raise HTTPException(400, "Configure replay first")

    if state.replay_state == "paused":
        state.wall_start_time = time.monotonic()
    elif state.replay_state in ("idle", "ended"):
        state.wall_start_time = time.monotonic()
        state.paused_elapsed = 0.0
        if state.replay_state == "ended":
            # Restart from beginning
            state.virtual_start_dt = state.candles_df["timestamp"].iloc[0].to_pydatetime()

    state.replay_state = "playing"
    return {"replay_state": state.replay_state}


@router.post("/replay/pause")
async def replay_pause():
    state = get_state()
    if state.replay_state != "playing":
        return {"replay_state": state.replay_state}
    if state.wall_start_time is not None:
        state.paused_elapsed += time.monotonic() - state.wall_start_time
        state.wall_start_time = None
    state.replay_state = "paused"
    return {"replay_state": state.replay_state}


@router.post("/replay/reset")
async def replay_reset():
    state = get_state()
    state.replay_state = "idle"
    state.wall_start_time = None
    state.paused_elapsed = 0.0
    if state.candles_df is not None:
        state.virtual_start_dt = state.candles_df["timestamp"].iloc[0].to_pydatetime()
    return {"replay_state": state.replay_state}


@router.get("/status")
async def feed_status():
    state = get_state()
    available_range = None
    if state.underlying in SPOT_TOKENS:
        try:
            token = get_token(state.underlying)
            df = get_candles(token, state.interval)
            if not df.empty:
                available_range = {
                    "from": str(df["timestamp"].min()),
                    "to":   str(df["timestamp"].max()),
                }
        except Exception:
            pass

    return {
        "mode":          state.mode,
        "underlying":    state.underlying,
        "interval":      state.interval,
        "replay_state":  state.replay_state,
        "speed":         state.speed,
        "available_range": available_range,
    }


_NSE_MONTH_CODE = {1:"1",2:"2",3:"3",4:"4",5:"5",6:"6",
                   7:"7",8:"8",9:"9",10:"O",11:"N",12:"D"}
_NSE_MONTH_NAME = {1:"JAN",2:"FEB",3:"MAR",4:"APR",5:"MAY",6:"JUN",
                   7:"JUL",8:"AUG",9:"SEP",10:"OCT",11:"NOV",12:"DEC"}


def _nse_weekly_symbol(underlying: str, expiry_date, strike: int, opt_type: str) -> str:
    """Construct NSE weekly option tradingsymbol, e.g. NIFTY2631723150CE."""
    yy = expiry_date.year % 100
    m  = _NSE_MONTH_CODE[expiry_date.month]
    dd = f"{expiry_date.day:02d}"
    return f"{underlying}{yy}{m}{dd}{strike}{opt_type}"


def _nse_monthly_symbol(underlying: str, expiry_date, strike: int, opt_type: str) -> str:
    """Construct NSE monthly option tradingsymbol, e.g. NIFTY26MAR23150CE."""
    yy  = expiry_date.year % 100
    mon = _NSE_MONTH_NAME[expiry_date.month]
    return f"{underlying}{yy}{mon}{strike}{opt_type}"


def _expected_weekly_expiry(ref_date, expiries_set: set) -> tuple:
    """Return (expiry_date, from_db) for the nearest weekly expiry >= ref_date.

    NSE weekly options expire on Thursday; if Thursday is a market holiday the
    expiry shifts to the previous trading day (Wed, then Tue).  We check the DB
    first for any expiry in the 7-day window — that naturally captures
    holiday-adjusted dates.  If nothing is in the DB (historical options have
    expired), we fall back to programmatic Thursday + backward check.
    """
    from datetime import timedelta
    # ── Phase 1: DB lookup in the upcoming 7-day window ──────────────────────
    for delta in range(7):
        candidate = ref_date + timedelta(days=delta)
        if candidate in expiries_set:
            return candidate, True

    # ── Phase 2: Programmatic fallback — next Thursday, allow 2-day backward ──
    days_to_thu = (3 - ref_date.weekday()) % 7
    thursday = ref_date + timedelta(days=days_to_thu)
    # Check Thu → Wed → Tue for holiday-adjusted expiry (not in DB, generate anyway)
    for offset in (0, -1, -2):
        cand = thursday + timedelta(days=offset)
        if cand >= ref_date:
            return cand, False
    return thursday, False


@router.get("/suggestions")
async def instrument_suggestions(strategy_id: str, direction: str | None = None):
    """Return ranked instrument suggestions based on a strategy recipe's structure.

    For replay mode the suggestions are resolved relative to the *virtual* replay
    date so that a February replay gets February expiries, not today's.  When
    historical instruments are no longer in the DB (they expired), symbols are
    generated programmatically using the NSE naming convention.
    """
    from datetime import date as date_type
    import math

    recipe = load_recipe(strategy_id)
    if recipe is None:
        raise HTTPException(404, f"Strategy '{strategy_id}' not found in vault")

    underlying = recipe.underlying.upper()
    expiry_offset = recipe.expiry_offset  # e.g. "weekly_current", "weekly_next", "monthly_current"

    from modules.data.sync import UNDERLYING_CONFIG
    cfg        = UNDERLYING_CONFIG.get(underlying, {})
    strike_gap = cfg.get("strike_gap", 50)
    # Always use the configured lot size (matches backtesting setup), not the
    # live NSE lot size which may differ due to contract revisions.
    cfg_lot_size = cfg.get("lot_size", 25)

    # ── Determine reference date ──────────────────────────────────────────────
    state = get_state()
    if state.mode == "replay" and state.candles_df is not None and not state.candles_df.empty:
        from modules.feed.replay_feed import _candle_idx
        idx = min(_candle_idx(state), len(state.candles_df) - 1)
        virtual_ts = state.candles_df.iloc[idx]["timestamp"]
        reference_date = (
            virtual_ts.date() if hasattr(virtual_ts, "date")
            else date_type.fromisoformat(str(virtual_ts)[:10])
        )
    else:
        idx = None
        reference_date = date_type.today()

    # ── Resolve target expiry ─────────────────────────────────────────────────
    expiries     = get_expiries(underlying)
    expiries_set = set(expiries)

    is_monthly = "monthly" in expiry_offset
    is_next    = "next" in expiry_offset

    if is_monthly:
        # Monthly expiry: last Thursday of the month (or holiday-adjusted)
        # Use DB month-gap heuristic for available expiries; for historical replay
        # fall back to generating a monthly symbol.
        future_exp = sorted(e for e in expiries if e >= reference_date)
        if not future_exp:
            future_exp = sorted(expiries)[-2:] if expiries else []

        monthly: list = []
        prev = None
        for e in future_exp:
            if prev is None or (e - prev).days > 10:
                monthly.append(e)
            prev = e
        target_expiry = monthly[1] if is_next and len(monthly) > 1 else (monthly[0] if monthly else None)
        from_db = target_expiry is not None
    else:
        # Weekly expiry
        if is_next:
            # Skip current week — find the week after
            from datetime import timedelta
            days_to_thu = (3 - reference_date.weekday()) % 7
            next_week_start = reference_date + timedelta(days=max(days_to_thu + 1, 1))
            target_expiry, from_db = _expected_weekly_expiry(next_week_start, expiries_set)
        else:
            target_expiry, from_db = _expected_weekly_expiry(reference_date, expiries_set)

    if target_expiry is None:
        return {"suggestions": [], "underlying": underlying,
                "reason": "Could not determine target expiry. Refresh instruments first."}

    # ── Get spot price for ATM calculation ───────────────────────────────────
    spot = 0.0
    if state.mode == "replay" and state.candles_df is not None and idx is not None:
        spot = float(state.candles_df.iloc[idx]["close"])
    elif state.mode == "live":
        from modules.feed.live_feed import get_live_quote
        q = get_live_quote(underlying)
        if q:
            spot = q["ltp"]

    # ── Compute ATM strike ────────────────────────────────────────────────────
    if spot > 0:
        atm_strike = round(spot / strike_gap) * strike_gap
    else:
        # Fall back to DB strike median if we have instruments
        df_tmp = get_option_instruments(underlying, expiry=target_expiry)
        if not df_tmp.empty:
            strikes_sorted = sorted(df_tmp["strike"].dropna().unique())
            atm_strike = int(strikes_sorted[len(strikes_sorted) // 2]) if strikes_sorted else 0
        else:
            atm_strike = 0

    STRIKE_OFFSETS = {
        "ATM-5": -5, "ATM-4": -4, "ATM-3": -3, "ATM-2": -2, "ATM-1": -1,
        "ATM+0": 0,
        "ATM+1": 1,  "ATM+2": 2,  "ATM+3": 3,  "ATM+4": 4,  "ATM+5": 5,
    }

    # ── Try DB instruments first; generate programmatically as fallback ───────
    df_instr = get_option_instruments(underlying, expiry=target_expiry) if from_db else None

    d = direction or "long"
    structure = recipe.long_structure if d == "long" else recipe.short_structure

    suggestions = []
    for leg in structure.legs:
        offset     = STRIKE_OFFSETS.get(leg.strike, 0)
        opt_type   = leg.option_type.upper()
        direction  = 1 if opt_type == "CE" else -1
        tgt_strike = int(atm_strike + offset * direction * strike_gap) if atm_strike else 0

        found_in_db = False
        if df_instr is not None and not df_instr.empty and tgt_strike:
            type_df = df_instr[df_instr["instrument_type"] == opt_type].copy()
            if not type_df.empty:
                type_df["dist"] = (type_df["strike"] - tgt_strike).abs()
                best = type_df.nsmallest(1, "dist").iloc[0]
                found_in_db = True
                suggestions.append({
                    "tradingsymbol":    best["tradingsymbol"],
                    "instrument_token": int(best["instrument_token"]),
                    "option_type":      opt_type,
                    "strike":           float(best["strike"]),
                    "expiry":           str(target_expiry),
                    "lot_size":         cfg_lot_size,
                    "action":           leg.action.value,
                    "lots":             leg.lots,
                    "strike_ref":       leg.strike,
                })

        if not found_in_db and tgt_strike:
            # Generate symbol programmatically using NSE naming convention
            sym = (
                _nse_monthly_symbol(underlying, target_expiry, tgt_strike, opt_type)
                if is_monthly
                else _nse_weekly_symbol(underlying, target_expiry, tgt_strike, opt_type)
            )
            suggestions.append({
                "tradingsymbol":    sym,
                "instrument_token": 0,
                "option_type":      opt_type,
                "strike":           float(tgt_strike),
                "expiry":           str(target_expiry),
                "lot_size":         cfg_lot_size,
                "action":           leg.action.value,
                "lots":             leg.lots,
                "strike_ref":       leg.strike,
            })

    return {
        "suggestions": suggestions,
        "underlying":  underlying,
        "expiry":      str(target_expiry),
        "spot":        spot,
        "atm_strike":  atm_strike,
    }


@router.get("/analyze")
async def analyze(strategy_id: str):
    """Run a vault strategy recipe against the current feed candles and return a verdict."""
    state = get_state()

    _neutral = {"verdict": "NEUTRAL", "direction": "neutral",
                "timestamp": None, "close": 0.0, "candles_used": 0}

    # Build analysis DataFrame from current feed state
    if state.mode == "replay":
        if state.candles_df is None or state.replay_state == "idle":
            return {**_neutral, "reason": "Replay not configured or not started"}

        df = state.candles_df
        if state.wall_start_time is None and state.paused_elapsed == 0.0:
            idx = 0
        else:
            idx = min(_candle_idx(state), len(df) - 1)

        analysis_df = df.iloc[max(0, idx - 499) : idx + 1].copy().reset_index(drop=True)

    else:  # live
        if state.underlying not in LIVE_SPOT_TOKENS:
            return {**_neutral, "reason": f"Unknown underlying: {state.underlying}"}
        try:
            analysis_df = get_live_candles(state.underlying, state.interval, 500)
            if analysis_df.empty:
                return {**_neutral, "reason": "No live candle data. Ensure Kite is authenticated."}
            analysis_df = analysis_df.tail(500).reset_index(drop=True)
        except Exception as e:
            return {**_neutral, "reason": str(e)}

    if len(analysis_df) < 5:
        return {**_neutral, "candles_used": len(analysis_df),
                "reason": "Insufficient candle data for indicators"}

    recipe = load_recipe(strategy_id)
    if recipe is None:
        raise HTTPException(404, f"Strategy '{strategy_id}' not found in vault")

    # Fetch higher-timeframe DataFrames for multi-TF indicators
    interval_dfs: dict = {}
    required = get_required_intervals(recipe)
    if required:
        if state.mode == "replay" and state.candles_df is not None:
            end_ts = analysis_df["timestamp"].iloc[-1]
            for iv in required:
                if state.underlying in SPOT_TOKENS:
                    try:
                        token = get_token(state.underlying)
                        htf = get_candles(token, iv)
                        if not htf.empty:
                            htf = htf[htf["timestamp"] <= end_ts].tail(500).reset_index(drop=True)
                            if not htf.empty:
                                interval_dfs[iv] = htf
                    except Exception:
                        pass
        else:
            for iv in required:
                if state.underlying in LIVE_SPOT_TOKENS:
                    try:
                        htf = get_live_candles(state.underlying, iv, 500)
                        if not htf.empty:
                            interval_dfs[iv] = htf.tail(500).reset_index(drop=True)
                    except Exception:
                        pass

    try:
        dir_signal = compile_direction_signal(recipe, analysis_df, interval_dfs=interval_dfs)
        direction = str(dir_signal.iloc[-1])  # "long", "short", or "neutral"
        verdict = direction.upper()  # "LONG", "SHORT", "NEUTRAL"

        last_ts = analysis_df["timestamp"].iloc[-1]
        return {
            "verdict":      verdict,
            "direction":    direction,
            "timestamp":    last_ts.isoformat() if hasattr(last_ts, "isoformat") else str(last_ts),
            "close":        float(analysis_df["close"].iloc[-1]),
            "candles_used": len(analysis_df),
            "reason":       None,
        }
    except Exception as e:
        log.error("Strategy analyze error for %s: %s", strategy_id, e)
        return {**_neutral, "candles_used": len(analysis_df), "reason": str(e)}


@router.get("/quotes")
async def get_quotes(history: int = 50):
    state = get_state()

    if state.mode == "live":
        quote = get_live_quote(state.underlying)
        if quote is None:
            now = datetime.now().isoformat()
            quote = {"timestamp": now, "open": 0, "high": 0, "low": 0,
                     "close": 0, "volume": 0, "ltp": 0}

        hist: list[dict] = []
        if state.underlying in LIVE_SPOT_TOKENS:
            live_df = get_live_candles(state.underlying, state.interval, history)
            if not live_df.empty:
                hist = [_row_to_dict(r) for _, r in live_df.iterrows()]

        return {
            "mode":         "live",
            "replay_state": None,
            "underlying":   state.underlying,
            "interval":     state.interval,
            "quote":        quote,
            "history":      hist,
        }

    # Replay mode
    quote = get_current_candle(state)
    hist  = get_recent_candles(state, history)
    return {
        "mode":         "replay",
        "replay_state": state.replay_state,
        "underlying":   state.underlying,
        "interval":     state.interval,
        "quote":        quote,
        "history":      hist,
    }
