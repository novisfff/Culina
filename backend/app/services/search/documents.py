from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Iterable

from app.models.domain import Food, Ingredient, Recipe

DOCUMENT_BUILDER_VERSION = "v1"
DEFAULT_EMBEDDING_MODEL = ""
DEFAULT_EMBEDDING_DIMENSIONS = 0
MAX_NOTE_CHARS = 500
MAX_STEP_TEXT_CHARS = 700


@dataclass(frozen=True)
class SearchDocumentPayload:
    family_id: str
    entity_type: str
    entity_id: str
    title_text: str
    keyword_text: str
    detail_text: str
    semantic_text: str
    metadata_json: dict[str, Any]
    content_hash: str
    document_builder_version: str = DOCUMENT_BUILDER_VERSION
    embedding_model: str = DEFAULT_EMBEDDING_MODEL
    embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS


def build_ingredient_search_document(
    ingredient: Ingredient,
    *,
    embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
) -> SearchDocumentPayload:
    metadata = {
        "name": ingredient.name,
        "category": ingredient.category,
        "default_unit": ingredient.default_unit,
        "default_storage": ingredient.default_storage,
        "default_expiry_mode": _value(ingredient.default_expiry_mode),
        "default_expiry_days": ingredient.default_expiry_days,
        "quantity_tracking_mode": _value(ingredient.quantity_tracking_mode),
    }
    title_text = _normalize_text(ingredient.name)
    keyword_text = _join_text(
        ingredient.name,
        ingredient.category,
        ingredient.default_unit,
        ingredient.default_storage,
        _value(ingredient.default_expiry_mode),
    )
    detail_text = _join_text(
        _truncate(ingredient.notes, MAX_NOTE_CHARS),
        *_unit_conversion_labels(ingredient.unit_conversions),
        _format_low_stock_threshold(ingredient.default_low_stock_threshold, ingredient.default_unit),
    )
    semantic_text = _semantic_text(
        ("食材", ingredient.name),
        ("分类", ingredient.category),
        ("默认单位", ingredient.default_unit),
        ("储存方式", ingredient.default_storage),
        ("保质期规则", _expiry_text(_value(ingredient.default_expiry_mode), ingredient.default_expiry_days)),
        ("备注", _truncate(ingredient.notes, MAX_NOTE_CHARS)),
    )
    return _payload(
        family_id=ingredient.family_id,
        entity_type="ingredient",
        entity_id=ingredient.id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text=detail_text,
        semantic_text=semantic_text,
        metadata_json=metadata,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def build_food_search_document(
    food: Food,
    *,
    embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
) -> SearchDocumentPayload:
    metadata = {
        "name": food.name,
        "type": _value(food.type),
        "category": food.category,
        "flavor_tags": _clean_list(food.flavor_tags),
        "scene_tags": _clean_list(food.scene_tags),
        "suitable_meal_types": [_value(item) for item in food.suitable_meal_types or []],
        "favorite": food.favorite,
        "rating": food.rating,
        "repurchase": food.repurchase,
        "recipe_id": food.recipe_id,
    }
    title_text = _normalize_text(food.name)
    keyword_text = _join_text(
        food.name,
        _value(food.type),
        food.category,
        *_clean_list(food.flavor_tags),
        *_clean_list(food.scene_tags),
        *[_value(item) for item in food.suitable_meal_types or []],
        food.source_name,
        food.purchase_source,
        food.scene,
    )
    detail_text = _join_text(
        _truncate(food.notes, MAX_NOTE_CHARS),
        _truncate(food.routine_note, MAX_NOTE_CHARS),
    )
    semantic_text = _semantic_text(
        ("食物", food.name),
        ("类型", _value(food.type)),
        ("分类", food.category),
        ("口味", "、".join(_clean_list(food.flavor_tags))),
        ("场景", "、".join(_clean_list([*(food.scene_tags or []), food.scene]))),
        ("适合餐别", "、".join(_value(item) for item in food.suitable_meal_types or [])),
        ("来源", _join_text(food.source_name, food.purchase_source)),
        ("日常说明", _truncate(food.routine_note, MAX_NOTE_CHARS)),
        ("备注", _truncate(food.notes, MAX_NOTE_CHARS)),
    )
    return _payload(
        family_id=food.family_id,
        entity_type="food",
        entity_id=food.id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text=detail_text,
        semantic_text=semantic_text,
        metadata_json=metadata,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def build_recipe_search_document(
    recipe: Recipe,
    *,
    embedding_model: str = DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
) -> SearchDocumentPayload:
    ingredient_lines = [
        _join_text(item.ingredient_name, _format_decimal(item.quantity), item.unit, _truncate(item.note, 120))
        for item in recipe.ingredient_items
    ]
    step_keyword_parts = [
        part
        for step in recipe.steps
        for part in [step.title or "", step.summary, *(_clean_list(step.key_points))]
        if _normalize_text(part)
    ]
    step_semantic_lines = [
        _join_text(
            step.title or "",
            step.summary,
            "、".join(_clean_list(step.key_points)),
            _truncate(step.text, MAX_STEP_TEXT_CHARS),
            _truncate(step.tip, 160),
        )
        for step in recipe.steps
    ]
    metadata = {
        "title": recipe.title,
        "difficulty": _value(recipe.difficulty),
        "prep_minutes": recipe.prep_minutes,
        "servings": recipe.servings,
        "scene_tags": _clean_list(recipe.scene_tags),
        "ingredient_names": [item.ingredient_name for item in recipe.ingredient_items if _normalize_text(item.ingredient_name)],
    }
    title_text = _normalize_text(recipe.title)
    keyword_text = _join_text(
        recipe.title,
        *_clean_list(recipe.scene_tags),
        _value(recipe.difficulty),
        *(item.ingredient_name for item in recipe.ingredient_items),
        *step_keyword_parts,
    )
    detail_text = _join_text(
        _truncate(recipe.tips, MAX_NOTE_CHARS),
        *(item.note for item in recipe.ingredient_items),
        *(step.text for step in recipe.steps),
        *(step.tip for step in recipe.steps),
    )
    semantic_text = _semantic_text(
        ("菜谱", recipe.title),
        ("场景", "、".join(_clean_list(recipe.scene_tags))),
        ("难度", _value(recipe.difficulty)),
        ("耗时", f"{recipe.prep_minutes} 分钟" if recipe.prep_minutes else ""),
        ("份量", f"{recipe.servings} 人份" if recipe.servings else ""),
        ("食材", "；".join(ingredient_lines)),
        ("步骤", "；".join(step_semantic_lines)),
        ("小贴士", _truncate(recipe.tips, MAX_NOTE_CHARS)),
    )
    return _payload(
        family_id=recipe.family_id,
        entity_type="recipe",
        entity_id=recipe.id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text=detail_text,
        semantic_text=semantic_text,
        metadata_json=metadata,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def _payload(
    *,
    family_id: str,
    entity_type: str,
    entity_id: str,
    title_text: str,
    keyword_text: str,
    detail_text: str,
    semantic_text: str,
    metadata_json: dict[str, Any],
    embedding_model: str,
    embedding_dimensions: int,
) -> SearchDocumentPayload:
    normalized_metadata = _jsonable(metadata_json)
    content_hash = _content_hash(
        entity_type=entity_type,
        entity_id=entity_id,
        semantic_text=semantic_text,
        metadata_json=normalized_metadata,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
        document_builder_version=DOCUMENT_BUILDER_VERSION,
    )
    return SearchDocumentPayload(
        family_id=family_id,
        entity_type=entity_type,
        entity_id=entity_id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text=detail_text,
        semantic_text=semantic_text,
        metadata_json=normalized_metadata,
        content_hash=content_hash,
        embedding_model=embedding_model,
        embedding_dimensions=embedding_dimensions,
    )


def _content_hash(
    *,
    entity_type: str,
    entity_id: str,
    semantic_text: str,
    metadata_json: dict[str, Any],
    embedding_model: str,
    embedding_dimensions: int,
    document_builder_version: str,
) -> str:
    payload = {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "semantic_text": semantic_text,
        "metadata_json": metadata_json,
        "embedding_model": embedding_model,
        "embedding_dimensions": embedding_dimensions,
        "document_builder_version": document_builder_version,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _semantic_text(*fields: tuple[str, object]) -> str:
    lines = []
    for label, raw_value in fields:
        value = _normalize_text(raw_value)
        if value:
            lines.append(f"{label}：{value}")
    return "\n".join(lines)


def _join_text(*values: object) -> str:
    parts = [_normalize_text(value) for value in values]
    return " ".join(dict.fromkeys(part for part in parts if part))


def _normalize_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return _join_text(*value)
    text = str(_value(value))
    text = text.strip()
    text = re.sub(r"\s+", " ", text)
    return text


def _truncate(value: object, limit: int) -> str:
    text = _normalize_text(value)
    return text[:limit]


def _value(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    return value


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


def _clean_list(values: Iterable[object] | None) -> list[str]:
    cleaned = [_normalize_text(value) for value in values or []]
    return list(dict.fromkeys(value for value in cleaned if value))


def _unit_conversion_labels(values: list[dict[str, Any]] | None) -> list[str]:
    labels = []
    for item in values or []:
        unit = _normalize_text(item.get("unit"))
        if unit:
            labels.append(unit)
    return labels


def _format_low_stock_threshold(value: Decimal | None, unit: str) -> str:
    if value is None:
        return ""
    return _join_text("低库存阈值", _format_decimal(value), unit)


def _format_decimal(value: Decimal | int | float | None) -> str:
    if value is None:
        return ""
    if isinstance(value, Decimal):
        text = format(value.normalize(), "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text or "0"
    return str(value)


def _expiry_text(mode: str, days: int | None) -> str:
    if days is None:
        return mode
    return _join_text(mode, f"{days} 天")
