from __future__ import annotations

from decimal import Decimal

from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.tools.catalog.shopping import serialize_shopping_tool_item
from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import ShoppingListItem


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
