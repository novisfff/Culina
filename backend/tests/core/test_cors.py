from __future__ import annotations

from app.core.config import Settings
from app.main import cors_allowed_origins, local_dev_origin_regex


def test_local_environment_allows_dynamic_dev_server_origins() -> None:
    settings = Settings(environment="local", frontend_origin="http://localhost:5173")

    assert cors_allowed_origins(settings) == ["http://localhost:5173", "http://127.0.0.1:5173"]
    assert local_dev_origin_regex(settings) == r"^http://(localhost|127\.0\.0\.1):\d+$"


def test_non_local_environment_keeps_cors_to_explicit_origins() -> None:
    settings = Settings(
        environment="production",
        frontend_origin="https://culina.example.com",
        mysql_password="safe-password",
        jwt_secret="safe-production-secret",
        minio_secret_key="safe-minio-secret",
    )

    assert cors_allowed_origins(settings) == ["https://culina.example.com"]
    assert local_dev_origin_regex(settings) is None
