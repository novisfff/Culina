"""Qwen-Omni Realtime protocol, distinct from Qwen TTS text buffers."""

import json
from typing import Any
from uuid import uuid4


def _event(kind: str, **fields: Any) -> dict[str, Any]:
    return {'event_id': f'event_{uuid4().hex}', 'type': kind, **fields}


def session_update_event(*, voice: str | None, transcription: bool, language: str | None = None) -> dict[str, Any]:
    # Legacy format fields are still supported by Omni, including older
    # qwen3 models. Fixed PCM16 mono input/output are 16 kHz and 24 kHz.
    session: dict[str, Any] = {
        'input_audio_format': 'pcm',
        'output_audio_format': 'pcm',
        'turn_detection': None,
        'modalities': ['text'] if transcription else ['text', 'audio'],
    }
    if transcription:
        session['input_audio_transcription'] = {'model': 'qwen3-asr-flash-realtime'}
        # Omni exposes a fixed transcription model, not a language field in
        # that object. Keep the hint in supported session instructions.
        if language and language != 'auto':
            session['instructions'] = f'用户输入的语言提示为 {language}。保留输入语言，不翻译。'
    else:
        session['input_audio_transcription'] = None
        session['instructions'] = '只逐字朗读最新一条用户消息中的文本。不要回答、解释、补充、改写或重复之前的消息。'
        if voice:
            session['voice'] = voice
        # Omission uses the chosen model's default (Cherry/Tina/etc.).
    return _event('session.update', session=session)


def speech_events(text: str) -> tuple[dict[str, Any], ...]:
    # Bare text is interpreted as a conversational turn even with session
    # instructions. Make every segment an explicit, isolated read request.
    read_request = '请逐字朗读下面引号中的原文；不要回答、解释或添加任何字。原文：' + json.dumps(text, ensure_ascii=False)
    return (
        _event('conversation.item.create', item={
            'type': 'message', 'role': 'user',
            'content': [{'type': 'input_text', 'text': read_request}],
        }),
        _event('response.create'),
    )


def response_done(event: dict[str, Any]) -> bool:
    if event.get('type') != 'response.done':
        return False
    response = event.get('response')
    if not isinstance(response, dict) or response.get('status') != 'completed':
        raise ValueError('realtime_response_incomplete')
    return True
