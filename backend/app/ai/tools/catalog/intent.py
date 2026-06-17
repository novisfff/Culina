from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.catalog.inventory_unit_conversion import normalize_pending_unit_mismatch
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import INVENTORY_OPERATION_DRAFT_SCHEMA


UNIT_MISMATCH_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "ingredientId",
        "ingredientName",
        "defaultUnit",
        "unsupportedUnit",
        "supportedUnits",
        "originalDraft",
    ],
    "properties": {
        "type": {"type": "string", "enum": ["inventory_unit_mismatch"]},
        "ingredientId": {"type": "string", "minLength": 1, "maxLength": 64},
        "ingredientName": {"type": "string", "minLength": 1, "maxLength": 120},
        "defaultUnit": {"type": "string", "minLength": 1, "maxLength": 32},
        "unsupportedUnit": {"type": "string", "minLength": 1, "maxLength": 32},
        "supportedUnits": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {"type": "string", "minLength": 1, "maxLength": 32},
        },
        "originalDraft": INVENTORY_OPERATION_DRAFT_SCHEMA,
    },
}
UNIT_MISMATCH_OUTPUT = {
    **UNIT_MISMATCH_INPUT,
    "required": [*UNIT_MISMATCH_INPUT["required"], "type"],
    "properties": {"type": {"type": "string"}, **UNIT_MISMATCH_INPUT["properties"]},
}


CLARIFICATION_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "question": {"type": "string", "minLength": 1, "maxLength": 200},
        "questionType": {
            "type": "string",
            "enum": [
                "missing_fields",
                "entity_disambiguation",
                "meal_plan_disambiguation",
                "quantity",
                "delete_impact",
                "time_scope",
                "confirmation",
                "unit_conversion",
                "other",
            ],
        },
        "missingFields": {"type": "array", "items": {"type": "string"}},
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string", "minLength": 1, "maxLength": 64},
                    "label": {"type": "string", "minLength": 1, "maxLength": 120},
                    "summary": {"type": ["string", "null"], "maxLength": 240},
                    "entityType": {"type": ["string", "null"], "maxLength": 40},
                    "updatedAt": {"type": ["string", "null"], "maxLength": 64},
                },
                "required": ["id", "label"],
            },
        },
        "allowFreeText": {"type": "boolean"},
        "unitMismatch": UNIT_MISMATCH_INPUT,
    },
    "required": ["question", "questionType"],
}
CLARIFICATION_OUTPUT = {
    "type": "object",
    "required": ["question", "questionType", "missingFields", "candidates", "allowFreeText"],
    "properties": {
        "question": {"type": "string"},
        "questionType": {"type": "string"},
        "missingFields": {"type": "array", "items": {"type": "string"}},
        "candidates": {"type": "array", "items": {"type": "object"}},
        "allowFreeText": {"type": "boolean"},
        "unitMismatch": UNIT_MISMATCH_OUTPUT,
    },
}


def intent_request_clarification(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    question_type = str(payload.get("questionType") or "other")
    unit_mismatch = None
    if question_type == "unit_conversion":
        raw_unit_mismatch = payload.get("unitMismatch") if isinstance(payload.get("unitMismatch"), dict) else None
        if raw_unit_mismatch is None:
            raise ValueError("单位换算澄清必须提供 unitMismatch")
        unit_mismatch = normalize_pending_unit_mismatch(raw_unit_mismatch)
    return {
        "question": str(payload.get("question") or "").strip(),
        "questionType": question_type,
        "missingFields": payload.get("missingFields") or [],
        "candidates": payload.get("candidates") or [],
        "allowFreeText": bool(payload.get("allowFreeText", True)),
        **({"unitMismatch": unit_mismatch} if unit_mismatch is not None else {}),
    }


def register_intent_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="intent.request_clarification",
        display_name="补充信息请求",
        description=(
            "请求用户补充缺失信息。库存入库遇到食材不支持的单位时，必须使用 questionType=unit_conversion，"
            "并提供 unitMismatch：食材 id/名称、主单位、不支持单位、支持单位列表和原始 inventory_operation 草稿；"
            "不要先调用 inventory.create_operation_draft 去触发单位错误。"
        ),
        side_effect="read",
        handler=intent_request_clarification,
        input_schema=CLARIFICATION_INPUT,
        output_schema=CLARIFICATION_OUTPUT,
    )
