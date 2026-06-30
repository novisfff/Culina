from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_meal_plan_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import MEAL_PLAN_DRAFT_SCHEMA, READ_BY_ID_INPUT, draft_input_schema, draft_output_schema
from app.core.utils import create_id
from app.models.domain import Food, FoodPlanItem, InventoryItem, MealLog, Recipe
from app.services.clock import today_for_family
from app.services.search.hybrid import hybrid_search
from app.services.serializers import serialize_food_plan_item


MEAL_PLAN_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "date", "mealType", "title", "foodId", "status"],
    "properties": {
        "id": {"type": "string"},
        "date": {"type": "string"},
        "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
        "title": {"type": "string"},
        "foodId": {"type": "string"},
        "note": {"type": ["string", "null"]},
        "status": {"type": "string"},
        "recipeId": {"type": ["string", "null"]},
        "updatedAt": {"type": ["string", "null"]},
    },
}

MEAL_PLAN_LIST_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": MEAL_PLAN_ITEM_OUTPUT},
    },
}

MEAL_PLAN_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": MEAL_PLAN_ITEM_OUTPUT},
}

RECOMMENDATION_EVIDENCE_INPUT = {
    "type": "object",
    "additionalProperties": True,
    "properties": {
        "id": {"type": ["string", "null"]},
        "type": {"type": ["string", "null"]},
        "label": {"type": ["string", "null"], "maxLength": 120},
        "name": {"type": ["string", "null"], "maxLength": 120},
        "status": {"type": ["string", "null"], "maxLength": 40},
        "displayStatus": {"type": ["string", "null"], "maxLength": 40},
        "quantity": {"type": ["string", "number", "null"]},
        "unit": {"type": ["string", "null"], "maxLength": 32},
        "expiryDate": {"type": ["string", "null"]},
    },
}

TODAY_RECOMMENDATION_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["recommendations"],
    "properties": {
        "recommendations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "foodId": {"type": ["string", "null"], "minLength": 1},
                    "recipeId": {"type": ["string", "null"], "minLength": 1},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 300},
                    "evidence": {"type": "array", "maxItems": 3, "items": RECOMMENDATION_EVIDENCE_INPUT},
                },
            },
        },
        "targetDate": {"type": ["string", "null"], "format": "date"},
        "mealType": {"type": ["string", "null"], "enum": ["breakfast", "lunch", "dinner", "snack", None]},
    },
}

TODAY_RECOMMENDATION_OUTPUT = {
    "type": "object",
    "required": ["card"],
    "properties": {
        "card": {
            "type": "object",
            "required": ["id", "type", "title", "data"],
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["today_recommendation"]},
                "title": {"type": "string"},
                "data": {"type": "object"},
            },
        }
    },
}


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
        .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
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
    if query and exact:
        statement = statement.where(or_(FoodPlanItem.note == query, FoodPlanItem.food.has(Food.name == query)))
    elif query:
        search_result = hybrid_search(
            context.db,
            family_id=context.family_id,
            user_id=context.user_id,
            query=query,
            scopes=["meal_plan"],
            limit=max(80, (offset + limit + 1) * 4),
            offset=0,
        )
        candidate_ids = [item.entity_id for item in search_result.items if item.entity_type == "meal_plan"]
        if not candidate_ids:
            return {"items": [], "count": 0, "hasMore": False}
        rank_by_id = {item_id: index for index, item_id in enumerate(candidate_ids)}
        statement = statement.where(FoodPlanItem.id.in_(candidate_ids))
        plans = list(context.db.scalars(statement))
        plans.sort(key=lambda item: (rank_by_id.get(item.id, len(rank_by_id)), item.plan_date, item.id))
        has_more = len(plans) > offset + limit
        plans = plans[offset : offset + limit]
        return {
            "items": [serialize_meal_plan_tool_item(item) for item in plans],
            "count": len(plans),
            "hasMore": has_more,
        }
    plans = list(
        context.db.scalars(
            statement.order_by(FoodPlanItem.plan_date.asc(), FoodPlanItem.id.asc()).offset(offset).limit(limit + 1)
        )
    )
    has_more = len(plans) > limit
    plans = plans[:limit]
    return {
        "items": [serialize_meal_plan_tool_item(item) for item in plans],
        "count": len(plans),
        "hasMore": has_more,
    }


def serialize_meal_plan_tool_item(item: FoodPlanItem) -> dict[str, Any]:
    record = serialize_food_plan_item(item)
    meal_type = record["meal_type"]
    plan_date = record["plan_date"]
    updated_at = record["updated_at"]
    return {
        "id": record["id"],
        "date": plan_date.isoformat() if hasattr(plan_date, "isoformat") else str(plan_date),
        "mealType": meal_type.value if hasattr(meal_type, "value") else str(meal_type),
        "title": record.get("food_name") or record.get("note") or "未命名餐食",
        "foodId": record["food_id"],
        "note": record["note"],
        "status": record["status"],
        "recipeId": record.get("recipe_id"),
        "updatedAt": updated_at.isoformat() if hasattr(updated_at, "isoformat") else updated_at,
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
    return {"item": serialize_meal_plan_tool_item(item)}


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


def _remaining_expression():
    return InventoryItem.quantity - InventoryItem.consumed_quantity - InventoryItem.disposed_quantity


def _today_recommendation_context(context: ToolContext) -> dict[str, int]:
    today = today_for_family(context.family_id)
    available_count = context.db.scalar(
        select(func.count(InventoryItem.id)).where(
            InventoryItem.family_id == context.family_id,
            _remaining_expression() > 0,
        )
    )
    expiring_count = context.db.scalar(
        select(func.count(InventoryItem.id)).where(
            InventoryItem.family_id == context.family_id,
            _remaining_expression() > 0,
            InventoryItem.expiry_date.is_not(None),
            InventoryItem.expiry_date >= today,
            InventoryItem.expiry_date <= today + timedelta(days=7),
        )
    )
    recent_ids = list(
        context.db.scalars(
            select(MealLog.id)
            .where(MealLog.family_id == context.family_id)
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
            .limit(30)
        )
    )
    recipe_count = context.db.scalar(select(func.count(Recipe.id)).where(Recipe.family_id == context.family_id))
    return {
        "inventoryCount": int(available_count or 0),
        "expiringCount": int(expiring_count or 0),
        "recentMealCount": len(recent_ids),
        "recipeCount": int(recipe_count or 0),
    }


def _recommendation_evidence(raw_items: Any) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    source_items = raw_items if isinstance(raw_items, list) else []
    for raw in source_items[:3]:
        if not isinstance(raw, dict):
            continue
        label = raw.get("label") or raw.get("name")
        if not label:
            continue
        details: list[str] = []
        if raw.get("quantity") is not None:
            details.append(f"{raw.get('quantity')}{raw.get('unit') or ''}")
        if raw.get("expiryDate"):
            details.append(f"保质期至 {raw.get('expiryDate')}")
        evidence.append(
            {
                "type": str(raw.get("type") or "inventory"),
                "id": raw.get("id"),
                "label": str(label),
                "status": raw.get("displayStatus") or raw.get("status"),
                "detail": " · ".join(details) or None,
            }
        )
    return evidence


def meal_plan_recommend_today(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    raw_recommendations = payload.get("recommendations") if isinstance(payload.get("recommendations"), list) else []
    food_ids = [
        str(item.get("foodId")).strip()
        for item in raw_recommendations
        if isinstance(item, dict) and item.get("foodId")
    ]
    recipe_ids = [
        str(item.get("recipeId")).strip()
        for item in raw_recommendations
        if isinstance(item, dict) and item.get("recipeId")
    ]
    foods = list(
        context.db.scalars(
            select(Food).where(Food.family_id == context.family_id, Food.id.in_(food_ids))
        )
    ) if food_ids else []
    recipes = list(
        context.db.scalars(
            select(Recipe)
            .options(selectinload(Recipe.foods))
            .where(Recipe.family_id == context.family_id, Recipe.id.in_(recipe_ids))
        )
    ) if recipe_ids else []
    foods_by_id = {item.id: item for item in foods}
    recipes_by_id = {item.id: item for item in recipes}
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"food", "recipe"},
        entity_ids=[*foods_by_id.keys(), *recipes_by_id.keys()],
    )
    recommendations: list[dict[str, Any]] = []
    seen_entities: set[tuple[str, str]] = set()
    for raw in raw_recommendations[:3]:
        if not isinstance(raw, dict):
            continue
        food_id = str(raw.get("foodId") or "").strip()
        recipe_id = str(raw.get("recipeId") or "").strip()
        food = foods_by_id.get(food_id) if food_id else None
        recipe = recipes_by_id.get(recipe_id) if recipe_id else None
        if recipe is not None and food is None:
            linked_food = next((item for item in recipe.foods if item.id in foods_by_id), None)
            if linked_food is not None:
                food = linked_food
                food_id = linked_food.id
        entity_type = "food" if food is not None else "recipe" if recipe is not None else ""
        entity_id = food.id if food is not None else recipe.id if recipe is not None else ""
        if not entity_type or not entity_id or (entity_type, entity_id) in seen_entities:
            continue
        seen_entities.add((entity_type, entity_id))
        recipe_difficulty = None
        if recipe is not None:
            recipe_difficulty = recipe.difficulty.value if hasattr(recipe.difficulty, "value") else str(recipe.difficulty)
        recommendations.append(
            {
                "entityType": entity_type,
                "entityId": entity_id,
                "foodId": food_id or None,
                "recipeId": recipe_id or None,
                "name": food.name if food is not None else recipe.title if recipe is not None else "推荐",
                "image": first_entity_media(media_map, entity_type, entity_id),
                "category": food.category if food is not None else None,
                "foodType": food.type if food is not None else None,
                "prepMinutes": recipe.prep_minutes if recipe is not None else None,
                "servings": recipe.servings if recipe is not None else None,
                "difficulty": recipe_difficulty,
                "reason": str(raw.get("reason") or "结合当前家庭数据推荐。"),
                "evidence": _recommendation_evidence(raw.get("evidence")),
            }
        )
    if not recommendations:
        raise ValueError("即时推荐必须引用当前家庭真实存在的 foodId 或 recipeId")
    target_date = str(payload.get("targetDate") or "") or today_for_family(context.family_id).isoformat()
    meal_type = str(payload.get("mealType") or "") or None
    return {
        "card": {
            "id": create_id("ai_card"),
            "type": "today_recommendation",
            "title": "今日吃什么",
            "data": {
                "recommendations": recommendations,
                "targetDate": target_date,
                "mealType": meal_type,
                "contextSummary": _today_recommendation_context(context),
            },
        }
    }


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
        output_schema=MEAL_PLAN_LIST_OUTPUT,
        requires_followup=True,
        followup_hint="读取已有餐食计划后必须总结冲突/空档、请求补充信息，或继续生成推荐/计划草稿。",
    )
    register_tool(
        registry,
        name="meal_plan.read_by_id",
        display_name="餐食计划详情",
        description="读取当前用户指定计划项的完整内容。",
        side_effect="read",
        handler=meal_plan_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=MEAL_PLAN_READ_OUTPUT,
        requires_followup=True,
        followup_hint="读取餐食计划详情后必须说明可调整项、请求补充信息，或继续生成计划草稿。",
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
        draft_types=["meal_plan"],
    )
    register_tool(
        registry,
        name="meal_plan.recommend_today",
        display_name="即时餐食推荐卡",
        description="基于已读取的真实食物或菜谱 ID 生成 today_recommendation 结果卡；不创建草稿或审批。",
        side_effect="read",
        handler=meal_plan_recommend_today,
        input_schema=TODAY_RECOMMENDATION_INPUT,
        output_schema=TODAY_RECOMMENDATION_OUTPUT,
        terminal_output=True,
        followup_hint="即时餐食推荐卡可作为今日推荐模式的终态输出。",
        output_types=["today_recommendation"],
    )
