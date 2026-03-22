"""Live market quote via Kite REST (interval-polled, no WebSocket)."""
from __future__ import annotations

import logging
from datetime import datetime

from modules.data.kite_client import get_kite, is_authenticated

log = logging.getLogger(__name__)

# Kite LTP symbol strings for each supported underlying
KITE_LTP_SYMBOL: dict[str, str] = {
    "NIFTY":     "NSE:NIFTY 50",
    "BANKNIFTY": "NSE:NIFTY BANK",
    "FINNIFTY":  "NSE:NIFTY FIN SERVICE",
    "SENSEX":    "BSE:SENSEX",
}


def get_live_quote(underlying: str) -> dict | None:
    """Poll Kite LTP for the given underlying. Returns None if unauthenticated."""
    if not is_authenticated():
        return None
    symbol = KITE_LTP_SYMBOL.get(underlying.upper())
    if not symbol:
        return None
    try:
        data = get_kite().ltp([symbol])
        ltp = data.get(symbol, {}).get("last_price", 0.0)
        return {
            "timestamp": datetime.now().isoformat(),
            "open": ltp,
            "high": ltp,
            "low": ltp,
            "close": ltp,
            "volume": 0,
            "ltp": ltp,
        }
    except Exception as e:
        log.warning("Live quote failed for %s: %s", underlying, e)
        return None
