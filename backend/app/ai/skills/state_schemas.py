from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, TypeAdapter, model_validator


EntityId = Annotated[str, Field(min_length=1, max_length=64)]
ShortText = Annotated[str, Field(min_length=1, max_length=120)]
Instruction = Annotated[str, Field(min_length=1, max_length=500)]
QuantityText = Annotated[str, Field(pattern=r"^[0-9]+(?:\.[0-9]+)?$")]


def _parse_iso_date(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("date must be a real calendar date in YYYY-MM-DD format") from exc
    if parsed.isoformat() != value:
        raise ValueError("date must use YYYY-MM-DD format")
    return parsed


def _parse_decimal(value: Any) -> Any:
    if isinstance(value, str):
        return Decimal(value)
    return value


IsoDate = Annotated[date, BeforeValidator(_parse_iso_date)]
Confidence = Annotated[Decimal, BeforeValidator(_parse_decimal), Field(ge=0, le=1)]


class ContinuationStateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RecipeMissingIngredientState(ContinuationStateModel):
    recipeTitle: ShortText
    currentIngredient: ShortText
    pendingIngredientNames: Annotated[list[ShortText], Field(max_length=30)]
    completedIngredientIds: Annotated[list[EntityId], Field(max_length=50)]


class ShoppingMissingTargetState(ContinuationStateModel):
    currentTargetName: ShortText
    pendingTargetNames: Annotated[list[ShortText], Field(max_length=50)]
    resolvedTargetIds: Annotated[list[EntityId], Field(max_length=50)]


class FoodToMealPlanState(ContinuationStateModel):
    targetDate: IsoDate
    mealType: Literal["breakfast", "lunch", "dinner", "snack"]
    instruction: Instruction


class MealMissingFoodState(ContinuationStateModel):
    targetName: ShortText
    targetDate: IsoDate
    mealType: Literal["breakfast", "lunch", "dinner", "snack"]
    instruction: Instruction


class InventoryOperationMissingIngredientState(ContinuationStateModel):
    targetName: ShortText
    operation: Literal["restock", "consume", "dispose"]
    instruction: Instruction


class InventoryIntakeResolvedItem(ContinuationStateModel):
    ingredientId: EntityId
    quantity: QuantityText | None = None
    unit: ShortText | None = None


class InventoryMissingIngredientState(ContinuationStateModel):
    currentLabel: ShortText
    pendingLabels: Annotated[list[ShortText], Field(max_length=30)]
    resolvedItems: Annotated[list[InventoryIntakeResolvedItem], Field(max_length=30)]


class InventoryUnitConversionState(ContinuationStateModel):
    ingredientName: ShortText
    unitName: ShortText
    baseQuantity: Annotated[float, Field(gt=0)]
    baseUnit: ShortText
    instruction: Instruction


class InventoryIntakeDateEvidence(ContinuationStateModel):
    userDate: IsoDate | None = None
    userSaidToday: bool = False
    receiptDate: IsoDate | None = None


class InventoryIntakePackageConversion(ContinuationStateModel):
    sourceQuantity: QuantityText
    sourceUnit: ShortText
    targetQuantity: QuantityText
    targetUnit: ShortText
    evidence: Literal["user_confirmed_once"]


class InventoryIntakeContinuationLine(ContinuationStateModel):
    sourceLineId: ShortText
    sourceOrder: Annotated[int, Field(ge=0, le=29)]
    rawText: ShortText
    name: ShortText
    quantity: QuantityText | None = None
    unit: ShortText | None = None
    packageCount: QuantityText | None = None
    packageUnit: ShortText | None = None
    confidence: Confidence | None = None
    itemKind: Literal["inventory", "non_inventory"]
    targetHint: Literal["ingredient", "food"] | None = None
    resolvedSourceKind: Literal["shopping_item", "direct"] | None = None
    selectedShoppingItemId: EntityId | None = None
    selectedTargetKind: Literal["exact_ingredient", "presence_ingredient", "food"] | None = None
    selectedTargetId: EntityId | None = None
    confirmedAction: Literal["stock_and_fulfill", "fulfill_without_stock", "stock_only", "skip"] | None = None
    confirmedQuantity: QuantityText | None = None
    confirmedUnit: ShortText | None = None
    packageConversion: InventoryIntakePackageConversion | None = None
    disposition: Literal["pending", "ready", "missing_target", "ignored", "skipped"]


class InventoryIntakeIgnoredLine(ContinuationStateModel):
    sourceLineId: ShortText
    reasonCode: Literal["non_inventory_item"]
    reason: ShortText


class InventoryIntakeBlockerRef(ContinuationStateModel):
    sourceLineId: ShortText | None = None
    reasonCode: Literal[
        "unit_mismatch",
        "conversion_quantity_missing",
        "quantity_missing",
        "quantity_unreliable",
        "target_ambiguous",
        "shopping_match_ambiguous",
        "source_ambiguous",
        "date_conflict",
        "target_missing",
    ]


class InventoryIntakeContinuationState(ContinuationStateModel):
    sourceType: Literal[
        "manual_text",
        "receipt_image",
        "receipt_text",
        "inventory_photo",
        "gift",
        "reconciliation",
        "initial_inventory",
        "historical_entry",
    ]
    sourceReference: dict[str, str] | None = None
    purchaseIntent: Literal["purchase", "non_purchase", "unknown"]
    dateEvidence: InventoryIntakeDateEvidence
    intakeDate: IsoDate
    intakeDateSource: Literal["user", "receipt", "family_business_date"]
    lines: Annotated[list[InventoryIntakeContinuationLine], Field(min_length=1, max_length=30)]
    ignoredItems: Annotated[list[InventoryIntakeIgnoredLine], Field(max_length=30)]
    currentBlocker: InventoryIntakeBlockerRef | None = None
    pendingBlockers: Annotated[list[InventoryIntakeBlockerRef], Field(max_length=30)]

    @model_validator(mode="after")
    def validate_intake_invariants(self) -> "InventoryIntakeContinuationState":
        line_ids = [line.sourceLineId for line in self.lines]
        if len(line_ids) != len(set(line_ids)):
            raise ValueError("sourceLineId values must be unique")

        orders = sorted(line.sourceOrder for line in self.lines)
        expected = list(range(len(self.lines)))
        if orders != expected:
            raise ValueError("sourceOrder values must be unique and contiguous from 0")

        line_by_id = {line.sourceLineId: line for line in self.lines}

        for ignored in self.ignoredItems:
            line = line_by_id.get(ignored.sourceLineId)
            if line is None:
                raise ValueError("ignoredItems sourceLineId must exist in lines")
            if line.disposition != "ignored":
                raise ValueError("ignoredItems must reference lines with disposition=ignored")

        blocker_refs: list[InventoryIntakeBlockerRef] = list(self.pendingBlockers)
        if self.currentBlocker is not None:
            blocker_refs.append(self.currentBlocker)
        for blocker in blocker_refs:
            if blocker.sourceLineId is None:
                continue
            if blocker.sourceLineId not in line_by_id:
                raise ValueError("blocker sourceLineId must exist in lines")

        return self


class InventoryIntakeMissingTargetState(InventoryIntakeContinuationState):
    currentMissingSourceLineId: ShortText

    @model_validator(mode="after")
    def validate_missing_target_ref(self) -> "InventoryIntakeMissingTargetState":
        if self.currentMissingSourceLineId not in {line.sourceLineId for line in self.lines}:
            raise ValueError("currentMissingSourceLineId must exist in lines")
        return self


class RecipeShoppingShortage(ContinuationStateModel):
    ingredientId: EntityId
    ingredientName: ShortText
    shortageType: Literal["quantity", "presence"]
    quantity: QuantityText | None = None
    unit: ShortText | None = None

    @model_validator(mode="after")
    def validate_shortage_payload(self) -> "RecipeShoppingShortage":
        if self.shortageType == "quantity":
            valid = self.quantity is not None and self.unit is not None
        else:
            valid = self.quantity is None and self.unit is None
        if not valid:
            raise ValueError("quantity fields must match shortageType")
        return self


class RecipeShortageToShoppingState(ContinuationStateModel):
    recipeId: EntityId
    shortages: Annotated[list[RecipeShoppingShortage], Field(min_length=1, max_length=50)]


CONTINUATION_STATE_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "recipe_missing_ingredient.v1": TypeAdapter(RecipeMissingIngredientState),
    "shopping_missing_target.v1": TypeAdapter(ShoppingMissingTargetState),
    "food_to_meal_plan.v1": TypeAdapter(FoodToMealPlanState),
    "meal_missing_food.v1": TypeAdapter(MealMissingFoodState),
    "inventory_missing_ingredient.v1": TypeAdapter(
        InventoryOperationMissingIngredientState | InventoryMissingIngredientState
    ),
    "inventory_unit_conversion.v1": TypeAdapter(InventoryUnitConversionState),
    "inventory_intake_missing_target.v1": TypeAdapter(InventoryIntakeMissingTargetState),
    "recipe_shortage_to_shopping.v1": TypeAdapter(RecipeShortageToShoppingState),
}

CONTINUATION_STATE_SCHEMAS: dict[str, dict[str, Any]] = {
    key: adapter.json_schema() for key, adapter in CONTINUATION_STATE_ADAPTERS.items()
}


def validate_continuation_state(schema_key: str, state: dict[str, Any]) -> dict[str, Any]:
    adapter = CONTINUATION_STATE_ADAPTERS.get(schema_key)
    if adapter is None:
        raise ValueError(f"Unknown continuation state schema: {schema_key}")
    validated = adapter.validate_python(state, strict=True)
    return validated.model_dump(
        mode="json",
        exclude_none=schema_key == "recipe_shortage_to_shopping.v1",
    )
