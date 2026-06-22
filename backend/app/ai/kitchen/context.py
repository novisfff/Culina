from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import AiMode, FoodType
from app.models.domain import Family, Food, Ingredient, InventoryItem, MealLog, MealLogFood, Recipe


@dataclass(slots=True)
class AgentContext:
    family: Family | None = None
    inventory_items: list[InventoryItem] = field(default_factory=list)
    meal_logs: list[MealLog] = field(default_factory=list)
    food: Food | None = None
    ingredients: list[Ingredient] = field(default_factory=list)
    recommendation_foods: list[Food] = field(default_factory=list)

    def to_record(self) -> dict[str, Any]:
        return {
            "familyId": self.family.id if self.family else None,
            "inventoryItemCount": len(self.inventory_items),
            "mealLogCount": len(self.meal_logs),
            "foodId": self.food.id if self.food else None,
            "ingredientIds": [item.id for item in self.ingredients],
            "recommendationFoodCount": len(self.recommendation_foods),
        }


def _subject_value(subject: dict[str, Any], camel_key: str, snake_key: str, default: Any = None) -> Any:
    if camel_key in subject:
        return subject[camel_key]
    if snake_key in subject:
        return subject[snake_key]
    return default


def load_agent_context(
    db: Session,
    *,
    family_id: str,
    mode: AiMode | None,
    subject: dict[str, Any],
    include_inventory: bool = True,
    include_meal_logs: bool = True,
) -> AgentContext:
    food_id = _subject_value(subject, "foodId", "food_id")
    ingredient_ids = list(_subject_value(subject, "ingredientIds", "ingredient_ids", []) or [])

    family = db.scalar(select(Family).where(Family.id == family_id))
    inventory_items = (
        list(
            db.scalars(
                select(InventoryItem)
                .where(InventoryItem.family_id == family_id)
                .options(selectinload(InventoryItem.ingredient))
            )
        )
        if include_inventory
        else []
    )
    meal_logs = (
        list(
            db.scalars(
                select(MealLog)
                .where(MealLog.family_id == family_id)
                .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food))
                .order_by(MealLog.date.desc(), MealLog.created_at.desc())
                .limit(5)
            )
        )
        if include_meal_logs
        else []
    )
    food = (
        db.scalar(
            select(Food)
            .where(Food.family_id == family_id, Food.id == food_id)
            .options(selectinload(Food.recipe).selectinload(Recipe.ingredient_items))
        )
        if food_id
        else None
    )
    ingredients = (
        list(
            db.scalars(
                select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id.in_(ingredient_ids))
            )
        )
        if ingredient_ids
        else []
    )
    recommendation_foods = (
        list(
            db.scalars(
                select(Food)
                .where(Food.family_id == family_id, Food.type == FoodType.SELF_MADE.value)
                .options(selectinload(Food.recipe).selectinload(Recipe.ingredient_items))
            )
        )
        if mode == AiMode.RECOMMENDATION
        else []
    )

    return AgentContext(
        family=family,
        inventory_items=inventory_items,
        meal_logs=meal_logs,
        food=food,
        ingredients=ingredients,
        recommendation_foods=recommendation_foods,
    )
