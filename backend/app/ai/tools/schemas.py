from __future__ import annotations

from typing import Any


EMPTY_INPUT: dict[str, Any] = {"type": "object", "additionalProperties": False, "properties": {}}
MEAL_TYPE_VALUES = ["breakfast", "lunch", "dinner", "snack"]
FOOD_TYPE_VALUES = ["selfMade", "takeout", "diningOut", "readyMade", "instant", "packaged"]

COUNT_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "items": {"type": "array", "items": {"type": "object"}},
    },
}
LIMIT_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}},
}
DAYS_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"days": {"type": "integer", "minimum": 1, "maximum": 30}},
}
DRAFT_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draft"],
    "properties": {"draft": {"type": "object"}},
}
DRAFT_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["draft", "itemCount"],
    "properties": {
        "draft": {"type": "object"},
        "itemCount": {"type": "integer", "minimum": 0},
    },
}


def draft_input_schema(draft_schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["draft"],
        "properties": {"draft": draft_schema},
    }


def draft_output_schema(draft_schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["draft", "itemCount"],
        "properties": {
            "draft": draft_schema,
            "itemCount": {"type": "integer", "minimum": 0},
        },
    }


SHOPPING_LIST_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "items"],
    "properties": {
        "draftType": {"type": "string", "enum": ["shopping_list"]},
        "schemaVersion": {"type": "string", "enum": ["shopping_list.v1"]},
        "sourceDraftId": {"type": ["string", "null"]},
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 100,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "quantity", "unit"],
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 80},
                    "quantity": {"type": "number", "exclusiveMinimum": 0},
                    "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                    "reason": {"type": "string", "maxLength": 255},
                    "sourceMeals": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "alreadyPending": {"type": "boolean"},
                },
            },
        },
    },
}

MEAL_PLAN_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "items"],
    "properties": {
        "draftType": {"type": "string", "enum": ["meal_plan"]},
        "schemaVersion": {"type": "string", "enum": ["meal_plan.v1"]},
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 28,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["date", "mealType", "title"],
                "properties": {
                    "date": {"type": "string", "minLength": 10, "maxLength": 10},
                    "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
                    "title": {"type": "string", "minLength": 1, "maxLength": 80},
                    "foodId": {"type": ["string", "null"]},
                    "recipeId": {"type": ["string", "null"]},
                    "reason": {"type": "string", "maxLength": 255},
                    "usedInventory": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "missingIngredients": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "source": {"type": "object"},
                },
            },
        },
        "source": {"type": "object"},
    },
}

MEAL_LOG_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "date", "mealType", "foods", "notes"],
    "properties": {
        "draftType": {"type": "string", "enum": ["meal_log"]},
        "schemaVersion": {"type": "string", "enum": ["meal_log.v1"]},
        "date": {"type": "string", "minLength": 10, "maxLength": 10},
        "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
        "foods": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["foodId", "name", "servings", "note"],
                "properties": {
                    "foodId": {"type": ["string", "null"]},
                    "name": {"type": "string", "maxLength": 80},
                    "servings": {"type": "number", "exclusiveMinimum": 0},
                    "note": {"type": "string", "maxLength": 255},
                },
            },
        },
        "notes": {"type": "string", "maxLength": 1000},
    },
}

FOOD_PROFILE_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "name", "type", "category"],
    "properties": {
        "draftType": {"type": "string", "enum": ["food_profile"]},
        "schemaVersion": {"type": "string", "enum": ["food_profile.v1"]},
        "name": {"type": "string", "minLength": 1, "maxLength": 80},
        "type": {"type": "string", "enum": FOOD_TYPE_VALUES},
        "category": {"type": "string", "maxLength": 80},
        "flavor_tags": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 40}},
        "scene_tags": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 40}},
        "suitable_meal_types": {"type": "array", "maxItems": 4, "items": {"type": "string", "enum": MEAL_TYPE_VALUES}},
        "source_name": {"type": "string", "maxLength": 80},
        "purchase_source": {"type": "string", "maxLength": 80},
        "scene": {"type": "string", "maxLength": 255},
        "notes": {"type": "string", "maxLength": 1000},
        "routine_note": {"type": "string", "maxLength": 1000},
        "price": {"type": ["number", "null"], "minimum": 0},
        "rating": {"type": ["integer", "null"], "minimum": 1, "maximum": 5},
        "repurchase": {"type": ["boolean", "null"]},
        "expiry_date": {"type": ["string", "null"]},
        "stock_quantity": {"type": ["number", "null"], "minimum": 0},
        "stock_unit": {"type": "string", "maxLength": 20},
        "favorite": {"type": "boolean"},
        "recipe_id": {"type": ["string", "null"]},
        "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
    },
}
