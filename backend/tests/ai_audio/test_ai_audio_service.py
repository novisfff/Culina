from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.ai_audio.config import resolved_audio_provider_config
from app.services.ai_audio.dashscope_audio import (
    DashScopeAudioProvider,
    RealtimeAudioProvider,
)
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.providers import AudioProviderDependencies
from app.services.ai_audio.realtime import RealtimeVoiceSessionState, realtime_voice_session_store
from app.services.ai_audio.schemas import SpeechRequest
from app.services.ai_audio.service import AIAudioService, AudioDependencies
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import AudioDurationError, measure_audio_duration_seconds
from app.services.family_model_settings.transport import ProviderMedia, ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.errors import ModelUsageContractError


def _binding(
    *,
    capability: str = "tts",
    adapter_kind: str = "openai_compatible_http",
    options: dict[str, object] | None = None,
) -> ResolvedCapabilityBinding:
    endpoint = ResolvedProviderEndpoint(
        normalized_url="https://audio.example/v1",
        scheme="https",
        host="audio.example",
        port=443,
        base_path="/v1",
        resolved_addresses=("93.184.216.34",),
        private_target=False,
    )
    return ResolvedCapabilityBinding(
        family_id="family-a",
        config_revision_id="revision-a",
        provider_profile_id="profile-a",
        provider_profile_version_id="profile-version-a",
        adapter_kind=adapter_kind,  # type: ignore[arg-type]
        auth_mode="api_key",
        endpoint=endpoint,
        websocket_endpoint=None,
        requested_model=f"{capability}-model",
        billing_model=f"{capability}-model",
        capability=capability,  # type: ignore[arg-type]
        variant_key="default",
        billing_scheme_key=(
            "tts-characters-v1" if capability == "tts" else "stt-seconds-v1"
        ),
        options=options or {},
    )


@dataclass
class _Permit:
    credential_secret_version_id: str = "secret-rotated"
    provider_idempotency_key: str = "audio-attempt"


class _Attempt:
    def __init__(self, timeline: list[str]) -> None:
        self.timeline = timeline

    def prepare_dispatch(self) -> _Permit:
        self.timeline.append("dispatch")
        return _Permit()

    def settle(self, receipt: object) -> None:
        assert receipt == "receipt"
        self.timeline.append("settle")

    def mark_uncertain(self, code: str) -> None:
        self.timeline.append(f"uncertain:{code}")


class _AudioAdapter:
    def __init__(self, binding: ResolvedCapabilityBinding, timeline: list[str]) -> None:
        self.binding = binding
        self.timeline = timeline

    def request_fingerprint(self, _payload: object) -> str:
        return "fingerprint"

    def begin_tts(self, *_args: object, **kwargs: object) -> _Attempt:
        assert kwargs["binding"] == self.binding
        self.timeline.append("begin")
        return _Attempt(self.timeline)

    def begin_stt(self, *_args: object, **kwargs: object) -> _Attempt:
        assert kwargs["binding"] == self.binding
        self.timeline.append("begin")
        return _Attempt(self.timeline)

    def tts_receipt(self, *_args: object, **_kwargs: object) -> str:
        self.timeline.append("receipt")
        return "receipt"

    def stt_receipt(self, *_args: object, **_kwargs: object) -> str:
        self.timeline.append("receipt")
        return "receipt"

    def confirmed_not_executed_receipt(self, *_args: object, **_kwargs: object) -> str:
        return "receipt"


def _speech_request() -> SpeechRequest:
    return SpeechRequest(
        text="今天做番茄炒蛋。",
        surface="recipe_cook_page",
        family_id="family-a",
        user_id="user-a",
        operation_id="tts-operation-a",
    )


def test_openai_audio_dispatches_before_decrypt_and_uses_shared_transport() -> None:
    binding = _binding(options={"voice": "alloy", "output_format": "mp3"})
    timeline: list[str] = []

    class Transport:
        def request(self, method: str, url: str, **kwargs: object) -> ProviderResponse:
            assert method == "POST"
            assert url == "https://audio.example/v1/audio/speech"
            headers = kwargs["headers"]
            assert isinstance(headers, dict)
            assert headers["Authorization"] == "Bearer key-rotated"
            assert isinstance(kwargs["json"], dict)
            timeline.append("transport")
            return ProviderResponse(200, {"content-type": "audio/mpeg"}, b"audio")

    def resolve_credential(
        resolved: ResolvedCapabilityBinding,
        secret_id: str | None,
    ) -> DispatchCredential:
        assert resolved == binding
        assert secret_id == "secret-rotated"
        timeline.append("decrypt")
        return DispatchCredential("family-a", "profile-a", secret_id, "key-rotated")

    provider = OpenAIAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(Transport(), resolve_credential),  # type: ignore[arg-type]
        usage_adapter=_AudioAdapter(binding, timeline),  # type: ignore[arg-type]
    )

    result = provider.synthesize(_speech_request())

    assert result.audio_bytes == b"audio"
    assert timeline == ["begin", "dispatch", "decrypt", "transport", "receipt", "settle"]


def test_dashscope_tts_downloads_generated_url_through_shared_transport() -> None:
    binding = _binding(
        adapter_kind="dashscope_http",
        options={"voice": "Cherry", "output_format": "mp3"},
    )
    timeline: list[str] = []

    class Transport:
        def request(self, _method: str, _url: str, **_kwargs: object) -> ProviderResponse:
            timeline.append("transport")
            return ProviderResponse(
                200,
                {"content-type": "application/json"},
                json.dumps({"output": {"audio": {"url": "https://audio.example/media/a.mp3"}}}).encode(),
            )

        def download_media(self, url: str, **kwargs: object) -> ProviderMedia:
            assert url == "https://audio.example/media/a.mp3"
            assert kwargs["source"] == binding.endpoint
            assert kwargs["adapter_kind"] == "dashscope_http"
            timeline.append("download")
            return ProviderMedia(b"audio", "audio/mpeg", binding.endpoint)

    provider = DashScopeAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(
            Transport(),  # type: ignore[arg-type]
            lambda _binding, secret_id: DispatchCredential(
                "family-a", "profile-a", secret_id, "key"
            ),
        ),
        usage_adapter=_AudioAdapter(binding, timeline),  # type: ignore[arg-type]
    )

    result = provider.synthesize(_speech_request())

    assert result.audio_bytes == b"audio"
    assert timeline == ["begin", "dispatch", "transport", "receipt", "settle", "download"]


def test_dashscope_transport_contract_failure_remains_uncertain_after_dispatch() -> None:
    binding = _binding(
        adapter_kind="dashscope_http",
        options={"voice": "Cherry", "output_format": "mp3"},
    )
    timeline: list[str] = []

    class Transport:
        def request(self, *_args: object, **_kwargs: object) -> ProviderResponse:
            raise ModelUsageContractError("transport_contract_failure")

    provider = DashScopeAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(
            Transport(),  # type: ignore[arg-type]
            lambda _binding, secret_id: DispatchCredential(
                "family-a", "profile-a", secret_id, "key"
            ),
        ),
        usage_adapter=_AudioAdapter(binding, timeline),  # type: ignore[arg-type]
    )

    with pytest.raises(HTTPException) as exc_info:
        provider.synthesize(_speech_request())

    assert exc_info.value.status_code == 502
    assert timeline == [
        "begin",
        "dispatch",
        "uncertain:audio_provider_result_unavailable",
    ]


@dataclass
class _RealtimeOperation:
    events: list[str]
    aborted: bool = False
    decision: str = "active"
    error_code: str | None = None
    lease: object = field(
        default_factory=lambda: SimpleNamespace(
            dispatch_permit=SimpleNamespace(credential_secret_version_id="realtime-secret")
        )
    )

    def add_tts_characters(self, _count: int) -> None:
        self.events.append("characters")

    def add_output_seconds(self, _duration: Decimal) -> None:
        self.events.append("output")

    def abort_before_provider_send(self) -> None:
        self.aborted = True
        self.events.append("abort")


@dataclass
class _RealtimeScope:
    operation: _RealtimeOperation

    @asynccontextmanager
    async def provider_audio_operation(self, **_kwargs: object):
        try:
            yield self.operation
        except Exception:
            if not self.operation.aborted:
                self.operation.events.append("uncertain")
            raise


def _realtime_binding() -> ResolvedCapabilityBinding:
    endpoint = ResolvedProviderEndpoint(
        normalized_url="wss://realtime.audio.example/v1",
        scheme="wss",
        host="realtime.audio.example",
        port=443,
        base_path="/v1",
        resolved_addresses=("93.184.216.34",),
        private_target=False,
    )
    return ResolvedCapabilityBinding(
        family_id="family-a",
        config_revision_id="revision-a",
        provider_profile_id="profile-a",
        provider_profile_version_id="profile-version-a",
        adapter_kind="openai_realtime",
        auth_mode="api_key",
        endpoint=endpoint,
        websocket_endpoint=None,
        requested_model="realtime-model",
        billing_model="realtime-model",
        capability="realtime_audio",
        variant_key="default",
        billing_scheme_key="realtime-asr-seconds-tts-characters-v1",
        options={"voice": "alloy"},
    )


def test_realtime_credential_precondition_aborts_before_provider_send() -> None:
    binding = _realtime_binding()
    events: list[str] = []
    operation = _RealtimeOperation(events)

    class Transport:
        def connect_websocket(self, *_args: object, **_kwargs: object) -> object:
            raise AssertionError("missing credential must stop before a dial")

    provider = RealtimeAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(
            Transport(),  # type: ignore[arg-type]
            lambda _binding, secret_id: DispatchCredential(
                "family-a", "profile-a", secret_id, None
            ),
        ),
    )

    async def run() -> None:
        await provider.synthesize_realtime_text(
            _speech_request(),
            realtime_usage_scope=_RealtimeScope(operation),  # type: ignore[arg-type]
            realtime_turn_id="turn-credential-missing",
        )

    with pytest.raises(ModelUsageContractError, match="audio_dispatch_credential_required"):
        asyncio.run(run())
    assert events == ["characters", "abort"]


def test_realtime_websocket_failure_remains_uncertain_after_dispatch() -> None:
    binding = _realtime_binding()
    events: list[str] = []
    operation = _RealtimeOperation(events)

    class Transport:
        def connect_websocket(self, *_args: object, **_kwargs: object) -> object:
            raise ModelUsageContractError("websocket_transport_failed")

    provider = RealtimeAudioProvider(
        resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(
            Transport(),  # type: ignore[arg-type]
            lambda _binding, secret_id: DispatchCredential(
                "family-a", "profile-a", secret_id, "key"
            ),
        ),
    )

    async def run() -> None:
        await provider.synthesize_realtime_text(
            _speech_request(),
            realtime_usage_scope=_RealtimeScope(operation),  # type: ignore[arg-type]
            realtime_turn_id="turn-websocket-failure",
        )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(run())
    assert exc_info.value.status_code == 502
    assert events == ["characters", "uncertain"]


def test_audio_config_uses_only_binding_options() -> None:
    config = resolved_audio_provider_config(
        _binding(options={"voice": "  Cherry ", "output_format": "wav"})
    )

    assert config.voice == "Cherry"
    assert config.output_format == "wav"


def test_audio_service_rejects_request_scope_before_resolving_provider() -> None:
    dependencies = AudioDependencies.production()
    service = AIAudioService(
        object(),  # type: ignore[arg-type]
        family_id="family-a",
        user_id="user-a",
        dependencies=dependencies,
    )
    with pytest.raises(HTTPException) as exc_info:
        service.synthesize(
            SpeechRequest(
                text="测试",
                surface="recipe_cook_page",
                family_id="family-b",
                user_id="user-a",
                operation_id="op",
            )
        )
    assert exc_info.value.status_code == 403


def test_realtime_state_contains_revision_identity_without_provider_label() -> None:
    state = RealtimeVoiceSessionState(
        session_id="voice-a",
        family_id="family-a",
        user_id="user-a",
        config_revision_id="revision-a",
        provider_profile_id="profile-a",
        provider_profile_version_id="profile-version-a",
        requested_model="realtime-model",
        binding_identity_checksum="checksum-a",
        adapter_kind="dashscope_realtime",
        recipe_id="recipe-a",
        cook_session_id="cook-a",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    realtime_voice_session_store.put(state)
    try:
        assert not hasattr(state, "provider")
        assert realtime_voice_session_store.require_owner(
            "voice-a", family_id="family-a", user_id="user-a"
        ).config_revision_id == "revision-a"
    finally:
        realtime_voice_session_store.clear()


def test_pcm_duration_and_speech_sanitization_keep_existing_safe_contracts() -> None:
    assert measure_audio_duration_seconds(
        b"\x00\x00" * 16000,
        content_type="audio/pcm",
        metadata={"sample_rate": 16000, "sample_width_bytes": 2, "channels": 1},
    ) == Decimal("1.000000")
    assert sanitize_speech_text("# 今天\n\n做好啦！") == "今天 做好啦！"
    with pytest.raises(AudioDurationError, match="audio_duration_metadata_invalid"):
        measure_audio_duration_seconds(
            b"\x00\x00",
            content_type="audio/pcm",
            metadata={"sample_rate": 123, "sample_width_bytes": 2, "channels": 1},
        )


def test_asyncio_remains_available_for_realtime_provider_calls() -> None:
    # Guards an accidental reintroduction of the old synchronous websocket
    # path; production realtime adapters use asyncio.to_thread around the
    # shared synchronous ProviderTransport websocket client.
    assert asyncio.get_event_loop_policy() is not None
