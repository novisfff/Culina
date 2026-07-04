from __future__ import annotations

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import timedelta
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.ai_audio import get_ai_audio_service
from app.api.ai_audio import _transcribe_voice_event
from app.core.deps import get_current_auth
from app.db.session import get_db
from app.core.utils import utcnow
from app.main import app
from app.services.ai_audio.cooking_voice_stream import stream_cooking_assistant_voice_events
from app.services.ai_audio.realtime import RealtimeVoiceSessionState, realtime_voice_session_store
from app.services.ai_audio.schemas import CookingRealtimeSession, SpeechResult, TranscriptionResult


def receive_json_with_timeout(websocket, timeout: float = 1.0):
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(websocket.receive_json)
    try:
        return future.result(timeout=timeout)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def receive_json_skipping_audio_trace(websocket):
    while True:
        message = websocket.receive_json()
        if message.get("type") != "assistant_audio_trace":
            return message


def receive_json_with_timeout_skipping_audio_trace(websocket, timeout: float = 1.0):
    while True:
        message = receive_json_with_timeout(websocket, timeout=timeout)
        if message.get("type") != "assistant_audio_trace":
            return message


class FakeAudioService:
    def __init__(self) -> None:
        self.transcription_request = None
        self.transcription_provider = None
        self.speech_request = None
        self.speech_provider = None
        self.session_request = None

    def transcribe(self, request, provider=None):
        self.transcription_request = request
        self.transcription_provider = provider
        return TranscriptionResult(
            text="下一步",
            language="zh",
            duration_seconds=1.2,
            provider=provider or "openai",
            model="fake-transcribe",
        )

    def synthesize(self, request, provider=None):
        self.speech_request = request
        self.speech_provider = provider
        return SpeechResult(
            content_type="audio/mpeg",
            audio_bytes=b"fake-audio",
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
            provider=provider or "openai",
            model="fake-tts",
        )

    def create_cooking_session(self, request):
        self.session_request = request
        return CookingRealtimeSession(
            provider=request.provider,
            mode="agent_backed_websocket",
            session_id="voice_session-test",
            websocket_url="/api/ai/realtime/cooking/sessions/voice_session-test/ws",
            expires_at=utcnow() + timedelta(minutes=10),
        )


class AIAudioApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fake_service = FakeAudioService()

        def override_auth():
            return (
                SimpleNamespace(id="user-test"),
                SimpleNamespace(id="membership-test", family_id="family-test"),
            )

        app.dependency_overrides[get_current_auth] = override_auth
        app.dependency_overrides[get_ai_audio_service] = lambda: self.fake_service
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def settings(self, **overrides):
        values = {
            "ai_audio_enabled": True,
            "ai_stt_max_upload_bytes": 1024,
            "ai_stt_language_hint": "zh",
            "ai_realtime_provider": "dashscope",
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_transcription_rejects_when_voice_disabled(self) -> None:
        with patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_audio_enabled=False)):
            response = self.client.post(
                "/api/ai/audio/transcriptions",
                data={"surface": "main_ai"},
                files={"file": ("voice.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("not enabled", response.json()["detail"])

    def test_transcription_uploads_audio_to_service(self) -> None:
        with patch("app.api.ai_audio.get_settings", return_value=self.settings()):
            response = self.client.post(
                "/api/ai/audio/transcriptions",
                data={"surface": "recipe_cook_page", "language_hint": "zh", "provider": "dashscope"},
                files={"file": ("voice.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["text"], "下一步")
        self.assertEqual(response.json()["provider"], "dashscope")
        self.assertIsNotNone(self.fake_service.transcription_request)
        self.assertEqual(self.fake_service.transcription_request.family_id, "family-test")
        self.assertEqual(self.fake_service.transcription_request.surface, "recipe_cook_page")
        self.assertEqual(self.fake_service.transcription_provider, "dashscope")

    def test_speech_only_allows_recipe_cook_page(self) -> None:
        with patch("app.api.ai_audio.get_settings", return_value=self.settings()):
            response = self.client.post(
                "/api/ai/audio/speech",
                json={"surface": "main_ai", "text": "你好", "provider": "openai"},
            )

        self.assertEqual(response.status_code, 400)

    def test_speech_returns_provider_audio_without_exposing_external_url(self) -> None:
        with patch("app.api.ai_audio.get_settings", return_value=self.settings()):
            response = self.client.post(
                "/api/ai/audio/speech",
                json={"surface": "recipe_cook_page", "text": "好了，已经切到下一步。", "provider": "openai"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"fake-audio")
        self.assertEqual(response.headers["content-type"], "audio/mpeg")
        self.assertEqual(response.headers["x-ai-audio-provider"], "openai")
        self.assertIsNotNone(self.fake_service.speech_request)
        self.assertEqual(self.fake_service.speech_request.family_id, "family-test")

    def test_cooking_session_uses_agent_backed_websocket_contract(self) -> None:
        subject = {"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}}
        with patch("app.api.ai_audio.get_settings", return_value=self.settings()):
            response = self.client.post(
                "/api/ai/realtime/cooking/session",
                json={
                    "provider": "dashscope",
                    "recipe_id": "recipe-test",
                    "cook_session_id": "cook-test",
                    "session_revision": 3,
                    "subject": subject,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["mode"], "agent_backed_websocket")
        self.assertEqual(data["websocket_url"], "/api/ai/realtime/cooking/sessions/voice_session-test/ws")
        self.assertEqual(self.fake_service.session_request.family_id, "family-test")
        self.assertEqual(self.fake_service.session_request.subject, subject)

    def test_cooking_session_rejects_non_cooking_subject(self) -> None:
        with patch("app.api.ai_audio.get_settings", return_value=self.settings()):
            response = self.client.post(
                "/api/ai/realtime/cooking/session",
                json={
                    "provider": "dashscope",
                    "recipe_id": "recipe-test",
                    "cook_session_id": "cook-test",
                    "session_revision": 3,
                    "subject": {"source": "ai_workspace", "extra": {"surface": "ai_workspace"}},
                },
            )

        self.assertEqual(response.status_code, 400)

    def test_cooking_assistant_voice_stream_sends_text_and_audio_events(self) -> None:
        subject = {"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}}

        class FakeDashScopeProvider:
            def __init__(self, settings, *, capability: str) -> None:
                self.settings = settings
                self.capability = capability

            async def stream_realtime_text(self, text_chunks, request):
                async for _chunk in text_chunks:
                    pass
                yield {
                    "type": "audio_start",
                    "content_type": "audio/pcm",
                    "format": "pcm16",
                    "sample_rate": 24000,
                    "channels": 1,
                }
                yield {"type": "audio_delta", "audio": base64.b64encode(b"voice").decode("ascii"), "sequence": 1}
                yield {"type": "audio_done", "sequence": 1}

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-stream-test", "created_at": utcnow()},
                        "message": {"content": "收到。", "parts": [], "created_at": utcnow()},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_tts_provider="dashscope")),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai_audio.DashScopeAudioProvider", FakeDashScopeProvider),
            patch("app.api.ai._discard_transient_chat_history"),
        ):
            with self.client.stream(
                "POST",
                "/api/ai/audio/cooking/assistant/stream",
                json={
                    "provider": "dashscope",
                    "message": "下一步",
                    "client_message_id": "client-message-test",
                    "client_run_id": "client-run-test",
                    "subject": subject,
                },
            ) as response:
                body = response.read().decode("utf-8")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-cache, no-transform")
        self.assertEqual(response.headers["connection"], "keep-alive")
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertIn("backend_sse_stream_start", body)
        self.assertIn("event: message_delta", body)
        self.assertIn("event: assistant_audio_trace", body)
        self.assertIn("event: assistant_audio_start", body)
        self.assertIn("event: assistant_audio_delta", body)
        self.assertIn("event: assistant_audio_done", body)
        self.assertIn("event: response", body)

    def test_cooking_voice_stream_uses_independent_worker_session(self) -> None:
        parent_db = object()
        created_sessions = []
        captured_service_sessions = []

        class WorkerSession:
            def __init__(self) -> None:
                self.closed = False

            def close(self) -> None:
                self.closed = True

        def session_factory() -> WorkerSession:
            session = WorkerSession()
            created_sessions.append(session)
            return session

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                captured_service_sessions.append(db)

            def stream_chat(self, **kwargs):
                del kwargs
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-worker-session-test"},
                        "message": {"content": "收到。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        async def collect_events() -> list[dict]:
            events = []
            async for event in stream_cooking_assistant_voice_events(
                parent_db,
                family_id="family-test",
                user_id="user-test",
                message="下一步",
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                provider="disabled",
                settings=self.settings(ai_tts_provider="disabled"),
                service_factory=FakeAIApplicationService,
                db_session_factory=session_factory,
            ):
                events.append(event)
            return events

        with (
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.services.ai_audio.cooking_voice_stream.commit_session"),
        ):
            events = asyncio.run(collect_events())

        self.assertEqual([event["type"] for event in events if event["type"] == "assistant_transcript_done"], ["assistant_transcript_done"])
        self.assertEqual(len(created_sessions), 1)
        self.assertIs(captured_service_sessions[0], created_sessions[0])
        self.assertIsNot(captured_service_sessions[0], parent_db)
        self.assertTrue(created_sessions[0].closed)

    def test_realtime_dashscope_stt_delta_uses_send_callback(self) -> None:
        session = RealtimeVoiceSessionState(
            session_id="voice_session-send-callback-test",
            family_id="family-test",
            user_id="user-test",
            provider="dashscope",
            recipe_id="recipe-test",
            cook_session_id="cook-test",
            session_revision=3,
            subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
            created_at=utcnow(),
            expires_at=utcnow() + timedelta(minutes=10),
        )
        sent_payloads = []

        class FailingWebSocket:
            async def send_json(self, payload):
                raise AssertionError(f"direct websocket send_json should not be used: {payload}")

        async def send_json(payload):
            sent_payloads.append(payload)

        class FakeDashScopeProvider:
            def __init__(self, settings, *, capability: str) -> None:
                self.settings = settings
                self.capability = capability

            async def transcribe_realtime_audio(self, request, *, on_delta=None):
                del request
                if on_delta is not None:
                    await on_delta("下一")
                    await on_delta("步")
                return TranscriptionResult(
                    text="下一步",
                    language="zh",
                    duration_seconds=None,
                    provider="dashscope",
                    model="qwen3-asr-flash-realtime",
                )

        audio_payload = base64.b64encode(b"\x00\x00\x01\x00").decode("ascii")
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_stt_max_upload_bytes=1024)),
            patch("app.api.ai_audio.DashScopeAudioProvider", FakeDashScopeProvider),
        ):
            text = asyncio.run(
                _transcribe_voice_event(
                    {
                        "type": "audio_chunk_done",
                        "data": f"data:audio/pcm;base64,{audio_payload}",
                        "mime_type": "audio/pcm",
                        "sample_rate": 16000,
                    },
                    session=session,
                    websocket=FailingWebSocket(),
                    send_json=send_json,
                    turn_id="turn-locked-send",
                    expose_turn_id=True,
                )
            )

        self.assertEqual(text, "下一步")
        self.assertEqual(
            sent_payloads,
            [
                {"type": "user_transcript_delta", "text": "下一", "turn_id": "turn-locked-send"},
                {"type": "user_transcript_delta", "text": "步", "turn_id": "turn-locked-send"},
            ],
        )

    def test_cooking_realtime_websocket_runs_agent_loop_for_final_transcript(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-test",
                family_id="family-test",
                user_id="user-test",
                provider="dashscope",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )
        captured = {}

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                captured.update(kwargs)
                card = {"id": "card-test", "type": "ui_actions", "data": {"actions": []}}
                yield ("message_delta", {"delta": "好了，"})
                yield ("message_part", {"part": {"id": "part-card", "type": "result_card", "card": card}})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-test"},
                        "message": {"content": "好了，已经切到下一步。", "parts": []},
                        "included": {"result_cards": [card]},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_tts_provider="disabled")),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "好了，"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket)["type"], "ui_actions")
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_done", "text": "好了，"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "listening"})

        self.assertEqual(captured["family_id"], "family-test")
        self.assertEqual(captured["user_id"], "user-test")
        self.assertEqual(captured["message"], "下一步")
        self.assertEqual(captured["quick_task"], "cooking_assistant")
        self.assertEqual(captured["subject"]["source"], "recipe_cook_page")
        self.assertEqual(captured["attachments"], [])

    def test_cooking_realtime_websocket_transcribes_audio_event_before_agent_loop(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-audio-test",
                family_id="family-test",
                user_id="user-test",
                provider="openai",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )
        captured = {"transcribe_provider": None, "transcription_content_type": None, "agent_message": None}

        class FakeVoiceAudioService:
            def __init__(self, settings) -> None:
                self.settings = settings

            def transcribe(self, request, provider=None):
                captured["transcribe_provider"] = provider
                captured["transcription_content_type"] = request.content_type
                return TranscriptionResult(
                    text="下一步",
                    language="zh",
                    duration_seconds=0.8,
                    provider=provider or "openai",
                    model="fake-transcribe",
                )

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                captured["agent_message"] = kwargs["message"]
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-audio-test"},
                        "message": {"content": "收到。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        audio_payload = base64.b64encode(b"fake-audio").decode("ascii")
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_stt_max_upload_bytes=1024)),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.AIAudioService", FakeVoiceAudioService),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-audio-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({
                    "type": "audio_chunk_done",
                    "data": f"data:audio/webm;base64,{audio_payload}",
                    "mime_type": "audio/webm",
                    "filename": "voice.webm",
                })
                audio_received_trace = websocket.receive_json()
                self.assertEqual(audio_received_trace["type"], "assistant_audio_trace")
                self.assertEqual(audio_received_trace["stage"], "backend_audio_received")
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "transcribing"})
                stt_done_trace = websocket.receive_json()
                self.assertEqual(stt_done_trace["type"], "assistant_audio_trace")
                self.assertEqual(stt_done_trace["stage"], "backend_stt_done")
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "收到。"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_done", "text": "收到。"})

        self.assertEqual(captured["transcribe_provider"], "openai")
        self.assertEqual(captured["transcription_content_type"], "audio/webm")
        self.assertEqual(captured["agent_message"], "下一步")

    def test_cooking_realtime_websocket_stays_responsive_during_sync_transcription(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-sync-stt-test",
                family_id="family-test",
                user_id="user-test",
                provider="openai",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )
        finish_transcribe = threading.Event()

        class BlockingVoiceAudioService:
            def __init__(self, settings) -> None:
                self.settings = settings

            def transcribe(self, request, provider=None):
                finish_transcribe.wait(timeout=3)
                return TranscriptionResult(
                    text="下一步",
                    language="zh",
                    duration_seconds=0.8,
                    provider=provider or "openai",
                    model="fake-transcribe",
                )

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-sync-stt-test"},
                        "message": {"content": "收到。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        audio_payload = base64.b64encode(b"fake-audio").decode("ascii")
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_stt_max_upload_bytes=1024)),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.AIAudioService", BlockingVoiceAudioService),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-sync-stt-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({
                    "type": "audio_chunk_done",
                    "data": f"data:audio/webm;base64,{audio_payload}",
                    "mime_type": "audio/webm",
                    "filename": "voice.webm",
                    "turn_id": "turn-stt",
                })
                self.assertEqual(websocket.receive_json()["type"], "assistant_audio_trace")
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "transcribing", "turn_id": "turn-stt"})
                websocket.send_json({"type": "ping"})
                try:
                    self.assertEqual(receive_json_with_timeout(websocket), {"type": "pong"})
                except TimeoutError:
                    finish_transcribe.set()
                    raise
                finish_transcribe.set()

        finish_transcribe.set()

    def test_cooking_realtime_websocket_uses_dashscope_realtime_for_pcm_audio(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-dashscope-realtime-test",
                family_id="family-test",
                user_id="user-test",
                provider="dashscope",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )
        captured = {"realtime_content_type": None, "realtime_sample_rate": None, "agent_message": None}

        class FakeDashScopeProvider:
            def __init__(self, settings, *, capability: str) -> None:
                self.settings = settings
                self.capability = capability

            async def transcribe_realtime_audio(self, request, *, on_delta=None):
                captured["realtime_content_type"] = request.content_type
                captured["realtime_sample_rate"] = request.metadata.get("sample_rate")
                if on_delta is not None:
                    await on_delta("下一")
                    await on_delta("步")
                return TranscriptionResult(
                    text="下一步",
                    language="zh",
                    duration_seconds=None,
                    provider="dashscope",
                    model="qwen3-asr-flash-realtime",
                )

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                captured["agent_message"] = kwargs["message"]
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-dashscope-realtime-test"},
                        "message": {"content": "收到。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        audio_payload = base64.b64encode(b"\x00\x00\x01\x00").decode("ascii")
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_stt_max_upload_bytes=1024)),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.DashScopeAudioProvider", FakeDashScopeProvider),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-dashscope-realtime-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({
                    "type": "audio_chunk_done",
                    "data": f"data:audio/pcm;base64,{audio_payload}",
                    "mime_type": "audio/pcm",
                    "sample_rate": 16000,
                    "filename": "voice.pcm",
                })
                audio_received_trace = websocket.receive_json()
                self.assertEqual(audio_received_trace["type"], "assistant_audio_trace")
                self.assertEqual(audio_received_trace["stage"], "backend_audio_received")
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "transcribing"})
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_delta", "text": "下一"})
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_delta", "text": "步"})
                stt_done_trace = websocket.receive_json()
                self.assertEqual(stt_done_trace["type"], "assistant_audio_trace")
                self.assertEqual(stt_done_trace["stage"], "backend_stt_done")
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "收到。"})

        self.assertEqual(captured["realtime_content_type"], "audio/pcm")
        self.assertEqual(captured["realtime_sample_rate"], 16000)
        self.assertEqual(captured["agent_message"], "下一步")

    def test_cooking_realtime_websocket_sends_dashscope_realtime_tts_audio(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-dashscope-tts-test",
                family_id="family-test",
                user_id="user-test",
                provider="dashscope",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )

        class FakeDashScopeProvider:
            def __init__(self, settings, *, capability: str) -> None:
                self.settings = settings
                self.capability = capability

            async def stream_realtime_text(self, text_chunks, request):
                chunks = []
                async for chunk in text_chunks:
                    chunks.append(chunk)
                self.chunks = chunks
                yield {
                    "type": "audio_start",
                    "content_type": "audio/pcm",
                    "format": "pcm16",
                    "sample_rate": 24000,
                    "channels": 1,
                }
                yield {"type": "audio_delta", "audio": base64.b64encode(b"tts-audio").decode("ascii"), "sequence": 1}
                yield {"type": "audio_done", "sequence": 1}

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                yield ("message_delta", {"delta": "收到。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-dashscope-tts-test"},
                        "message": {"content": "收到。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_tts_provider="dashscope")),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.DashScopeAudioProvider", FakeDashScopeProvider),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-dashscope-tts-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_done", "text": "下一步"})
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "收到。"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_done", "text": "收到。"})
                audio_start = receive_json_skipping_audio_trace(websocket)
                self.assertEqual(audio_start["type"], "assistant_audio_start")
                self.assertEqual(audio_start["content_type"], "audio/pcm")
                audio_delta = receive_json_skipping_audio_trace(websocket)
                self.assertEqual(audio_delta["type"], "assistant_audio_delta")
                self.assertEqual(base64.b64decode(audio_delta["audio"]), b"tts-audio")
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_audio_done", "sequence": 1})

    def test_cooking_realtime_websocket_accepts_next_turn_before_previous_ai_finishes(self) -> None:
        realtime_voice_session_store.clear()
        realtime_voice_session_store.put(
            RealtimeVoiceSessionState(
                session_id="voice_session-overlap-test",
                family_id="family-test",
                user_id="user-test",
                provider="dashscope",
                recipe_id="recipe-test",
                cook_session_id="cook-test",
                session_revision=3,
                subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
                created_at=utcnow(),
                expires_at=utcnow() + timedelta(minutes=10),
            )
        )
        first_turn_can_finish = threading.Event()

        class FakeAIApplicationService:
            def __init__(self, db) -> None:
                self.db = db

            def stream_chat(self, **kwargs):
                message = kwargs["message"]
                if message == "第一句":
                    yield ("message_delta", {"delta": "第一句处理中。"})
                    first_turn_can_finish.wait(timeout=3)
                    yield (
                        "response",
                        {
                            "run": {"id": "voice-run-overlap-first"},
                            "message": {"content": "第一句结束。", "parts": []},
                            "included": {"result_cards": []},
                        },
                    )
                    return
                yield ("message_delta", {"delta": "第二句处理中。"})
                yield (
                    "response",
                    {
                        "run": {"id": "voice-run-overlap-second"},
                        "message": {"content": "第二句结束。", "parts": []},
                        "included": {"result_cards": []},
                    },
                )

        def override_db():
            yield object()

        app.dependency_overrides[get_db] = override_db
        with (
            patch("app.api.ai_audio.get_settings", return_value=self.settings(ai_tts_provider="disabled")),
            patch("app.api.ai_audio._authenticate_websocket_token", return_value=(SimpleNamespace(id="user-test"), SimpleNamespace(family_id="family-test"))),
            patch("app.api.ai_audio.AIApplicationService", FakeAIApplicationService),
            patch("app.api.ai._discard_transient_chat_history"),
            patch("app.api.ai_audio.commit_session"),
        ):
            with self.client.websocket_connect("/api/ai/realtime/cooking/sessions/voice_session-overlap-test/ws?token=fake") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "status")
                websocket.send_json({"type": "user_transcript_done", "text": "第一句", "turn_id": "turn-1"})
                self.assertEqual(websocket.receive_json(), {"type": "user_transcript_done", "text": "第一句", "turn_id": "turn-1"})
                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking", "turn_id": "turn-1"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking", "turn_id": "turn-1"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "第一句处理中。", "turn_id": "turn-1"})

                websocket.send_json({"type": "user_transcript_done", "text": "第二句", "turn_id": "turn-2"})
                try:
                    self.assertEqual(receive_json_with_timeout_skipping_audio_trace(websocket), {"type": "user_transcript_done", "text": "第二句", "turn_id": "turn-2"})
                except TimeoutError:
                    first_turn_can_finish.set()
                    raise

                self.assertEqual(websocket.receive_json(), {"type": "status", "status": "thinking", "turn_id": "turn-2"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "status", "status": "speaking", "turn_id": "turn-2"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_delta", "text": "第二句处理中。", "turn_id": "turn-2"})
                self.assertEqual(receive_json_skipping_audio_trace(websocket), {"type": "assistant_transcript_done", "text": "第二句处理中。", "turn_id": "turn-2"})

        first_turn_can_finish.set()
