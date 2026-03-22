"""Live trading via Kite Connect orders API.

Wraps the kiteconnect SDK's order methods with local order tracking
and position management.
"""

from __future__ import annotations

import logging

from modules.data.kite_client import get_kite, is_authenticated
from modules.trading.order_manager import Order, OrderBook, OrderStatus

log = logging.getLogger(__name__)

_book = OrderBook()


def get_book() -> OrderBook:
    return _book


def place_order(
    tradingsymbol: str,
    transaction_type: str,
    quantity: int,
    price: float = 0.0,
    order_type: str = "MARKET",
    product: str = "MIS",
    strategy_id: str | None = None,
    exchange: str = "NFO",
) -> Order:
    """Place a real order via Kite Connect."""
    if not is_authenticated():
        raise RuntimeError("Kite not authenticated. Call /api/data/auth/login first.")

    kite = get_kite()

    order = Order(
        tradingsymbol=tradingsymbol,
        exchange=exchange,
        transaction_type=transaction_type,
        quantity=quantity,
        price=price,
        order_type=order_type,
        product=product,
        strategy_id=strategy_id,
    )
    _book.add_order(order)

    try:
        params = {
            "tradingsymbol": tradingsymbol,
            "exchange": exchange,
            "transaction_type": transaction_type,
            "quantity": quantity,
            "product": product,
            "order_type": order_type,
            "variety": "regular",
        }
        if order_type == "LIMIT":
            params["price"] = price

        kite_order_id = kite.place_order(**params)
        order.kite_order_id = str(kite_order_id)
        order.status = OrderStatus.OPEN
        log.info("Live order placed: %s (Kite ID: %s)", order.id, kite_order_id)

    except Exception as e:
        order.status = OrderStatus.REJECTED
        order.metadata["error"] = str(e)
        log.error("Order rejected: %s — %s", order.id, e)
        raise

    return order


def modify_order(
    order_id: str,
    price: float | None = None,
    quantity: int | None = None,
    order_type: str | None = None,
) -> Order | None:
    order = _book.orders.get(order_id)
    if not order or not order.kite_order_id:
        return None

    kite = get_kite()
    params: dict = {"variety": "regular", "order_id": order.kite_order_id}
    if price is not None:
        params["price"] = price
        order.price = price
    if quantity is not None:
        params["quantity"] = quantity
        order.quantity = quantity
    if order_type is not None:
        params["order_type"] = order_type
        order.order_type = order_type

    kite.modify_order(**params)
    log.info("Modified order %s (Kite: %s)", order_id, order.kite_order_id)
    return order


def cancel_order(order_id: str) -> bool:
    order = _book.orders.get(order_id)
    if not order or not order.kite_order_id:
        return False

    kite = get_kite()
    kite.cancel_order(variety="regular", order_id=order.kite_order_id)
    order.status = OrderStatus.CANCELLED
    log.info("Cancelled order %s (Kite: %s)", order_id, order.kite_order_id)
    return True


def sync_positions() -> list[dict]:
    """Sync positions from Kite to local order book."""
    if not is_authenticated():
        return []

    kite = get_kite()
    kite_positions = kite.positions()

    net = kite_positions.get("net", [])
    for pos in net:
        symbol = pos["tradingsymbol"]
        _book.update_ltp(symbol, pos.get("last_price", 0))

    return net


def get_orders(strategy_id: str | None = None) -> list[dict]:
    return _book.get_orders(strategy_id)


def get_positions(strategy_id: str | None = None) -> list[dict]:
    return _book.get_positions(strategy_id)
