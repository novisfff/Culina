from __future__ import annotations

from app.core.config import Settings


def test_family_model_platform_limits_have_safe_defaults() -> None:
    settings = Settings(_env_file=None)

    assert settings.family_model_allow_insecure_public_transports is False
    assert settings.family_model_audio_upload_max_bytes == 10 * 1024 * 1024
    assert settings.family_model_stt_max_duration_seconds == 60
    assert settings.family_model_tts_max_characters == 4096
    assert settings.family_model_realtime_session_max_seconds == 300
