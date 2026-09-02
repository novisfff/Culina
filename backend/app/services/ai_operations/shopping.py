from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, FoodType, IngredientQuantityTrackingMode
from app.core.utils import create_id
from app.models.domain import Food, Ingredient, ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policy_types import ConcurrencyStrategy, DraftExecutionReceipt
from app.services.ai_operations.registry_types import DraftExecuteContext
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.serializers import serialize_shopping_item


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}
_SHOPPING_TOP_FIELDS = {"draftType", "schemaVersion", "sourceDraftId"}
_SHOPPING_ITEM_FIELDS = {
    "title",
    "quantity",
    "unit",
    "ingredient_id",
    "food_id",
    "quantity_mode",
    "display_label",
    "reason",
}
_SHOPPING_CREATE_OPERATION_FIELDS = {"operationId", "action", "payload"}
_SHOPPING_MUTATION_OPERATION_FIELDS = {
    "operationId",
    "action",
    "targetId",
    "baseUpdatedAt",
    "before",
    "payload",
}
_SHOPPING_QUANTITY_QUANTUM = Decimal("0.01")


def _canonical_shopping_quantity(value: float | Decimal | None) -> Decimal:
    return Decimal(str(value or 1)).quantize(
        _SHOPPING_QUANTITY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _shopping_safe_mode(payload: dict[str, Any]) -> str | None:
    if payload.get("draftType") != "shopping_list":
        return None
    if payload.get("schemaVersion") == "shopping_list.v1":
        items = payload.get("items")
        if (
            set(payload) == _SHOPPING_TOP_FIELDS | {"items"}
            and isinstance(items, list)
            and bool(items)
            and len(items)
            <= AUTO_EXECUTION_CATALOG["shopping_list.safe_write"].limits[
                "add_or_restore_items"
            ]
            and all(isinstance(item, dict) and set(item) == _SHOPPING_ITEM_FIELDS for item in items)
            and _shopping_create_identities_are_unique(items)
        ):
            return "add"
        return None
    if payload.get("schemaVersion") != "shopping_list_operation.v1":
        return None
    operations = payload.get("operations")
    if (
        set(payload) != _SHOPPING_TOP_FIELDS | {"operations"}
        or not isinstance(operations, list)
        or not operations
        or not all(isinstance(operation, dict) for operation in operations)
    ):
        return None
    actions = {str(operation.get("action") or "") for operation in operations}
    if (
        actions == {"create"}
        and all(
            set(operation) == _SHOPPING_CREATE_OPERATION_FIELDS
            and isinstance(operation.get("payload"), dict)
            and set(operation["payload"]) == _SHOPPING_ITEM_FIELDS
            for operation in operations
        )
        and len(operations)
        <= AUTO_EXECUTION_CATALOG["shopping_list.safe_write"].limits[
            "add_or_restore_items"
        ]
        and _shopping_create_identities_are_unique(
            [operation["payload"] for operation in operations]
        )
    ):
        return "add"
    if actions == {"update"} and len(operations) == 1:
        operation = operations[0]
        if (
            set(operation) == _SHOPPING_MUTATION_OPERATION_FIELDS
            and isinstance(operation.get("before"), dict)
            and isinstance(operation.get("payload"), dict)
            and set(operation["payload"]) == _SHOPPING_ITEM_FIELDS
        ):
            return "update"
    if (
        actions == {"set_done"}
        and all(
            set(operation) == _SHOPPING_MUTATION_OPERATION_FIELDS
            and isinstance(operation.get("before"), dict)
            and isinstance(operation.get("payload"), dict)
            and set(operation["payload"]) == {"done", "reason"}
            and operation["payload"].get("done") is False
            and operation["payload"].get("reason") == ""
            for operation in operations
        )
        and len(operations)
        <= AUTO_EXECUTION_CATALOG["shopping_list.safe_write"].limits[
            "add_or_restore_items"
        ]
        and len({str(operation.get("targetId") or "") for operation in operations})
        == len(operations)
    ):
        return "restore"
    return None


def _shopping_create_identities_are_unique(items: list[dict[str, Any]]) -> bool:
    identities: list[str] = []
    for item in items:
        ingredient_id = str(item.get("ingredient_id") or "")
        food_id = str(item.get("food_id") or "")
        if bool(ingredient_id) == bool(food_id):
            return False
        identities.append(ingredient_id or food_id)
    return len(identities) == len(set(identities))


def _shopping_create_payload_matches_item(
    payload: dict[str, Any],
    item: ShoppingListItem,
) -> bool:
    try:
        quantity_matches = _canonical_shopping_quantity(
            payload.get("quantity")
        ) == Decimal(str(item.quantity))
    except Exception:
        return False
    return (
        payload.get("ingredient_id") == item.ingredient_id
        and payload.get("food_id") == item.food_id
        and payload.get("title") == item.title
        and quantity_matches
        and payload.get("unit") == item.unit
        and payload.get("quantity_mode")
        == getattr(item.quantity_mode, "value", item.quantity_mode)
        and payload.get("display_label") == item.display_label
        and payload.get("reason") == item.reason
    )


def _require_shopping_target(
    db: Session,
    *,
    family_id: str,
    item_in: CreateShoppingListItemRequest,
) -> tuple[Ingredient | None, Food | None]:
    if bool(item_in.ingredient_id) == bool(item_in.food_id):
        raise ValueError("购物清单项目必须引用真实食材或成品采购对象")
    if item_in.ingredient_id:
        ingredient = db.scalar(
            select(Ingredient).where(
                Ingredient.family_id == family_id,
                Ingredient.id == item_in.ingredient_id,
            )
        )
        if ingredient is None:
            raise ValueError("购物清单项目引用了不存在的食材")
        return ingredient, None
    food = db.scalar(select(Food).where(Food.family_id == family_id, Food.id == item_in.food_id))
    if food is None:
        raise ValueError("购物清单项目引用了不存在的食物")
    if food.type not in READY_LIKE_FOOD_TYPES:
        raise ValueError("只有成品、速食或包装食品可以加入采购清单")
    return None, food


def _shopping_values_for_target(
    item_in: CreateShoppingListItemRequest,
    ingredient: Ingredient | None,
    food: Food | None,
) -> dict[str, Any]:
    if ingredient is not None:
        quantity_mode = ingredient.quantity_tracking_mode
        unit = item_in.unit or ingredient.default_unit or "份"
        display_label = item_in.display_label
        if quantity_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
            display_label = display_label or "需要补充"
        else:
            display_label = None
        return {
            "ingredient_id": ingredient.id,
            "food_id": None,
            "title": ingredient.name,
            "quantity_mode": quantity_mode,
            "unit": unit,
            "display_label": display_label,
        }
    assert food is not None
    return {
        "ingredient_id": None,
        "food_id": food.id,
        "title": food.name,
        "quantity_mode": IngredientQuantityTrackingMode.TRACK_QUANTITY,
        "unit": item_in.unit or food.stock_unit or "份",
        "display_label": None,
    }


def execute_shopping_list_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
    concurrency_strategy: ConcurrencyStrategy = "entity_version",
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    if isinstance(payload.get("operations"), list):
        return _apply_shopping_item_operations(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
            concurrency_strategy=concurrency_strategy,
            revert_capture=revert_capture,
        )
    return _create_shopping_items_from_payload(
        db,
        family_id=family_id,
        user_id=user_id,
        payload=payload,
        revert_capture=revert_capture,
    )


def _apply_shopping_item_operations(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
    concurrency_strategy: ConcurrencyStrategy = "entity_version",
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    results: list[dict[str, Any]] = []
    entity_ids: list[str] = []
    operations = list(payload.get("operations") or [])
    eligible_mode = _shopping_safe_mode(payload)
    captured_items: list[dict[str, Any]] = []
    mutation_target_ids = sorted(
        {
            str(operation.get("targetId") or "")
            for operation in operations
            if isinstance(operation, dict)
            and str(operation.get("action") or "") != "create"
            and str(operation.get("targetId") or "")
        }
    )
    locked_items: dict[str, ShoppingListItem] = {}
    if mutation_target_ids:
        discovered = list(
            db.scalars(
                select(ShoppingListItem).where(
                    ShoppingListItem.family_id == family_id,
                    ShoppingListItem.id.in_(mutation_target_ids),
                )
            )
        )
        ingredient_ids = {
            item.ingredient_id for item in discovered if item.ingredient_id
        }
        food_ids = {item.food_id for item in discovered if item.food_id}
        for operation in operations:
            item_payload = operation.get("payload") if isinstance(operation, dict) else None
            if not isinstance(item_payload, dict):
                continue
            if item_payload.get("ingredient_id"):
                ingredient_ids.add(str(item_payload["ingredient_id"]))
            if item_payload.get("food_id"):
                food_ids.add(str(item_payload["food_id"]))
        try:
            locked_items = lock_inventory_targets(
                db,
                family_id=family_id,
                ingredient_ids=tuple(sorted(ingredient_ids)),
                food_ids=tuple(sorted(food_ids)),
                shopping_item_ids=mutation_target_ids,
            ).shopping_items
        except InventoryTargetNotFoundError as exc:
            raise AIConflictError("购物项不存在或已被删除") from exc
    for operation in operations:
        action = str(operation.get("action") or "")
        if action == "create":
            item_in = CreateShoppingListItemRequest.model_validate(operation.get("payload") or {})
            ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
            target_values = _shopping_values_for_target(item_in, ingredient, food)
            item = ShoppingListItem(
                id=create_id("shopping"),
                family_id=family_id,
                ingredient_id=target_values["ingredient_id"],
                food_id=target_values["food_id"],
                title=target_values["title"],
                quantity=_canonical_shopping_quantity(item_in.quantity),
                unit=target_values["unit"],
                quantity_mode=target_values["quantity_mode"],
                display_label=target_values["display_label"],
                reason=item_in.reason,
                done=False,
                created_by=user_id,
                updated_by=user_id,
            )
            db.add(item)
            db.flush()
            if eligible_mode == "add" and _shopping_create_payload_matches_item(
                operation.get("payload") or {}, item
            ):
                captured_items.append(_shopping_revert_item(item, before=None, mode="add"))
            elif eligible_mode == "add":
                eligible_mode = None
                captured_items.clear()
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.CREATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI 加入购物清单 {item.title}",
            )
            results.append(
                {
                    "operationId": operation.get("operationId"),
                    "action": "create",
                    "item": serialize_shopping_item(item),
                }
            )
            entity_ids.append(item.id)
            continue
        try:
            item = locked_items[str(operation["targetId"])]
        except KeyError:
            raise AIConflictError("购物项不存在或已被删除")
        relaxed_concurrency = (
            action == "update" and concurrency_strategy == "field_patch"
        ) or (
            action == "set_done" and concurrency_strategy == "idempotent_set"
        )
        if not relaxed_concurrency:
            assert_updated_at_matches(
                actual=item.updated_at,
                expected=str(operation.get("baseUpdatedAt")),
                label=f"购物项 {item.title}",
            )
        if action == "delete":
            snapshot = serialize_shopping_item(item)
            db.delete(item)
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI 删除购物项 {item.title}",
            )
            results.append({"operationId": operation.get("operationId"), "action": "delete", "item": snapshot})
            entity_ids.append(item.id)
            continue
        if action == "set_done":
            done = bool((operation.get("payload") or {}).get("done"))
            before_done = bool(item.done)
            item.done = done
            item.updated_by = user_id
            db.flush()
            if eligible_mode == "restore" and before_done and not done:
                captured_items.append(
                    _shopping_revert_item(item, before={"done": True}, mode="restore")
                )
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI {'完成' if done else '恢复'}购物项 {item.title}",
            )
            results.append(
                {
                    "operationId": operation.get("operationId"),
                    "action": "set_done",
                    "item": serialize_shopping_item(item),
                }
            )
            entity_ids.append(item.id)
            continue
        item_in = CreateShoppingListItemRequest.model_validate(operation.get("payload") or {})
        before_identity = (
            item.ingredient_id,
            item.food_id,
            item.title,
            item.quantity_mode,
            item.display_label,
        )
        before = _shopping_safe_values(item)
        ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
        target_values = _shopping_values_for_target(item_in, ingredient, food)
        item.ingredient_id = target_values["ingredient_id"]
        item.food_id = target_values["food_id"]
        item.title = target_values["title"]
        item.quantity = _canonical_shopping_quantity(item_in.quantity)
        item.unit = target_values["unit"]
        item.quantity_mode = target_values["quantity_mode"]
        item.display_label = target_values["display_label"]
        item.reason = item_in.reason
        item.updated_by = user_id
        db.flush()
        if eligible_mode == "update":
            after_identity = (
                item.ingredient_id,
                item.food_id,
                item.title,
                item.quantity_mode,
                item.display_label,
            )
            if (
                after_identity == before_identity
                and not item.done
                and _shopping_safe_values(item) != before
            ):
                captured_items.append(_shopping_revert_item(item, before=before, mode="update"))
            else:
                eligible_mode = None
                captured_items.clear()
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="ShoppingListItem",
            entity_id=item.id,
            summary=f"AI 更新购物项 {item.title}",
        )
        results.append(
            {
                "operationId": operation.get("operationId"),
                "action": "update",
                "item": serialize_shopping_item(item),
            }
        )
        entity_ids.append(item.id)
    if revert_capture is not None and eligible_mode and len(captured_items) == len(operations):
        revert_capture.update(
            {
                "schema_version": 1,
                "mode": eligible_mode,
                "items": sorted(captured_items, key=lambda record: record["shopping_item_id"]),
            }
        )
    return {"operations": results}, list(dict.fromkeys(entity_ids))


def _create_shopping_items_from_payload(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    created: list[ShoppingListItem] = []
    item_payloads = list(payload.get("items") or [])
    eligible_mode = _shopping_safe_mode(payload)
    for item_payload in item_payloads:
        item_in = CreateShoppingListItemRequest.model_validate(item_payload)
        ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
        target_values = _shopping_values_for_target(item_in, ingredient, food)
        item = ShoppingListItem(
            id=create_id("shopping"),
            family_id=family_id,
            ingredient_id=target_values["ingredient_id"],
            food_id=target_values["food_id"],
            title=target_values["title"],
            quantity=_canonical_shopping_quantity(item_in.quantity),
            unit=target_values["unit"],
            quantity_mode=target_values["quantity_mode"],
            display_label=target_values["display_label"],
            reason=item_in.reason,
            done=False,
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(item)
        created.append(item)
    db.flush()
    for item in created:
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="ShoppingListItem",
            entity_id=item.id,
            summary=f"AI 加入购物清单 {item.title}",
        )
    eligible = (
        eligible_mode == "add"
        and len(item_payloads) == len(created)
        and all(
            _shopping_create_payload_matches_item(item_payload, item)
            for item_payload, item in zip(item_payloads, created, strict=True)
        )
    )
    if revert_capture is not None and created and eligible:
        revert_capture.update(
            {
                "schema_version": 1,
                "mode": "add",
                "items": [
                    _shopping_revert_item(item, before=None, mode="add")
                    for item in sorted(created, key=lambda row: row.id)
                ],
            }
        )
    return {"items": [serialize_shopping_item(item) for item in created]}, [item.id for item in created]


def _shopping_safe_values(item: ShoppingListItem) -> dict[str, Any]:
    return {
        "quantity": float(item.quantity),
        "unit": item.unit,
        "notes": item.reason,
    }


def _shopping_revert_item(
    item: ShoppingListItem,
    *,
    before: dict[str, Any] | None,
    mode: str,
) -> dict[str, Any]:
    if mode == "restore":
        after: dict[str, Any] = {"done": False}
    else:
        after = _shopping_safe_values(item)
        if mode == "add":
            after["done"] = False
    return {
        "shopping_item_id": item.id,
        "before": before,
        "after": after,
        "after_row_version": int(item.row_version),
    }


def execute_shopping_list_draft_receipt(context: DraftExecuteContext) -> DraftExecutionReceipt:
    revert_context: dict[str, Any] = {}
    business_entity, entity_ids = execute_shopping_list_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
        concurrency_strategy=context.concurrency_strategy,
        revert_capture=revert_context,
    )
    eligible = _shopping_safe_mode(context.payload) is not None and bool(revert_context)
    return DraftExecutionReceipt(
        business_entity=business_entity,
        entity_ids=tuple(sorted(entity_ids)),
        cache_scopes=("shopping_list", "ai_conversation"),
        revert_adapter_key="shopping_list.safe_write.v1" if eligible else None,
        revert_context=revert_context if eligible else None,
    )


def _operation_error_message(operation: dict[str, Any], exc: Exception) -> str:
    operation_id = str(operation.get("operationId") or "").strip() or "unknown"
    return f"操作 {operation_id} 失败：{exc}"
