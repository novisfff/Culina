from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.draft_validation import normalize_meal_log_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.workflows.runner_support.attachments import validate_current_attachment_ids
from app.ai.tools.schemas import MEAL_LOG_DRAFT_SCHEMA, READ_BY_ID_INPUT, SEARCH_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Food, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import serialize_meal_log


MEAL_LOG_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "date", "mealType", "rowVersion"],
    "properties": {
        "id": {"type": "string"},
        "date": {"type": "string"},
        "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
        "foods": {"type": "array", "items": {"type": "object"}},
        "foodEntries": {"type": "array", "items": {"type": "object"}},
        "participantUserIds": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": ["string", "null"]},
        "mood": {"type": ["string", "null"]},
        "photos": {"type": "array", "items": {"type": "object"}},
        "rowVersion": {"type": "integer", "minimum": 1},
        "deductionSuggestions": {"type": "array", "items": {"type": "object"}},
        "createdAt": {"type": ["string", "null"]},
        "updatedAt": {"type": ["string", "null"]},
    },
}

MEAL_LOG_LIST_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": MEAL_LOG_ITEM_OUTPUT},
    },
}

MEAL_LOG_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": MEAL_LOG_ITEM_OUTPUT},
}


def _tool_date(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _tool_enum(value: Any) -> str:
    return value.value if hasattr(value, "value") else str(value)


def _tool_datetime(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _serialize_meal_log_tool_item(
    meal_log: MealLog,
    media_map: dict[tuple[str, str], list[Any]],
) -> dict[str, Any]:
    record = serialize_meal_log(meal_log, media_map)
    food_entries = [
        {
            "id": entry["id"],
            "foodId": entry["food_id"],
            "foodName": entry["food_name"],
            "servings": entry["servings"],
            "note": entry["note"],
            "rating": entry["rating"],
        }
        for entry in record["food_entries"]
    ]
    return {
        "id": record["id"],
        "date": _tool_date(record["date"]),
        "mealType": _tool_enum(record["meal_type"]),
        "foods": food_entries,
        "foodEntries": food_entries,
        "participantUserIds": list(record["participant_user_ids"] or []),
        "notes": record["notes"],
        "mood": record["mood"],
        "photos": record["photos"],
        "rowVersion": int(record["row_version"]),
        "deductionSuggestions": [
            {
                "id": item["id"],
                "ingredientName": item["ingredient_name"],
                "suggestedAmount": item["suggested_amount"],
                "unit": item["unit"],
                "basedOnFoodName": item["based_on_food_name"],
            }
            for item in record["deduction_suggestions"]
        ],
        "createdAt": _tool_datetime(record["created_at"]),
        "updatedAt": _tool_datetime(record["updated_at"]),
    }


def meal_log_read_recent(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 8)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    meal_type = str(payload.get("mealType") or payload.get("meal_type") or "").strip()
    date_from = str(payload.get("dateFrom") or payload.get("date_from") or "").strip()
    date_to = str(payload.get("dateTo") or payload.get("date_to") or "").strip()
    statement = (
        select(MealLog)
        .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
        .where(MealLog.family_id == context.family_id)
    )
    if ids:
        statement = statement.where(MealLog.id.in_(ids))
    if meal_type:
        statement = statement.where(MealLog.meal_type == meal_type)
    if date_from:
        statement = statement.where(MealLog.date >= date_from)
    if date_to:
        statement = statement.where(MealLog.date <= date_to)
    if query:
        pattern = query if exact else f"%{query}%"
        food_name_clause = Food.name == query if exact else Food.name.ilike(pattern)
        food_clause = MealLog.food_entries.any(MealLogFood.food.has(food_name_clause))
        notes_clause = MealLog.notes == query if exact else MealLog.notes.ilike(pattern)
        mood_clause = MealLog.mood == query if exact else MealLog.mood.ilike(pattern)
        statement = statement.where(or_(notes_clause, mood_clause, food_clause))
    logs = list(
        context.db.scalars(
            statement.order_by(MealLog.date.desc(), MealLog.created_at.desc()).offset(offset).limit(limit + 1)
        )
    )
    has_more = len(logs) > limit
    logs = logs[:limit]
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="meal_log",
            entity_ids=[item.id for item in logs],
        )
    )
    return {
        "items": [
            _serialize_meal_log_tool_item(item, media_map)
            for item in logs
        ],
        "count": len(logs),
        "hasMore": has_more,
    }


def meal_log_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    meal_log = context.db.scalar(
        select(MealLog)
        .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
        .where(MealLog.family_id == context.family_id, MealLog.id == str(payload["id"]))
    )
    if meal_log is None:
        raise ValueError("餐食记录不存在或不属于当前家庭")
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="meal_log",
            entity_ids=[meal_log.id],
        )
    )
    return {"item": _serialize_meal_log_tool_item(meal_log, media_map)}


def meal_log_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_meal_log_draft(context.db, family_id=context.family_id, user_id=context.user_id, payload=draft)
    meal_payload = (
        normalized.get("payload")
        if normalized.get("action") in {"create", "update_details"}
        else normalized
    )
    if isinstance(meal_payload, dict):
        meal_payload["mediaIds"] = validate_current_attachment_ids(
            context.db,
            family_id=context.family_id,
            requested_media_ids=meal_payload.get("mediaIds") or [],
            current_attachments=context.current_message_attachments,
            existing_entity_type="meal_log" if normalized.get("action") == "update_details" else None,
            existing_entity_id=str(normalized.get("targetId") or "") or None,
        )
    item_count = len(normalized.get("foods") or [])
    if not item_count and isinstance(normalized.get("payload"), dict):
        item_count = len((normalized["payload"].get("foodEntryRatings") or [])) or 1
    return {"draft": normalized, "itemCount": item_count}


def register_meal_log_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="meal_log.read_recent",
        display_name="最近餐食记录",
        description="读取最近餐食记录。",
        side_effect="read",
        handler=meal_log_read_recent,
        input_schema={
            **SEARCH_INPUT,
            "properties": {
                **SEARCH_INPUT["properties"],
                "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
                "dateFrom": {"type": "string", "minLength": 10, "maxLength": 10},
                "dateTo": {"type": "string", "minLength": 10, "maxLength": 10},
            },
        },
        output_schema=MEAL_LOG_LIST_OUTPUT,
        requires_followup=True,
        followup_hint="读取近期餐食记录后必须总结相关记录、请求补充信息，或继续生成/调整用餐记录草稿。",
    )
    register_tool(
        registry,
        name="meal_log.read_by_id",
        display_name="餐食记录详情",
        description="读取当前家庭指定餐食记录的完整资料。",
        side_effect="read",
        handler=meal_log_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=MEAL_LOG_READ_OUTPUT,
        requires_followup=True,
        followup_hint="读取餐食记录详情后必须说明可复用内容、请求补充信息，或继续生成/调整用餐记录草稿。",
    )
    register_tool(
        registry,
        name="meal_log.create_draft",
        display_name="餐食记录确认表单",
        description="生成餐食记录草稿，不写入业务表。",
        side_effect="draft",
        handler=meal_log_create_draft,
        input_schema=draft_input_schema(MEAL_LOG_DRAFT_SCHEMA),
        output_schema=draft_output_schema(MEAL_LOG_DRAFT_SCHEMA),
        draft_types=["meal_log"],
    )
