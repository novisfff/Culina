from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = BACKEND_ROOT / "scripts" / "manage_model_usage_prices.py"
FIXTURE = Path(__file__).parent / "fixtures" / "prices_valid.json"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(BACKEND_ROOT)
    return subprocess.run(
        [str(BACKEND_ROOT / ".venv" / "bin" / "python"), str(SCRIPT), *args],
        cwd=BACKEND_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def test_validate_prints_checksum_and_seven_capability_rows() -> None:
    result = run_cli("validate", "--file", str(FIXTURE), "--json")

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert len(payload["checksum"]) == 64
    assert {row["capability"] for row in payload["coverage"]} == {
        "llm",
        "embedding",
        "rerank",
        "stt",
        "tts",
        "realtime_audio",
        "image_generation",
    }
    assert "api_key" not in result.stdout.lower()


def test_publish_requires_checksum_and_change_ticket() -> None:
    result = run_cli(
        "publish",
        "--file",
        str(FIXTURE),
        "--operator",
        "release-owner",
    )

    assert result.returncode != 0
    assert "--change-ticket" in result.stderr
    assert "--confirm-checksum" in result.stderr


def test_validation_error_does_not_echo_secret_input(tmp_path: Path) -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    raw["api_key"] = "should-never-be-printed"
    broken = tmp_path / "broken-price.json"
    broken.write_text(json.dumps(raw), encoding="utf-8")

    result = run_cli("validate", "--file", str(broken))

    assert result.returncode != 0
    assert "should-never-be-printed" not in result.stdout
    assert "should-never-be-printed" not in result.stderr
    assert "invalid_price_manifest" in result.stderr
