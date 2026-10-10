from dataclasses import replace
from types import SimpleNamespace
import base64
import io
import json
import wave

import pytest

from app.services.family_model_settings.capability_tests import _http_probe_request, _run_realtime_probe
from app.services.family_model_settings.probe_contracts import audio_preview, probe_response_detail, silence_wav
from app.services.family_model_settings.probe_contracts import speech_probe_matches
from app.services.family_model_settings.transport import ProviderResponse
from tests.search.test_rerank import _family_rerank_binding


def binding(capability='llm', adapter='openai_compatible_http', variant='primary', **options):
    return replace(_family_rerank_binding(), capability=capability, adapter_kind=adapter, variant_key=variant, options=options)


def response(body):
    return ProviderResponse(200, {}, json.dumps(body).encode())


@pytest.mark.parametrize('transcript, expected', [('能力测试。', True), (' 能力 测试！', True),
    ('好的，请出题吧。', False), ('能力测试完成。', False), ('', False), (None, False)])
def test_speech_probe_accepts_punctuation_but_rejects_missing_or_rewritten_words(transcript, expected):
    assert speech_probe_matches('能力测试。', transcript) is expected


def test_llm_probe_respects_protocol_and_vision_and_validates_tool_call():
    configured = binding(runtime_protocol='responses', supports_vision=True, max_output_tokens=80)
    path, payload = _http_probe_request(configured)
    assert path == 'responses'
    assert payload['max_output_tokens'] == 80
    assert payload['input'][0]['content'][1]['type'] == 'input_image'
    assert payload['store'] is False
    valid = response({'output': [{'type': 'function_call', 'name': 'capability_check', 'arguments': '{"ok":true}'}]})
    assert '图片输入' in probe_response_detail(configured, valid)
    with pytest.raises(ValueError):
        probe_response_detail(configured, response({'output': []}))


@pytest.mark.parametrize('adapter', ['openai_compatible_http', 'dashscope'])
def test_reference_image_probe_uses_edit_contract(adapter):
    path, payload = _http_probe_request(binding('image_generation', adapter, 'reference'))
    if adapter == 'dashscope':
        assert path.endswith('multimodal-generation/generation')
        assert payload['input']['messages'][0]['content'][0]['image'].startswith('data:image/png')
    else:
        assert path == 'images/edits'
        assert 'image' not in payload and 'image_mime_type' not in payload
        assert payload['size'] == '1536x1024'


def test_audio_options_are_in_probe_and_silence_is_a_real_one_second_wav():
    with wave.open(io.BytesIO(silence_wav())) as audio:
        assert audio.getnframes() == audio.getframerate() == 16000
    _, stt = _http_probe_request(binding('stt', 'dashscope', 'default', language_hint='zh', hotwords=['藜麦']))
    assert stt['parameters']['language'] == 'zh'
    assert stt['parameters']['hotwords'] == ['藜麦']
    _, tts = _http_probe_request(binding('tts', voice='custom', output_format='wav'))
    assert tts['voice'] == 'custom'
    assert tts['response_format'] == 'wav'


@pytest.mark.parametrize('vector', [[0.2], [0.2, float('nan')], []])
def test_embedding_probe_rejects_wrong_dimensions_or_nonfinite_values(vector):
    with pytest.raises(Exception):
        probe_response_detail(binding('embedding', dimensions=2), response({'data': [{'index': 0, 'embedding': vector}]}))


def test_dashscope_embedding_probe_explicitly_requests_configured_nondefault_dimension():
    configured = binding('embedding', 'dashscope', 'search', dimensions=1536)
    path, payload = _http_probe_request(configured)
    assert path == 'services/embeddings/text-embedding/text-embedding'
    assert payload['parameters'] == {'text_type': 'query', 'dimension': 1536}
    assert '1536 维' in probe_response_detail(configured, response({
        'output': {'embeddings': [{'text_index': 0, 'embedding': [0.1] * 1536}]},
    }))


def test_audio_preview_is_bounded_and_never_exposes_provider_url():
    sample = silence_wav()
    preview = audio_preview(binding('tts'), ProviderResponse(200, {}, sample), None)
    assert base64.b64decode(preview.split(',')[1]) == sample
    for data in (b'{"error":"bad"}', b'ID3' + b'a' * (512 * 1024)):
        with pytest.raises(ValueError):
            audio_preview(binding('tts'), ProviderResponse(200, {}, data), None)
    media = SimpleNamespace(content=sample)
    calls = []
    transport = SimpleNamespace(download_media=lambda url, **kw: calls.append((url, kw)) or media)
    preview = audio_preview(binding('tts', 'dashscope'), response({'output': {'audio': {'url': 'https://example.com/sample'}}}), transport)
    assert preview.startswith('data:audio/wav;')
    assert calls[0][1]['adapter_kind'] == 'dashscope'


def test_realtime_handshake_alone_is_not_success_and_socket_always_closes():
    events = iter(['{"type":"session.created"}', '{"type":"error"}'])
    closed = []
    socket = SimpleNamespace(send=lambda _: None, recv=lambda **_: next(events), close=lambda: closed.append(True))
    configured = binding('realtime_audio', 'openai_realtime')
    configured = replace(configured, websocket_endpoint=replace(configured.endpoint, scheme='wss', normalized_url='wss://example.com/realtime'))
    with pytest.raises(ValueError):
        _run_realtime_probe(binding=configured, credential=SimpleNamespace(api_key='fake'), transport=SimpleNamespace(connect_websocket=lambda *_, **__: socket))
    assert closed == [True]
