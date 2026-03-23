"""Live market data via Kite REST API (quote + historical candles)."""
from __future__ import annotations

import logging
import time
from datetime import datetime, date, timedelta

import pandas as pd

from modules.data.kite_client import get_kite, is_authenticated, is_auth_error, invalidate_session

log = logging.getLogger(__name__)

KITE_QUOTE_SYMBOL: dict[str, str] = {
    "NIFTY":     "NSE:NIFTY 50",
    "BANKNIFTY": "NSE:NIFTY BANK",
    "FINNIFTY":  "NSE:NIFTY FIN SERVICE",
    "SENSEX":    "BSE:SENSEX",
}

SPOT_TOKENS: dict[str, int] = {
    "NIFTY":     256265,
    "BANKNIFTY": 260105,
    "FINNIFTY":  257801,
    "SENSEX":    265,
}

KITE_INTERVAL_MAP: dict[str, str] = {
    "1m": "minute",
    "5m": "5minute",
    "15m": "15minute",
    "1h": "60minute",
    "day": "day",
}

_LOOKBACK_DAYS: dict[str, int] = {
    "1m": 3,
    "5m": 7,
    "15m": 14,
    "1h": 30,
    "day": 365,
}

_CACHE_TTL_SECS: dict[str, float] = {
    "1m": 15,
    "5m": 30,
    "15m": 60,
    "1h": 120,
    "day": 300,
}

_candle_cache: dict[tuple[str, str], tuple[float, pd.DataFrame]] = {}


def get_live_quote(underlying: str) -> dict | None:
    """Fetch full market quote from Kite (OHLC + volume + LTP).

    Falls back to ltp() if quote() is unavailable.
    Returns None if unauthenticated.
    """
    if not is_authenticated():
        return None
    symbol = KITE_QUOTE_SYMBOL.get(underlying.upper())
    if not symbol:
        return None
    try:
        data = get_kite().quote([symbol])
        q = data.get(symbol, {})
        ohlc = q.get("ohlc", {})
        ltp = q.get("last_price", 0.0)
        last_time = q.get("last_trade_time")
        if hasattr(last_time, "replace"):
            last_time = last_time.replace(tzinfo=None)
        ts = last_time.isoformat() if hasattr(last_time, "isoformat") else datetime.now().isoformat()
        return {
            "timestamp": ts,
            "open":   ohlc.get("open", ltp),
            "high":   ohlc.get("high", ltp),
            "low":    ohlc.get("low", ltp),
            "close":  ltp,
            "volume": q.get("volume", 0),
            "ltp":    ltp,
        }
    except Exception as e:
        if is_auth_error(e):
            invalidate_session()
        log.warning("Live quote failed for %s: %s", underlying, e)
        return None


def get_live_candles(underlying: str, interval: str, count: int = 500) -> pd.DataFrame:
    """Fetch recent candles from Kite historical data API with caching.

    Returns a DataFrame matching the local candle schema, or an empty
    DataFrame if unauthenticated / on error.  Falls back to expired cache
    on transient failures so the chart is never blank.
    """
    if not is_authenticated():
        return pd.DataFrame()

    underlying = underlying.upper()
    token = SPOT_TOKENS.get(underlying)
    kite_interval = KITE_INTERVAL_MAP.get(interval)
    if token is None or kite_interval is None:
        return pd.DataFrame()

    cache_key = (underlying, interval)
    ttl = _CACHE_TTL_SECS.get(interval, 60)
    now = time.time()

    if cache_key in _candle_cache:
        cached_at, cached_df = _candle_cache[cache_key]
        if (now - cached_at) < ttl and not cached_df.empty:
            return cached_df.tail(count).copy()

    lookback = _LOOKBACK_DAYS.get(interval, 14)
    to_dt = date.today()
    from_dt = to_dt - timedelta(days=lookback)

    try:
        records = get_kite().historical_data(
            token, from_dt, to_dt, kite_interval, oi=True,
        )
        if not records:
            log.info("Kite returned 0 candles for %s %s", underlying, interval)
            return _cache_fallback(cache_key, count)

        df = pd.DataFrame(records)
        df.rename(columns={"date": "timestamp"}, inplace=True)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        # Kite returns tz-aware datetimes (IST); strip tz to match local DB
        # format and keep chart labels showing market time (09:15 not 03:45).
        if df["timestamp"].dt.tz is not None:
            df["timestamp"] = df["timestamp"].apply(lambda x: x.replace(tzinfo=None))
        df["instrument_token"] = token
        df["interval"] = kite_interval
        if "oi" not in df.columns:
            df["oi"] = 0

        df = df[["instrument_token", "timestamp", "interval",
                  "open", "high", "low", "close", "volume", "oi"]]
        df = df.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)

        _candle_cache[cache_key] = (now, df)
        log.debug("Cached %d live candles for %s %s", len(df), underlying, interval)
        return df.tail(count).copy()

    except Exception as e:
        if is_auth_error(e):
            invalidate_session()
        log.warning("Live candles fetch failed for %s %s: %s", underlying, interval, e)
        return _cache_fallback(cache_key, count)


def _cache_fallback(cache_key: tuple[str, str], count: int) -> pd.DataFrame:
    """Return stale cached data when a fresh fetch fails."""
    if cache_key in _candle_cache:
        _, cached_df = _candle_cache[cache_key]
        if not cached_df.empty:
            return cached_df.tail(count).copy()
    return pd.DataFrame()
