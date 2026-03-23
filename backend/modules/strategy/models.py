"""Pydantic models for the strategy "recipe" — the core data structure
that flows through the entire pipeline.

A recipe describes WHAT to trade (option legs), WHEN to enter/exit
(indicator conditions), and WHAT TO TUNE (param_ranges).
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class OptionType(str, Enum):
    CE = "CE"
    PE = "PE"


class LegAction(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class StrikeRef(str, Enum):
    """Strike ladder vs ATM (stored as ATM±N). UI labels: ATM+0 = ATM,
    ATM+k = k strikes OTM, ATM−k = k strikes ITM (for both CE and PE,
    matching feed/backtest strike resolution)."""
    ATM_M5 = "ATM-5"
    ATM_M4 = "ATM-4"
    ATM_M3 = "ATM-3"
    ATM_M2 = "ATM-2"
    ATM_M1 = "ATM-1"
    ATM = "ATM+0"
    ATM_P1 = "ATM+1"
    ATM_P2 = "ATM+2"
    ATM_P3 = "ATM+3"
    ATM_P4 = "ATM+4"
    ATM_P5 = "ATM+5"


class ExpiryOffset(str, Enum):
    WEEKLY_CURRENT = "weekly_current"
    WEEKLY_NEXT = "weekly_next"
    MONTHLY_CURRENT = "monthly_current"
    MONTHLY_NEXT = "monthly_next"


class Leg(BaseModel):
    action: LegAction
    option_type: OptionType
    strike: StrikeRef
    lots: int = 1


class OptionStructure(BaseModel):
    legs: list[Leg]


class ConditionOperator(str, Enum):
    LT = "<"
    GT = ">"
    LTE = "<="
    GTE = ">="
    EQ = "=="
    CROSSOVER = "crossover"
    CROSSUNDER = "crossunder"


class IndicatorVar(BaseModel):
    """A named indicator instance defined once in the recipe.
    Entry conditions reference these by name so the same variable can appear
    on either side of any condition without ambiguity.
    """
    name: str                              # e.g. "fast_ema"
    indicator: str                         # e.g. "EMA"
    params: dict[str, Any] = Field(default_factory=dict)  # e.g. {"period": 20}
    interval: str | None = None            # e.g. "1h" — None = base interval


class EntryCondition(BaseModel):
    # `indicator` and `compare_indicator` may hold either a raw indicator type
    # (e.g. "EMA") for legacy recipes, or a named variable from indicator_vars
    # (e.g. "fast_ema") for recipes built with the variable system.
    indicator: str
    params: dict[str, Any] = Field(default_factory=dict)
    condition: ConditionOperator
    value: float | str | None = None
    compare_indicator: str | None = None
    compare_params: dict[str, Any] | None = None
    direction: Literal["long", "short"] = "long"
    # Legacy alias fields — kept for backward compat with pre-variable recipes.
    indicator_alias: str | None = None
    compare_alias: str | None = None


class ExitType(str, Enum):
    TARGET_PCT = "target_pct"
    STOP_PCT = "stop_pct"
    TRAILING_STOP_PCT = "trailing_stop_pct"
    TIME_EXIT = "time_exit"
    INDICATOR = "indicator"
    MAX_HOLDING_BARS = "max_holding_bars"
    DIRECTION_CHANGE = "direction_change"


class ExitCondition(BaseModel):
    type: ExitType
    value: float | str | None = None
    indicator: str | None = None
    params: dict[str, Any] | None = None
    condition: ConditionOperator | None = None


class StrategyRecipe(BaseModel):
    """The complete, serializable strategy definition."""
    id: str = Field(default_factory=lambda: uuid4().hex[:12])
    name: str
    version: int = 1
    underlying: str = "NIFTY"
    expiry_offset: ExpiryOffset = ExpiryOffset.WEEKLY_CURRENT
    long_structure: OptionStructure
    short_structure: OptionStructure
    structure: OptionStructure | None = Field(default=None, exclude=True)
    indicator_vars: list[IndicatorVar] = Field(default_factory=list)
    entry_conditions: list[EntryCondition]
    # Indicator-based directional exit conditions.
    # direction=="long" means "fire this to exit a long position".
    # direction=="short" means "fire this to exit a short position".
    # All conditions within a direction are AND-combined.
    exit_indicator_conditions: list[EntryCondition] = Field(default_factory=list)
    exit_conditions: list[ExitCondition]
    param_ranges: dict[str, list[Any]] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StrategyRecipeUpdate(BaseModel):
    """Partial update — only supplied fields are changed."""
    name: str | None = None
    underlying: str | None = None
    expiry_offset: ExpiryOffset | None = None
    long_structure: OptionStructure | None = None
    short_structure: OptionStructure | None = None
    indicator_vars: list[IndicatorVar] | None = None
    entry_conditions: list[EntryCondition] | None = None
    exit_indicator_conditions: list[EntryCondition] | None = None
    exit_conditions: list[ExitCondition] | None = None
    param_ranges: dict[str, list[Any]] | None = None
    metadata: dict[str, Any] | None = None
