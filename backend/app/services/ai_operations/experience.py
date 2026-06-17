from __future__ import annotations

from collections.abc import Callable
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import create_id, utcnow
from app.models.domain import AIApprovalRequest, AIConversation, AIMessage, AITaskDraft, FoodPlanItem
from app.services.clock import today_for_family
from app.services.inventory_operations import require_inventory_item
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft

CreateDraftApproval = Callable[..., tuple[AITaskDraft, AIApprovalRequest]]


def record_recommendation_selection_for_card(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    message_id: str,
    part_id: str,
    card_id: str,
    entity_id: str,
    food_plan_item_id: str,
) -> AIMessage:
    message = db.scalar(
        select(AIMessage)
        .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
        .with_for_update()
    )
    if message is None:
        raise LookupError("AI 消息不存在")
    plan_item = db.scalar(
        select(FoodPlanItem)
        .where(FoodPlanItem.id == food_plan_item_id, FoodPlanItem.family_id == family_id)
        .with_for_update()
    )
    if plan_item is None:
        raise LookupError("菜单计划不存在")

    selected_name = ""
    next_parts: list[dict[str, Any]] = []
    matched = False
    for part in message.parts or []:
        if part.get("id") != part_id or not isinstance(part.get("card"), dict):
            next_parts.append(part)
            continue
        card = dict(part["card"])
        effective_card_id = card.get("id") if isinstance(card.get("id"), str) and card["id"].strip() else f"{part_id}-card"
        if effective_card_id != card_id or card.get("type") != "today_recommendation":
            next_parts.append(part)
            continue
        card["id"] = effective_card_id
        if not isinstance(card.get("title"), str) or not card["title"].strip():
            card["title"] = "今日吃什么"
        data = dict(card.get("data") or {})
        recommendations = []
        for item in data.get("recommendations") or []:
            if not isinstance(item, dict) or str(item.get("entityId") or "") != entity_id:
                recommendations.append(item)
                continue
            if str(item.get("foodId") or "") != plan_item.food_id:
                raise ValueError("推荐食物与菜单计划不一致")
            selected_name = str(item.get("name") or (plan_item.food.name if plan_item.food else "推荐食物"))
            recommendations.append(
                {
                    **item,
                    "planSelection": {
                        "foodPlanItemId": plan_item.id,
                        "foodId": plan_item.food_id,
                        "name": selected_name,
                        "planDate": plan_item.plan_date.isoformat(),
                        "mealType": plan_item.meal_type.value if hasattr(plan_item.meal_type, "value") else str(plan_item.meal_type),
                        "selectedAt": utcnow().isoformat(),
                        "selectedBy": user_id,
                    },
                }
            )
            matched = True
        data["recommendations"] = recommendations
        next_parts.append({**part, "card": {**card, "data": data}})
    if not matched:
        raise ValueError("推荐卡片中没有找到对应食物")

    selection = {
        "messageId": message.id,
        "cardId": card_id,
        "entityId": entity_id,
        "foodPlanItemId": plan_item.id,
        "foodId": plan_item.food_id,
        "name": selected_name,
        "planDate": plan_item.plan_date.isoformat(),
        "mealType": plan_item.meal_type.value if hasattr(plan_item.meal_type, "value") else str(plan_item.meal_type),
    }
    metadata = dict(message.message_metadata or {})
    existing_selections = [
        item
        for item in metadata.get("recommendationSelections") or []
        if isinstance(item, dict) and item.get("foodPlanItemId") != plan_item.id
    ]
    metadata["recommendationSelections"] = [*existing_selections, selection]
    message.parts = next_parts
    message.message_metadata = metadata

    conversation = db.scalar(
        select(AIConversation).where(AIConversation.id == message.conversation_id, AIConversation.family_id == family_id)
    )
    if conversation is None:
        raise LookupError("会话不存在")
    context = dict(conversation.context or {})
    context_selections = [
        item
        for item in context.get("recommendationSelections") or []
        if isinstance(item, dict) and item.get("foodPlanItemId") != plan_item.id
    ]
    context["recommendationSelections"] = [*context_selections[-9:], selection]
    conversation.context = context
    conversation.last_message_at = utcnow()
    db.flush()
    return message


def create_inventory_quick_draft_from_card(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    message_id: str,
    part_id: str,
    card_id: str,
    item_id: str,
    action: str,
    create_draft_approval: CreateDraftApproval,
) -> AIMessage:
    message = db.scalar(
        select(AIMessage)
        .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
        .with_for_update()
    )
    if message is None:
        raise LookupError("AI 消息不存在")
    matched_item: dict[str, Any] | None = None
    effective_card_id = ""
    for part in message.parts or []:
        if part.get("id") != part_id or not isinstance(part.get("card"), dict):
            continue
        card = part["card"]
        effective_card_id = (
            str(card.get("id"))
            if isinstance(card.get("id"), str) and str(card.get("id")).strip()
            else f"{part_id}-card"
        )
        if effective_card_id != card_id or card.get("type") != "inventory_summary":
            continue
        for item in (card.get("data") or {}).get("items") or []:
            if isinstance(item, dict) and str(item.get("id") or "") == item_id:
                matched_item = item
                break
    if matched_item is None:
        raise ValueError("库存卡片中没有找到对应批次")
    if action not in {"restock", "consume", "dispose"}:
        raise ValueError("不支持的库存操作")

    inventory_item = require_inventory_item(
        db,
        family_id=family_id,
        inventory_item_id=item_id,
    )
    available = max(Decimal(str(matched_item.get("quantity") or 0)), Decimal("0"))
    if action != "restock" and available <= 0:
        raise ValueError("该库存批次已无剩余数量")
    quantity = Decimal("1") if action != "dispose" else available
    if action == "consume":
        quantity = min(quantity, available)
    raw_operation: dict[str, Any] = {
        "action": action,
        "ingredientId": inventory_item.ingredient_id,
        "inventoryItemId": inventory_item.id if action != "restock" else None,
        "quantity": float(quantity),
        "unit": str(matched_item.get("unit") or inventory_item.unit),
        "reason": "用户从库存卡发起销毁" if action == "dispose" else "",
    }
    if action == "restock":
        raw_operation.update(
            {
                "purchaseDate": today_for_family(family_id).isoformat(),
                "storageLocation": inventory_item.storage_location,
                "status": (
                    inventory_item.status.value
                    if hasattr(inventory_item.status, "value")
                    else str(inventory_item.status)
                ),
                "notes": "",
                "lowStockThreshold": float(inventory_item.low_stock_threshold or 0),
            }
        )
    draft_payload = {
        "draft_type": "inventory_operation",
        "schema_version": "inventory_operation.v1",
        "payload": {
            "draftType": "inventory_operation",
            "schemaVersion": "inventory_operation.v1",
            "operations": [raw_operation],
            "source": {
                "messageId": message.id,
                "partId": part_id,
                "cardId": effective_card_id,
                "itemId": item_id,
                "action": action,
            },
        },
    }
    draft, approval = create_draft_approval(
        family_id=family_id,
        user_id=user_id,
        conversation_id=message.conversation_id,
        message_id=message.id,
        run_id=message.run_id,
        draft_payload=draft_payload,
    )
    message.parts = [
        *(message.parts or []),
        {
            "id": create_id("ai_part"),
            "type": "draft",
            "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
        },
        {
            "id": create_id("ai_part"),
            "type": "approval_request",
            "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
        },
    ]
    metadata = dict(message.message_metadata or {})
    metadata["lastInventoryDraft"] = {
        "draftId": draft.id,
        "approvalId": approval.id,
        "action": action,
        "ingredientId": inventory_item.ingredient_id,
        "inventoryItemId": inventory_item.id,
    }
    message.message_metadata = metadata
    db.flush()
    return message
