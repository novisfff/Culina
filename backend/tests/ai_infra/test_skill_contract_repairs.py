from __future__ import annotations

from decimal import Decimal
from pathlib import Path

from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.tools.catalog.shopping import serialize_shopping_tool_item
from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import ShoppingListItem


BACKEND_DIR = Path(__file__).resolve().parents[2]
ROOT_DIR = BACKEND_DIR.parent


def test_shopping_skill_authorizes_food_target_lookup() -> None:
    tools = set(build_workspace_skill_registry().get("shopping_list").manifest.tools)

    assert {"food.search", "food.read_by_id"}.issubset(tools)


def test_shopping_tool_item_preserves_food_target_identity() -> None:
    item = ShoppingListItem(
        id="shopping-ready-yogurt",
        family_id="family-1",
        ingredient_id=None,
        food_id="food-yogurt",
        title="蓝莓酸奶",
        quantity=Decimal("2"),
        unit="盒",
        quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        display_label=None,
        reason="早餐备用",
        done=False,
        created_by="user-1",
        updated_by="user-1",
    )

    payload = serialize_shopping_tool_item(item)

    assert payload["ingredientId"] is None
    assert payload["foodId"] == "food-yogurt"
    assert payload["targetType"] == "food"


def test_food_profile_does_not_default_unknown_stock_to_room_temperature() -> None:
    text = (BACKEND_DIR / "app/ai/skills/catalog/food-profile/SKILL.md").read_text(encoding="utf-8")

    assert "优先用 `常温` 作为可编辑默认值" not in text
    assert "保存位置不明确时留空或追问" in text


def test_ai_standards_lists_fixed_cooking_assistant_skill() -> None:
    text = (ROOT_DIR / "docs/ai-assistant-standards.md").read_text(encoding="utf-8")

    assert "cooking-assistant/" in text
    assert "只在 `recipe_cook_page` 固定 Profile" in text
