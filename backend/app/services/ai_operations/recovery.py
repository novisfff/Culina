from __future__ import annotations

import re
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import Food, FoodPlanItem, Ingredient, MealLog, MealLogFood, Recipe, ShoppingListItem
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import (
    serialize_food,
    serialize_food_plan_item,
    serialize_ingredient,
    serialize_meal_log,
    serialize_recipe,
    serialize_shopping_item,
)


def build_failure_summary(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    payload: dict[str, Any],
    error_message: str,
) -> dict[str, Any]:
    summary: dict[str, Any] = {"errorMessage": error_message}
    operations = payload.get("operations")
    if not isinstance(operations, list):
        return summary
    failed_operation_id = extract_failed_operation_id(error_message)
    selected = [
        operation
        for operation in operations
        if isinstance(operation, dict)
        and (failed_operation_id is None or str(operation.get("operationId") or "") == failed_operation_id)
    ]
    if not selected and failed_operation_id:
        selected = [{"operationId": failed_operation_id}]
    if not selected:
        return summary
    summary["failedOperationIds"] = [
        str(operation.get("operationId") or "")
        for operation in selected
        if str(operation.get("operationId") or "").strip()
    ]
    summary["failedOperationSummaries"] = [
        operation_failure_record(
            db,
            family_id=family_id,
            draft_type=draft_type,
            operation=operation,
            error_message=error_message,
        )
        for operation in selected
    ]
    return summary


def extract_failed_operation_id(error_message: str) -> str | None:
    match = re.search(r"操作\s+([A-Za-z0-9_-]+)\s+失败", error_message)
    return match.group(1) if match else None


def operation_failure_record(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    operation: dict[str, Any],
    error_message: str,
) -> dict[str, Any]:
    payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
    before = operation.get("before") if isinstance(operation.get("before"), dict) else {}
    title = (
        payload.get("title")
        or payload.get("name")
        or before.get("title")
        or before.get("food_name")
        or before.get("name")
        or operation.get("targetId")
        or "未命名对象"
    )
    action = str(operation.get("action") or "")
    action_label = {
        "create": "新增",
        "update": "更新",
        "delete": "删除",
        "set_status": "状态变更",
        "set_done": "状态变更",
    }.get(action, action or "操作")
    has_conflict = "冲突" in error_message or "更新" in error_message or "baseUpdatedAt" in error_message
    current_value = load_operation_current_value(
        db,
        family_id=family_id,
        draft_type=draft_type,
        target_id=str(operation.get("targetId") or ""),
    )
    return {
        "operationId": operation.get("operationId"),
        "action": action,
        "targetId": operation.get("targetId"),
        "summary": f"{action_label} {title}",
        "currentValue": jsonable_encoder(current_value) if current_value is not None else None,
        "recoveryHint": operation_recovery_hint(
            draft_type=draft_type,
            action=action,
            has_conflict=has_conflict,
            has_current_value=current_value is not None,
        ),
    }


def operation_recovery_hint(*, draft_type: str, action: str, has_conflict: bool, has_current_value: bool) -> str:
    if has_conflict and has_current_value:
        return "当前业务值已经变化，建议先核对下面的最新内容；如果只是时间或状态被别人改过，请按最新值调整草稿后重试。"
    if action == "delete":
        return "如果目标已经不存在，无需再次删除；可以直接放弃这条草稿，或重新整理剩余操作。"
    if draft_type in {"meal_plan", "shopping_list"}:
        return "可以直接修改下面的草稿后重试；如果当前对象已不符合预期，也可以重新生成一版操作草稿。"
    return "可以根据当前业务值调整草稿后重试；如果变更范围已经不适合当前草稿，建议重新生成。"


def load_operation_current_value(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    target_id: str,
) -> dict[str, Any] | None:
    if not target_id:
        return None
    if draft_type == "meal_plan":
        item = db.scalar(
            select(FoodPlanItem)
            .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
            .where(FoodPlanItem.family_id == family_id, FoodPlanItem.id == target_id)
        )
        if item is None:
            return {"id": target_id, "label": "当前计划已不存在", "summary": "该计划可能已被删除或移出当前范围", "payload": None}
        payload = serialize_food_plan_item(item)
        return {
            "id": item.id,
            "label": payload.get("food_name") or "当前计划",
            "summary": " · ".join(
                [
                    str(payload.get("plan_date") or ""),
                    str(payload.get("meal_type") or ""),
                    str(payload.get("status") or ""),
                ]
            ).strip(" · "),
            "payload": payload,
        }
    if draft_type == "shopping_list":
        item = db.scalar(select(ShoppingListItem).where(ShoppingListItem.family_id == family_id, ShoppingListItem.id == target_id))
        if item is None:
            return {"id": target_id, "label": "当前购物项已不存在", "summary": "该购物项可能已被删除", "payload": None}
        payload = serialize_shopping_item(item)
        status = "已完成" if payload.get("done") else "待购买"
        return {
            "id": item.id,
            "label": str(payload.get("title") or "当前购物项"),
            "summary": f"{payload.get('quantity')} {payload.get('unit')} · {status}",
            "payload": payload,
        }
    if draft_type == "meal_log":
        item = db.scalar(
            select(MealLog)
            .where(MealLog.family_id == family_id, MealLog.id == target_id)
            .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
        )
        if item is None:
            return {"id": target_id, "label": "当前餐食记录已不存在", "summary": "该记录可能已被删除", "payload": None}
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="meal_log", entity_ids=[item.id]))
        payload = serialize_meal_log(item, media_map)
        return {
            "id": item.id,
            "label": "当前餐食记录",
            "summary": " · ".join([str(payload.get("date") or ""), str(payload.get("meal_type") or ""), str(len(payload.get("foods") or [])) + " 项食物"]),
            "payload": payload,
        }
    if draft_type == "food_profile":
        item = db.scalar(select(Food).where(Food.family_id == family_id, Food.id == target_id))
        if item is None:
            return {"id": target_id, "label": "当前食物资料已不存在", "summary": "该食物可能已被删除", "payload": None}
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="food", entity_ids=[item.id]))
        payload = serialize_food(item, media_map)
        return {
            "id": item.id,
            "label": str(payload.get("name") or "当前食物"),
            "summary": " · ".join([str(payload.get("type") or ""), str(payload.get("category") or "")]).strip(" · "),
            "payload": payload,
        }
    if draft_type == "ingredient_profile":
        item = db.scalar(select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id == target_id))
        if item is None:
            return {"id": target_id, "label": "当前食材档案已不存在", "summary": "该食材可能已被删除", "payload": None}
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="ingredient", entity_ids=[item.id]))
        payload = serialize_ingredient(item, media_map)
        return {
            "id": item.id,
            "label": str(payload.get("name") or "当前食材"),
            "summary": " · ".join([str(payload.get("category") or ""), str(payload.get("default_unit") or "")]).strip(" · "),
            "payload": payload,
        }
    if draft_type == "recipe":
        item = db.scalar(
            select(Recipe)
            .where(Recipe.family_id == family_id, Recipe.id == target_id)
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
        )
        if item is None:
            return {"id": target_id, "label": "当前菜谱已不存在", "summary": "该菜谱可能已被删除", "payload": None}
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="recipe", entity_ids=[item.id]))
        payload = serialize_recipe(item, media_map)
        return {
            "id": item.id,
            "label": str(payload.get("title") or "当前菜谱"),
            "summary": " · ".join([f"{payload.get('servings')} 人份", f"{payload.get('prep_minutes')} 分钟"]),
            "payload": payload,
        }
    return None
