from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, MealType
from app.core.utils import create_id, utcnow
from app.models.domain import FoodPlanItem
from app.services.activity import log_activity
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policy_types import DraftExecutionReceipt
from app.services.ai_operations.registry_types import DraftExecuteContext
from app.services.food_plan_locking import (
    FoodPlanConflict,
    LockedFoodPlanTargets,
    discover_food_plan_write_intents,
    lock_food_plan_write_intents,
)
from app.services.search.indexing import delete_search_document
from app.services.search.jobs import enqueue_search_index_job
from app.services.serializers import serialize_food_plan_item


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
_SIMPLE_PLAN_FIELDS = {"draftType", "schemaVersion", "items", "source"}
_SIMPLE_PLAN_ITEM_FIELDS = {
    "date",
    "mealType",
    "title",
    "foodId",
    "recipeId",
    "reason",
    "usedInventory",
    "missingIngredients",
    "missingIngredientItems",
    "source",
}


def _simple_plan_revert_eligible(
    payload: dict[str, Any],
    business_entity: dict[str, Any],
) -> bool:
    items = payload.get("items")
    created = business_entity.get("items")
    if (
        set(payload) != _SIMPLE_PLAN_FIELDS
        or payload.get("schemaVersion") != "meal_plan.v1"
        or payload.get("draftType") != "meal_plan"
        or not isinstance(payload.get("source"), dict)
        or not isinstance(items, list)
        or not items
        or len(items) > AUTO_EXECUTION_CATALOG["meal_plan.simple_create"].limits["items"]
        or not isinstance(created, list)
        or len(created) != len(items)
    ):
        return False
    keys: set[tuple[date, str, str]] = set()
    for item, persisted in zip(items, created, strict=True):
        if (
            not isinstance(item, dict)
            or set(item) != _SIMPLE_PLAN_ITEM_FIELDS
            or item.get("mealType") not in {member.value for member in MealType}
            or item.get("missingIngredients") != []
            or item.get("missingIngredientItems") != []
            or not isinstance(item.get("usedInventory"), list)
            or not isinstance(item.get("source"), dict)
            or not isinstance(persisted, dict)
        ):
            return False
        try:
            plan_date = date.fromisoformat(str(item.get("date")))
        except ValueError:
            return False
        food_id = str(item.get("foodId") or "")
        key = (plan_date, str(item["mealType"]), food_id)
        if not food_id or key in keys:
            return False
        keys.add(key)
        recipe_id = str(item.get("recipeId") or "") or None
        if (
            item.get("title") != persisted.get("food_name")
            or food_id != persisted.get("food_id")
            or recipe_id != persisted.get("recipe_id")
        ):
            return False
    return True


def execute_meal_plan_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    if isinstance(payload.get("operations"), list):
        return _apply_meal_plan_operations(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    return _create_meal_plan_items_from_payload(
        db,
        family_id=family_id,
        user_id=user_id,
        payload=payload,
        revert_capture=revert_capture,
    )


def _map_food_plan_conflict(exc: FoodPlanConflict) -> Exception:
    if exc.code in {
        "food_plan_item_not_found",
        "food_plan_targets_changed",
        "food_plan_item_stale",
        "food_plan_item_already_completed",
        "food_plan_food_mismatch",
    }:
        return AIConflictError(exc.message)
    return ValueError(exc.message)


def _apply_meal_plan_operations(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> tuple[dict[str, Any], list[str]]:
    operations = list(payload.get("operations") or [])
    try:
        intents = discover_food_plan_write_intents(
            db,
            family_id=family_id,
            user_id=user_id,
            operations=operations,
        )
        locked = lock_food_plan_write_intents(
            db,
            family_id=family_id,
            user_id=user_id,
            intents=intents,
        )
    except FoodPlanConflict as exc:
        raise _map_food_plan_conflict(exc) from exc

    results: list[dict[str, Any]] = []
    entity_ids: list[str] = []
    for operation in operations:
        try:
            result, ids = apply_locked_food_plan_operation(
                db,
                operation=operation,
                locked=locked,
                family_id=family_id,
                user_id=user_id,
                assert_updated_at_matches=assert_updated_at_matches,
            )
        except FoodPlanConflict as exc:
            raise _map_food_plan_conflict(exc) from exc
        results.append(result)
        entity_ids.extend(ids)
    return {"operations": results}, list(dict.fromkeys(entity_ids))


def apply_locked_food_plan_operation(
    db: Session,
    *,
    operation: dict[str, Any],
    locked: LockedFoodPlanTargets,
    family_id: str,
    user_id: str,
    assert_updated_at_matches: UpdatedAtValidator | None = None,
) -> tuple[dict[str, Any], list[str]]:
    del assert_updated_at_matches  # validated once during whole-request lock
    action = str(operation.get("action") or "")
    if action == "create":
        result, ids = _create_meal_plan_items_from_payload(
            db,
            family_id=family_id,
            user_id=user_id,
            payload={"items": [operation.get("payload") or {}]},
            locked=locked,
        )
        created_item = (result.get("items") or [None])[0]
        return {"operationId": operation.get("operationId"), "action": "create", "item": created_item}, ids

    item_id = str(operation.get("targetId") or "")
    item = locked.items_by_id.get(item_id)
    if item is None:
        raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
    if item.food_id in locked.foods_by_id:
        item.food = locked.foods_by_id[item.food_id]
    label = item.food.name if item.food is not None else "计划项"

    if action == "delete":
        snapshot = serialize_food_plan_item(item)
        delete_search_document(
            db,
            family_id=family_id,
            entity_type="meal_plan",
            entity_id=item.id,
            delete_vector=True,
        )
        db.delete(item)
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="FoodPlanItem",
            entity_id=item.id,
            summary=f"AI 删除菜单计划 {label}",
        )
        return {"operationId": operation.get("operationId"), "action": "delete", "item": snapshot}, [item.id]

    if action == "set_status":
        next_status = str((operation.get("payload") or {}).get("status") or "")
        if next_status not in {"planned", "cooked", "skipped"}:
            raise ValueError("餐食计划状态不正确")
        item.status = next_status
        item.completed_at = utcnow() if next_status == "cooked" else None
        if next_status != "cooked":
            item.meal_log_id = None
        item.updated_by = user_id
        db.flush()
        enqueue_search_index_job(
            db,
            family_id=family_id,
            user_id=user_id,
            entity_type="meal_plan",
            entity_id=item.id,
            target_name=label,
        )
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="FoodPlanItem",
            entity_id=item.id,
            summary=f"AI 将菜单计划 {label} 标记为 {next_status}",
        )
        return {
            "operationId": operation.get("operationId"),
            "action": "set_status",
            "item": serialize_food_plan_item(item),
        }, [item.id]

    item_payload = operation.get("payload") or {}
    food_id = str(item_payload["foodId"])
    food = locked.foods_by_id.get(food_id)
    if food is None:
        raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")
    item.food_id = food.id
    item.food = food
    item.plan_date = date.fromisoformat(str(item_payload["date"]))
    item.meal_type = MealType(str(item_payload["mealType"]))
    item.note = str(item_payload.get("reason") or "")
    item.updated_by = user_id
    db.flush()
    enqueue_search_index_job(
        db,
        family_id=family_id,
        user_id=user_id,
        entity_type="meal_plan",
        entity_id=item.id,
        target_name=food.name,
    )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="FoodPlanItem",
        entity_id=item.id,
        summary=f"AI 更新菜单计划 {food.name}",
    )
    return {
        "operationId": operation.get("operationId"),
        "action": "update",
        "item": serialize_food_plan_item(item),
    }, [item.id]


def _create_meal_plan_items_from_payload(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    locked: LockedFoodPlanTargets | None = None,
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    items_payload = list(payload.get("items") or [])
    if locked is None:
        operations = [{"action": "create", "payload": item_payload} for item_payload in items_payload]
        try:
            intents = discover_food_plan_write_intents(
                db,
                family_id=family_id,
                user_id=user_id,
                operations=operations,
            )
            locked = lock_food_plan_write_intents(
                db,
                family_id=family_id,
                user_id=user_id,
                intents=intents,
            )
        except FoodPlanConflict as exc:
            raise _map_food_plan_conflict(exc) from exc

    created: list[FoodPlanItem] = []
    for item_payload in items_payload:
        food_id = item_payload.get("foodId")
        if not food_id:
            raise ValueError("餐食计划草稿必须引用食物库里的食物")
        food = locked.foods_by_id.get(str(food_id))
        if food is None:
            raise ValueError("草稿包含不属于当前家庭的食物")
        item = FoodPlanItem(
            id=create_id("food-plan"),
            family_id=family_id,
            user_id=user_id,
            food_id=food.id,
            plan_date=date.fromisoformat(str(item_payload["date"])),
            meal_type=MealType(str(item_payload["mealType"])),
            note=str(item_payload.get("reason") or ""),
            created_by=user_id,
            updated_by=user_id,
        )
        item.food = food
        db.add(item)
        created.append(item)
    db.flush()
    for item in created:
        enqueue_search_index_job(
            db,
            family_id=family_id,
            user_id=user_id,
            entity_type="meal_plan",
            entity_id=item.id,
            target_name=item.food.name if item.food else "餐食计划",
        )
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="FoodPlanItem",
            entity_id=item.id,
            summary=f"AI 加入菜单计划 {item.food.name if item.food else '食物'}",
        )
    if revert_capture is not None and created:
        revert_capture.update(
            {
                "schema_version": 1,
                "items": [
                    {
                        "food_plan_item_id": item.id,
                        "after_row_version": int(item.row_version),
                    }
                    for item in sorted(created, key=lambda row: row.id)
                ],
            }
        )
    return {"items": [serialize_food_plan_item(item) for item in created]}, [item.id for item in created]


def execute_meal_plan_draft_receipt(context: DraftExecuteContext) -> DraftExecutionReceipt:
    revert_context: dict[str, Any] = {}
    business_entity, entity_ids = execute_meal_plan_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
        revert_capture=revert_context,
    )
    eligible = _simple_plan_revert_eligible(
        context.payload,
        business_entity,
    ) and bool(revert_context)
    return DraftExecutionReceipt(
        business_entity=business_entity,
        entity_ids=tuple(sorted(entity_ids)),
        cache_scopes=("meal_plan", "ai_conversation"),
        revert_adapter_key="meal_plan.simple_create.v1" if eligible else None,
        revert_context=revert_context if eligible else None,
    )


def _operation_error_message(operation: dict[str, Any], exc: Exception) -> str:
    operation_id = str(operation.get("operationId") or "").strip() or "unknown"
    return f"操作 {operation_id} 失败：{exc}"
