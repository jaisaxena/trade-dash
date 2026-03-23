"""Strategy Vault — persists recipe JSON files and maintains a DuckDB
index for fast search/listing.  Each edit bumps the version number.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from config import settings
from db import get_conn
from modules.strategy.models import StrategyRecipe, StrategyRecipeUpdate

log = logging.getLogger(__name__)


def _recipe_path(strategy_id: str, version: int) -> Path:
    return settings.STRATEGIES_DIR / f"{strategy_id}_v{version}.json"


def save_recipe(recipe: StrategyRecipe) -> StrategyRecipe:
    """Save a new recipe (or new version). Writes JSON + upserts index."""
    path = _recipe_path(recipe.id, recipe.version)
    path.write_text(json.dumps(recipe.model_dump(), indent=2, default=str))

    conn = get_conn()
    existing = conn.execute(
        "SELECT id FROM strategy_index WHERE id = ?", [recipe.id]
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE strategy_index SET name = ?, version = ?, underlying = ?, "
            "updated_at = CURRENT_TIMESTAMP, file_path = ? WHERE id = ?",
            [recipe.name, recipe.version, recipe.underlying, str(path), recipe.id],
        )
    else:
        conn.execute(
            "INSERT INTO strategy_index (id, name, version, underlying, file_path) "
            "VALUES (?, ?, ?, ?, ?)",
            [recipe.id, recipe.name, recipe.version, recipe.underlying, str(path)],
        )

    log.info("Saved strategy %s v%d → %s", recipe.id, recipe.version, path)
    return recipe


def load_recipe(strategy_id: str, version: int | None = None) -> StrategyRecipe | None:
    """Load a recipe by ID. If version is None, loads the latest."""
    conn = get_conn()

    if version is not None:
        path = _recipe_path(strategy_id, version)
    else:
        row = conn.execute(
            "SELECT file_path FROM strategy_index WHERE id = ?", [strategy_id]
        ).fetchone()
        if not row:
            return None
        path = Path(row[0])

    if not path.exists():
        return None

    data = json.loads(path.read_text())
    # Migrate old recipes that have "structure" but not the new directional fields
    if data.get("structure") and not data.get("long_structure"):
        data["long_structure"] = data["structure"]
        data["short_structure"] = data["structure"]
    return StrategyRecipe(**data)


def update_recipe(strategy_id: str, update: StrategyRecipeUpdate) -> StrategyRecipe | None:
    """Apply partial update, bump version, save new copy."""
    current = load_recipe(strategy_id)
    if current is None:
        return None

    conn = get_conn()
    frozen = conn.execute(
        "SELECT is_frozen FROM strategy_index WHERE id = ?", [strategy_id]
    ).fetchone()
    if frozen and frozen[0]:
        raise ValueError("Cannot update a frozen strategy. Unfreeze first.")

    update_data = update.model_dump(exclude_unset=True)
    current_data = current.model_dump()
    current_data.update(update_data)
    current_data["version"] = current.version + 1

    new_recipe = StrategyRecipe(**current_data)
    return save_recipe(new_recipe)


def delete_recipe(strategy_id: str) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT file_path, version FROM strategy_index WHERE id = ?", [strategy_id]
    ).fetchone()
    if not row:
        return False

    for v in range(1, row[1] + 1):
        p = _recipe_path(strategy_id, v)
        if p.exists():
            p.unlink()

    conn.execute("DELETE FROM strategy_index WHERE id = ?", [strategy_id])
    return True


def list_recipes(underlying: str | None = None, frozen_only: bool = False) -> list[dict]:
    conn = get_conn()
    clauses = []
    params = []

    if underlying:
        clauses.append("underlying = ?")
        params.append(underlying)
    if frozen_only:
        clauses.append("is_frozen = TRUE")

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT id, name, version, underlying, created_at, updated_at, "
        f"is_frozen, last_backtest_sharpe, last_backtest_cagr, last_backtest_max_dd "
        f"FROM strategy_index{where} ORDER BY updated_at DESC",
        params,
    ).fetchdf()
    import numpy as np
    df = rows.fillna(np.nan)
    records = df.to_dict("records")
    for rec in records:
        for k, v in rec.items():
            if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                rec[k] = None
            elif hasattr(v, "isoformat"):
                rec[k] = v.isoformat()
    return records


def freeze_recipe(strategy_id: str) -> bool:
    conn = get_conn()
    conn.execute(
        "UPDATE strategy_index SET is_frozen = TRUE WHERE id = ?", [strategy_id]
    )
    return True


def unfreeze_recipe(strategy_id: str) -> bool:
    conn = get_conn()
    conn.execute(
        "UPDATE strategy_index SET is_frozen = FALSE WHERE id = ?", [strategy_id]
    )
    return True


def link_backtest(strategy_id: str, backtest_id: str, metrics: dict) -> None:
    """Update the strategy index with latest backtest metrics."""
    conn = get_conn()
    conn.execute(
        "UPDATE strategy_index SET last_backtest_id = ?, last_backtest_sharpe = ?, "
        "last_backtest_cagr = ?, last_backtest_max_dd = ? WHERE id = ?",
        [
            backtest_id,
            metrics.get("sharpe"),
            metrics.get("cagr"),
            metrics.get("max_drawdown"),
            strategy_id,
        ],
    )
