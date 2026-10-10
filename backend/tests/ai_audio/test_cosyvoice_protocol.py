"""Native CosyVoice task contracts, exercised through the real shared transport."""

import json
from collections import deque
from dataclasses import replace
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException

from app.services.ai_audio.config import resolved_audio_provider_config
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.providers import AudioProviderDependencies
from app.services.family_model_settings.capability_tests import _run_http_probe
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.probe_contracts import audio_preview, silence_wav
from app.services.family_model_settings.transport import ProviderTransport, ProviderTransportSettings
from app.services.family_model_settings.types import DispatchCredential
from tests.ai_audio.test_ai_audio_service import _AudioAdapter, _binding, _speech_request


class CosyVoiceSocket:
    def __init__(self, *, failure=None, audio=None):
        self.failure = failure
        self.audio = silence_wav() if audio is None else audio
        self.sent = []
        self.events = deque()
        self.started = False
        self.closed = False
        self.task_id = None

    def event(self, kind):
        task_id = 'another-task' if self.failure == 'wrong_task_id' else self.task_id
        return {'header': {'event': kind, 'task_id': task_id}, 'payload': {}}

    def send(self, raw):
        assert not self.closed
        event = json.loads(raw)
        self.sent.append(event)
        header = event['header']
        assert header['streaming'] == 'duplex'
        action = header['action']
        if action == 'run-task':
            assert self.task_id is None
            self.task_id = header['task_id']
            UUID(self.task_id)
            payload = event['payload']
            assert payload['task_group'] == 'audio' and payload['task'] == 'tts'
            assert payload['function'] == 'SpeechSynthesizer'
            assert payload['input'] == {}
            assert payload['parameters']['text_type'] == 'PlainText'
            assert 'language_type' not in payload['parameters']
            self.events.append(self.event('task-failed' if self.failure == 'task_failed' else 'task-started'))
        elif action == 'continue-task':
            assert self.started and header['task_id'] == self.task_id
            assert isinstance(event['payload']['input']['text'], str)
            self.events.append(self.event('result-generated'))
            if self.failure != 'no_audio':
                self.events.extend([self.audio[:20], self.audio[20:]])
        else:
            assert action == 'finish-task' and self.started
            assert header['task_id'] == self.task_id and event['payload']['input'] == {}
            self.events.append(self.event('task-finished'))

    def recv(self, timeout=None):
        assert timeout > 0 and not self.closed
        if self.failure == 'timeout':
            raise TimeoutError('synthetic timeout')
        event = self.events.popleft()
        if isinstance(event, bytes):
            return event
        if event['header']['event'] == 'task-started':
            self.started = True
        return json.dumps(event)

    def close(self):
        self.closed = True


def setup(*, model='cosyvoice-v3-plus', voice=None, output_format='wav', failure=None, max_bytes=1024 * 1024):
    binding = _binding(adapter_kind='dashscope', options={'output_format': output_format, 'voice': voice})
    endpoint = replace(binding.endpoint, normalized_url='https://dashscope.aliyuncs.com/api/v1',
        host='dashscope.aliyuncs.com', base_path='/api/v1')
    ws_endpoint = replace(endpoint, normalized_url='wss://dashscope.aliyuncs.com/api-ws/v1',
        scheme='wss', base_path='/api-ws/v1')
    binding = replace(binding, requested_model=model, billing_model=model, endpoint=endpoint, websocket_endpoint=ws_endpoint)
    timeline = []
    sockets = []

    def connect(*, endpoint, headers, **kwargs):
        assert endpoint.normalized_url == 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
        assert endpoint.resolved_addresses == ('93.184.216.34',)
        assert headers['Authorization'] == 'Bearer synthetic-key'
        timeline.append('connect')
        socket = CosyVoiceSocket(failure=failure)
        sockets.append(socket)
        return socket

    def unexpected_http(**kwargs):
        pytest.fail('CosyVoice must use its task WebSocket, not the Qwen TTS HTTP endpoint')

    transport = ProviderTransport(
        policy=ProviderNetworkPolicy(resolver=SimpleNamespace(resolve_all=lambda _: ('93.184.216.34',))),
        settings=ProviderTransportSettings(1, 2, max_bytes, max_bytes, 0),
        websocket_dialer=SimpleNamespace(connect=connect),
        http_dialer=SimpleNamespace(request=unexpected_http),
    )

    def credential(resolved, secret):
        assert resolved is binding and secret == 'secret-rotated'
        timeline.append('credential')
        return DispatchCredential('family-a', 'profile-a', secret, 'synthetic-key')

    provider = DashScopeAudioProvider(resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(transport, credential), usage_adapter=_AudioAdapter(binding, timeline))
    return binding, provider, transport, sockets, timeline


@pytest.mark.parametrize(('model', 'voice', 'expected_voice'), [
    ('cosyvoice-v3-plus', None, 'longanyang'),
    ('cosyvoice-v2', None, 'longxiaochun'),
    ('cosyvoice-v3-flash', 'custom-cloned-voice', 'custom-cloned-voice'),
])
def test_runtime_uses_cosyvoice_task_protocol_and_returns_binary_audio(model, voice, expected_voice):
    _, provider, _, sockets, timeline = setup(model=model, voice=voice)
    result = provider.synthesize(_speech_request())
    assert result.audio_bytes == silence_wav() and result.content_type == 'audio/wav'
    socket = sockets[0]
    assert [event['header']['action'] for event in socket.sent] == ['run-task', 'continue-task', 'finish-task']
    assert socket.sent[0]['payload']['model'] == model
    assert socket.sent[0]['payload']['parameters']['voice'] == expected_voice
    assert socket.sent[1]['payload']['input']['text'] == _speech_request().text
    assert socket.closed
    assert timeline == ['begin', 'dispatch', 'credential', 'connect', 'receipt', 'settle']


def test_cosyvoice_capability_probe_uses_the_same_task_protocol_and_audio_preview():
    binding, _, transport, sockets, _ = setup()
    response = _run_http_probe(binding=binding, permit=SimpleNamespace(provider_idempotency_key='test-probe'),
        credential=DispatchCredential('family-a', 'profile-a', None, 'synthetic-key'), transport=transport)
    assert response.status_code == 200
    assert audio_preview(binding, response, transport).startswith('data:audio/wav;base64,')
    assert sockets[0].sent[1]['payload']['input']['text'] == '能力测试。'
    assert sockets[0].closed


@pytest.mark.parametrize('failure', ['task_failed', 'wrong_task_id', 'no_audio', 'timeout'])
def test_cosyvoice_failure_closes_and_retains_uncertainty_without_resending(failure):
    _, provider, _, sockets, timeline = setup(failure=failure)
    with pytest.raises(HTTPException) as exc:
        provider.synthesize(_speech_request())
    assert exc.value.status_code == 502
    assert len(sockets) == 1 and sockets[0].closed
    assert timeline == ['begin', 'dispatch', 'credential', 'connect', 'uncertain:audio_provider_result_unavailable']


def test_cosyvoice_bounds_total_binary_audio_before_settlement():
    _, provider, _, sockets, timeline = setup(max_bytes=24)
    with pytest.raises(HTTPException):
        provider.synthesize(_speech_request())
    assert sockets[0].closed
    assert 'settle' not in timeline and timeline[-1] == 'uncertain:audio_provider_result_unavailable'


def test_cosyvoice_derives_native_websocket_when_binding_has_no_websocket_endpoint():
    binding, _, transport, sockets, timeline = setup()
    binding = replace(binding, websocket_endpoint=None)
    provider = DashScopeAudioProvider(resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(transport, lambda resolved, secret: DispatchCredential('family-a', 'profile-a', secret, 'synthetic-key')),
        usage_adapter=_AudioAdapter(binding, timeline))
    assert provider.synthesize(_speech_request()).audio_bytes == silence_wav()
    assert sockets[0].closed
