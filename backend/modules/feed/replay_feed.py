"""Replay engine — serves stored candle data at configurable speed.

Speed semantics: speed = candles per second.
  0.5x → 1 candle every 2 s
  1x   → 1 candle per second
  5x   → 5 candles per second
"""
from __future__ import annotations

import time
import logging
from datetime import datetime

import pandas as pd

from modules.data.downloader import get_candles
from modules.data.sync import get_token

log = logging.getLogger(__name__)


def load_candles(underlying: str, interval: str, start_dt: datetime) -> pd.DataFrame:
    token = get_token(underlying.upper())
    return get_candles(token, interval, from_date=start_dt.date())


def _candle_idx(state) -> int:
    """Return the zero-based index of the current candle based on wall time elapsed."""
    elapsed_wall = state.paused_elapsed
    if state.replay_state == "playing" and state.wall_start_time is not None:
        elapsed_wall += time.monotonic() - state.wall_start_time
    # speed = candles per second → floor gives the candle step
    return int(elapsed_wall * state.speed)


def get_current_candle(state) -> dict | None:
    """Return the candle at the current replay position."""
    if state.candles_df is None or state.candles_df.empty:
        return None
    if state.replay_state == "idle":
        return None

    df = state.candles_df

    if state.wall_start_time is None and state.paused_elapsed == 0.0:
        # Configured but not yet played — preview the first candle
        return _row_to_dict(df.iloc[0])

    idx = _candle_idx(state)
    if idx >= len(df) - 1:
        state.replay_state = "ended"
        idx = len(df) - 1

    return _row_to_dict(df.iloc[idx])


def get_recent_candles(state, n: int = 50) -> list[dict]:
    """Return the last N candles up to and including the current position."""
    if state.candles_df is None or state.replay_state == "idle":
        return []

    df = state.candles_df

    if state.wall_start_time is None and state.paused_elapsed == 0.0:
        return [_row_to_dict(df.iloc[0])]

    idx = min(_candle_idx(state), len(df) - 1)
    start = max(0, idx - n + 1)
    return [_row_to_dict(df.iloc[i]) for i in range(start, idx + 1)]


def _row_to_dict(row) -> dict:
    ts = row["timestamp"]
    return {
        "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
        "open":   float(row["open"]),
        "high":   float(row["high"]),
        "low":    float(row["low"]),
        "close":  float(row["close"]),
        "volume": int(row["volume"]),
        "ltp":    float(row["close"]),
    }
