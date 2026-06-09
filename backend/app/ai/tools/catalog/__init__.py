from app.ai.tools.catalog.food import register_food_tools
from app.ai.tools.catalog.ingredient import register_ingredient_tools
from app.ai.tools.catalog.intent import register_intent_tools
from app.ai.tools.catalog.inventory import register_inventory_tools
from app.ai.tools.catalog.meal_log import register_meal_log_tools
from app.ai.tools.catalog.meal_plan import register_meal_plan_tools
from app.ai.tools.catalog.recipe import register_recipe_tools
from app.ai.tools.catalog.shopping import register_shopping_tools

__all__ = [
    "register_food_tools",
    "register_ingredient_tools",
    "register_intent_tools",
    "register_inventory_tools",
    "register_meal_log_tools",
    "register_meal_plan_tools",
    "register_recipe_tools",
    "register_shopping_tools",
]
