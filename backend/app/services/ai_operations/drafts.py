from __future__ import annotations

from collections import Counter
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.ai.tools.draft_validation import (
    normalize_food_profile_draft_for_tools,
    normalize_ingredient_profile_draft,
    normalize_inventory_operation_draft,
    normalize_meal_log_draft,
    normalize_meal_plan_draft,
    normalize_recipe_cook_draft,
    normalize_recipe_draft_for_tools,
    normalize_shopping_list_draft,
)
from app.services.ai_operations.composite import normalize_composite_operation_draft


def normalize_ai_draft_payload(
    db: Session,
    *,
    draft_type: str,
    family_id: str,
    user_id: str,
    conversation_id: str,
    payload: Any,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("草稿内容格式不正确")
    if draft_type == "recipe":
        try:
            recipe = normalize_recipe_draft_for_tools(db, family_id=family_id, payload=payload)
        except ValidationError as exc:
            raise ValueError("菜谱草稿字段不完整或格式不正确") from exc
        return recipe
    if draft_type == "recipe_cook":
        try:
            return normalize_recipe_cook_draft(
                db,
                family_id=family_id,
                user_id=user_id,
                payload=payload,
            )
        except ValidationError as exc:
            raise ValueError("做菜草稿字段不完整或格式不正确") from exc
    if draft_type == "shopping_list":
        return normalize_shopping_list_draft(db, family_id=family_id, conversation_id=conversation_id, payload=payload)
    if draft_type == "meal_plan":
        return normalize_meal_plan_draft(db, family_id=family_id, user_id=user_id, payload=payload)
    if draft_type == "meal_log":
        return normalize_meal_log_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
        )
    if draft_type == "food_profile":
        try:
            return normalize_food_profile_draft_for_tools(db, family_id=family_id, payload=payload)
        except ValidationError as exc:
            raise ValueError("食物资料草稿字段不完整或格式不正确") from exc
    if draft_type == "ingredient_profile":
        try:
            return normalize_ingredient_profile_draft(db, family_id=family_id, payload=payload)
        except ValidationError as exc:
            raise ValueError("食材档案草稿字段不完整或格式不正确") from exc
    if draft_type == "inventory_operation":
        return normalize_inventory_operation_draft(db, family_id=family_id, payload=payload)
    if draft_type == "composite_operation":
        return normalize_composite_operation_draft(payload)
    raise ValueError("暂不支持的草稿类型")


def validate_inventory_operation_shape(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("库存操作草稿格式不正确")
    original_operations = original.get("operations")
    submitted_operations = submitted.get("operations")
    if not isinstance(original_operations, list) or not isinstance(submitted_operations, list):
        raise ValueError("库存操作草稿格式不正确")

    def operation_key(operation: Any) -> tuple[str, str]:
        if not isinstance(operation, dict):
            return ("", "")
        return (
            str(operation.get("ingredientId") or operation.get("ingredient_id") or ""),
            str(operation.get("action") or ""),
        )

    allowed = Counter(operation_key(operation) for operation in original_operations)
    requested = Counter(operation_key(operation) for operation in submitted_operations)
    if any(not ingredient_id or not action for ingredient_id, action in requested):
        raise ValueError("库存操作项格式不正确")
    if any(count > allowed.get(key, 0) for key, count in requested.items()):
        raise ValueError("库存处理对象或处理方式不能在确认阶段修改")


def validate_operation_draft_shape(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("操作草稿格式不正确")
    if not isinstance(original.get("operations"), list) or not isinstance(submitted.get("operations"), list):
        return

    def operation_key(operation: Any) -> tuple[str, str, str]:
        if not isinstance(operation, dict):
            return ("", "", "")
        return (
            str(operation.get("action") or ""),
            str(operation.get("targetId") or ""),
            str(operation.get("baseUpdatedAt") or ""),
        )

    allowed = Counter(operation_key(operation) for operation in original["operations"])
    requested = Counter(operation_key(operation) for operation in submitted["operations"])
    if any(not action for action, _, _ in requested):
        raise ValueError("操作草稿项格式不正确")
    if any(count > allowed.get(key, 0) for key, count in requested.items()):
        raise ValueError("确认阶段不能修改操作类型、目标或版本基线")


def validate_single_target_operation_shape(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("操作草稿格式不正确")
    for key in ("action", "targetId", "baseUpdatedAt"):
        if str(original.get(key) or "") != str(submitted.get(key) or ""):
            raise ValueError("确认阶段不能修改操作类型、目标或版本基线")


def draft_preview_summary(draft_type: str, payload: dict[str, Any]) -> str:
    if draft_type == "recipe":
        if payload.get("action"):
            action = str(payload.get("action") or "create")
            if action == "create":
                recipe_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
                return f"创建菜谱 · {recipe_payload.get('title') or '未命名菜谱'}"
            before = payload.get("before") if isinstance(payload.get("before"), dict) else {}
            action_label = {"update": "更新", "delete": "删除", "set_favorite": "收藏"}.get(action, "处理")
            return f"{action_label}菜谱 · {before.get('title') or payload.get('targetId') or '菜谱'}"
        return f"{payload['title']} · {len(payload['ingredient_items'])} 个食材 · {len(payload['steps'])} 个步骤"
    if draft_type == "recipe_cook":
        shortages = payload.get("shortages") or []
        suffix = " · 库存不足" if shortages else ""
        return f"做菜 · {payload.get('title') or '菜谱'} · {payload.get('servings')} 份{suffix}"
    if draft_type == "shopping_list":
        if payload.get("operations"):
            return f"{len(payload.get('operations') or [])} 个购物清单操作"
        return f"{len(payload.get('items') or [])} 个待采购项"
    if draft_type == "meal_plan":
        if payload.get("operations"):
            return f"{len(payload.get('operations') or [])} 个餐食计划操作"
        return f"{len(payload.get('items') or [])} 条计划项"
    if draft_type == "meal_log":
        if payload.get("action"):
            before = payload.get("before") if isinstance(payload.get("before"), dict) else {}
            action = str(payload.get("action") or "create")
            action_label = {"create": "创建", "update_details": "补充", "rate_food": "评分"}.get(action, "处理")
            label = before.get("date") or payload.get("targetId") or payload.get("date")
            return f"{action_label}餐食记录 · {label}"
        return f"{payload.get('date')} · {payload.get('mealType')} · {len(payload.get('foods') or [])} 个食物项"
    if draft_type == "food_profile":
        if payload.get("action"):
            action = str(payload.get("action") or "create")
            item_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
            label = item_payload.get("name") or payload.get("targetId") or "食物资料"
            action_label = {"create": "创建", "update": "更新", "set_favorite": "收藏"}.get(action, "处理")
            return f"{action_label}食物 · {label}"
        return f"{payload.get('name')} · {payload.get('category')}"
    if draft_type == "ingredient_profile":
        if isinstance(payload.get("operations"), list):
            return f"创建 {len(payload.get('operations') or [])} 个食材"
        action = "更新" if payload.get("action") == "update" else "创建"
        item_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        return f"{action}食材 · {item_payload.get('name') or '未命名食材'}"
    if draft_type == "inventory_operation":
        operations = payload.get("operations") or []
        labels = {"restock": "入库", "consume": "消耗", "dispose": "销毁"}
        counts: dict[str, int] = {}
        for operation in operations:
            action = labels.get(str(operation.get("action") or ""), "处理")
            counts[action] = counts.get(action, 0) + 1
        detail = " · ".join(f"{label} {count} 项" for label, count in counts.items())
        return f"{len(operations)} 项库存处理" + (f" · {detail}" if detail else "")
    if draft_type == "composite_operation":
        steps = payload.get("steps") or []
        return f"{len(steps)} 步复合操作"
    return "AI 草稿"
