from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.draft_validation import normalize_meal_plan_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, MEAL_PLAN_DRAFT_SCHEMA, READ_BY_ID_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Food, FoodPlanItem
from app.services.clock import today_for_family
from app.services.serializers import serialize_food_plan_item


def meal_plan_read_existing(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    limit = int(payload.get("limit") or 20)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    meal_type = str(payload.get("mealType") or "").strip()
    recipe_id = str(payload.get("recipeId") or "").strip()
    plan_date = str(payload.get("planDate") or payload.get("date") or "").strip()
    statement = (
        select(FoodPlanItem)
        .options(selectinload(FoodPlanItem.food))
        .where(
            FoodPlanItem.family_id == context.family_id,
            FoodPlanItem.user_id == context.user_id,
            FoodPlanItem.plan_date >= today,
        )
    )
    if ids:
        statement = statement.where(FoodPlanItem.id.in_(ids))
    if meal_type:
        statement = statement.where(FoodPlanItem.meal_type == meal_type)
    if recipe_id:
        statement = statement.where(FoodPlanItem.food.has(Food.recipe_id == recipe_id))
    if plan_date:
        try:
            parsed_plan_date = date.fromisoformat(plan_date)
        except ValueError as exc:
            raise ValueError("计划日期格式不正确") from exc
        statement = statement.where(FoodPlanItem.plan_date == parsed_plan_date)
    if query:
        if exact:
            statement = statement.where(or_(FoodPlanItem.note == query, FoodPlanItem.food.has(Food.name == query)))
        else:
            pattern = f"%{query}%"
            statement = statement.where(
                or_(FoodPlanItem.note.ilike(pattern), FoodPlanItem.food.has(Food.name.ilike(pattern)))
            )
    plans = list(
        context.db.scalars(
            statement.order_by(FoodPlanItem.plan_date.asc(), FoodPlanItem.id.asc()).offset(offset).limit(limit + 1)
        )
    )
    has_more = len(plans) > limit
    plans = plans[:limit]
    return {
        "items": [
            {
                "id": item.id,
                "date": item.plan_date.isoformat(),
                "mealType": item.meal_type.value if hasattr(item.meal_type, "value") else str(item.meal_type),
                "title": item.food.name if item.food else (item.note or "未命名餐食"),
                "foodId": item.food_id,
                "note": item.note,
                "status": item.status,
                "recipeId": item.food.recipe_id if item.food is not None else None,
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
            }
            for item in plans
        ],
        "count": len(plans),
        "hasMore": has_more,
    }


def meal_plan_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    item = context.db.scalar(
        select(FoodPlanItem)
        .options(selectinload(FoodPlanItem.food))
        .where(
            FoodPlanItem.family_id == context.family_id,
            FoodPlanItem.user_id == context.user_id,
            FoodPlanItem.id == str(payload["id"]),
        )
    )
    if item is None:
        raise ValueError("餐食计划不存在或不属于当前用户")
    return {"item": serialize_food_plan_item(item)}


def meal_plan_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_meal_plan_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=draft,
    )
    item_count = len(normalized.get("operations") or normalized.get("items") or [])
    return {"draft": normalized, "itemCount": item_count}


def register_meal_plan_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="meal_plan.read_existing",
        display_name="已有餐食计划",
        description="读取已有餐食计划。",
        side_effect="read",
        handler=meal_plan_read_existing,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "maxLength": 100},
                "ids": {"type": "array", "maxItems": 50, "items": {"type": "string", "minLength": 1}},
                "exact": {"type": "boolean"},
                "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
                "recipeId": {"type": "string", "minLength": 1},
                "planDate": {"type": "string", "format": "date"},
                "date": {"type": "string", "format": "date"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0, "maximum": 1000},
            },
        },
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="meal_plan.read_by_id",
        display_name="餐食计划详情",
        description="读取当前用户指定计划项的完整内容。",
        side_effect="read",
        handler=meal_plan_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema={"type": "object", "required": ["item"], "properties": {"item": {"type": "object"}}},
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
