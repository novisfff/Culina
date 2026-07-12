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


class InventoryAvailabilityLevel(str, Enum):
    PRESENT_UNKNOWN = "present_unknown"
    LOW = "low"
    SUFFICIENT = "sufficient"
    ABSENT = "absent"


class InventoryConfirmationSource(str, Enum):
    MANUAL_ENTRY = "manual_entry"
    RECONCILIATION = "reconciliation"
    SHOPPING_INTAKE = "shopping_intake"


class InventoryOperationType(str, Enum):
    RECONCILIATION = "reconciliation"
    SHOPPING_INTAKE = "shopping_intake"


class InventoryOperationStatus(str, Enum):
    APPLIED = "applied"
    REVERTED = "reverted"


class InventoryOperationEntityType(str, Enum):
    INGREDIENT = "ingredient"
    INVENTORY_ITEM = "inventory_item"
    NON_TRACKED_INGREDIENT_STATE = "non_tracked_ingredient_state"
    FOOD = "food"
    SHOPPING_LIST_ITEM = "shopping_list_item"


class InventoryOperationChangeType(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


class IngredientExpiryMode(str, Enum):
    DAYS = "days"
    MANUAL_DATE = "manual_date"
    NONE = "none"


class IngredientQuantityTrackingMode(str, Enum):
    TRACK_QUANTITY = "track_quantity"
    NOT_TRACK_QUANTITY = "not_track_quantity"


class AiMode(str, Enum):
    FOOD_QA = "foodQa"
    INVENTORY_QA = "inventoryQa"
    RECOMMENDATION = "recommendation"
    RECIPE_DRAFT = "recipeDraft"


class AIConversationVisibility(str, Enum):
    PRIVATE = "private"
    FAMILY = "family"


class ActivityAction(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    INVITE = "invite"
    SWITCH = "switch"
    REVERT = "revert"


class ActivityHighlightKind(str, Enum):
    SHOPPING = "shopping"
    INVENTORY = "inventory"
    MEAL_PLAN = "meal_plan"
    MEAL = "meal"
    FAMILY = "family"


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
