"""Auto-trade engine — the core tick function and helpers.

Rules:
  - Entry fires on the FIRST tick where direction is "long" or "short"
    while status=idle.  Enters the corresponding leg structure.
  - Reversal: if status=in_long and signal=short (or vice versa), exit
    current legs and enter opposite legs in the same tick.
  - Neutral signal: hold current position (no entry, no exit).
  - General exits (indicator/time) close the position and return to idle.
  - Stopping auto-trade (enabled=False) releases the watch immediately
    without closing any positions.
  - Re-enabling: reconciles open_legs with the live order book.
  - Expiry auto-exit: any tracked option whose expiry <= ref_date is closed
    before the signal check.
  - Only positions opened by auto-trade (tracked in open_legs) are ever
    touched; manually placed positions are never affected.
"""

from __future__ import annotations

import logging
from datetime import datetime, date as date_type
from uuid import uuid4

log = logging.getLogger(__name__)


# ── Feed helpers ─────────────────────────────────────────────────────────────

def _get_feed_df():
    """Return (analysis_df, ref_date) from the current feed state."""
    from modules.feed.feed_state import get_state as get_feed_state
    feed = get_feed_state()

    if feed.mode == "replay":
        if feed.candles_df is None or feed.replay_state == "idle":
            return None, None
        from modules.feed.replay_feed import _candle_idx
        idx = min(_candle_idx(feed), len(feed.candles_df) - 1)
        df  = feed.candles_df.iloc[max(0, idx - 499): idx + 1].copy().reset_index(drop=True)
        vts = feed.candles_df.iloc[idx]["timestamp"]
        ref = vts.date() if hasattr(vts, "date") else date_type.fromisoformat(str(vts)[:10])
        return df, ref

    # live
    from modules.data.downloader import get_candles
    from modules.data.sync import get_token, SPOT_TOKENS
    underlying = feed.underlying
    if underlying not in SPOT_TOKENS:
        return None, date_type.today()
    try:
        token = get_token(underlying)
        df    = get_candles(token, feed.interval)
        return (df.tail(500).reset_index(drop=True) if not df.empty else None), date_type.today()
    except Exception:
        return None, date_type.today()


# ── Multi-timeframe feed helper ───────────────────────────────────────────────

def _get_interval_dfs(required_intervals: set[str]) -> dict:
    """Fetch higher-timeframe DataFrames needed by a multi-TF strategy."""
    if not required_intervals:
        return {}

    from modules.feed.feed_state import get_state as get_feed_state
    from modules.data.downloader import get_candles
    from modules.data.sync import get_token, SPOT_TOKENS

    feed = get_feed_state()
    interval_dfs: dict = {}

    if feed.mode == "replay":
        if feed.candles_df is None or feed.replay_state == "idle":
            return {}
        from modules.feed.replay_feed import _candle_idx
        idx = min(_candle_idx(feed), len(feed.candles_df) - 1)
        end_ts = feed.candles_df.iloc[idx]["timestamp"]
        underlying = feed.underlying
        if underlying not in SPOT_TOKENS:
            return {}
        try:
            token = get_token(underlying)
            for iv in required_intervals:
                htf_df = get_candles(token, iv)
                if not htf_df.empty:
                    htf_df = htf_df[htf_df["timestamp"] <= end_ts].tail(500).reset_index(drop=True)
                    if not htf_df.empty:
                        interval_dfs[iv] = htf_df
        except Exception:
            pass
    else:
        underlying = feed.underlying
        if underlying not in SPOT_TOKENS:
            return {}
        try:
            token = get_token(underlying)
            for iv in required_intervals:
                htf_df = get_candles(token, iv)
                if not htf_df.empty:
                    interval_dfs[iv] = htf_df.tail(500).reset_index(drop=True)
        except Exception:
            pass

    return interval_dfs


# ── Signal evaluation ────────────────────────────────────────────────────────

def _run_signals(strategy_id: str) -> dict:
    """Compile all signals for the strategy on current feed data."""
    from modules.vault.store import load_recipe
    from modules.strategy.builder import (
        compile_direction_signal,
        compile_exit_signals,
        compile_exit_indicator_signals,
        get_required_intervals,
    )

    df, ref_date = _get_feed_df()
    if df is None or len(df) < 5:
        return {"direction": "neutral", "general_exit": False,
                "long_exit": False, "short_exit": False,
                "ref_date": ref_date, "reason": "Insufficient feed data"}

    recipe = load_recipe(strategy_id)
    if recipe is None:
        return {"direction": "neutral", "general_exit": False,
                "long_exit": False, "short_exit": False,
                "ref_date": ref_date, "reason": f"Strategy '{strategy_id}' not found"}

    try:
        interval_dfs = _get_interval_dfs(get_required_intervals(recipe))
        dir_signal   = compile_direction_signal(recipe, df, interval_dfs=interval_dfs)
        exit_signal  = compile_exit_signals(recipe, df, interval_dfs=interval_dfs)
        ind_exits    = compile_exit_indicator_signals(recipe, df, interval_dfs=interval_dfs)
        return {
            "direction":   str(dir_signal.iloc[-1]),
            "general_exit": bool(exit_signal.iloc[-1]),
            "long_exit":   bool(ind_exits["long_exit"].iloc[-1]),
            "short_exit":  bool(ind_exits["short_exit"].iloc[-1]),
            "ref_date":    ref_date,
            "reason":      None,
        }
    except Exception as exc:
        log.warning("Signal compilation failed: %s", exc)
        return {"direction": "neutral", "general_exit": False,
                "long_exit": False, "short_exit": False,
                "ref_date": ref_date, "reason": str(exc)}


# ── Order helpers ────────────────────────────────────────────────────────────

def _place(tradingsymbol: str, exchange: str, action: str,
           quantity: int, strategy_id: str | None, mode: str) -> bool:
    """Place a paper or live order. Returns True on success."""
    try:
        if mode == "paper":
            from modules.trading.paper_trader import place_order
            place_order(tradingsymbol, action, quantity, 0.0, strategy_id, exchange)
        else:
            from modules.trading.live_trader import place_order
            place_order(tradingsymbol, action, quantity, 0.0,
                        "MARKET", "MIS", strategy_id, exchange)
        return True
    except Exception as exc:
        log.error("Auto-trade order failed (%s %s): %s", action, tradingsymbol, exc)
        return False


def _close_leg(sym: str, leg, mode: str) -> bool:
    """Place the reversal order for one open leg."""
    close_action = "SELL" if leg.action == "BUY" else "BUY"
    ok = _place(sym, leg.exchange, close_action, leg.quantity, None, mode)
    if ok:
        log.info("Auto-trade closed leg: %s %s %d", close_action, sym, leg.quantity)
    return ok


def _close_all_legs(state, trading_mode: str) -> list[str]:
    """Close all open legs and clear them from state. Returns closed symbols."""
    closed: list[str] = []
    for sym, leg in list(state.open_legs.items()):
        if _close_leg(sym, leg, trading_mode):
            closed.append(sym)
        state.open_legs.pop(sym, None)
    return closed


def _enter_direction(state, strategy_id: str, direction: str, trading_mode: str) -> list[str]:
    """Open legs for the given direction. Returns entered symbols."""
    from modules.auto_trade.state import LegRecord
    from modules.feed.symbols import resolve_suggestions

    suggestions = resolve_suggestions(strategy_id, direction=direction)
    if not suggestions:
        log.warning("Auto-trade: %s signal but no suggestions resolved for %s", direction, strategy_id)
        return []

    session_id = uuid4().hex[:8]
    state.session_id = session_id
    state.entry_time = datetime.now()
    state.current_direction = direction
    entered: list[str] = []

    for s in suggestions:
        sym = s["tradingsymbol"]
        qty = s["lot_size"] * s["lots"]
        if _place(sym, s["exchange"], s["action"], qty, strategy_id, trading_mode):
            state.open_legs[sym] = LegRecord(
                tradingsymbol=sym,
                exchange=s["exchange"],
                quantity=qty,
                action=s["action"],
            )
            entered.append(sym)

    if entered:
        state.status = "in_long" if direction == "long" else "in_short"
        log.info("Auto-trade entered %s position: %s", direction, entered)

    return entered


# ── Reconcile (resume after re-enable) ───────────────────────────────────────

def _reconcile(state) -> None:
    """After re-enabling, check which tracked legs are still open in the book."""
    if not state.open_legs:
        return

    book = (
        __import__("modules.trading.paper_trader", fromlist=["get_book"]).get_book()
        if state.trading_mode == "paper"
        else __import__("modules.trading.live_trader", fromlist=["get_book"]).get_book()
    )

    still_open = {sym for sym in state.open_legs if sym in book.positions}

    for sym in list(state.open_legs.keys()):
        if sym not in still_open:
            state.open_legs.pop(sym)

    if still_open:
        if state.current_direction:
            state.status = "in_long" if state.current_direction == "long" else "in_short"
        else:
            state.status = "in_long"
        state.last_action = "resumed"
        log.info("Auto-trade resumed: %d legs still open: %s",
                 len(still_open), list(still_open))
    else:
        state.open_legs.clear()
        state.status = "idle"
        state.current_direction = None
        state.session_id = None
        state.last_action = None
        log.info("Auto-trade: all tracked legs were closed externally, resetting to idle")


# ── Public tick API ──────────────────────────────────────────────────────────

def tick(strategy_id: str, trading_mode: str) -> dict:
    """Run one evaluation cycle.  Called on each strategy-monitor poll."""
    from modules.auto_trade.state import get_state
    from modules.trading.paper_trader import _parse_option_symbol

    state = get_state()

    if not state.enabled:
        return {"status": "disabled", "action_taken": None}

    state.strategy_id  = strategy_id
    state.trading_mode = trading_mode
    state.last_tick    = datetime.now()

    # ── 1. Reconcile on first tick after re-enable ────────────────────────────
    if state.open_legs and state.status == "idle":
        _reconcile(state)

    # ── 2. Expiry auto-exit ───────────────────────────────────────────────────
    _, ref_date = _get_feed_df()
    if ref_date is None:
        ref_date = date_type.today()

    expired: list[str] = []
    for sym, leg in list(state.open_legs.items()):
        parsed = _parse_option_symbol(sym)
        if parsed and parsed["expiry"] <= ref_date:
            if _close_leg(sym, leg, trading_mode):
                expired.append(sym)
            state.open_legs.pop(sym, None)

    if expired:
        log.info("Auto-trade expiry exit: %s", expired)
        if not state.open_legs:
            state.status = "idle"
            state.current_direction = None
            state.session_id = None
            state.last_action = "expiry_exit"

    # ── 3. Evaluate strategy signals ─────────────────────────────────────────
    sig = _run_signals(strategy_id)
    direction    = sig["direction"]
    general_exit = sig["general_exit"]
    long_exit    = sig["long_exit"]
    short_exit   = sig["short_exit"]
    action_taken: str | None = None

    # ── 4. State machine ──────────────────────────────────────────────────────
    if state.status == "idle":
        if direction in ("long", "short"):
            entered = _enter_direction(state, strategy_id, direction, trading_mode)
            if entered:
                state.last_action = f"entered_{direction}"
                action_taken = f"entered_{direction}"

    elif state.status in ("in_long", "in_short"):
        cur = state.current_direction  # "long" or "short"

        # Indicator-based directional exit (fires before reversal check)
        ind_exit = (cur == "long" and long_exit) or (cur == "short" and short_exit)

        if ind_exit:
            _close_all_legs(state, trading_mode)
            state.status = "idle"
            state.current_direction = None
            state.session_id = None
            state.last_action = "indicator_exit"
            action_taken = "indicator_exit"
            # If there is also a new entry signal for the other direction, enter it
            if direction in ("long", "short") and direction != cur:
                entered = _enter_direction(state, strategy_id, direction, trading_mode)
                if entered:
                    state.last_action = f"reversed_to_{direction}"
                    action_taken = f"reversed_to_{direction}"

        # Reversal: opposite directional entry signal
        elif direction in ("long", "short") and direction != cur:
            _close_all_legs(state, trading_mode)
            entered = _enter_direction(state, strategy_id, direction, trading_mode)
            if entered:
                state.last_action = "reversed"
                action_taken = f"reversed_to_{direction}"
            else:
                state.status = "idle"
                state.current_direction = None
                state.session_id = None
                state.last_action = "exited"
                action_taken = "exited"

        # General rule-based exit (indicator conditions / time exit)
        elif general_exit:
            closed = _close_all_legs(state, trading_mode)
            if closed:
                state.status = "idle"
                state.current_direction = None
                state.session_id = None
                state.last_action = "exited"
                action_taken = "exited"

    return {
        "status":             state.status,
        "current_direction":  state.current_direction,
        "action_taken":       action_taken,
        "direction_signal":   direction,
        "general_exit":       general_exit,
        "long_exit":          long_exit,
        "short_exit":         short_exit,
        "open_legs":          list(state.open_legs.keys()),
        "expired_legs":       expired,
        "reason":             sig.get("reason"),
    }
