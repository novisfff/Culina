from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
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
from app.ai.workflows.orchestrator.draft_capture import prepare_tool_payload
from app.ai.workflows.orchestrator.payloads import OrchestratorPromptPayloadBuilder
from app.ai.workflows.orchestrator.profiles import OrchestratorBudgetConfig, OrchestratorCapabilityPolicy
from app.ai.workflows.compact_context import compact_artifacts
from app.ai.workflows.runner_support.approval_resume import (
    ContinuationResumeError,
    approval_resolved_state_patch,
    continuation_artifact,
    continuation_resume_state,
)
from app.ai.workflows.runner import WorkspaceGraphRunner


EXPECTED_SKILL_MODES = {
    "cooking_assistant": ("answer", "ui_action"),
    "food_profile": ("query", "create", "update"),
    "ingredient_profile": ("query", "create", "update"),
    "inventory_analysis": ("query", "restock", "consume", "dispose"),
    "meal_plan": ("query", "create", "update"),
    "meal_log": ("query", "create", "update"),
    "recipe_cook": ("preview", "execute"),
    "recipe_draft": ("query", "create", "update"),
    "shopping_list": ("query", "create", "update"),
}

EXPECTED_HANDOFFS = {
    "recipe_cook": {
        "recipe_shortage": (
            "shopping_list",
            "shopping_list",
            "shopping_list",
            "recipe_shortage_to_shopping.v1",
        ),
    },
    "recipe_draft": {
        "missing_ingredient": (
            "ingredient_profile",
            "ingredient_profile",
            "recipe_draft",
            "recipe_missing_ingredient.v1",
        ),
    },
    "meal_plan": {
        "missing_food": (
            "food_profile",
            "food_profile",
            "meal_plan",
            "meal_missing_food.v1",
        ),
    },
    "shopping_list": {
        "shopping_completed_ingredient": (
            "inventory_analysis",
            "inventory_operation",
            "inventory_analysis",
            "shopping_to_stock.v1",
        ),
        "shopping_completed_food": (
            "food_profile",
            "food_profile",
            "food_profile",
            "shopping_to_stock.v1",
        ),
        "missing_ingredient": (
            "ingredient_profile",
            "ingredient_profile",
            "shopping_list",
            "shopping_missing_target.v1",
        ),
        "missing_ready_food": (
            "food_profile",
            "food_profile",
            "shopping_list",
            "shopping_missing_target.v1",
        ),
    },
    "inventory_analysis": {
        "missing_ingredient": (
            "ingredient_profile",
            "ingredient_profile",
            "inventory_analysis",
            "inventory_missing_ingredient.v1",
        ),
        "save_unit_conversion": (
            "ingredient_profile",
            "ingredient_profile",
            "inventory_analysis",
            "inventory_unit_conversion.v1",
        ),
        "ready_food_stock": (
            "food_profile",
            "food_profile",
            "food_profile",
            "ready_food_stock.v1",
        ),
    },
    "meal_log": {
        "missing_food": (
            "food_profile",
            "food_profile",
            "meal_log",
            "meal_missing_food.v1",
        ),
    },
    "food_profile": {
        "plan_after_create": (
            "meal_plan",
            "meal_plan",
            "meal_plan",
            "food_to_meal_plan.v1",
        ),
    },
}

EXPECTED_SKILL_SECTIONS = [
    "## 用户目标",
    "## 不适用范围",
    "## 工作模式",
    "## 前置条件",
    "## 候选处理",
    "## Handoff",
    "## 审批规则",
    "## 用户反馈",
]


def test_all_catalog_skills_use_complete_v3_routing_contracts() -> None:
    registry = build_workspace_skill_registry()

    assert set(EXPECTED_SKILL_MODES) == registry.keys()
    for key, expected_modes in EXPECTED_SKILL_MODES.items():
        manifest = registry.get(key).manifest
        assert manifest.contract_version == 3, key
        assert manifest.routing.modes == expected_modes, key
        assert manifest.routing.include_examples, key
        assert len(manifest.routing.exclude_examples) >= 3, key
        assert set(manifest.routing.include_examples).isdisjoint(manifest.routing.exclude_examples), key
        assert manifest.routing.conflict_rules, key


def test_catalog_v3_handoff_matrix_is_complete_and_typed() -> None:
    registry = build_workspace_skill_registry()
    actual = {
        manifest.key: {
            reason: (
                policy.target_skill,
                policy.required_draft_type,
                policy.resume_skill,
                policy.state_schema,
            )
            for reason, policy in manifest.handoffs.items()
        }
        for manifest in registry.list_manifests()
        if manifest.handoffs
    }

    assert actual == EXPECTED_HANDOFFS


def test_catalog_v3_attachment_policies_only_bind_current_message_images() -> None:
    registry = build_workspace_skill_registry()
    expected_fields = {
        "food_profile": ("media_ids",),
        "ingredient_profile": ("media_ids",),
        "recipe_draft": ("media_ids",),
        "meal_log": ("mediaIds",),
    }

    for manifest in registry.list_manifests():
        policy = manifest.attachment_policy
        if manifest.key in expected_fields:
            assert policy.accepted_kinds == ("image",), manifest.key
            assert policy.usages, manifest.key
            assert policy.bindable_fields == expected_fields[manifest.key], manifest.key
            assert policy.current_message_only is True, manifest.key
            assert policy.explicit_user_intent_required is True, manifest.key
        else:
            assert policy.accepted_kinds == (), manifest.key
            assert policy.usages == (), manifest.key
            assert policy.bindable_fields == (), manifest.key


def test_catalog_skill_docs_use_v3_sections_and_typed_continuation_language() -> None:
    catalog_dir = Path(__file__).resolve().parents[2] / "app" / "ai" / "skills" / "catalog"
    documents = sorted(catalog_dir.glob("*/SKILL.md")) + sorted(catalog_dir.glob("*/references/workflows.md"))

    for path in sorted(catalog_dir.glob("*/SKILL.md")):
        headings = [line for line in path.read_text(encoding="utf-8").splitlines() if line.startswith("## ")]
        assert headings == EXPECTED_SKILL_SECTIONS, path

    for path in documents:
        text = path.read_text(encoding="utf-8")
        assert "afterApproval" not in text, path
        assert "nextDraftType" not in text, path


def test_meal_log_skill_requires_explicit_ready_food_stock_deduction_contract() -> None:
    registry = build_workspace_skill_registry()
    manifest = registry.get("meal_log").manifest
    skill_path = Path(__file__).resolve().parents[2] / "app" / "ai" / "skills" / "catalog" / "meal-record" / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8")

    assert any("扣减" in example and "库存" in example for example in manifest.routing.include_examples)
    for required_text in (
        "deductStock",
        "stockQuantity",
        "stockUnit",
        "readyMade",
        "instant",
        "packaged",
        "不得仅因 Food 出现在餐食记录中推断扣库存",
        "MealLog 创建和所有已选择的库存扣减必须在同一事务中",
    ):
        assert required_text in skill_text


def test_recipe_and_meal_skills_distinguish_saved_media_from_context_images() -> None:
    registry = build_workspace_skill_registry()
    catalog_dir = Path(__file__).resolve().parents[2] / "app" / "ai" / "skills" / "catalog"
    cases = {
        "recipe_draft": (catalog_dir / "recipe-draft" / "SKILL.md", "media_ids"),
        "meal_log": (catalog_dir / "meal-record" / "SKILL.md", "mediaIds"),
    }

    for skill_key, (skill_path, field_name) in cases.items():
        manifest = registry.get(skill_key).manifest
        skill_text = skill_path.read_text(encoding="utf-8")
        assert manifest.attachment_policy.current_message_only is True
        assert manifest.attachment_policy.explicit_user_intent_required is True
        assert manifest.attachment_policy.bindable_fields == (field_name,)
        assert any(
            ("图片" in example or "照片" in example) and ("保存" in example or "作为" in example)
            for example in manifest.routing.include_examples
        )
        assert "仅用于识别或理解的图片不写入" in skill_text


def test_inventory_skill_declares_reviewable_intake_candidate_terminal_contract() -> None:
    manifest = build_workspace_skill_registry().get("inventory_analysis").manifest
    skill_path = Path(__file__).resolve().parents[2] / "app" / "ai" / "skills" / "catalog" / "inventory-analysis" / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8")

    assert "inventory.preview_intake_candidates" in manifest.tools
    assert "inventory_intake_candidates" in manifest.output_types
    assert "inventory.preview_intake_candidates" in manifest.completion_policy.terminal_tools
    assert "候选卡本身不写库存" in skill_text
    assert "intakeCandidates" in skill_text


def test_meal_plan_and_recipe_skills_declare_inventory_idea_product_loop() -> None:
    registry = build_workspace_skill_registry()
    catalog_dir = Path(__file__).resolve().parents[2] / "app" / "ai" / "skills" / "catalog"
    meal_plan = registry.get("meal_plan").manifest
    meal_plan_text = (catalog_dir / "meal-planning" / "SKILL.md").read_text(encoding="utf-8")
    recipe_text = (catalog_dir / "recipe-draft" / "SKILL.md").read_text(encoding="utf-8")

    assert "meal_plan.propose_from_inventory" in meal_plan.tools
    assert "meal_idea_proposal" in meal_plan.output_types
    assert "meal_plan.propose_from_inventory" in meal_plan.completion_policy.terminal_tools
    assert "Food 和 Recipe 搜索都没有合适真实候选" in meal_plan_text
    assert "不能生成虚假的 Food ID、Recipe ID 或餐食计划项" in meal_plan_text
    assert "meal_idea_subject.v1" in recipe_text
    assert "重新读取每个 `ingredientId`" in recipe_text


def test_phase3_product_loop_edges_are_declared_and_never_commit_directly() -> None:
    registry = build_workspace_skill_registry()
    expected_edges = {
        ("shopping_list", "shopping_completed_ingredient"): (
            "inventory_analysis",
            "inventory_operation",
            "shopping_to_stock.v1",
        ),
        ("shopping_list", "shopping_completed_food"): (
            "food_profile",
            "food_profile",
            "shopping_to_stock.v1",
        ),
        ("recipe_cook", "recipe_shortage"): (
            "shopping_list",
            "shopping_list",
            "recipe_shortage_to_shopping.v1",
        ),
        ("inventory_analysis", "missing_ingredient"): (
            "ingredient_profile",
            "ingredient_profile",
            "inventory_missing_ingredient.v1",
        ),
    }

    for (source_key, reason), (target_key, draft_type, state_schema) in expected_edges.items():
        policy = registry.get(source_key).manifest.handoffs[reason]
        assert (policy.target_skill, policy.required_draft_type, policy.state_schema) == (
            target_key,
            draft_type,
            state_schema,
        )
        assert registry.get(target_key).manifest.approval_policy == "draft_then_confirm"
        assert set(policy.to_record()) == {
            "reasonCode",
            "targetSkill",
            "requiredDraftType",
            "resumeSkill",
            "stateSchema",
        }

    meal_idea_tool = build_workspace_tool_registry().get("meal_plan.propose_from_inventory")
    assert meal_idea_tool.side_effect == "read"
    assert meal_idea_tool.terminal_output is True
    assert meal_idea_tool.output_types == ["meal_idea_proposal"]
    assert "recipe" in registry.get("recipe_draft").manifest.draft_types


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
    assert "continuation" in injected_prompt
    assert "type=workflow.continuation" in prompt + injected_prompt
    assert "afterApproval" not in prompt + injected_prompt


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
    source_attachment_policy: dict | None = None,
    include_source_attachment_policy: bool = True,
    source_skill_key: str = "source_skill",
) -> SkillRegistry:
    target_tool = (
        "ingredient_profile.create_draft"
        if target_draft_type == "ingredient_profile"
        else "recipe.create_draft"
    )
    source_runtime = {
        "version": 3,
        "key": source_skill_key,
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
    }
    if include_source_attachment_policy:
        source_runtime["attachment_policy"] = source_attachment_policy or {
            "accepted_kinds": [],
            "usages": [],
            "bindable_fields": [],
            "current_message_only": True,
            "explicit_user_intent_required": True,
        }
    _write_skill(tmp_path, source_skill_key.replace("_", "-"), source_runtime)
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


def test_v3_loader_requires_attachment_policy(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="attachment_policy must be a mapping"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            include_source_attachment_policy=False,
        )


def test_v3_registry_rejects_unsafe_attachment_flags(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="current-message-only and explicit user intent"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key="food_profile",
            source_attachment_policy={
                "accepted_kinds": [],
                "usages": [],
                "bindable_fields": [],
                "current_message_only": False,
                "explicit_user_intent_required": False,
            },
        )


def test_v3_registry_rejects_undeclared_attachment_binding_field(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="cannot bind attachment fields"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key="food_profile",
            source_attachment_policy={
                "accepted_kinds": ["image"],
                "usages": ["draft_media_binding"],
                "bindable_fields": ["anything"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
        )


def test_v3_registry_rejects_non_image_attachment_binding(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="may accept only image attachments"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key="food_profile",
            source_attachment_policy={
                "accepted_kinds": ["video"],
                "usages": ["draft_media_binding"],
                "bindable_fields": ["media_ids"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
        )


@pytest.mark.parametrize(
    "policy",
    [
        {
            "accepted_kinds": ["image"],
            "usages": ["draft_media_binding"],
            "bindable_fields": [],
            "current_message_only": True,
            "explicit_user_intent_required": True,
        },
        {
            "accepted_kinds": ["image"],
            "usages": [],
            "bindable_fields": ["media_ids"],
            "current_message_only": True,
            "explicit_user_intent_required": True,
        },
    ],
)
def test_v3_registry_rejects_partially_declared_attachment_binding(
    tmp_path: Path,
    policy: dict,
) -> None:
    with pytest.raises(ValueError, match="must be all empty or all non-empty"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key="food_profile",
            source_attachment_policy=policy,
        )


def test_v3_registry_rejects_unknown_attachment_usage(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unsupported attachment usages"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key="food_profile",
            source_attachment_policy={
                "accepted_kinds": ["image"],
                "usages": ["unknown_usage"],
                "bindable_fields": ["media_ids"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
        )


@pytest.mark.parametrize(
    ("skill_key", "policy", "expected_error"),
    [
        (
            "meal_log",
            {
                "accepted_kinds": ["image"],
                "usages": ["draft_media_binding", "image_generation_reference"],
                "bindable_fields": ["mediaIds"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
            "attachment policy must exactly match",
        ),
        (
            "food_profile",
            {
                "accepted_kinds": ["image"],
                "usages": ["draft_media_binding"],
                "bindable_fields": ["media_ids"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
            "attachment policy must exactly match",
        ),
        (
            "food_profile",
            {
                "accepted_kinds": ["image"],
                "usages": [
                    "draft_media_binding",
                    "image_generation_reference",
                    "image_generation_reference",
                ],
                "bindable_fields": ["media_ids"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
            "contains duplicate values",
        ),
        (
            "food_profile",
            {
                "accepted_kinds": ["image"],
                "usages": ["image_generation_reference", "draft_media_binding"],
                "bindable_fields": ["media_ids"],
                "current_message_only": True,
                "explicit_user_intent_required": True,
            },
            "attachment policy must exactly match",
        ),
    ],
)
def test_v3_registry_requires_exact_skill_attachment_policy(
    tmp_path: Path,
    skill_key: str,
    policy: dict,
    expected_error: str,
) -> None:
    with pytest.raises(ValueError, match=expected_error):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_skill_key=skill_key,
            source_attachment_policy=policy,
        )


def test_v3_registry_requires_empty_attachment_policy_for_non_bindable_skill(tmp_path: Path) -> None:
    policy = {
        "accepted_kinds": ["image"],
        "usages": ["draft_media_binding"],
        "bindable_fields": ["anything"],
        "current_message_only": True,
        "explicit_user_intent_required": True,
    }

    with pytest.raises(ValueError, match="cannot declare attachment kinds, usages, or binding fields"):
        load_v3_registry(
            tmp_path,
            handoffs={},
            source_attachment_policy=policy,
        )


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


def test_new_draft_payload_does_not_capture_legacy_after_approval() -> None:
    definition = build_workspace_tool_registry().get("recipe.create_draft")
    draft = {
        "draftType": "recipe",
        "schemaVersion": "recipe.v1",
        "title": "番茄炒蛋",
    }

    prepared = prepare_tool_payload(
        payload={
            "draft": draft,
            "afterApproval": {
                "nextDraftType": "shopping_list",
                "instruction": "legacy model input",
            },
        },
        execution_definition=definition,
    )

    assert prepared.payload == {"draft": draft}
    assert not hasattr(prepared, "after_approval")


def test_resolution_tools_are_authorized_by_their_business_skills() -> None:
    registry = build_workspace_skill_registry()

    assert "ingredient.resolve_candidates" in registry.get("recipe_draft").manifest.tools
    assert "purchasable.resolve_candidates" in registry.get("shopping_list").manifest.tools


def test_continuation_artifact_is_typed_and_deduplicates_business_ids() -> None:
    artifact = continuation_artifact(
        run_id="run-1",
        approval_id="approval-1",
        continuation=_continuation_payload(),
        decision_status="approved",
        business_entity_ids=["ingredient-1", "ingredient-1"],
    )

    assert artifact["id"] == "workflow_continuation:workflow-recipe-1:ingredient-1:approval-1"
    assert artifact["type"] == "workflow.continuation"
    assert artifact["status"] == "ready"
    assert artifact["payload"]["businessEntityIds"] == ["ingredient-1"]


def test_compact_context_keeps_only_typed_continuation_state() -> None:
    artifact = continuation_artifact(
        run_id="run-1",
        approval_id="approval-1",
        continuation=_continuation_payload(extraIgnored="large-payload"),
        decision_status="approved",
        business_entity_ids=["ingredient-1"],
    )

    compact = compact_artifacts([artifact])[0]

    assert compact["payload"] == {
        "workflowId": "workflow-recipe-1",
        "stepKey": "ingredient-1",
        "reasonCode": "missing_item",
        "nextSkillKey": "target_skill",
        "resumeSkillKey": "source_skill",
        "stateSchema": "recipe_missing_ingredient.v1",
        "state": {
            "recipeTitle": "番茄鸡蛋面",
            "currentIngredient": "碱水面",
            "pendingIngredientNames": {"count": 1, "preview": ["碱水面"]},
            "completedIngredientIds": {"count": 0, "preview": []},
        },
        "businessEntityIds": ["ingredient-1"],
    }


def test_continuation_resume_injects_allowed_skill_exactly_once() -> None:
    state = {
        "orchestrator_profile": {
            "capabilityPolicy": OrchestratorCapabilityPolicy(
                allowed_skill_keys=("source_skill", "target_skill"),
            ).to_state(),
            "budgetConfig": OrchestratorBudgetConfig(
                max_business_skills_per_run=2,
                max_total_tool_calls_per_run=10,
                max_same_read_tool_calls_per_run=2,
            ).to_state(),
        },
        "injected_skill_keys": ["target_skill"],
        "injection_history": [],
    }
    artifact = continuation_artifact(
        run_id="run-1",
        approval_id="approval-1",
        continuation=_continuation_payload(),
        decision_status="approved",
        business_entity_ids=["ingredient-1"],
    )

    keys, history = continuation_resume_state(state=state, artifact=artifact)
    replay_keys, replay_history = continuation_resume_state(
        state={**state, "injected_skill_keys": keys, "injection_history": history},
        artifact=artifact,
    )

    assert keys == ["target_skill", "source_skill"]
    assert replay_keys == keys
    assert len(history) == 1
    assert replay_history == history


def test_continuation_resume_rejects_disallowed_skill() -> None:
    artifact = continuation_artifact(
        run_id="run-1",
        approval_id="approval-1",
        continuation=_continuation_payload(),
        decision_status="approved",
        business_entity_ids=["ingredient-1"],
    )
    state = {
        "orchestrator_profile": {
            "capabilityPolicy": OrchestratorCapabilityPolicy(
                skill_injection="fixed",
                allowed_skill_keys=("target_skill",),
            ).to_state(),
            "budgetConfig": OrchestratorBudgetConfig().to_state(),
        },
        "injected_skill_keys": ["target_skill"],
        "injection_history": [],
    }

    with pytest.raises(ContinuationResumeError) as exc_info:
        continuation_resume_state(state=state, artifact=artifact)

    assert exc_info.value.code == "continuation_skill_not_allowed"


def test_approval_resolved_patch_deduplicates_replayed_continuation_artifact() -> None:
    artifact = continuation_artifact(
        run_id="run-1",
        approval_id="approval-1",
        continuation=_continuation_payload(),
        decision_status="approved",
        business_entity_ids=["ingredient-1"],
    )

    patch = approval_resolved_state_patch(
        state={"injected_skill_keys": [], "injection_history": []},
        serialized={"approval": {"status": "approved"}},
        status="running",
        run_artifacts=[artifact],
        approval_artifacts=[],
        resume_artifact=artifact,
    )

    assert [item["id"] for item in patch["run_artifacts"]].count(artifact["id"]) == 1


@pytest.mark.parametrize(
    ("decision", "expected_status"),
    [("approved", "ready"), ("rejected", "rejected")],
)
def test_runner_builds_typed_continuation_artifact_from_persisted_draft(
    decision: str,
    expected_status: str,
) -> None:
    draft = SimpleNamespace(ai_metadata={"continuation": _continuation_payload()})
    fake_runner = SimpleNamespace(db=MagicMock())
    fake_runner.db.get.return_value = draft
    decision_result = {
        "draft": {"id": "draft-1"},
        "approval": {"id": "approval-1", "status": decision, "decision": decision},
        "operation": {
            "status": "succeeded" if decision == "approved" else "skipped",
            "business_entity_ids": ["ingredient-1"] if decision == "approved" else [],
        },
    }

    artifact = WorkspaceGraphRunner._consume_resume_after_approval(
        fake_runner,
        {"run_id": "run-1"},
        decision_result,
    )

    assert artifact is not None
    assert artifact["status"] == expected_status
    assert artifact["payload"]["businessEntityIds"] == (
        ["ingredient-1"] if decision == "approved" else []
    )
