from __future__ import annotations

from typing import Protocol

from fastapi import HTTPException, status

from app.core.config import Settings
from app.services.ai_audio.schemas import (
    CookingRealtimeSession,
    CookingRealtimeSessionRequest,
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
    TranscriptionResult,
)


DISABLED_PROVIDERS = {"", "disabled", "mock"}


class TranscriptionProvider(Protocol):
    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult: ...


class SpeechProvider(Protocol):
    def synthesize(self, request: SpeechRequest) -> SpeechResult: ...


class RealtimeVoiceProvider(Protocol):
    def create_cooking_session(self, request: CookingRealtimeSessionRequest) -> CookingRealtimeSession: ...


def normalize_provider(value: str | None) -> str:
    return (value or "").strip().lower()


def ensure_audio_enabled(settings: Settings) -> None:
    if not settings.ai_audio_enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI voice is not enabled")


def provider_unavailable(provider: str, capability: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"AI voice {capability} provider is not configured: {provider or 'disabled'}",
    )
