"""Strategy compiler — takes a StrategyRecipe and a candle DataFrame,
computes all indicators, evaluates entry/exit conditions, and returns
direction signals (long / short / neutral) per bar.
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
    IndicatorVar,
    StrategyRecipe,
)
from modules.strategy.indicators import compute_indicator


# ── Multi-timeframe helpers ──────────────────────────────────────────────────

def get_required_intervals(recipe: StrategyRecipe) -> set[str]:
    """Return all non-None intervals declared in indicator_vars."""
    return {v.interval for v in recipe.indicator_vars if v.interval}


def _align_to_base(htf_series: pd.Series, base_df: pd.DataFrame) -> pd.Series:
    """Forward-fill a higher-timeframe Series onto base-timeframe timestamps.

    ``htf_series`` must be indexed by datetime.  ``base_df`` must have a
    ``timestamp`` column.  The returned Series has the same integer index
    as ``base_df`` so it can be used directly in condition masks.

    Uses ``merge_asof`` (backward direction) which is safe against duplicate
    or overlapping timestamps between the two timeframes.
    """
    htf_frame = pd.DataFrame({
        "ts": pd.to_datetime(htf_series.index),
        "_val": htf_series.values,
    }).sort_values("ts")

    base_frame = pd.DataFrame({
        "ts": pd.to_datetime(base_df["timestamp"]),
    }).sort_values("ts")

    merged = pd.merge_asof(base_frame, htf_frame, on="ts", direction="backward")
    result = merged["_val"]
    result.index = base_df.index
    return result


def _get_indicator_series(
    cond_indicator: str,
    cond_params: dict[str, Any],
    df: pd.DataFrame,
    *,
    htf_df: pd.DataFrame | None = None,
    base_df: pd.DataFrame | None = None,
) -> pd.Series:
    """Compute an indicator and return the primary series.

    When *htf_df* is provided the indicator is computed on the higher-timeframe
    DataFrame and forward-filled back onto *base_df* timestamps.
    """
    compute_df = htf_df if htf_df is not None else df
    result = compute_indicator(cond_indicator, compute_df, **cond_params)
    if isinstance(result, pd.DataFrame):
        series = result.iloc[:, 0]
    else:
        series = result

    if htf_df is not None and base_df is not None:
        htf_ts = pd.to_datetime(htf_df["timestamp"])
        series = series.copy()
        series.index = htf_ts
        series = _align_to_base(series, base_df)

    return series


def _resolve_indicator(
    name: str,
    inline_params: dict[str, Any],
    var_lookup: dict[str, IndicatorVar],
    overrides: dict[str, Any],
    alias: str | None = None,
) -> tuple[str, dict[str, Any], str | None]:
    """Return (indicator_type, resolved_params, interval) for a reference.

    Resolution priority:
      1. Named variable — ``name`` matches a key in ``var_lookup``.
         Override key prefix = variable name.
      2. Legacy alias — ``name`` is a raw indicator type but ``alias`` is set.
         Override key prefix = alias.
      3. Raw indicator type — backward compat, key prefix = indicator name.
    """
    interval: str | None = None
    if name in var_lookup:
        var = var_lookup[name]
        indicator_type = var.indicator
        params = dict(var.params)
        prefix = name
        interval = var.interval
    else:
        indicator_type = name
        params = dict(inline_params)
        prefix = alias or name

    for key, val in overrides.items():
        parts = key.split(".")
        if len(parts) == 2 and parts[0] == prefix:
            params[parts[1]] = val

    return indicator_type, params, interval


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


def _compile_condition_mask(
    conditions: list[EntryCondition],
    df: pd.DataFrame,
    overrides: dict[str, Any],
    var_lookup: dict[str, IndicatorVar] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> pd.Series:
    """AND-combine a list of indicator conditions into a boolean mask."""
    var_lookup = var_lookup or {}
    interval_dfs = interval_dfs or {}
    mask = pd.Series(True, index=df.index)
    if not conditions:
        return pd.Series(False, index=df.index)

    for cond in conditions:
        # --- Main indicator ---
        ind_type, params, ind_interval = _resolve_indicator(
            cond.indicator, cond.params, var_lookup, overrides,
            alias=cond.indicator_alias,
        )
        htf_df = interval_dfs.get(ind_interval) if ind_interval else None
        series = _get_indicator_series(
            ind_type, params, df,
            htf_df=htf_df, base_df=df if htf_df is not None else None,
        )

        # --- Compare indicator ---
        compare_series = None
        if cond.compare_indicator:
            cmp_name = cond.compare_indicator
            if cmp_name in var_lookup or cond.compare_alias:
                cmp_type, cp, cmp_interval = _resolve_indicator(
                    cmp_name, cond.compare_params or {}, var_lookup, overrides,
                    alias=cond.compare_alias,
                )
            else:
                cmp_type = cmp_name
                cp = dict(cond.compare_params or {})
                cmp_interval = None
                compare_prefix = f"compare_{cmp_name}"
                compare_specific: set[str] = set()
                for key, val in overrides.items():
                    parts = key.split(".")
                    if len(parts) == 2 and parts[0] == compare_prefix:
                        cp[parts[1]] = val
                        compare_specific.add(parts[1])
                for key, val in overrides.items():
                    parts = key.split(".")
                    if (len(parts) == 2 and parts[0] == cmp_name
                            and parts[1] not in compare_specific):
                        cp[parts[1]] = val
            cmp_htf = interval_dfs.get(cmp_interval) if cmp_interval else None
            compare_series = _get_indicator_series(
                cmp_type, cp, df,
                htf_df=cmp_htf, base_df=df if cmp_htf is not None else None,
            )

        cond_mask = _evaluate_condition(series, cond.condition, cond.value, compare_series)
        mask = mask & cond_mask

    return mask.fillna(False)


def compile_direction_signal(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> pd.Series:
    """Evaluate all entry conditions grouped by direction.

    Returns a categorical Series with values "long", "short", or "neutral"
    for each bar.
    """
    overrides = param_overrides or {}
    var_lookup = {v.name: v for v in (recipe.indicator_vars or [])}

    long_conds  = [c for c in recipe.entry_conditions if c.direction == "long"]
    short_conds = [c for c in recipe.entry_conditions if c.direction == "short"]

    long_mask  = _compile_condition_mask(long_conds, df, overrides, var_lookup, interval_dfs)
    short_mask = _compile_condition_mask(short_conds, df, overrides, var_lookup, interval_dfs)

    signal = pd.Series("neutral", index=df.index)
    signal[long_mask]  = "long"
    signal[short_mask] = "short"
    signal[long_mask & short_mask] = "neutral"

    return signal


def compile_exit_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> pd.Series:
    """Compile general exit signals (indicator / time). Uses OR logic."""
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
            # Allow optimizer to sweep over different exit times via param_overrides.
            time_val = str(overrides.get("exit.time_exit", cond.value))
            exit_time = pd.to_datetime(time_val).time()
            exit_mask = exit_mask | (ts.dt.time >= exit_time)

        elif cond.type == ExitType.MAX_HOLDING_BARS and cond.value:
            pass  # handled in the backtest engine per-trade

    return exit_mask.fillna(False)


def compile_exit_indicator_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> dict[str, pd.Series]:
    """Compile indicator-based directional exit signals.

    Returns:
        long_exit  — True on bars where long positions should close.
        short_exit — True on bars where short positions should close.

    Conditions in exit_indicator_conditions with direction=="long" are
    AND-combined to form long_exit; direction=="short" → short_exit.
    An empty condition list for a direction means it never fires independently
    (the direction change or rule-based exits still apply).
    """
    overrides = param_overrides or {}
    var_lookup = {v.name: v for v in (recipe.indicator_vars or [])}
    false = pd.Series(False, index=df.index)

    long_conds  = [c for c in recipe.exit_indicator_conditions if c.direction == "long"]
    short_conds = [c for c in recipe.exit_indicator_conditions if c.direction == "short"]

    long_exit  = _compile_condition_mask(long_conds,  df, overrides, var_lookup, interval_dfs) if long_conds  else false.copy()
    short_exit = _compile_condition_mask(short_conds, df, overrides, var_lookup, interval_dfs) if short_conds else false.copy()

    return {"long_exit": long_exit, "short_exit": short_exit}


def compile_signals(
    recipe: StrategyRecipe,
    df: pd.DataFrame,
    param_overrides: dict[str, Any] | None = None,
    interval_dfs: dict[str, pd.DataFrame] | None = None,
) -> dict[str, pd.Series]:
    """Returns {'entries', 'exits', 'direction', 'long_exit', 'short_exit'}.

    'entries'    = True where direction is "long" (legacy callers).
    'exits'      = rule-based exits (time, general indicator conditions).
    'direction'  = full "long"/"short"/"neutral" series.
    'long_exit'  = indicator-based signal to close a long position.
    'short_exit' = indicator-based signal to close a short position.
    """
    direction = compile_direction_signal(recipe, df, param_overrides, interval_dfs)
    exits = compile_exit_signals(recipe, df, param_overrides, interval_dfs)
    ind_exits = compile_exit_indicator_signals(recipe, df, param_overrides, interval_dfs)
    entries = direction == "long"
    return {
        "entries":    entries,
        "exits":      exits,
        "direction":  direction,
        "long_exit":  ind_exits["long_exit"],
        "short_exit": ind_exits["short_exit"],
    }
