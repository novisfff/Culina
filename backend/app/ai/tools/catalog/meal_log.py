from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.draft_validation import normalize_meal_log_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, MEAL_LOG_DRAFT_SCHEMA, READ_BY_ID_INPUT, SEARCH_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Food, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import serialize_meal_log


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
            {
                **serialize_meal_log(item, media_map),
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
            }
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
    return {"item": serialize_meal_log(meal_log, media_map)}


def meal_log_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_meal_log_draft(context.db, family_id=context.family_id, user_id=context.user_id, payload=draft)
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
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="meal_log.read_by_id",
        display_name="餐食记录详情",
        description="读取当前家庭指定餐食记录的完整资料。",
        side_effect="read",
        handler=meal_log_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema={"type": "object", "required": ["item"], "properties": {"item": {"type": "object"}}},
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
    )
