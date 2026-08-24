from __future__ import annotations

from app.core.config import LOCAL_DEVELOPMENT_JWT_SECRET, Settings


def test_family_model_platform_limits_have_safe_defaults() -> None:
    settings = Settings(_env_file=None)

    assert settings.family_model_allow_insecure_public_transports is False
    assert settings.family_model_audio_upload_max_bytes == 10 * 1024 * 1024
    assert settings.family_model_stt_max_duration_seconds == 60
    assert settings.family_model_tts_max_characters == 4096
    assert settings.family_model_realtime_session_max_seconds == 300
    assert settings.media_access_url_ttl_seconds == 300
    assert settings.realtime_websocket_ticket_ttl_seconds == 45


def test_local_default_jwt_secret_is_non_empty_and_hs256_sized() -> None:
    settings = Settings(_env_file=None)

    assert settings.jwt_secret == LOCAL_DEVELOPMENT_JWT_SECRET
    assert len(settings.jwt_secret.encode("utf-8")) >= 32


def test_security_ticket_ttls_reject_unsafe_ranges() -> None:
    for field, value in (
        ("media_access_url_ttl_seconds", 29),
        ("media_access_url_ttl_seconds", 901),
        ("realtime_websocket_ticket_ttl_seconds", 29),
        ("realtime_websocket_ticket_ttl_seconds", 61),
    ):
        try:
            Settings(_env_file=None, **{field: value})
        except ValueError:
            continue
        raise AssertionError(f"{field} accepted unsafe value {value}")
