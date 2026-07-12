from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, FoodType, IngredientQuantityTrackingMode
from app.core.utils import create_id
from app.models.domain import Food, Ingredient, ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.serializers import serialize_shopping_item


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


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
) -> tuple[dict[str, Any], list[str]]:
    if isinstance(payload.get("operations"), list):
        return _apply_shopping_item_operations(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    return _create_shopping_items_from_payload(db, family_id=family_id, user_id=user_id, payload=payload)


def _apply_shopping_item_operations(
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
            item_in = CreateShoppingListItemRequest.model_validate(operation.get("payload") or {})
            ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
            target_values = _shopping_values_for_target(item_in, ingredient, food)
            item = ShoppingListItem(
                id=create_id("shopping"),
                family_id=family_id,
                ingredient_id=target_values["ingredient_id"],
                food_id=target_values["food_id"],
                title=target_values["title"],
                quantity=Decimal(str(item_in.quantity or 1)),
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
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.CREATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI 加入购物清单 {item.title}",
            )
            results.append({"operationId": operation.get("operationId"), "action": "create", "item": serialize_shopping_item(item)})
            entity_ids.append(item.id)
            continue
        try:
            item = lock_inventory_targets(
                db,
                family_id=family_id,
                shopping_item_ids=[str(operation["targetId"])],
            ).shopping_items[str(operation["targetId"])]
        except (InventoryTargetNotFoundError, KeyError):
            raise AIConflictError("购物项不存在或已被删除")
        assert_updated_at_matches(
            actual=item.updated_at,
            expected=str(operation["baseUpdatedAt"]),
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
            item.done = done
            item.updated_by = user_id
            db.flush()
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI {'完成' if done else '恢复'}购物项 {item.title}",
            )
            results.append({"operationId": operation.get("operationId"), "action": "set_done", "item": serialize_shopping_item(item)})
            entity_ids.append(item.id)
            continue
        item_in = CreateShoppingListItemRequest.model_validate(operation.get("payload") or {})
        ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
        target_values = _shopping_values_for_target(item_in, ingredient, food)
        item.ingredient_id = target_values["ingredient_id"]
        item.food_id = target_values["food_id"]
        item.title = target_values["title"]
        item.quantity = Decimal(str(item_in.quantity or 1))
        item.unit = target_values["unit"]
        item.quantity_mode = target_values["quantity_mode"]
        item.display_label = target_values["display_label"]
        item.reason = item_in.reason
        item.updated_by = user_id
        db.flush()
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="ShoppingListItem",
            entity_id=item.id,
            summary=f"AI 更新购物项 {item.title}",
        )
        results.append({"operationId": operation.get("operationId"), "action": "update", "item": serialize_shopping_item(item)})
        entity_ids.append(item.id)
    return {"operations": results}, list(dict.fromkeys(entity_ids))


def _create_shopping_items_from_payload(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    created: list[ShoppingListItem] = []
    for item_payload in payload.get("items") or []:
        item_in = CreateShoppingListItemRequest.model_validate(item_payload)
        ingredient, food = _require_shopping_target(db, family_id=family_id, item_in=item_in)
        target_values = _shopping_values_for_target(item_in, ingredient, food)
        item = ShoppingListItem(
            id=create_id("shopping"),
            family_id=family_id,
            ingredient_id=target_values["ingredient_id"],
            food_id=target_values["food_id"],
            title=target_values["title"],
            quantity=Decimal(str(item_in.quantity or 1)),
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
    return {"items": [serialize_shopping_item(item) for item in created]}, [item.id for item in created]


def _operation_error_message(operation: dict[str, Any], exc: Exception) -> str:
    operation_id = str(operation.get("operationId") or "").strip() or "unknown"
    return f"操作 {operation_id} 失败：{exc}"
