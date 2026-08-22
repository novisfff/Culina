from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from types import SimpleNamespace

from pydantic import SecretStr
from sqlalchemy import select

from app.core.enums import ModelUsageCapability
from app.models.model_usage import ModelUsageEvent
from app.services.ai_audio.realtime import realtime_voice_session_store
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest,
    SpeechRequest,
    TranscriptionRequest,
)
from app.services.ai_audio.service import AIAudioService, AudioDependencies
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderResponse
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.subjects import ensure_user_subject

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


_OWNERS = {"family-a": "owner-a", "family-b": "owner-b"}


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    url: str
    headers: dict[str, str]
    json_body: object | None
    body: bytes | None


@dataclass
class RecordingAudioTransport:
    calls: list[RecordedRequest] = field(default_factory=list)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: object | None = None,
        body: bytes | None = None,
    ) -> ProviderResponse:
        self.calls.append(
            RecordedRequest(
                method=method,
                url=url,
                headers=dict(headers),
                json_body=json,
                body=body,
            )
        )
        if url.endswith("/audio/transcriptions"):
            return ProviderResponse(
                status_code=200,
                headers={"content-type": "application/json"},
                content='{"text":"家庭语音转写"}'.encode("utf-8"),
            )
        if url.endswith("/audio/speech"):
            return ProviderResponse(
                status_code=200,
                headers={"content-type": "audio/mpeg"},
                content=b"family-audio-bytes",
            )
        raise AssertionError(f"unexpected audio request: {url}")

    def connect_websocket(self, *_args: object, **_kwargs: object) -> object:
        raise AssertionError("session snapshot setup must not open a WebSocket")


def _create_audio_profiles(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    http_key: str,
    realtime_key: str,
) -> dict[str, object]:
    context.use_owner(family_id)
    http_profile = context.create_profile(
        display_name=f"{family_id} HTTP audio",
        api_base_url=f"https://{family_id}.audio.example/v1",
        api_key=http_key,
        idempotency_key=f"audio-http-profile-{family_id}",
    )
    realtime_profile = context.create_profile(
        display_name=f"{family_id} realtime audio",
        adapter_kind="openai_realtime",
        api_base_url=f"wss://{family_id}.realtime.example/v1",
        api_key=realtime_key,
        idempotency_key=f"audio-realtime-profile-{family_id}",
    )
    return {"http": http_profile, "realtime": realtime_profile}


def _audio_payload(
    profiles: dict[str, object],
    *,
    stt_model: str,
    tts_model: str,
    realtime_model: str,
) -> dict[str, object]:
    http_profile = profiles["http"]
    realtime_profile = profiles["realtime"]
    assert isinstance(http_profile, dict) and isinstance(realtime_profile, dict)
    return {
        "bindings": [
            {
                "capability": "stt",
                "variant_key": "default",
                "enabled": True,
                "provider_profile_id": http_profile["id"],
                "requested_model": stt_model,
                "language_hint": "zh",
            },
            {
                "capability": "tts",
                "variant_key": "default",
                "enabled": True,
                "provider_profile_id": http_profile["id"],
                "requested_model": tts_model,
                "voice": "alloy",
                "output_format": "mp3",
            },
            {
                "capability": "realtime_audio",
                "variant_key": "default",
                "enabled": True,
                "provider_profile_id": realtime_profile["id"],
                "requested_model": realtime_model,
                "voice": "alloy",
                "language_hint": "zh",
            },
        ],
        "price_rates": [
            {
                "capability": "stt",
                "variant_key": "default",
                "meter": "audio_input_seconds",
                "unit_quantity": "1",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            },
            {
                "capability": "tts",
                "variant_key": "default",
                "meter": "tts_characters",
                "unit_quantity": "1",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            },
            *[
                {
                    "capability": "realtime_audio",
                    "variant_key": "default",
                    "meter": meter,
                    "unit_quantity": "1",
                    "unit_price": "0.01",
                    "source_currency": "CNY",
                    "fx_to_cny": "1",
                }
                for meter in ("audio_input_seconds", "tts_characters")
            ],
        ],
        "change_note": "家庭语音运行时测试",
    }


def _save_active_audio_configuration(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    stt_model: str,
    tts_model: str,
    realtime_model: str,
    profiles: dict[str, object] | None = None,
) -> dict[str, object]:
    context.use_owner(family_id)
    active_profiles = profiles or _create_audio_profiles(
        context,
        family_id=family_id,
        http_key=f"key-{family_id}-http",
        realtime_key=f"key-{family_id}-realtime",
    )
    draft_state = context.client.get("/api/family/model-settings/draft")
    assert draft_state.status_code == 200, draft_state.text
    draft_version = int(draft_state.json()["draft_version_number"])
    revision_hint = draft_state.json().get("base_config_revision_id")
    draft_key = f"audio-draft-{family_id}-{stt_model}-{tts_model}-{realtime_model}"
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_audio_payload(
            active_profiles,
            stt_model=stt_model,
            tts_model=tts_model,
            realtime_model=realtime_model,
        )
        | {
            "base_config_revision_id": revision_hint,
            "base_draft_version_number": draft_version,
            "idempotency_key": draft_key,
        },
    )
    assert saved.status_code == 200, saved.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    active = settings.json()
    assert active["active_config_revision_id"] is not None
    assert active["active_price_version_id"] is not None
    return {
        "profiles": active_profiles,
        "active": {
            "config_revision_id": active["active_config_revision_id"],
            "price_version_id": active["active_price_version_id"],
        },
    }


def _enable_usage_defaults(context: FamilyModelApiContext, *, family_id: str) -> None:
    with context.session_factory() as db:
        subject = ensure_user_subject(
            db,
            family_id=family_id,
            user_id=_OWNERS[family_id],
        )
        ensure_family_model_usage_defaults(
            db,
            family_id=family_id,
            creator_subject_id=subject.id,
        )
        db.commit()


def _audio_dependencies(
    context: FamilyModelApiContext,
    transport: RecordingAudioTransport,
) -> AudioDependencies:
    settings = SimpleNamespace(
        family_model_audio_upload_max_bytes=10 * 1024 * 1024,
        family_model_stt_max_duration_seconds=60,
        family_model_tts_max_characters=300,
        family_model_realtime_session_max_seconds=300,
        model_usage_receipt_integrity_active_key_id="audio-runtime-test",
        model_usage_receipt_integrity_keys_json=SecretStr(
            json.dumps({"audio-runtime-test": {"key": "audio-runtime-test-secret"}})
        ),
    )
    return AudioDependencies(
        resolver_factory=lambda db: FamilyModelConfigurationResolver(
            db,
            network_policy=context.policy,
            cipher=context.cipher,
        ),
        transport_factory=lambda _resolver: transport,  # type: ignore[arg-type]
        session_factory=context.session_factory,
        settings_factory=lambda: settings,
    )


def _speech_request(family_id: str, *, operation_id: str, text: str) -> SpeechRequest:
    return SpeechRequest(
        text=text,
        surface="recipe_cook_page",
        family_id=family_id,
        user_id=_OWNERS[family_id],
        operation_id=operation_id,
    )


def _transcription_request(family_id: str, *, operation_id: str) -> TranscriptionRequest:
    return TranscriptionRequest(
        audio_bytes=b"\x00\x00" * 16000,
        filename="voice.pcm",
        content_type="audio/pcm",
        surface="main_ai",
        family_id=family_id,
        user_id=_OWNERS[family_id],
        operation_id=operation_id,
        metadata={"sample_rate": 16000, "sample_width_bytes": 2, "channels": 1},
    )


def _realtime_request(family_id: str) -> CookingRealtimeSessionRequest:
    return CookingRealtimeSessionRequest(
        family_id=family_id,
        user_id=_OWNERS[family_id],
        recipe_id=f"recipe-{family_id}",
        cook_session_id=f"cook-{family_id}",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
    )


def _request_model(call: RecordedRequest) -> str:
    if isinstance(call.json_body, dict):
        model = call.json_body.get("model")
        assert isinstance(model, str)
        return model
    assert call.body is not None
    match = re.search(rb'name="model"\r\n\r\n([^\r\n]+)', call.body)
    assert match is not None
    return match.group(1).decode("utf-8")


def _run_audio_calls(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    dependencies: AudioDependencies,
) -> None:
    with context.session_factory() as db:
        service = AIAudioService(
            db,
            family_id=family_id,
            user_id=_OWNERS[family_id],
            dependencies=dependencies,
        )
        transcription = service.transcribe(
            _transcription_request(family_id, operation_id=f"{family_id}-stt")
        )
        speech = service.synthesize(
            _speech_request(
                family_id,
                operation_id=f"{family_id}-tts",
                text=f"{family_id} 的语音播报",
            )
        )
    assert transcription.text == "家庭语音转写"
    assert speech.audio_bytes == b"family-audio-bytes"


def test_stt_and_tts_dispatch_with_each_family_binding_and_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    family_a = _save_active_audio_configuration(
        family_model_api,
        family_id="family-a",
        stt_model="stt-a",
        tts_model="tts-a",
        realtime_model="realtime-a",
    )
    family_b = _save_active_audio_configuration(
        family_model_api,
        family_id="family-b",
        stt_model="stt-b",
        tts_model="tts-b",
        realtime_model="realtime-b",
    )
    _enable_usage_defaults(family_model_api, family_id="family-a")
    _enable_usage_defaults(family_model_api, family_id="family-b")
    transport = RecordingAudioTransport()
    dependencies = _audio_dependencies(family_model_api, transport)

    _run_audio_calls(
        family_model_api,
        family_id="family-a",
        dependencies=dependencies,
    )
    _run_audio_calls(
        family_model_api,
        family_id="family-b",
        dependencies=dependencies,
    )

    assert [(call.headers["Authorization"], _request_model(call)) for call in transport.calls] == [
        ("Bearer key-family-a-http", "stt-a"),
        ("Bearer key-family-a-http", "tts-a"),
        ("Bearer key-family-b-http", "stt-b"),
        ("Bearer key-family-b-http", "tts-b"),
    ]
    with family_model_api.session_factory() as db:
        events = tuple(
            db.scalars(
                select(ModelUsageEvent).where(
                    ModelUsageEvent.capability.in_(
                        (ModelUsageCapability.STT, ModelUsageCapability.TTS)
                    )
                )
            )
        )
    assert {
        (event.family_id, event.requested_model, event.config_revision_id, event.price_version_id)
        for event in events
    } == {
        (
            "family-a",
            "stt-a",
            family_a["active"]["config_revision_id"],
            family_a["active"]["price_version_id"],
        ),
        (
            "family-a",
            "tts-a",
            family_a["active"]["config_revision_id"],
            family_a["active"]["price_version_id"],
        ),
        (
            "family-b",
            "stt-b",
            family_b["active"]["config_revision_id"],
            family_b["active"]["price_version_id"],
        ),
        (
            "family-b",
            "tts-b",
            family_b["active"]["config_revision_id"],
            family_b["active"]["price_version_id"],
        ),
    }


def test_new_audio_dispatch_uses_rotated_current_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    configured = _save_active_audio_configuration(
        family_model_api,
        family_id="family-a",
        stt_model="stt-rotation",
        tts_model="tts-rotation",
        realtime_model="realtime-rotation",
    )
    _enable_usage_defaults(family_model_api, family_id="family-a")
    transport = RecordingAudioTransport()
    dependencies = _audio_dependencies(family_model_api, transport)

    with family_model_api.session_factory() as db:
        service = AIAudioService(
            db,
            family_id="family-a",
            user_id="owner-a",
            dependencies=dependencies,
        )
        service.synthesize(
            _speech_request(
                "family-a",
                operation_id="rotation-tts-before",
                text="轮换前的语音",
            )
        )

    family_model_api.use_owner("family-a")
    settings = family_model_api.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    profiles = configured["profiles"]
    assert isinstance(profiles, dict) and isinstance(profiles["http"], dict)
    rotated = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profiles['http']['id']}/rotate-key",
        json={
            "new_api_key": "key-family-a-http-rotated",
            "base_settings_version_number": settings.json()["version_number"],
            "idempotency_key": "audio-runtime-rotate-key-1",
        },
    )
    assert rotated.status_code == 200, rotated.text

    with family_model_api.session_factory() as db:
        service = AIAudioService(
            db,
            family_id="family-a",
            user_id="owner-a",
            dependencies=dependencies,
        )
        service.synthesize(
            _speech_request(
                "family-a",
                operation_id="rotation-tts-after",
                text="轮换后的语音",
            )
        )

    assert [call.headers["Authorization"] for call in transport.calls] == [
        "Bearer key-family-a-http",
        "Bearer key-family-a-http-rotated",
    ]
    assert [_request_model(call) for call in transport.calls] == [
        "tts-rotation",
        "tts-rotation",
    ]


def test_realtime_sessions_keep_their_creation_revision_after_a_new_publish(
    family_model_api: FamilyModelApiContext,
) -> None:
    realtime_voice_session_store.clear()
    try:
        configured = _save_active_audio_configuration(
            family_model_api,
            family_id="family-a",
            stt_model="stt-session-old",
            tts_model="tts-session-old",
            realtime_model="realtime-session-old",
        )
        transport = RecordingAudioTransport()
        dependencies = _audio_dependencies(family_model_api, transport)
        with family_model_api.session_factory() as db:
            service = AIAudioService(
                db,
                family_id="family-a",
                user_id="owner-a",
                dependencies=dependencies,
            )
            old_session = service.create_cooking_session(_realtime_request("family-a"))
        old_state = realtime_voice_session_store.require_owner(
            old_session.session_id,
            family_id="family-a",
            user_id="owner-a",
        )

        updated = _save_active_audio_configuration(
            family_model_api,
            family_id="family-a",
            stt_model="stt-session-new",
            tts_model="tts-session-new",
            realtime_model="realtime-session-new",
            profiles=configured["profiles"],
        )
        with family_model_api.session_factory() as db:
            service = AIAudioService(
                db,
                family_id="family-a",
                user_id="owner-a",
                dependencies=dependencies,
            )
            new_session = service.create_cooking_session(_realtime_request("family-a"))
            old_provider = service.realtime_runtime_for_session(old_state)
            new_state = realtime_voice_session_store.require_owner(
                new_session.session_id,
                family_id="family-a",
                user_id="owner-a",
            )
            new_provider = service.realtime_runtime_for_session(new_state)

        assert old_state.config_revision_id == configured["active"]["config_revision_id"]
        assert new_state.config_revision_id == updated["active"]["config_revision_id"]
        assert old_state.config_revision_id != new_state.config_revision_id
        assert old_provider.binding.requested_model == "realtime-session-old"
        assert new_provider.binding.requested_model == "realtime-session-new"
    finally:
        realtime_voice_session_store.clear()
