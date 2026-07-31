from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from scripts.generate_model_usage_launch_report import (
    _provider_smoke_evidence,
    build_launch_report,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPORT_SCRIPT = BACKEND_ROOT / "scripts" / "generate_model_usage_launch_report.py"


def _required_command_evidence(*, commit: str, failed_command: str | None = None) -> dict[str, object]:
    command_ids = (
        "focusedModelUsageTests",
        "backendQuality",
        "frontendQuality",
        "frontendBuild",
        "frontendStyleTokens",
        "frontendSmoke",
        "frontendE2EP0",
        "dockerBuild",
        "mysqlMigrationConcurrency",
        "dispatchPolicyInterleaving",
    )
    return {
        "schemaVersion": "model_usage_launch_verification.v1",
        "commands": {
            command_id: {
                "commit": commit,
                "environment": {"os": "ubuntu-24.04", "python": "3.12"},
                "exitCode": 1 if command_id == failed_command else 0,
                "assertions": {"passed": command_id != failed_command},
            }
            for command_id in command_ids
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
                "status": "passed",
                "executionMode": "real_provider",
                "capabilities": [
                    {"capability": capability, "status": "passed"}
                    for capability in capabilities
                ],
            }
        ),
        encoding="utf-8",
    )

    evidence, blocker = _provider_smoke_evidence(smoke)

    assert evidence["status"] == "passed"
    assert blocker is None
