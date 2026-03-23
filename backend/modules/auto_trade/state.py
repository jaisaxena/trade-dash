"""Auto-trade singleton state.

The state machine has three statuses:
  idle     — no auto-managed position open; watching for directional signal.
  in_long  — long legs are open; watching for exit / reversal to short.
  in_short — short legs are open; watching for exit / reversal to long.

Disabling auto-trade (enabled=False) pauses the engine without touching
open positions.  Re-enabling resumes from wherever we left off: if the
tracked legs are still open in the order book, status is restored;
if they were closed externally, we reset to idle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal


@dataclass
class LegRecord:
    """One instrument leg opened by auto-trade."""
    tradingsymbol: str
    exchange: str
    quantity: int
    action: str            # "BUY" or "SELL" — the action that OPENED this leg


@dataclass
class AutoTradeState:
    enabled: bool = False
    status: Literal["idle", "in_long", "in_short"] = "idle"
    current_direction: Literal["long", "short"] | None = None

    strategy_id: str | None = None
    trading_mode: Literal["paper", "live"] = "paper"

    session_id: str | None = None

    # Legs currently managed by auto-trade: {tradingsymbol: LegRecord}
    open_legs: dict[str, LegRecord] = field(default_factory=dict)

    entry_time: datetime | None = None
    last_action: str | None = None   # "entered_long" | "entered_short" | "reversed" | "exited" | "expiry_exit" | "resumed"
    last_tick: datetime | None = None


_state = AutoTradeState()


def get_state() -> AutoTradeState:
    return _state
