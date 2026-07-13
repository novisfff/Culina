from __future__ import annotations

RECIPE_COOK_V1 = "recipe_cook_operation.v1"
RECIPE_COOK_V2 = "recipe_cook_operation.v2"
RECIPE_COOK_ACCEPTED_VERSIONS = frozenset({RECIPE_COOK_V1, RECIPE_COOK_V2})
RECIPE_COOK_GENERATED_VERSION = RECIPE_COOK_V1


def accepted_recipe_cook_versions() -> set[str]:
    return set(RECIPE_COOK_ACCEPTED_VERSIONS)


def generated_recipe_cook_version() -> str:
    return RECIPE_COOK_GENERATED_VERSION


def require_recipe_cook_schema_version(payload: dict) -> str:
    schema_version = str(payload.get("schemaVersion") or payload.get("schema_version") or "").strip()
    if not schema_version:
        schema_version = RECIPE_COOK_GENERATED_VERSION
    if schema_version not in RECIPE_COOK_ACCEPTED_VERSIONS:
        raise ValueError(f"不支持的做菜草稿版本: {schema_version}")
    return schema_version
