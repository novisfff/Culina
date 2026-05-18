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
    PACKAGED = "packaged"


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
    FOOD = "food"
    INGREDIENT = "ingredient"
    RECIPE = "recipe"
    RECIPE_SCENE = "recipe_scene"
    MEAL_LOG = "meal_log"
