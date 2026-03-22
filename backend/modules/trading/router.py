from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from modules.trading import paper_trader, live_trader
from modules.data.kite_client import get_ltps, is_authenticated

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


# ── LTP refresh (fetches from Kite for all open positions) ────────────

@router.post("/refresh-ltps")
async def refresh_ltps():
    """Refresh LTPs for every open paper + live position.

    Uses Kite when authenticated; falls back to Black-Scholes feed estimates
    for option positions so that replay P&L tracks sensibly without live auth.
    """
    all_positions = {
        **paper_trader.get_book().positions,
        **live_trader.get_book().positions,
    }
    if not all_positions:
        return {"updated": 0, "ltps": {}}

    # Kite pass (skip entirely when not authenticated to avoid noise)
    kite_ltps: dict[str, float] = {}
    if is_authenticated():
        instruments = [f"{p.exchange}:{sym}" for sym, p in all_positions.items()]
        kite_ltps = get_ltps(instruments)

    # For symbols Kite didn't cover, use feed-based estimation (B-S for options).
    # est=0 is valid for expired OTM options — let it propagate so LTP shows 0.
    final_ltps: dict[str, float] = dict(kite_ltps)
    for sym in all_positions:
        if sym not in final_ltps:
            est = paper_trader._estimate_price_from_feed(sym)
            if est is not None:
                final_ltps[sym] = est

    for sym, ltp in final_ltps.items():
        paper_trader.get_book().update_ltp(sym, ltp)
        live_trader.get_book().update_ltp(sym, ltp)

    return {"updated": len(final_ltps), "ltps": final_ltps}


# ── Close position (paper + live) ────────────────────────────────────

@router.post("/paper/position/{tradingsymbol}/close")
async def paper_close_position(tradingsymbol: str):
    """Place a reversing order to close a paper position.
    Fetches current LTP from Kite automatically; falls back to stored LTP / avg."""
    pos = paper_trader.get_book().positions.get(tradingsymbol)
    if not pos:
        raise HTTPException(404, f"No open position for {tradingsymbol}")
    side = "SELL" if pos.quantity > 0 else "BUY"
    try:
        order = paper_trader.place_order(
            tradingsymbol, side, abs(pos.quantity),
            0.0,  # _resolve_fill_price will auto-fetch from Kite
            pos.strategy_id, pos.exchange,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"order": order.to_dict()}


@router.post("/live/position/{tradingsymbol}/close")
async def live_close_position(tradingsymbol: str):
    """Place a reversing market order to close a live position."""
    pos = live_trader.get_book().positions.get(tradingsymbol)
    if not pos:
        raise HTTPException(404, f"No open position for {tradingsymbol}")
    side = "SELL" if pos.quantity > 0 else "BUY"
    try:
        order = live_trader.place_order(
            tradingsymbol, side, abs(pos.quantity),
            0.0, "MARKET", "MIS", pos.strategy_id, pos.exchange,
        )
        return {"order": order.to_dict()}
    except RuntimeError as e:
        raise HTTPException(401, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))
