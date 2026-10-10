"""OpenAI Realtime GA wire protocol, separate from DashScope ASR/TTS."""

import base64
from collections.abc import Mapping
from typing import Any
from uuid import uuid4


def session_update_event(
    *, model: str, voice: str | None, transcription: bool, language: str | None = None,
) -> dict[str, Any]:
    audio_input: dict[str, Any] = {
        "format": {"type": "audio/pcm", "rate": 24000},
        "turn_detection": None,
    }
    if transcription:
        audio_input["transcription"] = {"model": "gpt-4o-mini-transcribe"}
        if language and language != "auto":
            audio_input["transcription"]["language"] = language
    return {
        "event_id": f"event_{uuid4().hex}",
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": model,
            "output_modalities": ["text" if transcription else "audio"],
            "audio": {
                "input": audio_input,
                "output": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "voice": voice or "alloy",
                },
            },
        },
    }


def speech_event(text: str) -> dict[str, Any]:
    # An explicit input prevents previous utterances from being read again.
    return {
        "event_id": f"event_{uuid4().hex}",
        "type": "response.create",
        "response": {
            "conversation": "none",
            "output_modalities": ["audio"],
            "instructions": "只逐字朗读用户提供的文本。不要回答、解释、补充或改写。",
            "input": [{
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": text}],
            }],
        },
    }


def audio_delta(event: dict[str, Any]) -> bytes | None:
    if event.get("type") != "response.output_audio.delta":
        return None
    value = event.get("delta")
    if not isinstance(value, str):
        raise ValueError("realtime_audio_invalid")
    payload = base64.b64decode(value, validate=True)
    if not payload or len(payload) % 2:
        raise ValueError("realtime_audio_invalid")
    return payload


def response_done(event: dict[str, Any]) -> bool:
    if event.get("type") != "response.done":
        return False
    response = event.get("response")
    if not isinstance(response, dict) or response.get("status") != "completed":
        raise ValueError("realtime_response_incomplete")
    return True


def pcm24k(payload: bytes, metadata: Mapping[str, object]) -> bytes:
    """Convert the browser's validated PCM16 input to GA's 24 kHz mono PCM."""
    from app.services.ai_audio.transcription import pcm16_mono
    return pcm16_mono(payload, metadata, target_rate=24000)
