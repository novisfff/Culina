from __future__ import annotations

from typing import Any

from app.ai.tools.draft_validation import (
    normalize_meal_log_draft,
    normalize_meal_plan_draft,
    normalize_shopping_list_draft,
)
from app.services.ai_operations.meal_logs import execute_meal_log_draft
from app.services.ai_operations.meal_plans import execute_meal_plan_draft
from app.services.ai_operations.recovery_loaders import (
    load_meal_log_current_value,
    load_meal_plan_current_value,
    load_shopping_list_current_value,
)
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftResultMetadata,
)
from app.services.ai_operations.shopping import execute_shopping_list_draft
from app.services.ai_operations.draft_specs.common import (
    _base_config,
    _build_operation_copy,
    _spec,
    _validate_operation_list_value,
)
from app.ai.workflows.runner_support.attachments import validate_submitted_attachment_subset


def _meal_log_media_ids(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []
    meal_payload = payload.get("payload") if payload.get("action") in {"create", "update_details"} else payload
    if not isinstance(meal_payload, dict):
        return []
    return [str(media_id) for media_id in meal_payload.get("mediaIds") or []]


def _validate_meal_log_approval_value(original: Any, submitted: Any) -> None:
    validate_submitted_attachment_subset(
        original_media_ids=_meal_log_media_ids(original),
        submitted_media_ids=_meal_log_media_ids(submitted),
    )


def _approval_config_for_meal_plan(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("meal_plan")
    if isinstance(payload.get("operations"), list):
        config.update(
            {
                "approval_type": "meal_plan.apply",
                "operation_type": "meal_plan.apply",
                **_build_operation_copy(
                    create_title="确认添加餐食计划",
                    update_title="确认修改餐食计划",
                    apply_title="确认应用餐食计划变更",
                    mixed_noun="计划调整",
                    create_instruction="确认后会把这些计划项加入你的菜单计划。未关联食物的条目会先创建可编辑的食物资料。",
                    update_instruction="确认后会按草稿修改你的菜单计划状态、日期或内容。",
                    apply_instruction="确认后会按草稿创建、修改或删除你的餐食计划。",
                    create_approve_label="添加计划",
                    update_approve_label="修改计划",
                    apply_approve_label="应用计划变更",
                    payload=payload,
                ),
            }
        )
    return config


def _approval_config_for_shopping_list(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("shopping_list")
    if isinstance(payload.get("operations"), list):
        config.update(
            {
                "approval_type": "shopping_list.apply",
                "operation_type": "shopping_list.apply",
                **_build_operation_copy(
                    create_title="确认添加购物清单",
                    update_title="确认修改购物清单",
                    apply_title="确认应用购物清单变更",
                    mixed_noun="清单调整",
                    create_instruction="确认后会把这些项目加入购物清单。",
                    update_instruction="确认后会按草稿修改待买数量、备注或完成状态。",
                    apply_instruction="确认后会按草稿创建、修改或删除购物清单项目。",
                    create_approve_label="添加清单",
                    update_approve_label="修改清单",
                    apply_approve_label="应用清单变更",
                    payload=payload,
                ),
            }
        )
    return config


def _approval_config_for_meal_log(payload: dict[str, Any]) -> dict[str, str]:
    config = _base_config("meal_log")
    action = str(payload.get("action") or "create")
    if action == "update_details":
        config.update(
            {
                "approval_type": "meal_log.update",
                "operation_type": "meal_log.update",
                "title": "确认补充餐食记录",
                "instruction": "确认后会更新参与人、备注、心情和媒体。",
                "approve_label": "更新记录",
                "reject_label": "暂不更新",
            }
        )
    elif action == "rate_food":
        config.update(
            {
                "approval_type": "meal_log.rate_food",
                "operation_type": "meal_log.rate_food",
                "title": "确认更新食物评分",
                "instruction": "确认后会更新这条餐食记录里的食物评分。",
                "approve_label": "更新评分",
                "reject_label": "暂不更新",
            }
        )
    return config


def _normalize_shopping_list(context: DraftNormalizeContext) -> dict[str, Any]:
    return normalize_shopping_list_draft(
        context.db,
        family_id=context.family_id,
        conversation_id=context.conversation_id,
        payload=context.payload,
    )


def _normalize_meal_plan(context: DraftNormalizeContext) -> dict[str, Any]:
    return normalize_meal_plan_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
    )


def _normalize_meal_log(context: DraftNormalizeContext) -> dict[str, Any]:
    return normalize_meal_log_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        phase=context.phase,
    )


def _execute_shopping_list(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    return execute_shopping_list_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )


def _execute_meal_plan(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    return execute_meal_plan_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )


def _execute_meal_log(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    return execute_meal_log_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
    )


def _preview_shopping_list(payload: dict[str, Any]) -> str:
    if payload.get("operations"):
        return f"{len(payload.get('operations') or [])} 个购物清单操作"
    return f"{len(payload.get('items') or [])} 个待采购项"


def _preview_meal_plan(payload: dict[str, Any]) -> str:
    if payload.get("operations"):
        return f"{len(payload.get('operations') or [])} 个餐食计划操作"
    return f"{len(payload.get('items') or [])} 条计划项"


def _preview_meal_log(payload: dict[str, Any]) -> str:
    if payload.get("action"):
        before = payload.get("before") if isinstance(payload.get("before"), dict) else {}
        action = str(payload.get("action") or "create")
        action_label = {"create": "创建", "update_details": "补充", "rate_food": "评分"}.get(action, "处理")
        label = before.get("date") or payload.get("targetId") or payload.get("date")
        return f"{action_label}餐食记录 · {label}"
    return f"{payload.get('date')} · {payload.get('mealType')} · {len(payload.get('foods') or [])} 个食物项"


def planning_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "shopping_list",
            normalize=_normalize_shopping_list,
            execute=_execute_shopping_list,
            approval_config=_approval_config_for_shopping_list,
            preview_summary=_preview_shopping_list,
            validate_approval_value=_validate_operation_list_value,
            result_metadata=DraftResultMetadata(
                workspace_label="购物清单",
                count_noun="项采购",
                fallback_label="采购项",
                recovery_hint="可以直接修改下面的草稿后重试；如果当前对象已不符合预期，也可以重新生成一版操作草稿。",
            ),
            load_current_value=load_shopping_list_current_value,
        ),
        _spec(
            "meal_plan",
            normalize=_normalize_meal_plan,
            execute=_execute_meal_plan,
            approval_config=_approval_config_for_meal_plan,
            preview_summary=_preview_meal_plan,
            validate_approval_value=_validate_operation_list_value,
            result_metadata=DraftResultMetadata(
                workspace_label="菜单计划",
                count_noun="条计划",
                fallback_label="菜单计划",
                recovery_hint="可以直接修改下面的草稿后重试；如果当前对象已不符合预期，也可以重新生成一版操作草稿。",
            ),
            load_current_value=load_meal_plan_current_value,
        ),
        _spec(
            "meal_log",
            normalize=_normalize_meal_log,
            execute=_execute_meal_log,
            approval_config=_approval_config_for_meal_log,
            preview_summary=_preview_meal_log,
            validate_approval_value=_validate_meal_log_approval_value,
            result_metadata=DraftResultMetadata(
                workspace_label="餐食记录",
                count_noun="条餐食记录",
                fallback_label="餐食记录",
            ),
            load_current_value=load_meal_log_current_value,
        ),
    ]
