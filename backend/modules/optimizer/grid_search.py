"""Parallel grid / random search over strategy parameter ranges.

Uses joblib (loky backend = separate processes) so the GIL is never a
bottleneck.  return_as="generator_unordered" lets us stream each result
back to the caller as soon as it lands, enabling live progress updates.
"""

from __future__ import annotations

import itertools
import logging
import random
from typing import Any, Callable

import pandas as pd
from joblib import Parallel, delayed

from modules.strategy.models import StrategyRecipe
from modules.backtest.engine import run_backtest

log = logging.getLogger(__name__)


def _expand_grid(param_ranges: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """Cartesian product of all param ranges → list of override dicts."""
    if not param_ranges:
        return [{}]
    keys = list(param_ranges.keys())
    values = list(param_ranges.values())
    return [dict(zip(keys, combo)) for combo in itertools.product(*values)]


def _random_sample(
    param_ranges: dict[str, list[Any]], n: int
) -> list[dict[str, Any]]:
    """Sample n random combinations from param ranges."""
    grid = _expand_grid(param_ranges)
    if n >= len(grid):
        return grid
    return random.sample(grid, n)


def get_combos(
    param_ranges: dict[str, list[Any]], max_random: int | None = None
) -> list[dict[str, Any]]:
    """Return the list of parameter combinations that will be tested."""
    if max_random:
        return _random_sample(param_ranges, max_random)
    return _expand_grid(param_ranges)


def _run_single(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    overrides: dict[str, Any],
    initial_capital: float,
    interval: str,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> dict:
    """Run one backtest with given param overrides.  Runs inside a joblib
    worker process — any exception is caught and returned as metadata so
    the whole search never aborts due to one bad combo."""
    try:
        result = run_backtest(recipe, df, overrides, initial_capital, interval, interval_dfs)
        return {
            "params": overrides,
            "metrics": result["metrics"],
            "equity_final": result["equity_curve"][-1] if result["equity_curve"] else initial_capital,
        }
    except Exception as e:
        log.warning("Backtest failed for params %s: %s", overrides, e)
        return {
            "params": overrides,
            "metrics": None,
            "error": str(e),
        }


def grid_search(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    initial_capital: float = 100_000,
    interval: str = "15minute",
    n_jobs: int = -1,
    max_random: int | None = None,
    progress_callback: Callable[[dict], None] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> list[dict]:
    """Run a full grid (or random sample) search in parallel.

    Uses joblib with the loky (process) backend so results are truly parallel
    and the GIL is never a bottleneck.  When *progress_callback* is provided
    it is called in the calling thread once per completed combination, so the
    caller can update a progress store without any multiprocessing complexity.

    Args:
        recipe: Strategy with param_ranges defined
        df: Candle DataFrame
        initial_capital: Starting capital
        interval: Kite interval string
        n_jobs: joblib parallelism (-1 = all cores)
        max_random: If set, sample this many combos randomly instead of full grid
        progress_callback: Called in the calling thread after each result arrives
        interval_dfs: Pre-fetched higher-timeframe DataFrames for multi-TF strategies

    Returns:
        List of results sorted by Sharpe ratio (descending).
    """
    if max_random:
        combos = _random_sample(recipe.param_ranges, max_random)
    else:
        combos = _expand_grid(recipe.param_ranges)

    total = len(combos)
    log.info("Starting grid search: %d combinations, n_jobs=%d", total, n_jobs)

    results: list[dict] = []
    gen = Parallel(n_jobs=n_jobs, return_as="generator_unordered", backend="loky")(
        delayed(_run_single)(recipe, df, combo, initial_capital, interval, interval_dfs)
        for combo in combos
    )

    for result in gen:
        results.append(result)
        if progress_callback:
            try:
                progress_callback(result)
            except Exception:
                pass

    valid = [r for r in results if r.get("metrics")]
    valid.sort(key=lambda r: r["metrics"].get("sharpe", -999), reverse=True)

    log.info(
        "Grid search complete: %d/%d valid results. Best Sharpe: %.4f",
        len(valid),
        total,
        valid[0]["metrics"]["sharpe"] if valid else 0,
    )

    return valid
