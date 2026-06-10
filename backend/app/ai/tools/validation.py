from __future__ import annotations

import re
from typing import Any


def validate_json_value(value: Any, schema: dict[str, Any], *, location: str) -> None:
    expected_type = schema.get("type")
    if expected_type is not None and not _matches_type(value, expected_type):
        raise ValueError(f"{location} must be {expected_type}")

    if isinstance(value, dict):
        required = schema.get("required")
        if isinstance(required, list):
            missing = [key for key in required if key not in value]
            if missing:
                raise ValueError(f"{location} missing required fields: {', '.join(missing)}")

        properties = schema.get("properties")
        if isinstance(properties, dict):
            if schema.get("additionalProperties") is False:
                extra = [key for key in value if key not in properties]
                if extra:
                    raise ValueError(f"{location} contains unknown fields: {', '.join(extra)}")
            for key, item in value.items():
                item_schema = properties.get(key)
                if isinstance(item_schema, dict):
                    validate_json_value(item, item_schema, location=f"{location}.{key}")

    if isinstance(value, list):
        min_items = schema.get("minItems")
        max_items = schema.get("maxItems")
        if min_items is not None and len(value) < min_items:
            raise ValueError(f"{location} must contain at least {min_items} items")
        if max_items is not None and len(value) > max_items:
            raise ValueError(f"{location} must contain at most {max_items} items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_json_value(item, item_schema, location=f"{location}[{index}]")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        exclusive_minimum = schema.get("exclusiveMinimum")
        if minimum is not None and value < minimum:
            raise ValueError(f"{location} must be >= {minimum}")
        if exclusive_minimum is not None and value <= exclusive_minimum:
            raise ValueError(f"{location} must be > {exclusive_minimum}")
        if maximum is not None and value > maximum:
            raise ValueError(f"{location} must be <= {maximum}")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        max_length = schema.get("maxLength")
        pattern = schema.get("pattern")
        if min_length is not None and len(value) < min_length:
            raise ValueError(f"{location} must contain at least {min_length} characters")
        if max_length is not None and len(value) > max_length:
            raise ValueError(f"{location} must contain at most {max_length} characters")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            raise ValueError(f"{location} does not match required pattern")

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        raise ValueError(f"{location} must be one of: {', '.join(str(item) for item in enum)}")


def _matches_type(value: Any, expected: str | list[str]) -> bool:
    if isinstance(expected, list):
        return any(_matches_type(value, item) for item in expected)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True
