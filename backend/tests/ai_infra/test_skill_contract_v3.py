from __future__ import annotations

from app.ai.skills.registry import build_workspace_skill_registry


def test_routing_record_excludes_execution_only_contracts() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest

    record = manifest.to_routing_record()

    assert record["key"] == "shopping_list"
    assert "routing" in record
    assert "toolBudget" not in record
    assert "completionPolicy" not in record
    assert "draftContract" not in record
    assert "allowedTools" not in record


def test_execution_record_contains_machine_contracts() -> None:
    manifest = build_workspace_skill_registry().get("shopping_list").manifest

    record = manifest.to_execution_record()

    assert record["allowedTools"] == manifest.tools
    assert record["draftContract"] == manifest.draft_contract
    assert record["handoffs"] == manifest.handoffs_record()
