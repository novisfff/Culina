from __future__ import annotations

from typing import Any

from decimal import Decimal, InvalidOperation

from sqlalchemy import or_, select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.draft_validation import normalize_shopping_list_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import (
    READ_BY_ID_INPUT,
    SHOPPING_LIST_DRAFT_SCHEMA,
    draft_input_schema,
    draft_output_schema,
)
from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import Food, Ingredient, ShoppingListItem


SHOPPING_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "ingredientId", "foodId", "targetType", "title", "quantity", "unit", "quantityMode", "done"],
    "properties": {
        "id": {"type": "string"},
        "ingredientId": {"type": ["string", "null"]},
        "foodId": {"type": ["string", "null"]},
        "targetType": {"type": "string", "enum": ["ingredient", "food"]},
        "title": {"type": "string"},
        "quantity": {"type": "number"},
        "unit": {"type": "string"},
        "quantityMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
        "displayLabel": {"type": ["string", "null"]},
        "reason": {"type": ["string", "null"]},
        "done": {"type": "boolean"},
        "updatedAt": {"type": ["string", "null"]},
    },
}

SHOPPING_LIST_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": SHOPPING_ITEM_OUTPUT},
    },
}

SHOPPING_ITEM_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": SHOPPING_ITEM_OUTPUT},
}

SHOPPING_INTAKE_MATCH_OUTPUT = {
    "type": "object",
    "additionalProperties": True,
    "required": ["clientKey", "label", "matchLevel", "matchReason"],
    "properties": {
        "clientKey": {"type": "string"},
        "label": {"type": "string"},
        "matchLevel": {"type": "string", "enum": ["confirmed", "suggested", "ambiguous", "unmatched"]},
        "matchReason": {"type": "string"},
    },
}

SHOPPING_INTAKE_CANDIDATES_OUTPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["confirmedMatches", "suggestedMatches", "ambiguousMatches", "unmatchedCandidates"],
    "properties": {
        "confirmedMatches": {"type": "array", "items": SHOPPING_INTAKE_MATCH_OUTPUT},
        "suggestedMatches": {"type": "array", "items": SHOPPING_INTAKE_MATCH_OUTPUT},
        "ambiguousMatches": {"type": "array", "items": SHOPPING_INTAKE_MATCH_OUTPUT},
        "unmatchedCandidates": {"type": "array", "items": SHOPPING_INTAKE_MATCH_OUTPUT},
    },
}


def _candidate_decimal(value: Any) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("小票行数量格式不正确") from exc
    if parsed <= 0:
        raise ValueError("小票行数量必须大于 0")
    return format(parsed.normalize(), "f")


def _normalized_match_label(value: Any) -> str:
    return "".join(str(value or "").strip().lower().split())


def _shopping_candidate_payload(context: ToolContext, item: ShoppingListItem) -> dict[str, Any]:
    target: dict[str, Any] | None = None
    if item.ingredient_id:
        ingredient = context.db.scalar(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id == item.ingredient_id,
            )
        )
        if ingredient is not None:
            target = {
                "targetKind": (
                    "exact_ingredient"
                    if ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
                    else "presence_ingredient"
                ),
                "targetId": ingredient.id,
                "targetName": ingredient.name,
                "expectedTargetRowVersion": ingredient.row_version,
                "defaultStorageLocation": ingredient.default_storage,
            }
    elif item.food_id:
        food = context.db.scalar(
            select(Food).where(Food.family_id == context.family_id, Food.id == item.food_id)
        )
        if food is not None:
            target = {
                "targetKind": "food",
                "targetId": food.id,
                "targetName": food.name,
                "expectedTargetRowVersion": food.row_version,
                "defaultStorageLocation": food.storage_location or "",
            }
    return {
        "id": item.id,
        "title": item.title,
        "quantity": format(Decimal(str(item.quantity)).normalize(), "f"),
        "unit": item.unit,
        "expectedRowVersion": item.row_version,
        "target": target,
    }


def shopping_preview_intake_candidates(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    lines = payload.get("lines")
    if not isinstance(lines, list) or not lines:
        raise ValueError("采购识别行不能为空")
    pending = list(
        context.db.scalars(
            select(ShoppingListItem)
            .where(
                ShoppingListItem.family_id == context.family_id,
                ShoppingListItem.done.is_(False),
            )
            .order_by(ShoppingListItem.updated_at.desc(), ShoppingListItem.id)
        )
    )
    pending_by_id = {item.id: item for item in pending}
    results: dict[str, list[dict[str, Any]]] = {
        "confirmedMatches": [],
        "suggestedMatches": [],
        "ambiguousMatches": [],
        "unmatchedCandidates": [],
    }
    for offset, line in enumerate(lines):
        if not isinstance(line, dict):
            raise ValueError("采购识别行格式不正确")
        client_key = str(line.get("clientKey") or f"line-{offset + 1}").strip()[:64]
        label = str(line.get("label") or "").strip()
        if not label:
            raise ValueError("采购识别行名称不能为空")
        common = {
            "clientKey": client_key,
            "label": label[:120],
            "enteredQuantity": _candidate_decimal(line.get("enteredQuantity")),
            "enteredUnit": str(line.get("enteredUnit") or "").strip()[:32] or None,
        }
        explicit_id = str(line.get("shoppingItemId") or "").strip()
        if explicit_id:
            explicit = pending_by_id.get(explicit_id)
            if explicit is None:
                raise ValueError("指定购物项不存在、已完成或不属于当前家庭")
            results["confirmedMatches"].append(
                {
                    **common,
                    "matchLevel": "confirmed",
                    "matchReason": "用户、卡片或当前会话明确指定了真实待买项",
                    "shoppingItem": _shopping_candidate_payload(context, explicit),
                }
            )
            continue

        normalized_label = _normalized_match_label(label)
        exact = [item for item in pending if _normalized_match_label(item.title) == normalized_label]
        if len(exact) == 1:
            results["confirmedMatches"].append(
                {
                    **common,
                    "matchLevel": "confirmed",
                    "matchReason": "名称与唯一待买项完全一致",
                    "shoppingItem": _shopping_candidate_payload(context, exact[0]),
                }
            )
            continue
        if len(exact) > 1:
            results["ambiguousMatches"].append(
                {
                    **common,
                    "matchLevel": "ambiguous",
                    "matchReason": "存在多个同名待买项，需要按单位或真实目标选择",
                    "shoppingCandidates": [_shopping_candidate_payload(context, item) for item in exact],
                }
            )
            continue
        fuzzy = [
            item
            for item in pending
            if _normalized_match_label(item.title)
            and (
                _normalized_match_label(item.title) in normalized_label
                or normalized_label in _normalized_match_label(item.title)
            )
        ]
        if len(fuzzy) == 1:
            results["suggestedMatches"].append(
                {
                    **common,
                    "matchLevel": "suggested",
                    "matchReason": "标题不完全一致，但只有一个名称包含关系明确的待买项",
                    "shoppingItem": _shopping_candidate_payload(context, fuzzy[0]),
                }
            )
            continue
        if len(fuzzy) > 1:
            results["ambiguousMatches"].append(
                {
                    **common,
                    "matchLevel": "ambiguous",
                    "matchReason": "存在多个名称相近的待买项，需要用户选择",
                    "shoppingCandidates": [_shopping_candidate_payload(context, item) for item in fuzzy],
                }
            )
            continue

        target_hint = str(line.get("targetHint") or "ingredient")
        if target_hint == "food":
            recommendation_type = "food_profile"
            recommendation = "未匹配到现有待买项；建议先创建对应成品食物资料，再单独登记库存"
        else:
            recommendation_type = "ingredient_profile"
            recommendation = "未匹配到现有待买项；建议先创建对应食材档案，再单独登记库存"
        results["unmatchedCandidates"].append(
            {
                **common,
                "matchLevel": "unmatched",
                "matchReason": "没有可匹配的当前待买项，不进入本次事务",
                "recommendationType": recommendation_type,
                "recommendation": recommendation,
                "candidateIds": [],
            }
        )
    return results


def shopping_read_pending(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 50)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    status = str(payload.get("status") or "pending")
    statement = select(ShoppingListItem).where(ShoppingListItem.family_id == context.family_id)
    if status == "pending":
        statement = statement.where(ShoppingListItem.done.is_(False))
    elif status == "completed":
        statement = statement.where(ShoppingListItem.done.is_(True))
    if ids:
        statement = statement.where(ShoppingListItem.id.in_(ids))
    if query:
        if exact:
            statement = statement.where(or_(ShoppingListItem.title == query, ShoppingListItem.reason == query))
        else:
            pattern = f"%{query}%"
            statement = statement.where(or_(ShoppingListItem.title.ilike(pattern), ShoppingListItem.reason.ilike(pattern)))
    items = list(
        context.db.scalars(
            statement.order_by(ShoppingListItem.updated_at.desc(), ShoppingListItem.id).offset(offset).limit(limit + 1)
        )
    )
    has_more = len(items) > limit
    items = items[:limit]
    return {
        "items": [serialize_shopping_tool_item(item) for item in items],
        "count": len(items),
        "hasMore": has_more,
    }


def serialize_shopping_tool_item(item: ShoppingListItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "ingredientId": item.ingredient_id,
        "foodId": item.food_id,
        "targetType": "food" if item.food_id else "ingredient",
        "title": item.title,
        "quantity": float(item.quantity),
        "unit": item.unit,
        "quantityMode": item.quantity_mode.value if hasattr(item.quantity_mode, "value") else item.quantity_mode,
        "displayLabel": item.display_label,
        "reason": item.reason,
        "done": item.done,
        "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
    }


def shopping_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    item = context.db.scalar(
        select(ShoppingListItem).where(
            ShoppingListItem.family_id == context.family_id,
            ShoppingListItem.id == str(payload["id"]),
        )
    )
    if item is None:
        raise ValueError("购物项不存在或不属于当前家庭")
    return {"item": serialize_shopping_tool_item(item)}


def shopping_list_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    if any(
        isinstance(operation, dict)
        and operation.get("action") == "set_done"
        and isinstance(operation.get("payload"), dict)
        and operation["payload"].get("done") is True
        for operation in draft.get("operations") or []
    ):
        raise ValueError("完成购物项请改用 inventory.create_intake_draft，在一份审批中同时处理购物状态和库存")
    normalized = normalize_shopping_list_draft(
        context.db,
        family_id=context.family_id,
        conversation_id=context.conversation_id,
        payload=draft,
    )
    item_count = len(normalized.get("operations") or normalized.get("items") or [])
    return {"draft": normalized, "itemCount": item_count}


def register_shopping_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="shopping.preview_intake_candidates",
        display_name="采购小票匹配预览",
        description="将小票或用户列出的采购行与当前家庭真实待买项匹配，分为确认、建议、歧义和未匹配四组；不会修改数据。",
        side_effect="read",
        handler=shopping_preview_intake_candidates,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "required": ["lines"],
            "properties": {
                "lines": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["label"],
                        "properties": {
                            "clientKey": {"type": "string", "maxLength": 64},
                            "label": {"type": "string", "minLength": 1, "maxLength": 120},
                            "shoppingItemId": {"type": "string", "maxLength": 64},
                            "enteredQuantity": {"type": ["string", "number", "null"]},
                            "enteredUnit": {"type": ["string", "null"], "maxLength": 32},
                            "targetHint": {"type": "string", "enum": ["ingredient", "food"]},
                        },
                    },
                }
            },
        },
        output_schema=SHOPPING_INTAKE_CANDIDATES_OUTPUT,
        requires_followup=True,
        followup_hint="匹配预览后必须让用户处理歧义项、说明未匹配额外购买候选，或继续生成 shopping_intake 草稿。",
    )
    register_tool(
        registry,
        name="shopping.read_pending",
        display_name="待采购清单",
        description="按 pending、completed 或 all 状态读取当前家庭待采购或已完成购物项。",
        side_effect="read",
        handler=shopping_read_pending,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "maxLength": 100},
                "ids": {"type": "array", "maxItems": 50, "items": {"type": "string", "minLength": 1}},
                "exact": {"type": "boolean"},
                "status": {
                    "type": "string",
                    "enum": ["pending", "completed", "all"],
                    "default": "pending",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0, "maximum": 1000},
            },
        },
        output_schema=SHOPPING_LIST_OUTPUT,
        requires_followup=True,
        followup_hint="读取待采购清单后必须总结待处理项目、请求补充信息，或继续生成/调整购物清单草稿。",
    )
    register_tool(
        registry,
        name="shopping.read_by_id",
        display_name="购物项详情",
        description="读取当前家庭指定购物项的完整内容。",
        side_effect="read",
        handler=shopping_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=SHOPPING_ITEM_READ_OUTPUT,
        requires_followup=True,
        followup_hint="读取购物项详情后必须说明可调整项、请求补充信息，或继续生成/调整购物清单草稿。",
    )
    register_tool(
        registry,
        name="shopping.create_draft",
        display_name="购物清单确认表单",
        description="生成购物清单草稿，不写入业务表。",
        side_effect="draft",
        handler=shopping_list_create_draft,
        input_schema=draft_input_schema(SHOPPING_LIST_DRAFT_SCHEMA),
        output_schema=draft_output_schema(SHOPPING_LIST_DRAFT_SCHEMA),
        draft_types=["shopping_list"],
    )
