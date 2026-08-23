from __future__ import annotations

from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def test_nginx_proxies_websockets_without_logging_queries() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "nginx.conf").read_text()

    assert "proxy_set_header Upgrade $http_upgrade;" in config
    assert "proxy_set_header Connection $connection_upgrade;" in config
    assert "proxy_read_timeout 360s;" in config
    assert "proxy_send_timeout 360s;" in config
    assert "log_format culina_access" in config
    assert '"$request_method $uri $server_protocol"' in config
    assert "$request_uri" not in config
    assert "location ~ ^/api/media/[^/]+/content$" in config
    assert "error_log /dev/stderr crit;" in config
    assert 'location /media/' not in config
    assert "proxy_pass http://minio" not in config


def test_backend_container_disables_query_bearing_uvicorn_access_log() -> None:
    dockerfile = (REPOSITORY_ROOT / "backend" / "Dockerfile").read_text()

    assert "--no-access-log" in dockerfile


def test_backend_waits_for_healthy_minio_before_privacy_bootstrap() -> None:
    compose = yaml.safe_load((REPOSITORY_ROOT / "deploy" / "docker-compose.yml").read_text())

    minio = compose["services"]["minio"]
    backend = compose["services"]["backend"]
    assert minio["healthcheck"]["test"] == ["CMD", "mc", "ready", "local"]
    assert backend["depends_on"]["minio"]["condition"] == "service_healthy"


def test_realtime_smoke_checks_error_logs_after_upstream_failure() -> None:
    smoke = (REPOSITORY_ROOT / "deploy" / "tests" / "run-realtime-websocket-smoke.mjs").read_text()

    assert "stop', 'backend'" in smoke
    assert "media-error-log-sentinel" in smoke
    assert "failed media capability request did not reach nginx upstream failure path" in smoke
