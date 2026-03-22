"""NSE F&O instrument list management.

Downloads the full instrument dump from Kite, filters to the F&O segment,
and stores it in DuckDB for fast lookup.
"""

from __future__ import annotations

import logging
from datetime import date

import pandas as pd

from db import get_conn
from modules.data.kite_client import get_kite

log = logging.getLogger(__name__)

INDEX_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"]

EXCHANGE_MAP = {
    "NIFTY": "NSE",
    "BANKNIFTY": "NSE",
    "FINNIFTY": "NSE",
    "SENSEX": "BSE",
}

SPOT_TOKENS = {
    "NIFTY": ("NSE", "NIFTY 50"),
    "BANKNIFTY": ("NSE", "NIFTY BANK"),
    "FINNIFTY": ("NSE", "NIFTY FIN SERVICE"),
    "SENSEX": ("BSE", "SENSEX"),
}

# Must match column order of `instruments` in db.py (Kite may return extra fields).
INSTRUMENT_DB_COLUMNS = (
    "instrument_token",
    "exchange_token",
    "tradingsymbol",
    "name",
    "exchange",
    "segment",
    "instrument_type",
    "strike",
    "expiry",
    "lot_size",
    "tick_size",
    "last_updated",
)


def refresh_instruments() -> int:
    """Download all instruments from Kite and upsert into DuckDB.
    Returns the count of F&O instruments stored."""
    kite = get_kite()
    raw = kite.instruments()
    df = pd.DataFrame(raw)

    fno = df[df["segment"].isin(["NFO-OPT", "NFO-FUT", "BFO-OPT", "BFO-FUT"])].copy()
    fno["last_updated"] = pd.Timestamp.now()

    missing = [c for c in INSTRUMENT_DB_COLUMNS if c not in fno.columns]
    if missing:
        raise ValueError(f"Kite instrument dump missing expected columns: {missing}")
    to_store = fno.loc[:, list(INSTRUMENT_DB_COLUMNS)]

    conn = get_conn()
    conn.execute("DELETE FROM instruments")
    conn.register("_fno_staging", to_store)
    try:
        conn.execute("INSERT INTO instruments SELECT * FROM _fno_staging")
    finally:
        conn.unregister("_fno_staging")
    count = conn.execute("SELECT COUNT(*) FROM instruments").fetchone()[0]
    log.info("Refreshed %d F&O instruments", count)
    return count


def _trigram_score(text: str, query: str) -> int:
    """Return count of query characters found in text (simple fuzzy score)."""
    text_lower = text.lower()
    score = 0
    for ch in query.lower():
        if ch in text_lower:
            score += 1
    return score


def search_instruments(
    search: str = "",
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Return a page of instruments from DuckDB plus total matching count.

    Matching logic (in order of precision):
      1. Exact prefix on tradingsymbol (highest priority)
      2. Substring match on tradingsymbol or name or token string
      3. Fuzzy / typo tolerance: any row where >=80% of query characters appear
         in tradingsymbol or name — catches 'mifty' → NIFTY, 'banknipty' → BANKNIFTY
    """
    conn = get_conn()
    limit = min(max(1, limit), 500)
    offset = max(0, offset)
    search = search.strip()

    cols = (
        "instrument_token, tradingsymbol, name, exchange, segment, "
        "instrument_type, strike, expiry, lot_size"
    )
    keys = [
        "instrument_token", "tradingsymbol", "name", "exchange", "segment",
        "instrument_type", "strike", "expiry", "lot_size",
    ]

    if not search:
        total = conn.execute("SELECT COUNT(*) FROM instruments").fetchone()[0]
        rows = conn.execute(
            f"SELECT {cols} FROM instruments ORDER BY tradingsymbol LIMIT ? OFFSET ?",
            [limit, offset],
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            row = dict(zip(keys, r, strict=True))
            if row.get("expiry") is not None and hasattr(row["expiry"], "isoformat"):
                row["expiry"] = row["expiry"].isoformat()
            out.append(row)
        return out, int(total)

    # ── Phase 1: substring match (fast SQL) ─────────────────────────────
    where = (
        "(strpos(lower(tradingsymbol), lower(?)) > 0 "
        "OR strpos(lower(COALESCE(name, '')), lower(?)) > 0 "
        "OR strpos(CAST(instrument_token AS VARCHAR), ?) > 0)"
    )
    params: list = [search, search, search]

    total = conn.execute(f"SELECT COUNT(*) FROM instruments WHERE {where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT {cols} FROM instruments WHERE {where} ORDER BY tradingsymbol LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    # ── Phase 2: fuzzy fallback when substring finds nothing ─────────────
    if not rows:
        threshold = max(1, int(len(search) * 0.75))  # need ≥75% char match
        candidates = conn.execute(
            f"SELECT {cols} FROM instruments "
            "WHERE length(tradingsymbol) <= ? + ? ORDER BY tradingsymbol LIMIT 5000",
            [len(search), max(6, len(search))],
        ).fetchall()

        scored: list[tuple[int, tuple]] = []
        for r in candidates:
            sym = r[1] or ""
            name = r[2] or ""
            score = max(_trigram_score(sym, search), _trigram_score(name, search))
            if score >= threshold:
                scored.append((score, r))

        scored.sort(key=lambda x: -x[0])
        total = len(scored)
        page = scored[offset: offset + limit]
        rows = [r for _, r in page]

    out = []
    for r in rows:
        row = dict(zip(keys, r, strict=True))
        if row.get("expiry") is not None and hasattr(row["expiry"], "isoformat"):
            row["expiry"] = row["expiry"].isoformat()
        out.append(row)
    return out, int(total)


def get_spot_token(underlying: str) -> int | None:
    """Get the instrument token for a spot index."""
    exchange, name = SPOT_TOKENS.get(underlying, (None, None))
    if not exchange:
        return None
    conn = get_conn()
    kite = get_kite()
    instruments = kite.instruments(exchange)
    for inst in instruments:
        if inst["tradingsymbol"] == name or inst["name"] == name:
            return inst["instrument_token"]
    return None


def get_option_instruments(
    underlying: str,
    expiry: date | None = None,
    option_type: str | None = None,
) -> pd.DataFrame:
    """Query stored option instruments, optionally filtered."""
    conn = get_conn()
    clauses = ["name = ?"]
    params: list = [underlying]

    if expiry:
        clauses.append("expiry = ?")
        params.append(expiry)
    if option_type:
        clauses.append("instrument_type = ?")
        params.append(option_type)

    where = " AND ".join(clauses)
    return conn.execute(
        f"SELECT * FROM instruments WHERE {where} ORDER BY strike, expiry",
        params,
    ).fetchdf()


def get_expiries(underlying: str) -> list[date]:
    """Return sorted list of available expiry dates for an underlying."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT DISTINCT expiry FROM instruments WHERE name = ? ORDER BY expiry",
        [underlying],
    ).fetchall()
    return [r[0] for r in rows]


def get_strikes(underlying: str, expiry: date) -> list[float]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT DISTINCT strike FROM instruments "
        "WHERE name = ? AND expiry = ? ORDER BY strike",
        [underlying, expiry],
    ).fetchall()
    return [r[0] for r in rows]
