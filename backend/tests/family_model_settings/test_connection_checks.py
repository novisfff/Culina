from __future__ import annotations

import json

import pytest

from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
)
from app.services.family_model_settings.transport import ProviderResponse

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def test_connection_check_never_calls_generation_endpoint(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-check-1")
    family_model_api.transport.responses.append(
        ProviderResponse(
            status_code=200,
            headers={},
            content=(
                b'{"data":['
                b'{"id":"gpt-4.1","object":"model"},'
                b'{"id":"text-embedding-3-small","object":"model"},'
                b'{"id":"gpt-4.1","secret":"do-not-leak"},'
                b'{"id":42}'
                b'],"secret":"do-not-leak"}'
            ),
        )
    )

    result = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-check-1"},
    )

    assert result.status_code == 200, result.text
    assert result.json()["status"] == "reachable"
    assert result.json()["models"] == ["gpt-4.1", "text-embedding-3-small"]
    assert "do-not-leak" not in result.text
    assert [(method, url) for method, url, _, _ in family_model_api.transport.calls] == [
        ("GET", "https://provider.example/v1/models")
    ]
    headers = family_model_api.transport.calls[0][2]
    assert headers["Authorization"].startswith("Bearer ")


def test_legacy_dashscope_compatible_catalog_remains_supported(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(adapter_kind="dashscope")
    with family_model_api.session_factory() as db:
        row = db.get(FamilyModelProviderProfile, profile["id"])
        assert row is not None
        version = db.get(FamilyModelProviderProfileVersion, row.current_profile_version_id)
        assert version is not None
        version.api_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
        db.commit()
    family_model_api.transport.responses.append(
        ProviderResponse(200, {}, b'{"data":[{"id":"qwen-plus"}]}')
    )

    result = family_model_api.client.get(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/models"
    )

    assert result.status_code == 200, result.text
    assert result.json()["models"] == ["qwen-plus"]
    assert family_model_api.transport.calls[0][:2] == (
        "GET", "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
    )


def test_provider_model_catalog_uses_a_read_only_owner_endpoint(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-model-catalog-1")
    family_model_api.transport.responses.append(
        ProviderResponse(
            status_code=200,
            headers={},
            content=b'{"data":[{"id":"gpt-4.1-mini"}]}',
        )
    )

    result = family_model_api.client.get(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/models"
    )

    assert result.status_code == 200, result.text
    assert result.json()["models"] == ["gpt-4.1-mini"]
    assert [(method, url) for method, url, _, _ in family_model_api.transport.calls] == [
        ("GET", "https://provider.example/v1/models")
    ]


@pytest.mark.parametrize("adapter_kind", ["openai_compatible_http", "dashscope"])
def test_provider_model_catalog_enforces_owner_and_family_boundaries(
    family_model_api: FamilyModelApiContext,
    adapter_kind: str,
) -> None:
    profile = family_model_api.create_profile(
        adapter_kind=adapter_kind, idempotency_key="profile-model-catalog-boundary-1"
    )

    family_model_api.use_owner("family-b")
    cross_family = family_model_api.client.get(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/models"
    )
    family_model_api.use_member()
    member = family_model_api.client.get(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/models"
    )

    assert cross_family.status_code == 404
    assert member.status_code == 403
    assert family_model_api.transport.calls == []


def test_connection_check_without_declared_free_probe_never_sends_a_request(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        display_name="Realtime",
        adapter_kind="openai_realtime",
        api_base_url="wss://provider.example/v1/realtime",
        idempotency_key="profile-no-probe-1",
    )

    result = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-no-probe-1"},
    )

    assert result.status_code == 200, result.text
    assert result.json() == {
        "status": "not_supported",
        "detail": "此服务没有可确认的免费连接检查；保存完整能力配置后可运行真实能力测试。",
        "checked_at": result.json()["checked_at"],
        "profile_version_number": 1,
        "models": [],
    }
    assert family_model_api.transport.calls == []


@pytest.mark.parametrize("operation", ["connection-check", "models"])
def test_dashscope_connection_and_discovery_use_only_authenticated_native_catalog(
    family_model_api: FamilyModelApiContext, operation: str,
) -> None:
    profile = family_model_api.create_profile(adapter_kind="dashscope")
    family_model_api.transport.responses.append(ProviderResponse(200, {}, json.dumps({
        "success": True, "code": None,
        "output": {"models": [
            {"model": "qwen-plus", "description": "do-not-leak"},
            {"model": " qwen-image-plus "},
            {"model": "qwen-plus"},
            {"model": "bad\nmodel"},
            {"model": 42},
        ], "total": 354, "page_no": 1, "page_size": 20},
    }).encode()))
    url = f"/api/family/model-settings/provider-profiles/{profile['id']}/{operation}"

    result = (family_model_api.client.get(url) if operation == "models" else
              family_model_api.client.post(url, json={"idempotency_key": "dashscope-check-1"}))

    assert result.status_code == 200, result.text
    assert result.json()["status"] == "reachable"
    assert result.json()["models"] == ["qwen-plus", "qwen-image-plus"]
    assert result.json()["latency_ms"] >= 0
    assert "do-not-leak" not in result.text
    assert len(family_model_api.transport.calls) == 1
    method, endpoint, headers, body = family_model_api.transport.calls[0]
    assert (method, endpoint, body) == ("GET", "https://dashscope.aliyuncs.com/api/v1/models", None)
    assert headers["Authorization"].startswith("Bearer ")


@pytest.mark.parametrize(("status", "body", "code"), [
    (401, b'{"code":"InvalidApiKey","message":"do-not-leak"}', "family_model_provider_connection_rejected"),
    (200, b'{"success":false,"code":"InvalidApiKey","message":"do-not-leak"}', "family_model_provider_connection_rejected"),
    (200, b'<html>do-not-leak</html>', "family_model_provider_response_invalid"),
    (200, b'{"success":true,"output":{}}', "family_model_provider_response_invalid"),
])
def test_dashscope_check_does_not_report_invalid_keys_or_invalid_catalogs_as_reachable(
    family_model_api: FamilyModelApiContext, status: int, body: bytes, code: str,
) -> None:
    profile = family_model_api.create_profile(adapter_kind="dashscope")
    family_model_api.transport.responses.append(ProviderResponse(status, {}, body))

    result = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "dashscope-check-invalid-1"},
    )

    assert result.status_code == 503, result.text
    assert result.json()["detail"]["code"] == code
    assert "do-not-leak" not in result.text
    assert len(family_model_api.transport.calls) == 1


@pytest.mark.parametrize("adapter_kind", ["openai_compatible_http", "dashscope"])
def test_connection_check_replays_safe_result_and_hides_provider_response(
    family_model_api: FamilyModelApiContext,
    adapter_kind: str,
) -> None:
    profile = family_model_api.create_profile(
        adapter_kind=adapter_kind, idempotency_key="profile-connection-replay-1"
    )
    family_model_api.transport.responses.append(
        ProviderResponse(
            status_code=200,
            headers={"x-provider-debug": "do-not-leak"},
            content=b'{"success":true,"output":{"models":[]},"secret":"do-not-leak"}',
        )
    )
    first = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-replay-1"},
    )
    replay = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-replay-1"},
    )

    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert len(family_model_api.transport.calls) == 1
    assert "do-not-leak" not in replay.text


def test_connection_check_provider_failure_is_safe_503(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-connection-503-1")
    family_model_api.transport.responses.append(
        ProviderResponse(status_code=401, headers={}, content=b'{"error": "raw provider response"}')
    )
    response = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-503-1"},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "family_model_provider_connection_rejected"
    assert "raw provider response" not in response.text
