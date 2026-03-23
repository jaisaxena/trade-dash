"""Incremental OHLCV downloader with Kite API rate-limit awareness.

Downloads candle data for given instrument tokens, only fetching date
ranges that are missing from DuckDB.  Kite allows up to 60 days of
minute-level data per request and limits to ~3 requests/second.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta

import pandas as pd

from db import get_conn
from modules.data.kite_client import get_kite, is_auth_error, invalidate_session, KiteAuthError
from modules.data.sync_state import sync_tracker


class SyncCancelledError(Exception):
    pass

log = logging.getLogger(__name__)

INTERVAL_MAP = {
    "1m": "minute",
    "5m": "5minute",
    "15m": "15minute",
    "day": "day",
}

KITE_INTERVAL_MAP = {
    "1m": "minute",
    "5m": "5minute",
    "15m": "15minute",
    "day": "day",
}

MAX_DAYS_PER_CALL = {
    "1m": 60,
    "5m": 100,
    "15m": 200,
    "day": 2000,
}

RATE_LIMIT_DELAY = 0.35  # seconds between Kite API calls


def _last_stored_ts(token: int, interval: str) -> datetime | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT MAX(timestamp) FROM candles WHERE instrument_token = ? AND interval = ?",
        [token, interval],
    ).fetchone()
    return row[0] if row and row[0] else None


def _first_stored_ts(token: int, interval: str) -> datetime | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT MIN(timestamp) FROM candles WHERE instrument_token = ? AND interval = ?",
        [token, interval],
    ).fetchone()
    return row[0] if row and row[0] else None


def download_candles(
    instrument_token: int,
    interval: str = "15m",
    from_date: date | None = None,
    to_date: date | None = None,
) -> int:
    """Download OHLCV candles incrementally. Returns count of new rows."""
    kite = get_kite()
    kite_interval = KITE_INTERVAL_MAP[interval]
    max_days = MAX_DAYS_PER_CALL[interval]

    if to_date is None:
        to_date = date.today()

    last_ts = _last_stored_ts(instrument_token, kite_interval)
    if from_date is None:
        from_date = (last_ts.date() + timedelta(days=1)) if last_ts else (to_date - timedelta(days=max_days))

    if from_date > to_date:
        log.info("Token %d interval %s already up-to-date", instrument_token, interval)
        return 0

    total_inserted = 0
    cursor = from_date

    while cursor <= to_date:
        if sync_tracker.is_cancelled():
            raise SyncCancelledError("Sync cancelled by user")

        chunk_end = min(cursor + timedelta(days=max_days - 1), to_date)

        try:
            records = kite.historical_data(
                instrument_token,
                cursor,
                chunk_end,
                kite_interval,
                oi=True,
            )
        except Exception as e:
            if is_auth_error(e):
                invalidate_session()
                raise KiteAuthError(f"Kite auth failed for token {instrument_token}: {e}") from e
            log.error("Kite API error for token %d: %s", instrument_token, e)
            time.sleep(1)
            cursor = chunk_end + timedelta(days=1)
            continue

        if records:
            df = pd.DataFrame(records)
            df["instrument_token"] = instrument_token
            df["interval"] = kite_interval
            df.rename(columns={"date": "timestamp"}, inplace=True)
            df["timestamp"] = pd.to_datetime(df["timestamp"])

            if "oi" not in df.columns:
                df["oi"] = 0

            df = df[["instrument_token", "timestamp", "interval",
                      "open", "high", "low", "close", "volume", "oi"]]

            conn = get_conn()
            conn.execute(
                "DELETE FROM candles WHERE instrument_token = ? AND interval = ? "
                "AND timestamp >= ? AND timestamp <= ?",
                [instrument_token, kite_interval, cursor, chunk_end],
            )
            conn.execute("INSERT INTO candles SELECT * FROM df")
            total_inserted += len(df)

        time.sleep(RATE_LIMIT_DELAY)
        cursor = chunk_end + timedelta(days=1)

    return total_inserted


def download_full_history(
    instrument_token: int,
    interval: str = "day",
) -> int:
    """Download ALL available history for a token+interval.

    Strategy:
      1. Sync forward from newest stored candle → today.
      2. Walk backwards from oldest stored candle until Kite returns
         two consecutive empty chunks (= start of available history).
    Returns total rows inserted across both passes.
    """
    kite = get_kite()
    kite_interval = KITE_INTERVAL_MAP[interval]
    max_days = MAX_DAYS_PER_CALL[interval]
    today = date.today()
    total_inserted = 0

    # ── Pass 1: forward sync (newest → today) ──────────────────────────
    newest = _last_stored_ts(instrument_token, kite_interval)
    forward_start = (newest.date() + timedelta(days=1)) if newest else (today - timedelta(days=max_days))
    if forward_start <= today:
        log.info("Full-history forward pass: token=%d %s from %s", instrument_token, interval, forward_start)
        total_inserted += download_candles(instrument_token, interval, forward_start, today)

    # ── Pass 2: backward walk ──────────────────────────────────────────
    oldest = _first_stored_ts(instrument_token, kite_interval)
    if oldest:
        backward_end = oldest.date() - timedelta(days=1)
    else:
        # Nothing stored yet (forward pass may have failed); start walking back from today
        backward_end = today - timedelta(days=max_days + 1)

    consecutive_empty = 0
    SAFETY_FLOOR = date(1994, 1, 1)  # NSE inception

    while backward_end > SAFETY_FLOOR and consecutive_empty < 2:
        if sync_tracker.is_cancelled():
            raise SyncCancelledError("Sync cancelled by user")

        chunk_start = max(backward_end - timedelta(days=max_days - 1), SAFETY_FLOOR)

        try:
            records = kite.historical_data(
                instrument_token, chunk_start, backward_end, kite_interval, oi=True
            )
        except Exception as e:
            if is_auth_error(e):
                invalidate_session()
                raise KiteAuthError(f"Kite auth failed for token {instrument_token}: {e}") from e
            log.error("Kite API error going backward (token=%d %s → %s): %s", instrument_token, chunk_start, backward_end, e)
            consecutive_empty += 1
            backward_end = chunk_start - timedelta(days=1)
            time.sleep(1)
            continue

        if not records:
            consecutive_empty += 1
            log.info(
                "Backward: empty chunk token=%d %s→%s (consecutive=%d)",
                instrument_token, chunk_start, backward_end, consecutive_empty,
            )
        else:
            consecutive_empty = 0
            df = pd.DataFrame(records)
            df["instrument_token"] = instrument_token
            df["interval"] = kite_interval
            df.rename(columns={"date": "timestamp"}, inplace=True)
            df["timestamp"] = pd.to_datetime(df["timestamp"])
            if "oi" not in df.columns:
                df["oi"] = 0
            df = df[["instrument_token", "timestamp", "interval",
                      "open", "high", "low", "close", "volume", "oi"]]

            conn = get_conn()
            conn.execute(
                "DELETE FROM candles WHERE instrument_token = ? AND interval = ? "
                "AND timestamp >= ? AND timestamp <= ?",
                [instrument_token, kite_interval, chunk_start, backward_end],
            )
            conn.execute("INSERT INTO candles SELECT * FROM df")
            total_inserted += len(df)
            log.info(
                "Backward: token=%d inserted %d candles (%s → %s)",
                instrument_token, len(df), chunk_start, backward_end,
            )

        time.sleep(RATE_LIMIT_DELAY)
        backward_end = chunk_start - timedelta(days=1)

    log.info("Full history done: token=%d %s, total inserted=%d", instrument_token, interval, total_inserted)
    return total_inserted


def download_bulk(
    tokens: list[int],
    interval: str = "15m",
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[int, int]:
    """Download candles for multiple tokens. Returns {token: count}."""
    results = {}
    for token in tokens:
        count = download_candles(token, interval, from_date, to_date)
        results[token] = count
    return results


def get_candles(
    instrument_token: int,
    interval: str = "15m",
    from_date: date | None = None,
    to_date: date | None = None,
) -> pd.DataFrame:
    """Read candles from DuckDB."""
    conn = get_conn()
    kite_interval = KITE_INTERVAL_MAP.get(interval, interval)
    clauses = ["instrument_token = ?", "interval = ?"]
    params: list = [instrument_token, kite_interval]

    if from_date:
        clauses.append("timestamp >= ?")
        params.append(from_date)
    if to_date:
        clauses.append("timestamp <= ?")
        params.append(to_date)

    where = " AND ".join(clauses)
    return conn.execute(
        f"SELECT * FROM candles WHERE {where} ORDER BY timestamp", params
    ).fetchdf()


def get_storage_stats() -> dict:
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
    by_interval = conn.execute(
        "SELECT interval, COUNT(*) as cnt FROM candles GROUP BY interval"
    ).fetchdf().to_dict("records")
    instruments_count = conn.execute(
        "SELECT COUNT(DISTINCT instrument_token) FROM candles"
    ).fetchone()[0]
    return {
        "total_candles": total,
        "by_interval": by_interval,
        "instruments_with_data": instruments_count,
    }
