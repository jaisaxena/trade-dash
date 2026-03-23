"""NSE option symbol helpers and suggestion resolver.

Shared by the feed router (for the /suggestions endpoint) and the
auto-trade engine (for resolving instruments on entry).
"""

from __future__ import annotations

from datetime import date as date_type, timedelta
from typing import Literal

_NSE_MONTH_CODE = {1:"1",2:"2",3:"3",4:"4",5:"5",6:"6",
                   7:"7",8:"8",9:"9",10:"O",11:"N",12:"D"}
_NSE_MONTH_NAME = {1:"JAN",2:"FEB",3:"MAR",4:"APR",5:"MAY",6:"JUN",
                   7:"JUL",8:"AUG",9:"SEP",10:"OCT",11:"NOV",12:"DEC"}


def nse_weekly_symbol(underlying: str, expiry_date: date_type, strike: int, opt_type: str) -> str:
    """e.g. NIFTY2631723150CE"""
    yy = expiry_date.year % 100
    m  = _NSE_MONTH_CODE[expiry_date.month]
    dd = f"{expiry_date.day:02d}"
    return f"{underlying}{yy}{m}{dd}{strike}{opt_type}"


def nse_monthly_symbol(underlying: str, expiry_date: date_type, strike: int, opt_type: str) -> str:
    """e.g. NIFTY26MAR23150CE"""
    yy  = expiry_date.year % 100
    mon = _NSE_MONTH_NAME[expiry_date.month]
    return f"{underlying}{yy}{mon}{strike}{opt_type}"


def expected_weekly_expiry(ref_date: date_type, expiries_set: set) -> tuple[date_type, bool]:
    """Return (expiry_date, found_in_db).

    Checks the DB for any expiry in the 7-day window first (handles
    holiday-adjusted dates).  Falls back to computing the next Thursday
    and checking Wed/Tue for holiday shifts.
    """
    for delta in range(7):
        candidate = ref_date + timedelta(days=delta)
        if candidate in expiries_set:
            return candidate, True

    days_to_thu = (3 - ref_date.weekday()) % 7
    thursday = ref_date + timedelta(days=days_to_thu)
    for offset in (0, -1, -2):
        cand = thursday + timedelta(days=offset)
        if cand >= ref_date:
            return cand, False
    return thursday, False


_STRIKE_OFFSETS = {
    "ATM-5": -5, "ATM-4": -4, "ATM-3": -3, "ATM-2": -2, "ATM-1": -1,
    "ATM+0": 0,
    "ATM+1":  1, "ATM+2":  2, "ATM+3":  3, "ATM+4":  4, "ATM+5":  5,
}


def resolve_suggestions(strategy_id: str, direction: str | None = None) -> list[dict]:
    """Resolve concrete instrument suggestions for a strategy at the current feed moment.

    Args:
        strategy_id: vault strategy ID
        direction: "long" or "short" — selects which leg structure to use.
                   If None, defaults to "long".

    Returns a list of dicts with keys:
        tradingsymbol, exchange, action, lots, lot_size, option_type, strike, expiry
    """
    from modules.vault.store import load_recipe
    from modules.data.instruments import get_expiries, get_option_instruments
    from modules.data.sync import UNDERLYING_CONFIG
    from modules.feed.feed_state import get_state as get_feed_state

    recipe = load_recipe(strategy_id)
    if recipe is None:
        return []

    underlying    = recipe.underlying.upper()
    expiry_offset = recipe.expiry_offset
    cfg           = UNDERLYING_CONFIG.get(underlying, {})
    strike_gap    = cfg.get("strike_gap", 50)
    cfg_lot_size  = cfg.get("lot_size", 25)

    feed_state = get_feed_state()

    # ── Determine reference date & spot ──────────────────────────────────────
    spot: float = 0.0
    ref_date: date_type = date_type.today()

    if feed_state.mode == "replay" and feed_state.candles_df is not None and not feed_state.candles_df.empty:
        from modules.feed.replay_feed import _candle_idx
        idx     = min(_candle_idx(feed_state), len(feed_state.candles_df) - 1)
        spot    = float(feed_state.candles_df.iloc[idx]["close"])
        vts     = feed_state.candles_df.iloc[idx]["timestamp"]
        ref_date = vts.date() if hasattr(vts, "date") else date_type.fromisoformat(str(vts)[:10])
    elif feed_state.mode == "live":
        from modules.feed.live_feed import get_live_quote
        q = get_live_quote(underlying)
        if q:
            spot = q["ltp"]

    if spot <= 0:
        return []

    # ── Resolve target expiry ─────────────────────────────────────────────────
    expiries     = get_expiries(underlying)
    expiries_set = set(expiries)
    is_monthly   = "monthly" in expiry_offset
    is_next      = "next"    in expiry_offset

    if is_monthly:
        future_exp = sorted(e for e in expiries if e >= ref_date)
        if not future_exp:
            future_exp = sorted(expiries)[-2:] if expiries else []
        monthly: list[date_type] = []
        prev = None
        for e in future_exp:
            if prev is None or (e - prev).days > 10:
                monthly.append(e)
            prev = e
        target_expiry: date_type | None = (
            monthly[1] if is_next and len(monthly) > 1 else (monthly[0] if monthly else None)
        )
        from_db = target_expiry is not None
    else:
        if is_next:
            days_to_thu    = (3 - ref_date.weekday()) % 7
            next_week_start = ref_date + timedelta(days=max(days_to_thu + 1, 1))
            target_expiry, from_db = expected_weekly_expiry(next_week_start, expiries_set)
        else:
            target_expiry, from_db = expected_weekly_expiry(ref_date, expiries_set)

    if target_expiry is None:
        return []

    atm_strike = round(spot / strike_gap) * strike_gap
    df_instr   = get_option_instruments(underlying, expiry=target_expiry) if from_db else None

    d = direction or "long"
    structure = recipe.long_structure if d == "long" else recipe.short_structure

    suggestions: list[dict] = []
    for leg in structure.legs:
        offset     = _STRIKE_OFFSETS.get(leg.strike, 0)
        opt_type   = leg.option_type.upper()
        direction  = 1 if opt_type == "CE" else -1
        tgt_strike = int(atm_strike + offset * direction * strike_gap)

        found = False
        if df_instr is not None and not df_instr.empty and tgt_strike:
            type_df = df_instr[df_instr["instrument_type"] == opt_type].copy()
            if not type_df.empty:
                type_df["dist"] = (type_df["strike"] - tgt_strike).abs()
                best  = type_df.nsmallest(1, "dist").iloc[0]
                found = True
                suggestions.append({
                    "tradingsymbol": best["tradingsymbol"],
                    "exchange":      "NFO",
                    "action":        leg.action.value,
                    "lots":          leg.lots,
                    "lot_size":      cfg_lot_size,
                    "option_type":   opt_type,
                    "strike":        float(best["strike"]),
                    "expiry":        str(target_expiry),
                })

        if not found and tgt_strike:
            sym = (
                nse_monthly_symbol(underlying, target_expiry, tgt_strike, opt_type)
                if is_monthly
                else nse_weekly_symbol(underlying, target_expiry, tgt_strike, opt_type)
            )
            suggestions.append({
                "tradingsymbol": sym,
                "exchange":      "NFO",
                "action":        leg.action.value,
                "lots":          leg.lots,
                "lot_size":      cfg_lot_size,
                "option_type":   opt_type,
                "strike":        float(tgt_strike),
                "expiry":        str(target_expiry),
            })

    return suggestions
