import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.ai.evals.models import SkillEvalCase, SkillEvalCaseScore, SkillEvalObservation, SkillEvalReport
from app.ai.evals.scoring import build_rate
from scripts.check_ai_skill_eval_report import case_contract_failures


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _write_jsonl(path: Path, values: list[object]) -> None:
    path.write_text(
        "\n".join(value.model_dump_json() for value in values) + "\n",
        encoding="utf-8",
    )


def _case(case_id: str) -> SkillEvalCase:
    return SkillEvalCase(
        schemaVersion="skill_eval_case.v1",
        id=case_id,
        category="query",
        message="查库存",
        expectedTerminalStatus="completed",
        script=[{"assistantText": "完成"}],
    )


def _observation(case_id: str, source: str) -> SkillEvalObservation:
    return SkillEvalObservation.model_validate(
        {
            "schemaVersion": "skill_eval_observation.v1",
            "caseId": case_id,
            "source": source,
            "terminalStatus": "completed",
        }
    )


def test_run_cli_rejects_mixed_observation_sources(tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.jsonl"
    observations_path = tmp_path / "observations.jsonl"
    output_path = tmp_path / "report.json"
    _write_jsonl(cases_path, [_case("case.one"), _case("case.two")])
    _write_jsonl(
        observations_path,
        [
            _observation("case.one", "scripted"),
            _observation("case.two", "real_provider"),
        ],
    )

    result = subprocess.run(
        [
            sys.executable,
            "scripts/run_ai_skill_evals.py",
            "--cases",
            str(cases_path),
            "--observations",
            str(observations_path),
            "--output",
            str(output_path),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "observations must have exactly one source" in result.stderr
    assert not output_path.exists()


def test_run_cli_requires_force_to_overwrite_report(tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.jsonl"
    observations_path = tmp_path / "observations.jsonl"
    output_path = tmp_path / "report.json"
    _write_jsonl(cases_path, [_case("case.one")])
    _write_jsonl(observations_path, [_observation("case.one", "scripted")])
    output_path.write_text("existing", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            "scripts/run_ai_skill_evals.py",
            "--cases",
            str(cases_path),
            "--observations",
            str(observations_path),
            "--output",
            str(output_path),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "pass --force to overwrite" in result.stderr
    assert output_path.read_text(encoding="utf-8") == "existing"


def test_check_cli_rejects_report_case_ids_outside_dataset(tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.jsonl"
    report_path = tmp_path / "report.json"
    thresholds_path = tmp_path / "thresholds.json"
    _write_jsonl(cases_path, [_case("case.expected")])
    report = SkillEvalReport(
        source="scripted",
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
        cases=[
            SkillEvalCaseScore(
                caseId="case.unexpected",
                passed=True,
                routingPassed=True,
                toolContractPassed=True,
                terminalPassed=True,
                draftPassed=True,
                firstPassDraftPassed=True,
                continuationPassed=True,
                identityBoundaryPassed=True,
            )
        ],
    )
    report_path.write_text(report.model_dump_json(), encoding="utf-8")
    thresholds_path.write_text(
        json.dumps(
            {
                "schemaVersion": "skill_eval_thresholds.v1",
                "minimumCaseCount": 0,
                "minimumRates": {},
                "maximumInvalidIdentityWriteCount": 0,
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            "scripts/check_ai_skill_eval_report.py",
            "--report",
            str(report_path),
            "--thresholds",
            str(thresholds_path),
            "--cases",
            str(cases_path),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "missing=['case.expected']" in result.stderr
    assert "extra=['case.unexpected']" in result.stderr


def test_checker_rejects_metric_denominator_that_does_not_match_cases() -> None:
    eval_case = _case("case.expected")
    score = SkillEvalCaseScore(
        caseId=eval_case.id,
        passed=True,
        routingPassed=True,
        toolContractPassed=True,
        terminalPassed=True,
        draftPassed=True,
        firstPassDraftPassed=True,
        continuationPassed=True,
        identityBoundaryPassed=True,
    )
    report = SkillEvalReport(
        source="scripted",
        generatedAt=datetime.now(timezone.utc),
        caseCount=1,
        passedCaseCount=1,
        metrics={
            "casePassRate": build_rate(1, 1),
            "routingContractRate": build_rate(1, 1),
            "toolContractRate": build_rate(1, 1),
            "terminalContractRate": build_rate(1, 1),
            "draftFirstPassRate": build_rate(1, 1),
            "continuationContractRate": build_rate(0, 0),
            "identityBoundaryRate": build_rate(0, 0),
        },
        invalidIdentityWriteCount=0,
        cases=[score],
    )

    assert case_contract_failures(report, [eval_case]) == [
        "draftFirstPassRate: report metric does not match case scores; expected 0/0, got 1/1"
    ]
