"""Auto-trade engine — the core tick function and helpers.

Rules (as specified):
  - Entry fires on the FIRST tick where entries[-1] is True while status=idle.
  - Exit fires ONLY when exits[-1] is True (explicit exit condition).
    HOLD does NOT trigger exit.
  - Stopping auto-trade (enabled=False) releases the watch immediately
    without closing any positions.
  - Re-enabling: reconciles open_legs with the live order book.
    If tracked legs are still open → resume in_position.
    If they were closed externally → reset to idle.
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


# ── Signal evaluation ────────────────────────────────────────────────────────

def _run_signals(strategy_id: str) -> dict:
    """Compile entry/exit signals for the strategy on current feed data."""
    from modules.vault.store import load_recipe
    from modules.strategy.builder import compile_signals

    df, ref_date = _get_feed_df()
    if df is None or len(df) < 5:
        return {"entry": False, "exit": False, "ref_date": ref_date,
                "reason": "Insufficient feed data"}

    recipe = load_recipe(strategy_id)
    if recipe is None:
        return {"entry": False, "exit": False, "ref_date": ref_date,
                "reason": f"Strategy '{strategy_id}' not found"}

    try:
        sigs  = compile_signals(recipe, df)
        entry = bool(sigs["entries"].iloc[-1])
        exit_ = bool(sigs["exits"].iloc[-1])
        return {
            "entry":               entry,
            "exit":                exit_,
            "has_exit_conditions": len(recipe.exit_conditions) > 0,
            "ref_date":            ref_date,
            "reason":              None,
        }
    except Exception as exc:
        log.warning("Signal compilation failed: %s", exc)
        return {"entry": False, "exit": False, "ref_date": ref_date, "reason": str(exc)}


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

    # Prune legs that no longer appear in the order book
    for sym in list(state.open_legs.keys()):
        if sym not in still_open:
            state.open_legs.pop(sym)

    if still_open:
        state.status      = "in_position"
        state.last_action = "resumed"
        log.info("Auto-trade resumed: %d legs still open: %s",
                 len(still_open), list(still_open))
    else:
        state.open_legs.clear()
        state.status      = "idle"
        state.session_id  = None
        state.last_action = None
        log.info("Auto-trade: all tracked legs were closed externally, resetting to idle")


# ── Public tick API ──────────────────────────────────────────────────────────

def tick(strategy_id: str, trading_mode: str) -> dict:
    """Run one evaluation cycle.  Called on each strategy-monitor poll.

    Returns a dict describing what (if anything) happened this tick.
    """
    from modules.auto_trade.state import get_state, LegRecord
    from modules.trading.paper_trader import _parse_option_symbol
    from modules.feed.symbols import resolve_suggestions

    state = get_state()

    if not state.enabled:
        return {"status": "disabled", "action_taken": None}

    state.strategy_id  = strategy_id
    state.trading_mode = trading_mode
    state.last_tick    = datetime.now()

    # ── 1. Reconcile on first tick after re-enable ────────────────────────────
    if state.open_legs and state.status != "in_position":
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
            state.open_legs.pop(sym, None)   # remove regardless of close success

    if expired:
        log.info("Auto-trade expiry exit: %s", expired)
        if not state.open_legs:
            state.status      = "idle"
            state.session_id  = None
            state.last_action = "expiry_exit"

    # ── 3. Evaluate strategy signals ─────────────────────────────────────────
    sig         = _run_signals(strategy_id)
    action_taken: str | None = None

    # ── 4. State machine ──────────────────────────────────────────────────────
    if state.status == "idle" and sig["entry"]:
        suggestions = resolve_suggestions(strategy_id)
        if not suggestions:
            log.warning("Auto-trade: entry signal but no suggestions resolved for %s", strategy_id)
        else:
            session_id = uuid4().hex[:8]
            state.session_id = session_id
            state.entry_time = datetime.now()
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
                state.status      = "in_position"
                state.last_action = "entered"
                action_taken      = "entered"
                log.info("Auto-trade entered position: %s", entered)

    elif state.status == "in_position" and sig["exit"]:
        exited: list[str] = []
        for sym, leg in list(state.open_legs.items()):
            if _close_leg(sym, leg, trading_mode):
                exited.append(sym)
            state.open_legs.pop(sym, None)

        if exited:
            state.status      = "idle"
            state.session_id  = None
            state.last_action = "exited"
            action_taken      = "exited"
            log.info("Auto-trade exited position: %s", exited)

    return {
        "status":        state.status,
        "action_taken":  action_taken,
        "entry_signal":  sig.get("entry", False),
        "exit_signal":   sig.get("exit", False),
        "open_legs":     list(state.open_legs.keys()),
        "expired_legs":  expired,
        "reason":        sig.get("reason"),
    }
