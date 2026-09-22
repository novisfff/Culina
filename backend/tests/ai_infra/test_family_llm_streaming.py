from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

import pytest

from app.ai.errors import AIExecutionCancelled
from app.ai.runtime.execution_guard import GuardedChatProvider
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from tests.family_model_settings.test_provider_streaming import FIRST, TAIL, deferred, gated_server, local_transport
from tests.model_usage.test_llm_provider_contract import ATTRIBUTION


RESP_FIRST = b'data: {"type":"response.output_text.delta","delta":"A"}\n\n'
RESP_TAIL = b'data: {"type":"response.completed","response":{"id":"request-stream","model":"model-stream","usage":{"prompt_tokens":4,"completion_tokens":2},"output":[]}}\n\n'


class UsageAdapter:
    def __init__(self):
        self.timeline = []
        self.receipts = []

    def start_round(self, attribution, **kwargs):
        self.timeline.append("reserve")
        return self

    def prepare_dispatch(self):
        self.timeline.append("dispatch")
        return SimpleNamespace(credential_secret_version_id="secret-v1", provider_idempotency_key="test-idempotency")

    def receipt_from_openai_usage(self, permit, **kwargs):
        self.receipts.append(kwargs)
        return kwargs

    def settle(self, receipt):
        self.timeline.append("settle")

    def mark_uncertain(self, code):
        self.timeline.append(f"uncertain:{code}")


def provider_for(transport, protocol, *, metered=True):
    adapter = UsageAdapter()
    facade = deferred(transport)
    cls = OpenAICompatibleChatProvider if protocol == "chat" else OpenAIResponsesChatProvider
    provider = cls(binding=facade.binding, transport=transport, resolve_dispatch_credential=facade.resolve_credential,
                   usage_adapter=adapter if metered else None, model_usage_required=metered)
    return provider, adapter


@pytest.mark.parametrize("protocol", ["chat", "responses"])
@pytest.mark.parametrize("proxy", [False, True])
@pytest.mark.parametrize("mode", ["tools", "text"])
def test_provider_delivers_real_network_delta_before_tail_and_settles_final_usage(monkeypatch, protocol, proxy, mode):
    first, tail = (FIRST, TAIL) if protocol == "chat" else (RESP_FIRST, RESP_TAIL)
    with gated_server(first=first, tail=tail) as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy)
        provider, adapter = provider_for(transport, protocol)
        consumed = Event()
        chunks = []

        def message(delta):
            chunks.append(delta)
            consumed.set()

        def invoke():
            if mode == "tools":
                return provider.generate_with_tools(system="test", user="test", tools=lambda: [],
                    tool_handler=lambda *_: {}, message_handler=message, usage_attribution=ATTRIBUTION)
            for delta in provider.stream_generate(system="test", user="test", usage_attribution=ATTRIBUTION):
                message(delta)

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(invoke)
            try:
                assert consumed.wait(1), "provider buffered the delta until completion"
                assert chunks == ["A"]
                assert "settle" not in adapter.timeline
                assert not release.is_set()
                release.set()
                result = future.result(timeout=2)
            finally:
                release.set()
        if mode == "tools":
            assert result.status == "completed"
        assert adapter.timeline == ["reserve", "dispatch", "settle"]
        assert adapter.receipts[0]["raw_usage"] == {"prompt_tokens": 4, "completion_tokens": 2}
        assert len(calls) == 1
        assert calls[0][1]["Idempotency-Key"] == "test-idempotency"


@pytest.mark.parametrize("protocol", ["chat", "responses"])
@pytest.mark.parametrize("metered", [False, True])
@pytest.mark.parametrize("partial_text", [False, True])
def test_network_eof_never_replays_an_ambiguous_call(monkeypatch, protocol, metered, partial_text):
    first = (FIRST if protocol == "chat" else RESP_FIRST) if partial_text else b": keepalive\n\n"
    with gated_server(first=first, tail=b"") as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port)
        provider, adapter = provider_for(transport, protocol, metered=metered)
        release.set()
        result = provider.generate_with_tools(system="test", user="test", tools=lambda: [],
            tool_handler=lambda *_: {}, usage_attribution=ATTRIBUTION if metered else None)
        assert result.status == "failed"
        assert len(calls) == 1
        assert "settle" not in adapter.timeline
        if metered:
            assert adapter.timeline[:2] == ["reserve", "dispatch"]
            assert adapter.timeline[2].startswith("uncertain:")
            assert len(adapter.timeline) == 3


@pytest.mark.parametrize("protocol", ["chat", "responses"])
@pytest.mark.parametrize("proxy", [False, True])
def test_guarded_run_cancels_idle_network_stream_and_preserves_uncertain_usage(monkeypatch, protocol, proxy):
    first, tail = (FIRST, TAIL) if protocol == "chat" else (RESP_FIRST, RESP_TAIL)
    consumed, cancelled = Event(), Event()
    guard_calls = []

    def check_cancel():
        if cancelled.is_set():
            raise AIExecutionCancelled("cancelled")

    with gated_server(first=first, tail=tail) as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port, proxy=proxy, request_timeout_seconds=4)
        provider, adapter = provider_for(transport, protocol)
        guarded = GuardedChatProvider(provider, lambda: guard_calls.append("dispatch-check"), cancel_check=check_cancel)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(guarded.generate_with_tools, system="test", user="test", tools=lambda: [],
                                 tool_handler=lambda *_: {}, message_handler=lambda _: consumed.set(),
                                 usage_attribution=ATTRIBUTION)
            try:
                assert consumed.wait(2)
                checks_before_cancel = len(guard_calls)
                cancelled.set()
                with pytest.raises(AIExecutionCancelled):
                    future.result(timeout=1)
                assert finished.wait(1)
                assert not release.is_set()
                assert len(guard_calls) == checks_before_cancel
            finally:
                release.set()
        assert "settle" not in adapter.timeline
        assert len(adapter.timeline) == 3 and adapter.timeline[-1].endswith("cancelled")
        assert len(calls) == 1


@pytest.mark.parametrize("protocol", ["chat", "responses"])
def test_partial_text_stream_raises_instead_of_ending_successfully(monkeypatch, protocol):
    with gated_server(first=FIRST if protocol == "chat" else RESP_FIRST, tail=b"") as (port, sent, release, finished, calls):
        transport, _ = local_transport(monkeypatch, port)
        provider, adapter = provider_for(transport, protocol)
        release.set()
        stream = provider.stream_generate(system="test", user="test", usage_attribution=ATTRIBUTION)
        assert next(stream) == "A"
        with pytest.raises(Exception, match="family_model_provider_stream_incomplete"):
            next(stream)
        assert adapter.timeline == ["reserve", "dispatch", "uncertain:" + (
            "provider_stream_transport_ambiguous" if protocol == "chat" else "provider_responses_stream_transport_ambiguous"
        )]
        assert len(calls) == 1
