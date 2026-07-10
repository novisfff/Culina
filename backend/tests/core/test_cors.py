from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient
import pytest

from app.core.config import Settings
from app.main import UnhandledApiExceptionMiddleware, app, cors_allowed_origins, local_dev_origin_regex


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


def test_unhandled_error_keeps_cors_header_for_local_dev_origin() -> None:
    def raise_error() -> None:
        raise RuntimeError("expected test error")

    app.add_api_route("/_test/cors-error", raise_error, methods=["GET"])
    try:
        response = TestClient(app, raise_server_exceptions=False).get(
            "/_test/cors-error",
            headers={"Origin": "http://127.0.0.1:63956"},
        )
    finally:
        app.router.routes.pop()

    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:63956"


def test_streaming_error_does_not_start_a_second_response() -> None:
    sent: list[dict] = []

    async def streaming_app(scope, receive, send) -> None:
        del scope, receive
        await send({"type": "http.response.start", "status": 200, "headers": []})
        raise RuntimeError("stream failed after response start")

    async def receive() -> dict:
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "scheme": "http",
        "path": "/_test/stream-error",
        "raw_path": b"/_test/stream-error",
        "query_string": b"",
        "headers": [],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
        "http_version": "1.1",
    }

    with pytest.raises(RuntimeError, match="stream failed after response start"):
        asyncio.run(UnhandledApiExceptionMiddleware(streaming_app)(scope, receive, send))

    assert [message["type"] for message in sent] == ["http.response.start"]
