"""Walk-forward analysis to guard against overfitting.

Splits data into sequential in-sample / out-of-sample windows,
optimizes on IS, validates on OOS, and reports stability.
"""

from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from modules.strategy.models import StrategyRecipe
from modules.optimizer.grid_search import grid_search
from modules.backtest.engine import run_backtest

log = logging.getLogger(__name__)


def walk_forward(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    n_splits: int = 5,
    is_ratio: float = 0.7,
    initial_capital: float = 100_000,
    interval: str = "15minute",
    n_jobs: int = -1,
    max_random: int | None = None,
    run_id: str | None = None,
) -> dict:
    """Run walk-forward optimization.

    Args:
        recipe: Strategy with param_ranges
        df: Full candle DataFrame
        n_splits: Number of walk-forward windows
        is_ratio: Fraction of each window used for in-sample optimization
        initial_capital: Starting capital per window
        interval: Kite interval string
        n_jobs: Thread pool size
        max_random: Random sample size per window (None = full grid)
        run_id: Optional run ID for real-time progress tracking

    Returns:
        Dict with per-window results, aggregated OOS metrics, and best params.
    """
    # Import here to avoid circular imports at module level
    if run_id:
        from modules.optimizer import progress as prog

    total_len = len(df)
    window_size = total_len // n_splits
    is_size = int(window_size * is_ratio)

    windows = []

    for i in range(n_splits):
        start = i * window_size
        is_end = start + is_size
        oos_end = min(start + window_size, total_len)

        if is_end >= total_len or oos_end > total_len:
            break

        is_data = df.iloc[start:is_end].reset_index(drop=True)
        oos_data = df.iloc[is_end:oos_end].reset_index(drop=True)

        if len(is_data) < 50 or len(oos_data) < 10:
            continue

        log.info("Walk-forward window %d: IS %d bars, OOS %d bars", i, len(is_data), len(oos_data))

        if run_id:
            prog.update(run_id, current_window=i + 1)

        def _callback(result: dict, _run_id: str = run_id) -> None:
            if _run_id:
                prog.add_result(_run_id, result)

        is_results = grid_search(
            recipe, is_data, initial_capital, interval, n_jobs, max_random,
            progress_callback=_callback if run_id else None,
        )

        if not is_results:
            windows.append({"window": i, "error": "No valid IS results"})
            if run_id:
                prog.update(run_id, window_results=list(windows))
            continue

        best_params = is_results[0]["params"]
        best_is_metrics = is_results[0]["metrics"]

        oos_result = run_backtest(recipe, oos_data, best_params, initial_capital, interval)

        windows.append({
            "window": i,
            "is_bars": len(is_data),
            "oos_bars": len(oos_data),
            "best_params": best_params,
            "is_metrics": best_is_metrics,
            "oos_metrics": oos_result["metrics"],
        })

        if run_id:
            prog.update(run_id, window_results=list(windows))

    oos_sharpes = [
        w["oos_metrics"]["sharpe"]
        for w in windows
        if "oos_metrics" in w
    ]
    oos_win_rates = [
        w["oos_metrics"]["win_rate"]
        for w in windows
        if "oos_metrics" in w
    ]

    avg_oos_sharpe = sum(oos_sharpes) / len(oos_sharpes) if oos_sharpes else 0
    avg_oos_win_rate = sum(oos_win_rates) / len(oos_win_rates) if oos_win_rates else 0

    best_window = max(
        (w for w in windows if "oos_metrics" in w),
        key=lambda w: w["oos_metrics"]["sharpe"],
        default=None,
    )

    return {
        "windows": windows,
        "n_splits": n_splits,
        "avg_oos_sharpe": round(avg_oos_sharpe, 4),
        "avg_oos_win_rate": round(avg_oos_win_rate, 4),
        "recommended_params": best_window["best_params"] if best_window else {},
        "robustness_score": _robustness_score(windows),
    }


def _robustness_score(windows: list[dict]) -> float:
    """0-100 score: how consistent is OOS performance across windows?"""
    oos_sharpes = [
        w["oos_metrics"]["sharpe"]
        for w in windows
        if "oos_metrics" in w and w["oos_metrics"]["sharpe"] is not None
    ]
    if len(oos_sharpes) < 2:
        return 0.0

    positive_pct = sum(1 for s in oos_sharpes if s > 0) / len(oos_sharpes)
    import numpy as np
    consistency = 1 - (np.std(oos_sharpes) / (np.mean(oos_sharpes) + 1e-9)) if np.mean(oos_sharpes) > 0 else 0
    consistency = max(0, min(1, consistency))

    return round((positive_pct * 60 + consistency * 40), 2)
