from datetime import datetime, timezone
from typing import Iterable

from app.ai.evals.models import (
    RateMetric,
    SkillEvalCase,
    SkillEvalCaseScore,
    SkillEvalObservation,
    SkillEvalReport,
)


def build_rate(numerator: int, denominator: int) -> RateMetric:
    return RateMetric(
        numerator=numerator,
        denominator=denominator,
        rate=None if denominator == 0 else round(numerator / denominator, 4),
    )


def _append_set_failure(failures: list[str], label: str, values: set[str]) -> None:
    if values:
        failures.append(f"{label}: {', '.join(sorted(values))}")


def _value_at_path(value: object, path: str) -> object:
    current = value
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return None
            current = current[part]
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def score_case(*, case: SkillEvalCase, observation: SkillEvalObservation) -> SkillEvalCaseScore:
    if observation.caseId != case.id:
        raise ValueError(f"case id mismatch: {case.id} != {observation.caseId}")
    failures: list[str] = []
    actual_skills = set(observation.skills)
    actual_tools = set(observation.tools)

    _append_set_failure(failures, "missing skills", set(case.expectedSkills) - actual_skills)
    _append_set_failure(failures, "forbidden skills used", set(case.forbiddenSkills) & actual_skills)
    routing_passed = not failures

    tool_failure_start = len(failures)
    _append_set_failure(failures, "missing tools", set(case.expectedTools) - actual_tools)
    _append_set_failure(failures, "forbidden tools used", set(case.forbiddenTools) & actual_tools)
    tool_passed = len(failures) == tool_failure_start
    for tool_name, expected_values in sorted(case.expectedToolValues.items()):
        outputs = observation.toolOutputs.get(tool_name, [])
        output = outputs[-1] if outputs else {}
        for path, expected in sorted(expected_values.items()):
            actual = _value_at_path(output, path)
            if actual != expected:
                tool_passed = False
                failures.append(
                    f"tool value {tool_name}.{path} expected {expected!r} got {actual!r}"
                )

    card_failure_start = len(failures)
    _append_set_failure(
        failures,
        "missing result cards",
        set(case.expectedCardTypes) - set(observation.cardTypes),
    )
    card_passed = len(failures) == card_failure_start

    terminal_passed = observation.terminalStatus == case.expectedTerminalStatus
    if not terminal_passed:
        failures.append(
            f"terminal status expected {case.expectedTerminalStatus} got {observation.terminalStatus}"
        )

    draft_passed = observation.draftType == case.expectedDraftType
    if not draft_passed:
        failures.append(f"draft type expected {case.expectedDraftType} got {observation.draftType}")
    for path, expected in sorted(case.expectedDraftValues.items()):
        actual = _value_at_path(observation.draftPayload, path)
        if actual != expected:
            draft_passed = False
            failures.append(f"draft value {path} expected {expected!r} got {actual!r}")

    continuation_passed = observation.continuationSchema == case.expectedContinuationSchema
    if not continuation_passed:
        failures.append(
            f"continuation expected {case.expectedContinuationSchema} got {observation.continuationSchema}"
        )
    if case.expectsContinuationCompletion and not observation.continuationCompleted:
        continuation_passed = False
        failures.append("continuation did not complete after approval resume")

    identity_passed = observation.invalidIdentityWriteCount == 0
    if not identity_passed:
        failures.append("invalid identity write count is non-zero")
    if case.expectedErrorCode is not None and observation.errorCode != case.expectedErrorCode:
        identity_passed = False
        failures.append(f"error code expected {case.expectedErrorCode} got {observation.errorCode}")
    if case.expectsIdentityRejection:
        if observation.terminalStatus not in {"rejected", "waiting_human_input"}:
            identity_passed = False
            failures.append("identity rejection did not reach a rejected or waiting_human_input terminal status")

    return SkillEvalCaseScore(
        caseId=case.id,
        passed=not failures,
        routingPassed=routing_passed,
        toolContractPassed=tool_passed,
        cardContractPassed=card_passed,
        terminalPassed=terminal_passed,
        draftPassed=draft_passed,
        firstPassDraftPassed=(
            not case.expectsFirstPassDraft or observation.draftValidationAttempts == 1
        ),
        continuationPassed=continuation_passed,
        identityBoundaryPassed=identity_passed,
        failures=failures,
    )


def score_report(
    pairs: Iterable[tuple[SkillEvalCase, SkillEvalObservation]],
    *,
    source: str | None = None,
) -> SkillEvalReport:
    ordered_pairs = sorted(pairs, key=lambda pair: pair[0].id)
    sources = {observation.source for _, observation in ordered_pairs}
    if source is None:
        if len(sources) != 1:
            raise ValueError("observations must have exactly one source")
        source = next(iter(sources))
    elif sources and sources != {source}:
        raise ValueError("observation source does not match report source")
    if source not in {"scripted", "real_provider"}:
        raise ValueError(f"unsupported report source: {source}")

    scored = [score_case(case=case, observation=observation) for case, observation in ordered_pairs]
    draft_pairs = [(case, observation) for case, observation in ordered_pairs if case.expectsFirstPassDraft]
    continuation_scores = [score for (case, _), score in zip(ordered_pairs, scored) if case.expectedContinuationSchema]
    identity_scores = [score for (case, _), score in zip(ordered_pairs, scored) if case.category == "identity_boundary"]
    case_count = len(scored)
    metrics = {
        "casePassRate": build_rate(sum(score.passed for score in scored), case_count),
        "routingContractRate": build_rate(sum(score.routingPassed for score in scored), case_count),
        "toolContractRate": build_rate(sum(score.toolContractPassed for score in scored), case_count),
        "terminalContractRate": build_rate(sum(score.terminalPassed for score in scored), case_count),
        "draftFirstPassRate": build_rate(
            sum(observation.draftValidationAttempts == 1 for _, observation in draft_pairs),
            len(draft_pairs),
        ),
        "continuationContractRate": build_rate(
            sum(score.continuationPassed for score in continuation_scores),
            len(continuation_scores),
        ),
        "identityBoundaryRate": build_rate(
            sum(score.identityBoundaryPassed for score in identity_scores),
            len(identity_scores),
        ),
    }
    return SkillEvalReport(
        source=source,
        generatedAt=datetime.now(timezone.utc),
        caseCount=case_count,
        passedCaseCount=sum(score.passed for score in scored),
        metrics=metrics,
        invalidIdentityWriteCount=sum(observation.invalidIdentityWriteCount for _, observation in ordered_pairs),
        cases=scored,
    )
