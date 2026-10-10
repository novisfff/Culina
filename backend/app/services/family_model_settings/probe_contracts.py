"""Fixed, household-free capability samples and structural response checks.

No provider response text or URL is echoed into durable test results.
"""
from __future__ import annotations

import base64
import io
import json
import math
import unicodedata
import wave
from typing import Any
from urllib.parse import urlsplit

from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import ResolvedCapabilityBinding

# A fixed red PNG, used only to check acceptance of image input, not vision accuracy.
REFERENCE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACwUlEQVR4nO3TIQEAIADAMKAPmv4VSEQMxLcEN5/37AFV63cA/GQA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAIyyB5kCAzahwxyOAAAAAElFTkSuQmCC'
PROBE_TEXT = '请调用 capability_check，设置 ok 为 true，表示收到测试请求。'
TOOL = {
    'name': 'capability_check', 'description': '确认收到功能测试请求',
    'parameters': {'type': 'object', 'properties': {'ok': {'type': 'boolean'}},
                   'required': ['ok'], 'additionalProperties': False},
}


def speech_probe_matches(expected: str, transcript: object) -> bool:
    if not isinstance(transcript, str):
        return False

    def words(text: str) -> str:
        return ''.join(char for char in text if not char.isspace() and not unicodedata.category(char).startswith('P'))

    return bool(words(expected)) and words(transcript) == words(expected)


def silence_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x00\x00' * 16000)
    return buffer.getvalue()


def llm_probe(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, Any]]:
    # A short probe verifies the wire protocol, not the configured maximum length.
    cap = int(binding.options.get('max_output_tokens', 256))
    vision = bool(binding.options.get('supports_vision'))
    if binding.adapter_kind != 'dashscope' and binding.options.get('runtime_protocol') == 'responses':
        content: list[dict[str, Any]] = [{'type': 'input_text', 'text': PROBE_TEXT}]
        if vision:
            content.append({'type': 'input_image', 'image_url': REFERENCE_IMAGE})
        return 'responses', {'model': binding.requested_model, 'input': [{'role': 'user', 'content': content}],
            'tools': [{'type': 'function', **TOOL}], 'tool_choice': {'type': 'function', 'name': TOOL['name']},
            'max_output_tokens': cap, 'store': False}
    content = [{'type': 'text', 'text': PROBE_TEXT}]
    if vision:
        content.append({'type': 'image_url', 'image_url': {'url': REFERENCE_IMAGE}})
    return 'chat/completions', {'model': binding.requested_model, 'messages': [{'role': 'user', 'content': content}],
        'tools': [{'type': 'function', 'function': TOOL}],
        'tool_choice': {'type': 'function', 'function': {'name': TOOL['name']}}, 'max_tokens': cap}


def image_probe(binding: ResolvedCapabilityBinding) -> tuple[str, dict[str, Any]]:
    from app.ai.images.generation import STANDARD_IMAGE_SIZE, _format_openai_size
    reference = binding.variant_key == 'reference'
    prompt = '一颗番茄，白色背景，测试图。'
    if binding.adapter_kind == 'dashscope':
        content = ([{'image': REFERENCE_IMAGE}] if reference else []) + [{'text': prompt}]
        return 'services/aigc/multimodal-generation/generation', {
            'model': binding.requested_model, 'input': {'messages': [{'role': 'user', 'content': content}]},
            'parameters': {'n': 1, 'size': STANDARD_IMAGE_SIZE, 'watermark': False},
        }
    payload = {'model': binding.requested_model, 'prompt': prompt, 'n': 1,
               'size': _format_openai_size(STANDARD_IMAGE_SIZE), 'output_format': 'png'}
    return ('images/edits' if reference else 'images/generations'), payload


def _resource(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return parsed.scheme in {'https', 'http'} and bool(parsed.hostname)


def probe_response_detail(binding: ResolvedCapabilityBinding, response: ProviderResponse, transport: Any = None) -> str:
    """Raise on a malformed/empty result even if the provider returned HTTP 200."""
    capability = binding.capability
    body = response.json()
    if not isinstance(body, dict) or body.get('error') or body.get('code'):
        raise ValueError('provider_response_invalid')
    if capability == 'llm':
        if binding.adapter_kind != 'dashscope' and binding.options.get('runtime_protocol') == 'responses':
            calls = [item for item in body.get('output', []) if isinstance(item, dict) and item.get('type') == 'function_call']
        else:
            choices = body.get('choices', [])
            calls = choices[0].get('message', {}).get('tool_calls', []) if choices else []
            calls = [item.get('function', {}) for item in calls if isinstance(item, dict)]
        for call in calls:
            if call.get('name') == TOOL['name'] and json.loads(call.get('arguments', '{}')).get('ok') is True:
                return ('工具调用和图片输入协议通过；未验证图片理解准确率。' if binding.options.get('supports_vision')
                        else '工具调用协议通过；未测试图片理解或最大回复长度。')
        raise ValueError('tool_call_missing')
    if capability == 'embedding':
        from app.services.search.embeddings import _parse_vectors
        dimensions = int(binding.options['dimensions'])
        vectors = _parse_vectors(body, expected_count=1, dimensions=dimensions, adapter_kind=binding.adapter_kind)
        if not all(math.isfinite(value) for value in vectors[0]):
            raise ValueError('embedding_not_finite')
        return f'已返回 {len(vectors[0])} 维向量，与配置一致。'
    if capability == 'rerank':
        from app.services.search.rerank import _parse_rerank_response
        results = _parse_rerank_response(response, document_count=1)
        if len(results) != 1 or not math.isfinite(results[0].relevance_score):
            raise ValueError('rerank_response_invalid')
        return '已返回有效排序分数。'
    if capability == 'stt':
        if binding.adapter_kind == 'dashscope':
            output = body.get('output', {})
            valid = isinstance(output, dict) and (
                isinstance(output.get('text'), str) or isinstance(output.get('transcription'), str)
                or any(isinstance(choice, dict) and isinstance(choice.get('message'), dict)
                       and isinstance(choice['message'].get('content'), (str, list))
                       for choice in output.get('choices', [])))
        else:
            valid = isinstance(body.get('text'), str)
        if not valid:
            raise ValueError('transcription_response_invalid')
        return '音频上传与识别响应协议通过；静音样本不验证识别准确率。'
    if capability == 'image_generation':
        data = body.get('data', [])
        if binding.adapter_kind == 'dashscope':
            choices = body.get('output', {}).get('choices', [])
            data = [part for choice in choices for part in choice.get('message', {}).get('content', [])]
        for item in data:
            if not isinstance(item, dict):
                continue
            if _resource(item.get('url') or item.get('image')):
                if transport is None:
                    raise ValueError('image_download_not_verified')
                media = transport.download_media(item.get('url') or item.get('image'),
                    source=binding.endpoint, adapter_kind=binding.adapter_kind)
                from PIL import Image
                with Image.open(io.BytesIO(media.content)) as image:
                    image.verify()
                return '已生成并下载有效图片；未验证画面效果。'
            if item.get('b64_json'):
                from PIL import Image
                with Image.open(io.BytesIO(base64.b64decode(item['b64_json'], validate=True))) as image:
                    image.verify()
                return '已返回有效图片数据。'
        raise ValueError('image_response_invalid')
    raise ValueError('unsupported_probe_response')


def audio_preview(binding: ResolvedCapabilityBinding, response: ProviderResponse, transport: Any) -> str:
    """Return bounded, ephemeral audio; never expose a provider-owned URL."""
    payload = response.content
    from app.services.ai_audio.dashscope_protocols import is_cosyvoice_model
    if binding.adapter_kind == 'dashscope' and not is_cosyvoice_model(binding.requested_model):
        from app.services.ai_audio.dashscope_audio import _extract_dashscope_audio_bytes, _extract_dashscope_audio_url
        body = response.json()
        if not isinstance(body, dict) or body.get('error') or body.get('code'):
            raise ValueError('audio_response_invalid')
        payload = _extract_dashscope_audio_bytes(body)
        if payload is None:
            media = transport.download_media(_extract_dashscope_audio_url(body), source=binding.endpoint, adapter_kind=binding.adapter_kind)
            payload = media.content
    if not payload or len(payload) > 512 * 1024:
        raise ValueError('audio_preview_size_invalid')
    if payload.startswith(b'RIFF') and payload[8:12] == b'WAVE':
        mime = 'audio/wav'
    elif payload.startswith(b'ID3') or (len(payload) > 1 and payload[0] == 255 and payload[1] & 224 == 224):
        mime = 'audio/mpeg'
    elif payload.startswith(b'OggS'):
        mime = 'audio/ogg'
    elif payload.startswith(b'fLaC'):
        mime = 'audio/flac'
    elif payload[4:8] == b'ftyp':
        mime = 'audio/mp4'
    else:
        raise ValueError('audio_preview_format_invalid')
    return f'data:{mime};base64,' + base64.b64encode(payload).decode('ascii')
