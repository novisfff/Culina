from __future__ import annotations

from typing import Any

from app.ai.skills.base import SkillContext, SkillManifest
from app.ai.skills.shared import conversation_artifacts


CONTEXT_POLICY_TOOLS: dict[str, tuple[str, ...]] = {
    "inventory": (
        "inventory.read_summary",
        "inventory.read_expiring_items",
        "inventory.read_available_items",
    ),
    "meal_logs": ("meal_log.read_recent",),
    "foods": ("food.search",),
    "recipes": ("recipe.search",),
    "meal_plan": ("meal_plan.read_existing",),
    "shopping": ("shopping.read_pending",),
    "artifacts": (),
    "ingredients": ("ingredient.search",),
}


def read_skill_context(
    context: SkillContext,
    manifest: SkillManifest,
    *,
    payloads: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    payloads = payloads or {}
    declared_tools = set(manifest.tools)
    outputs: dict[str, dict[str, Any]] = {}
    for policy in manifest.context_policy:
        if policy == "artifacts":
            artifacts = conversation_artifacts(context)
            outputs["conversation.artifacts"] = {"items": artifacts, "count": len(artifacts)}
            continue
        for tool_name in CONTEXT_POLICY_TOOLS.get(policy, ()):
            if tool_name in outputs or tool_name not in declared_tools:
                continue
            definition = context.tool_executor.registry.get(tool_name)
            if definition.side_effect != "read":
                continue
            outputs[tool_name] = context.tool_executor.call(tool_name, payloads.get(tool_name, {}))
    return outputs
