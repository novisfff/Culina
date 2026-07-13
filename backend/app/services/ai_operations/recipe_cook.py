from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.ai.draft_contracts import require_recipe_cook_schema_version
from app.ai.errors import AIConflictError
from app.core.enums import MealType
from app.models.domain import Recipe, RecipeCookLog
from app.services.clock import today_for_family
from app.services.food_plan_locking import FoodPlanConflict
from app.services.inventory_versions import InventoryConflictError, STALE_INVENTORY_DETAIL
from app.services.meal_log_references import MealLogReferenceError
from app.services.recipe_cook_completion import (
    CompletionConflict,
    RecipeCookCompletionCommand,
    RecipeCookInventoryExpectation,
    complete_recipe_cook,
)
from app.services.serializers import serialize_recipe_cook_log
from app.services.ai_operations.common import assert_updated_at_matches

logger = logging.getLogger(__name__)

SHORTAGE_CONFLICT_MESSAGE = "当前库存不足，不能直接完成做菜，请刷新预览或先补采购"


def _parse_optional_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValueError("planItemBaseUpdatedAt 格式不正确") from exc
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _map_completion_conflict(exc: CompletionConflict) -> AIConflictError:
    if exc.code == "recipe_not_found":
        return AIConflictError("菜谱不存在或已被删除")
    if exc.code == "recipe_stale":
        return AIConflictError(exc.message)
    if exc.code in {
        "inventory_targets_changed",
        "idempotency_key_reused",
        "completion_result_version_unsupported",
    }:
        return AIConflictError(STALE_INVENTORY_DETAIL if exc.code == "inventory_targets_changed" else exc.message)
    return AIConflictError(exc.message)


def _map_food_plan_conflict(exc: FoodPlanConflict) -> AIConflictError:
    if exc.code == "food_plan_item_not_found":
        return AIConflictError("关联计划项不存在或不匹配当前菜谱")
    if exc.code in {
        "food_plan_item_already_completed",
        "food_plan_item_stale",
        "food_plan_targets_changed",
        "food_plan_food_mismatch",
        "food_plan_item_not_planned",
    }:
        return AIConflictError(str(exc.message or exc))
    return AIConflictError(str(exc.message or exc))


def _require_inventory_boundaries(boundaries: list[Any]) -> tuple[dict[str, Any], ...]:
    """Hard-require inventory OCC boundary version fields on AI execute.

    Missing expected version fields would otherwise silently skip optimistic
    concurrency checks and weaken inventory OCC. Empty lists are allowed here
    for ingredient-less recipes; execute_recipe_cook_draft rejects empty
    boundaries when the recipe actually has ingredients.
    """
    normalized: list[dict[str, Any]] = []
    for item in boundaries:
        if not isinstance(item, dict):
            raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
        ingredient_version = item.get("expectedIngredientRowVersion")
        if ingredient_version is None:
            ingredient_version = item.get("expected_ingredient_row_version")
        if ingredient_version is None:
            raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
        batches = item.get("batches") or []
        if not isinstance(batches, list):
            raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
        for batch in batches:
            if not isinstance(batch, dict):
                raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
            item_version = batch.get("expectedRowVersion")
            if item_version is None:
                item_version = batch.get("expected_row_version")
            if item_version is None:
                raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
            inventory_item_id = batch.get("inventoryItemId") or batch.get("inventory_item_id")
            if not inventory_item_id:
                raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
        normalized.append(item)
    return tuple(normalized)


def recipe_cook_command_from_ai_payload(
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    completion_request_id: str,
) -> RecipeCookCompletionCommand:
    recipe_id = str(payload.get("recipeId") or payload.get("recipe_id") or "")
    if not recipe_id:
        raise AIConflictError("菜谱不存在或已被删除")

    cook_date_raw = payload.get("date")
    if cook_date_raw:
        cook_date = date.fromisoformat(str(cook_date_raw))
    else:
        cook_date = today_for_family(family_id)

    meal_type_raw = payload.get("mealType") or payload.get("meal_type") or MealType.DINNER.value
    meal_type = meal_type_raw if isinstance(meal_type_raw, MealType) else MealType(str(meal_type_raw))

    participant_ids = payload.get("participantUserIds") or payload.get("participant_user_ids") or []
    if not isinstance(participant_ids, list):
        participant_ids = []
    participants = tuple(str(item) for item in participant_ids if str(item).strip())
    if not participants:
        participants = (user_id,)

    plan_item_id = payload.get("planItemId") or payload.get("food_plan_item_id")
    plan_item_id = str(plan_item_id) if plan_item_id else None

    boundaries = payload.get("inventoryBoundaries")
    if boundaries is None:
        boundaries = []
    preview_items = payload.get("previewItems") or []
    shortages = payload.get("shortages") or []
    if not isinstance(boundaries, list) or not isinstance(preview_items, list) or not isinstance(shortages, list):
        raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")

    inventory_expectation = RecipeCookInventoryExpectation(
        ingredient_boundaries=_require_inventory_boundaries(boundaries),
        preview_items=tuple(item for item in preview_items if isinstance(item, dict)),
        shortages=tuple(item for item in shortages if isinstance(item, dict)),
    )

    recipe_base_updated_at = _parse_optional_datetime(
        payload.get("baseUpdatedAt") if "baseUpdatedAt" in payload else payload.get("base_updated_at")
    )

    return RecipeCookCompletionCommand(
        completion_request_id=completion_request_id,
        family_id=family_id,
        actor_user_id=user_id,
        recipe_id=recipe_id,
        cook_date=cook_date,
        meal_type=meal_type,
        servings=Decimal(str(payload.get("servings"))),
        participant_user_ids=participants,
        notes=str(payload.get("notes") or ""),
        food_plan_item_id=plan_item_id,
        food_plan_item_base_updated_at=_parse_optional_datetime(payload.get("planItemBaseUpdatedAt")),
        result_note=str(payload.get("resultNote") or payload.get("result_note") or "").strip(),
        adjustments=str(payload.get("adjustments") or "").strip(),
        rating=payload.get("rating"),
        allow_partial_inventory_deduction=False,
        inventory_expectation=inventory_expectation,
        recipe_base_updated_at=recipe_base_updated_at,
    )


def execute_recipe_cook_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    operation_idempotency_key: str,
) -> tuple[dict[str, Any], list[str]]:
    schema_version = require_recipe_cook_schema_version(payload)

    recipe = db.scalar(
        select(Recipe).where(Recipe.family_id == family_id, Recipe.id == str(payload.get("recipeId") or ""))
    )
    if recipe is None:
        raise AIConflictError("菜谱不存在或已被删除")
    # Soft pre-check for early conflict messaging; hard re-check happens after
    # FOR UPDATE inside lock_recipe_for_completion via recipe_base_updated_at.
    base_updated_at = payload.get("baseUpdatedAt")
    if base_updated_at:
        assert_updated_at_matches(
            actual=recipe.updated_at,
            expected=str(base_updated_at),
            label=f"菜谱 {recipe.title}",
        )

    command = recipe_cook_command_from_ai_payload(
        family_id=family_id,
        user_id=user_id,
        payload=payload,
        completion_request_id=operation_idempotency_key,
    )
    # Recipes with ingredients must carry non-empty OCC boundaries on AI execute.
    from sqlalchemy import func

    from app.models.domain import RecipeIngredient

    ingredient_count = int(
        db.scalar(
            select(func.count())
            .select_from(RecipeIngredient)
            .where(RecipeIngredient.recipe_id == recipe.id)
        )
        or 0
    )
    if ingredient_count > 0 and (
        command.inventory_expectation is None
        or not command.inventory_expectation.ingredient_boundaries
    ):
        raise AIConflictError("做菜草稿缺少库存并发校验信息，请重新生成后确认")
    try:
        result = complete_recipe_cook(db, command)
    except CompletionConflict as exc:
        raise _map_completion_conflict(exc) from exc
    except FoodPlanConflict as exc:
        raise _map_food_plan_conflict(exc) from exc
    except MealLogReferenceError as exc:
        raise AIConflictError(str(exc)) from exc
    except (InventoryConflictError, StaleDataError) as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc

    if not result.meal_log_id or not result.cook_log_id:
        raise AIConflictError(SHORTAGE_CONFLICT_MESSAGE)

    logger.info("ai_recipe_cook event=executed version=%s", schema_version)
    response = result.model_dump(mode="json")
    response["title"] = str(payload.get("title") or recipe.title or "")
    response["plan_item_id"] = command.food_plan_item_id
    cook_log = db.get(RecipeCookLog, result.cook_log_id)
    response["cook_log"] = serialize_recipe_cook_log(cook_log) if cook_log is not None else None
    return response, [result.cook_log_id]
