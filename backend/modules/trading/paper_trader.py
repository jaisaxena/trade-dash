"""Paper trading engine — simulates order execution using live Kite
WebSocket feed.  Fills at mid-price (bid+ask)/2 or LTP.
"""

from __future__ import annotations

import logging
import math
import re
from datetime import datetime, date as date_type

from modules.trading.order_manager import Order, OrderBook, OrderStatus
from modules.data.kite_client import get_ltps, is_authenticated

log = logging.getLogger(__name__)

_book = OrderBook()

# ── NSE option symbol parsing ────────────────────────────────────────────────

_WEEK_MONTH = {"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"O":10,"N":11,"D":12}
_NAMED_MONTH = {"JAN":1,"FEB":2,"MAR":3,"APR":4,"MAY":5,"JUN":6,
                "JUL":7,"AUG":8,"SEP":9,"OCT":10,"NOV":11,"DEC":12}
_WEEKLY_RE  = re.compile(r"^([A-Z]+)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$")
_MONTHLY_RE = re.compile(r"^([A-Z]+)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+)(CE|PE)$")


def _parse_option_symbol(symbol: str) -> dict | None:
    """Return {underlying, expiry, strike, option_type} or None."""
    m = _WEEKLY_RE.match(symbol)
    if m:
        und, yy, mc, dd, strike, ot = m.groups()
        try:
            return {
                "underlying": und,
                "expiry": date_type(2000 + int(yy), _WEEK_MONTH[mc], int(dd)),
                "strike": int(strike),
                "option_type": ot,
            }
        except ValueError:
            pass
    m = _MONTHLY_RE.match(symbol)
    if m:
        und, yy, mon, strike, ot = m.groups()
        year, month = 2000 + int(yy), _NAMED_MONTH[mon]
        # Last Thursday of the month as expiry day approximation
        from calendar import monthrange
        _, last = monthrange(year, month)
        d = last
        while date_type(year, month, d).weekday() != 3:
            d -= 1
        return {
            "underlying": und,
            "expiry": date_type(year, month, d),
            "strike": int(strike),
            "option_type": ot,
        }
    return None


# ── Black-Scholes estimator (no scipy dependency) ────────────────────────────

def _norm_cdf(x: float) -> float:
    return (1.0 + math.erf(x / math.sqrt(2))) / 2


def _bs_price(spot: float, strike: float, t_days: float,
              sigma: float = 0.15, r: float = 0.07, opt: str = "CE") -> float:
    """Black-Scholes European option price.  Uses σ=15% as NIFTY IV proxy."""
    if spot <= 0 or strike <= 0:
        return 0.0
    if t_days <= 0:
        return max(0.0, spot - strike) if opt == "CE" else max(0.0, strike - spot)
    T = max(t_days / 365.0, 1 / 365)
    try:
        d1 = (math.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        d2 = d1 - sigma * math.sqrt(T)
        if opt == "CE":
            return max(0.0, spot * _norm_cdf(d1) - strike * math.exp(-r * T) * _norm_cdf(d2))
        return max(0.0, strike * math.exp(-r * T) * _norm_cdf(-d2) - spot * _norm_cdf(-d1))
    except Exception:
        return max(0.0, spot - strike) if opt == "CE" else max(0.0, strike - spot)


def _estimate_price_from_feed(tradingsymbol: str) -> float | None:
    """Estimate instrument price using the current feed state.

    - Options  → Black-Scholes using feed spot, parsed strike/expiry, σ=15%.
    - Underlying futures/spot → feed close directly.
    Returns None when the feed is not available or the symbol can't be parsed.
    """
    is_option = tradingsymbol.upper().endswith(("CE", "PE"))
    try:
        from modules.feed.feed_state import get_state
        state = get_state()
        spot = 0.0
        ref_date: date_type | None = None

        if state.mode == "replay" and state.candles_df is not None and not state.candles_df.empty:
            from modules.feed.replay_feed import _candle_idx
            idx = min(_candle_idx(state), len(state.candles_df) - 1)
            spot = float(state.candles_df.iloc[idx]["close"])
            vts = state.candles_df.iloc[idx]["timestamp"]
            ref_date = vts.date() if hasattr(vts, "date") else date_type.fromisoformat(str(vts)[:10])
        elif state.mode == "live":
            from modules.feed.live_feed import get_live_quote
            q = get_live_quote(state.underlying)
            if q:
                spot = q["ltp"]

        if spot <= 0:
            return None

        if not is_option:
            return spot

        parsed = _parse_option_symbol(tradingsymbol)
        if not parsed:
            return None

        t_days = float((parsed["expiry"] - (ref_date or date_type.today())).days)
        price = _bs_price(spot, float(parsed["strike"]), t_days, opt=parsed["option_type"])
        log.info(
            "BS estimate for %s: spot=%.0f strike=%d t_days=%.0f → %.2f",
            tradingsymbol, spot, parsed["strike"], t_days, price,
        )
        # For expired options, 0 is a valid settlement price (expired worthless).
        # Only return None when we genuinely cannot estimate (active option, no data).
        if t_days <= 0:
            return price   # intrinsic value; may be 0 for OTM — that is correct
        return price if price > 0 else None
    except Exception as exc:
        log.warning("Feed-based price estimation failed for %s: %s", tradingsymbol, exc)
        return None


def get_book() -> OrderBook:
    return _book


def reset_book() -> None:
    global _book
    _book = OrderBook()


def _resolve_fill_price(tradingsymbol: str, exchange: str, price: float) -> float:
    """Resolve a fill price for a paper order.

    Priority:
      1. Caller-supplied price if > 0.
      2. Kite LTP  (live market — accurate for any instrument).
      3. Black-Scholes estimate from feed state (options, replay without Kite).
      4. Feed close for bare underlying (futures/equity legs).
      5. Raises if nothing is available.
    """
    if price > 0:
        return price

    # Kite LTP — most accurate, works for options too
    if is_authenticated():
        ltps = get_ltps([f"{exchange}:{tradingsymbol}"])
        if ltps.get(tradingsymbol, 0) > 0:
            log.info("Paper order: Kite LTP %.2f for %s", ltps[tradingsymbol], tradingsymbol)
            return ltps[tradingsymbol]

    # Feed-based estimation (B-S for options, spot close for underlying).
    # A returned value of 0.0 is intentional for expired OTM options — allow it.
    estimated = _estimate_price_from_feed(tradingsymbol)
    if estimated is not None:
        log.info("Paper order: feed-estimated price %.2f for %s", estimated, tradingsymbol)
        return estimated

    raise ValueError(
        f"Could not resolve price for '{tradingsymbol}'. "
        "Connect to Kite (for live LTP) or enter the price manually."
    )


def place_order(
    tradingsymbol: str,
    transaction_type: str,
    quantity: int,
    price: float = 0.0,
    strategy_id: str | None = None,
    exchange: str = "NFO",
) -> Order:
    """Place a paper order. Fills immediately at the best available price."""
    fill_price = _resolve_fill_price(tradingsymbol, exchange, price)

    order = Order(
        tradingsymbol=tradingsymbol,
        exchange=exchange,
        transaction_type=transaction_type,
        quantity=quantity,
        price=fill_price,
        order_type="MARKET",
        product="MIS",
        strategy_id=strategy_id,
    )
    _book.add_order(order)
    _book.fill_order(order.id, fill_price)
    log.info("Paper order filled: %s %s %d @ %.2f",
             transaction_type, tradingsymbol, quantity, fill_price)
    return order


def on_tick(ticks: list[dict]) -> None:
    """Called by the Kite WebSocket ticker — updates LTP for all positions."""
    for tick in ticks:
        symbol = tick.get("tradingsymbol", "")
        ltp = tick.get("last_price", 0)
        if symbol and ltp:
            _book.update_ltp(symbol, ltp)


def get_positions(strategy_id: str | None = None) -> list[dict]:
    return _book.get_positions(strategy_id)


def get_orders(strategy_id: str | None = None) -> list[dict]:
    return _book.get_orders(strategy_id)


def get_pnl() -> dict:
    unrealized = sum(p.unrealised_pnl for p in _book.positions.values())
    return {
        "total_pnl":    _book.total_pnl(),
        "realized_pnl": _book.realized_pnl,
        "unrealized_pnl": unrealized,
        "positions":    len(_book.positions),
        "open_orders":  sum(
            1 for o in _book.orders.values()
            if o.status == OrderStatus.PENDING
        ),
    }
