from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


AudioSurface = Literal["main_ai", "recipe_cook_page"]
AudioProviderName = Literal["openai", "dashscope"]


class AudioTranscriptionResponse(BaseModel):
    text: str
    language: str | None = None
    provider: str
    model: str
    duration_seconds: float | None = None


class SpeechRequest(BaseModel):
    surface: AudioSurface
    text: str = Field(min_length=1, max_length=300)
    voice: str | None = None
    provider: AudioProviderName | None = None


class CookingAssistantVoiceStreamRequest(BaseModel):
    provider: AudioProviderName | None = None
    message: str = Field(min_length=1)
    client_message_id: str | None = None
    client_run_id: str | None = None
    subject: dict


class CookingRealtimeSessionRequest(BaseModel):
    provider: AudioProviderName | None = None
    recipe_id: str
    cook_session_id: str
    session_revision: int
    subject: dict


class CookingRealtimeSessionResponse(BaseModel):
    provider: str
    mode: Literal["agent_backed_websocket"] = "agent_backed_websocket"
    session_id: str
    websocket_url: str
    expires_at: str
