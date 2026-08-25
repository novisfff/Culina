from __future__ import annotations

from app.services.ai_revert.adapters.food_favorite import FoodFavoriteRevertAdapter
from app.services.ai_revert.adapters.meal_rating import MealRatingRevertAdapter
from app.services.ai_revert.adapters.shopping_safe_write import ShoppingSafeWriteRevertAdapter
from app.services.ai_revert.adapters.simple_plan import SimplePlanRevertAdapter
from app.services.ai_revert.types import AIRevertAdapter


def low_risk_revert_adapters() -> tuple[AIRevertAdapter, ...]:
    return (
        FoodFavoriteRevertAdapter(),
        MealRatingRevertAdapter(),
        ShoppingSafeWriteRevertAdapter(),
        SimplePlanRevertAdapter(),
    )


__all__ = [
    "FoodFavoriteRevertAdapter",
    "MealRatingRevertAdapter",
    "ShoppingSafeWriteRevertAdapter",
    "SimplePlanRevertAdapter",
    "low_risk_revert_adapters",
]
