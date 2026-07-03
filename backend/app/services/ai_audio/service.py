from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.utils import utcnow
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.providers import DISABLED_PROVIDERS, normalize_provider, provider_unavailable
from app.services.ai_audio.realtime import RealtimeVoiceSessionState, realtime_voice_session_store
from app.services.ai_audio.schemas import (
    CookingRealtimeSession,
    CookingRealtimeSessionRequest,
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
    TranscriptionResult,
)


class AIAudioService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def transcribe(self, request: TranscriptionRequest, provider: str | None = None) -> TranscriptionResult:
        selected = normalize_provider(provider or self.settings.ai_stt_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "transcription")
        if selected == "openai":
            return OpenAIAudioProvider(self.settings, capability="stt").transcribe(request)
        if selected == "dashscope":
            return DashScopeAudioProvider(self.settings, capability="stt").transcribe(request)
        raise provider_unavailable(selected, "transcription")

    def synthesize(self, request: SpeechRequest, provider: str | None = None) -> SpeechResult:
        selected = normalize_provider(provider or self.settings.ai_tts_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "speech")
        if selected == "openai":
            return OpenAIAudioProvider(self.settings, capability="tts").synthesize(request)
        if selected == "dashscope":
            return DashScopeAudioProvider(self.settings, capability="tts").synthesize(request)
        raise provider_unavailable(selected, "speech")

    def create_cooking_session(self, request: CookingRealtimeSessionRequest) -> CookingRealtimeSession:
        selected = normalize_provider(request.provider or self.settings.ai_realtime_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "realtime")
        if selected not in {"openai", "dashscope"}:
            raise provider_unavailable(selected, "realtime")
        if request.subject.get("source") != "recipe_cook_page":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cooking voice subject")
        created_at = utcnow()
        expires_at = created_at + timedelta(seconds=self.settings.ai_realtime_timeout_seconds)
        session_id = f"voice_session-{uuid4().hex}"
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id=session_id,
                family_id=request.family_id,
                user_id=request.user_id,
                provider=selected,
                recipe_id=request.recipe_id,
                cook_session_id=request.cook_session_id,
                session_revision=request.session_revision,
                subject=request.subject,
                created_at=created_at,
                expires_at=expires_at,
            )
        )
        return CookingRealtimeSession(
            provider=selected,
            mode="agent_backed_websocket",
            session_id=session_id,
            websocket_url=f"/api/ai/realtime/cooking/sessions/{session_id}/ws",
            expires_at=expires_at,
        )
