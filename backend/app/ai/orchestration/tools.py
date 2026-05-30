from __future__ import annotations

from app.ai.runtime.registry import ToolDefinition, ToolRegistry


def build_tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    for name, description in [
        ("inventory.read_summary", "读取当前家庭库存摘要。"),
        ("inventory.read_expiring_items", "读取当前家庭临期食材。"),
        ("meal_log.read_recent", "读取最近餐食记录。"),
        ("recipe.search_available", "搜索可参考菜谱。"),
        ("recipe.create_draft", "生成菜谱草稿，不写入业务表。"),
    ]:
        registry.register(
            ToolDefinition(
                name=name,
                description=description,
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                permission="family:read",
                side_effect="draft" if name == "recipe.create_draft" else "read",
                requires_confirmation=False,
            )
        )
    return registry
