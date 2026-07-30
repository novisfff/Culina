from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[2]
SMOKE_SCRIPT = BACKEND_ROOT / "scripts" / "smoke_model_usage_providers.py"
SECRET_MARKER = "CULINA_USAGE_SECRET_7f3a9d"


def test_cli_emits_content_free_blocked_artifact_when_real_drivers_are_unavailable(
    tmp_path: Path,
) -> None:
    output = tmp_path / "provider-smoke.json"

    result = subprocess.run(
        [
            sys.executable,
            str(SMOKE_SCRIPT),
            "--family-id",
            "family-model-usage-smoke",
            "--user-id",
            f"user-{SECRET_MARKER}",
            "--acknowledge-provider-cost",
            "--output",
            str(output),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert output.exists()
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["schemaVersion"] == "model_usage_provider_smoke.v1"
    assert payload["status"] == "blocked"
    assert payload["executionMode"] == "not_run"
    assert payload["blockers"] == ["provider_smoke_driver_unavailable"]
    assert [item["capability"] for item in payload["capabilities"]] == [
        "llm",
        "embedding",
        "rerank",
        "stt",
        "tts",
        "realtime_audio",
        "image_generation",
    ]
    assert all(
        item == {
            "capability": item["capability"],
            "status": "blocked",
            "errorCode": "provider_smoke_driver_unavailable",
        }
        for item in payload["capabilities"]
    )
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert SECRET_MARKER not in serialized
    assert "family-model-usage-smoke" not in serialized
    assert result.stdout == ""
    assert result.stderr == "provider_smoke_driver_unavailable\n"


def test_cli_requires_explicit_cost_acknowledgement_and_a_designated_test_family(
    tmp_path: Path,
) -> None:
    acknowledgement_output = tmp_path / "missing-acknowledgement.json"
    acknowledgement_result = subprocess.run(
        [
            sys.executable,
            str(SMOKE_SCRIPT),
            "--family-id",
            "family-model-usage-smoke",
            "--user-id",
            "user-smoke",
            "--output",
            str(acknowledgement_output),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    production_output = tmp_path / "production-family.json"
    production_result = subprocess.run(
        [
            sys.executable,
            str(SMOKE_SCRIPT),
            "--family-id",
            "production-family",
            "--user-id",
            "user-smoke",
            "--acknowledge-provider-cost",
            "--output",
            str(production_output),
        ],
        cwd=BACKEND_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert acknowledgement_result.returncode != 0
    assert acknowledgement_output.exists() is False
    assert production_result.returncode == 2
    assert production_output.exists() is False
    assert production_result.stderr == "provider_smoke_test_family_required\n"
