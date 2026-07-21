from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import INVENTORY_INTAKE_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.core.utils import create_id
from app.models.domain import Ingredient
from app.services.ai_operations.inventory_intake import normalize_inventory_intake_draft
from app.services.ai_operations.registry_types import DraftNormalizeContext
from app.services.ingredient_units import get_supported_units, normalize_unit_label
from app.services.inventory_usage import tracks_quantity


INTAKE_ITEM_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ingredientId"],
    "properties": {
        "ingredientId": {"type": "string", "minLength": 1, "maxLength": 64},
        "quantity": {"type": ["string", "null"], "pattern": "^[0-9]+(?:\\.[0-9]+)?$"},
        "unit": {"type": ["string", "null"], "maxLength": 32},
        "confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
        "sourceLabel": {"type": ["string", "null"], "maxLength": 120},
    },
}

INTAKE_CANDIDATE_OUTPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ingredientId", "name", "quantityMode", "quantity", "unit", "selected", "warnings"],
    "properties": {
        "ingredientId": {"type": "string"},
        "name": {"type": "string"},
        "quantityMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
        "quantity": {"type": ["string", "null"]},
        "unit": {"type": ["string", "null"]},
        "selected": {"type": "boolean"},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": ["number", "null"]},
        "sourceLabel": {"type": ["string", "null"]},
    },
}

INVENTORY_INTAKE_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {"type": "array", "minItems": 1, "maxItems": 30, "items": INTAKE_ITEM_INPUT},
        "unresolvedLabels": {
            "type": "array",
            "maxItems": 30,
            "items": {"type": "string", "minLength": 1, "maxLength": 120},
        },
    },
}

INVENTORY_INTAKE_OUTPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["count", "card"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "card": {
            "type": "object",
            "additionalProperties": False,
            "required": ["id", "type", "title", "data"],
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["inventory_intake_candidates"]},
                "title": {"type": "string"},
                "data": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["items", "unresolvedLabels"],
                    "properties": {
                        "items": {"type": "array", "items": INTAKE_CANDIDATE_OUTPUT},
                        "unresolvedLabels": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
    },
}


def _quantity_text(value: Any, *, ingredient_name: str) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        quantity = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{ingredient_name} quantity_invalid") from exc
    if quantity <= 0:
        raise ValueError(f"{ingredient_name} quantity_invalid")
    return format(quantity.normalize(), "f")


def execute_preview_intake_candidates(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    raw_items = [item for item in payload.get("items") or [] if isinstance(item, dict)]
    items_by_id: dict[str, dict[str, Any]] = {}
    for item in raw_items:
        ingredient_id = str(item.get("ingredientId") or "").strip()
        if ingredient_id and ingredient_id not in items_by_id:
            items_by_id[ingredient_id] = item
    ingredient_ids = list(items_by_id)
    ingredients = list(
        context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_(ingredient_ids),
            )
        )
    )
    ingredients_by_id = {ingredient.id: ingredient for ingredient in ingredients}
    if set(ingredients_by_id) != set(ingredient_ids):
        raise ValueError("ingredient_not_found")

    candidates: list[dict[str, Any]] = []
    for ingredient_id, raw in items_by_id.items():
        ingredient = ingredients_by_id[ingredient_id]
        is_tracked = tracks_quantity(ingredient)
        quantity = _quantity_text(raw.get("quantity"), ingredient_name=ingredient.name) if is_tracked else None
        requested_unit = normalize_unit_label(str(raw.get("unit") or ingredient.default_unit))
        if not is_tracked:
            requested_unit = ingredient.default_unit
        supported_units = get_supported_units(ingredient.default_unit, ingredient.unit_conversions)
        if is_tracked and requested_unit not in supported_units:
            raise ValueError(f"{ingredient.name} unit_not_supported")
        warnings: list[str] = []
        if is_tracked and quantity is None:
            warnings.append("待补充入库数量")
        if not is_tracked:
            warnings.append("该食材只记录有无，不记录数量")
        candidates.append(
            {
                "ingredientId": ingredient.id,
                "name": ingredient.name,
                "quantityMode": "track_quantity" if is_tracked else "not_track_quantity",
                "quantity": quantity,
                "unit": requested_unit or ingredient.default_unit,
                "selected": True,
                "warnings": warnings,
                "confidence": raw.get("confidence"),
                "sourceLabel": str(raw.get("sourceLabel") or "").strip() or None,
            }
        )
    unresolved_labels = list(
        dict.fromkeys(str(label).strip() for label in payload.get("unresolvedLabels") or [] if str(label).strip())
    )
    return {
        "count": len(candidates),
        "card": {
            "id": create_id("inventory_intake_candidates"),
            "type": "inventory_intake_candidates",
            "title": f"识别到 {len(candidates)} 个可入库食材",
            "data": {
                "items": candidates,
                "unresolvedLabels": unresolved_labels,
            },
        },
    }


def inventory_create_intake_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_inventory_intake_draft(
        DraftNormalizeContext(
            db=context.db,
            draft_type="inventory_intake",
            family_id=context.family_id,
            user_id=context.user_id,
            conversation_id=context.conversation_id,
            payload=draft,
        )
    )
    return {"draft": normalized, "itemCount": len(normalized.get("items") or [])}


def register_inventory_intake_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="inventory.preview_intake_candidates",
        display_name="入库候选预览",
        description="校验冰箱照片或小票中已解析到真实 Ingredient ID 的候选项，返回可审阅卡片，不写库存。",
        side_effect="read",
        handler=execute_preview_intake_candidates,
        input_schema=INVENTORY_INTAKE_INPUT,
        output_schema=INVENTORY_INTAKE_OUTPUT,
        terminal_output=True,
        output_types=["inventory_intake_candidates"],
    )
    register_tool(
        registry,
        name="inventory.create_intake_draft",
        display_name="统一入库确认表单",
        description="为已解决的采购关联行、直接入库行和只读忽略行生成一份正式 inventory_intake 草稿，不写入业务表。",
        side_effect="draft",
        handler=inventory_create_intake_draft,
        input_schema=draft_input_schema(INVENTORY_INTAKE_DRAFT_SCHEMA),
        output_schema=draft_output_schema(INVENTORY_INTAKE_DRAFT_SCHEMA),
        draft_types=["inventory_intake"],
    )
