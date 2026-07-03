from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.core.config import get_settings
from app.core.config import Settings
from app.core.utils import create_id
from app.db.transactions import commit_session
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.providers import normalize_provider
from app.services.ai_audio.schemas import SpeechRequest


_AGENT_DONE = object()
_TTS_DONE = object()
_TTS_TEXT_IDLE_FLUSH_SECONDS = 0.18
_TTS_TEXT_MIN_IDLE_CHARS = 8
_TTS_TEXT_MIN_BOUNDARY_CHARS = 6
_TTS_TEXT_MAX_CHARS = 28
_TTS_TEXT_BOUNDARY_CHARS = tuple("。！？；!?;\n")
_TTS_TEXT_SOFT_BOUNDARY_CHARS = tuple("，、,.：:")


def _text_from_response_message(response: dict) -> str:
    message = response.get("message") if isinstance(response.get("message"), dict) else {}
    parts = message.get("parts") if isinstance(message.get("parts"), list) else []
    text_parts = [
        str(part.get("text") or "").strip()
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
    ]
    if text_parts:
        return "\n\n".join(text_parts)
    return str(message.get("content") or "").strip()


def _should_stream_dashscope_tts(provider: str | None, settings: Settings | Any | None = None) -> bool:
    settings = settings or get_settings()
    return normalize_provider(provider) == "dashscope" and normalize_provider(getattr(settings, "ai_tts_provider", "disabled")) == "dashscope"


def _result_cards_from_response(response: dict) -> list[dict]:
    included = response.get("included") if isinstance(response.get("included"), dict) else {}
    cards = included.get("result_cards") if isinstance(included.get("result_cards"), list) else []
    return [card for card in cards if isinstance(card, dict)]


def _should_flush_tts_text(text: str) -> bool:
    value = text.strip()
    if not value:
        return False
    if len(value) >= _TTS_TEXT_MAX_CHARS:
        return True
    if len(value) >= _TTS_TEXT_MIN_BOUNDARY_CHARS and value.endswith(_TTS_TEXT_BOUNDARY_CHARS):
        return True
    if len(value) >= 14 and value.endswith(_TTS_TEXT_SOFT_BOUNDARY_CHARS):
        return True
    return False


async def stream_cooking_assistant_voice_events(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    message: str,
    subject: dict,
    provider: str | None,
    client_message_id: str | None = None,
    client_run_id: str | None = None,
    settings: Settings | Any | None = None,
    service_factory: Callable[[Session], Any] | None = None,
    tts_provider_factory: Callable[[Any, str], Any] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    events: asyncio.Queue[dict[str, Any] | object] = asyncio.Queue()
    text_chunks: asyncio.Queue[str | None] = asyncio.Queue()
    stop_event = threading.Event()
    stream_settings = settings or get_settings()
    tts_enabled = _should_stream_dashscope_tts(provider, stream_settings)
    trace_started_at = time.perf_counter()
    ai_first_token_emitted = False

    def trace_elapsed_ms() -> int:
        return int((time.perf_counter() - trace_started_at) * 1000)

    def emit(event: dict[str, Any] | object) -> None:
        loop.call_soon_threadsafe(events.put_nowait, event)

    def emit_tts_text(delta: str) -> None:
        if tts_enabled:
            loop.call_soon_threadsafe(text_chunks.put_nowait, delta)

    def run_agent_stream() -> None:
        nonlocal ai_first_token_emitted
        assistant_text_parts: list[str] = []
        seen_cards: set[str] = set()
        service = (service_factory or AIApplicationService)(db)
        try:
            for event, data in service.stream_chat(
                family_id=family_id,
                user_id=user_id,
                message=message,
                client_message_id=client_message_id or create_id("voice_msg"),
                client_run_id=client_run_id or create_id("voice_run"),
                quick_task="cooking_assistant",
                subject=subject,
                attachments=[],
            ):
                if stop_event.is_set():
                    break
                if event == "progress":
                    emit({"type": "progress", "data": data})
                    continue
                if event == "message_delta":
                    delta = str(data.get("delta") or "")
                    if delta:
                        if tts_enabled and not ai_first_token_emitted:
                            ai_first_token_emitted = True
                            emit({"type": "assistant_audio_trace", "stage": "ai_first_token", "elapsed_ms": trace_elapsed_ms()})
                        assistant_text_parts.append(delta)
                        emit({"type": "message_delta", "data": data})
                        emit({"type": "assistant_transcript_delta", "text": delta})
                        emit_tts_text(delta)
                    continue
                if event == "message_part":
                    emit({"type": "message_part", "data": data})
                    part = data.get("part") if isinstance(data.get("part"), dict) else {}
                    card = part.get("card") if isinstance(part.get("card"), dict) else None
                    if part.get("type") == "result_card" and card:
                        card_id = str(card.get("id") or id(card))
                        if card_id not in seen_cards:
                            seen_cards.add(card_id)
                            emit({"type": "ui_actions", "card": card})
                    continue
                if event == "response":
                    for card in _result_cards_from_response(data):
                        card_id = str(card.get("id") or id(card))
                        if card_id in seen_cards:
                            continue
                        seen_cards.add(card_id)
                        emit({"type": "ui_actions", "card": card})
                    from app.api.ai import _discard_transient_chat_history

                    _discard_transient_chat_history(db, family_id=family_id, response=data)
                    if hasattr(db, "commit"):
                        commit_session(db)
                    run_id = data.get("run", {}).get("id") if isinstance(data.get("run"), dict) else None
                    live_ai_stream_cache.clear_run(run_id)
                    final_text = "".join(assistant_text_parts).strip() or _text_from_response_message(data)
                    if final_text and not assistant_text_parts:
                        emit_tts_text(final_text)
                    emit({"type": "assistant_transcript_done", "text": final_text})
                    emit({"type": "response", "data": data})
                    continue
                if event == "error":
                    emit({"type": "error", "detail": str(data.get("detail") or "小灶回复失败")})
        except AIConflictError as exc:
            emit({"type": "error", "detail": str(exc)})
        except ValueError as exc:
            emit({"type": "error", "detail": str(exc)})
        finally:
            if tts_enabled:
                loop.call_soon_threadsafe(text_chunks.put_nowait, None)
            emit(_AGENT_DONE)

    async def tts_text_iterator() -> AsyncIterator[str]:
        pending: list[str] = []

        def drain_pending() -> str:
            text = "".join(pending).strip()
            pending.clear()
            return text

        while True:
            if pending:
                try:
                    chunk = await asyncio.wait_for(text_chunks.get(), timeout=_TTS_TEXT_IDLE_FLUSH_SECONDS)
                except TimeoutError:
                    text = "".join(pending).strip()
                    if len(text) >= _TTS_TEXT_MIN_IDLE_CHARS:
                        yield drain_pending()
                    continue
            else:
                chunk = await text_chunks.get()
            if chunk is None:
                text = drain_pending()
                if text:
                    yield text
                break
            pending.append(chunk)
            text = "".join(pending)
            if _should_flush_tts_text(text):
                yield drain_pending()

    async def run_tts_stream() -> None:
        if not tts_enabled:
            await events.put(_TTS_DONE)
            return
        if tts_provider_factory is None:
            provider_client = DashScopeAudioProvider(stream_settings, capability="tts")
        else:
            provider_client = tts_provider_factory(stream_settings, "tts")
        try:
            async for audio_event in provider_client.stream_realtime_text(
                tts_text_iterator(),
                SpeechRequest(
                    text="",
                    surface="recipe_cook_page",
                    family_id=family_id,
                    metadata={"trace_started_at": trace_started_at},
                ),
            ):
                mapped = {"type": f"assistant_{audio_event.pop('type')}", **audio_event}
                await events.put(mapped)
        except HTTPException as exc:
            await events.put({"type": "assistant_audio_error", "message": str(exc.detail)})
        except Exception:
            await events.put({"type": "assistant_audio_error", "message": "语音播报失败"})
        finally:
            await events.put(_TTS_DONE)

    agent_thread = threading.Thread(target=run_agent_stream, name="cooking-voice-agent-stream", daemon=True)
    tts_task = asyncio.create_task(run_tts_stream())
    agent_thread.start()
    agent_done = False
    tts_done = False
    try:
        while not (agent_done and tts_done):
            event = await events.get()
            if event is _AGENT_DONE:
                agent_done = True
                continue
            if event is _TTS_DONE:
                tts_done = True
                continue
            yield event  # type: ignore[misc]
    finally:
        stop_event.set()
        if not tts_task.done():
            tts_task.cancel()
            try:
                await tts_task
            except asyncio.CancelledError:
                pass
