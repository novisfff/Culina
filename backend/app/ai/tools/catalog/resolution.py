from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from sqlalchemy import func, select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.core.enums import FoodType
from app.models.domain import Food, Ingredient
from app.services.ingredient_units import get_supported_units
from app.services.search.hybrid import hybrid_search


RESOLVE_CANDIDATES_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 30,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["clientKey", "name"],
                "properties": {
                    "clientKey": {"type": "string", "minLength": 1, "maxLength": 64},
                    "name": {"type": "string", "minLength": 1, "maxLength": 120},
                },
            },
        },
        "limitPerItem": {"type": "integer", "minimum": 1, "maximum": 5},
    },
}

RESOLUTION_CANDIDATE_OUTPUT = {
    "type": "object",
    "required": ["id", "name", "targetType", "matchType", "matchReason"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "targetType": {"type": "string", "enum": ["ingredient", "food"]},
        "matchType": {"type": "string", "enum": ["exact", "semantic"]},
        "matchReason": {"type": "array", "items": {"type": "string"}},
        "defaultUnit": {"type": ["string", "null"]},
        "supportedUnits": {"type": "array", "items": {"type": "string"}},
        "quantityTrackingMode": {"type": ["string", "null"]},
        "foodType": {"type": ["string", "null"]},
        "stockUnit": {"type": ["string", "null"]},
        "storageLocation": {"type": ["string", "null"]},
    },
}

RESOLVE_CANDIDATES_OUTPUT = {
    "type": "object",
    "required": ["results"],
    "additionalProperties": False,
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["clientKey", "name", "status", "candidates"],
                "additionalProperties": False,
                "properties": {
                    "clientKey": {"type": "string"},
                    "name": {"type": "string"},
                    "status": {
                        "type": "string",
                        "enum": ["exact", "candidate", "ambiguous", "missing"],
                    },
                    "candidates": {
                        "type": "array",
                        "items": RESOLUTION_CANDIDATE_OUTPUT,
                    },
                },
            },
        }
    },
}


def _normalized_name(value: str) -> str:
    return " ".join(value.split()).casefold()


def _status(candidates: list[dict[str, Any]]) -> Literal["exact", "candidate", "ambiguous", "missing"]:
    if not candidates:
        return "missing"
    if len(candidates) == 1 and candidates[0]["matchType"] == "exact":
        return "exact"
    if len(candidates) == 1:
        return "candidate"
    return "ambiguous"


def _ingredient_candidate(
    ingredient: Ingredient,
    *,
    match_type: str,
    reasons: list[str],
) -> dict[str, Any]:
    return {
        "id": ingredient.id,
        "name": ingredient.name,
        "targetType": "ingredient",
        "matchType": match_type,
        "matchReason": reasons,
        "defaultUnit": ingredient.default_unit,
        "supportedUnits": get_supported_units(ingredient.default_unit, ingredient.unit_conversions),
        "quantityTrackingMode": (
            ingredient.quantity_tracking_mode.value
            if hasattr(ingredient.quantity_tracking_mode, "value")
            else str(ingredient.quantity_tracking_mode)
        ),
    }


def _food_candidate(
    food: Food,
    *,
    match_type: str,
    reasons: list[str],
) -> dict[str, Any]:
    return {
        "id": food.id,
        "name": food.name,
        "targetType": "food",
        "matchType": match_type,
        "matchReason": reasons,
        "foodType": food.type.value if hasattr(food.type, "value") else str(food.type),
        "stockUnit": food.stock_unit,
        "storageLocation": food.storage_location,
    }


def _resolve_items(
    context: ToolContext,
    payload: dict[str, Any],
    *,
    entity_type: Literal["ingredient", "food"],
    exact_entities: list[Ingredient] | list[Food],
    load_semantic_entities: Callable[[list[str]], list[Ingredient] | list[Food]],
    serialize_candidate: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    limit = int(payload.get("limitPerItem") or 3)
    exact_by_name: dict[str, list[Ingredient | Food]] = {}
    for entity in exact_entities:
        exact_by_name.setdefault(_normalized_name(entity.name), []).append(entity)

    results: list[dict[str, Any]] = []
    for raw in payload["items"]:
        client_key = str(raw["clientKey"]).strip()
        name = str(raw["name"]).strip()
        normalized = _normalized_name(name)
        exact = exact_by_name.get(normalized, [])[:limit]
        candidates = [
            serialize_candidate(entity, match_type="exact", reasons=["名称完全匹配"])
            for entity in exact
        ]
        if not candidates:
            search_result = hybrid_search(
                context.db,
                family_id=context.family_id,
                query=name,
                scopes=[entity_type],
                limit=limit,
                offset=0,
            )
            search_items = [item for item in search_result.items if item.entity_type == entity_type]
            entities_by_id = {
                entity.id: entity
                for entity in load_semantic_entities([item.entity_id for item in search_items])
            }
            candidates = [
                serialize_candidate(
                    entities_by_id[item.entity_id],
                    match_type=(
                        "exact"
                        if _normalized_name(entities_by_id[item.entity_id].name) == normalized
                        else "semantic"
                    ),
                    reasons=list(item.match_reason or []) or ["语义候选"],
                )
                for item in search_items
                if item.entity_id in entities_by_id
            ][:limit]
        results.append(
            {
                "clientKey": client_key,
                "name": name,
                "status": _status(candidates),
                "candidates": candidates,
            }
        )
    return {"results": results}


def ingredient_resolve_candidates(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    names = [str(item["name"]).strip() for item in payload["items"]]
    normalized_names = list({_normalized_name(name) for name in names})
    exact_entities = list(
        context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                func.lower(func.trim(Ingredient.name)).in_(normalized_names),
            )
        )
    )

    def load(ids: list[str]) -> list[Ingredient]:
        if not ids:
            return []
        return list(
            context.db.scalars(
                select(Ingredient).where(
                    Ingredient.family_id == context.family_id,
                    Ingredient.id.in_(ids),
                )
            )
        )

    return _resolve_items(
        context,
        payload,
        entity_type="ingredient",
        exact_entities=exact_entities,
        load_semantic_entities=load,
        serialize_candidate=_ingredient_candidate,
    )


PURCHASABLE_FOOD_TYPES = {
    FoodType.READY_MADE,
    FoodType.INSTANT,
    FoodType.PACKAGED,
}


def purchasable_resolve_candidates(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    names = [str(item["name"]).strip() for item in payload["items"]]
    normalized_names = list({_normalized_name(name) for name in names})
    exact_ingredients = list(
        context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                func.lower(func.trim(Ingredient.name)).in_(normalized_names),
            )
        )
    )
    exact_foods = list(
        context.db.scalars(
            select(Food).where(
                Food.family_id == context.family_id,
                Food.type.in_(PURCHASABLE_FOOD_TYPES),
                func.lower(func.trim(Food.name)).in_(normalized_names),
            )
        )
    )
    exact_by_name: dict[str, list[Ingredient | Food]] = {}
    for entity in [*exact_ingredients, *exact_foods]:
        exact_by_name.setdefault(_normalized_name(entity.name), []).append(entity)

    limit = int(payload.get("limitPerItem") or 3)
    results: list[dict[str, Any]] = []
    for raw in payload["items"]:
        client_key = str(raw["clientKey"]).strip()
        name = str(raw["name"]).strip()
        normalized = _normalized_name(name)
        exact = exact_by_name.get(normalized, [])[:limit]
        candidates = [
            (
                _ingredient_candidate(entity, match_type="exact", reasons=["名称完全匹配"])
                if isinstance(entity, Ingredient)
                else _food_candidate(entity, match_type="exact", reasons=["名称完全匹配"])
            )
            for entity in exact
        ]
        if not candidates:
            search_result = hybrid_search(
                context.db,
                family_id=context.family_id,
                query=name,
                scopes=["ingredient", "food"],
                limit=limit,
                offset=0,
            )
            ingredient_ids = [
                item.entity_id for item in search_result.items if item.entity_type == "ingredient"
            ]
            food_ids = [item.entity_id for item in search_result.items if item.entity_type == "food"]
            ingredients_by_id = {
                entity.id: entity
                for entity in context.db.scalars(
                    select(Ingredient).where(
                        Ingredient.family_id == context.family_id,
                        Ingredient.id.in_(ingredient_ids),
                    )
                )
            } if ingredient_ids else {}
            foods_by_id = {
                entity.id: entity
                for entity in context.db.scalars(
                    select(Food).where(
                        Food.family_id == context.family_id,
                        Food.type.in_(PURCHASABLE_FOOD_TYPES),
                        Food.id.in_(food_ids),
                    )
                )
            } if food_ids else {}
            for item in search_result.items:
                entity = (
                    ingredients_by_id.get(item.entity_id)
                    if item.entity_type == "ingredient"
                    else foods_by_id.get(item.entity_id)
                )
                if entity is None:
                    continue
                match_type = "exact" if _normalized_name(entity.name) == normalized else "semantic"
                reasons = list(item.match_reason or []) or ["语义候选"]
                candidates.append(
                    _ingredient_candidate(entity, match_type=match_type, reasons=reasons)
                    if isinstance(entity, Ingredient)
                    else _food_candidate(entity, match_type=match_type, reasons=reasons)
                )
                if len(candidates) >= limit:
                    break
        results.append(
            {
                "clientKey": client_key,
                "name": name,
                "status": _status(candidates),
                "candidates": candidates,
            }
        )
    return {"results": results}


def register_resolution_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="ingredient.resolve_candidates",
        display_name="批量解析食材候选",
        description="批量解析当前家庭食材候选；仅名称完全匹配可直接绑定，其他结果需要用户确认。",
        side_effect="read",
        handler=ingredient_resolve_candidates,
        input_schema=RESOLVE_CANDIDATES_INPUT,
        output_schema=RESOLVE_CANDIDATES_OUTPUT,
        requires_followup=True,
        followup_hint="遇到 ambiguous 必须请用户选择，遇到 missing 必须进入食材档案 handoff。",
    )
    register_tool(
        registry,
        name="purchasable.resolve_candidates",
        display_name="批量解析可购买候选",
        description="批量解析当前家庭食材及可购买成品候选；语义候选不得自动绑定。",
        side_effect="read",
        handler=purchasable_resolve_candidates,
        input_schema=RESOLVE_CANDIDATES_INPUT,
        output_schema=RESOLVE_CANDIDATES_OUTPUT,
        requires_followup=True,
        followup_hint="遇到 ambiguous 必须请用户选择，遇到 missing 必须进入对应资料 handoff。",
    )
