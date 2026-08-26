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


def test_nginx_rate_limits_auth_sensitive_and_general_api_traffic() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "nginx.conf").read_text()

    assert '"POST:/api/auth/login" login;' in config
    assert '"POST:/api/auth/refresh" refresh;' in config
    assert '"PATCH:/api/auth/password" sensitive;' in config
    assert "/api/family/model-settings" in config
    assert "/api/model-usage" in config
    assert "zone=culina_login:10m rate=5r/m" in config
    assert "zone=culina_refresh:10m rate=60r/m" in config
    assert "zone=culina_sensitive:10m rate=10r/m" in config
    assert "zone=culina_api:10m rate=300r/m" in config
    assert "limit_req zone=culina_login burst=5 nodelay;" in config
    assert "limit_req_status 429;" in config
    assert '"code":"rate_limited"' in config


def test_nginx_isolates_bursty_media_reads_from_the_general_api_budget() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "nginx.conf").read_text()
    rate_map = config[config.index('map "$request_method:$uri"'):config.index("log_format culina_access")]
    content_location = config[
        config.index("location ~ ^/api/media/[^/]+/content$"):config.index("location /api/")
    ]
    api_location_start = config.index("location /api/")
    api_location = config[api_location_start:config.index("\n    location / {", api_location_start)]

    assert "~^GET:/api/media/[^/]+/access$ media_access;" in rate_map
    assert "~^GET:/api/media/[^/]+/content$ media_content;" in rate_map
    assert rate_map.index("media_access;") < rate_map.index("~^[A-Z]+:/api/ general;")
    assert rate_map.index("media_content;") < rate_map.index("~^[A-Z]+:/api/ general;")
    assert "zone=culina_media_access:10m" in rate_map
    assert "zone=culina_media_content:10m" in rate_map
    assert "limit_req zone=culina_media_content" in content_location
    assert "limit_req zone=culina_api" not in content_location
    assert "limit_req zone=culina_media_access" in api_location


def test_nginx_emits_browser_security_headers() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "nginx.conf").read_text()

    assert "Content-Security-Policy" in config
    assert "default-src 'self'" in config
    assert "https://fonts.googleapis.com" in config
    assert "https://fonts.gstatic.com" in config
    assert "img-src 'self' data: blob:" in config
    assert "media-src 'self' data: blob:" in config
    assert "connect-src 'self' ws://$http_host wss://$http_host" in config
    assert "Strict-Transport-Security" in config
    assert "Referrer-Policy" in config
    assert "Permissions-Policy" in config
    assert "microphone=(self)" in config
    assert "camera=()" in config
    assert "geolocation=()" in config
    assert "X-Content-Type-Options" in config
    assert "X-Frame-Options" in config


def test_nginx_only_honors_forwarded_ips_from_an_explicit_trusted_proxy() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "nginx.conf").read_text()
    compose = yaml.safe_load((REPOSITORY_ROOT / "deploy" / "docker-compose.yml").read_text())

    assert "set_real_ip_from ${TRUSTED_PROXY_CIDR};" in config
    assert "real_ip_header X-Forwarded-For;" in config
    assert "real_ip_recursive on;" in config
    proxy_cidr = compose["services"]["frontend"]["environment"]["TRUSTED_PROXY_CIDR"]
    assert proxy_cidr == "${TRUSTED_PROXY_CIDR:-127.0.0.1/32}"
    assert "0.0.0.0/0" not in config
    assert "0.0.0.0/0" not in proxy_cidr


def test_compose_uses_short_auth_lifetimes() -> None:
    compose = yaml.safe_load((REPOSITORY_ROOT / "deploy" / "docker-compose.yml").read_text())
    environment = compose["services"]["backend"]["environment"]

    assert environment["ACCESS_TOKEN_EXPIRE_MINUTES"] == "${ACCESS_TOKEN_EXPIRE_MINUTES:-15}"
    assert environment["REFRESH_SESSION_EXPIRE_DAYS"] == "${REFRESH_SESSION_EXPIRE_DAYS:-30}"
    assert environment["REFRESH_ROTATION_GRACE_SECONDS"] == "${REFRESH_ROTATION_GRACE_SECONDS:-10}"


def test_vite_development_server_proxies_same_origin_api_and_websockets() -> None:
    config = (REPOSITORY_ROOT / "frontend" / "vite.config.ts").read_text()

    assert "'/api':" in config
    assert "target: 'http://127.0.0.1:8010'" in config
    assert "ws: true" in config


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
