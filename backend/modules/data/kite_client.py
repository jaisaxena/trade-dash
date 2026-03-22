"""Singleton wrapper around the Kite Connect SDK.

Handles login URL generation, access-token exchange, and exposes
the authenticated KiteConnect instance to the rest of the backend.

The access token is stored in DuckDB (`kite_session`) so it survives API
restarts until it expires (Zerodha invalidates daily — you still need to
re-login on a new trading day).
"""

from __future__ import annotations

import logging
from kiteconnect import KiteConnect, KiteTicker

from config import settings

log = logging.getLogger(__name__)

_kite: KiteConnect | None = None
_access_token: str | None = None


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
    global _access_token
    kite = get_kite()
    data = kite.generate_session(
        request_token, api_secret=settings.KITE_API_SECRET
    )
    _access_token = data["access_token"]
    kite.set_access_token(_access_token)
    _persist_access_token(_access_token)
    log.info("Kite access token set and persisted")
    return _access_token


def set_token_directly(token: str) -> None:
    """Set an already-known access token (e.g. from env or prior session)."""
    global _access_token
    _access_token = token
    get_kite().set_access_token(token)
    _persist_access_token(token)


def is_authenticated() -> bool:
    if _access_token is not None:
        return True
    get_kite()
    return _access_token is not None


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
