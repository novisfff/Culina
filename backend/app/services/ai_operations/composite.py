from __future__ import annotations

from collections import deque
import re
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.models.domain import InventoryItem
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.ai_operations.ingredients import execute_ingredient_profile_draft
from app.services.ai_operations.inventory import execute_inventory_operation_draft
from app.services.serializers import serialize_ingredient, serialize_inventory_item


COMPOSITE_OPERATION_SCHEMA_VERSION = "composite_operation.v1"
SUPPORTED_COMPOSITE_DOMAINS = {
    "ingredient",
    "inventory",
    "food",
    "recipe",
    "recipe_cook",
    "meal_plan",
    "shopping_list",
    "meal_log",
}
COMPOSITE_REFERENCE_RE = re.compile(r"^\$([A-Za-z0-9_-]+)\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)$")
COMPOSITE_DOMAIN_DRAFT_TYPES = {
    "ingredient": "ingredient_profile",
    "inventory": "inventory_operation",
    "food": "food_profile",
    "recipe": "recipe",
    "recipe_cook": "recipe_cook",
    "meal_plan": "meal_plan",
    "shopping_list": "shopping_list",
    "meal_log": "meal_log",
}
EXECUTABLE_COMPOSITE_DOMAINS = set(COMPOSITE_DOMAIN_DRAFT_TYPES)
CompositeStepExecutor = Callable[[str, dict[str, Any]], tuple[dict[str, Any], list[str]]]


def validate_composite_operation_plan(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("复合操作草稿格式不正确")
    if str(payload.get("schemaVersion") or "") != COMPOSITE_OPERATION_SCHEMA_VERSION:
        raise ValueError("复合操作草稿版本不正确")
    steps = payload.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("复合操作必须包含步骤")
    if len(steps) > 20:
        raise ValueError("复合操作一次不能超过 20 个步骤")

    normalized_steps: list[dict[str, Any]] = []
    seen_step_ids: set[str] = set()
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError("复合操作步骤格式不正确")
        step_id = str(step.get("stepId") or "").strip()
        if not step_id:
            raise ValueError("复合操作步骤必须包含 stepId")
        if step_id in seen_step_ids:
            raise ValueError("复合操作步骤 ID 不能重复")
        seen_step_ids.add(step_id)
        domain = str(step.get("domain") or "").strip()
        if domain not in SUPPORTED_COMPOSITE_DOMAINS:
            raise ValueError("复合操作步骤领域不受支持")
        operation = step.get("operation")
        if not isinstance(operation, dict):
            raise ValueError("复合操作步骤必须包含 operation")
        depends_on = step.get("dependsOn") or []
        if not isinstance(depends_on, list):
            raise ValueError("复合操作步骤 dependsOn 必须是数组")
        normalized_steps.append(
            {
                "stepId": step_id,
                "domain": domain,
                "dependsOn": [str(item).strip() for item in depends_on if str(item).strip()],
                "operation": operation,
            }
        )

    _validate_dependency_graph(normalized_steps)
    return {
        "draftType": "composite_operation",
        "schemaVersion": COMPOSITE_OPERATION_SCHEMA_VERSION,
        "steps": normalized_steps,
    }


def normalize_composite_operation_draft(payload: Any) -> dict[str, Any]:
    normalized = validate_composite_operation_plan(payload)
    unsupported_domains = sorted(
        {str(step.get("domain") or "") for step in normalized["steps"] if str(step.get("domain") or "") not in EXECUTABLE_COMPOSITE_DOMAINS}
    )
    if unsupported_domains:
        raise ValueError("复合操作正式审批暂只支持已接入的基础业务域")
    return {
        **normalized,
        "stepPreviews": build_composite_operation_step_previews(normalized)["steps"],
    }


def normalize_limited_composite_operation_draft(payload: Any) -> dict[str, Any]:
    return normalize_composite_operation_draft(payload)


def validate_composite_operation_shape(original: Any, submitted: Any) -> None:
    original_normalized = validate_composite_operation_plan(original)
    submitted_normalized = validate_composite_operation_plan(submitted)
    if original_normalized["steps"] != submitted_normalized["steps"]:
        raise ValueError("确认阶段不能修改复合操作步骤、依赖或执行内容")


def composite_execution_order(payload: Any) -> list[dict[str, Any]]:
    normalized = validate_composite_operation_plan(payload)
    steps = list(normalized["steps"])
    return _topological_order(steps)


def resolve_composite_step_operation(
    step: dict[str, Any],
    *,
    step_results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(step, dict):
        raise ValueError("复合操作步骤格式不正确")
    operation = step.get("operation")
    if not isinstance(operation, dict):
        raise ValueError("复合操作步骤必须包含 operation")
    allowed_dependencies = set(str(item) for item in (step.get("dependsOn") or []))
    return _resolve_references(operation, step_results=step_results, allowed_dependencies=allowed_dependencies)


def build_composite_operation_step_previews(payload: Any) -> dict[str, Any]:
    ordered_steps = composite_execution_order(payload)
    previews: list[dict[str, Any]] = []
    for index, step in enumerate(ordered_steps, start=1):
        operation = step["operation"]
        dependency_refs = _collect_dependency_references(operation)
        undeclared_refs = sorted(
            ref["stepId"]
            for ref in dependency_refs
            if ref["stepId"] not in set(str(item) for item in step.get("dependsOn") or [])
        )
        if undeclared_refs:
            raise ValueError("复合操作步骤只能引用自己的依赖步骤")
        previews.append(_step_preview(step, operation=operation, dependency_refs=dependency_refs, index=index))
    return {
        "schemaVersion": COMPOSITE_OPERATION_SCHEMA_VERSION,
        "stepCount": len(previews),
        "steps": previews,
    }


def execute_composite_operation_plan(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    execute_operation: CompositeStepExecutor | None = None,
) -> dict[str, Any]:
    """Execute composite_operation.v1 in dependency order within one transaction."""

    ordered_steps = composite_execution_order(payload)
    step_results: dict[str, dict[str, Any]] = {}
    with db.begin_nested():
        for step in ordered_steps:
            domain = str(step["domain"])
            if domain not in EXECUTABLE_COMPOSITE_DOMAINS:
                raise ValueError("复合操作执行器暂不支持该步骤领域")
            operation = resolve_composite_step_operation(step, step_results=step_results)
            if execute_operation is None and domain == "ingredient":
                step_result = _execute_ingredient_step(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    step=step,
                    operation=operation,
                )
            elif domain == "inventory":
                step_result = _execute_inventory_step(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    step=step,
                    operation=operation,
                )
            elif execute_operation is None:
                raise ValueError("复合操作执行器需要统一领域 executor 后才能执行该步骤")
            else:
                draft_type = COMPOSITE_DOMAIN_DRAFT_TYPES[domain]
                business_entity, entity_ids = execute_operation(draft_type, operation)
                step_result = _step_result(step, domain=domain, business_entity=business_entity, entity_ids=entity_ids)
            step_results[str(step["stepId"])] = step_result

    return {
        "schemaVersion": COMPOSITE_OPERATION_SCHEMA_VERSION,
        "steps": [step_results[str(step["stepId"])] for step in ordered_steps],
        "stepResults": step_results,
    }


def execute_limited_composite_operation_plan(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    execute_operation: CompositeStepExecutor | None = None,
) -> dict[str, Any]:
    return execute_composite_operation_plan(
        db,
        family_id=family_id,
        user_id=user_id,
        payload=payload,
        execute_operation=execute_operation,
    )


def _step_result(
    step: dict[str, Any],
    *,
    domain: str,
    business_entity: dict[str, Any],
    entity_ids: list[str],
) -> dict[str, Any]:
    return {
        "stepId": step["stepId"],
        "domain": domain,
        "entityType": _affected_entity_type(domain),
        "entityId": entity_ids[0] if len(entity_ids) == 1 else None,
        "entityIds": entity_ids,
        "payload": business_entity,
    }


def _validate_dependency_graph(steps: list[dict[str, Any]]) -> None:
    _topological_order(steps)


def _topological_order(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    step_ids = {step["stepId"] for step in steps}
    dependents: dict[str, list[str]] = {step_id: [] for step_id in step_ids}
    indegree: dict[str, int] = {step_id: 0 for step_id in step_ids}
    by_id = {step["stepId"]: step for step in steps}
    for step in steps:
        step_id = str(step["stepId"])
        dependencies = list(dict.fromkeys(str(item) for item in step.get("dependsOn") or []))
        for dependency in dependencies:
            if dependency == step_id:
                raise ValueError("复合操作步骤不能依赖自身")
            if dependency not in step_ids:
                raise ValueError("复合操作步骤依赖了不存在的步骤")
            dependents[dependency].append(step_id)
            indegree[step_id] += 1

    queue = deque(step_id for step_id, degree in indegree.items() if degree == 0)
    ordered: list[dict[str, Any]] = []
    while queue:
        current = queue.popleft()
        ordered.append(by_id[current])
        for dependent in dependents[current]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                queue.append(dependent)
    if len(ordered) != len(steps):
        raise ValueError("复合操作依赖图不能有环")
    return ordered


def _resolve_references(
    value: Any,
    *,
    step_results: dict[str, dict[str, Any]],
    allowed_dependencies: set[str],
) -> Any:
    if isinstance(value, dict):
        return {
            key: _resolve_references(item, step_results=step_results, allowed_dependencies=allowed_dependencies)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _resolve_references(item, step_results=step_results, allowed_dependencies=allowed_dependencies)
            for item in value
        ]
    if not isinstance(value, str):
        return value

    match = COMPOSITE_REFERENCE_RE.match(value)
    if match is None:
        return value
    step_id, path = match.groups()
    if step_id not in allowed_dependencies:
        raise ValueError("复合操作步骤只能引用自己的依赖步骤")
    if step_id not in step_results:
        raise ValueError("复合操作引用的依赖步骤尚未执行")
    current: Any = step_results[step_id]
    for key in path.split("."):
        if not isinstance(current, dict) or key not in current:
            raise ValueError("复合操作引用的依赖结果不存在")
        current = current[key]
    return current


def _collect_dependency_references(value: Any) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    if isinstance(value, dict):
        for item in value.values():
            refs.extend(_collect_dependency_references(item))
        return refs
    if isinstance(value, list):
        for item in value:
            refs.extend(_collect_dependency_references(item))
        return refs
    if not isinstance(value, str):
        return refs
    match = COMPOSITE_REFERENCE_RE.match(value)
    if match is None:
        return refs
    step_id, path = match.groups()
    return [{"stepId": step_id, "path": path, "ref": value}]


def _step_preview(
    step: dict[str, Any],
    *,
    operation: dict[str, Any],
    dependency_refs: list[dict[str, str]],
    index: int,
) -> dict[str, Any]:
    domain = str(step["domain"])
    action = _step_action(domain, operation)
    return {
        "stepId": step["stepId"],
        "stepIndex": index,
        "domain": domain,
        "domainLabel": _domain_label(domain),
        "action": action,
        "actionLabel": _action_label(action),
        "title": _step_title(domain, action, operation),
        "summary": _step_summary(domain, action, operation, dependency_refs),
        "dependsOn": list(step.get("dependsOn") or []),
        "dependencyRefs": dependency_refs,
        "affectedEntityType": _affected_entity_type(domain),
        "impact": _step_impact(domain, action, operation, dependency_refs),
    }


def _step_action(domain: str, operation: dict[str, Any]) -> str:
    if domain == "inventory" and isinstance(operation.get("operations"), list):
        actions = [str(item.get("action") or "") for item in operation.get("operations") or [] if isinstance(item, dict)]
        unique_actions = sorted(set(item for item in actions if item))
        return unique_actions[0] if len(unique_actions) == 1 else "apply"
    return str(operation.get("action") or "apply")


def _domain_label(domain: str) -> str:
    return {
        "ingredient": "食材档案",
        "inventory": "库存",
        "food": "食物资料",
        "recipe": "菜谱",
        "recipe_cook": "做菜",
        "meal_plan": "餐食计划",
        "shopping_list": "购物清单",
        "meal_log": "餐食记录",
    }.get(domain, domain)


def _action_label(action: str) -> str:
    return {
        "create": "新增",
        "update": "更新",
        "delete": "删除",
        "set_status": "状态变更",
        "set_done": "状态变更",
        "set_favorite": "收藏",
        "restock": "入库",
        "consume": "消耗",
        "dispose": "销毁",
        "apply": "应用",
        "cook": "做菜",
    }.get(action, action or "操作")


def _affected_entity_type(domain: str) -> str:
    return {
        "ingredient": "Ingredient",
        "inventory": "InventoryItem",
        "food": "Food",
        "recipe": "Recipe",
        "recipe_cook": "RecipeCookLog",
        "meal_plan": "FoodPlanItem",
        "shopping_list": "ShoppingListItem",
        "meal_log": "MealLog",
    }.get(domain, domain)


def _step_title(domain: str, action: str, operation: dict[str, Any]) -> str:
    label = _domain_label(domain)
    action_label = _action_label(action)
    target = _operation_target_label(operation)
    return f"{action_label}{label}" + (f" · {target}" if target else "")


def _step_summary(
    domain: str,
    action: str,
    operation: dict[str, Any],
    dependency_refs: list[dict[str, str]],
) -> str:
    if domain == "inventory":
        operations = operation.get("operations") if isinstance(operation.get("operations"), list) else [operation]
        parts = []
        for item in operations:
            if not isinstance(item, dict):
                continue
            quantity = item.get("quantity")
            unit = item.get("unit")
            target = item.get("ingredientName") or item.get("ingredientId")
            parts.append(" ".join(str(value) for value in [target, quantity, unit] if value not in {None, ""}))
        if parts:
            return "；".join(parts)
    if dependency_refs:
        return "引用前置步骤结果：" + "、".join(ref["ref"] for ref in dependency_refs)
    target = _operation_target_label(operation)
    return target or f"{_action_label(action)}{_domain_label(domain)}"


def _step_impact(
    domain: str,
    action: str,
    operation: dict[str, Any],
    dependency_refs: list[dict[str, str]],
) -> dict[str, Any]:
    impact: dict[str, Any] = {
        "writesBusinessData": True,
        "requiresApproval": True,
        "usesDependencyResult": bool(dependency_refs),
    }
    if action == "create":
        impact["creates"] = 1
    elif action in {"update", "set_status", "set_done", "set_favorite"}:
        impact["updates"] = 1
    elif action == "delete":
        impact["deletes"] = 1
    if domain == "inventory":
        operations = operation.get("operations") if isinstance(operation.get("operations"), list) else [operation]
        impact["operationCount"] = len([item for item in operations if isinstance(item, dict)])
    return impact


def _operation_target_label(operation: dict[str, Any]) -> str:
    payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
    before = operation.get("before") if isinstance(operation.get("before"), dict) else {}
    for key in ("title", "name", "ingredientName", "foodName"):
        value = payload.get(key) or before.get(key) or operation.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    target_id = operation.get("targetId")
    if isinstance(target_id, str) and target_id.strip():
        return target_id.strip()
    return ""


def _execute_ingredient_step(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    step: dict[str, Any],
    operation: dict[str, Any],
) -> dict[str, Any]:
    ingredient = execute_ingredient_profile_draft(
        db,
        family_id=family_id,
        user_id=user_id,
        payload=operation,
        assert_updated_at_matches=assert_updated_at_matches,
    )
    payload = serialize_ingredient(ingredient, {})
    return {
        "stepId": step["stepId"],
        "domain": "ingredient",
        "entityType": "Ingredient",
        "entityId": ingredient.id,
        "entityIds": [ingredient.id],
        "payload": payload,
    }


def _execute_inventory_step(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    step: dict[str, Any],
    operation: dict[str, Any],
) -> dict[str, Any]:
    raw_payload = operation if isinstance(operation.get("operations"), list) else {"operations": [operation]}
    payload = normalize_inventory_operation_draft(db, family_id=family_id, payload=raw_payload)
    result, entity_ids = execute_inventory_operation_draft(
        db,
        family_id=family_id,
        user_id=user_id,
        payload=payload,
    )
    rows = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id, InventoryItem.id.in_(entity_ids))
            .options(selectinload(InventoryItem.ingredient))
        )
    )
    entities = [serialize_inventory_item(item) for item in rows]
    return {
        "stepId": step["stepId"],
        "domain": "inventory",
        "entityType": "InventoryItem",
        "entityId": entity_ids[0] if len(entity_ids) == 1 else None,
        "entityIds": entity_ids,
        "payload": result,
        "entities": entities,
    }
