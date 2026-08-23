from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlencode, urlsplit, urlunsplit

from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.types import ResolvedCapabilityBinding


@dataclass(frozen=True, slots=True)
class ResolvedAudioProviderConfig:
    """Validated non-secret audio options for one immutable family binding.

    Provider endpoint, adapter and model identity are carried by ``binding``.
    The object deliberately has no Settings reference and no credential: a
    caller may resolve a credential only after its usage attempt has obtained a
    durable dispatch permit.
    """

    binding: ResolvedCapabilityBinding
    language_hint: str | None
    hotwords: tuple[str, ...]
    voice: str | None
    output_format: str | None


def resolved_audio_provider_config(
    binding: ResolvedCapabilityBinding,
) -> ResolvedAudioProviderConfig:
    if binding.capability not in {"stt", "tts", "realtime_audio"}:
        raise FamilyModelSettingsError("family_model_capability_disabled")
    options = binding.options if isinstance(binding.options, Mapping) else {}
    language_hint = _optional_string(options.get("language_hint"), max_length=32)
    voice = _optional_string(options.get("voice"), max_length=80)
    output_format = _optional_string(options.get("output_format"), max_length=16)
    raw_hotwords = options.get("hotwords", ())
    if not isinstance(raw_hotwords, (list, tuple)):
        raw_hotwords = ()
    hotwords = tuple(
        value
        for item in raw_hotwords
        if (value := _optional_string(item, max_length=80)) is not None
    )
    if len(hotwords) != len(set(hotwords)) or len(hotwords) > 32:
        raise FamilyModelSettingsError("family_model_audio_options_invalid")
    if output_format is not None and output_format not in {"mp3", "wav", "ogg", "flac", "mp4"}:
        raise FamilyModelSettingsError("family_model_audio_options_invalid")
    return ResolvedAudioProviderConfig(
        binding=binding,
        language_hint=language_hint,
        hotwords=hotwords,
        voice=voice,
        output_format=output_format,
    )


def binding_endpoint_url(binding: ResolvedCapabilityBinding, suffix: str) -> str:
    """Append one adapter-owned path without accepting a caller URL."""

    parsed = urlsplit(binding.endpoint.normalized_url)
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}/{suffix.lstrip('/')}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def realtime_endpoint_url(binding: ResolvedCapabilityBinding) -> str:
    """Build the one allowed realtime URL from a published websocket binding."""

    endpoint = binding.websocket_endpoint or binding.endpoint
    if endpoint.scheme not in {"ws", "wss"}:
        raise FamilyModelSettingsError("family_model_provider_protocol_unsupported")
    parsed = urlsplit(endpoint.normalized_url)
    path = parsed.path.rstrip("/")
    if not path.endswith("/realtime"):
        path = f"{path}/realtime"
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            path,
            urlencode({"model": binding.requested_model}),
            "",
        )
    )


def _optional_string(value: object, *, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > max_length:
        return None
    return normalized
