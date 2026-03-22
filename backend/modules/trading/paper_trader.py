"""Paper trading engine — simulates order execution using live Kite
WebSocket feed.  Fills at mid-price (bid+ask)/2 or LTP.
"""

from __future__ import annotations

import logging
from datetime import datetime

from modules.trading.order_manager import Order, OrderBook, OrderStatus

log = logging.getLogger(__name__)

_book = OrderBook()


def get_book() -> OrderBook:
    return _book


def reset_book() -> None:
    global _book
    _book = OrderBook()


def place_order(
    tradingsymbol: str,
    transaction_type: str,
    quantity: int,
    price: float = 0.0,
    strategy_id: str | None = None,
    exchange: str = "NFO",
) -> Order:
    """Place a paper order. Immediately fills at the given price."""
    order = Order(
        tradingsymbol=tradingsymbol,
        exchange=exchange,
        transaction_type=transaction_type,
        quantity=quantity,
        price=price,
        order_type="MARKET",
        product="MIS",
        strategy_id=strategy_id,
    )
    _book.add_order(order)
    _book.fill_order(order.id, price)
    log.info("Paper order filled: %s %s %d @ %.2f",
             transaction_type, tradingsymbol, quantity, price)
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
    return {
        "total_pnl": _book.total_pnl(),
        "positions": len(_book.positions),
        "open_orders": sum(
            1 for o in _book.orders.values()
            if o.status == OrderStatus.PENDING
        ),
    }
