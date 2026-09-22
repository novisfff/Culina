from __future__ import annotations

import json

import pytest

from app.ai.runtime.family_transport import _sse_events
from app.services.family_model_settings.errors import FamilyModelProviderTransportError
from app.services.family_model_settings.streaming import ProviderStreamResponse


def response(chunks, *, content_type="text/event-stream"):
    return ProviderStreamResponse(200, {"Content-Type": content_type}, iter(chunks), 4096, lambda: None)


@pytest.mark.parametrize("size", [1, 2, 7, 4096])
@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_incremental_utf8_multiline_sse_and_tail_usage(size, newline):
    wire = newline.join([
        '\ufeff: heartbeat', 'event: message', 'data: {"choices":',
        'data: [{"delta":{"content":"晚餐🍜"}}]}', '',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}', '',
        'data: [DONE]', '', '',
    ]).encode()
    chunks = [wire[index:index + size] for index in range(0, len(wire), size)]
    assert list(_sse_events(response(chunks))) == [
        {"choices": [{"delta": {"content": "晚餐🍜"}}]},
        {"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2}},
    ]


@pytest.mark.parametrize("terminal", [
    b'data: [DONE]\n\n',
    b'data: {"type":"response.completed","response":{"usage":{"input_tokens":1}}}\n\n',
])
def test_terminal_event_does_not_wait_for_http_eof(terminal):
    def chunks():
        yield b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
        yield terminal
        raise AssertionError("terminal event must close an otherwise idle connection")

    events = _sse_events(response(chunks()))
    assert next(events)["choices"][0]["delta"]["content"] == "first"
    assert len(list(events)) == (0 if b"[DONE]" in terminal else 1)


@pytest.mark.parametrize("wire", [
    b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    b'data: {"unfinished":true}',
    b'data: [DONE]\n',
    b'data: {bad json}\n\n',
    b'data: []\n\n',
    b'data: {"content":"\xe6\x99',
    b'data: {"error":{"message":"sensitive provider payload"}}\n\ndata: [DONE]\n\n',
])
def test_malformed_or_truncated_stream_is_not_silently_successful(wire):
    with pytest.raises(FamilyModelProviderTransportError) as caught:
        list(_sse_events(response([wire])))
    assert "sensitive provider payload" not in str(caught.value)


def test_non_sse_json_compatibility_remains_bounded():
    wire = json.dumps({"choices": [{"message": {"content": "hello"}}]}).encode()
    assert list(_sse_events(response([wire[:4], wire[4:]], content_type="application/json"))) == [
        {"choices": [{"message": {"content": "hello"}}]},
    ]


def test_stream_cannot_reset_size_accounting_with_a_second_iterator():
    stream = response([b"first", b"second"])
    original = stream.iter_bytes()
    assert next(original) == b"first"
    with pytest.raises(FamilyModelProviderTransportError, match="already_consumed"):
        next(stream.iter_bytes())
    original.close()
