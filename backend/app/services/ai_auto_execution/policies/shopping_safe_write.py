from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import FoodType, IngredientQuantityTrackingMode
from app.models.domain import Food, Ingredient, ShoppingListItem
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policies._common import (
    active_actor,
    allowed,
    decimal_equal,
    decimal_value,
    denied,
    enum_value,
    requirements_verified,
    version_matches,
)
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    CriticalEvidenceRequirement,
)


_READY_FOOD_TYPES = {
    FoodType.READY_MADE.value,
    FoodType.INSTANT.value,
    FoodType.PACKAGED.value,
}
_TOP_LEVEL_FIELDS = {"draftType", "schemaVersion", "sourceDraftId"}
_ITEM_FIELDS = {
    "title", "quantity", "unit", "ingredient_id", "food_id", "quantity_mode", "display_label", "reason",
}
_CREATE_OPERATION_FIELDS = {"operationId", "action", "payload"}
_MUTATION_OPERATION_FIELDS = {"operationId", "action", "targetId", "baseUpdatedAt", "before", "payload"}


class ShoppingPolicyViolation(ValueError):
    def __init__(self, reason_code: str = "domain_constraint_failed") -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


@dataclass(frozen=True)
class ShoppingServerTargets:
    ingredients: dict[str, Ingredient]
    foods: dict[str, Food]
    shopping_items: dict[str, ShoppingListItem]


def _require(condition: bool, reason: str = "domain_constraint_failed") -> None:
    if not condition:
        raise ShoppingPolicyViolation(reason)


def _create_target(
    item: dict[str, Any],
    *,
    targets: ShoppingServerTargets,
) -> tuple[str, Ingredient | Food, bool]:
    _require(set(item) == _ITEM_FIELDS)
    ingredient_id = str(item.get("ingredient_id") or "")
    food_id = str(item.get("food_id") or "")
    _require(bool(ingredient_id) != bool(food_id))
    if ingredient_id:
        ingredient = targets.ingredients.get(ingredient_id)
        _require(ingredient is not None)
        tracked = enum_value(ingredient.quantity_tracking_mode) == IngredientQuantityTrackingMode.TRACK_QUANTITY.value
        _require(item.get("title") == ingredient.name)
        if tracked:
            _require(item.get("quantity_mode") == IngredientQuantityTrackingMode.TRACK_QUANTITY.value)
            _require(item.get("display_label") is None)
            _require(decimal_value(item.get("quantity")) is not None and decimal_value(item.get("quantity")) > 0)
            _require(isinstance(item.get("unit"), str) and bool(item.get("unit")))
        else:
            _require(item.get("quantity_mode") == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value)
            _require(decimal_equal(item.get("quantity"), 1))
            _require(item.get("unit") == (ingredient.default_unit or "份"))
            _require(item.get("display_label") == "需要补充")
        return "ingredient_id", ingredient, tracked
    food = targets.foods.get(food_id)
    _require(food is not None and enum_value(food.type) in _READY_FOOD_TYPES)
    _require(item.get("title") == food.name)
    _require(item.get("quantity_mode") == IngredientQuantityTrackingMode.TRACK_QUANTITY.value)
    _require(item.get("display_label") is None)
    _require(decimal_value(item.get("quantity")) is not None and decimal_value(item.get("quantity")) > 0)
    _require(isinstance(item.get("unit"), str) and bool(item.get("unit")))
    return "food_id", food, True


def _create_requirements(
    *,
    prefix: str,
    action_field: str,
    item: dict[str, Any],
    targets: ShoppingServerTargets,
) -> list[CriticalEvidenceRequirement]:
    identity_field, target, tracked = _create_target(item, targets=targets)
    requirements = [
        CriticalEvidenceRequirement(action_field, "create", "explicit_action"),
        CriticalEvidenceRequirement(f"{prefix}.{identity_field}", target.id, "entity_id"),
    ]
    if tracked:
        requirements.extend((
            CriticalEvidenceRequirement(f"{prefix}.quantity", item.get("quantity"), "quantity"),
            CriticalEvidenceRequirement(f"{prefix}.unit", item.get("unit"), "unit"),
        ))
    return requirements


def shopping_critical_requirements(
    normalized_payload: dict[str, Any],
    server_targets: ShoppingServerTargets,
) -> tuple[CriticalEvidenceRequirement, ...]:
    _require(isinstance(normalized_payload, dict))
    schema_version = normalized_payload.get("schemaVersion")
    if schema_version == "shopping_list.v1":
        _require(set(normalized_payload) == _TOP_LEVEL_FIELDS | {"items"})
        items = normalized_payload.get("items")
        _require(isinstance(items, list) and bool(items))
        limit = AUTO_EXECUTION_CATALOG[ShoppingSafeWritePolicy.key].limits["add_or_restore_items"]
        _require(len(items) <= limit, "batch_limit_exceeded")
        requirements = [CriticalEvidenceRequirement("action", "create", "explicit_action")]
        identities: list[str] = []
        for index, item in enumerate(items):
            _require(isinstance(item, dict))
            identity_field, target, tracked = _create_target(item, targets=server_targets)
            _require(target.id not in identities)
            identities.append(target.id)
            prefix = f"items[{index}]"
            requirements.append(CriticalEvidenceRequirement(f"{prefix}.{identity_field}", target.id, "entity_id"))
            if tracked:
                requirements.extend((
                    CriticalEvidenceRequirement(f"{prefix}.quantity", item.get("quantity"), "quantity"),
                    CriticalEvidenceRequirement(f"{prefix}.unit", item.get("unit"), "unit"),
                ))
        return tuple(requirements)

    _require(schema_version == "shopping_list_operation.v1")
    _require(set(normalized_payload) == _TOP_LEVEL_FIELDS | {"operations"})
    operations = normalized_payload.get("operations")
    _require(isinstance(operations, list) and bool(operations))
    _require(all(isinstance(item, dict) for item in operations))
    actions = {str(item.get("action") or "") for item in operations}
    _require(len(actions) == 1)
    action = next(iter(actions)) if actions else ""
    requirements: list[CriticalEvidenceRequirement] = []
    if action == "create":
        limit = AUTO_EXECUTION_CATALOG[ShoppingSafeWritePolicy.key].limits["add_or_restore_items"]
        _require(len(operations) <= limit, "batch_limit_exceeded")
        identities: list[str] = []
        for index, operation in enumerate(operations):
            _require(isinstance(operation, dict) and set(operation) == _CREATE_OPERATION_FIELDS)
            item = operation.get("payload")
            _require(isinstance(item, dict))
            identity_field, target, _ = _create_target(item, targets=server_targets)
            _require(target.id not in identities)
            identities.append(target.id)
            requirements.extend(_create_requirements(
                prefix=f"operations[{index}].payload",
                action_field=f"operations[{index}].action",
                item=item,
                targets=server_targets,
            ))
        return tuple(requirements)

    if action == "update":
        _require(len(operations) == AUTO_EXECUTION_CATALOG[ShoppingSafeWritePolicy.key].limits["update_items"])
        operation = operations[0]
        _require(isinstance(operation, dict) and set(operation) == _MUTATION_OPERATION_FIELDS)
        item = operation.get("payload")
        _require(isinstance(item, dict) and set(item) == _ITEM_FIELDS)
        target = server_targets.shopping_items.get(str(operation.get("targetId") or ""))
        _require(target is not None and not target.done)
        _require(version_matches(target.updated_at, operation.get("baseUpdatedAt")), "target_stale")
        _require(bool(target.ingredient_id) != bool(target.food_id))
        if target.ingredient_id:
            _require(target.ingredient_id in server_targets.ingredients)
        else:
            food = server_targets.foods.get(str(target.food_id))
            _require(food is not None and enum_value(food.type) in _READY_FOOD_TYPES)
        _require(item.get("ingredient_id") == target.ingredient_id and item.get("food_id") == target.food_id)
        _require(item.get("title") == target.title)
        _require(item.get("quantity_mode") == enum_value(target.quantity_mode))
        _require(item.get("display_label") == target.display_label)
        if enum_value(target.quantity_mode) == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value:
            _require(decimal_equal(item.get("quantity"), 1))
            _require(item.get("unit") == target.unit and item.get("display_label") == "需要补充")
        requirements.extend((
            CriticalEvidenceRequirement("operations[0].action", "update", "explicit_action"),
            CriticalEvidenceRequirement("operations[0].targetId", target.id, "entity_id"),
        ))
        for field, matcher in (("quantity", "quantity"), ("unit", "unit"), ("reason", "text")):
            current_value = getattr(target, field)
            next_value = item.get(field)
            equal = decimal_equal(current_value, next_value) if field == "quantity" else current_value == next_value
            if not equal:
                requirements.append(CriticalEvidenceRequirement(f"operations[0].payload.{field}", next_value, matcher))
        return tuple(requirements)

    if action == "set_done":
        limit = AUTO_EXECUTION_CATALOG[ShoppingSafeWritePolicy.key].limits["add_or_restore_items"]
        _require(len(operations) <= limit, "batch_limit_exceeded")
        target_ids: set[str] = set()
        for index, operation in enumerate(operations):
            _require(isinstance(operation, dict) and set(operation) == _MUTATION_OPERATION_FIELDS)
            target_id = str(operation.get("targetId") or "")
            target = server_targets.shopping_items.get(target_id)
            _require(target is not None and target_id not in target_ids)
            target_ids.add(target_id)
            _require(version_matches(target.updated_at, operation.get("baseUpdatedAt")), "target_stale")
            item = operation.get("payload")
            _require(isinstance(item, dict) and set(item) == {"done", "reason"})
            _require(item.get("done") is False and item.get("reason") == "")
            requirements.extend((
                CriticalEvidenceRequirement(f"operations[{index}].action", "set_done:false", "explicit_action"),
                CriticalEvidenceRequirement(f"operations[{index}].targetId", target.id, "entity_id"),
                CriticalEvidenceRequirement(f"operations[{index}].payload.done", False, "boolean_direction"),
            ))
        return tuple(requirements)
    raise ShoppingPolicyViolation()


def _load_server_targets(db: Session, *, family_id: str, payload: dict[str, Any]) -> ShoppingServerTargets:
    ingredient_ids: set[str] = set()
    food_ids: set[str] = set()
    shopping_item_ids: set[str] = set()
    raw_items: list[Any] = []
    if isinstance(payload.get("items"), list):
        raw_items.extend(payload["items"])
    if isinstance(payload.get("operations"), list):
        for operation in payload["operations"]:
            if not isinstance(operation, dict):
                continue
            target_id = str(operation.get("targetId") or "")
            if target_id:
                shopping_item_ids.add(target_id)
            raw_items.append(operation.get("payload"))
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        ingredient_id = str(item.get("ingredient_id") or "")
        food_id = str(item.get("food_id") or "")
        if ingredient_id:
            ingredient_ids.add(ingredient_id)
        if food_id:
            food_ids.add(food_id)
    ingredients = list(db.scalars(select(Ingredient).where(
        Ingredient.family_id == family_id,
        Ingredient.id.in_(ingredient_ids),
    ))) if ingredient_ids else []
    foods = list(db.scalars(select(Food).where(
        Food.family_id == family_id,
        Food.id.in_(food_ids),
    ))) if food_ids else []
    shopping_items = list(db.scalars(select(ShoppingListItem).where(
        ShoppingListItem.family_id == family_id,
        ShoppingListItem.id.in_(shopping_item_ids),
    ))) if shopping_item_ids else []
    return ShoppingServerTargets(
        ingredients={item.id: item for item in ingredients},
        foods={item.id: item for item in foods},
        shopping_items={item.id: item for item in shopping_items},
    )


class ShoppingSafeWritePolicy:
    key = "shopping_list.safe_write"
    version = "shopping_list.safe_write.v1"
    draft_types = frozenset({"shopping_list"})
    revert_adapter_key = "shopping_list.safe_write.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return draft_type == "shopping_list" and payload.get("draftType") == "shopping_list"

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]:
        del actor_user_id
        targets = _load_server_targets(db, family_id=family_id, payload=payload)
        try:
            return shopping_critical_requirements(payload, targets)
        except ShoppingPolicyViolation:
            return ()

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        if not active_actor(context.db, family_id=context.family_id, actor_user_id=context.actor_user_id):
            return denied()
        targets = _load_server_targets(context.db, family_id=context.family_id, payload=context.payload)
        try:
            requirements = shopping_critical_requirements(context.payload, targets)
        except ShoppingPolicyViolation as exc:
            return denied(exc.reason_code)
        if not requirements_verified(context, requirements):
            return denied("intent_evidence_missing")
        operations = context.payload.get("operations")
        if not isinstance(operations, list):
            return allowed()
        action = str((operations[0] if operations else {}).get("action") or "")
        if action == "update":
            target = targets.shopping_items[str(operations[0]["targetId"])]
            item = operations[0]["payload"]
            satisfied = (
                decimal_equal(target.quantity, item.get("quantity"))
                and target.unit == item.get("unit")
                and target.reason == item.get("reason")
            )
            return allowed(all_targets_satisfied=satisfied)
        if action == "set_done":
            satisfied = [not targets.shopping_items[str(operation["targetId"])].done for operation in operations]
            if any(satisfied) and not all(satisfied):
                return denied()
            return allowed(all_targets_satisfied=all(satisfied))
        return allowed()
