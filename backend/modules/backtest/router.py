from __future__ import annotations

from datetime import date
from typing import Any
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import math

from db import get_conn
from modules.strategy.models import StrategyRecipe
from modules.data.downloader import get_candles
from modules.data.sync import get_token
from modules.backtest.engine import run_backtest, save_backtest_result, _NumpyEncoder
import json


def _sanitize(obj):
    """Recursively replace non-JSON-compliant floats with None."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj

router = APIRouter()

INTERVAL_TO_KITE = {
    "1m": "minute", "5m": "5minute", "15m": "15minute", "day": "day",
}


class BacktestRequest(BaseModel):
    recipe: StrategyRecipe
    interval: str = "15m"
    initial_capital: float = 100_000
    param_overrides: dict[str, Any] | None = None
    from_date: str | None = None   # "YYYY-MM-DD"
    to_date: str | None = None     # "YYYY-MM-DD"
    optimizer_run_id: str | None = None   # for tracking source


@router.get("/data-range")
async def data_range(
    underlying: str = Query(...),
    interval: str = Query("15m"),
):
    """Return available candle date range for a given underlying + interval."""
    try:
        token = get_token(underlying)
    except ValueError as e:
        raise HTTPException(400, str(e))

    kite_interval = INTERVAL_TO_KITE.get(interval, interval)
    conn = get_conn()
    row = conn.execute(
        "SELECT MIN(timestamp), MAX(timestamp), COUNT(*) FROM candles "
        "WHERE instrument_token = ? AND interval = ?",
        [token, kite_interval],
    ).fetchone()

    if not row or not row[0]:
        raise HTTPException(404, f"No {interval} data for {underlying}. Download it in the Data module first.")

    return {
        "underlying": underlying,
        "interval": interval,
        "from_date": str(row[0])[:10],
        "to_date": str(row[1])[:10],
        "bar_count": int(row[2]),
    }


@router.post("/run")
async def run(body: BacktestRequest):
    try:
        token = get_token(body.recipe.underlying)
    except ValueError as e:
        raise HTTPException(400, str(e))

    from_date = date.fromisoformat(body.from_date) if body.from_date else None
    to_date = date.fromisoformat(body.to_date) if body.to_date else None

    df = get_candles(token, body.interval, from_date=from_date, to_date=to_date)
    if df.empty:
        raise HTTPException(
            404,
            f"No {body.interval} candle data for {body.recipe.underlying}. "
            f"Go to the Data module and sync it first."
        )

    kite_interval = INTERVAL_TO_KITE.get(body.interval, body.interval)
    result = run_backtest(body.recipe, df, body.param_overrides, body.initial_capital, kite_interval)
    result_id = save_backtest_result(body.recipe.id, body.recipe.version, result)
    actual_from = str(df["timestamp"].min())[:10]
    actual_to = str(df["timestamp"].max())[:10]
    payload = _sanitize(
        json.loads(json.dumps(
            {"result_id": result_id, "date_from": actual_from, "date_to": actual_to, **result},
            cls=_NumpyEncoder,
        ))
    )
    return JSONResponse(content=payload)


@router.get("/results")
async def list_results(strategy_id: str | None = None, limit: int = 50):
    conn = get_conn()
    if strategy_id:
        rows = conn.execute(
            "SELECT id, strategy_id, strategy_version, run_at, sharpe, cagr, "
            "max_drawdown, win_rate, total_trades, profit_factor, calmar "
            "FROM backtest_results WHERE strategy_id = ? ORDER BY run_at DESC LIMIT ?",
            [strategy_id, limit],
        ).fetchdf()
    else:
        rows = conn.execute(
            "SELECT id, strategy_id, strategy_version, run_at, sharpe, cagr, "
            "max_drawdown, win_rate, total_trades, profit_factor, calmar "
            "FROM backtest_results ORDER BY run_at DESC LIMIT ?",
            [limit],
        ).fetchdf()
    return {"results": rows.to_dict("records")}


@router.get("/results/{result_id}")
async def get_result(result_id: str):
    conn = get_conn()
    row = conn.execute("SELECT * FROM backtest_results WHERE id = ?", [result_id]).fetchone()
    if not row:
        raise HTTPException(404, "Result not found")
    columns = [
        "id", "strategy_id", "strategy_version", "run_at", "params_json",
        "sharpe", "cagr", "max_drawdown", "win_rate", "total_trades",
        "profit_factor", "calmar", "equity_curve_json", "trade_log_json",
    ]
    return dict(zip(columns, row))
