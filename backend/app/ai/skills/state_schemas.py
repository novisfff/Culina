from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


EntityId = Annotated[str, Field(min_length=1, max_length=64)]
ShortText = Annotated[str, Field(min_length=1, max_length=120)]
Instruction = Annotated[str, Field(min_length=1, max_length=500)]
IsoDate = Annotated[str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$")]
QuantityText = Annotated[str, Field(pattern=r"^[0-9]+(?:\.[0-9]+)?$")]


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


class InventoryMissingIngredientState(ContinuationStateModel):
    targetName: ShortText
    operation: Literal["restock", "consume", "dispose"]
    instruction: Instruction


class InventoryUnitConversionState(ContinuationStateModel):
    ingredientName: ShortText
    unitName: ShortText
    baseQuantity: Annotated[float, Field(gt=0)]
    baseUnit: ShortText
    instruction: Instruction


class ReadyFoodStockState(ContinuationStateModel):
    targetName: ShortText
    instruction: Instruction


class ShoppingToStockState(ContinuationStateModel):
    shoppingItemId: EntityId
    targetType: Literal["ingredient", "food"]
    ingredientId: EntityId | None = None
    foodId: EntityId | None = None
    quantity: QuantityText
    unit: ShortText
    stockAction: Literal["restock"]

    @model_validator(mode="after")
    def validate_target_identity(self) -> "ShoppingToStockState":
        if self.targetType == "ingredient":
            valid = self.ingredientId is not None and self.foodId is None
        else:
            valid = self.foodId is not None and self.ingredientId is None
        if not valid:
            raise ValueError("targetType must match exactly one target ID")
        return self


CONTINUATION_STATE_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "recipe_missing_ingredient.v1": TypeAdapter(RecipeMissingIngredientState),
    "shopping_missing_target.v1": TypeAdapter(ShoppingMissingTargetState),
    "food_to_meal_plan.v1": TypeAdapter(FoodToMealPlanState),
    "meal_missing_food.v1": TypeAdapter(MealMissingFoodState),
    "inventory_missing_ingredient.v1": TypeAdapter(InventoryMissingIngredientState),
    "inventory_unit_conversion.v1": TypeAdapter(InventoryUnitConversionState),
    "ready_food_stock.v1": TypeAdapter(ReadyFoodStockState),
    "shopping_to_stock.v1": TypeAdapter(ShoppingToStockState),
}

CONTINUATION_STATE_SCHEMAS: dict[str, dict[str, Any]] = {
    key: adapter.json_schema() for key, adapter in CONTINUATION_STATE_ADAPTERS.items()
}


def validate_continuation_state(schema_key: str, state: dict[str, Any]) -> dict[str, Any]:
    adapter = CONTINUATION_STATE_ADAPTERS.get(schema_key)
    if adapter is None:
        raise ValueError(f"Unknown continuation state schema: {schema_key}")
    validated = adapter.validate_python(state, strict=True)
    return validated.model_dump(mode="json")
