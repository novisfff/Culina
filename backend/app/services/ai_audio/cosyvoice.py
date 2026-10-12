"""CosyVoice native WebSocket task protocol for runtime and capability probes."""

import json
from collections.abc import Mapping
from time import monotonic
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from app.services.ai_audio.dashscope_protocols import is_cosyvoice_model, tts_default_voice
from app.services.family_model_settings.errors import FamilyModelProviderProtocolUnsupported, FamilyModelProviderTransportError
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.types import ResolvedCapabilityBinding


def endpoint_url(binding: ResolvedCapabilityBinding) -> str:
    endpoint = binding.websocket_endpoint
    if endpoint is not None:
        parsed = urlsplit(endpoint.normalized_url)
        if parsed.scheme not in {'ws', 'wss'}:
            raise FamilyModelProviderProtocolUnsupported()
        path = parsed.path.rstrip('/')
        if path.endswith('/realtime'):
            path = path[:-len('/realtime')]
    else:
        parsed = urlsplit(binding.endpoint.normalized_url)
        if parsed.scheme not in {'http', 'https'}:
            raise FamilyModelProviderProtocolUnsupported()
        path = parsed.path.rstrip('/')
        if path.endswith('/api/v1'):
            path = path[:-len('/api/v1')] + '/api-ws/v1'
        else:
            raise FamilyModelProviderProtocolUnsupported()
    if not path.endswith('/inference'):
        path += '/inference'
    scheme = {'http': 'ws', 'https': 'wss'}.get(parsed.scheme, parsed.scheme)
    return urlunsplit((scheme, parsed.netloc, path, '', ''))


def synthesize(
    binding: ResolvedCapabilityBinding,
    *,
    transport: ProviderTransport,
    headers: Mapping[str, str],
    text: str,
    voice: str | None = None,
    output_format: str = 'mp3',
    timeout_seconds: float = 45,
    max_audio_bytes: int | None = None,
) -> ProviderResponse:
    if binding.adapter_kind != 'dashscope' or not is_cosyvoice_model(binding.requested_model) or output_format not in {'mp3', 'wav'}:
        raise FamilyModelProviderProtocolUnsupported()
    url = endpoint_url(binding)  # All model/format/URL preconditions precede a send.
    limit = max_audio_bytes if max_audio_bytes is not None else transport.settings.media_max_bytes
    task_id = str(uuid4())
    connection = transport.connect_websocket(url, headers=dict(headers))
    deadline = monotonic() + timeout_seconds
    audio = bytearray()

    def send(action: str, payload: dict[str, object]) -> None:
        connection.send(json.dumps({
            'header': {'action': action, 'task_id': task_id, 'streaming': 'duplex'},
            'payload': payload,
        }, ensure_ascii=False))

    def receive() -> bytes | dict[str, object]:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise FamilyModelProviderTransportError()
        raw = connection.recv(timeout=remaining)
        if isinstance(raw, bytes):
            return raw
        body = json.loads(raw)
        if not isinstance(body, dict) or not isinstance(body.get('header'), dict):
            raise FamilyModelProviderTransportError()
        header = body['header']
        if header.get('task_id') != task_id or header.get('event') == 'task-failed':
            # Do not reflect provider error messages or mark a post-send
            # failure as free/retryable: execution may have already begun.
            raise FamilyModelProviderTransportError()
        return body

    try:
        send('run-task', {
            'task_group': 'audio', 'task': 'tts', 'function': 'SpeechSynthesizer',
            'model': binding.requested_model, 'input': {},
            'parameters': {
                'text_type': 'PlainText', 'voice': voice or tts_default_voice(binding.requested_model),
                'format': output_format, 'sample_rate': 24000,
            },
        })
        first = receive()
        if not isinstance(first, dict) or first['header'].get('event') != 'task-started':
            raise FamilyModelProviderTransportError()
        send('continue-task', {'input': {'text': text}})
        send('finish-task', {'input': {}})
        for _ in range(4096):
            event = receive()
            if isinstance(event, bytes):
                if not event or len(audio) + len(event) > limit:
                    raise FamilyModelProviderTransportError()
                audio.extend(event)
            elif event['header'].get('event') == 'task-finished':
                if not audio:
                    raise FamilyModelProviderTransportError()
                return ProviderResponse(200, {
                    'content-type': 'audio/wav' if output_format == 'wav' else 'audio/mpeg',
                    'x-request-id': task_id,
                }, bytes(audio))
            elif event['header'].get('event') != 'result-generated':
                raise FamilyModelProviderTransportError()
        raise FamilyModelProviderTransportError()
    finally:
        try:
            connection.close()
        except Exception:
            pass
