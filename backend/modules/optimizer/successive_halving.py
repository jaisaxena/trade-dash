"""Successive Halving optimizer.

Tests ALL parameter combinations on a short recent data slice first, prunes
the weakest performers, then re-tests survivors on progressively longer
horizons.  Only the final stage uses the full dataset.

Default plan  (eta=3, budgets=[0.10, 0.33, 1.0]):
  Stage 1:  N    combos on last 10 % of data  → keep top 33 %  (N/3)
  Stage 2:  N/3  combos on last 33 % of data  → keep top 33 %  (N/9)
  Stage 3:  N/9  combos on full 100 % data    → final ranking

Total backtests ≈ N × (0.10 + 0.11 + 0.04) ≈ 25 % of a full grid search,
while still letting every combination prove itself on the full data if it
survives the earlier cuts.

Why SUFFIX slices (most-recent data first)?
  Each stage is a SUPERSET of the previous one — stage 2 contains all of
  stage 1's data plus more history.  This means a combo's stage-3 score is
  consistent with its earlier scores.  Using random mid-period slices would
  make stage-2 results incomparable with stage-1 results.
"""
from __future__ import annotations

import logging
import math

import pandas as pd
from joblib import Parallel, delayed

from modules.strategy.models import StrategyRecipe
from modules.optimizer.grid_search import get_combos, _run_single

log = logging.getLogger(__name__)

DEFAULT_BUDGETS: list[float] = [0.10, 0.33, 1.0]
DEFAULT_ETA: int = 3


def _stage_plan(
    n_initial: int,
    df: pd.DataFrame,
    budgets: list[float],
    eta: int,
) -> list[dict]:
    """Pre-compute stage metadata so the UI can show the plan upfront."""
    total_bars = len(df)
    plan = []
    for i, budget in enumerate(budgets):
        n_combos = max(1, math.floor(n_initial / (eta ** i)))
        bar_count = max(50, int(total_bars * budget))
        plan.append({
            "stage": i + 1,
            "n_combos": n_combos,
            "data_fraction": round(budget, 3),
            "bar_count": bar_count,
            "date_from": str(df.iloc[-bar_count]["timestamp"])[:10],
            "date_to": str(df.iloc[-1]["timestamp"])[:10],
        })
    return plan


def successive_halving(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    initial_capital: float = 100_000,
    interval: str = "15minute",
    n_jobs: int = -1,
    max_random: int | None = None,
    budgets: list[float] | None = None,
    eta: int = DEFAULT_ETA,
    run_id: str | None = None,
) -> dict:
    """Run successive halving over the parameter grid.

    Args:
        recipe:          Strategy with param_ranges defined.
        df:              Full candle DataFrame (suffix slices are taken internally).
        initial_capital: Starting capital for each backtest.
        interval:        Kite interval string.
        n_jobs:          joblib parallelism (-1 = all cores).
        max_random:      If set, randomly sample this many combos for stage 1
                         instead of the full grid.
        budgets:         Data-fraction thresholds per stage, e.g. [0.10, 0.33, 1.0].
        eta:             Pruning factor — keep the top 1/eta fraction each stage.
        run_id:          Optional run ID for real-time progress tracking.

    Returns:
        Dict with per-stage results, final ranking, and summary stats.
    """
    if run_id:
        from modules.optimizer import progress as prog

    budgets = budgets or DEFAULT_BUDGETS
    all_combos = get_combos(recipe.param_ranges or {}, max_random)
    n_initial = len(all_combos)

    stage_plan = _stage_plan(n_initial, df, budgets, eta)

    log.info(
        "Successive halving: %d initial combos, %d stages, eta=%d  |  plan: %s",
        n_initial, len(budgets), eta,
        [(s["n_combos"], f"{s['data_fraction']*100:.0f}%") for s in stage_plan],
    )

    if run_id:
        prog.update(run_id, current_stage=1, n_stages=len(budgets), stage_meta=stage_plan)

    surviving_combos = all_combos
    completed_stage_results: list[dict] = []

    for stage_idx, (meta, budget) in enumerate(zip(stage_plan, budgets)):
        stage_num = stage_idx + 1
        n_to_test = min(meta["n_combos"], len(surviving_combos))
        combos_this_stage = surviving_combos[:n_to_test]

        bar_count = meta["bar_count"]
        slice_df = df.iloc[-bar_count:].reset_index(drop=True)

        log.info(
            "Stage %d/%d: testing %d combos on last %d bars (%.0f%% of data, %s → %s)",
            stage_num, len(budgets), len(combos_this_stage), bar_count,
            budget * 100, meta["date_from"], meta["date_to"],
        )

        if run_id:
            prog.update(run_id, current_stage=stage_num)

        # Parallel execution — identical to grid_search but with explicit combos
        results: list[dict] = []
        gen = Parallel(
            n_jobs=n_jobs,
            return_as="generator_unordered",
            backend="loky",
        )(
            delayed(_run_single)(recipe, slice_df, combo, initial_capital, interval)
            for combo in combos_this_stage
        )

        for result in gen:
            results.append(result)
            if run_id:
                try:
                    prog.add_result(run_id, result)
                except Exception:
                    pass

        # Sort survivors by Sharpe (descending); invalid results drop out
        valid = [r for r in results if r.get("metrics")]
        valid.sort(key=lambda r: r["metrics"].get("sharpe", -999), reverse=True)

        n_survivors_next = (
            max(1, math.floor(n_initial / (eta ** stage_num)))
            if stage_idx < len(budgets) - 1
            else 0
        )

        stage_record = {
            "stage": stage_num,
            "n_tested": len(combos_this_stage),
            "n_valid": len(valid),
            "n_survived": min(n_survivors_next, len(valid)) if n_survivors_next else len(valid),
            "data_fraction": budget,
            "bar_count": bar_count,
            "date_from": meta["date_from"],
            "date_to": meta["date_to"],
            "top_result_sharpe": valid[0]["metrics"].get("sharpe") if valid else None,
            "top_result_params": valid[0]["params"] if valid else None,
            "top_results": valid[:10],
        }
        completed_stage_results.append(stage_record)

        if run_id:
            prog.update(run_id, sh_stage_results=completed_stage_results)

        # Prune: keep only top 1/eta for the next stage
        if stage_idx < len(budgets) - 1:
            surviving_combos = [r["params"] for r in valid[:n_survivors_next]]
            log.info(
                "Stage %d complete: best Sharpe=%.3f, kept %d/%d for stage %d",
                stage_num,
                valid[0]["metrics"].get("sharpe", 0) if valid else 0,
                len(surviving_combos),
                len(combos_this_stage),
                stage_num + 1,
            )
            if not surviving_combos:
                log.warning("No valid combos survived stage %d — stopping early", stage_num)
                break

    final_valid = completed_stage_results[-1]["top_results"] if completed_stage_results else []
    best_sharpe = final_valid[0]["metrics"].get("sharpe", 0) if final_valid else 0

    log.info(
        "Successive halving complete: %d stage(s), %d final combos, best Sharpe=%.4f",
        len(completed_stage_results), len(final_valid), best_sharpe,
    )

    return {
        "ranked_results": final_valid,
        "stages": completed_stage_results,
        "n_stages_completed": len(completed_stage_results),
        "initial_combos": n_initial,
        "final_combos": len(final_valid),
        "stage_meta": stage_plan,
    }
