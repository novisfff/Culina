from __future__ import annotations

import asyncio
import base64
import json
import sys
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.services.ai_audio.service import AIAudioService
from app.services.ai_audio.realtime import RealtimeVoiceSessionState, realtime_voice_session_store
from app.services.ai_audio.schemas import CookingRealtimeSessionRequest
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.dashscope_audio import (
    _dashscope_stt_payload,
    _extract_qwen_asr_delta_text,
    _qwen_tts_realtime_stream,
)
from app.services.ai_audio.cooking_voice_stream import _should_flush_tts_text
from app.core.utils import utcnow


def settings(**overrides):
    values = {
        "ai_stt_provider": "disabled",
        "ai_tts_provider": "disabled",
        "ai_realtime_provider": "disabled",
        "ai_realtime_timeout_seconds": 300,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_disabled_provider_returns_clear_http_error() -> None:
    service = AIAudioService(settings())

    with pytest.raises(Exception) as exc_info:
        service.transcribe(None)  # type: ignore[arg-type]

    assert getattr(exc_info.value, "status_code", None) == 503
    assert "provider is not configured" in exc_info.value.detail


def test_sanitize_speech_text_removes_markdown_and_limits_length() -> None:
    text = """
    # 标题
    | a | b |
    好了，已经切到下一步。
    ```json
    {"internal": true}
    ```
    """

    result = sanitize_speech_text(text, max_chars=20)

    assert result == "标题 好了，已经切到下一步。"


def test_create_cooking_session_stores_ttl_state() -> None:
    realtime_voice_session_store.clear()
    service = AIAudioService(settings(ai_realtime_provider="dashscope"))

    session = service.create_cooking_session(
        CookingRealtimeSessionRequest(
            provider="dashscope",
            family_id="family-test",
            user_id="user-test",
            recipe_id="recipe-test",
            cook_session_id="cook-test",
            session_revision=7,
            subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
        )
    )

    state = realtime_voice_session_store.require_owner(session.session_id, family_id="family-test", user_id="user-test")
    assert session.mode == "agent_backed_websocket"
    assert state.provider == "dashscope"
    assert state.recipe_id == "recipe-test"
    assert state.cook_session_id == "cook-test"
    assert state.session_revision == 7


def test_extract_qwen_asr_delta_text_supports_realtime_subtitle_event() -> None:
    text = _extract_qwen_asr_delta_text(
        {
            "type": "conversation.item.input_audio_transcription.text",
            "text": " 下一 ",
        }
    )

    assert text == "下一"


def test_dashscope_qwen_asr_payload_uses_audio_content_shape() -> None:
    payload = _dashscope_stt_payload(
        model="qwen3-asr-flash",
        audio_data_url="data:audio/mpeg;base64,ZmFrZQ==",
        content_type="audio/mpeg",
        sample_rate=16000,
    )

    content = payload["input"]["messages"][1]["content"][0]
    assert content == {"audio": "data:audio/mpeg;base64,ZmFrZQ=="}
    assert payload["parameters"]["asr_options"] == {"enable_itn": False}


def test_cooking_voice_tts_text_flushes_on_sentence_sized_chunks() -> None:
    assert not _should_flush_tts_text("好")
    assert not _should_flush_tts_text("先把锅")
    assert _should_flush_tts_text("先把锅烧热。")
    assert _should_flush_tts_text("这一步先把锅烧热，然后倒一点油，等油温上来再放葱姜蒜炒香")


def test_qwen_tts_realtime_stream_yields_audio_before_text_input_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_assertion() -> None:
        sent_event_types: list[str] = []

        class FakeWebSocket:
            def __init__(self) -> None:
                self.messages: asyncio.Queue[str] = asyncio.Queue()

            async def send(self, raw: str) -> None:
                event = json.loads(raw)
                sent_event_types.append(str(event.get("type") or ""))
                if event.get("type") == "input_text_buffer.commit":
                    await self.messages.put(
                        json.dumps({
                            "type": "response.audio.delta",
                            "delta": base64.b64encode(b"first-audio").decode("ascii"),
                        })
                    )

            async def recv(self) -> str:
                return await self.messages.get()

        class FakeConnection:
            def __init__(self) -> None:
                self.websocket = FakeWebSocket()

            async def __aenter__(self) -> FakeWebSocket:
                return self.websocket

            async def __aexit__(self, *_args: object) -> None:
                return None

        monkeypatch.setitem(
            sys.modules,
            "websockets",
            SimpleNamespace(connect=lambda *_args, **_kwargs: FakeConnection()),
        )

        async def text_chunks():
            yield "第一句。"
            await asyncio.Event().wait()

        stream = _qwen_tts_realtime_stream(
            url="wss://dashscope.example/realtime",
            api_key="test-key",
            text_chunks=text_chunks(),
            voice="Cherry",
            audio_format="pcm",
            sample_rate=24000,
            language_type="Chinese",
            timeout_seconds=1,
        )
        try:
            first_audio_event = None
            while first_audio_event is None:
                event = await asyncio.wait_for(anext(stream), timeout=1)
                if event["type"] == "audio_delta":
                    first_audio_event = event
        finally:
            await stream.aclose()

        assert first_audio_event["audio"] == b"first-audio"
        assert "input_text_buffer.commit" in sent_event_types

    asyncio.run(run_assertion())


def test_realtime_session_store_keeps_one_active_session_per_user() -> None:
    realtime_voice_session_store.clear()
    now = utcnow()
    first = RealtimeVoiceSessionState(
        session_id="voice_session-first",
        family_id="family-test",
        user_id="user-test",
        provider="dashscope",
        recipe_id="recipe-a",
        cook_session_id="cook-a",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(minutes=10),
    )
    second = RealtimeVoiceSessionState(
        session_id="voice_session-second",
        family_id="family-test",
        user_id="user-test",
        provider="openai",
        recipe_id="recipe-b",
        cook_session_id="cook-b",
        session_revision=2,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(minutes=10),
    )

    realtime_voice_session_store.put(first)
    realtime_voice_session_store.put(second)

    assert realtime_voice_session_store.get("voice_session-second").recipe_id == "recipe-b"
    with pytest.raises(Exception) as exc_info:
        realtime_voice_session_store.get("voice_session-first")
    assert getattr(exc_info.value, "status_code", None) == 404
