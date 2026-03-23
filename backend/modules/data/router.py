from __future__ import annotations

import logging
import threading
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from config import settings
from modules.data import kite_client, instruments, downloader
from modules.data.kite_client import KiteAuthError
from modules.data.downloader import SyncCancelledError
from modules.data.sync import smart_sync, smart_sync_full_history, get_data_status, UNDERLYING_CONFIG
from modules.data.sync_state import sync_tracker

log = logging.getLogger(__name__)

router = APIRouter()


# ── Auth ─────────────────────────────────────────────────────────────

class TokenRequest(BaseModel):
    request_token: str


class AccessTokenRequest(BaseModel):
    access_token: str


@router.get("/auth/login")
async def kite_login_url():
    if not kite_client.get_kite().api_key:
        raise HTTPException(400, "KITE_API_KEY not configured in .env")
    return {"login_url": kite_client.get_login_url()}


def _kite_oauth_html_page(*, ok: bool, message: str, detail: str = "") -> str:
    dash = settings.FRONTEND_URL.rstrip("/")
    if ok:
        body = f"""
        <p class="ok">{message}</p>
        <p>You can close this tab and return to Trade Dash, or click below.</p>
        <p><a class="btn" href="{dash}/data">Open Data Module →</a></p>
        """
    else:
        body = f"""
        <p class="err">{message}</p>
        {f'<pre>{detail}</pre>' if detail else ''}
        <p><a class="btn secondary" href="{dash}/data">Back to Trade Dash</a></p>
        """
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kite Connect — Trade Dash</title>
<style>
  body{{background:#0a0e17;color:#e2e8f0;font-family:system-ui,sans-serif;
       max-width:36rem;margin:4rem auto;padding:0 1.5rem;}}
  h1{{color:#3b82f6;margin-bottom:1.5rem;}}
  .ok{{color:#10b981;font-weight:600;font-size:1.1rem;}}
  .err{{color:#ef4444;font-weight:600;font-size:1.1rem;}}
  pre{{background:#0f1623;border:1px solid #1e293b;padding:1rem;border-radius:8px;
       overflow:auto;font-size:.85rem;color:#94a3b8;}}
  a.btn{{display:inline-block;margin-top:1.5rem;padding:.7rem 1.4rem;
         background:#2563eb;color:#fff;text-decoration:none;
         border-radius:8px;font-weight:600;transition:opacity .15s;}}
  a.btn:hover{{opacity:.85;}} a.btn.secondary{{background:#334155;}}
</style></head><body>
<h1>Trade Dash · Kite Auth</h1>{body}
</body></html>"""


@router.get("/auth/callback")
async def kite_callback_get(
    request_token: str | None = Query(None),
    status: str | None = Query(None),
):
    """Kite redirects here with GET + query params after login."""
    if status and status.lower() != "success":
        return HTMLResponse(
            _kite_oauth_html_page(ok=False, message="Kite login was not completed.", detail=f"status={status!r}"),
            status_code=400,
        )
    if not request_token:
        return HTMLResponse(
            _kite_oauth_html_page(ok=False, message="Missing request_token in redirect URL."),
            status_code=400,
        )
    try:
        kite_client.set_access_token(request_token)
    except Exception as e:
        return HTMLResponse(
            _kite_oauth_html_page(ok=False, message="Could not exchange request_token.", detail=str(e)),
            status_code=400,
        )
    return HTMLResponse(_kite_oauth_html_page(ok=True, message="Connected to Kite successfully."))


@router.post("/auth/callback")
async def kite_callback_post(body: TokenRequest):
    """Programmatic: exchange request_token for access_token (JSON body)."""
    try:
        token = kite_client.set_access_token(body.request_token)
        return {"access_token": token, "status": "authenticated"}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/auth/token")
async def set_token(body: AccessTokenRequest):
    kite_client.set_token_directly(body.access_token)
    return {"status": "authenticated"}


@router.get("/auth/status")
async def auth_status():
    valid = kite_client.validate_session()
    return {"authenticated": valid}


# ── Smart Sync (background thread) ────────────────────────────────────

class SyncRequest(BaseModel):
    underlyings: list[str] = ["NIFTY", "BANKNIFTY"]
    intervals: list[str] = ["15m", "day"]
    from_date: date | None = None
    to_date: date | None = None


class SyncFullRequest(BaseModel):
    underlyings: list[str] = ["NIFTY", "BANKNIFTY"]
    intervals: list[str] = ["15m", "day"]


def _run_sync_in_background(mode: str, underlyings: list[str], intervals: list[str],
                            from_date: date | None = None, to_date: date | None = None) -> None:
    """Worker function executed in a background thread."""
    try:
        if mode == "full":
            smart_sync_full_history(underlyings, intervals)
        else:
            smart_sync(underlyings, intervals, from_date, to_date)
        sync_tracker.finish()
    except KiteAuthError as e:
        sync_tracker.finish(error=f"Kite session expired: {e}")
    except SyncCancelledError:
        sync_tracker.finish()
    except Exception as e:
        log.exception("Sync thread crashed")
        sync_tracker.finish(error=str(e))


@router.post("/sync")
async def sync_data(body: SyncRequest):
    """Launch a date-range sync in the background."""
    if sync_tracker.is_active:
        raise HTTPException(409, "A sync is already in progress. Cancel it first or wait for it to finish.")
    if not kite_client.validate_session():
        raise HTTPException(401, "Kite session is invalid or expired. Please re-login.")
    sync_tracker.start("range", body.underlyings, body.intervals)
    t = threading.Thread(
        target=_run_sync_in_background,
        args=("range", body.underlyings, body.intervals, body.from_date, body.to_date),
        daemon=True,
    )
    t.start()
    return {"started": True}


@router.post("/sync/full")
async def sync_full_history(body: SyncFullRequest):
    """Launch a full-history sync in the background."""
    if sync_tracker.is_active:
        raise HTTPException(409, "A sync is already in progress. Cancel it first or wait for it to finish.")
    if not kite_client.validate_session():
        raise HTTPException(401, "Kite session is invalid or expired. Please re-login.")
    sync_tracker.start("full", body.underlyings, body.intervals)
    t = threading.Thread(
        target=_run_sync_in_background,
        args=("full", body.underlyings, body.intervals),
        daemon=True,
    )
    t.start()
    return {"started": True}


@router.get("/sync/status")
async def sync_status():
    """Poll current sync progress."""
    return sync_tracker.snapshot()


@router.post("/sync/cancel")
async def sync_cancel():
    """Request cancellation of the running sync."""
    if sync_tracker.cancel():
        return {"cancelled": True}
    raise HTTPException(404, "No active sync to cancel.")


@router.get("/status")
async def data_status():
    """Per-underlying, per-interval candle availability."""
    return get_data_status()


@router.get("/underlyings")
async def list_underlyings():
    """List all supported underlyings and their config."""
    return {
        k: {**v, "token": v["token"]}
        for k, v in UNDERLYING_CONFIG.items()
    }


# ── Instruments ──────────────────────────────────────────────────────

@router.post("/instruments/refresh")
async def refresh_instruments():
    count = instruments.refresh_instruments()
    return {"instruments_stored": count}


@router.get("/instruments")
async def list_instruments(
    q: str = "",
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Search cached F&O instruments (local DB; no Kite call)."""
    items, total = instruments.search_instruments(q, limit, offset)
    return {"total": total, "items": items, "limit": limit, "offset": offset}


@router.get("/instruments/expiries")
async def expiries(underlying: str = "NIFTY"):
    return {"expiries": instruments.get_expiries(underlying)}


@router.get("/instruments/strikes")
async def strikes(underlying: str = "NIFTY", expiry: date = Query(...)):
    return {"strikes": instruments.get_strikes(underlying, expiry)}


# ── Candles ──────────────────────────────────────────────────────────

@router.get("/candles")
async def get_candles(
    underlying: str,
    interval: str = "15m",
    from_date: date | None = None,
    to_date: date | None = None,
    limit: int | None = Query(None, description="Max rows to return (most recent first when set)"),
):
    """Fetch candles by underlying name — no token needed."""
    from modules.data.sync import get_token
    try:
        token = get_token(underlying)
    except ValueError as e:
        raise HTTPException(400, str(e))
    df = downloader.get_candles(token, interval, from_date, to_date)
    if limit and len(df) > limit:
        df = df.tail(limit)
    # Convert timestamps to ISO strings for JSON serialisation
    if "timestamp" in df.columns:
        df["timestamp"] = df["timestamp"].astype(str)
    return {"count": len(df), "candles": df.to_dict("records")}


@router.get("/storage/stats")
async def storage_stats():
    return downloader.get_storage_stats()
