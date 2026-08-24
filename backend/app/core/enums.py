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


class MealLogRecordStatus(str, Enum):
    APPLIED = "applied"
    REVERTED = "reverted"


class MealLogRecordTargetKind(str, Enum):
    NEW = "new"
    EXISTING = "existing"


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
    CONSUME = "consume"
    DISPOSE = "dispose"


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


class ModelUsageCapability(str, Enum):
    LLM = "llm"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    STT = "stt"
    TTS = "tts"
    REALTIME_AUDIO = "realtime_audio"
    IMAGE_GENERATION = "image_generation"


class FamilyModelProviderStatus(str, Enum):
    ACTIVE = "active"
    DISABLED = "disabled"
    ARCHIVED = "archived"


class FamilyModelSecretStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"
    DESTROYED = "destroyed"


class FamilyModelConfigRevisionStatus(str, Enum):
    PUBLISHED = "published"
    SUPERSEDED = "superseded"


class FamilyModelSearchProfileStatus(str, Enum):
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SUPERSEDED = "superseded"
    RETIRED = "retired"


class FamilyModelOperationStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"


class FamilyModelResourceOperationType(str, Enum):
    ENSURE_SEARCH_PROFILE_COLLECTION = "ensure_search_profile_collection"
    DELETE_SEARCH_PROFILE_COLLECTION = "delete_search_profile_collection"


class FamilyModelResourceOperationStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    RETRY_WAIT = "retry_wait"
    COMPLETED = "completed"
    FAILED = "failed"


class FamilyModelPricePurpose(str, Enum):
    ACTIVE = "active"
    SEARCH_REBUILD_CANDIDATE = "search_rebuild_candidate"
    LEGACY_GLOBAL = "legacy_global"


class ModelUsageMeter(str, Enum):
    INPUT_TOKENS = "input_tokens"
    UNCACHED_INPUT_TOKENS = "uncached_input_tokens"
    CACHED_INPUT_TOKENS = "cached_input_tokens"
    OUTPUT_TOKENS = "output_tokens"
    TOTAL_TOKENS = "total_tokens"
    EMBEDDING_TOKENS = "embedding_tokens"
    RERANK_REQUESTS = "rerank_requests"
    RERANK_DOCUMENTS = "rerank_documents"
    AUDIO_INPUT_SECONDS = "audio_input_seconds"
    AUDIO_OUTPUT_SECONDS = "audio_output_seconds"
    AUDIO_INPUT_TOKENS = "audio_input_tokens"
    AUDIO_OUTPUT_TOKENS = "audio_output_tokens"
    TTS_CHARACTERS = "tts_characters"
    TTS_TOKENS = "tts_tokens"
    GENERATED_IMAGES = "generated_images"
    REQUEST_UNITS = "request_units"


class ModelUsageMeterRole(str, Enum):
    BILLABLE = "billable"
    INFORMATIONAL = "informational"


class ModelUsagePricingStatus(str, Enum):
    PRICED = "priced"
    UNPRICED = "unpriced"


class ModelUsageReservationStatus(str, Enum):
    RESERVED = "reserved"
    DISPATCHING = "dispatching"
    SETTLED = "settled"
    RELEASED = "released"
    UNCERTAIN = "uncertain"


class ModelUsageProviderOutcome(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED_BILLED = "failed_billed"
    NOT_BILLED = "not_billed"
    UNKNOWN = "unknown"


class ModelUsageExecutionCertainty(str, Enum):
    CONFIRMED_EXECUTED = "confirmed_executed"
    CONFIRMED_NOT_EXECUTED = "confirmed_not_executed"
    UNKNOWN = "unknown"


class ModelUsageMeasurementStatus(str, Enum):
    EXACT = "exact"
    ESTIMATED = "estimated"


class ModelUsageRecoveryMode(str, Enum):
    IDEMPOTENCY_KEY = "idempotency_key"
    QUERYABLE_REQUEST = "queryable_request"
    IDEMPOTENCY_AND_QUERYABLE = "idempotency_and_queryable"
    NONE = "none"


class ModelUsageAttributionKind(str, Enum):
    USER = "user"
    SYSTEM = "system"


class ModelUsageSubjectKind(str, Enum):
    USER = "user"
    SYSTEM = "system"


class ModelUsageCounterKind(str, Enum):
    FAMILY_COST = "family_cost"
    CAPABILITY_COST = "capability_cost"
    CAPABILITY_METER = "capability_meter"


class ModelUsageLimitKind(str, Enum):
    COST = "cost"
    METER = "meter"


class ModelUsageResolutionKind(str, Enum):
    METER_CORRECTION = "meter_correction"
    PRICING_CORRECTION = "pricing_correction"
    EXECUTION_RESOLUTION = "execution_resolution"


class ModelUsageRollupKind(str, Enum):
    FAMILY_TOTAL = "family_total"
    SUBJECT_TOTAL = "subject_total"
    CAPABILITY_TOTAL = "capability_total"
    PROVIDER_MODEL_TOTAL = "provider_model_total"
    METER_TOTAL = "meter_total"
    DAILY_CAPABILITY_COST = "daily_capability_cost"


class ModelUsageCorrectionStatus(str, Enum):
    OPEN = "open"
    PRUNING = "pruning"
    CLOSED = "closed"


class ModelUsageIncidentCoverage(str, Enum):
    EXACT_SCOPE = "exact_scope"
    PARTIAL_SCOPE = "partial_scope"
    UNKNOWN_SCOPE = "unknown_scope"


class ModelUsageIncidentRecoveryStatus(str, Enum):
    UNRESOLVED = "unresolved"
    RECOVERED = "recovered"


class ModelUsageQuantitySource(str, Enum):
    PROVIDER = "provider"
    SERVER_MEASURED = "server_measured"
    ESTIMATED = "estimated"


class ModelUsageOperationSource(str, Enum):
    INTERACTIVE = "interactive"
    BACKGROUND_INDEX = "background_index"
    IMAGE_JOB = "image_job"


class ModelUsageMemberBudgetState(str, Enum):
    SUFFICIENT = "sufficient"
    APPROACHING_LIMIT = "approaching_limit"
    ALERT_THRESHOLD_REACHED = "alert_threshold_reached"
    CAPABILITY_DEGRADED = "capability_degraded"
    MEASUREMENT_UNAVAILABLE = "measurement_unavailable"


# Backend services use the shorter name; the API-facing name remains explicit.
ModelUsageBudgetState = ModelUsageMemberBudgetState
