"""Pydantic models for the strategy "recipe" — the core data structure
that flows through the entire pipeline.

A recipe describes WHAT to trade (option legs), WHEN to enter/exit
(indicator conditions), and WHAT TO TUNE (param_ranges).
"""

from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class OptionType(str, Enum):
    CE = "CE"
    PE = "PE"


class LegAction(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class StrikeRef(str, Enum):
    """Strike selection relative to ATM.  ATM+0 = at the money,
    ATM+1 = one strike OTM for CE (ITM for PE), etc."""
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


class EntryCondition(BaseModel):
    indicator: str
    params: dict[str, Any] = Field(default_factory=dict)
    condition: ConditionOperator
    value: float | str | None = None
    compare_indicator: str | None = None
    compare_params: dict[str, Any] | None = None


class ExitType(str, Enum):
    TARGET_PCT = "target_pct"
    STOP_PCT = "stop_pct"
    TRAILING_STOP_PCT = "trailing_stop_pct"
    TIME_EXIT = "time_exit"
    INDICATOR = "indicator"
    MAX_HOLDING_BARS = "max_holding_bars"


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
    structure: OptionStructure
    entry_conditions: list[EntryCondition]
    exit_conditions: list[ExitCondition]
    param_ranges: dict[str, list[Any]] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StrategyRecipeUpdate(BaseModel):
    """Partial update — only supplied fields are changed."""
    name: str | None = None
    underlying: str | None = None
    expiry_offset: ExpiryOffset | None = None
    structure: OptionStructure | None = None
    entry_conditions: list[EntryCondition] | None = None
    exit_conditions: list[ExitCondition] | None = None
    param_ranges: dict[str, list[Any]] | None = None
    metadata: dict[str, Any] | None = None
