from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Food, MealLog, MealLogFood


@dataclass(frozen=True)
class MealFoodOccurrence:
    meal_log_id: str
    meal_date: date
    meal_created_at: datetime
    food_id: str
    food_name: str
    food_type: str
    entry_rating: Decimal | None


def list_meal_food_occurrences(
    db: Session,
    *,
    family_id: str,
) -> list[MealFoodOccurrence]:
    """Return family-scoped occurrence rows for insight aggregation.

    Each MealLogFood entry becomes one row. The service layer is responsible for
    collapsing duplicate entries within the same meal.
    """
    rows = db.execute(
        select(
            MealLog.id,
            MealLog.date,
            MealLog.created_at,
            Food.id,
            Food.name,
            Food.type,
            MealLogFood.rating,
        )
        .join(MealLogFood, MealLogFood.meal_log_id == MealLog.id)
        .join(Food, Food.id == MealLogFood.food_id)
        .where(
            MealLog.family_id == family_id,
            Food.family_id == family_id,
        )
        .order_by(
            MealLog.date.desc(),
            MealLog.created_at.desc(),
            MealLog.id.desc(),
            Food.id.asc(),
            MealLogFood.id.asc(),
        )
    ).all()

    occurrences: list[MealFoodOccurrence] = []
    for meal_log_id, meal_date, meal_created_at, food_id, food_name, food_type, entry_rating in rows:
        food_type_value = food_type.value if hasattr(food_type, "value") else str(food_type)
        occurrences.append(
            MealFoodOccurrence(
                meal_log_id=meal_log_id,
                meal_date=meal_date,
                meal_created_at=meal_created_at,
                food_id=food_id,
                food_name=food_name,
                food_type=food_type_value,
                entry_rating=entry_rating,
            )
        )
    return occurrences
