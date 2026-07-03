from __future__ import annotations

import httpx
from fastapi import HTTPException, status

from app.core.config import Settings
from app.services.ai_audio.providers import provider_unavailable
from app.services.ai_audio.schemas import SpeechRequest, SpeechResult, TranscriptionRequest, TranscriptionResult
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import normalize_transcript


class OpenAIAudioProvider:
    def __init__(self, settings: Settings, *, capability: str) -> None:
        self.settings = settings
        self.capability = capability

    @property
    def api_key(self) -> str:
        if self.capability == "stt":
            return self.settings.ai_stt_api_key.strip() or self.settings.ai_api_key.strip()
        if self.capability == "tts":
            return self.settings.ai_tts_api_key.strip() or self.settings.ai_api_key.strip()
        return self.settings.ai_api_key.strip()

    @property
    def api_base(self) -> str:
        if self.capability == "stt":
            return (self.settings.ai_stt_api_base.strip() or self.settings.ai_api_base).rstrip("/")
        if self.capability == "tts":
            return (self.settings.ai_tts_api_base.strip() or self.settings.ai_api_base).rstrip("/")
        return self.settings.ai_api_base.rstrip("/")

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.api_key:
            raise provider_unavailable("openai", "transcription")
        model = self.settings.ai_stt_model.strip() or "gpt-4o-mini-transcribe"
        files = {"file": (request.filename or "audio.webm", request.audio_bytes, request.content_type)}
        data: dict[str, str] = {"model": model}
        if request.language_hint and request.language_hint != "auto":
            data["language"] = request.language_hint
        try:
            with httpx.Client(timeout=self.settings.ai_stt_timeout_seconds) as client:
                response = client.post(
                    f"{self.api_base}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    data=data,
                    files=files,
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务返回错误") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务不可用") from exc
        payload = response.json()
        text = normalize_transcript(str(payload.get("text") or ""))
        if not text:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别结果为空")
        return TranscriptionResult(
            text=text,
            language=payload.get("language"),
            duration_seconds=payload.get("duration"),
            provider="openai",
            model=model,
            raw_metadata={},
        )

    def synthesize(self, request: SpeechRequest) -> SpeechResult:
        if not self.api_key:
            raise provider_unavailable("openai", "speech")
        model = self.settings.ai_tts_model.strip() or "gpt-4o-mini-tts"
        voice = request.voice or self.settings.ai_tts_voice.strip() or "alloy"
        audio_format = self.settings.ai_tts_format.strip() or "mp3"
        text = sanitize_speech_text(request.text)
        try:
            with httpx.Client(timeout=self.settings.ai_tts_timeout_seconds) as client:
                response = client.post(
                    f"{self.api_base}/audio/speech",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={"model": model, "voice": voice, "input": text, "response_format": audio_format},
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务返回错误") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务不可用") from exc
        return SpeechResult(
            content_type=_content_type_for_format(audio_format),
            audio_bytes=response.content,
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
            provider="openai",
            model=model,
        )


def _content_type_for_format(audio_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "mpeg": "audio/mpeg",
        "wav": "audio/wav",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "pcm": "audio/wav",
    }.get(audio_format.lower(), "application/octet-stream")
