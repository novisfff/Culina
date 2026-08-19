from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


AudioSurface = Literal["main_ai", "recipe_cook_page"]
class AudioTranscriptionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    language: str | None = None
    duration_seconds: float | None = None


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    surface: AudioSurface
    text: str = Field(min_length=1, max_length=300)
    voice: str | None = None


class CookingAssistantVoiceStreamRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1)
    client_message_id: str | None = None
    client_run_id: str | None = None
    subject: dict


class CookingRealtimeSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recipe_id: str
    cook_session_id: str
    session_revision: int
    subject: dict


class CookingRealtimeSessionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["agent_backed_websocket"] = "agent_backed_websocket"
    session_id: str
    websocket_url: str
    expires_at: str
