from __future__ import annotations

from typing import Any


EMPTY_INPUT: dict[str, Any] = {"type": "object", "additionalProperties": False, "properties": {}}
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
