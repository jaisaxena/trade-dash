"""Singleton feed state shared across all requests."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

import pandas as pd


@dataclass
class FeedState:
    mode: Literal["live", "replay"] = "live"
    underlying: str = "NIFTY"
    interval: str = "15m"

    # Replay-only fields
    replay_state: Literal["idle", "playing", "paused", "ended"] = "idle"
    speed: float = 1.0
    candles_df: pd.DataFrame | None = None
    virtual_start_dt: datetime | None = None
    wall_start_time: float | None = None   # time.monotonic() snapshot when play began
    paused_elapsed: float = 0.0            # accumulated wall-seconds during pauses


_state = FeedState()


def get_state() -> FeedState:
    return _state
