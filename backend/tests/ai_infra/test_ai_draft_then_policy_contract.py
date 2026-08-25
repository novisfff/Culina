from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml
from sqlalchemy import func, select

from app.ai.runtime.tooling import chat_tool_definition_to_model_tool
from app.ai.skills.base import SkillContext
from app.ai.skills.loader import load_skill_catalog
from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.tools.registry import ToolRegistry, build_workspace_tool_registry
from app.ai.tools.schemas import INTENT_CLARITY_MODEL_DESCRIPTION
from app.ai.tools.executor import ToolContext
from app.ai.tools.executor import ToolExecutor
from app.ai.workflows.orchestrator.payloads import OrchestratorPromptPayloadBuilder
from app.ai.workflows.orchestrator.tools import SkillInjectionManager
from app.services.ai_auto_execution.policy_registry import (
    AutoExecutionPolicyRegistry,
    auto_execution_policy_registry,
)
from app.services.ai_auto_execution.policies.food_favorite import FoodFavoritePolicy
from app.ai.evals.loader import load_eval_cases
from app.models.domain import AIApprovalRequest, AIOperation, Food
from tests.ai_infra._support import AIAgentInfraTestCase, AIEvalContext


POLICY_SKILLS = {
    "food_profile": "food_profile",
    "meal_log": "meal_log",
    "meal_plan": "meal_plan",
    "shopping_list": "shopping_list",
}


def _write_skill_manifest(
    tmp_path: Path,
    *,
    approval_policy: str,
    draft_type: str = "meal_plan",
    include_draft_type: bool = True,
    include_draft_contract: bool = True,
) -> Path:
    skill_dir = tmp_path / "policy-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: policy-skill\n"
        "description: Temporary policy Skill.\n"
        "---\n"
        "# Policy Skill\n",
        encoding="utf-8",
    )
    runtime = {
        "version": 2,
        "key": "policy_skill",
        "display_name": "Policy Skill",
        "approval_policy": approval_policy,
        "allowed_tools": ["meal_plan.create_draft"],
        "draft_types": [draft_type] if include_draft_type else [],
    }
    if include_draft_contract:
        runtime["draft_contract"] = {
            draft_type: {
                "schema_version": f"{draft_type}.v1",
                "approval_config_key": draft_type,
                "commit_handler_key": draft_type,
            }
        }
    (skill_dir / "skill.yaml").write_text(
        yaml.safe_dump(runtime, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return tmp_path


def test_policy_skills_keep_draft_tools_at_commit_gate() -> None:
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()

    for skill_key, draft_type in POLICY_SKILLS.items():
        skill = skill_registry.get(skill_key)
        assert skill.manifest.approval_policy == "draft_then_policy"
        assert skill.manifest.draft_types == [draft_type]
        draft_tools = [
            tool_registry.get(name)
            for name in skill.manifest.tools
            if draft_type in tool_registry.get(name).draft_types
        ]
        assert draft_tools
        assert all(tool.side_effect == "draft" for tool in draft_tools)
        assert all(tool.requires_confirmation for tool in draft_tools)
        assert skill.manifest.to_routing_record()["requiresApproval"] is True
        assert skill.manifest.to_execution_record()["approvalPolicy"] == "draft_then_policy"


def test_only_selected_skills_use_policy_routing() -> None:
    registry = build_workspace_skill_registry()

    assert {
        manifest.key: manifest.approval_policy
        for manifest in registry.list_manifests()
    } == {
        "cooking_assistant": "none",
        "food_profile": "draft_then_policy",
        "ingredient_profile": "draft_then_confirm",
        "inventory_analysis": "draft_then_confirm",
        "meal_plan": "draft_then_policy",
        "meal_log": "draft_then_policy",
        "recipe_cook": "draft_then_confirm",
        "recipe_draft": "draft_then_confirm",
        "shopping_list": "draft_then_policy",
    }


def test_loader_rejects_policy_skill_without_registered_server_policy(tmp_path: Path) -> None:
    catalog_dir = _write_skill_manifest(
        tmp_path,
        approval_policy="draft_then_policy",
    )

    with pytest.raises(ValueError, match="no registered auto-execution policy"):
        load_skill_catalog(
            catalog_dir,
            tool_registry=build_workspace_tool_registry(),
            auto_execution_policy_registry=AutoExecutionPolicyRegistry(()),
        )


def test_loader_rejects_policy_skill_without_injected_policy_registry(tmp_path: Path) -> None:
    catalog_dir = _write_skill_manifest(tmp_path, approval_policy="draft_then_policy")

    with pytest.raises(ValueError, match="auto-execution policy registry"):
        load_skill_catalog(catalog_dir, tool_registry=build_workspace_tool_registry())


def test_loader_rejects_policy_skill_with_partial_registry_coverage(tmp_path: Path) -> None:
    catalog_dir = _write_skill_manifest(tmp_path, approval_policy="draft_then_policy")

    with pytest.raises(ValueError, match="no registered auto-execution policy for meal_plan"):
        load_skill_catalog(
            catalog_dir,
            tool_registry=build_workspace_tool_registry(),
            auto_execution_policy_registry=AutoExecutionPolicyRegistry((FoodFavoritePolicy(),)),
        )


def test_loader_rejects_policy_skill_without_draft_contract(tmp_path: Path) -> None:
    catalog_dir = _write_skill_manifest(
        tmp_path,
        approval_policy="draft_then_policy",
        include_draft_contract=False,
    )

    with pytest.raises(ValueError, match="policy routing requires a draft contract"):
        load_skill_catalog(
            catalog_dir,
            tool_registry=build_workspace_tool_registry(),
            auto_execution_policy_registry=auto_execution_policy_registry,
        )


def test_loader_rejects_policy_draft_tool_without_confirmation(tmp_path: Path) -> None:
    catalog_dir = _write_skill_manifest(tmp_path, approval_policy="draft_then_policy")
    tools = build_workspace_tool_registry()
    registry = ToolRegistry()
    for definition in tools.list():
        registry.register(
            replace(definition, requires_confirmation=False)
            if definition.name == "meal_plan.create_draft"
            else definition
        )

    with pytest.raises(ValueError, match="policy Draft Tools must require confirmation"):
        load_skill_catalog(
            catalog_dir,
            tool_registry=registry,
            auto_execution_policy_registry=auto_execution_policy_registry,
        )


def test_none_and_confirm_policies_keep_existing_behavior(tmp_path: Path) -> None:
    none_catalog = _write_skill_manifest(
        tmp_path / "none",
        approval_policy="none",
        include_draft_type=False,
        include_draft_contract=False,
    )
    with pytest.raises(ValueError, match="non-read/control tools without approval"):
        load_skill_catalog(none_catalog, tool_registry=build_workspace_tool_registry())

    confirm_catalog = _write_skill_manifest(
        tmp_path / "confirm",
        approval_policy="draft_then_confirm",
    )
    skill = load_skill_catalog(
        confirm_catalog,
        tool_registry=build_workspace_tool_registry(),
    )[0]
    assert skill.manifest.approval_policy == "draft_then_confirm"
    assert skill.manifest.to_routing_record()["requiresApproval"] is True


def test_policy_skill_instructions_and_rendered_tool_schema_share_intent_contract() -> None:
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()
    clarity_values = (
        "explicit_complete",
        "explicit_context_resolved",
        "explicit_incomplete",
        "inferred",
    )

    for skill_key in POLICY_SKILLS:
        skill = skill_registry.get(skill_key)
        draft_tool = next(
            tool_registry.get(name)
            for name in skill.manifest.tools
            if tool_registry.get(name).side_effect == "draft"
        )
        rendered_tool = chat_tool_definition_to_model_tool(draft_tool)
        rendered_schema = json.dumps(rendered_tool, ensure_ascii=False)
        evidence_schema = rendered_tool["function"]["parameters"]["properties"]["draft"][
            "properties"
        ]["intentEvidence"]
        assert evidence_schema["description"] == INTENT_CLARITY_MODEL_DESCRIPTION
        assert all(value in rendered_schema for value in clarity_values)
        assert "事实陈述、称赞或可能的未来打算都不是操作指令" in rendered_schema
        assert "当前用户消息" in skill.instructions
        assert "当前 UI、本轮 Tool 输出或成功读取的 Artifact" in skill.instructions
        assert "intentEvidence" in skill.instructions
        assert "不编造缺失事实" in skill.instructions


def test_model_visible_registry_never_contains_write_tools() -> None:
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()

    for manifest in skill_registry.list_manifests():
        assert all(tool_registry.get(name).side_effect != "write" for name in manifest.tools)


def test_model_visible_policy_prompt_distinguishes_confirm_and_server_policy_routes() -> None:
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()
    context = SkillContext(
        db=MagicMock(),
        family_id="family-policy-prompt",
        user_id="user-policy-prompt",
        conversation_id="conversation-policy-prompt",
        run_id="run-policy-prompt",
        conversation=[],
        current_message="记录今天午餐",
        tool_executor=ToolExecutor(
            tool_registry,
            ToolContext(
                db=MagicMock(),
                family_id="family-policy-prompt",
                user_id="user-policy-prompt",
                conversation_id="conversation-policy-prompt",
                run_id="run-policy-prompt",
            ),
        ),
    )
    prompt = OrchestratorPromptPayloadBuilder(
        SkillInjectionManager(skill_registry)
    ).system_prompt(context, ["food_profile"])

    assert "draft_then_confirm 等待真实用户决定" in prompt
    assert "draft_then_policy 只生成 Draft" in prompt
    assert "服务端在 evidence/authorization/allowlist/limits/version/revert-adapter 全通过才提交" in prompt
    assert "模型永不获得正式 Write Tool" in prompt
    assert "Composite/Continuation 始终人工确认" in prompt
    assert "所有写入必须等待 approval" not in prompt
    assert "生成 draft 后必须结束当前动作并等待 approval" not in prompt

    for skill_key in POLICY_SKILLS:
        text = skill_registry.get(skill_key).instructions
        assert "draft_then_confirm 等待真实用户决定" in text
        assert "draft_then_policy 只生成 Draft" in text
        assert "Composite/Continuation 始终人工确认" in text
        assert "遵循 `draft -> approval -> commit`" not in text


class AIDraftThenPolicyDefaultOffTestCase(AIAgentInfraTestCase):
    def test_policy_skill_still_waits_when_member_authorization_is_absent(self) -> None:
        cases_path = Path(__file__).resolve().parents[1] / "ai_evals" / "cases" / "core.jsonl"
        case = next(
            item for item in load_eval_cases(cases_path) if item.id == "food.favorite_explicit"
        )
        context = AIEvalContext(self)

        with self.SessionLocal() as db:
            favorite_before = db.get(Food, context.aliases["tomato_egg_food"]).favorite
            approvals_before = db.scalar(select(func.count(AIApprovalRequest.id)))
            operations_before = db.scalar(select(func.count(AIOperation.id)))

        observation = context.run_case(case)

        with self.SessionLocal() as db:
            favorite_after = db.get(Food, context.aliases["tomato_egg_food"]).favorite
            approvals_after = db.scalar(select(func.count(AIApprovalRequest.id)))
            operations_after = db.scalar(select(func.count(AIOperation.id)))

        self.assertEqual(observation.terminalStatus, "waiting_approval")
        self.assertEqual(approvals_after, approvals_before + 1)
        self.assertEqual(operations_after, operations_before)
        self.assertEqual(favorite_after, favorite_before)
