from __future__ import annotations

import asyncio
import base64
import io
import json
import sys
import wave
from contextlib import asynccontextmanager
from dataclasses import replace
from decimal import Decimal
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.services.ai_audio import service as audio_service_module
from app.services.ai_audio import dashscope_audio as dashscope_audio_module
from app.services.ai_audio.service import AIAudioService, SpeechResultCache
from app.services.ai_audio.realtime import RealtimeVoiceSessionState, realtime_voice_session_store
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest,
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
)
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import AudioDurationError, measure_audio_duration_seconds
from app.services.ai_audio.dashscope_audio import (
    DashScopeAudioProvider,
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


def _wav_payload(*, seconds: int, sample_rate: int = 16000) -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"\x00\x00" * sample_rate * seconds)
    return payload.getvalue()


def _webm_payload(*, seconds: int, sample_rate: int = 48000) -> bytes:
    import av

    payload = io.BytesIO()
    container = av.open(payload, mode="w", format="webm")
    stream = container.add_stream("opus", rate=sample_rate)
    frame = av.AudioFrame(format="s16", layout="mono", samples=sample_rate * seconds)
    frame.sample_rate = sample_rate
    frame.planes[0].update(b"\x00\x00" * sample_rate * seconds)
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return payload.getvalue()


def test_server_duration_ignores_client_claim_for_wav() -> None:
    measured = measure_audio_duration_seconds(
        _wav_payload(seconds=1),
        content_type="audio/wav",
        metadata={"duration_seconds": 0.01},
    )

    assert measured == Decimal("1.000000")


def test_server_duration_ignores_client_claim_for_webm() -> None:
    measured = measure_audio_duration_seconds(
        _webm_payload(seconds=1),
        content_type="audio/webm",
        metadata={"duration_seconds": 0.01},
    )

    # Opus/WebM carries codec delay, so use a narrow decode-based tolerance
    # rather than trusting the spoofed client-side duration.
    assert float(measured) == pytest.approx(1, rel=0.05)


def test_server_duration_measures_validated_pcm_frames() -> None:
    measured = measure_audio_duration_seconds(
        b"\x00\x00" * 16000,
        content_type="audio/pcm",
        metadata={"sample_rate": 16000, "sample_width_bytes": 2, "channels": 1},
    )

    assert measured == Decimal("1.000000")


def test_server_duration_rejects_invalid_audio_and_oversized_duration() -> None:
    with pytest.raises(AudioDurationError, match="audio_duration_invalid"):
        measure_audio_duration_seconds(
            b"not-an-audio-container",
            content_type="audio/webm",
            metadata={},
        )


def test_local_tts_cache_hit_skips_a_second_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    class FakeOpenAIAudioProvider:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            return None

        def synthesize(self, _request: SpeechRequest) -> SpeechResult:
            nonlocal calls
            calls += 1
            return SpeechResult(
                content_type="audio/mpeg",
                audio_bytes=b"cached-audio",
                audio_stream=None,
                external_url=None,
                external_url_expires_at=None,
                provider="openai",
                model="tts-test",
            )

    monkeypatch.setattr(audio_service_module, "OpenAIAudioProvider", FakeOpenAIAudioProvider)
    service = AIAudioService(
        settings(
            ai_tts_provider="openai",
            ai_tts_model="tts-test",
            ai_tts_voice="default",
            model_usage_required=False,
        ),
        cache=SpeechResultCache(),
    )
    request = SpeechRequest(
        text="做好啦！",
        surface="recipe_cook_page",
        family_id="family-test",
        user_id="user-test",
        operation_id="tts-operation-cache",
    )

    first = service.synthesize(request)
    second = service.synthesize(replace(request, operation_id="tts-operation-cache-retry"))

    assert first.audio_bytes == second.audio_bytes == b"cached-audio"
    assert calls == 1
    with pytest.raises(AudioDurationError, match="audio_duration_exceeded"):
        measure_audio_duration_seconds(
            _wav_payload(seconds=2),
            content_type="audio/wav",
            metadata={},
            max_duration_seconds=Decimal("1"),
        )


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


def test_realtime_session_creation_installs_scope_without_opening_a_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    realtime_voice_session_store.clear()
    sentinel_adapter = object()
    calls: list[str] = []

    def build_adapter(*_args: object, provider: str, **_kwargs: object) -> object:
        calls.append(provider)
        return sentinel_adapter

    monkeypatch.setattr(audio_service_module, "_realtime_usage_adapter", build_adapter)
    service = AIAudioService(
        settings(
            ai_realtime_provider="dashscope",
            ai_realtime_model="realtime-test",
            model_usage_required=True,
        )
    )

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

    state = realtime_voice_session_store.require_owner(
        session.session_id,
        family_id="family-test",
        user_id="user-test",
    )
    assert calls == ["dashscope"]
    assert state.realtime_usage_scope is not None
    assert state.realtime_usage_scope.usage_adapter is sentinel_adapter
    assert state.active_usage_lease is None
    assert state.next_lease_sequence == 1


def test_realtime_usage_required_fails_closed_without_a_configured_variant() -> None:
    service = AIAudioService(
        settings(
            ai_realtime_provider="dashscope",
            ai_realtime_model="",
            model_usage_required=True,
        )
    )

    with pytest.raises(Exception) as exc_info:
        service.create_cooking_session(
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

    assert getattr(exc_info.value, "status_code", None) == 503
    assert exc_info.value.detail["code"] == "realtime_billing_variant_required"


def test_dashscope_realtime_asr_records_server_input_in_its_realtime_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ActiveOperation:
        decision = "active"
        error_code = None

        def __init__(self) -> None:
            self.input_durations: list[Decimal] = []

        def add_input_seconds(self, value: Decimal) -> None:
            self.input_durations.append(value)

    class Scope:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []
            self.operation = ActiveOperation()

        @asynccontextmanager
        async def provider_audio_operation(self, *, turn_id: str, segment: str):
            self.calls.append((turn_id, segment))
            yield self.operation

    async def fake_transcribe(**_kwargs: object) -> str:
        return "下一步"

    monkeypatch.setattr(
        dashscope_audio_module,
        "_qwen_asr_realtime_transcribe",
        fake_transcribe,
    )
    provider = DashScopeAudioProvider(
        SimpleNamespace(
            ai_stt_api_key="test-key",
            dashscope_api_key="test-key",
            ai_realtime_model="qwen-realtime-test",
            ai_stt_model="",
            ai_realtime_api_base="wss://dashscope.example/realtime",
            ai_realtime_input_sample_rate=16000,
            ai_realtime_timeout_seconds=5,
        ),
        capability="stt",
    )
    scope = Scope()
    request = TranscriptionRequest(
        audio_bytes=b"\x00\x00" * 16000,
        filename="voice.pcm",
        content_type="audio/pcm",
        surface="recipe_cook_page",
        family_id="family-test",
        user_id="user-test",
        operation_id="realtime-asr-operation",
        metadata={"sample_rate": 16000, "sample_width_bytes": 2, "channels": 1},
    )

    result = asyncio.run(
        provider.transcribe_realtime_audio(
            request,
            realtime_usage_scope=scope,  # type: ignore[arg-type]
            realtime_turn_id="turn-realtime-asr",
        )
    )

    assert result.text == "下一步"
    assert scope.calls == [("turn-realtime-asr", "duplex")]
    assert scope.operation.input_durations == [Decimal("1.000000")]


def test_dashscope_realtime_asr_rejects_a_pcm_segment_over_one_lease_before_provider_send(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One realtime ASR provider operation cannot outlive its 30-second lease."""

    calls = 0

    class ActiveOperation:
        decision = "active"
        error_code = None

        def add_input_seconds(self, _value: Decimal) -> None:
            return None

    class Scope:
        @asynccontextmanager
        async def provider_audio_operation(self, *, turn_id: str, segment: str):
            assert (turn_id, segment) == ("turn-realtime-asr-long", "duplex")
            yield ActiveOperation()

    async def fake_transcribe(**_kwargs: object) -> str:
        nonlocal calls
        calls += 1
        return "不应发送"

    monkeypatch.setattr(
        dashscope_audio_module,
        "_qwen_asr_realtime_transcribe",
        fake_transcribe,
    )
    provider = DashScopeAudioProvider(
        SimpleNamespace(
            ai_stt_api_key="test-key",
            dashscope_api_key="test-key",
            ai_realtime_model="qwen-realtime-test",
            ai_stt_model="",
            ai_realtime_api_base="wss://dashscope.example/realtime",
            ai_realtime_input_sample_rate=16000,
            ai_realtime_timeout_seconds=5,
        ),
        capability="stt",
    )
    request = TranscriptionRequest(
        audio_bytes=b"\x00\x00" * 16000 * 31,
        filename="voice.pcm",
        content_type="audio/pcm",
        surface="recipe_cook_page",
        family_id="family-test",
        user_id="user-test",
        operation_id="realtime-asr-long-operation",
        metadata={"sample_rate": 16000, "sample_width_bytes": 2, "channels": 1},
    )

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            provider.transcribe_realtime_audio(
                request,
                realtime_usage_scope=Scope(),  # type: ignore[arg-type]
                realtime_turn_id="turn-realtime-asr-long",
            )
        )

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail["code"] == "realtime_audio_lease_duration_exceeded"
    assert calls == 0


def test_dashscope_realtime_tts_records_server_output_in_its_realtime_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ActiveOperation:
        decision = "active"
        error_code = None

        def __init__(self) -> None:
            self.output_durations: list[Decimal] = []

        def add_output_seconds(self, value: Decimal) -> None:
            self.output_durations.append(value)

    class Scope:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []
            self.operation = ActiveOperation()

        @asynccontextmanager
        async def provider_audio_operation(self, *, turn_id: str, segment: str):
            self.calls.append((turn_id, segment))
            yield self.operation

    async def fake_tts_stream(**_kwargs: object):
        yield {"type": "audio", "audio": b"\x00\x00" * 24000}

    async def text_chunks():
        yield "做好啦。"

    monkeypatch.setattr(
        dashscope_audio_module,
        "_qwen_tts_realtime_stream",
        fake_tts_stream,
    )
    provider = DashScopeAudioProvider(
        SimpleNamespace(
            ai_tts_api_key="test-key",
            dashscope_api_key="test-key",
            ai_tts_model="qwen-realtime-test",
            ai_realtime_voice="Cherry",
            ai_tts_voice="Cherry",
            ai_realtime_output_sample_rate=24000,
            ai_tts_language_type="Chinese",
            ai_realtime_timeout_seconds=5,
            ai_realtime_api_base="wss://dashscope.example/realtime",
        ),
        capability="tts",
    )
    scope = Scope()

    async def run() -> list[dict]:
        return [
            event
            async for event in provider.stream_realtime_text(
                text_chunks(),
                SpeechRequest(
                    text="",
                    surface="recipe_cook_page",
                    family_id="family-test",
                    user_id="user-test",
                    operation_id="realtime-tts-operation",
                ),
                realtime_usage_scope=scope,  # type: ignore[arg-type]
                realtime_turn_id="turn-realtime-tts",
            )
        ]

    events = asyncio.run(run())

    assert events[-1] == {"type": "audio_done", "sequence": 1}
    assert scope.calls == [("turn-realtime-tts", "duplex")]
    assert scope.operation.output_durations == [Decimal("1.000000")]


def test_dashscope_realtime_tts_response_records_server_output_in_its_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ActiveOperation:
        decision = "active"
        error_code = None

        def __init__(self) -> None:
            self.output_durations: list[Decimal] = []

        def add_output_seconds(self, value: Decimal) -> None:
            self.output_durations.append(value)

    class Scope:
        def __init__(self) -> None:
            self.operation = ActiveOperation()

        @asynccontextmanager
        async def provider_audio_operation(self, *, turn_id: str, segment: str):
            assert (turn_id, segment) == ("turn-realtime-tts-response", "duplex")
            yield self.operation

    async def fake_tts(**_kwargs: object) -> bytes:
        return b"\x00\x00" * 24000

    monkeypatch.setattr(dashscope_audio_module, "_qwen_tts_realtime_synthesize", fake_tts)
    provider = DashScopeAudioProvider(
        SimpleNamespace(
            ai_tts_api_key="test-key",
            dashscope_api_key="test-key",
            ai_tts_model="qwen-realtime-test",
            ai_realtime_voice="Cherry",
            ai_tts_voice="Cherry",
            ai_tts_format="pcm",
            ai_realtime_output_sample_rate=24000,
            ai_tts_language_type="Chinese",
            ai_realtime_timeout_seconds=5,
            ai_realtime_api_base="wss://dashscope.example/realtime",
        ),
        capability="tts",
    )
    scope = Scope()

    speech = asyncio.run(
        provider.synthesize_realtime_text(
            SpeechRequest(
                text="做好啦。",
                surface="recipe_cook_page",
                family_id="family-test",
                user_id="user-test",
                operation_id="realtime-tts-response-operation",
            ),
            realtime_usage_scope=scope,  # type: ignore[arg-type]
            realtime_turn_id="turn-realtime-tts-response",
        )
    )

    assert speech.audio_bytes is not None
    assert scope.operation.output_durations == [Decimal("1.000000")]


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


def test_realtime_session_store_requires_matching_family_and_owner() -> None:
    realtime_voice_session_store.clear()
    now = utcnow()
    state = RealtimeVoiceSessionState(
        session_id="voice_session-owner-isolation",
        family_id="family-owner",
        user_id="user-owner",
        provider="dashscope",
        recipe_id="recipe-owner",
        cook_session_id="cook-owner",
        session_revision=1,
        subject={"source": "recipe_cook_page"},
        created_at=now,
        expires_at=now + timedelta(minutes=10),
    )
    realtime_voice_session_store.put(state)

    assert realtime_voice_session_store.require_owner(
        state.session_id,
        family_id="family-owner",
        user_id="user-owner",
    ) is state
    for family_id, user_id in (("family-other", "user-owner"), ("family-owner", "user-other")):
        with pytest.raises(Exception) as exc_info:
            realtime_voice_session_store.require_owner(
                state.session_id,
                family_id=family_id,
                user_id=user_id,
            )
        assert getattr(exc_info.value, "status_code", None) == 403
