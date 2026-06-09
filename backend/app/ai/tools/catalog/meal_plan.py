from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, LIMIT_INPUT, MEAL_PLAN_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.models.domain import FoodPlanItem


def meal_plan_read_existing(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = date.today()
    limit = int(payload.get("limit") or 20)
    plans = list(
        context.db.scalars(
            select(FoodPlanItem)
            .options(selectinload(FoodPlanItem.food))
            .where(FoodPlanItem.family_id == context.family_id, FoodPlanItem.plan_date >= today)
            .order_by(FoodPlanItem.plan_date.asc())
            .limit(limit)
        )
    )
    return {
        "items": [
            {
                "id": item.id,
                "date": item.plan_date.isoformat(),
                "mealType": item.meal_type.value if hasattr(item.meal_type, "value") else str(item.meal_type),
                "title": item.food.name if item.food else (item.note or "未命名餐食"),
                "foodId": item.food_id,
                "note": item.note,
            }
            for item in plans
        ],
        "count": len(plans),
    }


def meal_plan_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    items = draft.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("餐食计划草稿不能为空")
    return {"draft": draft, "itemCount": len(items)}


def register_meal_plan_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="meal_plan.read_existing",
        display_name="已有餐食计划",
        description="读取已有餐食计划。",
        side_effect="read",
        handler=meal_plan_read_existing,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="meal_plan.create_draft",
        display_name="餐食计划确认表单",
        description="生成餐食计划草稿，不写入业务表。",
        side_effect="draft",
        handler=meal_plan_create_draft,
        input_schema=draft_input_schema(MEAL_PLAN_DRAFT_SCHEMA),
        output_schema=draft_output_schema(MEAL_PLAN_DRAFT_SCHEMA),
    )
