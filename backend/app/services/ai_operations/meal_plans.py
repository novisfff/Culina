from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, MealType
from app.core.utils import create_id, utcnow
from app.models.domain import Food, FoodPlanItem
from app.services.activity import log_activity
from app.services.serializers import serialize_food_plan_item


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


def execute_meal_plan_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> tuple[dict[str, Any], list[str]]:
    if isinstance(payload.get("operations"), list):
        return _apply_meal_plan_operations(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    return _create_meal_plan_items_from_payload(db, family_id=family_id, user_id=user_id, payload=payload)


def _apply_meal_plan_operations(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> tuple[dict[str, Any], list[str]]:
    results: list[dict[str, Any]] = []
    entity_ids: list[str] = []
    for operation in payload.get("operations") or []:
        action = str(operation.get("action") or "")
        if action == "create":
            result, ids = _create_meal_plan_items_from_payload(
                db,
                family_id=family_id,
                user_id=user_id,
                payload={"items": [operation.get("payload") or {}]},
            )
            created_item = (result.get("items") or [None])[0]
            results.append({"operationId": operation.get("operationId"), "action": "create", "item": created_item})
            entity_ids.extend(ids)
            continue
        item = db.scalar(
            select(FoodPlanItem)
            .options(selectinload(FoodPlanItem.food))
            .where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.user_id == user_id,
                FoodPlanItem.id == str(operation["targetId"]),
            )
            .with_for_update()
        )
        if item is None:
            raise AIConflictError("餐食计划不存在或已被删除")
        label = item.food.name if item.food is not None else "计划项"
        assert_updated_at_matches(
            actual=item.updated_at,
            expected=str(operation["baseUpdatedAt"]),
            label=f"餐食计划 {label}",
        )
        if action == "delete":
            snapshot = serialize_food_plan_item(item)
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
            results.append({"operationId": operation.get("operationId"), "action": "delete", "item": snapshot})
            entity_ids.append(item.id)
            continue
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
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="FoodPlanItem",
                entity_id=item.id,
                summary=f"AI 将菜单计划 {label} 标记为 {next_status}",
            )
            results.append({"operationId": operation.get("operationId"), "action": "set_status", "item": serialize_food_plan_item(item)})
            entity_ids.append(item.id)
            continue
        item_payload = operation.get("payload") or {}
        food = db.scalar(select(Food).where(Food.id == str(item_payload["foodId"]), Food.family_id == family_id))
        if food is None:
            raise ValueError("草稿包含不属于当前家庭的食物")
        item.food_id = food.id
        item.food = food
        item.plan_date = date.fromisoformat(str(item_payload["date"]))
        item.meal_type = MealType(str(item_payload["mealType"]))
        item.note = str(item_payload.get("reason") or "")
        item.updated_by = user_id
        db.flush()
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="FoodPlanItem",
            entity_id=item.id,
            summary=f"AI 更新菜单计划 {food.name}",
        )
        results.append({"operationId": operation.get("operationId"), "action": "update", "item": serialize_food_plan_item(item)})
        entity_ids.append(item.id)
    return {"operations": results}, list(dict.fromkeys(entity_ids))


def _create_meal_plan_items_from_payload(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    created: list[FoodPlanItem] = []
    for item_payload in payload.get("items") or []:
        food_id = item_payload.get("foodId")
        if not food_id:
            raise ValueError("餐食计划草稿必须引用食物库里的食物")
        food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
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
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="FoodPlanItem",
            entity_id=item.id,
            summary=f"AI 加入菜单计划 {item.food.name if item.food else '食物'}",
        )
    return {"items": [serialize_food_plan_item(item) for item in created]}, [item.id for item in created]


def _operation_error_message(operation: dict[str, Any], exc: Exception) -> str:
    operation_id = str(operation.get("operationId") or "").strip() or "unknown"
    return f"操作 {operation_id} 失败：{exc}"
