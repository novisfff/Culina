from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml

from app.ai.skills.loader import SkillDirectoryLoader
from app.ai.skills.base import SkillContext
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.tools import ToolContext, ToolExecutor
from app.ai.tools.registry import build_workspace_tool_registry
from app.ai.runtime.tooling import chat_tool_definition_to_model_tool
from app.ai.workflows.orchestrator import SkillInjectionManager
from app.ai.workflows.orchestrator.continuation import ContinuationValidationError, normalize_continuation
from app.ai.workflows.orchestrator.payloads import OrchestratorPromptPayloadBuilder
from app.ai.workflows.orchestrator.profiles import OrchestratorCapabilityPolicy


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


def test_prompt_uses_routing_records_before_injection_and_execution_records_after() -> None:
    registry = build_workspace_skill_registry()
    builder = OrchestratorPromptPayloadBuilder(SkillInjectionManager(registry))
    context = SkillContext(
        db=MagicMock(),
        family_id="family-contract-v3",
        user_id="user-contract-v3",
        conversation_id="conversation-contract-v3",
        run_id="run-contract-v3",
        conversation=[],
        current_message="整理购物清单",
        tool_executor=ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=MagicMock(),
                family_id="family-contract-v3",
                user_id="user-contract-v3",
                conversation_id="conversation-contract-v3",
                run_id="run-contract-v3",
            ),
        ),
    )

    prompt = builder.system_prompt(context, [])
    injected_prompt = builder.system_prompt(context, ["shopping_list"])

    assert '"routing"' in prompt
    assert '"toolBudget"' not in prompt
    assert '"allowedTools"' in injected_prompt
    assert '"handoffs"' in injected_prompt


def _write_skill(tmp_path: Path, slug: str, runtime: dict) -> None:
    skill_dir = tmp_path / slug
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {slug}\n"
        f"description: Temporary {slug} skill.\n"
        "---\n"
        f"# {slug}\n",
        encoding="utf-8",
    )
    (skill_dir / "skill.yaml").write_text(
        yaml.safe_dump(runtime, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def load_v3_registry(
    tmp_path: Path,
    *,
    handoffs: dict[str, dict[str, str]],
    routing: dict | None = None,
    target_draft_type: str = "ingredient_profile",
) -> SkillRegistry:
    target_tool = (
        "ingredient_profile.create_draft"
        if target_draft_type == "ingredient_profile"
        else "recipe.create_draft"
    )
    _write_skill(
        tmp_path,
        "source-skill",
        {
            "version": 3,
            "key": "source_skill",
            "display_name": "Source Skill",
            "approval_policy": "none",
            "allowed_tools": [],
            "draft_types": [],
            "output_types": [],
            "routing": routing
            or {
                "modes": ["default"],
                "include_examples": ["source request"],
                "exclude_examples": [],
                "conflict_rules": [],
            },
            "handoffs": handoffs,
            "attachment_policy": {
                "accepted_kinds": [],
                "usages": [],
                "bindable_fields": [],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
        },
    )
    _write_skill(
        tmp_path,
        "target-skill",
        {
            "version": 3,
            "key": "target_skill",
            "display_name": "Target Skill",
            "approval_policy": "draft_then_confirm",
            "allowed_tools": [target_tool],
            "draft_types": [target_draft_type],
            "draft_contract": {
                target_draft_type: {
                    "schema_version": f"{target_draft_type}.v1",
                    "approval_config_key": target_draft_type,
                    "commit_handler_key": target_draft_type,
                }
            },
            "output_types": [],
            "routing": {
                "modes": ["create"],
                "include_examples": ["target request"],
                "exclude_examples": [],
                "conflict_rules": [],
            },
            "handoffs": {},
            "attachment_policy": {},
        },
    )

    tool_registry = build_workspace_tool_registry()
    registry = SkillRegistry()
    for skill in SkillDirectoryLoader(tmp_path, tool_registry=tool_registry).load():
        registry.register(skill)
    registry.validate_contracts(tool_registry)
    return registry


def _valid_handoff(**overrides: str) -> dict[str, dict[str, str]]:
    policy = {
        "target_skill": "target_skill",
        "required_draft_type": "ingredient_profile",
        "resume_skill": "source_skill",
        "state_schema": "recipe_missing_ingredient.v1",
    }
    policy.update(overrides)
    return {"missing_item": policy}


def test_v3_loader_parses_routing_handoffs_and_attachment_policy(tmp_path: Path) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())

    manifest = registry.get("source_skill").manifest
    assert manifest.contract_version == 3
    assert manifest.routing.modes == ("default",)
    assert manifest.handoffs["missing_item"].target_skill == "target_skill"
    assert manifest.attachment_policy.current_message_only is True


def test_v3_loader_rejects_unknown_handoff_target(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown target Skill"):
        load_v3_registry(
            tmp_path,
            handoffs=_valid_handoff(target_skill="missing_skill"),
        )


def test_v3_loader_rejects_overlapping_routing_examples(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="include/exclude examples overlap"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            routing={
                "modes": ["default"],
                "include_examples": ["same request"],
                "exclude_examples": ["same request"],
                "conflict_rules": [],
            },
        )


def test_v3_loader_rejects_missing_routing_modes(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="routing.modes must not be empty"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            routing={
                "modes": [],
                "include_examples": ["source request"],
                "exclude_examples": [],
                "conflict_rules": [],
            },
        )


def test_v3_loader_rejects_unknown_state_schema(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown state schema"):
        load_v3_registry(
            tmp_path,
            handoffs=_valid_handoff(state_schema="unknown.v1"),
        )


def test_v3_loader_rejects_handoff_draft_type_not_declared_by_target(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="undeclared target draft type"):
        load_v3_registry(
            tmp_path,
            handoffs=_valid_handoff(required_draft_type="ingredient_profile"),
            target_draft_type="recipe",
        )


def _continuation_payload(**overrides) -> dict:
    payload = {
        "workflowId": "workflow-recipe-1",
        "stepKey": "ingredient-1",
        "reasonCode": "missing_item",
        "nextSkillKey": "target_skill",
        "resumeSkillKey": "source_skill",
        "requiredDraftType": "ingredient_profile",
        "stateSchema": "recipe_missing_ingredient.v1",
        "state": {
            "recipeTitle": "番茄鸡蛋面",
            "currentIngredient": "碱水面",
            "pendingIngredientNames": ["碱水面"],
            "completedIngredientIds": [],
        },
    }
    payload.update(overrides)
    return payload


def test_normalize_continuation_validates_declared_handoff_and_state(tmp_path: Path) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())

    normalized = normalize_continuation(
        payload=_continuation_payload(),
        source_skill_key="source_skill",
        skill_registry=registry,
        capability_policy=OrchestratorCapabilityPolicy(),
    )

    assert normalized["status"] == "pending"
    assert normalized["version"] == 1
    assert normalized["state"]["currentIngredient"] == "碱水面"


def test_continuation_source_is_resolved_from_the_declared_active_handoff(tmp_path: Path) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())
    manager = SkillInjectionManager(registry)

    source_skill_key = manager.continuation_source_skill_key(
        _continuation_payload(),
        ["target_skill", "source_skill"],
    )

    assert source_skill_key == "source_skill"


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"reasonCode": "unknown"}, "unknown_continuation_reason"),
        ({"nextSkillKey": "source_skill"}, "continuation_target_mismatch"),
        ({"requiredDraftType": "recipe"}, "continuation_draft_type_mismatch"),
        ({"stateSchema": "shopping_missing_target.v1"}, "continuation_state_schema_mismatch"),
    ],
)
def test_normalize_continuation_rejects_contract_mismatches(
    tmp_path: Path,
    overrides: dict,
    code: str,
) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())

    with pytest.raises(ContinuationValidationError) as exc_info:
        normalize_continuation(
            payload=_continuation_payload(**overrides),
            source_skill_key="source_skill",
            skill_registry=registry,
            capability_policy=OrchestratorCapabilityPolicy(),
        )

    assert exc_info.value.code == code


def test_normalize_continuation_rejects_invalid_typed_state(tmp_path: Path) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())

    with pytest.raises(ContinuationValidationError) as exc_info:
        normalize_continuation(
            payload=_continuation_payload(
                state={
                    "recipeTitle": "番茄鸡蛋面",
                    "currentIngredient": "碱水面",
                    "pendingIngredientNames": [],
                }
            ),
            source_skill_key="source_skill",
            skill_registry=registry,
            capability_policy=OrchestratorCapabilityPolicy(),
        )

    assert exc_info.value.code == "invalid_continuation_state"
    assert any(detail["path"] == "completedIngredientIds" for detail in exc_info.value.details)


def test_normalize_continuation_rejects_disallowed_resume_skill(tmp_path: Path) -> None:
    registry = load_v3_registry(tmp_path, handoffs=_valid_handoff())

    with pytest.raises(ContinuationValidationError) as exc_info:
        normalize_continuation(
            payload=_continuation_payload(),
            source_skill_key="source_skill",
            skill_registry=registry,
            capability_policy=OrchestratorCapabilityPolicy(
                skill_injection="fixed",
                allowed_skill_keys=("target_skill",),
            ),
        )

    assert exc_info.value.code == "continuation_skill_not_allowed"


def test_draft_model_tool_schema_exposes_continuation_not_after_approval() -> None:
    definition = build_workspace_tool_registry().get("recipe.create_draft")

    parameters = chat_tool_definition_to_model_tool(definition)["function"]["parameters"]

    assert "continuation" in parameters["properties"]
    assert "afterApproval" not in parameters["properties"]
