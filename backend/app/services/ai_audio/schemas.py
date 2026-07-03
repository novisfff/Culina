from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal


AudioSurface = Literal["main_ai", "recipe_cook_page"]


@dataclass(frozen=True)
class TranscriptionRequest:
    audio_bytes: bytes
    filename: str
    content_type: str
    surface: AudioSurface
    language_hint: str | None = None
    family_id: str | None = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str | None
    duration_seconds: float | None
    provider: str
    model: str
    raw_metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    surface: AudioSurface
    voice: str | None = None
    family_id: str | None = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SpeechResult:
    content_type: str
    audio_bytes: bytes | None
    audio_stream: object | None
    external_url: str | None
    external_url_expires_at: datetime | None
    provider: str
    model: str


@dataclass(frozen=True)
class CookingRealtimeSessionRequest:
    provider: str
    family_id: str
    user_id: str
    recipe_id: str
    cook_session_id: str
    session_revision: int
    subject: dict


@dataclass(frozen=True)
class CookingRealtimeSession:
    provider: str
    mode: Literal["agent_backed_websocket"]
    session_id: str
    websocket_url: str
    expires_at: datetime
