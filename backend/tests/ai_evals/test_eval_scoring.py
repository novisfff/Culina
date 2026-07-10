from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.ai.evals.models import RateMetric, SkillEvalCase, SkillEvalCaseScore, SkillEvalObservation, SkillEvalReport
from app.ai.evals.scoring import build_rate, score_case, score_report
from app.ai.evals.thresholds import SkillEvalThresholds, check_thresholds


def case(**overrides) -> SkillEvalCase:
    values = {
        "schemaVersion": "skill_eval_case.v1",
        "id": "shopping.add",
        "category": "draft",
        "message": "加入购物清单",
        "expectedTerminalStatus": "completed",
        "script": [{"assistantText": "完成"}],
    }
    values.update(overrides)
    return SkillEvalCase.model_validate(values)


def observation(**overrides) -> SkillEvalObservation:
    values = {
        "schemaVersion": "skill_eval_observation.v1",
        "caseId": "shopping.add",
        "source": "scripted",
        "terminalStatus": "completed",
    }
    values.update(overrides)
    return SkillEvalObservation.model_validate(values)


def test_score_case_reports_forbidden_tool_and_missing_skill() -> None:
    score = score_case(
        case=case(
            expectedSkills=["shopping_list"],
            expectedTools=["shopping.create_draft"],
            forbiddenTools=["inventory.create_operation_draft"],
        ),
        observation=observation(tools=["inventory.create_operation_draft"]),
    )
    assert score.passed is False
    assert score.routingPassed is False
    assert score.toolContractPassed is False
    assert score.failures == [
        "missing skills: shopping_list",
        "missing tools: shopping.create_draft",
        "forbidden tools used: inventory.create_operation_draft",
    ]


def test_score_case_requires_expected_persisted_result_card() -> None:
    score = score_case(
        case=case(expectedCardTypes=["inventory_summary"]),
        observation=observation(cardTypes=[]),
    )

    assert score.passed is False
    assert score.cardContractPassed is False
    assert score.failures == ["missing result cards: inventory_summary"]


def test_empty_metric_denominator_returns_null_rate() -> None:
    assert build_rate(0, 0).model_dump() == {"numerator": 0, "denominator": 0, "rate": None}


def test_first_pass_rate_counts_only_expected_drafts() -> None:
    draft_case = case(expectsFirstPassDraft=True)
    query_case = case(id="inventory.query", category="query")
    report = score_report(
        [
            (draft_case, observation(draftValidationAttempts=1)),
            (query_case, observation(caseId="inventory.query")),
        ]
    )
    assert report.metrics["draftFirstPassRate"].model_dump() == {
        "numerator": 1,
        "denominator": 1,
        "rate": 1.0,
    }


def test_thresholds_fail_with_actionable_messages() -> None:
    base_case = case(expectedSkills=["shopping_list"])
    score = score_case(case=base_case, observation=observation(skills=[], tools=[]))
    report = SkillEvalReport(
        source="scripted",
        generatedAt=datetime.now(timezone.utc),
        caseCount=1,
        passedCaseCount=0,
        metrics={
            "casePassRate": build_rate(0, 1),
            "routingContractRate": build_rate(0, 1),
            "toolContractRate": build_rate(1, 1),
            "terminalContractRate": build_rate(1, 1),
            "draftFirstPassRate": build_rate(0, 0),
            "continuationContractRate": build_rate(0, 0),
            "identityBoundaryRate": build_rate(0, 0),
        },
        invalidIdentityWriteCount=1,
        cases=[score],
    )
    thresholds = SkillEvalThresholds(
        schemaVersion="skill_eval_thresholds.v1",
        minimumCaseCount=2,
        minimumRates={"routingContractRate": 1.0},
        maximumInvalidIdentityWriteCount=0,
    )
    assert check_thresholds(report=report, thresholds=thresholds) == [
        "caseCount: expected at least 2, got 1",
        "routingContractRate: expected at least 1.0000, got 0.0000",
        "invalidIdentityWriteCount: expected 0, got 1",
    ]


def test_thresholds_reject_real_provider_source_and_unknown_metric() -> None:
    base_case = case()
    score = score_case(case=base_case, observation=observation())
    report = SkillEvalReport(
        source="real_provider",
        generatedAt=datetime.now(timezone.utc),
        caseCount=1,
        passedCaseCount=1,
        metrics={
            "casePassRate": build_rate(1, 1),
            "routingContractRate": build_rate(1, 1),
            "toolContractRate": build_rate(1, 1),
            "terminalContractRate": build_rate(1, 1),
            "draftFirstPassRate": build_rate(0, 0),
            "continuationContractRate": build_rate(0, 0),
            "identityBoundaryRate": build_rate(0, 0),
        },
        invalidIdentityWriteCount=0,
        cases=[score],
    )
    thresholds = SkillEvalThresholds(
        schemaVersion="skill_eval_thresholds.v1",
        minimumCaseCount=1,
        minimumRates={"unknownRate": 1.0},
        maximumInvalidIdentityWriteCount=0,
    )

    assert check_thresholds(report=report, thresholds=thresholds) == [
        "source: expected scripted, got real_provider",
        "minimumRates: unknown metrics: unknownRate",
    ]


def test_score_case_checks_expected_error_code_for_attachment_boundary() -> None:
    attachment_case = case(
        id="attachment.stale",
        category="attachment_boundary",
        expectedErrorCode="stale_attachment",
        expectedTerminalStatus="rejected",
    )

    score = score_case(
        case=attachment_case,
        observation=observation(
            caseId="attachment.stale",
            terminalStatus="rejected",
            errorCode="unknown_media",
        ),
    )

    assert score.passed is False
    assert "error code expected stale_attachment got unknown_media" in score.failures


def test_score_case_checks_persisted_draft_values() -> None:
    draft_case = case(expectedDraftType="meal_log", expectedDraftValues={"foods.0.deductStock": True})

    score = score_case(
        case=draft_case,
        observation=observation(
            draftType="meal_log",
            draftPayload={"foods": [{"deductStock": False}]},
        ),
    )

    assert score.draftPassed is False
    assert "draft value foods.0.deductStock expected True got False" in score.failures


def test_score_case_checks_real_tool_output_values() -> None:
    query_case = case(
        category="query",
        expectedTools=["inventory.read_low_stock_items"],
        expectedToolValues={
            "inventory.read_low_stock_items": {"items.0.status": "out_of_stock"}
        },
    )

    score = score_case(
        case=query_case,
        observation=observation(
            tools=["inventory.read_low_stock_items"],
            toolOutputs={
                "inventory.read_low_stock_items": [{"items": [{"status": "fresh"}]}]
            },
        ),
    )

    assert score.toolContractPassed is False
    assert (
        "tool value inventory.read_low_stock_items.items.0.status "
        "expected 'out_of_stock' got 'fresh'"
    ) in score.failures


def test_rate_metric_rejects_inconsistent_rate() -> None:
    with pytest.raises(ValidationError, match="rate must match numerator / denominator"):
        RateMetric(numerator=1, denominator=2, rate=1.0)


def test_report_rejects_duplicate_case_ids_and_inconsistent_counts() -> None:
    score = SkillEvalCaseScore(
        caseId="duplicate",
        passed=True,
        routingPassed=True,
        toolContractPassed=True,
        terminalPassed=True,
        draftPassed=True,
        firstPassDraftPassed=True,
        continuationPassed=True,
        identityBoundaryPassed=True,
    )
    metrics = {
        "casePassRate": build_rate(2, 2),
        "routingContractRate": build_rate(2, 2),
        "toolContractRate": build_rate(2, 2),
        "terminalContractRate": build_rate(2, 2),
        "draftFirstPassRate": build_rate(0, 0),
        "continuationContractRate": build_rate(0, 0),
        "identityBoundaryRate": build_rate(0, 0),
    }

    with pytest.raises(ValidationError, match="report caseId values must be unique"):
        SkillEvalReport(
            source="scripted",
            generatedAt=datetime.now(timezone.utc),
            caseCount=2,
            passedCaseCount=0,
            metrics=metrics,
            invalidIdentityWriteCount=0,
            cases=[score, score],
        )


def test_report_rejects_inconsistent_case_and_passed_counts() -> None:
    score = SkillEvalCaseScore(
        caseId="only-case",
        passed=True,
        routingPassed=True,
        toolContractPassed=True,
        terminalPassed=True,
        draftPassed=True,
        firstPassDraftPassed=True,
        continuationPassed=True,
        identityBoundaryPassed=True,
    )
    metrics = {
        "casePassRate": build_rate(1, 1),
        "routingContractRate": build_rate(1, 1),
        "toolContractRate": build_rate(1, 1),
        "terminalContractRate": build_rate(1, 1),
        "draftFirstPassRate": build_rate(0, 0),
        "continuationContractRate": build_rate(0, 0),
        "identityBoundaryRate": build_rate(0, 0),
    }
    with pytest.raises(ValidationError, match="caseCount must match report cases length"):
        SkillEvalReport(
            source="scripted",
            generatedAt=datetime.now(timezone.utc),
            caseCount=2,
            passedCaseCount=1,
            metrics=metrics,
            invalidIdentityWriteCount=0,
            cases=[score],
        )
    with pytest.raises(ValidationError, match="passedCaseCount must match passed report cases"):
        SkillEvalReport(
            source="scripted",
            generatedAt=datetime.now(timezone.utc),
            caseCount=1,
            passedCaseCount=0,
            metrics=metrics,
            invalidIdentityWriteCount=0,
            cases=[score],
        )
