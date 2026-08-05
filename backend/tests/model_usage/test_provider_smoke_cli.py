from __future__ import annotations

import json
import subprocess
import sys
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.enums import ModelUsageCapability
from scripts import model_usage_provider_smoke_driver as smoke_driver_module
from scripts.model_usage_provider_smoke_driver import (
    CulinaProviderSmokeDriver,
    ProviderSmokeDriverError,
    ProviderSmokeResult,
)
from scripts.smoke_model_usage_providers import handle_smoke


BACKEND_ROOT = Path(__file__).resolve().parents[2]
SMOKE_SCRIPT = BACKEND_ROOT / "scripts" / "smoke_model_usage_providers.py"
SECRET_MARKER = "CULINA_USAGE_SECRET_7f3a9d"


def test_cli_emits_content_free_blocked_artifact_before_any_unready_real_provider_send(
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
    assert len(payload["blockers"]) == 1
    assert payload["blockers"][0].startswith("provider_smoke_")
    assert payload["blockers"] != ["provider_smoke_driver_unavailable"]
    assert [item["capability"] for item in payload["capabilities"]] == [
        "llm",
        "embedding",
        "rerank",
        "stt",
        "tts",
        "realtime_audio",
        "image_generation",
    ]
    assert all(item["status"] == "blocked" for item in payload["capabilities"])
    assert all(str(item["errorCode"]).startswith("provider_smoke_") for item in payload["capabilities"])
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert SECRET_MARKER not in serialized
    assert "family-model-usage-smoke" not in serialized
    assert result.stdout == ""
    assert result.stderr.startswith("provider_smoke_")


def test_smoke_coordinator_accepts_only_all_seven_metered_results(tmp_path: Path) -> None:
    output = tmp_path / "provider-smoke.json"
    calls: list[ModelUsageCapability] = []

    class FakeDriver:
        def run(self, capability: ModelUsageCapability) -> ProviderSmokeResult:
            calls.append(capability)
            return ProviderSmokeResult(
                capability=capability,
                event_id=f"usage-event-{capability.value.replace('_', '')}",
            )

    result = handle_smoke(
        Namespace(
            family_id="family-model-usage-smoke",
            user_id="user-smoke",
            output=output,
            acknowledge_provider_cost=True,
        ),
        driver_factory=lambda **_kwargs: FakeDriver(),
    )

    assert result == 0
    assert calls == [
        ModelUsageCapability.LLM,
        ModelUsageCapability.EMBEDDING,
        ModelUsageCapability.RERANK,
        ModelUsageCapability.TTS,
        ModelUsageCapability.STT,
        ModelUsageCapability.REALTIME_AUDIO,
        ModelUsageCapability.IMAGE_GENERATION,
    ]
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "passed"
    assert payload["executionMode"] == "real_provider"
    assert payload["blockers"] == []
    assert [item["capability"] for item in payload["capabilities"]] == [
        capability.value for capability in ModelUsageCapability
    ]
    assert all(item["status"] == "passed" for item in payload["capabilities"])
    assert all(set(item) == {"capability", "status", "eventId"} for item in payload["capabilities"])


def test_real_driver_accepts_multiple_variants_when_all_capabilities_are_registered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = CulinaProviderSmokeDriver.__new__(CulinaProviderSmokeDriver)
    driver.family_id = "family-model-usage-smoke"
    driver.user_id = "user-smoke"
    driver.settings = SimpleNamespace(model_usage_required=True)

    registrations = [
        SimpleNamespace(capability=capability)
        for capability in ModelUsageCapability
    ]
    registrations.append(
        SimpleNamespace(capability=ModelUsageCapability.IMAGE_GENERATION)
    )
    monkeypatch.setattr(
        smoke_driver_module,
        "provider_usage_registrations",
        lambda _settings: registrations,
    )
    monkeypatch.setattr(
        smoke_driver_module,
        "run_first_launch_preflight",
        lambda _settings: SimpleNamespace(ready=True),
    )

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def get(self, model: object, _identifier: str) -> object:
            if model is smoke_driver_module.User:
                return SimpleNamespace(is_active=True)
            return object()

        def scalar(self, _statement: object) -> object:
            return object()

    monkeypatch.setattr(smoke_driver_module, "SessionLocal", FakeSession)

    driver._validate_before_provider_send()


def test_realtime_smoke_closes_the_session_when_the_adapter_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = CulinaProviderSmokeDriver.__new__(CulinaProviderSmokeDriver)
    driver.family_id = "family-model-usage-smoke"
    driver.user_id = "user-smoke"
    driver.run_id = "provider-smoke-test"
    driver.settings = SimpleNamespace(ai_realtime_provider="dashscope")
    closed: list[str] = []

    class FakeAudioService:
        def __init__(self, _settings: object) -> None:
            pass

        def create_cooking_session(self, _request: object) -> object:
            return SimpleNamespace(session_id="voice-session-test")

    class FakeStore:
        def require_owner(self, *_args: object, **_kwargs: object) -> object:
            return SimpleNamespace(realtime_usage_scope=None)

        def close(self, session_id: str) -> None:
            closed.append(session_id)

    monkeypatch.setattr(smoke_driver_module, "AIAudioService", FakeAudioService)
    monkeypatch.setattr(smoke_driver_module, "realtime_voice_session_store", FakeStore())

    with pytest.raises(
        ProviderSmokeDriverError,
        match="provider_smoke_realtime_adapter_missing",
    ):
        driver._run_realtime_audio()

    assert closed == ["voice-session-test"]


def test_realtime_smoke_terminalizes_the_lease_and_returns_its_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = CulinaProviderSmokeDriver.__new__(CulinaProviderSmokeDriver)
    driver.family_id = "family-model-usage-smoke"
    driver.user_id = "user-smoke"
    driver.run_id = "provider-smoke-test"
    driver.settings = SimpleNamespace(ai_realtime_provider="dashscope")
    closed: list[str] = []
    lifecycle: list[str] = []

    class FakeScope:
        async def finish_current_lease_once(self, *, completion_reason: str) -> object:
            lifecycle.append(f"finish:{completion_reason}")
            return SimpleNamespace(
                decision="ended",
                settlement=SimpleNamespace(event_id="usage-event-realtime"),
            )

    scope = FakeScope()

    class FakeAudioService:
        def __init__(self, _settings: object) -> None:
            pass

        def create_cooking_session(self, _request: object) -> object:
            return SimpleNamespace(session_id="voice-session-test")

    class FakeProvider:
        def __init__(self, _settings: object, *, capability: str) -> None:
            assert capability == "tts"

        async def synthesize_realtime_text(self, _request: object, **kwargs: object) -> object:
            assert kwargs["realtime_usage_scope"] is scope
            lifecycle.append("provider_send")
            return SimpleNamespace(audio_bytes=b"audio")

    class FakeStore:
        def require_owner(self, *_args: object, **_kwargs: object) -> object:
            return SimpleNamespace(realtime_usage_scope=scope)

        def close(self, session_id: str) -> None:
            lifecycle.append("close")
            closed.append(session_id)

    monkeypatch.setattr(smoke_driver_module, "AIAudioService", FakeAudioService)
    monkeypatch.setattr(smoke_driver_module, "DashScopeAudioProvider", FakeProvider)
    monkeypatch.setattr(smoke_driver_module, "realtime_voice_session_store", FakeStore())
    monkeypatch.setattr(
        driver,
        "_event_for_operation",
        lambda **_kwargs: pytest.fail("realtime smoke must use the terminal settlement event"),
    )

    event_id = driver._run_realtime_audio()

    assert event_id == "usage-event-realtime"
    assert lifecycle == ["provider_send", "finish:provider_smoke", "close"]
    assert closed == ["voice-session-test"]


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
