from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.ai.tools.draft_validation import normalize_recipe_cook_draft, normalize_recipe_draft_for_tools
from app.core.enums import ActivityHighlightKind
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.activity import ActivityHighlight
from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft
from app.services.ai_operations.recipes import execute_recipe_draft
from app.services.ai_operations.recovery_loaders import load_recipe_current_value
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftHighlightContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftPostExecuteContext,
    DraftResultMetadata,
    default_business_entity_records as _default_business_entity_records,
)
from app.services.serializers import serialize_recipe
from app.services.ai_operations.draft_specs.common import _base_config, _spec, _validate_single_target_operation_value
from app.ai.workflows.runner_support.attachments import validate_submitted_attachment_subset


RECIPE_COOK_APPROVAL_PROTECTED_FIELDS = (
    "draftType",
    "schemaVersion",
    "recipeId",
    "title",
    "baseUpdatedAt",
    "before",
    "servings",
    "participantUserIds",
    "planItemId",
    "planItemBaseUpdatedAt",
    "previewItems",
    "shortages",
    "inventoryBoundaries",
)


def _recipe_media_ids(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []
    recipe_payload = payload.get("payload") if payload.get("action") in {"create", "update"} else payload
    if not isinstance(recipe_payload, dict):
        return []
    return [str(media_id) for media_id in recipe_payload.get("media_ids") or []]


def _validate_recipe_approval_value(original: Any, submitted: Any) -> None:
    _validate_single_target_operation_value(original, submitted)
    validate_submitted_attachment_subset(
        original_media_ids=_recipe_media_ids(original),
        submitted_media_ids=_recipe_media_ids(submitted),
    )


def _validate_recipe_cook_approval_value(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("做菜草稿格式不正确")
    if any(original.get(field) != submitted.get(field) for field in RECIPE_COOK_APPROVAL_PROTECTED_FIELDS):
        raise ValueError("菜谱目标、份数、关联计划或库存预览不能在确认阶段修改，请重新生成做菜草稿")


def _approval_config_for_recipe(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("recipe")
    action = str(payload.get("action") or "create")
    if action == "update":
        config.update(
            {
                "value_key": "draft",
                "widget": "textarea",
                "approval_type": "recipe.update",
                "operation_type": "recipe.update",
                "title": "确认更新菜谱",
                "instruction": "确认后会更新当前家庭的菜谱资料，并同步关联家常菜。",
                "approve_label": "更新菜谱",
                "reject_label": "暂不更新",
            }
        )
    elif action == "delete":
        config.update(
            {
                "value_key": "draft",
                "widget": "textarea",
                "approval_type": "recipe.delete",
                "operation_type": "recipe.delete",
                "title": "确认删除菜谱",
                "instruction": "确认后会删除菜谱，并按现有业务规则处理同步食物和媒体绑定。",
                "approve_label": "删除菜谱",
                "reject_label": "暂不删除",
            }
        )
    elif action == "set_favorite":
        favorite = bool((payload.get("payload") or {}).get("favorite"))
        config.update(
            {
                "value_key": "draft",
                "widget": "textarea",
                "approval_type": "recipe.favorite",
                "operation_type": "recipe.favorite",
                "title": "确认更新菜谱收藏状态",
                "instruction": f"确认后会将该菜谱{'加入' if favorite else '移出'}收藏。",
                "approve_label": "确认更新收藏",
                "reject_label": "暂不更新",
            }
        )
    return config


def _normalize_recipe(context: DraftNormalizeContext) -> dict[str, Any]:
    try:
        return normalize_recipe_draft_for_tools(context.db, family_id=context.family_id, payload=context.payload)
    except ValidationError as exc:
        raise ValueError("菜谱草稿字段不完整或格式不正确") from exc


def _normalize_recipe_cook(context: DraftNormalizeContext) -> dict[str, Any]:
    try:
        normalized = normalize_recipe_cook_draft(
            context.db,
            family_id=context.family_id,
            user_id=context.user_id,
            payload=context.payload,
        )
        if context.phase == "approval":
            for field in RECIPE_COOK_APPROVAL_PROTECTED_FIELDS:
                normalized[field] = context.payload.get(field)
        return normalized
    except ValidationError as exc:
        raise ValueError("做菜草稿字段不完整或格式不正确") from exc


def _execute_recipe(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    payload = context.payload
    if payload.get("action") == "delete":
        recipe_id = str(payload.get("targetId"))
        before = (payload.get("before") or {}) if isinstance(payload.get("before"), dict) else {}
        title = str(before.get("title") or "")
        execute_recipe_draft(
            context.db,
            family_id=context.family_id,
            user_id=context.user_id,
            payload=payload,
            assert_updated_at_matches=context.assert_updated_at_matches,
        )
        return {"id": recipe_id, "title": title, "deleted": True}, [recipe_id]
    recipe = execute_recipe_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="recipe",
            entity_ids=[recipe.id],
        )
    )
    return serialize_recipe(recipe, media_map), [recipe.id]


def _execute_recipe_cook(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    return execute_recipe_cook_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
    )


def _recipe_cook_business_entity_records(entity_payload: Any, entity_type: str) -> list[dict[str, Any]]:
    if (
        isinstance(entity_payload, dict)
        and entity_type == "RecipeCookLog"
        and isinstance(entity_payload.get("cook_log"), dict)
    ):
        return [entity_payload["cook_log"]]
    return _default_business_entity_records(entity_payload, entity_type)


def _preview_recipe(payload: dict[str, Any]) -> str:
    if payload.get("action"):
        action = str(payload.get("action") or "create")
        if action == "create":
            recipe_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
            return f"创建菜谱 · {recipe_payload.get('title') or '未命名菜谱'}"
        before = payload.get("before") if isinstance(payload.get("before"), dict) else {}
        action_label = {"update": "更新", "delete": "删除", "set_favorite": "收藏"}.get(action, "处理")
        return f"{action_label}菜谱 · {before.get('title') or payload.get('targetId') or '菜谱'}"
    return f"{payload['title']} · {len(payload['ingredient_items'])} 个食材 · {len(payload['steps'])} 个步骤"


def _preview_recipe_cook(payload: dict[str, Any]) -> str:
    shortages = payload.get("shortages") or []
    suffix = " · 库存不足" if shortages else ""
    return f"做菜 · {payload.get('title') or '菜谱'} · {payload.get('servings')} 份{suffix}"


def _classify_recipe_cook_highlight(context: DraftHighlightContext) -> ActivityHighlight | None:
    cook_log = context.business_entity.get("cook_log")
    meal_log = context.business_entity.get("meal_log")
    if not isinstance(cook_log, dict) and not isinstance(meal_log, dict):
        return None
    title = str(context.submitted_payload.get("title") or "一道菜").strip()
    return ActivityHighlight(
        kind=ActivityHighlightKind.MEAL,
        summary=f"完成 {title} 并记录用餐",
    )


def recipe_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "recipe",
            normalize=_normalize_recipe,
            execute=_execute_recipe,
            approval_config=_approval_config_for_recipe,
            preview_summary=_preview_recipe,
            validate_approval_value=_validate_recipe_approval_value,
            result_metadata=DraftResultMetadata(
                workspace_label="菜谱库",
                count_noun="个菜谱",
                fallback_label="菜谱",
            ),
            load_current_value=load_recipe_current_value,
        ),
        _spec(
            "recipe_cook",
            normalize=_normalize_recipe_cook,
            execute=_execute_recipe_cook,
            preview_summary=_preview_recipe_cook,
            validate_approval_value=_validate_recipe_cook_approval_value,
            highlight_classifier=_classify_recipe_cook_highlight,
            business_entity_records=_recipe_cook_business_entity_records,
            result_metadata=DraftResultMetadata(
                workspace_label="做菜记录",
                count_noun="条做菜记录",
                fallback_label="做菜记录",
                default_action="cook",
            ),
        ),
    ]
