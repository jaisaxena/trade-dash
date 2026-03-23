"""Auto-trade API router."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from modules.auto_trade.state import get_state

router = APIRouter()


class EnableRequest(BaseModel):
    strategy_id: str
    trading_mode: Literal["paper", "live"] = "paper"


class TickRequest(BaseModel):
    strategy_id: str
    trading_mode: Literal["paper", "live"] = "paper"


@router.post("/enable")
async def enable(body: EnableRequest):
    """Enable auto-trade for a strategy.  Does not place any orders yet —
    the first tick that fires an entry signal will do that."""
    state = get_state()
    state.enabled      = True
    state.strategy_id  = body.strategy_id
    state.trading_mode = body.trading_mode
    return {"enabled": True, "status": state.status, "current_direction": state.current_direction, "open_legs": list(state.open_legs.keys())}


@router.post("/disable")
async def disable():
    """Disable auto-trade.  Open positions are left untouched — the engine
    simply stops watching.  Re-enabling will resume monitoring."""
    state = get_state()
    state.enabled = False
    return {"enabled": False, "status": state.status, "current_direction": state.current_direction, "open_legs": list(state.open_legs.keys())}


@router.post("/tick")
async def tick(body: TickRequest):
    """Run one evaluation cycle.  Should be called on every strategy-monitor
    poll while auto-trade is enabled."""
    from modules.auto_trade.engine import tick as engine_tick
    result = engine_tick(body.strategy_id, body.trading_mode)
    return result


@router.get("/status")
async def status():
    """Return current auto-trade state."""
    state = get_state()
    return {
        "enabled":           state.enabled,
        "status":            state.status,
        "current_direction": state.current_direction,
        "strategy_id":       state.strategy_id,
        "trading_mode":      state.trading_mode,
        "session_id":        state.session_id,
        "open_legs":         list(state.open_legs.keys()),
        "entry_time":        state.entry_time.isoformat() if state.entry_time else None,
        "last_action":       state.last_action,
        "last_tick":         state.last_tick.isoformat() if state.last_tick else None,
    }
