from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from scripts.generate_model_usage_launch_report import (
    _performance_evidence,
    _provider_smoke_evidence,
    _visual_review_evidence,
    build_launch_report,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPORT_SCRIPT = BACKEND_ROOT / "scripts" / "generate_model_usage_launch_report.py"


REQUIRED_ASSERTIONS = {
    "focusedModelUsageTests": {
        "focusedSuitePassed",
    },
    "backendQuality": {
        "compileCheckPassed",
        "pytestSuitePassed",
    },
    "frontendQuality": {
        "styleTokenScanCompleted",
        "typecheckPassed",
        "vitestPassed",
    },
    "frontendBuild": {
        "productionBuildPassed",
    },
    "frontendStyleTokens": {
        "newViolationsAbsentOrAccepted",
        "reportReviewed",
    },
    "frontendSmoke": {
        "modelUsageSmokePassed",
    },
    "frontendE2EP0": {
        "p0JourneysPassed",
        "targetViewportsCovered",
    },
    "dockerBuild": {
        "backendImageBuilt",
        "frontendImageBuilt",
    },
    "mysqlMigrationConcurrency": {
        "concurrencyPassed",
        "migrationPassed",
        "queryPlansPassed",
    },
    "dispatchPolicyInterleaving": {
        "interleavingPassed",
    },
}


def _required_command_evidence(*, commit: str, failed_command: str | None = None) -> dict[str, object]:
    return {
        "schemaVersion": "model_usage_launch_verification.v1",
        "commands": {
            command_id: {
                "commit": commit,
                "environment": {"os": "ubuntu-24.04", "python": "3.12"},
                "exitCode": 1 if command_id == failed_command else 0,
                "assertions": {
                    assertion: command_id != failed_command
                    for assertion in required_assertions
                },
            }
            for command_id, required_assertions in REQUIRED_ASSERTIONS.items()
        },
    }


def test_launch_report_blocks_when_required_command_evidence_is_missing(tmp_path: Path) -> None:
    report = build_launch_report(
        provider_smoke=tmp_path / "missing-provider-smoke.json",
        audit=tmp_path / "missing-audit.json",
        rollup=tmp_path / "missing-rollup.json",
        health=tmp_path / "missing-health.json",
        visual_review=tmp_path / "missing-visual-review",
        performance=None,
        verification_evidence=tmp_path / "missing-verification-evidence.json",
    )

    assert "required_verification_evidence_not_run" in report["blockers"]
    assert report["evidence"]["requiredVerification"]["status"] == "not_run"


def test_launch_report_blocks_when_any_required_command_evidence_failed(tmp_path: Path) -> None:
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=BACKEND_ROOT.parent,
        text=True,
    ).strip()
    verification_evidence = tmp_path / "verification-evidence.json"
    verification_evidence.write_text(
        json.dumps(_required_command_evidence(commit=commit, failed_command="backendQuality")),
        encoding="utf-8",
    )

    report = build_launch_report(
        provider_smoke=tmp_path / "missing-provider-smoke.json",
        audit=tmp_path / "missing-audit.json",
        rollup=tmp_path / "missing-rollup.json",
        health=tmp_path / "missing-health.json",
        visual_review=tmp_path / "missing-visual-review",
        performance=None,
        verification_evidence=verification_evidence,
    )

    assert "required_verification_backend_quality_failed" in report["blockers"]
    assert report["evidence"]["requiredVerification"]["status"] == "blocked"
    commands = report["evidence"]["requiredVerification"]["commands"]
    assert isinstance(commands, dict)
    frontend_quality = commands["frontendQuality"]
    assert isinstance(frontend_quality, dict)
    assert frontend_quality["environment"] == {"os": "ubuntu", "python": "3.12"}


def test_launch_report_blocks_when_command_uses_unrelated_true_assertion(tmp_path: Path) -> None:
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=BACKEND_ROOT.parent,
        text=True,
    ).strip()
    verification_evidence = _required_command_evidence(commit=commit)
    commands = verification_evidence["commands"]
    assert isinstance(commands, dict)
    commands["mysqlMigrationConcurrency"]["assertions"] = {"passed": True}
    evidence_path = tmp_path / "verification-evidence.json"
    evidence_path.write_text(json.dumps(verification_evidence), encoding="utf-8")

    report = build_launch_report(
        provider_smoke=tmp_path / "missing-provider-smoke.json",
        audit=tmp_path / "missing-audit.json",
        rollup=tmp_path / "missing-rollup.json",
        health=tmp_path / "missing-health.json",
        visual_review=tmp_path / "missing-visual-review",
        performance=None,
        verification_evidence=evidence_path,
    )

    assert "required_verification_mysql_migration_concurrency_assertions_not_passed" in report["blockers"]
    assert report["evidence"]["requiredVerification"]["status"] == "blocked"


def test_launch_report_rejects_unknown_verification_keys_at_every_level(tmp_path: Path) -> None:
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=BACKEND_ROOT.parent,
        text=True,
    ).strip()

    def mutate_document(document: dict[str, object], level: str) -> None:
        commands = document["commands"]
        assert isinstance(commands, dict)
        if level == "document":
            document["rawOutput"] = "must-not-be-accepted"
        elif level == "commands":
            commands["unreviewedCommand"] = commands["backendQuality"]
        elif level == "command":
            commands["backendQuality"]["durationMs"] = 1
        elif level == "assertions":
            commands["backendQuality"]["assertions"]["unreviewedAssertion"] = True
        else:  # pragma: no cover - protects the test table itself
            raise AssertionError(level)

    for level in ("document", "commands", "command", "assertions"):
        verification_evidence = _required_command_evidence(commit=commit)
        mutate_document(verification_evidence, level)
        evidence_path = tmp_path / f"verification-evidence-{level}.json"
        evidence_path.write_text(json.dumps(verification_evidence), encoding="utf-8")

        report = build_launch_report(
            provider_smoke=tmp_path / "missing-provider-smoke.json",
            audit=tmp_path / "missing-audit.json",
            rollup=tmp_path / "missing-rollup.json",
            health=tmp_path / "missing-health.json",
            visual_review=tmp_path / "missing-visual-review",
            performance=None,
            verification_evidence=evidence_path,
        )

        assert report["evidence"]["requiredVerification"]["status"] == "blocked", level


def test_launch_report_blocks_and_does_not_copy_untrusted_environment_values(tmp_path: Path) -> None:
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=BACKEND_ROOT.parent,
        text=True,
    ).strip()
    verification_evidence = _required_command_evidence(commit=commit)
    commands = verification_evidence["commands"]
    assert isinstance(commands, dict)
    commands["backendQuality"]["environment"] = {
        "os": "api_key=never-copy-this",
        "python": "3.12",
    }
    evidence_path = tmp_path / "verification-evidence.json"
    evidence_path.write_text(json.dumps(verification_evidence), encoding="utf-8")

    report = build_launch_report(
        provider_smoke=tmp_path / "missing-provider-smoke.json",
        audit=tmp_path / "missing-audit.json",
        rollup=tmp_path / "missing-rollup.json",
        health=tmp_path / "missing-health.json",
        visual_review=tmp_path / "missing-visual-review",
        performance=None,
        verification_evidence=evidence_path,
    )

    required = report["evidence"]["requiredVerification"]
    assert isinstance(required, dict)
    assert required["status"] == "blocked"
    assert "required_verification_backend_quality_environment_missing" in report["blockers"]
    assert "api_key=never-copy-this" not in json.dumps(report)


def test_launch_report_is_blocked_when_real_smoke_artifact_is_missing(tmp_path: Path) -> None:
    output = tmp_path / "model-usage-first-launch-report.md"

    result = subprocess.run(
        [
            sys.executable,
            str(REPORT_SCRIPT),
            "--provider-smoke",
            str(tmp_path / "missing-provider-smoke.json"),
            "--audit",
            str(tmp_path / "missing-audit.json"),
            "--rollup",
            str(tmp_path / "missing-rollup.json"),
            "--health",
            str(tmp_path / "missing-health.json"),
            "--visual-review",
            str(tmp_path / "missing-visual-review"),
            "--verification-evidence",
            str(tmp_path / "missing-verification-evidence.json"),
            "--output",
            str(output),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    report = output.read_text(encoding="utf-8")
    assert "ready_for_first_open: false" in report
    assert "status: blocked" in report
    assert "provider_smoke_not_run" in report
    assert "counter_audit_not_run" in report
    assert "reference_performance_not_run" in report
    assert "visual_review_not_run" in report


def _write_visual_review(
    directory: Path,
    *,
    checks: dict[str, bool] | None = None,
    extra_document_field: bool = False,
) -> None:
    expected_checks = {
        "keyboard": True,
        "reducedMotion": True,
        "textZoom200": True,
        "noHorizontalOverflow": True,
        "screenReaderLabels": True,
        "voiceOver": True,
        "safeArea": True,
        "offlineRestore": True,
        "longModelNames": True,
    }
    if checks is not None:
        expected_checks = checks
    payload: dict[str, object] = {
        "schemaVersion": "model_usage_visual_review.v1",
        "status": "passed",
        "viewports": [
            "360x800",
            "375x812",
            "390x844",
            "430x932",
            "768x1024",
            "1024x768",
            "1440x900",
        ],
        "unresolvedP0P1": 0,
        "checks": expected_checks,
        "notes": [],
    }
    if extra_document_field:
        payload["rawScreenReaderTranscript"] = "must-not-be-accepted"
    directory.mkdir()
    (directory / "review.json").write_text(json.dumps(payload), encoding="utf-8")


def test_visual_review_requires_every_manual_and_automated_check(tmp_path: Path) -> None:
    visual_review = tmp_path / "visual-review"
    checks = {
        "keyboard": True,
        "reducedMotion": True,
        "textZoom200": True,
        "noHorizontalOverflow": True,
        "screenReaderLabels": True,
        "voiceOver": False,
        "safeArea": True,
        "offlineRestore": True,
        "longModelNames": True,
    }
    _write_visual_review(visual_review, checks=checks)

    evidence, blockers = _visual_review_evidence(visual_review)

    assert evidence["status"] == "blocked"
    assert blockers == ["visual_review_not_passed"]


def test_visual_review_rejects_unknown_document_and_check_keys(tmp_path: Path) -> None:
    document_directory = tmp_path / "visual-review-document"
    _write_visual_review(document_directory, extra_document_field=True)

    check_directory = tmp_path / "visual-review-check"
    checks = {
        "keyboard": True,
        "reducedMotion": True,
        "textZoom200": True,
        "noHorizontalOverflow": True,
        "screenReaderLabels": True,
        "voiceOver": True,
        "safeArea": True,
        "offlineRestore": True,
        "longModelNames": True,
        "unreviewedCheck": True,
    }
    _write_visual_review(check_directory, checks=checks)

    for directory in (document_directory, check_directory):
        evidence, blockers = _visual_review_evidence(directory)
        assert evidence["status"] == "blocked"
        assert blockers == ["visual_review_not_passed"]


def _write_reference_performance(
    path: Path,
    *,
    payload_updates: dict[str, object] | None = None,
    document_updates: dict[str, object] | None = None,
) -> None:
    payload: dict[str, object] = {
        "profile": "culina-first-launch-mysql84-v1",
        "status": "passed",
        "sampleCount": 20,
        "reserveP95Ms": 10.0,
        "settleP95Ms": 10.0,
        "currentOverviewP95Ms": 20.0,
        "currentBreakdownP95Ms": 30.0,
        "historicalRollupP95Ms": 20.0,
        "hasFullTableScan": False,
        "currentAggregateQueryCount": 11,
        "currentBreakdownQueryCount": 6,
        "historicalRollupQueryCount": 3,
    }
    if payload_updates:
        payload.update(payload_updates)
    document: dict[str, object] = {
        "schemaVersion": "model_usage_reference_performance.v1",
        "exitCode": 0,
        "payload": payload,
    }
    if document_updates:
        document.update(document_updates)
    path.write_text(json.dumps(document), encoding="utf-8")


def test_reference_performance_requires_exact_content_free_schema(tmp_path: Path) -> None:
    valid = tmp_path / "valid.json"
    _write_reference_performance(valid)
    evidence, blocker = _performance_evidence(valid)
    assert evidence["status"] == "passed"
    assert blocker is None

    unknown_document = tmp_path / "unknown-document.json"
    _write_reference_performance(unknown_document, document_updates={"rawOutput": "unsafe"})
    unknown_payload = tmp_path / "unknown-payload.json"
    _write_reference_performance(unknown_payload, payload_updates={"hostname": "private-host"})
    non_finite = tmp_path / "non-finite.json"
    _write_reference_performance(non_finite, payload_updates={"reserveP95Ms": float("nan")})
    excessive_queries = tmp_path / "excessive-queries.json"
    _write_reference_performance(excessive_queries, payload_updates={"currentAggregateQueryCount": 12})

    for path in (unknown_document, unknown_payload, non_finite, excessive_queries):
        evidence, blocker = _performance_evidence(path)
        assert evidence["status"] == "blocked"
        assert blocker == "reference_performance_not_passed"


def test_provider_smoke_evidence_requires_all_seven_real_provider_results(
    tmp_path: Path,
) -> None:
    smoke = tmp_path / "provider-smoke.json"
    capabilities = (
        "llm",
        "embedding",
        "rerank",
        "stt",
        "tts",
        "realtime_audio",
        "image_generation",
    )
    smoke.write_text(
        json.dumps(
            {
                "schemaVersion": "model_usage_provider_smoke.v1",
                "generatedAt": "2026-08-05T00:00:00Z",
                "status": "passed",
                "executionMode": "real_provider",
                "blockers": [],
                "capabilities": [
                    {
                        "capability": capability,
                        "status": "passed",
                        "eventId": f"usage-event-{capability.replace('_', '')}",
                    }
                    for capability in capabilities
                ],
            }
        ),
        encoding="utf-8",
    )

    evidence, blocker = _provider_smoke_evidence(smoke)

    assert evidence["status"] == "passed"
    assert blocker is None


def test_provider_smoke_evidence_rejects_unknown_or_incomplete_rows(
    tmp_path: Path,
) -> None:
    smoke = tmp_path / "provider-smoke.json"
    capabilities = [
        {
            "capability": capability,
            "status": "passed",
            "eventId": f"usage-event-{capability.replace('_', '')}",
        }
        for capability in (
            "llm",
            "embedding",
            "rerank",
            "stt",
            "tts",
            "realtime_audio",
            "image_generation",
        )
    ]
    capabilities[0]["providerResponse"] = "must-not-be-accepted"
    smoke.write_text(
        json.dumps(
            {
                "schemaVersion": "model_usage_provider_smoke.v1",
                "generatedAt": "2026-08-05T00:00:00Z",
                "status": "passed",
                "executionMode": "real_provider",
                "blockers": [],
                "capabilities": capabilities,
            }
        ),
        encoding="utf-8",
    )

    evidence, blocker = _provider_smoke_evidence(smoke)

    assert evidence["status"] == "blocked"
    assert blocker == "provider_smoke_not_passed"
