from __future__ import annotations

from enum import Enum


class UserRole(str, Enum):
    OWNER = "Owner"
    MEMBER = "Member"


class MembershipStatus(str, Enum):
    ACTIVE = "active"
    INVITED = "invited"


class FoodType(str, Enum):
    SELF_MADE = "selfMade"
    TAKEOUT = "takeout"
    DINING_OUT = "diningOut"
    READY_MADE = "readyMade"
    INSTANT = "instant"
    PACKAGED = "packaged"


FOOD_TYPE_VALUES = {item.value for item in FoodType}
LEGACY_FOOD_TYPE_VALUES = {
    "SELF_MADE": FoodType.SELF_MADE.value,
    "TAKEOUT": FoodType.TAKEOUT.value,
    "DINING_OUT": FoodType.DINING_OUT.value,
    "READY_MADE": FoodType.READY_MADE.value,
    "INSTANT": FoodType.INSTANT.value,
    "PACKAGED": FoodType.READY_MADE.value,
}


def normalize_food_type(value: FoodType | str) -> str:
    raw_value = value.value if isinstance(value, FoodType) else value
    return LEGACY_FOOD_TYPE_VALUES.get(raw_value, raw_value)


def food_type_values(food_type: FoodType) -> tuple[str, ...]:
    return tuple(
        legacy_value
        for legacy_value, normalized_value in LEGACY_FOOD_TYPE_VALUES.items()
        if normalized_value == food_type.value
    ) + (food_type.value,)


class MealType(str, Enum):
    BREAKFAST = "breakfast"
    LUNCH = "lunch"
    DINNER = "dinner"
    SNACK = "snack"


class Difficulty(str, Enum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


class InventoryStatus(str, Enum):
    FRESH = "fresh"
    OPENED = "opened"
    FROZEN = "frozen"
    EXPIRING = "expiring"


class IngredientExpiryMode(str, Enum):
    DAYS = "days"
    MANUAL_DATE = "manual_date"
    NONE = "none"


class AiMode(str, Enum):
    FOOD_QA = "foodQa"
    INVENTORY_QA = "inventoryQa"
    RECOMMENDATION = "recommendation"
    RECIPE_DRAFT = "recipeDraft"


class ActivityAction(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    INVITE = "invite"
    SWITCH = "switch"


class MediaSource(str, Enum):
    UPLOAD = "upload"
    AI = "ai"


class ImageGenerationMode(str, Enum):
    REFERENCE = "reference"
    TEXT = "text"


class MediaEntityType(str, Enum):
    USER = "user"
    FAMILY = "family"
    FOOD = "food"
    INGREDIENT = "ingredient"
    RECIPE = "recipe"
    RECIPE_SCENE = "recipe_scene"
    FOOD_SCENE = "food_scene"
    MEAL_LOG = "meal_log"
