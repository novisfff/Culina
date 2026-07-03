from __future__ import annotations

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings

ALLOWED_AUDIO_TYPES = {
    "audio/webm",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
}


async def read_audio_upload(file: UploadFile, settings: Settings) -> tuple[bytes, str]:
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="不支持的音频格式")

    max_bytes = settings.ai_stt_max_upload_bytes
    payload = await file.read(max_bytes + 1)
    if not payload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="音频文件为空")
    if len(payload) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="音频文件过大")
    return payload, content_type


def normalize_transcript(text: str) -> str:
    return " ".join((text or "").strip().split())
