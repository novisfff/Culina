from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.ai_audio import _reject_audio_provider_overrides, get_ai_audio_service
from app.schemas.ai_audio import (
    AudioTranscriptionResponse,
    CookingAssistantVoiceStreamRequest,
    CookingRealtimeSessionRequest,
    CookingRealtimeSessionResponse,
    SpeechRequest,
)


def test_audio_requests_forbid_provider_model_and_endpoint_overrides() -> None:
    with pytest.raises(ValidationError):
        SpeechRequest.model_validate(
            {
                "surface": "recipe_cook_page",
                "text": "测试",
                "provider": "other-provider",
            }
        )
    with pytest.raises(ValidationError):
        CookingRealtimeSessionRequest.model_validate(
            {
                "recipe_id": "recipe-1",
                "cook_session_id": "cook-1",
                "session_revision": 1,
                "subject": {},
                "model": "override",
                "api_base": "http://127.0.0.1",
            }
        )
    with pytest.raises(ValidationError):
        CookingAssistantVoiceStreamRequest.model_validate(
            {"message": "继续", "subject": {}, "endpoint": "https://other.example"}
        )


def test_member_audio_response_contract_has_no_provider_or_model() -> None:
    transcription = AudioTranscriptionResponse(
        text="番茄炒蛋",
        language="zh",
        duration_seconds=1.25,
    )
    realtime = CookingRealtimeSessionResponse(
        session_id="voice-session-1",
        websocket_url="/api/ai/realtime/cooking/sessions/voice-session-1/ws",
        websocket_ticket="short-lived-ticket",
        websocket_ticket_expires_at="2026-08-17T23:55:45+00:00",
        expires_at="2026-08-18T00:00:00+00:00",
    )
    forbidden = {"provider", "model", "base_url", "profile_id", "credential"}
    assert forbidden.isdisjoint(transcription.model_dump())
    assert forbidden.isdisjoint(realtime.model_dump())
    assert "?" not in realtime.websocket_url


def test_form_provider_override_is_rejected_before_audio_read() -> None:
    with pytest.raises(Exception) as exc_info:
        _reject_audio_provider_overrides({"surface": "main_ai", "provider": "openai"})
    assert getattr(exc_info.value, "status_code", None) == 422


def test_audio_dependency_uses_trusted_membership_scope() -> None:
    service = get_ai_audio_service(
        db=object(),  # type: ignore[arg-type]
        auth=(SimpleNamespace(id="user-a"), SimpleNamespace(family_id="family-a")),
    )
    assert service.family_id == "family-a"
    assert service.user_id == "user-a"
