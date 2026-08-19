from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import Awaitable, Callable

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response, StreamingResponse
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.ai.runtime.factory import (
    FamilyChatProviderFactory,
    RevisionBoundFamilyChatProviderFactory,
)
from app.ai.workspace_service import AIApplicationService
from app.core.config import get_settings
from app.core.deps import get_current_auth
from app.core.utils import create_id
from app.db.session import SessionLocal, get_db
from app.db.transactions import commit_session
from app.models.domain import Membership, User
from app.repos.auth import get_active_membership, get_user_by_id
from app.schemas.ai_audio import (
    AudioTranscriptionResponse,
    CookingAssistantVoiceStreamRequest,
    CookingRealtimeSessionRequest,
    CookingRealtimeSessionResponse,
    SpeechRequest as SpeechApiRequest,
)
from app.services.ai_audio.cooking_voice_stream import (
    stream_cooking_assistant_voice_events,
)
from app.services.ai_audio.providers import audio_capability_error
from app.services.ai_audio.realtime import (
    RealtimeVoiceSessionState,
    realtime_voice_session_store,
)
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest as ServiceCookingRealtimeSessionRequest,
    SpeechRequest,
    TranscriptionRequest,
)
from app.services.ai_audio.service import AIAudioService
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import read_audio_upload
from app.services.family_model_settings.errors import FamilyModelSettingsError


router = APIRouter(prefix="/api/ai", tags=["ai-audio"])


def get_ai_audio_service(
    db: Session = Depends(get_db),
    auth: tuple[User, Membership] = Depends(get_current_auth),
) -> AIAudioService:
    user, membership = auth
    return AIAudioService(
        db,
        family_id=membership.family_id,
        user_id=user.id,
    )


def _authenticate_websocket_token(
    token: str | None,
    db: Session,
) -> tuple[User, Membership] | None:
    if not token:
        return None
    try:
        payload = jwt.decode(
            token, get_settings().jwt_secret, algorithms=["HS256"]
        )
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


def _validate_cooking_subject(subject: dict) -> None:
    extra = subject.get("extra") if isinstance(subject, dict) else None
    if (
        subject.get("source") != "recipe_cook_page"
        or not isinstance(extra, dict)
        or extra.get("surface") != "recipe_cook_page"
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid cooking voice subject",
        )


def _sse_event(event_type: str, data: dict) -> str:
    return (
        f"event: {event_type}\n"
        f"data: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"
    )


def _decode_audio_event(event: dict) -> tuple[bytes, str, str]:
    data = str(event.get("data") or "")
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Voice audio payload is empty",
        )
    content_type = str(event.get("mime_type") or "audio/webm")
    if data.startswith("data:"):
        header, _, data = data.partition(",")
        if ";" in header:
            content_type = header.removeprefix("data:").split(";", 1)[0] or content_type
    try:
        audio_bytes = base64.b64decode(data, validate=True)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Voice audio payload is invalid",
        ) from exc
    return audio_bytes, content_type, str(event.get("filename") or "voice.webm")


def _with_turn_id(payload: dict, *, turn_id: str, expose_turn_id: bool) -> dict:
    return {**payload, "turn_id": turn_id} if expose_turn_id and turn_id else payload


async def _transcribe_voice_event(
    event: dict,
    *,
    session: RealtimeVoiceSessionState,
    service: AIAudioService,
    send_json: Callable[[dict], Awaitable[None]],
    turn_id: str,
    expose_turn_id: bool,
    realtime_turn_id: str,
) -> str:
    audio_bytes, content_type, filename = _decode_audio_event(event)
    if len(audio_bytes) > service.audio_upload_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "audio_upload_too_large", "message": "音频文件过大"},
        )
    scope = session.realtime_usage_scope
    if scope is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "realtime_usage_unavailable", "message": "当前实时语音服务不可用，请改用文字。"},
        )
    provider = service.realtime_runtime_for_session(session)

    async def send_delta(delta: str) -> None:
        if not delta:
            return
        await send_json(
            _with_turn_id(
                {"type": "user_transcript_delta", "text": delta},
                turn_id=turn_id,
                expose_turn_id=expose_turn_id,
            )
        )

    result = await provider.transcribe_realtime_audio(
        TranscriptionRequest(
            audio_bytes=audio_bytes,
            filename=filename,
            content_type=content_type,
            surface="recipe_cook_page",
            family_id=session.family_id,
            user_id=session.user_id,
            operation_id=create_id("realtime-stt-operation"),
            metadata={
                "sample_rate": event.get("sample_rate"),
                "sample_width_bytes": event.get("sample_width_bytes"),
                "channels": event.get("channels"),
            },
        ),
        on_delta=send_delta,
        realtime_usage_scope=scope,
        realtime_turn_id=realtime_turn_id,
    )
    return result.text.strip()


def _reject_audio_provider_overrides(form: object) -> None:
    keys = set(form.keys()) if hasattr(form, "keys") else set()
    forbidden = {"provider", "model", "api_base", "endpoint", "api_key"}
    if keys & forbidden:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "audio_provider_override_forbidden",
                "message": "语音服务由家庭主理人统一配置。",
            },
        )


@router.post("/audio/transcriptions", response_model=AudioTranscriptionResponse)
async def transcribe_audio(
    raw_request: Request,
    file: UploadFile = File(...),
    surface: str = Form(...),
    language_hint: str | None = Form(default=None),
    sample_rate: int | None = Form(default=None),
    sample_width_bytes: int | None = Form(default=None),
    channels: int | None = Form(default=None),
    service: AIAudioService = Depends(get_ai_audio_service),
) -> AudioTranscriptionResponse:
    _reject_audio_provider_overrides(await raw_request.form())
    if surface not in {"main_ai", "recipe_cook_page"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid audio surface",
        )
    payload, content_type = await read_audio_upload(
        file,
        max_bytes=service.audio_upload_max_bytes,
    )
    result = service.transcribe(
        TranscriptionRequest(
            audio_bytes=payload,
            filename=file.filename or "audio",
            content_type=content_type,
            surface=surface,  # type: ignore[arg-type]
            language_hint=language_hint,
            family_id=service.family_id,
            user_id=service.user_id,
            operation_id=create_id("stt-operation"),
            metadata={
                "sample_rate": sample_rate,
                "sample_width_bytes": sample_width_bytes,
                "channels": channels,
            },
        )
    )
    return AudioTranscriptionResponse(
        text=result.text,
        language=result.language,
        duration_seconds=result.duration_seconds,
    )


@router.post("/audio/speech")
def synthesize_speech(
    request: SpeechApiRequest,
    service: AIAudioService = Depends(get_ai_audio_service),
) -> Response:
    if request.surface != "recipe_cook_page":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only recipe cook page speech is supported",
        )
    speech_result = service.synthesize(
        SpeechRequest(
            text=sanitize_speech_text(request.text),
            surface=request.surface,
            voice=request.voice,
            family_id=service.family_id,
            user_id=service.user_id,
            operation_id=create_id("tts-operation"),
        )
    )
    if not speech_result.audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="语音合成结果为空",
        )
    return Response(
        content=speech_result.audio_bytes,
        media_type=speech_result.content_type,
    )


@router.post("/audio/cooking/assistant/stream")
async def stream_cooking_assistant_voice(
    request: CookingAssistantVoiceStreamRequest,
    service: AIAudioService = Depends(get_ai_audio_service),
) -> StreamingResponse:
    _validate_cooking_subject(request.subject)
    runtime = service.prepare_cooking_voice_stream(
        ServiceCookingRealtimeSessionRequest(
            family_id=service.family_id,
            user_id=service.user_id,
            recipe_id=str(request.subject.get("recipe_id") or "voice-stream"),
            cook_session_id=str(request.subject.get("cook_session_id") or "voice-stream"),
            session_revision=int(request.subject.get("session_revision") or 0),
            subject=request.subject,
        )
    )
    scope = runtime.session.realtime_usage_scope
    if scope is None:  # pragma: no cover - service always attaches one
        raise HTTPException(status_code=503, detail="Realtime usage unavailable")
    route_started_at = time.perf_counter()
    provider_factory = RevisionBoundFamilyChatProviderFactory(
        FamilyChatProviderFactory(), runtime.session.config_revision_id
    )

    async def event_stream():
        yield _sse_event(
            "assistant_audio_trace",
            {"stage": "backend_sse_stream_start", "elapsed_ms": int((time.perf_counter() - route_started_at) * 1000)},
        )
        async for event in stream_cooking_assistant_voice_events(
            service.db,
            family_id=service.family_id,
            user_id=service.user_id,
            message=request.message,
            subject=request.subject,
            realtime_provider=runtime.provider,
            realtime_usage_scope=scope,
            realtime_turn_id=create_id("realtime-turn"),
            provider_factory=provider_factory,
            client_message_id=request.client_message_id,
            client_run_id=request.client_run_id,
            db_session_factory=SessionLocal,
        ):
            event_type = str(event.get("type") or "message")
            if event_type in {"progress", "message_delta", "message_part", "response"}:
                payload = event.get("data") if isinstance(event.get("data"), dict) else {}
            elif event_type == "error":
                payload = {"detail": str(event.get("detail") or "小灶回复失败")}
            else:
                payload = {key: value for key, value in event.items() if key != "type"}
            yield _sse_event(event_type, payload)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/realtime/cooking/session",
    response_model=CookingRealtimeSessionResponse,
)
def create_cooking_realtime_session(
    request: CookingRealtimeSessionRequest,
    service: AIAudioService = Depends(get_ai_audio_service),
) -> CookingRealtimeSessionResponse:
    _validate_cooking_subject(request.subject)
    session = service.create_cooking_session(
        ServiceCookingRealtimeSessionRequest(
            family_id=service.family_id,
            user_id=service.user_id,
            recipe_id=request.recipe_id,
            cook_session_id=request.cook_session_id,
            session_revision=request.session_revision,
            subject=request.subject,
        )
    )
    return CookingRealtimeSessionResponse(
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
    auth = _authenticate_websocket_token(token, db)
    if auth is None:
        await websocket.close(code=4401)
        return
    user, membership = auth
    try:
        session = realtime_voice_session_store.require_owner(
            session_id,
            family_id=membership.family_id,
            user_id=user.id,
        )
    except HTTPException:
        await websocket.close(code=4404)
        return
    service = AIAudioService(db, family_id=membership.family_id, user_id=user.id)
    try:
        provider = service.realtime_runtime_for_session(session)
    except FamilyModelSettingsError as exc:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": audio_capability_error(exc).detail["message"]})
        await websocket.close(code=1011)
        return

    scope = session.realtime_usage_scope
    if scope is None:
        await websocket.close(code=1011)
        return
    provider_factory = RevisionBoundFamilyChatProviderFactory(
        FamilyChatProviderFactory(), session.config_revision_id
    )
    send_lock = asyncio.Lock()

    async def send_json(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    await websocket.accept()
    await send_json(
        {
            "type": "status",
            "status": "listening",
            "session_id": session.session_id,
            "expires_at": session.expires_at.isoformat(),
        }
    )
    active_turn_id = ""
    current_turn_task: asyncio.Task[None] | None = None

    async def finish_realtime_audio_once(*, completion_reason: str) -> None:
        outcome = await scope.finish_current_lease_once(
            completion_reason=completion_reason,
        )
        if outcome.decision in {"blocked", "settlement_pending"}:
            await send_json(
                {
                    "type": "usage_limit",
                    "code": outcome.error_code or "model_usage_realtime_unavailable",
                    "message": "本次语音会话已结束，可以继续使用文字。",
                }
            )

    async def cancel_current_turn(*, reason: str) -> None:
        nonlocal active_turn_id, current_turn_task
        run_id = active_turn_id
        if run_id:
            cancellation = AIApplicationService(db)
            cancellation.record_run_cancellation(
                family_id=session.family_id,
                user_id=session.user_id,
                run_id=run_id,
            )
            commit_session(db)
        active_turn_id = ""
        if current_turn_task is not None and not current_turn_task.done():
            current_turn_task.cancel()
            try:
                await current_turn_task
            except asyncio.CancelledError:
                pass
        current_turn_task = None
        if reason in {"hangup", "disconnect"}:
            await finish_realtime_audio_once(completion_reason=reason)

    async def run_agent_turn(
        *,
        text: str,
        turn_id: str,
        metering_turn_id: str,
        expose_turn_id: bool,
    ) -> None:
        nonlocal active_turn_id
        if not text:
            active_turn_id = ""
            await send_json(_with_turn_id({"type": "status", "status": "listening"}, turn_id=turn_id, expose_turn_id=expose_turn_id))
            return
        await send_json(_with_turn_id({"type": "user_transcript_done", "text": text}, turn_id=turn_id, expose_turn_id=expose_turn_id))
        await send_json(_with_turn_id({"type": "status", "status": "thinking"}, turn_id=turn_id, expose_turn_id=expose_turn_id))
        speaking_sent = False
        try:
            async for voice_event in stream_cooking_assistant_voice_events(
                db,
                family_id=session.family_id,
                user_id=session.user_id,
                message=text,
                subject=session.subject,
                realtime_provider=provider,
                realtime_usage_scope=scope,
                realtime_turn_id=metering_turn_id,
                provider_factory=provider_factory,
                client_run_id=turn_id,
                db_session_factory=SessionLocal,
            ):
                if active_turn_id != turn_id:
                    break
                event_type = str(voice_event.get("type") or "")
                if event_type in {"progress", "message_delta", "message_part", "response"}:
                    continue
                if not speaking_sent and event_type in {
                    "assistant_transcript_delta",
                    "assistant_audio_start",
                    "assistant_audio_done",
                    "ui_actions",
                }:
                    speaking_sent = True
                    await send_json(_with_turn_id({"type": "status", "status": "speaking"}, turn_id=turn_id, expose_turn_id=expose_turn_id))
                await send_json(_with_turn_id(voice_event, turn_id=turn_id, expose_turn_id=expose_turn_id))
        finally:
            await finish_realtime_audio_once(completion_reason="turn_complete")
            if active_turn_id == turn_id:
                active_turn_id = ""
                await send_json(_with_turn_id({"type": "status", "status": "listening"}, turn_id=turn_id, expose_turn_id=expose_turn_id))

    async def run_audio_turn(
        *,
        event: dict,
        turn_id: str,
        metering_turn_id: str,
        expose_turn_id: bool,
    ) -> None:
        nonlocal active_turn_id
        await send_json(_with_turn_id({"type": "status", "status": "transcribing"}, turn_id=turn_id, expose_turn_id=expose_turn_id))
        try:
            text = await _transcribe_voice_event(
                event,
                session=session,
                service=service,
                send_json=send_json,
                turn_id=turn_id,
                expose_turn_id=expose_turn_id,
                realtime_turn_id=metering_turn_id,
            )
        except FamilyModelSettingsError as exc:
            detail = audio_capability_error(exc).detail
            await send_json(_with_turn_id({"type": "error", "message": detail["message"]}, turn_id=turn_id, expose_turn_id=expose_turn_id))
            active_turn_id = ""
        except HTTPException as exc:
            detail = exc.detail
            message = detail.get("message") if isinstance(detail, dict) else str(detail)
            await send_json(_with_turn_id({"type": "error", "message": message}, turn_id=turn_id, expose_turn_id=expose_turn_id))
            active_turn_id = ""
        else:
            if active_turn_id == turn_id:
                await run_agent_turn(
                    text=text,
                    turn_id=turn_id,
                    metering_turn_id=metering_turn_id,
                    expose_turn_id=expose_turn_id,
                )

    async def start_turn(event: dict) -> None:
        nonlocal active_turn_id, current_turn_task
        await cancel_current_turn(reason="replaced_by_new_turn")
        expose_turn_id = isinstance(event.get("turn_id"), str) and bool(str(event.get("turn_id")).strip())
        turn_id = str(event.get("turn_id") or create_id("voice_turn"))
        active_turn_id = turn_id
        metering_turn_id = create_id("realtime_turn")
        if event.get("type") == "audio_chunk_done":
            current_turn_task = asyncio.create_task(
                run_audio_turn(
                    event=event,
                    turn_id=turn_id,
                    metering_turn_id=metering_turn_id,
                    expose_turn_id=expose_turn_id,
                )
            )
        else:
            current_turn_task = asyncio.create_task(
                run_agent_turn(
                    text=str(event.get("text") or "").strip(),
                    turn_id=turn_id,
                    metering_turn_id=metering_turn_id,
                    expose_turn_id=expose_turn_id,
                )
            )

    try:
        while True:
            event = await websocket.receive_json()
            event_type = event.get("type")
            if event_type == "ping":
                await send_json({"type": "pong"})
            elif event_type == "hangup":
                await cancel_current_turn(reason="hangup")
                realtime_voice_session_store.close(session_id)
                await send_json({"type": "status", "status": "closed"})
                await websocket.close(code=1000)
                return
            elif event_type == "cancel_turn":
                await cancel_current_turn(reason="client_cancel")
                await send_json({"type": "turn_cancelled", "turn_id": str(event.get("turn_id") or "")})
            elif event_type in {"audio_chunk_done", "user_transcript_done"}:
                await start_turn(event)
            else:
                await send_json({"type": "error", "message": "Unsupported voice event"})
    except WebSocketDisconnect:
        await cancel_current_turn(reason="disconnect")
        realtime_voice_session_store.close(session_id)
