from __future__ import annotations

from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.kitchen.recipe_drafts import RECIPE_DRAFT_JSON_SCHEMA
from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_recipe_cook_draft, normalize_recipe_draft_for_tools
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import READ_BY_ID_INPUT, RECIPE_COOK_DRAFT_INPUT_SCHEMA, RECIPE_COOK_DRAFT_SCHEMA, SEARCH_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Food, FoodPlanItem, Recipe, RecipeFavorite
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.clock import today_for_family
from app.services.inventory_usage import build_cook_inventory_plan, serialize_cook_preview_item
from app.services.search.hybrid import hybrid_search
from app.services.serializers import serialize_recipe

RECIPE_CREATE_DRAFT_SCHEMA = {
    **RECIPE_DRAFT_JSON_SCHEMA,
    "required": ["title", "servings", "prep_minutes", "difficulty", "ingredient_items", "steps"],
    "properties": {
        **RECIPE_DRAFT_JSON_SCHEMA["properties"],
        "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "draftType": {"type": "string", "enum": ["recipe"]},
        "schemaVersion": {"type": "string", "enum": ["recipe.v1", "recipe_operation.v1"]},
    },
    "description": "新增菜谱草稿必须填写 title、servings、prep_minutes、difficulty、ingredient_items、steps；信息不足时先调用 human.request_input。",
}
RECIPE_OPERATION_DRAFT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["action"],
    "properties": {
        "draftType": {"type": "string", "enum": ["recipe"]},
        "schemaVersion": {"type": "string", "enum": ["recipe_operation.v1"]},
        "action": {"type": "string", "enum": ["create", "update", "delete", "set_favorite"]},
        "targetId": {"type": ["string", "null"]},
        "baseUpdatedAt": {"type": ["string", "null"]},
        "before": {"type": ["object", "null"]},
        "payload": {"type": "object", "additionalProperties": True},
    },
}
RECIPE_CREATE_OPERATION_SCHEMA = {
    **RECIPE_OPERATION_DRAFT_SCHEMA,
    "required": ["action", "payload"],
    "properties": {
        **RECIPE_OPERATION_DRAFT_SCHEMA["properties"],
        "action": {"type": "string", "enum": ["create"]},
        "payload": RECIPE_CREATE_DRAFT_SCHEMA,
    },
}
RECIPE_UPDATE_OPERATION_SCHEMA = {
    **RECIPE_OPERATION_DRAFT_SCHEMA,
    "required": ["action", "targetId", "baseUpdatedAt", "payload"],
    "properties": {
        **RECIPE_OPERATION_DRAFT_SCHEMA["properties"],
        "action": {"type": "string", "enum": ["update"]},
        "targetId": {"type": "string", "minLength": 1},
        "baseUpdatedAt": {"type": "string", "minLength": 1},
        "payload": RECIPE_CREATE_DRAFT_SCHEMA,
    },
}
RECIPE_DELETE_OPERATION_SCHEMA = {
    **RECIPE_OPERATION_DRAFT_SCHEMA,
    "required": ["action", "targetId", "baseUpdatedAt"],
    "properties": {
        **RECIPE_OPERATION_DRAFT_SCHEMA["properties"],
        "action": {"type": "string", "enum": ["delete"]},
        "targetId": {"type": "string", "minLength": 1},
        "baseUpdatedAt": {"type": "string", "minLength": 1},
        "payload": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"reason": {"type": "string", "maxLength": 500}},
        },
    },
}
RECIPE_FAVORITE_OPERATION_SCHEMA = {
    **RECIPE_OPERATION_DRAFT_SCHEMA,
    "required": ["action", "targetId", "baseUpdatedAt", "payload"],
    "properties": {
        **RECIPE_OPERATION_DRAFT_SCHEMA["properties"],
        "action": {"type": "string", "enum": ["set_favorite"]},
        "targetId": {"type": "string", "minLength": 1},
        "baseUpdatedAt": {"type": "string", "minLength": 1},
        "payload": {
            "type": "object",
            "additionalProperties": False,
            "required": ["favorite"],
            "properties": {"favorite": {"type": "boolean"}},
        },
    },
}
RECIPE_TOOL_DRAFT_SCHEMA = {
    **RECIPE_OPERATION_DRAFT_SCHEMA,
    "required": [],
    "properties": {
        **RECIPE_CREATE_DRAFT_SCHEMA["properties"],
        **RECIPE_OPERATION_DRAFT_SCHEMA["properties"],
        "schemaVersion": {"type": "string", "enum": ["recipe.v1", "recipe_operation.v1"]},
    },
    "description": (
        "菜谱草稿必须匹配一种形态：新增菜谱提供 title、servings、prep_minutes、difficulty、"
        "ingredient_items、steps；或操作式草稿提供 action、目标和 payload。不要提交空对象。"
    ),
    "anyOf": [
        RECIPE_CREATE_DRAFT_SCHEMA,
        RECIPE_CREATE_OPERATION_SCHEMA,
        RECIPE_UPDATE_OPERATION_SCHEMA,
        RECIPE_DELETE_OPERATION_SCHEMA,
        RECIPE_FAVORITE_OPERATION_SCHEMA,
    ],
}

RECIPE_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "title", "servings", "prepMinutes", "difficulty", "foodIds", "favorite", "updatedAt"],
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "image": {"type": ["object", "null"]},
        "servings": {"type": "integer", "minimum": 1},
        "prepMinutes": {"type": "integer", "minimum": 0},
        "difficulty": {"type": "string"},
        "sceneTags": {"type": "array", "items": {"type": "string"}},
        "foodIds": {"type": "array", "items": {"type": "string"}},
        "favorite": {"type": "boolean"},
        "updatedAt": {"type": ["string", "null"]},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["ingredientId", "name", "quantity", "unit"],
                "properties": {
                    "ingredientId": {"type": ["string", "null"]},
                    "name": {"type": "string"},
                    "quantity": {"type": "number"},
                    "unit": {"type": "string"},
                    "note": {"type": ["string", "null"]},
                },
            },
        },
    },
}

RECIPE_SEARCH_OUTPUT = {
    "type": "object",
    "required": ["count", "hasMore", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": RECIPE_ITEM_OUTPUT},
    },
}

RECIPE_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": {"type": "object"}},
}


def recipe_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 24)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    category = str(payload.get("category") or "").strip()
    if query and not exact and not ids:
        search_result = hybrid_search(
            context.db,
            family_id=context.family_id,
            query=query,
            scopes=["recipe"],
            limit=max(limit + offset + 1, 80),
            offset=0,
        )
        search_ids = [item.entity_id for item in search_result.items if item.entity_type == "recipe"]
        if not search_ids:
            recipes: list[Recipe] = []
        else:
            statement = (
                select(Recipe)
                .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.foods))
                .where(Recipe.family_id == context.family_id, Recipe.id.in_(search_ids))
            )
            if category:
                statement = statement.where(Recipe.scene_tags.contains([category]))
            recipes_by_id = {item.id: item for item in context.db.scalars(statement)}
            recipes = [recipes_by_id[item_id] for item_id in search_ids if item_id in recipes_by_id]
            recipes = recipes[offset : offset + limit + 1]
        return _recipe_search_response(context, recipes, limit=limit)

    statement = (
        select(Recipe)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.foods))
        .where(Recipe.family_id == context.family_id)
    )
    if ids:
        statement = statement.where(Recipe.id.in_(ids))
    if category:
        statement = statement.where(Recipe.scene_tags.contains([category]))
    if query:
        if exact:
            statement = statement.where(Recipe.title == query)
    recipes = list(
        context.db.scalars(
            statement.order_by(Recipe.updated_at.desc(), Recipe.id).offset(offset).limit(limit + 1)
        )
    )
    return _recipe_search_response(context, recipes, limit=limit)


def _recipe_search_response(context: ToolContext, recipes: list[Recipe], *, limit: int) -> dict[str, Any]:
    has_more = len(recipes) > limit
    recipes = recipes[:limit]
    favorite_ids = set(
        context.db.scalars(
            select(RecipeFavorite.recipe_id).where(
                RecipeFavorite.family_id == context.family_id,
                RecipeFavorite.user_id == context.user_id,
                RecipeFavorite.recipe_id.in_([item.id for item in recipes]),
            )
        )
    )
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"recipe"}, entity_ids=[item.id for item in recipes])
    return {
        "items": [
            {
                "id": item.id,
                "title": item.title,
                "image": first_entity_media(media_map, "recipe", item.id),
                "servings": item.servings,
                "prepMinutes": item.prep_minutes,
                "difficulty": item.difficulty.value if hasattr(item.difficulty, "value") else str(item.difficulty),
                "sceneTags": item.scene_tags or [],
                "foodIds": [food.id for food in item.foods],
                "favorite": item.id in favorite_ids,
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
                "ingredients": [
                    {
                        "ingredientId": ingredient.ingredient_id,
                        "name": ingredient.ingredient_name,
                        "quantity": float(ingredient.quantity),
                        "unit": ingredient.unit,
                        "note": ingredient.note,
                    }
                    for ingredient in item.ingredient_items
                ],
            }
            for item in recipes
        ],
        "count": len(recipes),
        "hasMore": has_more,
    }


def recipe_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    recipe = context.db.scalar(
        select(Recipe)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs), selectinload(Recipe.foods))
        .where(Recipe.family_id == context.family_id, Recipe.id == str(payload["id"]))
    )
    if recipe is None:
        raise ValueError("菜谱不存在或不属于当前家庭")
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="recipe",
            entity_ids=[recipe.id],
        )
    )
    favorite = context.db.scalar(
        select(RecipeFavorite.id).where(
            RecipeFavorite.family_id == context.family_id,
            RecipeFavorite.user_id == context.user_id,
            RecipeFavorite.recipe_id == recipe.id,
        )
    )
    return {
        "item": {
            **serialize_recipe(recipe, media_map),
            "favorite": favorite is not None,
            "linkedFoods": [
                {
                    "id": food.id,
                    "name": food.name,
                    "favorite": bool(getattr(food, "favorite", False)),
                }
                for food in recipe.foods
            ],
        }
    }


def recipe_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_recipe_draft_for_tools(context.db, family_id=context.family_id, payload=draft)
    return {"draft": normalized, "itemCount": len(normalized.get("ingredient_items", []) or [])}


def recipe_preview_cook(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    recipe = context.db.scalar(
        select(Recipe)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.foods))
        .where(Recipe.family_id == context.family_id, Recipe.id == str(payload["recipeId"]))
    )
    if recipe is None:
        raise ValueError("菜谱不存在或不属于当前家庭")
    servings = float(payload.get("servings") or recipe.servings)
    preview, shortages = build_cook_inventory_plan(
        context.db,
        family_id=context.family_id,
        recipe=recipe,
        servings=servings,
        today=today_for_family(context.family_id),
    )
    plan_item_id = str(payload.get("planItemId") or "") or None
    plan_item = None
    plan_item_warning = None
    if plan_item_id:
        plan_item = context.db.scalar(
            select(FoodPlanItem)
            .options(selectinload(FoodPlanItem.food))
            .where(
                FoodPlanItem.family_id == context.family_id,
                FoodPlanItem.user_id == context.user_id,
                FoodPlanItem.id == plan_item_id,
            )
        )
        if plan_item is None:
            plan_item_warning = {
                "code": "plan_item_not_found",
                "message": "计划项不存在或不属于当前用户，已仅返回不关联计划的做菜预览。",
                "planItemId": plan_item_id,
            }
        elif plan_item.food is None or plan_item.food.recipe_id != recipe.id:
            plan_item_warning = {
                "code": "plan_item_recipe_mismatch",
                "message": "计划项不属于当前菜谱，已仅返回不关联计划的做菜预览。",
                "planItemId": plan_item_id,
            }
            plan_item = None
    return {
        "recipe": {
            "id": recipe.id,
            "title": recipe.title,
            "servings": recipe.servings,
            "updatedAt": recipe.updated_at.isoformat(),
        },
        "preview": {
            "recipe_id": recipe.id,
            "preview_items": jsonable_encoder([serialize_cook_preview_item(item) for item in preview]),
            "shortages": jsonable_encoder(shortages),
        },
        "planItem": {
            "id": plan_item.id,
            "status": plan_item.status,
            "updatedAt": plan_item.updated_at.isoformat(),
        }
        if plan_item is not None
        else None,
        "planItemWarning": plan_item_warning,
    }


def recipe_create_cook_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_recipe_cook_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=draft,
    )
    return {
        "draft": normalized,
        "itemCount": len(normalized["previewItems"]),
    }


def register_recipe_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="recipe.search",
        display_name="菜谱库",
        description="搜索当前家庭菜谱。",
        side_effect="read",
        handler=recipe_search,
        input_schema=SEARCH_INPUT,
        output_schema=RECIPE_SEARCH_OUTPUT,
        requires_followup=True,
        followup_hint="菜谱检索后必须说明候选、请求用户选择，或继续读取详情/生成草稿。",
    )
    register_tool(
        registry,
        name="recipe.read_by_id",
        display_name="菜谱详情",
        description="读取当前家庭指定菜谱的完整资料。",
        side_effect="read",
        handler=recipe_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=RECIPE_READ_OUTPUT,
        requires_followup=True,
        followup_hint="读取菜谱详情后必须说明可用信息、请求补充信息，或继续预览/生成草稿。",
    )
    register_tool(
        registry,
        name="recipe.create_draft",
        display_name="菜谱确认表单",
        description="生成菜谱草稿，不写入业务表。",
        side_effect="draft",
        handler=recipe_create_draft,
        input_schema=draft_input_schema(RECIPE_TOOL_DRAFT_SCHEMA),
        output_schema=draft_output_schema(RECIPE_TOOL_DRAFT_SCHEMA),
        draft_types=["recipe"],
    )
    register_tool(
        registry,
        name="recipe.preview_cook",
        display_name="做菜扣减预览",
        description="预览指定菜谱按当前份数的库存扣减和缺料情况。",
        side_effect="read",
        handler=recipe_preview_cook,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "required": ["recipeId"],
            "properties": {
                "recipeId": {"type": "string", "minLength": 1},
                "servings": {"type": "number", "exclusiveMinimum": 0},
                "planItemId": {"type": "string", "minLength": 1},
            },
        },
        output_schema={
            "type": "object",
            "required": ["recipe", "preview"],
            "properties": {
                "recipe": {"type": "object"},
                "preview": {"type": "object"},
                "planItem": {"type": ["object", "null"]},
            },
        },
        requires_followup=True,
        followup_hint="做菜预览后必须说明库存扣减和缺料情况、请求补充信息，或生成 recipe_cook 草稿。",
    )
    register_tool(
        registry,
        name="recipe.create_cook_draft",
        display_name="做菜确认表单",
        description="生成做菜扣减草稿，不直接写入库存或餐食记录。",
        side_effect="draft",
        handler=recipe_create_cook_draft,
        input_schema=draft_input_schema(RECIPE_COOK_DRAFT_INPUT_SCHEMA),
        output_schema=draft_output_schema(RECIPE_COOK_DRAFT_SCHEMA),
        draft_types=["recipe_cook"],
    )
