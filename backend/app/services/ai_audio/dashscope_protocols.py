"""Native audio model families; a provider name alone is not a wire protocol."""

from collections.abc import Mapping


def is_cosyvoice_model(model: str) -> bool:
    return model.lower().startswith('cosyvoice-')


def is_omni_realtime_model(model: str) -> bool:
    name = model.lower()
    return name.startswith('qwen') and '-omni-' in name and '-realtime' in name


def is_qwen_http_tts_model(model: str) -> bool:
    name = model.lower()
    return name.startswith(('qwen-tts', 'qwen3-tts')) and '-realtime' not in name


def tts_output_format(model: str, configured: object) -> str:
    # Qwen HTTP TTS returns WAV; historic bindings may still store MP3.
    return 'wav' if is_qwen_http_tts_model(model) else str(configured or 'mp3')


def audio_binding_issue(capability: str, model: str, options: Mapping[str, object]) -> str | None:
    if capability == 'realtime_audio' and not is_omni_realtime_model(model):
        return 'family_model_realtime_model_unsupported'
    if capability == 'tts' and is_cosyvoice_model(model) and (options.get('output_format') or 'mp3') not in {'mp3', 'wav'}:
        return 'family_model_audio_output_format_unsupported'
    return None


def tts_default_voice(model: str) -> str:
    if is_cosyvoice_model(model):
        return 'longanyang' if model.lower().startswith('cosyvoice-v3') else 'longxiaochun'
    return 'Cherry'
