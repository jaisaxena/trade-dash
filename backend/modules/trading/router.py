from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from modules.trading import paper_trader, live_trader

router = APIRouter()


class PlaceOrderRequest(BaseModel):
    tradingsymbol: str
    transaction_type: str  # BUY or SELL
    quantity: int
    price: float = 0.0
    order_type: str = "MARKET"
    product: str = "MIS"
    strategy_id: str | None = None
    exchange: str = "NFO"


class ModifyOrderRequest(BaseModel):
    price: float | None = None
    quantity: int | None = None
    order_type: str | None = None


# ── Paper Trading ────────────────────────────────────────────────────

@router.post("/paper/order")
async def paper_place(body: PlaceOrderRequest):
    order = paper_trader.place_order(
        body.tradingsymbol, body.transaction_type, body.quantity,
        body.price, body.strategy_id, body.exchange,
    )
    return {"order": order.to_dict()}


@router.get("/paper/orders")
async def paper_orders(strategy_id: str | None = None):
    return {"orders": paper_trader.get_orders(strategy_id)}


@router.get("/paper/positions")
async def paper_positions(strategy_id: str | None = None):
    return {"positions": paper_trader.get_positions(strategy_id)}


@router.get("/paper/pnl")
async def paper_pnl():
    return paper_trader.get_pnl()


@router.post("/paper/reset")
async def paper_reset():
    paper_trader.reset_book()
    return {"status": "reset"}


# ── Live Trading ─────────────────────────────────────────────────────

@router.post("/live/order")
async def live_place(body: PlaceOrderRequest):
    try:
        order = live_trader.place_order(
            body.tradingsymbol, body.transaction_type, body.quantity,
            body.price, body.order_type, body.product,
            body.strategy_id, body.exchange,
        )
        return {"order": order.to_dict()}
    except RuntimeError as e:
        raise HTTPException(401, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))


@router.put("/live/order/{order_id}")
async def live_modify(order_id: str, body: ModifyOrderRequest):
    order = live_trader.modify_order(
        order_id, body.price, body.quantity, body.order_type
    )
    if not order:
        raise HTTPException(404, "Order not found")
    return {"order": order.to_dict()}


@router.delete("/live/order/{order_id}")
async def live_cancel(order_id: str):
    ok = live_trader.cancel_order(order_id)
    if not ok:
        raise HTTPException(404, "Order not found")
    return {"cancelled": True}


@router.get("/live/orders")
async def live_orders(strategy_id: str | None = None):
    return {"orders": live_trader.get_orders(strategy_id)}


@router.get("/live/positions")
async def live_positions(strategy_id: str | None = None):
    return {"positions": live_trader.get_positions(strategy_id)}


@router.post("/live/sync")
async def live_sync():
    positions = live_trader.sync_positions()
    return {"kite_positions": positions}
