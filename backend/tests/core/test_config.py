from __future__ import annotations

import base64
import json

from pydantic import SecretStr
import pytest

from app.core.config import LOCAL_DEVELOPMENT_JWT_SECRET, Settings


def production_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "production",
        "frontend_origin": "https://culina.example.com",
        "mysql_password": "safe-password",
        "jwt_secret": "safe-production-secret",
        "minio_secret_key": "safe-minio-secret",
        "model_usage_required": True,
        "family_model_credential_active_key_id": "test-key",
        "family_model_credential_keys_json": SecretStr(
            json.dumps(
                {
                    "test-key": base64.b64encode(b"t" * 32).decode("ascii"),
                }
            )
        ),
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_family_model_platform_limits_have_safe_defaults() -> None:
    settings = Settings(_env_file=None)

    assert settings.access_token_expire_minutes == 15
    assert settings.refresh_session_expire_days == 30
    assert settings.refresh_rotation_grace_seconds == 10
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


def test_production_rejects_long_lived_access_tokens() -> None:
    with pytest.raises(ValueError, match="ACCESS_TOKEN_EXPIRE_MINUTES"):
        production_settings(access_token_expire_minutes=31)


def test_production_requires_https_frontend_origin() -> None:
    with pytest.raises(ValueError, match="FRONTEND_ORIGIN"):
        production_settings(frontend_origin="http://culina.example.com")


@pytest.mark.parametrize(
    "frontend_origin",
    [
        "https://user@culina.example.com",
        "https://culina.example.com/app",
        "https://culina.example.com?tenant=family-a",
        "https://culina.example.com#login",
    ],
)
def test_production_frontend_origin_must_be_an_origin(frontend_origin: str) -> None:
    with pytest.raises(ValueError, match="FRONTEND_ORIGIN"):
        production_settings(frontend_origin=frontend_origin)


def test_production_rejects_known_default_initial_admin_password() -> None:
    with pytest.raises(ValueError, match="INITIAL_ADMIN_PASSWORD"):
        production_settings(initial_admin_password="CulinaAdmin123!")
