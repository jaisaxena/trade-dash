from __future__ import annotations

import json
import logging
import threading
from uuid import uuid4

import duckdb
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import settings
from db import get_conn
from modules.strategy.models import StrategyRecipe
from modules.data.downloader import get_candles
from modules.data.sync import get_token
from modules.optimizer.grid_search import grid_search, get_combos
from modules.optimizer.walk_forward import walk_forward
from modules.optimizer.successive_halving import (
    successive_halving, DEFAULT_BUDGETS, DEFAULT_ETA,
)
from modules.optimizer import progress as prog

log = logging.getLogger(__name__)

router = APIRouter()

INTERVAL_TO_KITE = {
    "1m": "minute", "5m": "5minute", "15m": "15minute", "day": "day",
}


class OptimizeRequest(BaseModel):
    recipe: StrategyRecipe
    interval: str = "15m"
    initial_capital: float = 100_000
    mode: str = "grid"          # "grid" | "random" | "walk_forward" | "successive_halving"
    max_random: int | None = None
    n_splits: int = 5
    is_ratio: float = 0.7
    n_jobs: int = -1
    # successive halving options
    sh_eta: int = DEFAULT_ETA
    sh_budgets: list[float] = DEFAULT_BUDGETS


def _run_optimizer_sync(
    run_id: str,
    body: OptimizeRequest,
    df,
    kite_interval: str,
) -> dict:
    """Core optimization loop — runs inside a background thread."""

    def callback(result: dict) -> None:
        prog.add_result(run_id, result)

    if body.mode == "walk_forward":
        result = walk_forward(
            body.recipe, df, body.n_splits, body.is_ratio,
            body.initial_capital, kite_interval, body.n_jobs, body.max_random,
            run_id=run_id,
        )
    elif body.mode == "successive_halving":
        result = successive_halving(
            body.recipe, df, body.initial_capital, kite_interval,
            body.n_jobs, body.max_random,
            budgets=body.sh_budgets, eta=body.sh_eta,
            run_id=run_id,
        )
    else:
        max_random_val = body.max_random if body.mode == "random" else None
        results = grid_search(
            body.recipe, df, body.initial_capital, kite_interval,
            body.n_jobs, max_random_val,
            progress_callback=callback,
        )
        result = {"ranked_results": results[:100]}

    return result


def _run_in_thread(
    run_id: str,
    body: OptimizeRequest,
    df,
    kite_interval: str,
) -> None:
    """Background thread: runs the optimizer and writes result to a fresh
    DuckDB connection (thread-safe: each thread owns its connection)."""
    print(f"[optimizer] thread {threading.current_thread().name} started for run {run_id}", flush=True)
    try:
        result = _run_optimizer_sync(run_id, body, df, kite_interval)

        if body.mode == "walk_forward":
            best_params = result.get("recommended_params", {})
            best_sharpe = result.get("avg_oos_sharpe", 0)
        else:
            ranked = result.get("ranked_results", [])
            best_params = ranked[0]["params"] if ranked else {}
            best_sharpe = ranked[0]["metrics"].get("sharpe", 0) if ranked else 0

        # Each thread opens its own DuckDB connection — no sharing with the
        # main thread's get_conn() singleton.
        try:
            thread_conn = duckdb.connect(str(settings.DUCKDB_PATH))
            thread_conn.execute(
                "UPDATE optimization_runs SET status = 'completed', "
                "best_params_json = ?, best_sharpe = ?, results_json = ?, "
                "completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [json.dumps(best_params), best_sharpe, json.dumps(result, default=str), run_id],
            )
            thread_conn.close()
        except Exception as db_err:
            print(f"[optimizer] DB write failed for run {run_id}: {db_err}", flush=True)

        prog.mark_done(run_id, final_result=result)
        print(f"[optimizer] run {run_id} completed. Best Sharpe: {best_sharpe:.4f}", flush=True)

    except Exception as e:
        print(f"[optimizer] run {run_id} FAILED: {e}", flush=True)
        log.error("Optimizer run %s failed", run_id, exc_info=True)
        try:
            thread_conn = duckdb.connect(str(settings.DUCKDB_PATH))
            thread_conn.execute(
                "UPDATE optimization_runs SET status = 'failed' WHERE id = ?", [run_id]
            )
            thread_conn.close()
        except Exception:
            pass
        prog.mark_done(run_id, error=str(e))


@router.post("/run")
async def run_optimization(body: OptimizeRequest):
    try:
        token = get_token(body.recipe.underlying)
    except ValueError as e:
        raise HTTPException(400, str(e))

    df = get_candles(token, body.interval)
    if df.empty:
        raise HTTPException(
            404,
            f"No {body.interval} data for {body.recipe.underlying}. "
            f"Download it in the Data module first."
        )

    date_from = str(df["timestamp"].min())[:10]
    date_to = str(df["timestamp"].max())[:10]
    bar_count = len(df)

    kite_interval = INTERVAL_TO_KITE.get(body.interval, body.interval)
    run_id = uuid4().hex[:12]

    # Build the full plan upfront so the UI can display it immediately
    max_random_for_combos = body.max_random if body.mode in ("random", "successive_halving") else None
    all_combos = get_combos(body.recipe.param_ranges or {}, max_random_for_combos)
    n_initial = len(all_combos)

    if body.mode == "walk_forward":
        total = n_initial * body.n_splits
        n_windows = body.n_splits
        sh_stage_plan = None
    elif body.mode == "successive_halving":
        from modules.optimizer.successive_halving import _stage_plan
        sh_stage_plan = _stage_plan(n_initial, df, body.sh_budgets, body.sh_eta)
        total = sum(s["n_combos"] for s in sh_stage_plan)
        n_windows = None
    else:
        total = n_initial
        n_windows = None
        sh_stage_plan = None

    prog.init_run(
        run_id, total, all_combos if body.mode != "successive_halving" else [],
        mode=body.mode,
        n_windows=n_windows,
        date_from=date_from,
        date_to=date_to,
        bar_count=bar_count,
    )

    if sh_stage_plan:
        prog.update(run_id, stage_meta=sh_stage_plan, n_stages=len(sh_stage_plan))

    conn = get_conn()
    conn.execute(
        "INSERT INTO optimization_runs (id, strategy_id, status, mode, interval, total_combinations) "
        "VALUES (?, ?, 'running', ?, ?, ?)",
        [run_id, body.recipe.id, body.mode, body.interval, total],
    )

    # Spawn a daemon thread — completely independent of asyncio's event loop,
    # no GIL issues, no asyncio executor queue.
    t = threading.Thread(
        target=_run_in_thread,
        args=(run_id, body, df, kite_interval),
        daemon=True,
        name=f"optimizer-{run_id}",
    )
    t.start()
    print(f"[optimizer] spawned thread {t.name} for run {run_id} ({total} combos, mode={body.mode})", flush=True)

    return {
        "run_id": run_id,
        "status": "running",
        "total": total,
        "all_combos": all_combos[:200] if body.mode != "successive_halving" else [],
        "mode": body.mode,
        "n_windows": n_windows,
        "date_from": date_from,
        "date_to": date_to,
        "bar_count": bar_count,
        "stage_meta": sh_stage_plan,
        "n_stages": len(sh_stage_plan) if sh_stage_plan else None,
    }


@router.get("/runs/{run_id}/progress")
async def get_run_progress(run_id: str):
    snapshot = prog.get_snapshot(run_id)
    if snapshot is not None:
        return snapshot

    # Fallback to DB when the server has restarted and lost in-memory state
    conn = get_conn()
    row = conn.execute(
        "SELECT status, total_combinations, completed_combinations, results_json "
        "FROM optimization_runs WHERE id = ?",
        [run_id],
    ).fetchone()
    if not row:
        raise HTTPException(404, "Run not found")
    return {
        "run_id": run_id,
        "status": row[0],
        "total": row[1],
        "completed": row[2] or 0,
        "current_params": None,
        "partial_results": [],
        "all_combos": [],
        "final_result": json.loads(row[3]) if row[3] else None,
    }


@router.get("/runs")
async def list_runs(strategy_id: str | None = None, status: str | None = None, limit: int = 50):
    conn = get_conn()
    filters = []
    params: list = []
    if strategy_id:
        filters.append("strategy_id = ?")
        params.append(strategy_id)
    if status:
        filters.append("status = ?")
        params.append(status)
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    params.append(limit)
    rows = conn.execute(
        f"SELECT id, strategy_id, started_at, completed_at, status, mode, interval, "
        f"best_sharpe, best_params_json "
        f"FROM optimization_runs {where} ORDER BY started_at DESC LIMIT ?",
        params,
    ).fetchdf()
    return {"runs": rows.to_dict("records")}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM optimization_runs WHERE id = ?", [run_id]
    ).fetchone()
    if not row:
        raise HTTPException(404, "Run not found")
    columns = [
        "id", "strategy_id", "started_at", "completed_at", "status",
        "total_combinations", "completed_combinations", "best_params_json",
        "best_sharpe", "results_json",
    ]
    return dict(zip(columns, row))
