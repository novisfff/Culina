from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, LIMIT_INPUT, MEAL_LOG_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.models.domain import MealLog


def meal_log_read_recent(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 8)
    logs = list(
        context.db.scalars(
            select(MealLog)
            .where(MealLog.family_id == context.family_id)
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
            .limit(limit)
        )
    )
    return {
        "items": [
            {
                "id": item.id,
                "date": item.date.isoformat(),
                "mealType": item.meal_type.value if hasattr(item.meal_type, "value") else str(item.meal_type),
                "notes": item.notes,
            }
            for item in logs
        ],
        "count": len(logs),
    }


def meal_log_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    return {"draft": draft, "itemCount": len(draft.get("foods", []) or [])}


def register_meal_log_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="meal_log.read_recent",
        description="读取最近餐食记录。",
        side_effect="read",
        handler=meal_log_read_recent,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="meal_log.create_draft",
        description="生成餐食记录草稿，不写入业务表。",
        side_effect="draft",
        handler=meal_log_create_draft,
        input_schema=draft_input_schema(MEAL_LOG_DRAFT_SCHEMA),
        output_schema=draft_output_schema(MEAL_LOG_DRAFT_SCHEMA),
    )
