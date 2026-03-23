"""Singleton wrapper around the Kite Connect SDK.

Handles login URL generation, access-token exchange, and exposes
the authenticated KiteConnect instance to the rest of the backend.

The access token is stored in DuckDB (`kite_session`) so it survives API
restarts until it expires (Zerodha invalidates daily — you still need to
re-login on a new trading day).
"""

from __future__ import annotations

import logging
import time
from kiteconnect import KiteConnect, KiteTicker

from config import settings

log = logging.getLogger(__name__)

_kite: KiteConnect | None = None
_access_token: str | None = None

_last_validated_at: float = 0.0
_last_validation_ok: bool = False
VALIDATION_CACHE_SECS = 60


class KiteAuthError(Exception):
    """Raised when a Kite API call fails due to invalid/expired credentials."""
    pass


AUTH_ERROR_KEYWORDS = ("api_key", "access_token", "TokenException")


def _load_stored_access_token() -> None:
    """If memory has no token yet, try DuckDB row id=1."""
    global _access_token, _kite
    if _access_token is not None or _kite is None:
        return
    try:
        from db import get_conn

        row = get_conn().execute(
            "SELECT access_token FROM kite_session WHERE id = 1"
        ).fetchone()
        if row and row[0]:
            _access_token = row[0]
            _kite.set_access_token(_access_token)
            log.info("Restored Kite access token from database")
    except Exception as e:
        log.warning("Could not load Kite token from database: %s", e)


def _persist_access_token(token: str) -> None:
    try:
        from db import get_conn

        conn = get_conn()
        conn.execute("DELETE FROM kite_session WHERE id = 1")
        conn.execute(
            "INSERT INTO kite_session (id, access_token, updated_at) "
            "VALUES (1, ?, CURRENT_TIMESTAMP)",
            [token],
        )
    except Exception as e:
        log.error("Could not persist Kite access token: %s", e)


def get_kite() -> KiteConnect:
    global _kite
    if _kite is None:
        _kite = KiteConnect(api_key=settings.KITE_API_KEY)
        _load_stored_access_token()
    return _kite


def get_login_url() -> str:
    return get_kite().login_url()


def set_access_token(request_token: str) -> str:
    """Exchange *request_token* for an access token and save it to DuckDB."""
    global _access_token, _last_validated_at, _last_validation_ok
    kite = get_kite()
    data = kite.generate_session(
        request_token, api_secret=settings.KITE_API_SECRET
    )
    _access_token = data["access_token"]
    kite.set_access_token(_access_token)
    _persist_access_token(_access_token)
    _last_validated_at = 0.0
    _last_validation_ok = False
    log.info("Kite access token set and persisted")
    return _access_token


def set_token_directly(token: str) -> None:
    """Set an already-known access token (e.g. from env or prior session)."""
    global _access_token, _last_validated_at, _last_validation_ok
    _access_token = token
    get_kite().set_access_token(token)
    _persist_access_token(token)
    _last_validated_at = 0.0
    _last_validation_ok = False


def is_authenticated() -> bool:
    """Fast check: is there a token in memory (does NOT validate with Kite)."""
    if _access_token is not None:
        return True
    get_kite()
    return _access_token is not None


def is_auth_error(exc: Exception) -> bool:
    """Return True if the exception indicates expired/invalid credentials."""
    msg = str(exc).lower()
    return any(kw.lower() in msg for kw in AUTH_ERROR_KEYWORDS)


def invalidate_session() -> None:
    """Clear the token from memory and DB — UI will show 'Kite Offline'."""
    global _access_token, _last_validated_at, _last_validation_ok
    _access_token = None
    _last_validated_at = 0.0
    _last_validation_ok = False
    if _kite is not None:
        _kite.set_access_token("")
    try:
        from db import get_conn
        get_conn().execute("DELETE FROM kite_session WHERE id = 1")
    except Exception as e:
        log.warning("Could not clear Kite session from database: %s", e)
    log.warning("Kite session invalidated — token cleared from memory and DB")


def validate_session() -> bool:
    """Call Kite to verify the token is still valid.

    Returns True if the token works, False otherwise.  Results are cached
    for VALIDATION_CACHE_SECS to avoid spamming Kite on every poll.
    """
    global _last_validated_at, _last_validation_ok

    if not is_authenticated():
        return False

    now = time.time()
    if (now - _last_validated_at) < VALIDATION_CACHE_SECS:
        return _last_validation_ok

    try:
        get_kite().profile()
        _last_validated_at = now
        _last_validation_ok = True
        return True
    except Exception as e:
        log.warning("Kite session validation failed: %s", e)
        if is_auth_error(e):
            invalidate_session()
        _last_validated_at = now
        _last_validation_ok = False
        return False


def get_ltps(instruments: list[str]) -> dict[str, float]:
    """Fetch LTP for a list of 'EXCHANGE:SYMBOL' strings. Returns {symbol: ltp}.
    Returns an empty dict if not authenticated or on any error."""
    if not is_authenticated() or not instruments:
        return {}
    try:
        raw = get_kite().ltp(instruments)
        return {
            data["tradingsymbol"]: data["last_price"]
            for data in raw.values()
            if data.get("last_price") is not None
        }
    except Exception as e:
        if is_auth_error(e):
            invalidate_session()
        log.warning("get_ltps failed: %s", e)
        return {}


def get_ticker(on_ticks, on_connect) -> KiteTicker:
    """Return a KiteTicker wired to *on_ticks* / *on_connect* callbacks."""
    get_kite()
    if not _access_token:
        raise RuntimeError("Authenticate with Kite first")
    ticker = KiteTicker(settings.KITE_API_KEY, _access_token)
    ticker.on_ticks = on_ticks
    ticker.on_connect = on_connect
    ticker.on_close = lambda ws, code, reason: log.warning(
        "Ticker closed: %s %s", code, reason
    )
    return ticker
