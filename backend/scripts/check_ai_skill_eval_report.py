from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ai.evals.loader import load_eval_cases
from app.ai.evals.models import SkillEvalCase, SkillEvalReport
from app.ai.evals.thresholds import SkillEvalThresholds, check_thresholds


def case_contract_failures(report: SkillEvalReport, cases: list[SkillEvalCase]) -> list[str]:
    failures: list[str] = []
    expected_ids = [case.id for case in sorted(cases, key=lambda item: item.id)]
    actual_ids = [case.caseId for case in report.cases]
    if actual_ids != expected_ids:
        missing = sorted(set(expected_ids) - set(actual_ids))
        extra = sorted(set(actual_ids) - set(expected_ids))
        failures.append(
            "caseIds: report does not match core dataset; "
            f"missing={missing} extra={extra} orderMatches={set(actual_ids) == set(expected_ids)}"
        )
        return failures

    scores_by_id = {score.caseId: score for score in report.cases}
    metric_expectations = {
        "draftFirstPassRate": (
            [case for case in cases if case.expectsFirstPassDraft],
            "firstPassDraftPassed",
        ),
        "continuationContractRate": (
            [case for case in cases if case.expectedContinuationSchema],
            "continuationPassed",
        ),
        "identityBoundaryRate": (
            [case for case in cases if case.category == "identity_boundary"],
            "identityBoundaryPassed",
        ),
    }
    for metric_name, (eligible_cases, score_field) in metric_expectations.items():
        expected_denominator = len(eligible_cases)
        expected_numerator = sum(
            bool(getattr(scores_by_id[case.id], score_field))
            for case in eligible_cases
        )
        metric = report.metrics[metric_name]
        if metric.numerator != expected_numerator or metric.denominator != expected_denominator:
            failures.append(
                f"{metric_name}: report metric does not match case scores; "
                f"expected {expected_numerator}/{expected_denominator}, "
                f"got {metric.numerator}/{metric.denominator}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--thresholds", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    args = parser.parse_args()
    report = SkillEvalReport.model_validate_json(args.report.read_text(encoding="utf-8"))
    thresholds = SkillEvalThresholds.model_validate(json.loads(args.thresholds.read_text(encoding="utf-8")))
    failures = check_thresholds(report=report, thresholds=thresholds)
    failures.extend(case_contract_failures(report, load_eval_cases(args.cases)))
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    rates = ", ".join(f"{name}={metric.rate}" for name, metric in report.metrics.items())
    print(f"AI skill eval gate passed: {report.caseCount} cases; {rates}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
