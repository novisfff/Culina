from __future__ import annotations

import re
from pathlib import Path

from app.core.config import Settings


LEGACY_PROVIDER_SETTINGS = frozenset(
    {
        "ai_provider",
        "ai_api_base",
        "ai_api_key",
        "ai_model",
        "ai_max_output_tokens",
        "ai_fallback_model",
        "ai_fallback_max_output_tokens",
        "ai_supports_vision",
        "ai_timeout_seconds",
        "ai_prompt_cache_enabled",
        "ai_image_reference_provider",
        "ai_image_reference_api_base",
        "ai_image_reference_api_key",
        "ai_image_reference_model",
        "ai_image_text_provider",
        "ai_image_text_api_base",
        "ai_image_text_api_key",
        "ai_image_text_model",
        "ai_audio_enabled",
        "ai_stt_provider",
        "ai_stt_api_base",
        "ai_stt_api_key",
        "ai_stt_model",
        "ai_stt_language_hint",
        "ai_stt_audio_format",
        "ai_stt_sample_rate",
        "ai_stt_hotwords",
        "ai_stt_timeout_seconds",
        "ai_stt_max_upload_bytes",
        "ai_stt_max_duration_seconds",
        "ai_tts_provider",
        "ai_tts_api_base",
        "ai_tts_api_key",
        "ai_tts_model",
        "ai_tts_voice",
        "ai_tts_format",
        "ai_tts_sample_rate",
        "ai_tts_language_type",
        "ai_tts_streaming",
        "ai_tts_timeout_seconds",
        "ai_realtime_provider",
        "ai_realtime_api_base",
        "ai_realtime_api_key",
        "ai_realtime_model",
        "ai_realtime_voice",
        "ai_realtime_audio_format",
        "ai_realtime_input_sample_rate",
        "ai_realtime_output_sample_rate",
        "ai_realtime_vad_silence_ms",
        "ai_realtime_timeout_seconds",
        "ai_realtime_tts_max_characters",
        "dashscope_api_key",
        "dashscope_workspace_id",
        "dashscope_region",
        "dashscope_http_api_base",
        "dashscope_websocket_api_base",
        "search_embedding_provider",
        "search_embedding_api_base",
        "search_embedding_api_key",
        "search_embedding_model",
        "search_embedding_dimensions",
        "search_embedding_timeout_seconds",
        "search_rerank_provider",
        "search_rerank_api_base",
        "search_rerank_api_key",
        "search_rerank_model",
        "search_rerank_timeout_seconds",
        "search_rerank_instruct",
        "search_semantic_min_score",
        "search_rerank_min_score",
        "search_literal_fallback_min_score",
        "search_rerank_candidate_limit",
        "qdrant_collection",
    }
)
LEGACY_PROVIDER_ENVIRONMENT_NAMES = frozenset(name.upper() for name in LEGACY_PROVIDER_SETTINGS)


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _app_python_sources() -> list[Path]:
    return sorted((_backend_root() / "app").rglob("*.py"))


def test_settings_has_no_legacy_provider_fields_or_runtime_reads() -> None:
    assert LEGACY_PROVIDER_SETTINGS.isdisjoint(Settings.model_fields)

    for source_path in _app_python_sources():
        source = source_path.read_text(encoding="utf-8")
        for field in LEGACY_PROVIDER_SETTINGS:
            assert f"settings.{field}" not in source, source_path
            assert not re.search(
                rf"getattr\(\s*settings\s*,\s*['\"]{re.escape(field)}['\"]",
                source,
            ), source_path
        for environment_name in LEGACY_PROVIDER_ENVIRONMENT_NAMES:
            assert not re.search(
                rf"(?:getenv|environ(?:\.get|\[))[^\n]*['\"]{re.escape(environment_name)}['\"]",
                source,
            ), source_path


def test_legacy_provider_environment_cannot_enable_runtime(monkeypatch) -> None:
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "must-not-be-read")
    monkeypatch.setenv("AI_MODEL", "must-not-be-read")
    monkeypatch.setenv("SEARCH_EMBEDDING_PROVIDER", "openai")

    settings = Settings(_env_file=None)

    assert not hasattr(settings, "ai_provider")
    assert not hasattr(settings, "search_embedding_provider")


def test_tracked_examples_and_compose_never_document_legacy_provider_environment_names() -> None:
    backend_root = _backend_root()
    repository_root = backend_root.parent
    tracked_paths = (
        backend_root / ".env.example",
        repository_root / "deploy" / ".env.example",
        repository_root / "deploy" / "docker-compose.yml",
        repository_root / "README.md",
    )

    for tracked_path in tracked_paths:
        source = tracked_path.read_text(encoding="utf-8")
        for environment_name in LEGACY_PROVIDER_ENVIRONMENT_NAMES:
            assert not re.search(rf"\b{re.escape(environment_name)}\b", source), tracked_path
