from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException

from modules.strategy.models import StrategyRecipe
from modules.strategy.indicators import INDICATOR_REGISTRY, compute_indicator
from modules.strategy.builder import compile_signals
from modules.data.downloader import get_candles

router = APIRouter()


@router.get("/indicators")
async def list_indicators():
    """List all available indicators and their names."""
    return {"indicators": list(INDICATOR_REGISTRY.keys())}


@router.post("/preview-indicator")
async def preview_indicator(
    instrument_token: int,
    indicator_name: str,
    interval: str = "15m",
    params: dict[str, Any] | None = None,
):
    """Compute a single indicator on historical data (for charting)."""
    df = get_candles(instrument_token, interval)
    if df.empty:
        raise HTTPException(404, "No candle data found for this token/interval")
    result = compute_indicator(indicator_name, df, **(params or {}))
    if hasattr(result, "to_dict"):
        if isinstance(result, dict):
            data = result
        else:
            data = result.to_dict("records") if hasattr(result, "to_dict") else result.tolist()
    else:
        data = result.tolist()
    return {"indicator": indicator_name, "data": data}


@router.post("/compile")
async def compile_strategy(
    recipe: StrategyRecipe,
    instrument_token: int,
    interval: str = "15m",
    param_overrides: dict[str, Any] | None = None,
):
    """Compile a recipe into entry/exit signals on historical data."""
    df = get_candles(instrument_token, interval)
    if df.empty:
        raise HTTPException(404, "No candle data found")

    signals = compile_signals(recipe, df, param_overrides)
    entry_count = int(signals["entries"].sum())
    exit_count = int(signals["exits"].sum())

    return {
        "total_bars": len(df),
        "entry_signals": entry_count,
        "exit_signals": exit_count,
    }


@router.post("/validate")
async def validate_recipe(recipe: StrategyRecipe):
    """Validate a recipe schema without running it."""
    errors = []
    for cond in recipe.entry_conditions:
        if cond.indicator.upper() not in INDICATOR_REGISTRY:
            errors.append(f"Unknown indicator: {cond.indicator}")
    if not recipe.long_structure.legs and not recipe.short_structure.legs:
        errors.append("Strategy must have at least one leg in either long or short structure")
    if not recipe.entry_conditions:
        errors.append("Strategy must have at least one entry condition")
    if not recipe.exit_conditions:
        errors.append("Strategy must have at least one exit condition")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "recipe": recipe.model_dump(),
    }
