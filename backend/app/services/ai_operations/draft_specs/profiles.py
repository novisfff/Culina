from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.ai.tools.draft_validation import normalize_food_profile_draft_for_tools, normalize_ingredient_profile_draft
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.ai_operations.foods import execute_food_profile_draft
from app.services.ai_operations.ingredients import execute_ingredient_profile_draft
from app.services.ai_operations.recovery_loaders import (
    load_food_profile_current_value,
    load_ingredient_profile_current_value,
)
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftResultMetadata,
)
from app.services.serializers import serialize_food, serialize_ingredient
from app.services.ai_operations.draft_specs.common import (
    _base_config,
    _spec,
    _validate_ingredient_profile_value,
)


def _approval_config_for_ingredient_profile(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("ingredient_profile")
    operations = payload.get("operations")
    if isinstance(operations, list):
        total = len(operations)
        config.update(
            {
                "approval_type": "ingredient.create",
                "operation_type": "ingredient.create",
                "title": f"确认创建 {total} 个食材档案",
                "instruction": "确认后会批量创建当前家庭的食材档案，不会登记库存数量。",
                "approve_label": "创建食材",
                "reject_label": "暂不创建",
            }
        )
        return config
    action = str(payload.get("action") or "create")
    if action == "update":
        config.update(
            {
                "approval_type": "ingredient.update",
                "operation_type": "ingredient.update",
                "title": "确认更新食材档案",
                "instruction": "确认后会更新当前家庭的食材档案。",
                "approve_label": "更新食材",
                "reject_label": "暂不更新",
            }
        )
    else:
        config.update(
            {
                "approval_type": "ingredient.create",
                "operation_type": "ingredient.create",
                "title": "确认创建食材档案",
                "instruction": "确认后会创建当前家庭的食材档案。",
                "approve_label": "创建食材",
                "reject_label": "暂不创建",
            }
        )
    return config


def _approval_config_for_food_profile(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("food_profile")
    action = str(payload.get("action") or "create")
    if action == "update":
        config.update(
            {
                "approval_type": "food.update",
                "operation_type": "food.update",
                "title": "确认更新食物资料",
                "instruction": "确认后会更新当前家庭的食物资料。",
                "approve_label": "更新食物",
                "reject_label": "暂不更新",
            }
        )
    elif action == "set_favorite":
        favorite = bool((payload.get("payload") or {}).get("favorite"))
        config.update(
            {
                "approval_type": "food.favorite",
                "operation_type": "food.favorite",
                "title": "确认更新收藏状态",
                "instruction": f"确认后会将该食物{'加入' if favorite else '移出'}收藏。",
                "approve_label": "确认更新收藏",
                "reject_label": "暂不更新",
            }
        )
    return config


def _normalize_food_profile(context: DraftNormalizeContext) -> dict[str, Any]:
    try:
        return normalize_food_profile_draft_for_tools(context.db, family_id=context.family_id, payload=context.payload)
    except ValidationError as exc:
        raise ValueError("食物资料草稿字段不完整或格式不正确") from exc


def _normalize_ingredient_profile(context: DraftNormalizeContext) -> dict[str, Any]:
    try:
        return normalize_ingredient_profile_draft(context.db, family_id=context.family_id, payload=context.payload)
    except ValidationError as exc:
        raise ValueError("食材档案草稿字段不完整或格式不正确") from exc


def _execute_food_profile(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    food = execute_food_profile_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )
    media_map = build_media_map(
        get_media_assets_for_entities(context.db, family_id=context.family_id, entity_type="food", entity_ids=[food.id])
    )
    return serialize_food(food, media_map), [food.id]


def _execute_ingredient_profile(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    ingredient_result = execute_ingredient_profile_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )
    if isinstance(ingredient_result, list):
        ingredient_ids = [ingredient.id for ingredient in ingredient_result]
        media_map = build_media_map(
            get_media_assets_for_entities(
                context.db,
                family_id=context.family_id,
                entity_type="ingredient",
                entity_ids=ingredient_ids,
            )
        )
        return {
            "items": [serialize_ingredient(ingredient, media_map) for ingredient in ingredient_result]
        }, ingredient_ids
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="ingredient",
            entity_ids=[ingredient_result.id],
        )
    )
    return serialize_ingredient(ingredient_result, media_map), [ingredient_result.id]


def _preview_food_profile(payload: dict[str, Any]) -> str:
    if payload.get("action"):
        action = str(payload.get("action") or "create")
        item_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        label = item_payload.get("name") or payload.get("targetId") or "食物资料"
        action_label = {"create": "创建", "update": "更新", "set_favorite": "收藏"}.get(action, "处理")
        return f"{action_label}食物 · {label}"
    return f"{payload.get('name')} · {payload.get('category')}"


def _preview_ingredient_profile(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("operations"), list):
        return f"创建 {len(payload.get('operations') or [])} 个食材"
    action = "更新" if payload.get("action") == "update" else "创建"
    item_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    return f"{action}食材 · {item_payload.get('name') or '未命名食材'}"


def profile_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "food_profile",
            normalize=_normalize_food_profile,
            execute=_execute_food_profile,
            approval_config=_approval_config_for_food_profile,
            preview_summary=_preview_food_profile,
            result_metadata=DraftResultMetadata(
                workspace_label="食物库",
                count_noun="个食物",
                fallback_label="食物",
            ),
            load_current_value=load_food_profile_current_value,
        ),
        _spec(
            "ingredient_profile",
            normalize=_normalize_ingredient_profile,
            execute=_execute_ingredient_profile,
            approval_config=_approval_config_for_ingredient_profile,
            preview_summary=_preview_ingredient_profile,
            validate_approval_value=_validate_ingredient_profile_value,
            result_metadata=DraftResultMetadata(
                workspace_label="食材库",
                count_noun="个食材",
                fallback_label="食材",
            ),
            load_current_value=load_ingredient_profile_current_value,
        ),
    ]
