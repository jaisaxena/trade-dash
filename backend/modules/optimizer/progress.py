"""In-memory thread-safe progress store for async optimizer runs."""
from __future__ import annotations

import math
import threading
from datetime import datetime, timezone
from typing import Any


def _sanitize(obj: Any) -> Any:
    """Recursively replace nan/inf floats with None so the response is always
    JSON-serializable regardless of what the backtest engine produces."""
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj

_store: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def init_run(
    run_id: str,
    total: int,
    all_combos: list[dict],
    mode: str = "grid",
    n_windows: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    bar_count: int | None = None,
) -> None:
    with _lock:
        _store[run_id] = {
            "run_id": run_id,
            "status": "running",
            "mode": mode,
            "total": total,
            "completed": 0,
            "current_params": None,
            "partial_results": [],
            "all_combos": all_combos[:200],  # cap to avoid huge payloads
            "n_windows": n_windows,
            "current_window": None,
            "window_results": [],
            "error": None,
            "final_result": None,
            # data range
            "date_from": date_from,
            "date_to": date_to,
            "bar_count": bar_count,
            # timing
            "started_at": datetime.now(timezone.utc).isoformat(),
            "last_result_at": None,
            # successive halving
            "current_stage": None,
            "n_stages": None,
            "stage_meta": None,
            "sh_stage_results": None,
        }


def add_result(run_id: str, result: dict) -> None:
    with _lock:
        if run_id not in _store:
            return
        _store[run_id]["completed"] += 1
        _store[run_id]["current_params"] = result.get("params")
        _store[run_id]["last_result_at"] = datetime.now(timezone.utc).isoformat()
        if result.get("metrics"):
            _store[run_id]["partial_results"].append(_sanitize(result))


def update(run_id: str, **kwargs: Any) -> None:
    with _lock:
        if run_id in _store:
            _store[run_id].update(kwargs)


def mark_done(run_id: str, final_result: dict | None = None, error: str | None = None) -> None:
    with _lock:
        if run_id in _store:
            _store[run_id]["status"] = "failed" if error else "completed"
            _store[run_id]["error"] = error
            if final_result:
                _store[run_id]["final_result"] = final_result


def get_snapshot(run_id: str) -> dict | None:
    with _lock:
        p = _store.get(run_id)
        if p is None:
            return None
        partial = sorted(
            [r for r in p["partial_results"] if r.get("metrics")],
            key=lambda r: (r["metrics"].get("sharpe") or 0),
            reverse=True,
        )
        snapshot = {**p, "partial_results": partial[:20]}
    return _sanitize(snapshot)


def cleanup(run_id: str) -> None:
    with _lock:
        _store.pop(run_id, None)
