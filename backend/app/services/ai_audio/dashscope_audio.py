from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import uuid4

import httpx
from fastapi import HTTPException, status

from app.core.config import Settings
from app.services.ai_audio.config import dashscope_api_key, dashscope_http_base, dashscope_realtime_url, join_api_url
from app.services.ai_audio.providers import provider_unavailable
from app.services.ai_audio.schemas import SpeechRequest, SpeechResult, TranscriptionRequest, TranscriptionResult
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import normalize_transcript


class DashScopeAudioProvider:
    def __init__(self, settings: Settings, *, capability: str) -> None:
        self.settings = settings
        self.capability = capability

    @property
    def api_key(self) -> str:
        if self.capability == "stt":
            return dashscope_api_key(self.settings, self.settings.ai_stt_api_key)
        if self.capability == "tts":
            return dashscope_api_key(self.settings, self.settings.ai_tts_api_key)
        return dashscope_api_key(self.settings)

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.api_key:
            raise provider_unavailable("dashscope", "transcription")
        model = self.settings.ai_stt_model.strip() or "fun-asr-flash-2026-06-15"
        url = join_api_url(dashscope_http_base(self.settings), "/services/aigc/multimodal-generation/generation")
        audio_b64 = base64.b64encode(request.audio_bytes).decode("ascii")
        payload = _dashscope_stt_payload(
            model=model,
            audio_data_url=f"data:{request.content_type};base64,{audio_b64}",
            content_type=request.content_type,
            sample_rate=self.settings.ai_stt_sample_rate,
        )
        if request.language_hint and request.language_hint != "auto":
            payload["parameters"]["language"] = request.language_hint
        try:
            with httpx.Client(timeout=self.settings.ai_stt_timeout_seconds) as client:
                response = client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                        "X-DashScope-SSE": "disable",
                    },
                    json=payload,
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务返回错误") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务不可用") from exc
        body = response.json()
        text = _extract_dashscope_text(body)
        if not text:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别结果为空")
        return TranscriptionResult(
            text=text,
            language=request.language_hint,
            duration_seconds=None,
            provider="dashscope",
            model=model,
            raw_metadata={"request_id": body.get("request_id")},
        )

    def synthesize(self, request: SpeechRequest) -> SpeechResult:
        if not self.api_key:
            raise provider_unavailable("dashscope", "speech")
        model = self.settings.ai_tts_model.strip() or "qwen3-tts-flash"
        voice = request.voice or self.settings.ai_tts_voice.strip() or "Cherry"
        text = sanitize_speech_text(request.text)
        url = join_api_url(dashscope_http_base(self.settings), "/services/aigc/multimodal-generation/generation")
        payload = {
            "model": model,
            "input": {
                "text": text,
                "voice": voice,
                "language_type": self.settings.ai_tts_language_type,
            },
            "parameters": {
                "format": self.settings.ai_tts_format,
                "sample_rate": self.settings.ai_tts_sample_rate,
            },
        }
        try:
            with httpx.Client(timeout=self.settings.ai_tts_timeout_seconds) as client:
                response = client.post(
                    url,
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务返回错误") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务不可用") from exc
        body = response.json()
        audio_bytes = _extract_dashscope_audio_bytes(body)
        if audio_bytes is None:
            audio_url = _extract_dashscope_audio_url(body)
            if not audio_url:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成结果为空")
            audio_bytes = _download_provider_audio(audio_url, timeout=self.settings.ai_tts_timeout_seconds)
        return SpeechResult(
            content_type=_content_type_for_format(self.settings.ai_tts_format),
            audio_bytes=audio_bytes,
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
            provider="dashscope",
            model=model,
        )

    async def transcribe_realtime_audio(
        self,
        request: TranscriptionRequest,
        *,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
    ) -> TranscriptionResult:
        if not self.api_key:
            raise provider_unavailable("dashscope", "realtime transcription")
        if "pcm" not in request.content_type.lower():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="DashScope realtime ASR requires PCM audio")
        model = self.settings.ai_realtime_model.strip() or self.settings.ai_stt_model.strip() or "qwen3-asr-flash-realtime"
        transcript = await _qwen_asr_realtime_transcribe(
            url=dashscope_realtime_url(self.settings, model),
            api_key=self.api_key,
            audio_bytes=request.audio_bytes,
            sample_rate=_metadata_sample_rate(request.metadata, self.settings.ai_realtime_input_sample_rate),
            language=request.language_hint,
            timeout_seconds=self.settings.ai_realtime_timeout_seconds,
            on_delta=on_delta,
        )
        text = normalize_transcript(transcript)
        if not text:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="实时语音识别结果为空")
        return TranscriptionResult(
            text=text,
            language=request.language_hint,
            duration_seconds=None,
            provider="dashscope",
            model=model,
            raw_metadata={"mode": "qwen_asr_realtime"},
        )

    async def synthesize_realtime_text(self, request: SpeechRequest) -> SpeechResult:
        if not self.api_key:
            raise provider_unavailable("dashscope", "realtime speech")
        configured_model = self.settings.ai_tts_model.strip()
        model = configured_model if "realtime" in configured_model else "qwen3-tts-flash-realtime"
        voice = request.voice or self.settings.ai_realtime_voice.strip() or self.settings.ai_tts_voice.strip() or "Cherry"
        audio_format = self.settings.ai_tts_format.strip() or "mp3"
        audio_bytes = await _qwen_tts_realtime_synthesize(
            url=dashscope_realtime_url(self.settings, model),
            api_key=self.api_key,
            text=sanitize_speech_text(request.text),
            voice=voice,
            audio_format=audio_format,
            sample_rate=self.settings.ai_realtime_output_sample_rate,
            language_type=self.settings.ai_tts_language_type,
            timeout_seconds=self.settings.ai_realtime_timeout_seconds,
        )
        if audio_format.lower() == "pcm":
            audio_bytes = _pcm16_to_wav(audio_bytes, sample_rate=self.settings.ai_realtime_output_sample_rate)
        if not audio_bytes:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="实时语音合成结果为空")
        return SpeechResult(
            content_type=_content_type_for_format(audio_format),
            audio_bytes=audio_bytes,
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
            provider="dashscope",
            model=model,
        )

    async def stream_realtime_text(
        self,
        text_chunks: AsyncIterator[str],
        request: SpeechRequest,
    ) -> AsyncIterator[dict]:
        if not self.api_key:
            raise provider_unavailable("dashscope", "realtime speech")
        configured_model = self.settings.ai_tts_model.strip()
        model = configured_model if "realtime" in configured_model else "qwen3-tts-flash-realtime"
        voice = request.voice or self.settings.ai_realtime_voice.strip() or self.settings.ai_tts_voice.strip() or "Cherry"
        audio_format = "pcm"
        sample_rate = self.settings.ai_realtime_output_sample_rate
        yield {
            "type": "audio_start",
            "content_type": "audio/pcm",
            "format": "pcm16",
            "sample_rate": sample_rate,
            "channels": 1,
            "provider": "dashscope",
            "model": model,
        }
        sequence = 0
        trace_started_at = request.metadata.get("trace_started_at") if isinstance(request.metadata, dict) else None
        async for event in _qwen_tts_realtime_stream(
            url=dashscope_realtime_url(self.settings, model),
            api_key=self.api_key,
            text_chunks=text_chunks,
            voice=voice,
            audio_format=audio_format,
            sample_rate=sample_rate,
            language_type=self.settings.ai_tts_language_type,
            timeout_seconds=self.settings.ai_realtime_timeout_seconds,
            trace_started_at=trace_started_at if isinstance(trace_started_at, (int, float)) else None,
        ):
            if event["type"] == "audio_trace":
                yield event
                continue
            chunk = event["audio"]
            sequence += 1
            yield {
                "type": "audio_delta",
                "audio": base64.b64encode(chunk).decode("ascii"),
                "sequence": sequence,
            }
        yield {"type": "audio_done", "sequence": sequence}


def _dashscope_format(content_type: str) -> str:
    if "wav" in content_type:
        return "wav"
    if "mpeg" in content_type or "mp3" in content_type:
        return "mp3"
    if "mp4" in content_type or "m4a" in content_type:
        return "mp4"
    return "wav"


def _dashscope_stt_payload(*, model: str, audio_data_url: str, content_type: str, sample_rate: int) -> dict:
    if model.startswith("qwen3-asr-flash"):
        return {
            "model": model,
            "input": {
                "messages": [
                    {"role": "system", "content": [{"text": ""}]},
                    {"role": "user", "content": [{"audio": audio_data_url}]},
                ]
            },
            "parameters": {
                "asr_options": {"enable_itn": False},
                "format": _dashscope_format(content_type),
                "sample_rate": str(sample_rate),
            },
        }
    return {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": audio_data_url},
                        }
                    ],
                }
            ]
        },
        "parameters": {
            "format": _dashscope_format(content_type),
            "sample_rate": str(sample_rate),
        },
    }


def _extract_dashscope_text(body: dict) -> str:
    candidates = [
        body.get("output", {}).get("text"),
        body.get("output", {}).get("transcription"),
        body.get("output", {}).get("choices", [{}])[0].get("message", {}).get("content"),
    ]
    for value in candidates:
        if isinstance(value, str) and normalize_transcript(value):
            return normalize_transcript(value)
        if isinstance(value, list):
            joined = " ".join(str(item.get("text") or item) for item in value)
            if normalize_transcript(joined):
                return normalize_transcript(joined)
    return ""


def _extract_dashscope_audio_bytes(body: dict) -> bytes | None:
    audio = body.get("output", {}).get("audio")
    if isinstance(audio, dict):
        data = audio.get("data")
        if isinstance(data, str) and data:
            return base64.b64decode(data)
    data = body.get("output", {}).get("data")
    if isinstance(data, str) and data:
        return base64.b64decode(data)
    return None


def _extract_dashscope_audio_url(body: dict) -> str:
    audio = body.get("output", {}).get("audio")
    if isinstance(audio, dict) and isinstance(audio.get("url"), str):
        return audio["url"]
    if isinstance(body.get("output", {}).get("url"), str):
        return body["output"]["url"]
    return ""


def _download_provider_audio(url: str, timeout: float) -> bytes:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.content
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成音频下载失败") from exc


def _content_type_for_format(audio_format: str) -> str:
    return {"mp3": "audio/mpeg", "wav": "audio/wav", "pcm": "audio/wav"}.get(audio_format.lower(), "audio/mpeg")


def _metadata_sample_rate(metadata: dict, fallback: int) -> int:
    value = metadata.get("sample_rate") if isinstance(metadata, dict) else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _extract_qwen_asr_completed_text(event: dict) -> str:
    if event.get("type") != "conversation.item.input_audio_transcription.completed":
        return ""
    value = event.get("transcript")
    return normalize_transcript(value) if isinstance(value, str) else ""


def _extract_qwen_asr_delta_text(event: dict) -> str:
    if event.get("type") != "conversation.item.input_audio_transcription.text":
        return ""
    for key in ("text", "delta", "transcript"):
        value = event.get(key)
        if isinstance(value, str) and normalize_transcript(value):
            return normalize_transcript(value)
    return ""


async def _qwen_asr_realtime_transcribe(
    *,
    url: str,
    api_key: str,
    audio_bytes: bytes,
    sample_rate: int,
    language: str | None,
    timeout_seconds: float,
    on_delta: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    import websockets

    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Beta": "realtime=v1",
    }
    async with websockets.connect(url, additional_headers=headers, open_timeout=timeout_seconds) as websocket:
        session: dict = {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": sample_rate,
            "turn_detection": None,
        }
        if language and language != "auto":
            session["input_audio_transcription"] = {"language": language}
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "session.update", "session": session}))
        for offset in range(0, len(audio_bytes), 3200):
            chunk = audio_bytes[offset: offset + 3200]
            await websocket.send(json.dumps({
                "event_id": f"event_{uuid4().hex}",
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }))
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "input_audio_buffer.commit"}))
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "session.finish"}))
        while True:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=timeout_seconds)
            except TimeoutError as exc:
                raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="实时语音识别服务超时") from exc
            if isinstance(message, bytes):
                continue
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue
            delta = _extract_qwen_asr_delta_text(event)
            if delta and on_delta is not None:
                await on_delta(delta)
            text = _extract_qwen_asr_completed_text(event)
            if text:
                return text
            if event.get("type") == "session.finished":
                break
            if event.get("type") == "error":
                error = event.get("error") if isinstance(event.get("error"), dict) else {}
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error.get("message") or "实时语音识别服务返回错误"))
    return ""


async def _qwen_tts_realtime_synthesize(
    *,
    url: str,
    api_key: str,
    text: str,
    voice: str,
    audio_format: str,
    sample_rate: int,
    language_type: str,
    timeout_seconds: float,
) -> bytes:
    import websockets

    headers = {"Authorization": f"Bearer {api_key}"}
    chunks: list[bytes] = []
    async with websockets.connect(url, additional_headers=headers, open_timeout=timeout_seconds) as websocket:
        await websocket.send(json.dumps({
            "event_id": f"event_{uuid4().hex}",
            "type": "session.update",
            "session": {
                "mode": "commit",
                "voice": voice,
                "language_type": language_type,
                "response_format": audio_format,
                "sample_rate": sample_rate,
            },
        }))
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "input_text_buffer.append", "text": text}))
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "input_text_buffer.commit"}))
        await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "session.finish"}))
        while True:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=timeout_seconds)
            except TimeoutError as exc:
                raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="实时语音合成服务超时") from exc
            if isinstance(message, bytes):
                chunks.append(message)
                continue
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "response.audio.delta" and isinstance(event.get("delta"), str):
                chunks.append(base64.b64decode(event["delta"]))
                continue
            if event.get("type") == "session.finished":
                break
            if event.get("type") == "error":
                error = event.get("error") if isinstance(event.get("error"), dict) else {}
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error.get("message") or "实时语音合成服务返回错误"))
    return b"".join(chunks)


async def _qwen_tts_realtime_stream(
    *,
    url: str,
    api_key: str,
    text_chunks: AsyncIterator[str],
    voice: str,
    audio_format: str,
    sample_rate: int,
    language_type: str,
    timeout_seconds: float,
    trace_started_at: float | None = None,
) -> AsyncIterator[dict[str, Any]]:
    import websockets

    headers = {"Authorization": f"Bearer {api_key}"}
    stream_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    error_queue: asyncio.Queue[HTTPException] = asyncio.Queue()
    trace_started_at = trace_started_at or time.perf_counter()
    audio_condition = asyncio.Condition()
    audio_delta_count = 0
    first_audio_delta_sent = False
    segment_commit_timeout_seconds = 0.45

    def elapsed_ms() -> int:
        return int((time.perf_counter() - trace_started_at) * 1000)

    async with websockets.connect(url, additional_headers=headers, open_timeout=timeout_seconds) as websocket:
        await websocket.send(json.dumps({
            "event_id": f"event_{uuid4().hex}",
            "type": "session.update",
            "session": {
                "mode": "commit",
                "voice": voice,
                "language_type": language_type,
                "response_format": audio_format,
                "sample_rate": sample_rate,
            },
        }))

        async def receive_audio() -> None:
            nonlocal audio_delta_count, first_audio_delta_sent
            while True:
                try:
                    message = await asyncio.wait_for(websocket.recv(), timeout=timeout_seconds)
                except TimeoutError:
                    await error_queue.put(HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="实时语音合成服务超时"))
                    await stream_queue.put(None)
                    return
                if isinstance(message, bytes):
                    async with audio_condition:
                        audio_delta_count += 1
                        audio_condition.notify_all()
                    if not first_audio_delta_sent:
                        first_audio_delta_sent = True
                        await stream_queue.put({"type": "audio_trace", "stage": "provider_first_audio_delta", "elapsed_ms": elapsed_ms()})
                    await stream_queue.put({"type": "audio_delta", "audio": message})
                    continue
                try:
                    event = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "response.audio.delta" and isinstance(event.get("delta"), str):
                    async with audio_condition:
                        audio_delta_count += 1
                        audio_condition.notify_all()
                    if not first_audio_delta_sent:
                        first_audio_delta_sent = True
                        await stream_queue.put({"type": "audio_trace", "stage": "provider_first_audio_delta", "elapsed_ms": elapsed_ms()})
                    await stream_queue.put({"type": "audio_delta", "audio": base64.b64decode(event["delta"])})
                    continue
                if event.get("type") == "session.finished":
                    await stream_queue.put(None)
                    return
                if event.get("type") == "error":
                    error = event.get("error") if isinstance(event.get("error"), dict) else {}
                    await error_queue.put(
                        HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail=str(error.get("message") or "实时语音合成服务返回错误"),
                        )
                    )
                    await stream_queue.put(None)
                    return

        async def send_text() -> None:
            try:
                segment_sequence = 0
                async for text in text_chunks:
                    try:
                        sanitized = sanitize_speech_text(text, max_chars=1000)
                    except HTTPException:
                        continue
                    if not sanitized:
                        continue
                    async with audio_condition:
                        previous_audio_delta_count = audio_delta_count
                    segment_sequence += 1
                    await websocket.send(json.dumps({
                        "event_id": f"event_{uuid4().hex}",
                        "type": "input_text_buffer.append",
                        "text": sanitized,
                    }))
                    await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "input_text_buffer.commit"}))
                    await stream_queue.put({
                        "type": "audio_trace",
                        "stage": "tts_segment_commit",
                        "elapsed_ms": elapsed_ms(),
                        "segment_sequence": segment_sequence,
                        "chars": len(sanitized),
                    })
                    try:
                        async with audio_condition:
                            await asyncio.wait_for(
                                audio_condition.wait_for(lambda: audio_delta_count > previous_audio_delta_count),
                                timeout=segment_commit_timeout_seconds,
                            )
                    except TimeoutError:
                        pass
                await websocket.send(json.dumps({"event_id": f"event_{uuid4().hex}", "type": "session.finish"}))
            except asyncio.CancelledError:
                raise
            except HTTPException as exc:
                await error_queue.put(exc)
                await stream_queue.put(None)
            except Exception:
                await error_queue.put(
                    HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="实时语音合成服务发送失败")
                )
                await stream_queue.put(None)

        receiver = asyncio.create_task(receive_audio())
        sender = asyncio.create_task(send_text())
        try:
            while True:
                event = await stream_queue.get()
                if event is None:
                    break
                yield event
            if not error_queue.empty():
                raise await error_queue.get()
        finally:
            for task in (sender, receiver):
                if not task.done():
                    task.cancel()
            for task in (sender, receiver):
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass


def _pcm16_to_wav(pcm: bytes, *, sample_rate: int, channels: int = 1) -> bytes:
    byte_rate = sample_rate * channels * 2
    block_align = channels * 2
    data_size = len(pcm)
    header = (
        b"RIFF"
        + (36 + data_size).to_bytes(4, "little")
        + b"WAVEfmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + channels.to_bytes(2, "little")
        + sample_rate.to_bytes(4, "little")
        + byte_rate.to_bytes(4, "little")
        + block_align.to_bytes(2, "little")
        + (16).to_bytes(2, "little")
        + b"data"
        + data_size.to_bytes(4, "little")
    )
    return header + pcm
