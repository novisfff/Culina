from __future__ import annotations

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
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_json_value(item, item_schema, location=f"{location}[{index}]")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if minimum is not None and value < minimum:
            raise ValueError(f"{location} must be >= {minimum}")
        if maximum is not None and value > maximum:
            raise ValueError(f"{location} must be <= {maximum}")


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
