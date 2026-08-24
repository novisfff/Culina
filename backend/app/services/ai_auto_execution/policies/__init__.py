from __future__ import annotations

from app.services.ai_auto_execution.policies.food_favorite import FoodFavoritePolicy
from app.services.ai_auto_execution.policies.meal_rating import MealRatingPolicy
from app.services.ai_auto_execution.policies.shopping_safe_write import ShoppingSafeWritePolicy
from app.services.ai_auto_execution.policies.simple_meal import SimpleMealPolicy
from app.services.ai_auto_execution.policies.simple_plan import SimplePlanPolicy
from app.services.ai_auto_execution.policy_types import AutoExecutionActionPolicy


POLICY_VERSIONS = {
    "food.set_favorite": "food.set_favorite.v1",
    "meal_log.rate_food": "meal_log.rate_food.v1",
    "shopping_list.safe_write": "shopping_list.safe_write.v1",
    "meal_log.simple_create": "meal_log.simple_create.v1",
    "meal_plan.simple_create": "meal_plan.simple_create.v1",
}


def build_action_policies() -> tuple[AutoExecutionActionPolicy, ...]:
    return (
        FoodFavoritePolicy(),
        MealRatingPolicy(),
        ShoppingSafeWritePolicy(),
        SimpleMealPolicy(),
        SimplePlanPolicy(),
    )


__all__ = [
    "POLICY_VERSIONS",
    "FoodFavoritePolicy",
    "MealRatingPolicy",
    "ShoppingSafeWritePolicy",
    "SimpleMealPolicy",
    "SimplePlanPolicy",
    "build_action_policies",
]
