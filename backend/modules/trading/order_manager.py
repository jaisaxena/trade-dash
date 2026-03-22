"""Order lifecycle management — place, modify, cancel, and track orders
through both paper and live modes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4

log = logging.getLogger(__name__)


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    OPEN = "OPEN"
    COMPLETE = "COMPLETE"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"


class TransactionType(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


@dataclass
class Order:
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    tradingsymbol: str = ""
    exchange: str = "NFO"
    transaction_type: str = "BUY"
    quantity: int = 0
    price: float = 0.0
    order_type: str = "MARKET"
    product: str = "MIS"
    status: str = OrderStatus.PENDING
    kite_order_id: str | None = None
    fill_price: float | None = None
    timestamp: datetime = field(default_factory=datetime.now)
    strategy_id: str | None = None
    pnl: float = 0.0
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tradingsymbol": self.tradingsymbol,
            "exchange": self.exchange,
            "transaction_type": self.transaction_type,
            "quantity": self.quantity,
            "price": self.price,
            "order_type": self.order_type,
            "product": self.product,
            "status": self.status,
            "kite_order_id": self.kite_order_id,
            "fill_price": self.fill_price,
            "timestamp": self.timestamp.isoformat(),
            "strategy_id": self.strategy_id,
            "pnl": self.pnl,
        }


@dataclass
class Position:
    tradingsymbol: str
    exchange: str = "NFO"
    quantity: int = 0
    avg_price: float = 0.0
    ltp: float = 0.0
    pnl: float = 0.0
    strategy_id: str | None = None

    @property
    def unrealised_pnl(self) -> float:
        return (self.ltp - self.avg_price) * self.quantity

    def to_dict(self) -> dict:
        return {
            "tradingsymbol": self.tradingsymbol,
            "exchange": self.exchange,
            "quantity": self.quantity,
            "avg_price": self.avg_price,
            "ltp": self.ltp,
            "pnl": self.pnl,
            "unrealised_pnl": self.unrealised_pnl,
            "strategy_id": self.strategy_id,
        }


class OrderBook:
    """In-memory order and position tracker."""

    def __init__(self) -> None:
        self.orders: dict[str, Order] = {}
        self.positions: dict[str, Position] = {}

    def add_order(self, order: Order) -> Order:
        self.orders[order.id] = order
        log.info("Order %s added: %s %s %d @ %.2f",
                 order.id, order.transaction_type, order.tradingsymbol,
                 order.quantity, order.price)
        return order

    def fill_order(self, order_id: str, fill_price: float) -> Order | None:
        order = self.orders.get(order_id)
        if not order:
            return None

        order.fill_price = fill_price
        order.status = OrderStatus.COMPLETE

        key = order.tradingsymbol
        pos = self.positions.get(key)
        sign = 1 if order.transaction_type == "BUY" else -1
        qty = sign * order.quantity

        if pos is None:
            pos = Position(
                tradingsymbol=order.tradingsymbol,
                exchange=order.exchange,
                quantity=qty,
                avg_price=fill_price,
                strategy_id=order.strategy_id,
            )
            self.positions[key] = pos
        else:
            old_val = pos.avg_price * pos.quantity
            new_val = fill_price * qty
            total_qty = pos.quantity + qty
            if total_qty != 0:
                pos.avg_price = (old_val + new_val) / total_qty
            pos.quantity = total_qty

            if pos.quantity == 0:
                del self.positions[key]

        return order

    def cancel_order(self, order_id: str) -> bool:
        order = self.orders.get(order_id)
        if not order or order.status != OrderStatus.PENDING:
            return False
        order.status = OrderStatus.CANCELLED
        return True

    def get_orders(self, strategy_id: str | None = None) -> list[dict]:
        orders = self.orders.values()
        if strategy_id:
            orders = [o for o in orders if o.strategy_id == strategy_id]
        return [o.to_dict() for o in orders]

    def get_positions(self, strategy_id: str | None = None) -> list[dict]:
        positions = self.positions.values()
        if strategy_id:
            positions = [p for p in positions if p.strategy_id == strategy_id]
        return [p.to_dict() for p in positions]

    def update_ltp(self, tradingsymbol: str, ltp: float) -> None:
        pos = self.positions.get(tradingsymbol)
        if pos:
            pos.ltp = ltp
            pos.pnl = pos.unrealised_pnl

    def total_pnl(self) -> float:
        realized = sum(
            o.pnl for o in self.orders.values()
            if o.status == OrderStatus.COMPLETE
        )
        unrealized = sum(p.unrealised_pnl for p in self.positions.values())
        return realized + unrealized
