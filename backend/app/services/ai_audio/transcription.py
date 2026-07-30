from __future__ import annotations

import io
from collections.abc import Mapping
from decimal import Decimal

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.services.model_usage.decimal_math import quantize_quantity

ALLOWED_AUDIO_TYPES = {
    "audio/webm",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/pcm",
    "audio/x-pcm",
    "audio/l16",
}

PCM_SAMPLE_RATES = frozenset({8000, 16000, 24000, 48000})
PCM_SAMPLE_WIDTH_BYTES = frozenset({1, 2, 3, 4})
PCM_CHANNEL_COUNTS = frozenset({1, 2})


class AudioDurationError(ValueError):
    """A client-safe validation error before any audio provider dispatch."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


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


def measure_audio_duration_seconds(
    payload: bytes,
    *,
    content_type: str,
    metadata: Mapping[str, object],
    max_duration_seconds: Decimal | None = None,
) -> Decimal:
    """Return a server-probed, quantized duration without trusting client claims.

    Container inputs are decoded by PyAV.  Raw PCM has no trustworthy header,
    so it is accepted only with a constrained, validated server contract for
    sample rate, width and channels.
    """

    if not payload:
        raise AudioDurationError("audio_duration_invalid")
    normalized_type = content_type.split(";", 1)[0].strip().lower()
    if normalized_type not in ALLOWED_AUDIO_TYPES:
        raise AudioDurationError("audio_duration_invalid")
    if "pcm" in normalized_type or normalized_type == "audio/l16":
        duration = _pcm_duration_seconds(
            payload,
            metadata=metadata,
            content_type=normalized_type,
        )
    else:
        duration = _container_duration_seconds(payload)
    if duration <= 0:
        raise AudioDurationError("audio_duration_invalid")
    if max_duration_seconds is not None:
        if not isinstance(max_duration_seconds, Decimal) or max_duration_seconds <= 0:
            raise ValueError("max_duration_seconds must be a positive Decimal")
        if duration > quantize_quantity(max_duration_seconds):
            raise AudioDurationError("audio_duration_exceeded")
    return duration


def _pcm_duration_seconds(
    payload: bytes,
    *,
    metadata: Mapping[str, object],
    content_type: str,
) -> Decimal:
    sample_rate = _validated_pcm_metadata(metadata, "sample_rate", PCM_SAMPLE_RATES)
    sample_width = _validated_pcm_metadata(
        metadata,
        "sample_width_bytes",
        PCM_SAMPLE_WIDTH_BYTES,
    )
    channels = _validated_pcm_metadata(metadata, "channels", PCM_CHANNEL_COUNTS)
    if content_type == "audio/l16" and sample_width != 2:
        raise AudioDurationError("audio_duration_metadata_invalid")
    frame_bytes = sample_width * channels
    if len(payload) % frame_bytes != 0:
        raise AudioDurationError("audio_duration_invalid")
    frames = Decimal(len(payload) // frame_bytes)
    return quantize_quantity(frames / Decimal(sample_rate))


def _validated_pcm_metadata(
    metadata: Mapping[str, object],
    field: str,
    allowed: frozenset[int],
) -> int:
    value = metadata.get(field)
    if isinstance(value, bool):
        raise AudioDurationError("audio_duration_metadata_invalid")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise AudioDurationError("audio_duration_metadata_invalid") from exc
    if parsed not in allowed:
        raise AudioDurationError("audio_duration_metadata_invalid")
    return parsed


def _container_duration_seconds(payload: bytes) -> Decimal:
    try:
        import av
    except ImportError as exc:  # pragma: no cover - deployment dependency gate
        raise AudioDurationError("audio_duration_probe_unavailable") from exc
    try:
        with av.open(io.BytesIO(payload), mode="r") as container:
            duration = _duration_from_container(container, av_time_base=av.time_base)
    except AudioDurationError:
        raise
    except Exception as exc:
        # The PyAV exception hierarchy differs by supported container/codec;
        # this tightly-scoped external parser boundary is intentionally mapped
        # to one pre-dispatch validation result.
        raise AudioDurationError("audio_duration_invalid") from exc
    return quantize_quantity(duration)


def _duration_from_container(container: object, *, av_time_base: int) -> Decimal:
    duration = getattr(container, "duration", None)
    if isinstance(duration, int) and duration > 0:
        return Decimal(duration) / Decimal(av_time_base)
    durations: list[Decimal] = []
    streams = getattr(container, "streams", None)
    audio_streams = getattr(streams, "audio", ()) if streams is not None else ()
    for stream in audio_streams:
        stream_duration = getattr(stream, "duration", None)
        time_base = getattr(stream, "time_base", None)
        if stream_duration is None or time_base is None:
            continue
        try:
            value = Decimal(stream_duration) * Decimal(str(time_base))
        except Exception:
            continue
        if value > 0:
            durations.append(value)
    if not durations:
        raise AudioDurationError("audio_duration_invalid")
    return max(durations)
