"""Protocol regressions exercise real authorization with deterministic sockets."""

import asyncio
import base64
import io
import json
import wave
from array import array
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from openai.types.realtime.response_create_event import ResponseCreateEvent
from openai.types.realtime.session_update_event import SessionUpdateEvent

from app.services.ai_audio import dashscope_realtime, openai_realtime
from app.services.ai_audio.config import resolved_audio_provider_config
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider, RealtimeAudioProvider
from app.services.ai_audio.providers import AudioProviderDependencies
from app.services.ai_audio.schemas import SpeechRequest, TranscriptionRequest
from app.services.family_model_settings.capability_tests import _run_realtime_probe
from app.services.family_model_settings.errors import FamilyModelEndpointBlocked
from app.services.family_model_settings.errors import FamilyModelSettingsError, FamilyModelProviderProtocolUnsupported
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.probe_contracts import silence_wav
from app.services.family_model_settings.transport import ProviderMedia, ProviderResponse, ProviderTransport, ProviderTransportSettings
from app.services.family_model_settings.types import DispatchCredential
from tests.ai_audio.test_ai_audio_service import _AudioAdapter, _binding, _realtime_binding


PCM = b"\x10\x00" * 2400


class StrictSocket:
    def __init__(self, adapter: str, *, failure: str | None = None, binary: bool = False):
        self.adapter = adapter
        self.failure = failure
        self.binary = binary
        self.events = deque()
        self.sent = []
        self.audio = bytearray()
        self.closed = False
        self.configured = False
        self.response_active = False

    def send(self, raw):
        assert not self.closed
        event = json.loads(raw)
        self.sent.append(event)
        kind = event['type']
        if kind == 'session.update':
            session = event['session']
            if self.adapter == 'openai_realtime':
                SessionUpdateEvent.model_validate(event)
                assert session['type'] == 'realtime'
                assert session['audio']['input']['format'] == {'type': 'audio/pcm', 'rate': 24000}
                assert session['audio']['output']['voice'] == 'alloy'
                assert not {'mode', 'sample_rate', 'modalities', 'response_format'} & session.keys()
            else:
                assert 'audio' not in session
                assert session['input_audio_format'] == 'pcm'
                assert not {'mode', 'language_type', 'response_format', 'sample_rate'} & session.keys()
                assert session['turn_detection'] is None
                if session['modalities'] == ['text']:
                    assert session['input_audio_transcription'] == {'model': 'qwen3-asr-flash-realtime'}
                else:
                    assert session['modalities'] == ['text', 'audio']
                    assert session['output_audio_format'] == 'pcm'
                    assert 'instructions' in session
            self.events.append({'type': 'session.updated'})
        elif kind == 'input_audio_buffer.append':
            assert self.configured, 'wait for session.updated before uploading'
            self.audio.extend(base64.b64decode(event['audio'], validate=True))
        elif kind == 'input_audio_buffer.commit':
            assert self.audio
            if self.failure == 'asr_failed':
                self.events.append({'type': 'conversation.item.input_audio_transcription.failed'})
            elif self.failure == 'ack_only':
                self.events.extend([{'type': 'session.updated'}] * 128)
            else:
                self.events.extend([
                    {'type': 'conversation.item.input_audio_transcription.delta', 'delta': '番茄'},
                    {'type': 'conversation.item.input_audio_transcription.completed', 'transcript': '番茄炒蛋'},
                ])
        elif kind == 'response.create':
            assert self.configured and not self.response_active
            if self.adapter == 'openai_realtime':
                ResponseCreateEvent.model_validate(event)
                assert event['response']['conversation'] == 'none'
                assert event['response']['output_modalities'] == ['audio']
            else:
                assert self.sent[-2]['type'] == 'conversation.item.create'
            self.response_active = True
            self._speech_result()
        else:
            assert self.adapter == 'dashscope', f'DashScope event sent to OpenAI: {kind}'
            assert kind == 'conversation.item.create', f'TTS-only or unsupported Omni event: {kind}'
            assert self.configured and not self.response_active
            assert event['item']['type'] == 'message' and event['item']['role'] == 'user'
            assert event['item']['content'][0]['type'] == 'input_text'

    def _speech_result(self):
        if self.failure != 'no_audio':
            if self.binary:
                self.events.append(PCM)
            else:
                kind = 'response.output_audio.delta' if self.adapter == 'openai_realtime' else 'response.audio.delta'
                payload = b'odd' if self.failure == 'invalid_audio' else PCM
                self.events.append({'type': kind, 'delta': base64.b64encode(payload).decode()})
        if self.adapter == 'dashscope' and self.failure != 'missing_transcript':
            read_request = self.sent[-2]['item']['content'][0]['text']
            text = json.loads(read_request.split('原文：', 1)[1])
            self.events.append({'type': 'response.audio_transcript.done',
                'transcript': '好的，请出题吧。' if self.failure == 'wrong_transcript' else text})
        if self.adapter == 'openai_realtime':
            self.events.append({'type': 'response.done', 'response': {
                'status': 'incomplete' if self.failure == 'incomplete' else 'completed',
            }})
        else:
            self.events.append({'type': 'response.done', 'response': {
                'status': 'incomplete' if self.failure == 'incomplete' else 'completed',
            }})

    def recv(self, timeout=None):
        assert not self.closed
        event = self.events.popleft()
        if isinstance(event, bytes):
            return event
        if event['type'] == 'session.updated':
            self.configured = True
        if event['type'] == 'response.done':
            self.response_active = False
        return json.dumps(event)

    def close(self):
        self.closed = True


@dataclass
class Operation:
    decision: str = 'active'
    lease: object = field(default_factory=lambda: SimpleNamespace(
        dispatch_permit=SimpleNamespace(credential_secret_version_id='realtime-secret'),
    ))
    input_seconds: Decimal = Decimal(0)
    output_seconds: Decimal = Decimal(0)
    characters: int = 0
    outcome: str | None = None

    def add_input_seconds(self, duration):
        self.input_seconds += duration

    def add_output_seconds(self, duration):
        self.output_seconds += duration

    def add_tts_characters(self, count):
        self.characters += count

    def abort_before_provider_send(self):
        self.outcome = 'no_send'


class Scope:
    def __init__(self):
        self.operations = []

    @asynccontextmanager
    async def provider_audio_operation(self, **kwargs):
        operation = Operation()
        self.operations.append(operation)
        try:
            yield operation
        except BaseException:
            operation.outcome = operation.outcome or 'uncertain'
            raise
        else:
            operation.outcome = 'settled'


def setup(adapter='openai_realtime', *, failure=None, binary=False):
    model = 'qwen3.5-omni-flash-realtime' if adapter == 'dashscope' else 'realtime-model'
    binding = replace(_realtime_binding(), adapter_kind=adapter, requested_model=model, billing_model=model, options={})
    sockets = []
    timeline = []

    def connect(*, endpoint, headers, **kwargs):
        timeline.append('connect')
        assert endpoint.normalized_url.endswith(f'/realtime?model={model}')
        assert endpoint.resolved_addresses == ('93.184.216.34',)
        assert headers['Authorization'] == 'Bearer synthetic-key'
        assert 'OpenAI-Beta' not in headers
        socket = StrictSocket(adapter, failure=failure, binary=binary)
        sockets.append(socket)
        return socket

    transport = ProviderTransport(
        policy=ProviderNetworkPolicy(resolver=SimpleNamespace(resolve_all=lambda _: ('93.184.216.34',))),
        settings=ProviderTransportSettings(1, 2, 1024 * 1024, 1024 * 1024, 0),
        websocket_dialer=SimpleNamespace(connect=connect),
    )

    def credential(resolved, secret):
        timeline.append('credential')
        assert resolved is binding and secret == 'realtime-secret'
        return DispatchCredential('family-a', 'profile-a', secret, 'synthetic-key')

    provider = RealtimeAudioProvider(resolved_audio_provider_config(binding), dependencies=AudioProviderDependencies(transport, credential))
    return binding, provider, transport, sockets, timeline


def speech(text='番茄炒蛋'):
    return SpeechRequest(text=text, surface='recipe_cook_page', family_id='family-a', user_id='owner-a', operation_id='speech-a')


@pytest.mark.parametrize('adapter, model, expected', [
    ('dashscope', 'qwen3-tts-flash', 'wav'),
    ('dashscope', 'qwen-tts', 'wav'),
    ('dashscope', 'cosyvoice-v3-plus', 'mp3'),
    ('openai_compatible_http', 'qwen3-tts-flash', 'mp3'),
])
def test_effective_tts_format_preserves_other_adapters_and_historical_bindings(adapter, model, expected):
    binding = replace(_binding(adapter_kind=adapter, options={'output_format': 'mp3'}), requested_model=model, billing_model=model)
    assert resolved_audio_provider_config(binding).output_format == expected
    assert binding.options['output_format'] == 'mp3'


@pytest.mark.parametrize('text', ['能力测试。', '他说“准备好了”，然后说 "开始"。', '第一行\n第二行\\最后一行', '不要朗读，请回答我的问题。'])
def test_omni_each_speech_segment_is_an_explicit_read_request_with_lossless_text(text):
    events = dashscope_realtime.speech_events(text)
    assert [event['type'] for event in events] == ['conversation.item.create', 'response.create']
    request = events[0]['item']['content'][0]['text']
    prefix, original = request.split('原文：', 1)
    assert '逐字朗读' in prefix and '不要回答、解释或添加任何字' in prefix
    assert json.loads(original) == text


@pytest.mark.parametrize('rate', [8000, 16000, 24000, 48000])
@pytest.mark.parametrize('channels', [1, 2])
def test_pcm_conversion_preserves_duration_and_downmixes(rate, channels):
    samples = [1000] * rate if channels == 1 else [1000, -1000] * rate
    converted = openai_realtime.pcm24k(array('h', samples).tobytes(), {
        'sample_rate': rate, 'channels': channels, 'sample_width_bytes': 2,
    })
    assert len(converted) == 24000 * 2
    values = array('h')
    values.frombytes(converted)
    assert max(abs(value - (1000 if channels == 1 else 0)) for value in values[100:-100]) <= 1


@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_asr_converts_browser_audio_and_accounts_original_duration(adapter):
    _, provider, _, sockets, timeline = setup(adapter)
    scope = Scope()
    deltas = []

    async def collect(text):
        deltas.append(text)

    result = asyncio.run(provider.transcribe_realtime_audio(
        TranscriptionRequest(audio_bytes=b'\x00\x00' * 16000, filename='recording.pcm', content_type='audio/pcm',
            surface='recipe_cook_page', family_id='family-a', user_id='owner-a', operation_id='asr-a', language_hint='zh',
            metadata={'sample_rate': 16000, 'sample_width_bytes': 2, 'channels': 1}),
        on_delta=collect, realtime_usage_scope=scope, realtime_turn_id='turn-a',
    ))
    assert result.text == '番茄炒蛋'
    assert deltas == ['番茄']
    assert len(sockets[0].audio) == (48000 if adapter == 'openai_realtime' else 32000)
    session = sockets[0].sent[0]['session']
    if adapter == 'openai_realtime':
        assert session['audio']['input']['transcription'] == {'model': 'gpt-4o-mini-transcribe', 'language': 'zh'}
    else:
        assert session['input_audio_transcription'] == {'model': 'qwen3-asr-flash-realtime'}
    assert all(event['type'] != 'session.finish' for event in sockets[0].sent)
    assert sockets[0].closed
    assert timeline == ['credential', 'connect']
    assert scope.operations[0].input_seconds == Decimal('1')
    assert scope.operations[0].outcome == 'settled'


@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_synthesis_uses_distinct_protocol_and_returns_decodable_wav(adapter):
    _, provider, _, sockets, _ = setup(adapter)
    scope = Scope()
    result = asyncio.run(provider.synthesize_realtime_text(speech(), realtime_usage_scope=scope, realtime_turn_id='turn-a'))
    with wave.open(io.BytesIO(result.audio_bytes)) as wav:
        assert wav.getframerate() == 24000
        assert wav.getnchannels() == 1
        assert wav.readframes(wav.getnframes()) == PCM
    expected = ['session.update', 'response.create'] if adapter == 'openai_realtime' else [
        'session.update', 'conversation.item.create', 'response.create',
    ]
    assert [event['type'] for event in sockets[0].sent] == expected
    assert sockets[0].closed
    assert scope.operations[0].output_seconds == Decimal('0.1')


@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_stream_finishes_each_response_before_next_segment_and_closes_on_cancel(adapter):
    _, provider, _, sockets, _ = setup(adapter)
    scope = Scope()

    async def chunks():
        yield '番茄'
        yield '炒蛋'

    async def run():
        return [event async for event in provider.stream_realtime_text(chunks(), speech(), realtime_usage_scope=scope, realtime_turn_id='turn-stream')]

    events = asyncio.run(run())
    assert [event['type'] for event in events] == ['audio_start', 'audio_trace', 'audio_delta', 'audio_trace', 'audio_delta', 'audio_done']
    assert [event['sequence'] for event in events if event['type'] == 'audio_delta'] == [1, 2]
    if adapter == 'openai_realtime':
        assert [event['response']['input'][0]['content'][0]['text'] for event in sockets[0].sent[1:]] == ['番茄', '炒蛋']
    else:
        assert [json.loads(event['item']['content'][0]['text'].split('原文：', 1)[1])
                for event in sockets[0].sent if event['type'] == 'conversation.item.create'] == ['番茄', '炒蛋']
        assert 'voice' not in sockets[0].sent[0]['session']
    assert scope.operations[0].characters == (4 if adapter == 'openai_realtime' else 8)
    assert scope.operations[0].output_seconds == Decimal('0.2')
    assert sockets[0].closed

    async def cancel():
        stream = provider.stream_realtime_text(chunks(), speech(), realtime_usage_scope=scope, realtime_turn_id='turn-cancel')
        async for event in stream:
            if event['type'] == 'audio_delta':
                await stream.aclose()
                break

    asyncio.run(cancel())
    assert sockets[1].closed
    assert scope.operations[1].outcome == 'uncertain'


@pytest.mark.parametrize('failure', ['no_audio', 'incomplete', 'invalid_audio'])
@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_invalid_synthesis_is_uncertain_and_closes_without_resend(failure, adapter):
    _, provider, _, sockets, timeline = setup(adapter, failure=failure)
    scope = Scope()
    with pytest.raises(HTTPException):
        asyncio.run(provider.synthesize_realtime_text(speech(), realtime_usage_scope=scope, realtime_turn_id='turn-fail'))
    assert timeline == ['credential', 'connect']
    assert len(sockets) == 1 and sockets[0].closed
    assert scope.operations[0].outcome == 'uncertain'


@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_capability_probe_requires_asr_and_real_audio_on_separate_closed_sockets(adapter):
    binding, _, transport, sockets, _ = setup(adapter)
    _run_realtime_probe(binding=binding, credential=DispatchCredential('family-a', 'profile-a', 'realtime-secret', 'synthetic-key'), transport=transport)
    assert len(sockets) == 2 and all(socket.closed for socket in sockets)
    assert len(sockets[0].audio) == (48000 if adapter == 'openai_realtime' else 32000)


@pytest.mark.parametrize('failure', ['wrong_transcript', 'missing_transcript'])
def test_omni_probe_rejects_audio_that_does_not_read_the_sample_without_resending(failure):
    binding, _, transport, sockets, _ = setup('dashscope', failure=failure)
    with pytest.raises(ValueError, match='realtime_speech_text_mismatch'):
        _run_realtime_probe(binding=binding, credential=DispatchCredential('family-a', 'profile-a', None, 'synthetic-key'), transport=transport)
    assert len(sockets) == 2 and all(socket.closed for socket in sockets)
    assert sum(event['type'] == 'response.create' for event in sockets[1].sent) == 1


@pytest.mark.parametrize('failure', ['no_audio', 'incomplete', 'invalid_audio', 'asr_failed', 'ack_only'])
@pytest.mark.parametrize('adapter', ['openai_realtime', 'dashscope'])
def test_probe_rejects_ack_only_or_incomplete_audio_and_closes_without_resend(failure, adapter):
    binding, _, transport, sockets, _ = setup(adapter, failure=failure)
    with pytest.raises(ValueError):
        _run_realtime_probe(binding=binding, credential=DispatchCredential('family-a', 'profile-a', None, 'synthetic-key'), transport=transport)
    assert all(socket.closed for socket in sockets)
    assert len(sockets) == (1 if failure in {'asr_failed', 'ack_only'} else 2)


@pytest.mark.parametrize('model', ['qwen3-tts-flash-realtime', 'qwen3-asr-flash-realtime', 'cosyvoice-v3-plus'])
def test_dashscope_realtime_rejects_models_without_both_asr_and_speech_before_send(model):
    binding, _, transport, sockets, timeline = setup('dashscope')
    binding = replace(binding, requested_model=model, billing_model=model)
    with pytest.raises(FamilyModelSettingsError) as exc:
        RealtimeAudioProvider(resolved_audio_provider_config(binding), dependencies=AudioProviderDependencies(
            transport, lambda *_: pytest.fail('no credential should be read')))
    assert exc.value.code == 'family_model_realtime_model_unsupported'
    with pytest.raises(FamilyModelProviderProtocolUnsupported):
        _run_realtime_probe(binding=binding, credential=DispatchCredential('family-a', 'profile-a', None, 'synthetic-key'), transport=transport)
    assert not sockets and not timeline


@pytest.mark.parametrize('language', [None, 'auto', 'zh', 'en'])
def test_omni_transcription_is_enabled_even_with_default_language(language):
    _, provider, _, _, _ = setup('dashscope')
    session = provider._session_event(voice=None, transcription=True, language=language)['session']
    assert session['input_audio_transcription'] == {'model': 'qwen3-asr-flash-realtime'}


@pytest.mark.parametrize('rate', [8000, 16000, 24000, 48000])
@pytest.mark.parametrize('channels', [1, 2])
def test_omni_normalizes_pcm_to_16khz_mono_and_preserves_original_usage_duration(rate, channels):
    _, provider, _, sockets, _ = setup('dashscope')
    scope = Scope()
    request = TranscriptionRequest(audio_bytes=b'\x00\x00' * rate * channels, filename='recording.pcm', content_type='audio/pcm',
        surface='recipe_cook_page', family_id='family-a', user_id='owner-a', operation_id='asr-a',
        metadata={'sample_rate': rate, 'sample_width_bytes': 2, 'channels': channels})
    result = asyncio.run(provider.transcribe_realtime_audio(request, realtime_usage_scope=scope, realtime_turn_id='turn-normalize'))
    assert result.text == '番茄炒蛋' and len(sockets[0].audio) == 32000
    assert scope.operations[0].input_seconds == Decimal('1')


def test_dashscope_binary_audio_remains_supported_by_runtime_and_probe():
    binding, provider, transport, sockets, _ = setup('dashscope', binary=True)
    result = asyncio.run(provider.synthesize_realtime_text(speech(), realtime_usage_scope=Scope(), realtime_turn_id='turn-binary'))
    with wave.open(io.BytesIO(result.audio_bytes)) as wav:
        assert wav.readframes(wav.getnframes()) == PCM
    _run_realtime_probe(binding=binding, credential=DispatchCredential('family-a', 'profile-a', None, 'synthetic-key'), transport=transport)
    assert len(sockets) == 3 and all(socket.closed for socket in sockets)


@pytest.mark.parametrize('download_fails', [False, True])
def test_dashscope_http_tts_fetches_signed_oss_audio_and_never_resends(download_fails):
    binding = replace(_binding(adapter_kind='dashscope', options={'output_format': 'mp3'}),
                      requested_model='qwen3-tts-flash', billing_model='qwen3-tts-flash')
    timeline = []
    url = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=A%2B%3D&Expires=123'
    sample = silence_wav()

    def request(*, headers, **kwargs):
        timeline.append('send')
        assert headers['Authorization'] == 'Bearer synthetic-key'
        assert kwargs['json']['parameters']['format'] == 'wav'
        return ProviderResponse(200, {}, json.dumps({'output': {'audio': {'url': url}}}).encode())

    def download(*, endpoint, **kwargs):
        timeline.append('download')
        assert 'headers' not in kwargs
        assert endpoint.normalized_url == url.replace('http://', 'https://', 1)
        assert endpoint.resolved_addresses == ('93.184.216.34',)
        if download_fails:
            raise FamilyModelEndpointBlocked()
        return ProviderMedia(sample, 'audio/x-wav', endpoint)

    transport = ProviderTransport(
        policy=ProviderNetworkPolicy(resolver=SimpleNamespace(resolve_all=lambda _: ('93.184.216.34',))),
        settings=ProviderTransportSettings(1, 2, 1024 * 1024, 1024 * 1024, 0),
        http_dialer=SimpleNamespace(request=request, download=download),
    )
    provider = DashScopeAudioProvider(resolved_audio_provider_config(binding),
        dependencies=AudioProviderDependencies(transport, lambda resolved, secret: DispatchCredential(
            'family-a', binding.provider_profile_id, secret, 'synthetic-key',
        )), usage_adapter=_AudioAdapter(binding, timeline))
    if download_fails:
        with pytest.raises(HTTPException):
            provider.synthesize(speech())
    else:
        result = provider.synthesize(speech())
        assert result.audio_bytes == sample and result.content_type == 'audio/wav'
    assert timeline == ['begin', 'dispatch', 'send', 'receipt', 'settle', 'download']
