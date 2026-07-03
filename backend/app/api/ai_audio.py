from __future__ import annotations

import base64
import json

from jose import JWTError, jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.deps import get_current_auth
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Membership, User
from app.repos.auth import get_active_membership, get_user_by_id
from app.ai.errors import AIConflictError
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.schemas.ai_audio import (
    AudioTranscriptionResponse,
    CookingAssistantVoiceStreamRequest,
    CookingRealtimeSessionRequest,
    CookingRealtimeSessionResponse,
    SpeechRequest as SpeechApiRequest,
)
from app.services.ai_audio.providers import ensure_audio_enabled, normalize_provider
from app.services.ai_audio.cooking_voice_stream import stream_cooking_assistant_voice_events
from app.services.ai_audio.realtime import RealtimeVoiceSessionState
from app.services.ai_audio.realtime import realtime_voice_session_store
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest as ServiceCookingRealtimeSessionRequest,
    SpeechRequest,
    TranscriptionRequest,
)
from app.services.ai_audio.service import AIAudioService
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import read_audio_upload

router = APIRouter(prefix="/api/ai", tags=["ai-audio"])


def get_ai_audio_service() -> AIAudioService:
    return AIAudioService(get_settings())


def _authenticate_websocket_token(token: str | None, db: Session) -> tuple[User, Membership] | None:
    if not token:
        return None
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except JWTError:
        return None
    subject = payload.get("sub")
    if not subject:
        return None
    user = get_user_by_id(db, subject)
    membership = get_active_membership(db, subject)
    if user is None or membership is None:
        return None
    return user, membership


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


def _validate_cooking_subject(subject: dict) -> None:
    extra = subject.get("extra") if isinstance(subject, dict) else None
    if subject.get("source") != "recipe_cook_page" or not isinstance(extra, dict) or extra.get("surface") != "recipe_cook_page":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cooking voice subject")


def _sse_event(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"


async def _voice_events_from_agent_stream(db: Session, *, session: RealtimeVoiceSessionState, text: str):
    assistant_text_parts: list[str] = []
    seen_cards: set[str] = set()
    service = AIApplicationService(db)
    try:
        for event, data in service.stream_chat(
            family_id=session.family_id,
            user_id=session.user_id,
            message=text,
            client_message_id=create_id("voice_msg"),
            client_run_id=create_id("voice_run"),
            quick_task="cooking_assistant",
            subject=session.subject,
            attachments=[],
        ):
            if event == "message_delta":
                delta = str(data.get("delta") or "")
                if delta:
                    assistant_text_parts.append(delta)
                    yield {"type": "assistant_transcript_delta", "text": delta}
                continue
            if event == "message_part":
                part = data.get("part") if isinstance(data.get("part"), dict) else {}
                card = part.get("card") if isinstance(part.get("card"), dict) else None
                if part.get("type") == "result_card" and card:
                    card_id = str(card.get("id") or id(card))
                    if card_id not in seen_cards:
                        seen_cards.add(card_id)
                        yield {"type": "ui_actions", "card": card}
                continue
            if event == "response":
                included = data.get("included") if isinstance(data.get("included"), dict) else {}
                cards = included.get("result_cards") if isinstance(included.get("result_cards"), list) else []
                for card in cards:
                    if not isinstance(card, dict):
                        continue
                    card_id = str(card.get("id") or id(card))
                    if card_id in seen_cards:
                        continue
                    seen_cards.add(card_id)
                    yield {"type": "ui_actions", "card": card}
                from app.api.ai import _discard_transient_chat_history

                _discard_transient_chat_history(db, family_id=session.family_id, response=data)
                commit_session(db)
                run_id = data.get("run", {}).get("id") if isinstance(data.get("run"), dict) else None
                live_ai_stream_cache.clear_run(run_id)
                final_text = "".join(assistant_text_parts).strip() or _text_from_response_message(data)
                yield {"type": "assistant_transcript_done", "text": final_text}
                settings = get_settings()
                if session.provider == "dashscope" and normalize_provider(getattr(settings, "ai_tts_provider", "")) == "dashscope" and final_text:
                    try:
                        speech = await DashScopeAudioProvider(settings, capability="tts").synthesize_realtime_text(
                            SpeechRequest(text=final_text, surface="recipe_cook_page", family_id=session.family_id)
                        )
                    except HTTPException as exc:
                        yield {"type": "error", "message": str(exc.detail)}
                    else:
                        if speech.audio_bytes:
                            yield {
                                "type": "assistant_audio_done",
                                "content_type": speech.content_type,
                                "audio": base64.b64encode(speech.audio_bytes).decode("ascii"),
                            }
                continue
            if event == "error":
                yield {"type": "error", "message": str(data.get("detail") or "小灶回复失败")}
    except AIConflictError as exc:
        yield {"type": "error", "message": str(exc)}
    except ValueError as exc:
        yield {"type": "error", "message": str(exc)}


def _decode_audio_event(event: dict) -> tuple[bytes, str, str]:
    data = str(event.get("data") or "")
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Voice audio payload is empty")
    content_type = str(event.get("mime_type") or "audio/webm")
    if data.startswith("data:"):
        header, _, payload = data.partition(",")
        if ";" in header:
            content_type = header.removeprefix("data:").split(";", 1)[0] or content_type
        data = payload
    try:
        audio_bytes = base64.b64decode(data, validate=True)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Voice audio payload is invalid") from exc
    filename = str(event.get("filename") or "voice.webm")
    return audio_bytes, content_type, filename


async def _transcribe_voice_event(event: dict, *, session: RealtimeVoiceSessionState, websocket: WebSocket | None = None) -> str:
    settings = get_settings()
    audio_bytes, content_type, filename = _decode_audio_event(event)
    if len(audio_bytes) > settings.ai_stt_max_upload_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Audio file is too large")
    request = TranscriptionRequest(
        audio_bytes=audio_bytes,
        filename=filename,
        content_type=content_type,
        surface="recipe_cook_page",
        language_hint=settings.ai_stt_language_hint,
        family_id=session.family_id,
        metadata={"sample_rate": event.get("sample_rate")},
    )
    if session.provider == "dashscope" and "pcm" in content_type.lower():
        async def send_delta(delta: str) -> None:
            if websocket is not None and delta:
                await websocket.send_json({"type": "user_transcript_delta", "text": delta})

        result = await DashScopeAudioProvider(settings, capability="stt").transcribe_realtime_audio(request, on_delta=send_delta)
    else:
        result = AIAudioService(settings).transcribe(request, provider=session.provider)
    return result.text.strip()


@router.post("/audio/transcriptions", response_model=AudioTranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    surface: str = Form(...),
    language_hint: str | None = Form(default=None),
    provider: str | None = Form(default=None),
    auth: tuple[User, Membership] = Depends(get_current_auth),
    service: AIAudioService = Depends(get_ai_audio_service),
) -> AudioTranscriptionResponse:
    settings = get_settings()
    ensure_audio_enabled(settings)
    if surface not in {"main_ai", "recipe_cook_page"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid audio surface")
    _, membership = auth
    payload, content_type = await read_audio_upload(file, settings)
    result = service.transcribe(
        TranscriptionRequest(
            audio_bytes=payload,
            filename=file.filename or "audio",
            content_type=content_type,
            surface=surface,  # type: ignore[arg-type]
            language_hint=language_hint or settings.ai_stt_language_hint,
            family_id=membership.family_id,
        ),
        provider=provider,
    )
    return AudioTranscriptionResponse(
        text=result.text,
        language=result.language,
        provider=result.provider,
        model=result.model,
        duration_seconds=result.duration_seconds,
    )


@router.post("/audio/speech")
def synthesize_speech(
    request: SpeechApiRequest,
    auth: tuple[User, Membership] = Depends(get_current_auth),
    service: AIAudioService = Depends(get_ai_audio_service),
) -> Response:
    settings = get_settings()
    ensure_audio_enabled(settings)
    if request.surface != "recipe_cook_page":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only recipe cook page speech is supported")
    _, membership = auth
    speech_result = service.synthesize(
        SpeechRequest(
            text=sanitize_speech_text(request.text),
            surface=request.surface,
            voice=request.voice,
            family_id=membership.family_id,
        ),
        provider=request.provider,
    )
    if not speech_result.audio_bytes:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成结果为空")
    return Response(
        content=speech_result.audio_bytes,
        media_type=speech_result.content_type,
        headers={
            "X-AI-Audio-Provider": speech_result.provider,
            "X-AI-Audio-Model": speech_result.model,
        },
    )


@router.post("/audio/cooking/assistant/stream")
async def stream_cooking_assistant_voice(
    request: CookingAssistantVoiceStreamRequest,
    auth: tuple[User, Membership] = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    settings = get_settings()
    ensure_audio_enabled(settings)
    _validate_cooking_subject(request.subject)
    user, membership = auth

    async def event_stream():
        async for event in stream_cooking_assistant_voice_events(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            message=request.message,
            subject=request.subject,
            provider=request.provider or settings.ai_realtime_provider,
            client_message_id=request.client_message_id,
            client_run_id=request.client_run_id,
            settings=settings,
            service_factory=AIApplicationService,
            tts_provider_factory=lambda settings, capability: DashScopeAudioProvider(settings, capability=capability),
        ):
            event_type = str(event.get("type") or "message")
            if event_type in {"progress", "message_delta", "message_part", "response"}:
                payload = event.get("data") if isinstance(event.get("data"), dict) else {}
            elif event_type == "error":
                payload = {"detail": str(event.get("detail") or "小灶回复失败")}
            else:
                payload = {key: value for key, value in event.items() if key != "type"}
            yield _sse_event(event_type, payload)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/realtime/cooking/session", response_model=CookingRealtimeSessionResponse)
def create_cooking_realtime_session(
    request: CookingRealtimeSessionRequest,
    auth: tuple[User, Membership] = Depends(get_current_auth),
    service: AIAudioService = Depends(get_ai_audio_service),
) -> CookingRealtimeSessionResponse:
    settings = get_settings()
    ensure_audio_enabled(settings)
    user, membership = auth
    _validate_cooking_subject(request.subject)
    session = service.create_cooking_session(
        ServiceCookingRealtimeSessionRequest(
            provider=request.provider or settings.ai_realtime_provider,
            family_id=membership.family_id,
            user_id=user.id,
            recipe_id=request.recipe_id,
            cook_session_id=request.cook_session_id,
            session_revision=request.session_revision,
            subject=request.subject,
        )
    )
    return CookingRealtimeSessionResponse(
        provider=session.provider,
        session_id=session.session_id,
        websocket_url=session.websocket_url,
        expires_at=session.expires_at.isoformat(),
    )


@router.websocket("/realtime/cooking/sessions/{session_id}/ws")
async def cooking_realtime_session_ws(
    websocket: WebSocket,
    session_id: str,
    token: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> None:
    settings = get_settings()
    auth = _authenticate_websocket_token(token, db)
    if auth is None:
        await websocket.close(code=4401)
        return
    user, membership = auth
    try:
        session = realtime_voice_session_store.require_owner(session_id, family_id=membership.family_id, user_id=user.id)
    except HTTPException:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await websocket.send_json(
        {
            "type": "status",
            "status": "listening",
            "provider": session.provider,
            "session_id": session.session_id,
            "expires_at": session.expires_at.isoformat(),
        }
    )
    try:
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if event_type == "hangup":
                realtime_voice_session_store.close(session_id)
                await websocket.send_json({"type": "status", "status": "closed"})
                await websocket.close(code=1000)
                return
            if event_type == "audio_chunk_done":
                try:
                    text = await _transcribe_voice_event(event, session=session, websocket=websocket)
                except HTTPException as exc:
                    await websocket.send_json({"type": "error", "message": str(exc.detail)})
                    await websocket.send_json({"type": "status", "status": "listening"})
                    continue
                if text:
                    await websocket.send_json({"type": "user_transcript_done", "text": text})
                    await websocket.send_json({"type": "status", "status": "speaking"})
                    async for voice_event in stream_cooking_assistant_voice_events(
                        db,
                        family_id=session.family_id,
                        user_id=session.user_id,
                        message=text,
                        subject=session.subject,
                        provider=session.provider,
                        settings=settings,
                        service_factory=AIApplicationService,
                        tts_provider_factory=lambda settings, capability: DashScopeAudioProvider(settings, capability=capability),
                    ):
                        event_type = voice_event.get("type")
                        if event_type in {"progress", "message_delta", "message_part", "response"}:
                            continue
                        await websocket.send_json(voice_event)
                    await websocket.send_json({"type": "status", "status": "listening"})
                continue
            if event_type == "user_transcript_done":
                text = str(event.get("text") or "").strip()
                if text:
                    await websocket.send_json({"type": "user_transcript_done", "text": text})
                    await websocket.send_json({"type": "status", "status": "speaking"})
                    async for voice_event in stream_cooking_assistant_voice_events(
                        db,
                        family_id=session.family_id,
                        user_id=session.user_id,
                        message=text,
                        subject=session.subject,
                        provider=session.provider,
                        settings=settings,
                        service_factory=AIApplicationService,
                        tts_provider_factory=lambda settings, capability: DashScopeAudioProvider(settings, capability=capability),
                    ):
                        event_type = voice_event.get("type")
                        if event_type in {"progress", "message_delta", "message_part", "response"}:
                            continue
                        await websocket.send_json(voice_event)
                    await websocket.send_json({"type": "status", "status": "listening"})
                continue
            await websocket.send_json({"type": "error", "message": "Unsupported voice event"})
    except WebSocketDisconnect:
        realtime_voice_session_store.close(session_id)
