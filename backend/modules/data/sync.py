"""Underlying-aware smart sync.

Hardcodes well-known spot index tokens so callers never have to look
up or paste instrument tokens manually.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from db import get_conn
from modules.data.downloader import download_candles, download_full_history, SyncCancelledError, KITE_INTERVAL_MAP
from modules.data.kite_client import validate_session, KiteAuthError
from modules.data.sync_state import sync_tracker

log = logging.getLogger(__name__)

# Fixed NSE/BSE spot index tokens — these never change
SPOT_TOKENS: dict[str, int] = {
    "NIFTY":     256265,
    "BANKNIFTY": 260105,
    "FINNIFTY":  257801,
    "SENSEX":    265,
}

UNDERLYING_CONFIG: dict[str, dict] = {
    "NIFTY": {
        "token":        256265,
        "exchange":     "NSE",
        "lot_size":     25,
        "strike_gap":   50,
        "display_name": "Nifty 50",
    },
    "BANKNIFTY": {
        "token":        260105,
        "exchange":     "NSE",
        "lot_size":     15,
        "strike_gap":   100,
        "display_name": "Bank Nifty",
    },
    "FINNIFTY": {
        "token":        257801,
        "exchange":     "NSE",
        "lot_size":     25,
        "strike_gap":   50,
        "display_name": "Fin Nifty",
    },
    "SENSEX": {
        "token":        265,
        "exchange":     "BSE",
        "lot_size":     10,
        "strike_gap":   100,
        "display_name": "Sensex",
    },
}


def get_token(underlying: str) -> int:
    """Resolve underlying name → spot instrument token. Raises if unknown."""
    token = SPOT_TOKENS.get(underlying.upper())
    if token is None:
        raise ValueError(
            f"Unknown underlying '{underlying}'. "
            f"Supported: {list(SPOT_TOKENS.keys())}"
        )
    return token


def smart_sync(
    underlyings: list[str],
    intervals: list[str],
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[str, dict[str, int]]:
    """Download candles for a list of underlyings × intervals.

    Reports progress via sync_tracker and respects cancellation.

    Raises:
        KiteAuthError: if Kite session is invalid/expired (aborts immediately).
        SyncCancelledError: if cancelled by user.
    """
    if not validate_session():
        raise KiteAuthError("Kite session is invalid or expired. Please re-login.")

    if to_date is None:
        to_date = date.today()
    if from_date is None:
        from_date = to_date - timedelta(days=90)

    results: dict[str, dict[str, int]] = {}
    for underlying in underlyings:
        underlying = underlying.upper()
        token = get_token(underlying)
        results[underlying] = {}
        for interval in intervals:
            sync_tracker.begin_step(underlying, interval)
            try:
                count = download_candles(token, interval, from_date, to_date)
                results[underlying][interval] = count
                sync_tracker.complete_step(underlying, interval, count)
            except (KiteAuthError, SyncCancelledError):
                raise
            except Exception as e:
                log.error("Failed %s %s: %s", underlying, interval, e)
                results[underlying][interval] = -1
                sync_tracker.complete_step(underlying, interval, -1)

    return results


def smart_sync_full_history(
    underlyings: list[str],
    intervals: list[str],
) -> dict[str, dict[str, int]]:
    """Sync all available history for underlyings × intervals.

    Reports progress via sync_tracker and respects cancellation.

    Raises:
        KiteAuthError: if Kite session is invalid/expired (aborts immediately).
        SyncCancelledError: if cancelled by user.
    """
    if not validate_session():
        raise KiteAuthError("Kite session is invalid or expired. Please re-login.")

    results: dict[str, dict[str, int]] = {}
    for underlying in underlyings:
        underlying = underlying.upper()
        token = get_token(underlying)
        results[underlying] = {}
        for interval in intervals:
            sync_tracker.begin_step(underlying, interval)
            try:
                count = download_full_history(token, interval)
                results[underlying][interval] = count
                sync_tracker.complete_step(underlying, interval, count)
            except (KiteAuthError, SyncCancelledError):
                raise
            except Exception as e:
                log.error("Full-history failed %s %s: %s", underlying, interval, e)
                results[underlying][interval] = -1
                sync_tracker.complete_step(underlying, interval, -1)
    return results


def get_data_status() -> dict:
    """Return per-underlying, per-interval candle availability from DuckDB."""
    conn = get_conn()
    display_intervals = {
        "minute":    "1m",
        "5minute":   "5m",
        "15minute":  "15m",
        "60minute":  "1h",
        "day":       "day",
    }
    result: dict[str, dict] = {}
    for underlying, cfg in UNDERLYING_CONFIG.items():
        token = cfg["token"]
        intervals: dict[str, dict | None] = {}
        for kite_iv, label in display_intervals.items():
            try:
                cnt_row = conn.execute(
                    "SELECT COUNT(*) FROM candles "
                    "WHERE instrument_token = ? AND interval = ?",
                    [token, kite_iv],
                ).fetchone()
                cnt = cnt_row[0] if cnt_row else 0
                if cnt > 0:
                    rng = conn.execute(
                        "SELECT MIN(timestamp), MAX(timestamp) FROM candles "
                        "WHERE instrument_token = ? AND interval = ?",
                        [token, kite_iv],
                    ).fetchone()
                    intervals[label] = {
                        "count": cnt,
                        "from":  str(rng[0])[:10] if rng and rng[0] else None,
                        "to":    str(rng[1])[:10] if rng and rng[1] else None,
                    }
                else:
                    intervals[label] = None
            except Exception as e:
                log.error("Error reading candle status for %s %s: %s", underlying, kite_iv, e)
                intervals[label] = None
        result[underlying] = {
            "display_name": cfg["display_name"],
            "token":        token,
            "intervals":    intervals,
            "has_any":      any(v is not None for v in intervals.values()),
        }
    return result
