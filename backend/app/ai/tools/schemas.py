from __future__ import annotations

from typing import Any


EMPTY_INPUT: dict[str, Any] = {"type": "object", "additionalProperties": False, "properties": {}}
MEAL_TYPE_VALUES = ["breakfast", "lunch", "dinner", "snack"]
FOOD_TYPE_VALUES = ["selfMade", "takeout", "diningOut", "readyMade", "instant", "packaged"]
INVENTORY_STATUS_VALUES = ["fresh", "opened", "frozen", "expiring"]
OPERATION_ACTION_VALUES = ["create", "update", "delete"]
MEAL_PLAN_OPERATION_ACTION_VALUES = ["create", "update", "set_status", "delete"]
SHOPPING_OPERATION_ACTION_VALUES = ["create", "update", "set_done", "delete"]

LIMIT_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}},
}
SEARCH_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "query": {"type": "string", "maxLength": 100},
        "ids": {"type": "array", "maxItems": 50, "items": {"type": "string", "minLength": 1}},
        "exact": {"type": "boolean"},
        "category": {"type": ["string", "null"], "maxLength": 80},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        "offset": {"type": "integer", "minimum": 0, "maximum": 1000},
    },
}
READ_BY_ID_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id"],
    "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 64}},
}
DAYS_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"days": {"type": "integer", "minimum": 1, "maximum": 30}},
}
DAYS_LIMIT_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "days": {"type": "integer", "minimum": 1, "maximum": 30},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    },
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
    "required": ["draftType", "schemaVersion"],
    "properties": {
        "draftType": {"type": "string", "enum": ["shopping_list"]},
        "schemaVersion": {"type": "string", "enum": ["shopping_list.v1", "shopping_list_operation.v1"]},
        "sourceDraftId": {"type": ["string", "null"]},
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 100,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title"],
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 80},
                    "ingredient_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "ingredientId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "food_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "foodId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "quantity": {"type": "number", "exclusiveMinimum": 0},
                    "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                    "quantity_mode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                    "quantityMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                    "display_label": {"type": ["string", "null"], "maxLength": 80},
                    "displayLabel": {"type": ["string", "null"], "maxLength": 80},
                    "reason": {"type": "string", "maxLength": 255},
                    "sourceMeals": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "alreadyPending": {"type": "boolean"},
                },
            },
        },
        "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 100,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["action"],
                "properties": {
                    "operationId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "action": {"type": "string", "enum": SHOPPING_OPERATION_ACTION_VALUES},
                    "targetId": {"type": ["string", "null"]},
                    "baseUpdatedAt": {"type": ["string", "null"]},
                    "before": {"type": ["object", "null"]},
                    "payload": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string", "minLength": 1, "maxLength": 80},
                            "ingredient_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                            "ingredientId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                            "food_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                            "foodId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                            "quantity": {"type": "number", "exclusiveMinimum": 0},
                            "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                            "quantity_mode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                            "quantityMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                            "display_label": {"type": ["string", "null"], "maxLength": 80},
                            "displayLabel": {"type": ["string", "null"], "maxLength": 80},
                            "reason": {"type": "string", "maxLength": 255},
                            "done": {"type": "boolean"},
                            "sourceMeals": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                            "alreadyPending": {"type": "boolean"},
                        },
                    },
                },
            },
        },
    },
}

MEAL_PLAN_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion"],
    "properties": {
        "draftType": {"type": "string", "enum": ["meal_plan"]},
        "schemaVersion": {"type": "string", "enum": ["meal_plan.v1", "meal_plan_operation.v1"]},
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 28,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["date", "mealType", "title", "foodId"],
                "properties": {
                    "date": {"type": "string", "minLength": 10, "maxLength": 10},
                    "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
                    "title": {"type": "string", "minLength": 1, "maxLength": 80},
                    "foodId": {"type": "string", "minLength": 1},
                    "recipeId": {"type": ["string", "null"]},
                    "reason": {"type": "string", "maxLength": 255},
                    "usedInventory": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "missingIngredients": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                    "missingIngredientItems": {
                        "type": "array",
                        "maxItems": 20,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["name", "quantity", "unit"],
                            "properties": {
                                "ingredientId": {"type": ["string", "null"]},
                                "name": {"type": "string", "minLength": 1, "maxLength": 80},
                                "quantity": {"type": "number", "exclusiveMinimum": 0},
                                "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                            },
                        },
                    },
                    "source": {"type": "object"},
                },
            },
        },
        "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 28,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["action"],
                "properties": {
                    "operationId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "action": {"type": "string", "enum": MEAL_PLAN_OPERATION_ACTION_VALUES},
                    "targetId": {"type": ["string", "null"]},
                    "baseUpdatedAt": {"type": ["string", "null"]},
                    "before": {"type": ["object", "null"]},
                    "payload": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "date": {"type": "string", "minLength": 10, "maxLength": 10},
                            "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
                            "title": {"type": "string", "minLength": 1, "maxLength": 80},
                            "foodId": {"type": "string", "minLength": 1},
                            "recipeId": {"type": ["string", "null"]},
                            "reason": {"type": "string", "maxLength": 255},
                            "status": {"type": "string", "enum": ["planned", "cooked", "skipped"]},
                            "usedInventory": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                            "missingIngredients": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 80}},
                            "missingIngredientItems": {
                                "type": "array",
                                "maxItems": 20,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["name", "quantity", "unit"],
                                    "properties": {
                                        "ingredientId": {"type": ["string", "null"]},
                                        "name": {"type": "string", "minLength": 1, "maxLength": 80},
                                        "quantity": {"type": "number", "exclusiveMinimum": 0},
                                        "unit": {"type": "string", "minLength": 1, "maxLength": 20},
                                    },
                                },
                            },
                            "source": {"type": "object"},
                        },
                    },
                },
            },
        },
        "source": {"type": "object"},
    },
}

INGREDIENT_PROFILE_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "食材档案草稿。单个创建/更新使用 action 和 payload；更新时还必须提供 targetId；一次创建 2-5 个食材时使用 operations，每项 action=create。",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion"],
    "properties": {
        "draftType": {"type": "string", "enum": ["ingredient_profile"]},
        "schemaVersion": {"type": "string", "enum": ["ingredient_profile.v1", "ingredient_profile_operation.v1"]},
        "action": {"type": "string", "enum": ["create", "update"]},
        "targetId": {"type": ["string", "null"]},
        "baseUpdatedAt": {"type": ["string", "null"]},
        "before": {"type": ["object", "null"]},
        "payload": {
            "type": "object",
            "additionalProperties": False,
            "required": ["name", "category", "default_unit", "default_storage", "default_expiry_mode"],
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 120},
                "category": {"type": "string", "minLength": 1, "maxLength": 120},
                "default_unit": {"type": "string", "minLength": 1, "maxLength": 32},
                "quantity_tracking_mode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                "unit_conversions": {
                    "type": "array",
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["unit", "ratio_to_default"],
                        "properties": {
                            "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                            "ratio_to_default": {"type": "number", "exclusiveMinimum": 0},
                        },
                    },
                },
                "default_storage": {"type": "string", "minLength": 1, "maxLength": 120},
                "default_expiry_mode": {"type": "string", "enum": ["days", "manual_date", "none"]},
                "default_expiry_days": {"type": ["integer", "null"], "minimum": 1, "maximum": 3650},
                "default_low_stock_threshold": {"type": ["number", "null"], "exclusiveMinimum": 0},
                "notes": {"type": "string", "maxLength": 5000},
                "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
            },
        },
        "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["action", "payload"],
                "properties": {
                    "operationId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "operation_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
                    "action": {"type": "string", "enum": ["create"]},
                    "payload": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["name", "category", "default_unit", "default_storage", "default_expiry_mode"],
                        "properties": {
                            "name": {"type": "string", "minLength": 1, "maxLength": 120},
                            "category": {"type": "string", "minLength": 1, "maxLength": 120},
                            "default_unit": {"type": "string", "minLength": 1, "maxLength": 32},
                            "quantity_tracking_mode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                            "unit_conversions": {
                                "type": "array",
                                "maxItems": 20,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["unit", "ratio_to_default"],
                                    "properties": {
                                        "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                                        "ratio_to_default": {"type": "number", "exclusiveMinimum": 0},
                                    },
                                },
                            },
                            "default_storage": {"type": "string", "minLength": 1, "maxLength": 120},
                            "default_expiry_mode": {"type": "string", "enum": ["days", "manual_date", "none"]},
                            "default_expiry_days": {"type": ["integer", "null"], "minimum": 1, "maximum": 3650},
                            "default_low_stock_threshold": {"type": ["number", "null"], "exclusiveMinimum": 0},
                            "notes": {"type": "string", "maxLength": 5000},
                            "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
                        },
                    },
                },
            },
        },
    },
}

MEAL_LOG_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion"],
    "properties": {
        "draftType": {"type": "string", "enum": ["meal_log"]},
        "schemaVersion": {"type": "string", "enum": ["meal_log.v1", "meal_log_operation.v1"]},
        "action": {"type": "string", "enum": ["create", "update_details", "rate_food"]},
        "targetId": {"type": ["string", "null"]},
        "baseUpdatedAt": {"type": ["string", "null"]},
        "before": {"type": ["object", "null"]},
        "date": {"type": "string", "minLength": 10, "maxLength": 10},
        "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
        "participantUserIds": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
        "mood": {"type": "string", "maxLength": 255},
        "mediaIds": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
        "planItemId": {"type": ["string", "null"]},
        "planItemBaseUpdatedAt": {"type": ["string", "null"]},
        "foods": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["foodId", "name", "servings", "note"],
                "properties": {
                    "foodId": {"type": "string", "minLength": 1},
                    "name": {"type": "string", "maxLength": 80},
                    "foodType": {"type": "string", "enum": ["selfMade", "takeout", "diningOut", "readyMade", "instant", "packaged"]},
                    "servings": {"type": "number", "exclusiveMinimum": 0},
                    "note": {"type": "string", "maxLength": 255},
                    "rating": {"type": ["number", "null"], "minimum": 0.5, "maximum": 5},
                    "deductStock": {"type": "boolean", "default": False},
                    "stockQuantity": {"type": "string", "pattern": "^[0-9]+(?:\\.[0-9]+)?$"},
                    "stockUnit": {"type": "string", "minLength": 1, "maxLength": 32},
                    "stockCurrentQuantity": {"type": "string", "pattern": "^[0-9]+(?:\\.[0-9]+)?$"},
                    "stockAfterQuantity": {"type": "string", "pattern": "^[0-9]+(?:\\.[0-9]+)?$"},
                },
                "allOf": [
                    {
                        "if": {
                            "required": ["deductStock"],
                            "properties": {"deductStock": {"const": True}},
                        },
                        "then": {"required": ["stockQuantity", "stockUnit"]},
                    }
                ],
            },
        },
        "notes": {"type": "string", "maxLength": 1000},
        "payload": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "participantUserIds": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
                "notes": {"type": "string", "maxLength": 1000},
                "mood": {"type": "string", "maxLength": 255},
                "mediaIds": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
                "foodEntryRatings": {
                    "type": "array",
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["id"],
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "rating": {"type": ["number", "null"], "minimum": 0.5, "maximum": 5},
                        },
                    },
                },
            },
        },
    },
}

SHOPPING_OPERATION_ITEM_SCHEMA = SHOPPING_LIST_DRAFT_SCHEMA["properties"]["operations"]["items"]
SHOPPING_OPERATION_PAYLOAD_SCHEMA = SHOPPING_OPERATION_ITEM_SCHEMA["properties"]["payload"]
SHOPPING_LIST_DRAFT_SCHEMA.update(
    {
        "description": "购物清单草稿必须提供 items，或提供 operations；不要提交只有 draftType/schemaVersion 的空草稿。",
        "anyOf": [
            {"description": "普通新增购物清单草稿。", "required": ["draftType", "schemaVersion", "items"], "properties": {"schemaVersion": {"enum": ["shopping_list.v1"]}}},
            {"description": "操作式购物清单草稿。", "required": ["draftType", "schemaVersion", "operations"], "properties": {"schemaVersion": {"enum": ["shopping_list_operation.v1"]}}},
        ],
    }
)
SHOPPING_OPERATION_ITEM_SCHEMA["anyOf"] = [
    {
        "description": "新增购物项。",
        "required": ["action", "payload"],
        "properties": {"action": {"enum": ["create"]}, "payload": {**SHOPPING_OPERATION_PAYLOAD_SCHEMA, "required": ["title"]}},
    },
    {
        "description": "更新购物项。",
        "required": ["action", "targetId", "baseUpdatedAt", "payload"],
        "properties": {
            "action": {"enum": ["update"]},
            "targetId": {"type": "string", "minLength": 1},
            "baseUpdatedAt": {"type": "string", "minLength": 1},
            "payload": {**SHOPPING_OPERATION_PAYLOAD_SCHEMA, "required": ["title"]},
        },
    },
    {
        "description": "标记购物项买到或未买到。",
        "required": ["action", "targetId", "baseUpdatedAt", "payload"],
        "properties": {
            "action": {"enum": ["set_done"]},
            "targetId": {"type": "string", "minLength": 1},
            "baseUpdatedAt": {"type": "string", "minLength": 1},
            "payload": {
                "type": "object",
                "additionalProperties": False,
                "required": ["done"],
                "properties": {"done": {"type": "boolean"}, "reason": {"type": "string", "maxLength": 255}},
            },
        },
    },
    {
        "description": "删除购物项。",
        "required": ["action", "targetId", "baseUpdatedAt"],
        "properties": {"action": {"enum": ["delete"]}, "targetId": {"type": "string", "minLength": 1}, "baseUpdatedAt": {"type": "string", "minLength": 1}},
    },
]

MEAL_PLAN_OPERATION_ITEM_SCHEMA = MEAL_PLAN_DRAFT_SCHEMA["properties"]["operations"]["items"]
MEAL_PLAN_OPERATION_PAYLOAD_SCHEMA = MEAL_PLAN_OPERATION_ITEM_SCHEMA["properties"]["payload"]
MEAL_PLAN_DRAFT_SCHEMA.update(
    {
        "description": "餐食计划草稿必须提供 items，或提供 operations；不要提交只有 draftType/schemaVersion 的空草稿。",
        "anyOf": [
            {"description": "普通餐食计划草稿。", "required": ["draftType", "schemaVersion", "items"], "properties": {"schemaVersion": {"enum": ["meal_plan.v1"]}}},
            {"description": "操作式餐食计划草稿。", "required": ["draftType", "schemaVersion", "operations"], "properties": {"schemaVersion": {"enum": ["meal_plan_operation.v1"]}}},
        ],
    }
)
MEAL_PLAN_OPERATION_ITEM_SCHEMA["anyOf"] = [
    {
        "description": "新增餐食计划项。",
        "required": ["action", "payload"],
        "properties": {"action": {"enum": ["create"]}, "payload": {**MEAL_PLAN_OPERATION_PAYLOAD_SCHEMA, "required": ["date", "mealType", "title", "foodId"]}},
    },
    {
        "description": "更新餐食计划项。",
        "required": ["action", "targetId", "baseUpdatedAt", "payload"],
        "properties": {
            "action": {"enum": ["update"]},
            "targetId": {"type": "string", "minLength": 1},
            "baseUpdatedAt": {"type": "string", "minLength": 1},
            "payload": {**MEAL_PLAN_OPERATION_PAYLOAD_SCHEMA, "required": ["date", "mealType", "title", "foodId"]},
        },
    },
    {
        "description": "更新餐食计划状态。",
        "required": ["action", "targetId", "baseUpdatedAt", "payload"],
        "properties": {
            "action": {"enum": ["set_status"]},
            "targetId": {"type": "string", "minLength": 1},
            "baseUpdatedAt": {"type": "string", "minLength": 1},
            "payload": {
                "type": "object",
                "additionalProperties": False,
                "required": ["status"],
                "properties": {"status": {"type": "string", "enum": ["planned", "cooked", "skipped"]}, "reason": {"type": "string", "maxLength": 255}},
            },
        },
    },
    {
        "description": "删除餐食计划项。",
        "required": ["action", "targetId", "baseUpdatedAt"],
        "properties": {"action": {"enum": ["delete"]}, "targetId": {"type": "string", "minLength": 1}, "baseUpdatedAt": {"type": "string", "minLength": 1}},
    },
]

INGREDIENT_PROFILE_DRAFT_SCHEMA.update(
    {
        "description": "食材档案草稿。单个创建/更新使用 action 和 payload；更新时还必须提供 targetId；一次创建 2-5 个食材时使用 operations，每项 action=create。",
        "anyOf": [
            {
                "description": "新增食材档案。",
                "required": ["draftType", "schemaVersion", "action", "payload"],
                "properties": {"action": {"enum": ["create"]}, "payload": INGREDIENT_PROFILE_DRAFT_SCHEMA["properties"]["payload"]},
            },
            {
                "description": "更新食材档案。",
                "required": ["draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "payload"],
                "properties": {
                    "action": {"enum": ["update"]},
                    "targetId": {"type": "string", "minLength": 1},
                    "baseUpdatedAt": {"type": "string", "minLength": 1},
                    "payload": INGREDIENT_PROFILE_DRAFT_SCHEMA["properties"]["payload"],
                },
            },
            {
                "description": "批量新增 2-5 个食材档案。",
                "required": ["draftType", "schemaVersion", "operations"],
                "properties": {
                    "operations": INGREDIENT_PROFILE_DRAFT_SCHEMA["properties"]["operations"],
                },
            },
        ],
    }
)

MEAL_LOG_CREATE_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["date", "mealType", "foods"],
    "properties": {
        "date": MEAL_LOG_DRAFT_SCHEMA["properties"]["date"],
        "mealType": MEAL_LOG_DRAFT_SCHEMA["properties"]["mealType"],
        "participantUserIds": MEAL_LOG_DRAFT_SCHEMA["properties"]["participantUserIds"],
        "mood": MEAL_LOG_DRAFT_SCHEMA["properties"]["mood"],
        "mediaIds": MEAL_LOG_DRAFT_SCHEMA["properties"]["mediaIds"],
        "planItemId": MEAL_LOG_DRAFT_SCHEMA["properties"]["planItemId"],
        "planItemBaseUpdatedAt": MEAL_LOG_DRAFT_SCHEMA["properties"]["planItemBaseUpdatedAt"],
        "foods": MEAL_LOG_DRAFT_SCHEMA["properties"]["foods"],
        "notes": MEAL_LOG_DRAFT_SCHEMA["properties"]["notes"],
    },
}
MEAL_LOG_UPDATE_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "participantUserIds": MEAL_LOG_DRAFT_SCHEMA["properties"]["payload"]["properties"]["participantUserIds"],
        "notes": MEAL_LOG_DRAFT_SCHEMA["properties"]["payload"]["properties"]["notes"],
        "mood": MEAL_LOG_DRAFT_SCHEMA["properties"]["payload"]["properties"]["mood"],
        "mediaIds": MEAL_LOG_DRAFT_SCHEMA["properties"]["payload"]["properties"]["mediaIds"],
    },
}
MEAL_LOG_RATING_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["foodEntryRatings"],
    "properties": {"foodEntryRatings": {**MEAL_LOG_DRAFT_SCHEMA["properties"]["payload"]["properties"]["foodEntryRatings"], "minItems": 1}},
}
MEAL_LOG_DRAFT_SCHEMA.update(
    {
        "description": "餐食记录草稿必须提供 date、mealType、foods，或提供有效 action 操作草稿；不要提交只有 draftType/schemaVersion 的空草稿。",
        "anyOf": [
            {"description": "普通新增餐食记录。", "required": ["draftType", "schemaVersion", "date", "mealType", "foods"], "properties": {"schemaVersion": {"enum": ["meal_log.v1"]}}},
            {
                "description": "操作式新增餐食记录。",
                "required": ["draftType", "schemaVersion", "action", "payload"],
                "properties": {"schemaVersion": {"enum": ["meal_log_operation.v1"]}, "action": {"enum": ["create"]}, "payload": MEAL_LOG_CREATE_PAYLOAD_SCHEMA},
            },
            {
                "description": "更新餐食记录详情。",
                "required": ["draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "payload"],
                "properties": {
                    "schemaVersion": {"enum": ["meal_log_operation.v1"]},
                    "action": {"enum": ["update_details"]},
                    "targetId": {"type": "string", "minLength": 1},
                    "baseUpdatedAt": {"type": "string", "minLength": 1},
                    "payload": MEAL_LOG_UPDATE_PAYLOAD_SCHEMA,
                },
            },
            {
                "description": "更新餐食记录评分。",
                "required": ["draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "payload"],
                "properties": {
                    "schemaVersion": {"enum": ["meal_log_operation.v1"]},
                    "action": {"enum": ["rate_food"]},
                    "targetId": {"type": "string", "minLength": 1},
                    "baseUpdatedAt": {"type": "string", "minLength": 1},
                    "payload": MEAL_LOG_RATING_PAYLOAD_SCHEMA,
                },
            },
        ],
    }
)

_RECIPE_COOK_SHARED_PROPERTIES: dict[str, Any] = {
    "draftType": {"type": "string", "enum": ["recipe_cook"]},
    "recipeId": {"type": "string", "minLength": 1},
    "title": {"type": "string", "minLength": 1, "maxLength": 120},
    "baseUpdatedAt": {"type": ["string", "null"]},
    "before": {"type": ["object", "null"]},
    "servings": {"type": "number", "exclusiveMinimum": 0},
    "date": {"type": "string", "minLength": 10, "maxLength": 10},
    "mealType": {"type": "string", "enum": MEAL_TYPE_VALUES},
    "participantUserIds": {"type": "array", "maxItems": 20, "items": {"type": "string", "minLength": 1}},
    "notes": {"type": "string", "maxLength": 1000},
    "planItemId": {"type": ["string", "null"]},
    "planItemBaseUpdatedAt": {"type": ["string", "null"]},
    "resultNote": {"type": "string", "maxLength": 2000},
    "adjustments": {"type": "string", "maxLength": 2000},
    "rating": {"type": ["integer", "null"], "minimum": 1, "maximum": 5},
    "operationId": {"type": ["string", "null"], "minLength": 1, "maxLength": 64},
    "previewItems": {
        "type": "array",
        "maxItems": 50,
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["ingredient_id", "ingredient_name", "requested_quantity", "unit", "batches"],
            "properties": {
                "ingredient_id": {"type": "string", "minLength": 1},
                "ingredient_name": {"type": "string", "minLength": 1, "maxLength": 120},
                "requested_quantity": {"type": "number", "exclusiveMinimum": 0},
                "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                "quantity_tracking_mode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
                "deduction_note": {"type": ["string", "null"], "maxLength": 255},
                "batches": {
                    "type": "array",
                    "maxItems": 50,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["inventory_item_id", "quantity", "unit", "purchase_date", "storage_location"],
                        "properties": {
                            "inventory_item_id": {"type": "string", "minLength": 1},
                            "quantity": {"type": "number", "exclusiveMinimum": 0},
                            "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                            "purchase_date": {"type": "string", "minLength": 10, "maxLength": 10},
                            "expiry_date": {"type": ["string", "null"]},
                            "storage_location": {"type": "string", "minLength": 1, "maxLength": 120},
                        },
                    },
                },
            },
        },
    },
    "shortages": {
        "type": "array",
        "maxItems": 50,
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["ingredient_name", "required_quantity", "available_quantity", "missing_quantity", "unit"],
            "properties": {
                "ingredient_id": {"type": ["string", "null"]},
                "ingredient_name": {"type": "string", "minLength": 1, "maxLength": 120},
                "required_quantity": {"type": "number", "minimum": 0},
                "available_quantity": {"type": "number", "minimum": 0},
                "missing_quantity": {"type": "number", "exclusiveMinimum": 0},
                "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                "shortage_type": {"type": "string", "maxLength": 64},
            },
        },
    },
    "inventoryBoundaries": {
        "type": "array",
        "maxItems": 50,
        "description": "后端根据库存预览固化的并发边界；模型不需要自行填写。",
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "ingredientId",
                "quantityTrackingMode",
                "expectedIngredientRowVersion",
                "stateId",
                "expectedStateRowVersion",
                "batches",
            ],
            "properties": {
                "ingredientId": {"type": "string", "minLength": 1, "maxLength": 64},
                "quantityTrackingMode": {
                    "type": "string",
                    "enum": ["track_quantity", "not_track_quantity"],
                },
                "expectedIngredientRowVersion": {"type": "integer", "minimum": 1},
                "stateId": {"type": ["string", "null"], "maxLength": 64},
                "expectedStateRowVersion": {"type": ["integer", "null"], "minimum": 1},
                "batches": {
                    "type": "array",
                    "maxItems": 100,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["inventoryItemId", "expectedRowVersion"],
                        "properties": {
                            "inventoryItemId": {"type": "string", "minLength": 1, "maxLength": 64},
                            "expectedRowVersion": {"type": "integer", "minimum": 1},
                        },
                    },
                },
            },
        },
    },
}

# B1 generator-facing schema remains v1 (includes createMealLog).
RECIPE_COOK_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "draftType",
        "schemaVersion",
        "recipeId",
        "title",
        "servings",
        "date",
        "mealType",
        "createMealLog",
        "previewItems",
        "shortages",
        "inventoryBoundaries",
    ],
    "properties": {
        **_RECIPE_COOK_SHARED_PROPERTIES,
        "schemaVersion": {"type": "string", "enum": ["recipe_cook_operation.v1"]},
        "createMealLog": {"type": "boolean"},
    },
}

# Persisted acceptance schema for v2 readers/normalizers (no createMealLog).
RECIPE_COOK_DRAFT_V2_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "draftType",
        "schemaVersion",
        "recipeId",
        "title",
        "servings",
        "date",
        "mealType",
        "previewItems",
        "shortages",
        "inventoryBoundaries",
    ],
    "properties": {
        **_RECIPE_COOK_SHARED_PROPERTIES,
        "schemaVersion": {"type": "string", "enum": ["recipe_cook_operation.v2"]},
    },
}

RECIPE_COOK_DRAFT_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "做菜确认草稿输入。模型只需要提供真实 recipeId、份数和用户明确给出的日期/餐别/记录餐食意图；"
        "previewItems 和 shortages 会由后端根据当前库存重新计算，不要求模型手写。"
        "B1 生成版本固定为 recipe_cook_operation.v1。"
    ),
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "recipeId", "servings"],
    "properties": RECIPE_COOK_DRAFT_SCHEMA["properties"],
}

FOOD_PROFILE_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "食物资料草稿。创建食物资料时必须填写 name、type、category；"
        "如果用户描述中可推断这些字段，必须先推断并填入，不要提交空 payload；"
        "确实无法推断时应调用 human.request_input，而不是调用本工具。"
    ),
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion"],
    "anyOf": [
        {
            "description": "普通新增食物资料草稿。",
            "required": ["draftType", "schemaVersion", "name", "type", "category"],
            "properties": {
                "schemaVersion": {"enum": ["food_profile.v1"]},
                "name": {"type": "string", "minLength": 1},
                "type": {"type": "string", "enum": FOOD_TYPE_VALUES},
                "category": {"type": "string", "minLength": 1},
            },
        },
        {
            "description": "操作式新增食物资料草稿。",
            "required": ["draftType", "schemaVersion", "action", "payload"],
            "properties": {
                "schemaVersion": {"enum": ["food_profile_operation.v1"]},
                "action": {"enum": ["create"]},
                "payload": {
                    "type": "object",
                    "required": ["name", "type", "category"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1},
                        "type": {"type": "string", "enum": FOOD_TYPE_VALUES},
                        "category": {"type": "string", "minLength": 1},
                    },
                },
            },
        },
        {
            "description": "操作式更新食物资料草稿。",
            "required": ["draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "payload"],
            "properties": {
                "schemaVersion": {"enum": ["food_profile_operation.v1"]},
                "action": {"enum": ["update"]},
                "targetId": {"type": "string", "minLength": 1},
                "baseUpdatedAt": {"type": "string", "minLength": 1},
                "payload": {
                    "type": "object",
                    "required": ["name", "type", "category"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1},
                        "type": {"type": "string", "enum": FOOD_TYPE_VALUES},
                        "category": {"type": "string", "minLength": 1},
                    },
                },
            },
        },
        {
            "description": "操作式收藏状态草稿。",
            "required": ["draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "payload"],
            "properties": {
                "schemaVersion": {"enum": ["food_profile_operation.v1"]},
                "action": {"enum": ["set_favorite"]},
                "targetId": {"type": "string", "minLength": 1},
                "baseUpdatedAt": {"type": "string", "minLength": 1},
                "payload": {
                    "type": "object",
                    "required": ["favorite"],
                    "properties": {"favorite": {"type": "boolean"}},
                },
            },
        },
    ],
    "properties": {
        "draftType": {"type": "string", "enum": ["food_profile"], "description": "固定为 food_profile。"},
        "schemaVersion": {
            "type": "string",
            "enum": ["food_profile.v1", "food_profile_operation.v1"],
            "description": "新增食物资料优先使用 food_profile.v1；操作式草稿使用 food_profile_operation.v1。",
        },
        "action": {
            "type": "string",
            "enum": ["create", "update", "set_favorite"],
            "description": "操作式草稿动作。action=create 时 payload.name、payload.type、payload.category 必填。",
        },
        "targetId": {"type": ["string", "null"]},
        "baseUpdatedAt": {"type": ["string", "null"]},
        "before": {"type": ["object", "null"]},
        "name": {"type": "string", "minLength": 1, "maxLength": 80, "description": "食物名称，创建草稿必填，例如 盒装牛奶。"},
        "type": {
            "type": "string",
            "enum": FOOD_TYPE_VALUES,
            "description": "食物类型，创建草稿必填。自制= selfMade，外卖= takeout，堂食/外食= diningOut，即食/现成/盒装= readyMade，速食/方便食品= instant。",
        },
        "category": {"type": "string", "maxLength": 80, "description": "食物分类，创建草稿必填；可根据名称推断，例如牛奶/酸奶=饮品。"},
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
        "stock_quantity": {"type": ["number", "null"], "minimum": 0, "multipleOf": 0.1},
        "stock_unit": {"type": "string", "maxLength": 20},
        "storage_location": {"type": "string", "enum": ["冷藏", "冷冻", "常温", ""]},
        "favorite": {"type": "boolean"},
        "recipe_id": {"type": ["string", "null"]},
        "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "payload": {
            "type": "object",
            "description": "操作式草稿 payload。action=create/update 时 name、type、category 必填；set_favorite 时只提供 favorite。",
            "additionalProperties": False,
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 80, "description": "食物名称，create/update 必填。"},
                "type": {
                    "type": "string",
                    "enum": FOOD_TYPE_VALUES,
                    "description": "食物类型，create/update 必填。即食/现成/盒装通常用 readyMade；速食/方便食品用 instant。",
                },
                "category": {"type": "string", "maxLength": 80, "description": "食物分类，create/update 必填；可根据食物名称推断。"},
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
                "stock_quantity": {"type": ["number", "null"], "minimum": 0, "multipleOf": 0.1},
                "stock_unit": {"type": "string", "maxLength": 20},
                "storage_location": {"type": "string", "enum": ["冷藏", "冷冻", "常温", ""]},
                "favorite": {"type": "boolean"},
                "recipe_id": {"type": ["string", "null"]},
                "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
            },
        },
    },
}

INVENTORY_OPERATION_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draftType", "schemaVersion", "operations"],
    "properties": {
        "draftType": {"type": "string", "enum": ["inventory_operation"]},
        "schemaVersion": {"type": "string", "enum": ["inventory_operation.v1"]},
        "source": {"type": "object"},
        "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 50,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["action", "ingredientId"],
                "properties": {
                    "action": {"type": "string", "enum": ["restock", "consume", "dispose"]},
                    "ingredientId": {"type": "string", "minLength": 1, "maxLength": 64},
                    "ingredientName": {"type": "string", "maxLength": 120},
                    "quantityTrackingMode": {
                        "type": "string",
                        "enum": ["track_quantity", "not_track_quantity"],
                        "description": "后端归一化草稿时固化的食材数量记录方式；模型不需要自行填写。",
                    },
                    "expectedIngredientRowVersion": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "后端归一化草稿时固化的食材库存集合版本；模型不需要自行填写。",
                    },
                    "stateId": {
                        "type": ["string", "null"],
                        "maxLength": 64,
                        "description": "后端归一化 presence-only 草稿时固化的库存状态 ID。",
                    },
                    "expectedStateRowVersion": {
                        "type": ["integer", "null"],
                        "minimum": 1,
                        "description": "后端归一化 presence-only 草稿时固化的库存状态版本。",
                    },
                    "inventoryItemId": {
                        "type": ["string", "null"],
                        "maxLength": 64,
                        "description": (
                            "库存批次 ID。consume 操作可省略，后端会按到期日、采购日和创建时间扣减可用批次，"
                            "并在草稿中展示 batchOptions；dispose 操作必须提供真实批次 ID。"
                        ),
                    },
                    "expectedInventoryItemRowVersion": {
                        "type": ["integer", "null"],
                        "minimum": 1,
                        "description": "后端归一化显式批次草稿时固化的库存批次版本。",
                    },
                    "availabilityLevel": {
                        "type": ["string", "null"],
                        "enum": ["present_unknown", "low", "sufficient", None],
                        "description": "不记录精确数量的补货结果；absent 不属于补货操作。",
                    },
                    "quantity": {"type": ["number", "null"], "exclusiveMinimum": 0},
                    "unit": {"type": "string", "minLength": 1, "maxLength": 32},
                    "purchaseDate": {"type": ["string", "null"], "maxLength": 10},
                    "expiryDate": {"type": ["string", "null"], "maxLength": 10},
                    "storageLocation": {"type": ["string", "null"], "maxLength": 120},
                    "status": {"type": ["string", "null"], "enum": [*INVENTORY_STATUS_VALUES, None]},
                    "notes": {"type": "string", "maxLength": 1000},
                    "lowStockThreshold": {"type": ["number", "null"], "minimum": 0},
                    "reason": {"type": "string", "maxLength": 255},
                    "sourceQuantity": {"type": ["number", "null"], "exclusiveMinimum": 0},
                    "sourceUnit": {"type": ["string", "null"], "maxLength": 32},
                    "conversionRatioToDefault": {"type": ["number", "null"], "exclusiveMinimum": 0},
                    "conversionNote": {"type": ["string", "null"], "maxLength": 255},
                    "image": {"type": ["object", "null"]},
                    "remainingQuantity": {"type": ["number", "null"], "minimum": 0},
                    "batchOptions": {
                        "type": "array",
                        "description": "后端归一化草稿时补充的可用批次候选，供用户审批时核对；模型不需要自行编造。",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "label", "remainingQuantity", "unit"],
                            "properties": {
                                "id": {"type": "string"},
                                "label": {"type": "string"},
                                "remainingQuantity": {"type": "number", "minimum": 0},
                                "unit": {"type": "string"},
                                "expiryDate": {"type": ["string", "null"]},
                                "rowVersion": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "后端归一化候选批次时固化的并发版本。",
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}
