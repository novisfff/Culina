from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app.ai.evals.loader import join_cases_and_observations, load_eval_cases
from app.ai.evals.models import SkillEvalCase
from app.ai.evals.scripted_provider import ScriptedEvalProvider
from app.ai.skills.registry import build_workspace_skill_registry
from app.ai.skills.state_schemas import CONTINUATION_STATE_SCHEMAS
from app.ai.tools.registry import build_workspace_tool_registry
from app.schemas.ai import AITaskDraftType

CORE_CASES = Path(__file__).parent / "cases" / "core.jsonl"


def _case(case_id: str) -> SkillEvalCase:
    return SkillEvalCase(
        schemaVersion="skill_eval_case.v1",
        id=case_id,
        category="query",
        message="查库存",
        expectedTerminalStatus="completed",
        script=[{"assistantText": "完成"}],
    )


def test_load_cases_rejects_duplicate_id(tmp_path: Path) -> None:
    path = tmp_path / "cases.jsonl"
    row = _case("duplicate").model_dump_json()
    path.write_text(row + "\n" + row + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate eval case id"):
        load_eval_cases(path)


def test_eval_case_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SkillEvalCase.model_validate({**_case("bad-field").model_dump(), "unexpected": True})


def test_observation_requires_matching_case_id() -> None:
    with pytest.raises(ValueError, match="missing observations"):
        join_cases_and_observations(cases=[_case("inventory.available")], observations=[])


def test_core_dataset_has_required_coverage() -> None:
    cases = load_eval_cases(CORE_CASES)
    assert len(cases) == 32
    covered_skills = {skill for case in cases for skill in case.expectedSkills}
    assert covered_skills == {
        "cooking_assistant",
        "food_profile",
        "ingredient_profile",
        "inventory_analysis",
        "meal_plan",
        "meal_log",
        "recipe_cook",
        "recipe_draft",
        "shopping_list",
    }
    assert sum(case.category == "identity_boundary" for case in cases) == 5
    assert sum(case.category == "attachment_boundary" for case in cases) == 3
    assert sum(case.category == "continuation" for case in cases) == 5
    assert all(case.expectsContinuationCompletion for case in cases if case.category == "continuation")
    assert all(any(entry.get("resume") is True for entry in case.script) for case in cases if case.category == "continuation")
    expected_cards = {
        "inventory.available": ["inventory_summary"],
        "inventory.low_stock_zero": ["inventory_summary"],
        "inventory.expiring": ["inventory_summary"],
        "inventory.intake_preview": ["inventory_intake_candidates"],
        "meal.plan_empty_library": ["meal_idea_proposal"],
        "cooking.next_step": ["ui_actions"],
    }
    assert {case.id: case.expectedCardTypes for case in cases if case.expectedCardTypes} == expected_cards


def test_core_dataset_references_real_runtime_contracts() -> None:
    cases = load_eval_cases(CORE_CASES)
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()
    skill_keys = skill_registry.keys()
    tool_names = {tool.name for tool in tool_registry.list()}
    draft_types = set(get_args(AITaskDraftType))
    for case in cases:
        assert set(case.expectedSkills + case.forbiddenSkills) <= skill_keys
        assert set(case.expectedTools + case.forbiddenTools) <= tool_names
        if case.expectedDraftType:
            assert case.expectedDraftType in draft_types
        if case.expectedContinuationSchema:
            assert case.expectedContinuationSchema in CONTINUATION_STATE_SCHEMAS
        allowed = {
            tool
            for skill_key in case.expectedSkills
            for tool in skill_registry.get(skill_key).manifest.tools
        }
        assert set(case.expectedTools) <= allowed
        scripted_injections = [entry["inject"] for entry in case.script if "inject" in entry]
        assert set(scripted_injections) <= set(case.expectedSkills)
        assert not any("observation" in entry for entry in case.script)


def test_scripted_provider_rejects_an_unexpected_extra_provider_round() -> None:
    provider = ScriptedEvalProvider([{"assistantText": "完成"}])
    kwargs = {
        "system": "system",
        "user": "user",
        "tools": lambda: [],
        "tool_handler": lambda *args, **kwargs: {},
    }
    provider.generate_with_tools(**kwargs)

    with pytest.raises(AssertionError, match="unexpected extra provider round"):
        provider.generate_with_tools(**kwargs)
