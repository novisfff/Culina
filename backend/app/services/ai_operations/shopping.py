from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.models.domain import ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.serializers import serialize_shopping_item


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


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
            item = ShoppingListItem(
                id=create_id("shopping"),
                family_id=family_id,
                title=item_in.title,
                quantity=Decimal(str(item_in.quantity)),
                unit=item_in.unit,
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
        item = db.scalar(
            select(ShoppingListItem)
            .where(ShoppingListItem.family_id == family_id, ShoppingListItem.id == str(operation["targetId"]))
            .with_for_update()
        )
        if item is None:
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
        item.title = item_in.title
        item.quantity = Decimal(str(item_in.quantity))
        item.unit = item_in.unit
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
        item = ShoppingListItem(
            id=create_id("shopping"),
            family_id=family_id,
            title=item_in.title,
            quantity=Decimal(str(item_in.quantity)),
            unit=item_in.unit,
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
