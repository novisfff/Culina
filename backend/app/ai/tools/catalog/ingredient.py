from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import decimal_text, register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, LIMIT_INPUT
from app.models.domain import Ingredient


def ingredient_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 50)
    ingredients = list(
        context.db.scalars(
            select(Ingredient)
            .where(Ingredient.family_id == context.family_id)
            .order_by(Ingredient.name.asc())
            .limit(limit)
        )
    )
    return {
        "items": [
            {
                "id": item.id,
                "name": item.name,
                "category": item.category,
                "defaultUnit": item.default_unit,
                "defaultStorage": item.default_storage,
                "defaultExpiryMode": item.default_expiry_mode.value if hasattr(item.default_expiry_mode, "value") else str(item.default_expiry_mode),
                "defaultExpiryDays": item.default_expiry_days,
                "defaultLowStockThreshold": decimal_text(item.default_low_stock_threshold) if item.default_low_stock_threshold is not None else None,
                "notes": item.notes,
            }
            for item in ingredients
        ],
        "count": len(ingredients),
    }


def register_ingredient_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="ingredient.search",
        display_name="食材资料",
        description="搜索当前家庭食材资料。",
        side_effect="read",
        handler=ingredient_search,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
