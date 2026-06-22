from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry


HUMAN_INPUT_OPTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 120},
        "label": {"type": "string", "minLength": 1, "maxLength": 160},
        "description": {"type": ["string", "null"], "maxLength": 360},
    },
    "required": ["id", "label"],
}
HUMAN_INPUT_REQUEST_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "question": {"type": "string", "minLength": 1, "maxLength": 240},
        "inputMode": {"type": "string", "enum": ["choice", "text", "choice_or_text"]},
        "options": {
            "type": "array",
            "items": HUMAN_INPUT_OPTION_SCHEMA,
            "maxItems": 12,
        },
        "allowMultiple": {"type": "boolean"},
        "required": {"type": "boolean"},
        "reason": {"type": ["string", "null"], "maxLength": 360},
        "sourceSkills": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 80},
            "maxItems": 8,
        },
        "resumeHint": {"type": "object"},
    },
    "required": ["question", "inputMode"],
}
HUMAN_INPUT_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "question": {"type": "string"},
        "inputMode": {"type": "string"},
        "options": {"type": "array", "items": HUMAN_INPUT_OPTION_SCHEMA},
        "allowMultiple": {"type": "boolean"},
        "required": {"type": "boolean"},
        "reason": {"type": ["string", "null"]},
        "sourceSkills": {"type": "array", "items": {"type": "string"}},
        "resumeHint": {"type": "object"},
    },
    "required": ["question", "inputMode", "options", "allowMultiple", "required", "sourceSkills", "resumeHint"],
}


def human_request_input(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    input_mode = str(payload.get("inputMode") or "choice_or_text")
    options = payload.get("options") if isinstance(payload.get("options"), list) else []
    return {
        "question": str(payload.get("question") or "").strip(),
        "inputMode": input_mode,
        "options": options,
        "allowMultiple": bool(payload.get("allowMultiple", False)),
        "required": bool(payload.get("required", True)),
        "reason": str(payload.get("reason") or "").strip() or None,
        "sourceSkills": payload.get("sourceSkills") if isinstance(payload.get("sourceSkills"), list) else [],
        "resumeHint": payload.get("resumeHint") if isinstance(payload.get("resumeHint"), dict) else {},
    }


def register_intent_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="human.request_input",
        display_name="询问用户",
        description=(
            "当信息不足、需要用户从候选项中选择，或需要自由文本补充时调用。"
            "该工具只收集信息，不代表用户批准写入；正式写入仍必须走 draft approval。"
        ),
        side_effect="read",
        handler=human_request_input,
        input_schema=HUMAN_INPUT_REQUEST_SCHEMA,
        output_schema=HUMAN_INPUT_RESULT_SCHEMA,
    )
