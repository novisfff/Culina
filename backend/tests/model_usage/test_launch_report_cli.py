from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from scripts.generate_model_usage_launch_report import _provider_smoke_evidence

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPORT_SCRIPT = BACKEND_ROOT / "scripts" / "generate_model_usage_launch_report.py"


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
