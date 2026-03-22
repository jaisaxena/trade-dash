from __future__ import annotations

from fastapi import APIRouter, HTTPException

from modules.strategy.models import StrategyRecipe, StrategyRecipeUpdate
from modules.vault import store

router = APIRouter()


@router.post("/strategies")
async def create_strategy(recipe: StrategyRecipe):
    saved = store.save_recipe(recipe)
    return {"strategy": saved.model_dump()}


@router.get("/strategies")
async def list_strategies(
    underlying: str | None = None,
    frozen_only: bool = False,
):
    return {"strategies": store.list_recipes(underlying, frozen_only)}


@router.get("/strategies/{strategy_id}")
async def get_strategy(strategy_id: str, version: int | None = None):
    recipe = store.load_recipe(strategy_id, version)
    if not recipe:
        raise HTTPException(404, "Strategy not found")
    return {"strategy": recipe.model_dump()}


@router.patch("/strategies/{strategy_id}")
async def update_strategy(strategy_id: str, update: StrategyRecipeUpdate):
    try:
        updated = store.update_recipe(strategy_id, update)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not updated:
        raise HTTPException(404, "Strategy not found")
    return {"strategy": updated.model_dump()}


@router.delete("/strategies/{strategy_id}")
async def delete_strategy(strategy_id: str):
    ok = store.delete_recipe(strategy_id)
    if not ok:
        raise HTTPException(404, "Strategy not found")
    return {"deleted": True}


@router.post("/strategies/{strategy_id}/freeze")
async def freeze(strategy_id: str):
    store.freeze_recipe(strategy_id)
    return {"frozen": True}


@router.post("/strategies/{strategy_id}/unfreeze")
async def unfreeze(strategy_id: str):
    store.unfreeze_recipe(strategy_id)
    return {"frozen": False}
