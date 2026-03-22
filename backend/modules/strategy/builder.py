"""Strategy compiler — takes a StrategyRecipe and a candle DataFrame,
computes all indicators, evaluates entry/exit conditions, and returns
boolean signal arrays suitable for the backtest engine.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from modules.strategy.models import (
    ConditionOperator,
    EntryCondition,
    ExitCondition,
    ExitType,
    StrategyRecipe,
)
from modules.strategy.indicators import compute_indicator


def _get_indicator_series(
    cond_indicator: str,
    cond_params: dict[str, Any],
    df: pd.DataFrame,
) -> pd.Series:
    """Compute an indicator and return the primary series."""
    result = compute_indicator(cond_indicator, df, **cond_params)
    if isinstance(result, pd.DataFrame):
        return result.iloc[:, 0]
    return result


def _evaluate_condition(
    series: pd.Series,
    op: ConditionOperator,
    value: float | str | None,
    compare_series: pd.Series | None = None,
) -> pd.Series:
    """Apply a comparison operator, return boolean Series."""
    if op == ConditionOperator.CROSSOVER:
        if compare_series is None:
            compare_series = pd.Series(float(value), index=series.index)
        return (series > compare_series) & (series.shift(1) <= compare_series.shift(1))

    if op == ConditionOperator.CROSSUNDER:
        if compare_series is None:
            compare_series = pd.Series(float(value), index=series.index)
        return (series < compare_series) & (series.shift(1) >= compare_series.shift(1))

    rhs = compare_series if compare_series is not None else float(value)

    if op == ConditionOperator.LT:
        return series < rhs
    if op == ConditionOperator.GT:
        return series > rhs
    if op == ConditionOperator.LTE:
        return series <= rhs
    if op == ConditionOperator.GTE:
        return series >= rhs
    if op == ConditionOperator.EQ:
        return series == rhs

    raise ValueError(f"Unknown operator: {op}")


def compile_entry_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
) -> pd.Series:
    """Evaluate all entry conditions with AND logic. Returns bool Series."""
    overrides = param_overrides or {}
    mask = pd.Series(True, index=df.index)

    for cond in recipe.entry_conditions:
        params = dict(cond.params)
        for key, val in overrides.items():
            parts = key.split(".")
            if len(parts) == 2 and parts[0] == cond.indicator:
                params[parts[1]] = val

        series = _get_indicator_series(cond.indicator, params, df)

        compare_series = None
        if cond.compare_indicator:
            cp = dict(cond.compare_params or {})
            for key, val in overrides.items():
                parts = key.split(".")
                if len(parts) == 2 and parts[0] == cond.compare_indicator:
                    cp[parts[1]] = val
            compare_series = _get_indicator_series(cond.compare_indicator, cp, df)

        cond_mask = _evaluate_condition(series, cond.condition, cond.value, compare_series)
        mask = mask & cond_mask

    return mask.fillna(False)


def compile_exit_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    entry_signals: pd.Series,
    param_overrides: dict[str, Any] | None = None,
) -> pd.Series:
    """Compile exit signals. Uses OR logic — any exit condition triggers."""
    overrides = param_overrides or {}
    exit_mask = pd.Series(False, index=df.index)

    for cond in recipe.exit_conditions:
        if cond.type == ExitType.INDICATOR and cond.indicator:
            params = dict(cond.params or {})
            for key, val in overrides.items():
                parts = key.split(".")
                if len(parts) == 2 and parts[0] == cond.indicator:
                    params[parts[1]] = val
            series = _get_indicator_series(cond.indicator, params, df)
            if cond.condition:
                exit_mask = exit_mask | _evaluate_condition(series, cond.condition, cond.value)

        elif cond.type == ExitType.TIME_EXIT and cond.value:
            if "timestamp" in df.columns:
                ts = pd.to_datetime(df["timestamp"])
            else:
                ts = df.index.to_series()
            exit_time = pd.to_datetime(str(cond.value)).time()
            exit_mask = exit_mask | (ts.dt.time >= exit_time)

        elif cond.type == ExitType.MAX_HOLDING_BARS and cond.value:
            pass  # handled in the backtest engine per-trade

    return exit_mask.fillna(False)


def compile_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
) -> dict[str, pd.Series]:
    """One-shot compile: returns {'entries': bool Series, 'exits': bool Series}."""
    entries = compile_entry_signals(recipe, df, param_overrides)
    exits = compile_exit_signals(recipe, df, entries, param_overrides)
    return {"entries": entries, "exits": exits}
