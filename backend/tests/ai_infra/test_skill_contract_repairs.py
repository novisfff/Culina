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


def test_shopping_skill_authorizes_complete_low_stock_lookup() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest

    assert "inventory.read_low_stock_items" in manifest.tools
    assert (
        "inventory.read_low_stock_items"
        in manifest.completion_policy.followup_required_tools
    )


def test_shopping_skill_routes_purchase_completion_to_inventory_analysis() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest
    skill_text = (BACKEND_DIR / "app/ai/skills/catalog/shopping-list/SKILL.md").read_text(encoding="utf-8")

    assert "shopping.preview_intake_candidates" not in manifest.tools
    assert "shopping.create_intake_draft" not in manifest.tools
    assert "shopping_intake" not in manifest.draft_types
    assert "inventory_analysis" in skill_text
    assert "inventory.create_intake_draft" in skill_text or "inventory_intake" in skill_text
    assert "不能默认选择当前家庭全部" in skill_text
    assert "第二份库存草稿" in skill_text or "统一入库" in skill_text


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


def test_shopping_intake_skill_uses_one_approval_and_keeps_legacy_compatibility_explicit() -> None:
    catalog_dir = BACKEND_DIR / "app/ai/skills/catalog"
    shopping = (catalog_dir / "shopping-list/SKILL.md").read_text(encoding="utf-8")
    workflows = (catalog_dir / "shopping-list/references/workflows.md").read_text(encoding="utf-8")
    inventory = (catalog_dir / "inventory-analysis/SKILL.md").read_text(encoding="utf-8")

    assert "inventory_analysis" in shopping
    assert "inventory_intake" in shopping or "inventory.create_intake_draft" in shopping
    assert "部署前遗留" in shopping
    assert "购物完成与一体化入库" in workflows
    assert "任一行失败整批回滚" in workflows
    assert "新请求不再生成两阶段流程" in workflows
    assert "inventory.create_intake_draft" in inventory
    assert "purchasable.resolve_candidates" in inventory


def test_recipe_shortage_skills_preserve_real_id_shopping_boundary() -> None:
    catalog_dir = BACKEND_DIR / "app/ai/skills/catalog"
    recipe_cook = (catalog_dir / "recipe-cook/SKILL.md").read_text(encoding="utf-8")
    shopping = (catalog_dir / "shopping-list/SKILL.md").read_text(encoding="utf-8")

    assert "`recipe_shortage_to_shopping.v1`" in recipe_cook
    assert "普通用户消息" in recipe_cook
    assert "不自动重试做菜" in recipe_cook
    assert "`recipe_shortage` artifact" in shopping
    assert "逐个调用 `ingredient.read_by_id`" in shopping
    assert "省略 `quantity` 和 `unit`" in shopping


def test_ai_standards_lists_fixed_cooking_assistant_skill() -> None:
    text = (ROOT_DIR / "docs/ai-assistant-standards.md").read_text(encoding="utf-8")

    assert "cooking-assistant/" in text
    assert "只在 `recipe_cook_page` 固定 Profile" in text
