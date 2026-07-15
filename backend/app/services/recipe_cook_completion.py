from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.enums import ActivityAction, ActivityHighlightKind, FoodType, MealType
from app.core.utils import create_id, utcnow
from app.models.domain import (
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryItem,
    MealLog,
    MealLogFood,
    Recipe,
    RecipeCookLog,
)
from app.schemas.recipes import CookRecipeResponse
from app.services.activity import ActivityHighlight, log_activity
from app.services.clock import today_for_family
from app.services.food_plan_locking import FoodPlanConflict, lock_plan_item_after_food
from app.services.inventory_operation_locking import (
    InventoryTargetNotFoundError,
    LockedInventoryTargets,
    lock_inventory_targets,
)
from app.services.inventory_usage import (
    CookInventoryPlanItem,
    build_cook_inventory_plan,
    expiry_sort_key,
    remaining_quantity,
    serialize_cook_preview_item,
    tracks_quantity,
)
from app.services.inventory_versions import (
    InventoryConflictError,
    bump_ingredient_collection,
    require_expected_version,
)
from app.services.meal_log_references import (
    ValidatedMealLogReferences,
    lock_and_validate_meal_log_references,
    normalize_and_validate_participant_user_ids,
)
from app.services.meal_log_versions import (
    MEAL_LOG_DATE_MISMATCH_CODE,
    MEAL_LOG_DATE_MISMATCH_MESSAGE,
    MealLogConflictError,
    bump_meal_log_collection,
    discover_meal_log_entry_food_ids,
    lock_meal_log_write_targets,
    require_meal_log_version,
)
from app.services.meal_log_writes import MealEntryWrite, append_meal_log_entries, create_meal_log_with_entries
from app.services.recipe_food_sync import ensure_food_for_recipe

COMPLETION_RESULT_VERSION = 1
IDEMPOTENCY_KEY_REUSED_CODE = "idempotency_key_reused"
IDEMPOTENCY_KEY_REUSED_MESSAGE = "相同请求标识已用于不同内容，请使用新的请求标识"
COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE = "completion_result_version_unsupported"
COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE = "完成结果版本不受支持，无法安全重放"
INVENTORY_TARGETS_CHANGED_CODE = "inventory_targets_changed"
INVENTORY_TARGETS_CHANGED_MESSAGE = "库存目标已变化，请刷新后重试"


@dataclass(frozen=True, slots=True)
class RecipeCookInventoryExpectation:
    ingredient_boundaries: tuple[dict[str, Any], ...]
    preview_items: tuple[dict[str, Any], ...]
    shortages: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class RecipeCookCompletionCommand:
    completion_request_id: str
    family_id: str
    actor_user_id: str
    recipe_id: str
    cook_date: date
    meal_type: MealType
    servings: Decimal
    participant_user_ids: tuple[str, ...]
    notes: str
    food_plan_item_id: str | None
    food_plan_item_base_updated_at: datetime | None
    result_note: str
    adjustments: str
    rating: int | None
    allow_partial_inventory_deduction: bool
    inventory_expectation: RecipeCookInventoryExpectation | None = None
    recipe_base_updated_at: datetime | None = None
    target_meal_log_id: str | None = None
    expected_meal_log_row_version: int | None = None


@dataclass(frozen=True, slots=True)
class CompletionInventoryCandidates:
    ingredient_ids: tuple[str, ...]
    food_ids: tuple[str, ...]
    required_state_ingredient_ids: tuple[str, ...]
    optional_state_ingredient_ids: tuple[str, ...]
    inventory_item_ids: tuple[str, ...]
    shopping_item_ids: tuple[str, ...]
    candidate_plan_food_id: str | None


class CompletionConflict(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _decimal_string(value: Decimal) -> str:
    normalized = value.normalize()
    return "0" if normalized == 0 else format(normalized, "f")


def _canonicalize_datetime(value: datetime | None) -> str | None:
    """Normalize datetimes to UTC ISO-8601 with Z for stable hashing."""
    if value is None:
        return None
    dt = value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    else:
        dt = dt.astimezone(UTC)
    # Use microseconds-preserving ISO then force Z suffix for UTC.
    text = dt.isoformat().replace("+00:00", "Z")
    if not text.endswith("Z"):
        text = f"{text}Z"
    return text


def canonicalize_completion_command(command: RecipeCookCompletionCommand) -> dict[str, Any]:
    """Build the stable business payload used for completion request hashing.

    Intentionally excludes completion_request_id, replayed, and other
    transport-only fields so retries with the same business intent hash equal.
    """
    return {
        "family_id": command.family_id,
        "actor_user_id": command.actor_user_id,
        "recipe_id": command.recipe_id,
        "cook_date": command.cook_date.isoformat(),
        "meal_type": command.meal_type.value,
        "servings": _decimal_string(command.servings),
        "participant_user_ids": sorted(set(command.participant_user_ids)),
        "notes": command.notes,
        "food_plan_item_id": command.food_plan_item_id,
        "food_plan_item_base_updated_at": _canonicalize_datetime(command.food_plan_item_base_updated_at),
        "result_note": command.result_note,
        "adjustments": command.adjustments,
        "rating": command.rating,
        "allow_partial_inventory_deduction": command.allow_partial_inventory_deduction,
        "inventory_expectation": jsonable_encoder(command.inventory_expectation),
        "target_meal_log_id": command.target_meal_log_id,
        "expected_meal_log_row_version": command.expected_meal_log_row_version,
    }


def hash_completion_command(command: RecipeCookCompletionCommand) -> str:
    encoded = json.dumps(
        canonicalize_completion_command(command),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalize_participant_ids_for_hash(
    *,
    actor_user_id: str,
    participant_user_ids: Sequence[str],
) -> tuple[str, ...]:
    """Sort/dedupe participant IDs for hashing without active-membership checks.

    Replay must still match the stored claim hash after a member leaves. Active
    membership is enforced only on the first-write path.
    """
    normalized = tuple(sorted({str(value).strip() for value in participant_user_ids if str(value).strip()}))
    if not normalized:
        return (actor_user_id,)
    return normalized


def encode_completion_result(response: CookRecipeResponse) -> dict[str, Any]:
    payload = response.model_dump(mode="json")
    payload.pop("replayed", None)
    return {"version": COMPLETION_RESULT_VERSION, "response": payload}


def load_completion_replay_if_present(
    db: Session,
    *,
    family_id: str,
    completion_request_id: str,
    request_hash: str,
) -> CookRecipeResponse | None:
    """Return a replayed response when a claim already exists.

    Returns None only when no claim row is present. An existing claim with a
    mismatched hash, missing result, or unsupported envelope raises
    CompletionConflict and never re-executes the cook path.
    """
    claim = db.scalar(
        select(RecipeCookLog).where(
            RecipeCookLog.family_id == family_id,
            RecipeCookLog.completion_request_id == completion_request_id,
        )
    )
    if claim is None:
        return None
    if claim.completion_request_hash != request_hash:
        raise CompletionConflict(IDEMPOTENCY_KEY_REUSED_CODE, IDEMPOTENCY_KEY_REUSED_MESSAGE)

    envelope = claim.completion_result_json
    if not isinstance(envelope, dict):
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )
    if envelope.get("version") != COMPLETION_RESULT_VERSION:
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )
    response_payload = envelope.get("response")
    if not isinstance(response_payload, dict):
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        )

    try:
        response = CookRecipeResponse.model_validate(response_payload)
    except Exception as exc:  # pydantic ValidationError and similar
        raise CompletionConflict(
            COMPLETION_RESULT_VERSION_UNSUPPORTED_CODE,
            COMPLETION_RESULT_VERSION_UNSUPPORTED_MESSAGE,
        ) from exc
    return response.model_copy(update={"replayed": True})


def claim_completion(
    db: Session,
    *,
    command: RecipeCookCompletionCommand,
    request_hash: str,
) -> RecipeCookLog:
    """Insert the first-write completion claim row and flush.

    Called after read locks and before inventory/MealLog/plan/activity writes.
    On unique conflict the IntegrityError propagates; complete_recipe_cook wraps
    this call in begin_nested so only the claim savepoint rolls back, then loads
    the winner through load_completion_replay_if_present.
    """
    cook_log = RecipeCookLog(
        id=create_id("recipe-cook"),
        family_id=command.family_id,
        recipe_id=command.recipe_id,
        meal_log_id=None,
        cook_date=command.cook_date,
        meal_type=command.meal_type,
        servings=command.servings,
        result_note=command.result_note,
        adjustments=command.adjustments,
        rating=command.rating,
        completion_request_id=command.completion_request_id,
        completion_request_hash=request_hash,
        completion_result_json=None,
        created_by=command.actor_user_id,
        updated_by=command.actor_user_id,
    )
    db.add(cook_log)
    db.flush()
    return cook_log


def lock_recipe_for_completion(db: Session, command: RecipeCookCompletionCommand) -> Recipe:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == command.family_id, Recipe.id == command.recipe_id)
        .options(
            selectinload(Recipe.ingredient_items),
            selectinload(Recipe.steps),
            selectinload(Recipe.foods),
            selectinload(Recipe.cook_logs),
        )
        .with_for_update()
    )
    if recipe is None:
        raise CompletionConflict("recipe_not_found", "菜谱不存在或不属于当前家庭")
    if command.recipe_base_updated_at is not None:
        actual = recipe.updated_at
        expected = command.recipe_base_updated_at
        if actual is None:
            raise CompletionConflict("recipe_stale", "菜谱已被其他成员更新，请刷新后重试")
        actual_dt = actual if actual.tzinfo is not None else actual.replace(tzinfo=UTC)
        expected_dt = expected if expected.tzinfo is not None else expected.replace(tzinfo=UTC)
        if actual_dt.astimezone(UTC) != expected_dt.astimezone(UTC):
            raise CompletionConflict("recipe_stale", "菜谱已被其他成员更新，请刷新后重试")
    return recipe


def _unique_sorted_ids(ids: Sequence[str | None]) -> tuple[str, ...]:
    return tuple(sorted({item_id for item_id in ids if item_id}))


def discover_completion_inventory_candidates(
    db: Session,
    *,
    recipe: Recipe,
    command: RecipeCookCompletionCommand,
) -> CompletionInventoryCandidates:
    """Discover lock targets without writing or locking inventory parents."""
    # Usability filters use family "today"; cook_date remains the meal log date.
    today = today_for_family(command.family_id)
    ingredient_ids = _unique_sorted_ids(
        [item.ingredient_id for item in recipe.ingredient_items if item.ingredient_id]
    )
    ingredients_by_id: dict[str, Ingredient] = {}
    if ingredient_ids:
        ingredients_by_id = {
            ingredient.id: ingredient
            for ingredient in db.scalars(
                select(Ingredient).where(
                    Ingredient.family_id == command.family_id,
                    Ingredient.id.in_(ingredient_ids),
                )
            )
        }

    presence_ingredient_ids = [
        ingredient_id
        for ingredient_id, ingredient in ingredients_by_id.items()
        if not tracks_quantity(ingredient)
    ]
    tracked_ingredient_ids = [
        ingredient_id
        for ingredient_id, ingredient in ingredients_by_id.items()
        if tracks_quantity(ingredient)
    ]

    inventory_item_ids: list[str] = []
    if tracked_ingredient_ids:
        items = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.family_id == command.family_id,
                    InventoryItem.ingredient_id.in_(tracked_ingredient_ids),
                )
            )
        )
        for item in items:
            if item.expiry_date is not None and item.expiry_date < today:
                continue
            if remaining_quantity(item) <= 0:
                continue
            inventory_item_ids.append(item.id)

    optional_state_ingredient_ids = list(presence_ingredient_ids)
    required_state_ingredient_ids: list[str] = []
    if command.inventory_expectation is not None:
        for boundary in command.inventory_expectation.ingredient_boundaries:
            if not isinstance(boundary, Mapping):
                continue
            ingredient_id = str(boundary.get("ingredientId") or boundary.get("ingredient_id") or "").strip()
            if not ingredient_id:
                continue
            state_id = boundary.get("stateId") if "stateId" in boundary else boundary.get("state_id")
            if state_id is not None and str(state_id).strip():
                required_state_ingredient_ids.append(ingredient_id)

    food_ids: list[str] = []
    for food in recipe.foods:
        if food.family_id == command.family_id and food.type == FoodType.SELF_MADE.value:
            food_ids.append(food.id)

    existing_food = db.scalar(
        select(Food).where(
            Food.family_id == command.family_id,
            Food.recipe_id == recipe.id,
            Food.type == FoodType.SELF_MADE.value,
        )
    )
    if existing_food is not None:
        food_ids.append(existing_food.id)

    candidate_plan_food_id: str | None = None
    if command.food_plan_item_id is not None:
        plan_item = db.scalar(
            select(FoodPlanItem)
            .where(
                FoodPlanItem.family_id == command.family_id,
                FoodPlanItem.user_id == command.actor_user_id,
                FoodPlanItem.id == command.food_plan_item_id,
            )
            .options(selectinload(FoodPlanItem.food))
        )
        if plan_item is None:
            raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
        plan_food = plan_item.food
        if plan_food is None or plan_food.family_id != command.family_id or plan_food.recipe_id != recipe.id:
            raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
        candidate_plan_food_id = plan_item.food_id
        food_ids.append(plan_item.food_id)

    return CompletionInventoryCandidates(
        ingredient_ids=ingredient_ids,
        food_ids=_unique_sorted_ids(food_ids),
        required_state_ingredient_ids=_unique_sorted_ids(required_state_ingredient_ids),
        optional_state_ingredient_ids=_unique_sorted_ids(optional_state_ingredient_ids),
        inventory_item_ids=_unique_sorted_ids(inventory_item_ids),
        shopping_item_ids=(),
        candidate_plan_food_id=candidate_plan_food_id,
    )


def _inventory_by_ingredient_from_locked(
    locked: LockedInventoryTargets,
    *,
    today: date,
) -> dict[str, list[InventoryItem]]:
    inventory_by_ingredient: dict[str, list[InventoryItem]] = {}
    for item in locked.inventory_items.values():
        if item.expiry_date is not None and item.expiry_date < today:
            continue
        if remaining_quantity(item) <= 0:
            continue
        inventory_by_ingredient.setdefault(item.ingredient_id, []).append(item)
    for available_items in inventory_by_ingredient.values():
        available_items.sort(
            key=lambda entry: (*expiry_sort_key(entry.expiry_date), entry.purchase_date, entry.created_at)
        )
    return inventory_by_ingredient


def _validate_inventory_expectation(
    *,
    locked: LockedInventoryTargets,
    expectation: RecipeCookInventoryExpectation,
    plan: list[CookInventoryPlanItem],
    shortages: list[dict],
) -> None:
    for boundary in expectation.ingredient_boundaries:
        if not isinstance(boundary, Mapping):
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
        ingredient_id = str(boundary.get("ingredientId") or boundary.get("ingredient_id") or "").strip()
        if not ingredient_id:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
        ingredient = locked.ingredients.get(ingredient_id)
        if ingredient is None:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)

        expected_ingredient_version = boundary.get("expectedIngredientRowVersion")
        if expected_ingredient_version is None:
            expected_ingredient_version = boundary.get("expected_ingredient_row_version")
        if expected_ingredient_version is None:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
        require_expected_version(
            ingredient,
            int(expected_ingredient_version),
            entity_type="ingredient",
            entity_id=ingredient.id,
        )

        expected_tracking = str(
            boundary.get("quantityTrackingMode") or boundary.get("quantity_tracking_mode") or ""
        )
        actual_tracking = "track_quantity" if tracks_quantity(ingredient) else "not_track_quantity"
        if expected_tracking and expected_tracking != actual_tracking:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)

        state_id = boundary.get("stateId") if "stateId" in boundary else boundary.get("state_id")
        expected_state_version = boundary.get("expectedStateRowVersion")
        if expected_state_version is None:
            expected_state_version = boundary.get("expected_state_row_version")
        state = locked.states_by_ingredient_id.get(ingredient.id)
        if state_id is not None:
            if state is None or state.id != str(state_id):
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            if expected_state_version is not None:
                require_expected_version(
                    state,
                    int(expected_state_version),
                    entity_type="ingredient_inventory_state",
                    entity_id=state.id,
                )

        batches = boundary.get("batches") or []
        if not isinstance(batches, list):
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
        for batch in batches:
            if not isinstance(batch, Mapping):
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            item_id = str(batch.get("inventoryItemId") or batch.get("inventory_item_id") or "").strip()
            item = locked.inventory_items.get(item_id)
            if item is None or item.ingredient_id != ingredient.id:
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            expected_item_version = batch.get("expectedRowVersion")
            if expected_item_version is None:
                expected_item_version = batch.get("expected_row_version")
            if expected_item_version is None:
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            require_expected_version(
                item,
                int(expected_item_version),
                entity_type="inventory_item",
                entity_id=item.id,
            )

    current_preview = jsonable_encoder([serialize_cook_preview_item(item) for item in plan])
    expected_preview = jsonable_encoder(list(expectation.preview_items))
    expected_shortages = jsonable_encoder(list(expectation.shortages))
    if expected_preview != current_preview or expected_shortages != shortages:
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)


def rebuild_and_validate_completion_plan(
    db: Session,
    *,
    recipe: Recipe,
    command: RecipeCookCompletionCommand,
    candidates: CompletionInventoryCandidates,
    locked: LockedInventoryTargets,
) -> tuple[list[CookInventoryPlanItem], list[dict]]:
    today = today_for_family(command.family_id)
    inventory_by_ingredient = _inventory_by_ingredient_from_locked(locked, today=today)
    plan, shortages = build_cook_inventory_plan(
        db,
        family_id=command.family_id,
        recipe=recipe,
        servings=float(command.servings),
        today=today,
        inventory_by_ingredient=inventory_by_ingredient,
        allow_partial_deduction=command.allow_partial_inventory_deduction,
        presence_states_by_ingredient=locked.states_by_ingredient_id,
    )

    planned_ingredient_ids = {item.ingredient.id for item in plan if item.ingredient is not None}
    planned_item_ids = {
        deduction.item.id for item in plan for deduction in item.deductions if deduction.item is not None
    }
    # Plan may only touch parents/items that were discovered and locked. Using the
    # locked set alone is tautological (plan was built from locked items).
    locked_ingredient_ids = set(locked.ingredients)
    locked_item_ids = set(locked.inventory_items)
    candidate_ingredient_ids = set(candidates.ingredient_ids)
    candidate_item_ids = set(candidates.inventory_item_ids)
    if not planned_ingredient_ids.issubset(candidate_ingredient_ids):
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
    if not planned_item_ids.issubset(candidate_item_ids):
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
    if not planned_ingredient_ids.issubset(locked_ingredient_ids):
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
    if not planned_item_ids.issubset(locked_item_ids):
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)

    # Required presence states from AI expectation must also be in the locked set.
    for state_ingredient_id in candidates.required_state_ingredient_ids:
        if state_ingredient_id not in locked.states_by_ingredient_id:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)

    if command.inventory_expectation is not None:
        try:
            _validate_inventory_expectation(
                locked=locked,
                expectation=command.inventory_expectation,
                plan=plan,
                shortages=shortages,
            )
        except InventoryConflictError as exc:
            raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE) from exc

    return plan, shortages


def blocked_shortage_response(recipe_id: str, shortages: list[dict]) -> CookRecipeResponse:
    return CookRecipeResponse(
        recipe_id=recipe_id,
        consumed_items=[],
        shortages=shortages,
        meal_log_id=None,
        cook_log_id=None,
        replayed=False,
    )


def lock_optional_completion_plan_item(
    db: Session,
    *,
    command: RecipeCookCompletionCommand,
    candidate_plan_food_id: str | None,
    locked_foods: Mapping[str, Food],
) -> FoodPlanItem | None:
    if command.food_plan_item_id is None:
        if command.food_plan_item_base_updated_at is not None:
            raise CompletionConflict("food_plan_source_invalid", "菜单版本不能脱离菜单项使用")
        return None
    if candidate_plan_food_id is None or candidate_plan_food_id not in locked_foods:
        raise CompletionConflict("food_plan_targets_changed", "菜单关联已变化，请刷新后重试")
    return lock_plan_item_after_food(
        db,
        family_id=command.family_id,
        user_id=command.actor_user_id,
        item_id=command.food_plan_item_id,
        expected_food_id=candidate_plan_food_id,
        base_updated_at=command.food_plan_item_base_updated_at,
        require_planned=True,
    )


def apply_locked_inventory_plan(
    db: Session,
    *,
    plan: list[CookInventoryPlanItem],
    locked: LockedInventoryTargets,
    actor_user_id: str,
) -> list[dict[str, Any]]:
    del db  # mutations happen on already-locked ORM instances
    consumed_items: list[dict[str, Any]] = []
    bumped_ingredient_ids: set[str] = set()
    for plan_item in plan:
        affected_item_ids: list[str] = []
        for deduction in plan_item.deductions:
            item = locked.inventory_items.get(deduction.item.id)
            if item is None:
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            item.consumed_quantity = item.consumed_quantity + deduction.quantity
            item.updated_by = actor_user_id
            affected_item_ids.append(item.id)

        if affected_item_ids and plan_item.ingredient is not None and plan_item.ingredient.id not in bumped_ingredient_ids:
            ingredient = locked.ingredients.get(plan_item.ingredient.id)
            if ingredient is None:
                raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE)
            bump_ingredient_collection(ingredient, user_id=actor_user_id)
            bumped_ingredient_ids.add(plan_item.ingredient.id)

        if plan_item.ingredient is None:
            continue
        consumed_items.append(
            {
                "ingredient_id": plan_item.ingredient.id,
                "ingredient_name": plan_item.ingredient_item.ingredient_name,
                "requested_quantity": float(plan_item.requested_quantity),
                "unit": plan_item.ingredient_item.unit,
                "quantity_tracking_mode": plan_item.quantity_tracking_mode,
                "deduction_note": plan_item.deduction_note,
                "affected_item_ids": affected_item_ids,
            }
        )
    return consumed_items


def ensure_completion_food_after_claim(
    db: Session,
    *,
    recipe: Recipe,
    command: RecipeCookCompletionCommand,
    locked_foods: Mapping[str, Food],
) -> Food:
    for food in locked_foods.values():
        if (
            food.family_id == command.family_id
            and food.recipe_id == recipe.id
            and food.type == FoodType.SELF_MADE.value
        ):
            return food
    # Create-only under the held recipe lock. Never rebind an unlocked orphan by name.
    food, _ = ensure_food_for_recipe(
        db,
        family_id=command.family_id,
        user_id=command.actor_user_id,
        recipe=recipe,
        sync_media=False,
        allow_orphan_rebind=False,
    )
    return food


def validate_target_meal_log_for_completion(
    meal_log: MealLog,
    *,
    command: RecipeCookCompletionCommand,
) -> None:
    """First business checks after target MealLog is locked (before inventory mutation)."""
    if meal_log.date != command.cook_date or meal_log.meal_type != command.meal_type:
        raise MealLogConflictError(
            MEAL_LOG_DATE_MISMATCH_CODE,
            MEAL_LOG_DATE_MISMATCH_MESSAGE,
            recovery_hint="refresh_and_review",
        )
    if command.expected_meal_log_row_version is None:
        raise CompletionConflict("meal_log_target_invalid", "加入已有餐时必须提供 expected_meal_log_row_version")
    require_meal_log_version(meal_log, command.expected_meal_log_row_version)


def create_completion_meal_log(
    db: Session,
    *,
    command: RecipeCookCompletionCommand,
    food: Food,
    references: ValidatedMealLogReferences,
    target_meal_log: MealLog | None = None,
) -> MealLog:
    if food.id not in references.foods_by_id:
        raise CompletionConflict("meal_log_food_not_found", "食物不存在或不属于当前家庭")
    entry = MealEntryWrite(food_id=food.id, servings=command.servings, note="", rating=None)
    if target_meal_log is not None:
        # Version/date already validated immediately after locks; only append here.
        append_meal_log_entries(db, meal_log=target_meal_log, entries=[entry])
        bump_meal_log_collection(target_meal_log, user_id=command.actor_user_id)
        return target_meal_log

    meal_log, _ = create_meal_log_with_entries(
        db,
        family_id=command.family_id,
        user_id=command.actor_user_id,
        date=command.cook_date,
        meal_type=command.meal_type,
        entries=[entry],
        participant_user_ids=list(references.participant_user_ids),
        notes=command.notes,
        mood="",
    )
    return meal_log


def finish_claimed_cook_log(
    cook_log: RecipeCookLog,
    *,
    command: RecipeCookCompletionCommand,
    meal_log: MealLog,
) -> None:
    del command
    cook_log.meal_log_id = meal_log.id
    cook_log.updated_by = cook_log.updated_by or meal_log.updated_by


def finish_optional_plan_item(
    plan_item: FoodPlanItem | None,
    *,
    meal_log: MealLog,
    actor_user_id: str,
) -> None:
    if plan_item is None:
        return
    plan_item.status = "cooked"
    plan_item.completed_at = utcnow()
    plan_item.meal_log_id = meal_log.id
    plan_item.updated_by = actor_user_id


def record_completion_activity(
    db: Session,
    *,
    recipe: Recipe,
    command: RecipeCookCompletionCommand,
    consumed_items: list[dict[str, Any]],
) -> None:
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"完成菜谱 {recipe.title}，扣减 {len(consumed_items)} 项食材",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL,
            summary=f"完成 {recipe.title} 并记录用餐",
        ),
    )


def successful_completion_response(
    recipe_id: str,
    consumed_items: list[dict[str, Any]],
    shortages: list[dict],
    meal_log_id: str,
    cook_log_id: str,
) -> CookRecipeResponse:
    return CookRecipeResponse(
        recipe_id=recipe_id,
        consumed_items=consumed_items,
        shortages=shortages,
        meal_log_id=meal_log_id,
        cook_log_id=cook_log_id,
        replayed=False,
    )


def complete_recipe_cook(db: Session, command: RecipeCookCompletionCommand) -> CookRecipeResponse:
    # Hash without active-membership checks so an existing claim can replay even if
    # a participant later leaves the family. Membership is revalidated for writes.
    hashed_participants = normalize_participant_ids_for_hash(
        actor_user_id=command.actor_user_id,
        participant_user_ids=command.participant_user_ids,
    )
    hashed_command = replace(command, participant_user_ids=hashed_participants)
    request_hash = hash_completion_command(hashed_command)
    replay = load_completion_replay_if_present(
        db,
        family_id=command.family_id,
        completion_request_id=command.completion_request_id,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay

    recipe = lock_recipe_for_completion(db, hashed_command)
    replay = load_completion_replay_if_present(
        db,
        family_id=command.family_id,
        completion_request_id=command.completion_request_id,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay

    # First-write path requires currently active participants.
    normalized_participants = normalize_and_validate_participant_user_ids(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        participant_user_ids=command.participant_user_ids,
    )
    normalized_command = replace(command, participant_user_ids=normalized_participants)
    # Defensive: validated set must match the hashed identity used for the claim.
    if normalized_participants != hashed_participants:
        raise CompletionConflict(IDEMPOTENCY_KEY_REUSED_CODE, IDEMPOTENCY_KEY_REUSED_MESSAGE)

    candidates = discover_completion_inventory_candidates(db, recipe=recipe, command=normalized_command)
    # Discover target MealLog entry Foods before any inventory lock so we can union
    # them into the first Food lock set and never re-lock Foods after InventoryItems.
    target_entry_food_ids: tuple[str, ...] = ()
    if normalized_command.target_meal_log_id is not None:
        target_entry_food_ids = discover_meal_log_entry_food_ids(
            db,
            family_id=command.family_id,
            meal_log_id=normalized_command.target_meal_log_id,
        )
    inventory_food_ids = _unique_sorted_ids([*candidates.food_ids, *target_entry_food_ids])
    try:
        locked = lock_inventory_targets(
            db,
            family_id=command.family_id,
            ingredient_ids=candidates.ingredient_ids,
            food_ids=inventory_food_ids,
            state_ingredient_ids=candidates.required_state_ingredient_ids,
            optional_state_ingredient_ids=candidates.optional_state_ingredient_ids,
            inventory_item_ids=candidates.inventory_item_ids,
            shopping_item_ids=candidates.shopping_item_ids,
        )
    except InventoryTargetNotFoundError as exc:
        raise CompletionConflict(INVENTORY_TARGETS_CHANGED_CODE, INVENTORY_TARGETS_CHANGED_MESSAGE) from exc

    plan, shortages = rebuild_and_validate_completion_plan(
        db,
        recipe=recipe,
        command=normalized_command,
        candidates=candidates,
        locked=locked,
    )
    if shortages and not command.allow_partial_inventory_deduction:
        return blocked_shortage_response(recipe.id, shortages)

    try:
        # When already inside a SAVEPOINT (AI approval begin_nested), wrap the claim
        # so IntegrityError only rolls back the claim savepoint and keeps the outer
        # AI transaction open. On the REST path claim is the first write: avoid
        # begin_nested so successful claims remain fully rollback-able under SQLite
        # StaticPool (released savepoints can otherwise leave durable rows).
        if db.in_nested_transaction():
            with db.begin_nested():
                cook_log = claim_completion(db, command=normalized_command, request_hash=request_hash)
        else:
            cook_log = claim_completion(db, command=normalized_command, request_hash=request_hash)
    except IntegrityError as exc:
        if db.in_nested_transaction():
            # Claim savepoint already rolled back by begin_nested; outer txn intact.
            pass
        else:
            # Full rollback clears the failed INSERT so we can load the winner cleanly.
            db.rollback()
        replay = load_completion_replay_if_present(
            db,
            family_id=command.family_id,
            completion_request_id=command.completion_request_id,
            request_hash=request_hash,
        )
        if replay is not None:
            return replay
        raise CompletionConflict(IDEMPOTENCY_KEY_REUSED_CODE, IDEMPOTENCY_KEY_REUSED_MESSAGE) from exc

    # After claim: optional MealLog (Foods already held) → plan → version/date checks → inventory mutation.
    # First business checks on locked targets run only after all write locks are held.
    target_meal_log: MealLog | None = None
    locked_foods = dict(locked.foods)
    if normalized_command.target_meal_log_id is not None:
        locked_target = lock_meal_log_write_targets(
            db,
            family_id=command.family_id,
            meal_log_id=normalized_command.target_meal_log_id,
            additional_food_ids=list(candidates.food_ids),
            prelocked_foods=locked_foods,
        )
        target_meal_log = locked_target.meal_log
        locked_foods.update(locked_target.foods_by_id)

    plan_item = lock_optional_completion_plan_item(
        db,
        command=normalized_command,
        candidate_plan_food_id=candidates.candidate_plan_food_id,
        locked_foods=locked_foods,
    )
    if target_meal_log is not None:
        validate_target_meal_log_for_completion(target_meal_log, command=normalized_command)
    consumed_items = apply_locked_inventory_plan(
        db,
        plan=plan,
        locked=locked,
        actor_user_id=command.actor_user_id,
    )
    food = ensure_completion_food_after_claim(
        db,
        recipe=recipe,
        command=normalized_command,
        locked_foods=locked_foods,
    )
    references = lock_and_validate_meal_log_references(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        food_ids=[food.id],
        participant_user_ids=normalized_participants,
        prelocked_foods={**locked_foods, food.id: food},
    )
    meal_log = create_completion_meal_log(
        db,
        command=normalized_command,
        food=food,
        references=references,
        target_meal_log=target_meal_log,
    )
    finish_claimed_cook_log(cook_log, command=normalized_command, meal_log=meal_log)
    finish_optional_plan_item(plan_item, meal_log=meal_log, actor_user_id=command.actor_user_id)
    record_completion_activity(
        db,
        recipe=recipe,
        command=normalized_command,
        consumed_items=consumed_items,
    )
    response = successful_completion_response(
        recipe.id,
        consumed_items,
        shortages,
        meal_log.id,
        cook_log.id,
    )
    cook_log.completion_result_json = encode_completion_result(response)
    db.flush()
    return response
