from __future__ import annotations

from app.services.family_model_settings.transport import ProviderResponse

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def test_connection_check_never_calls_generation_endpoint(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-check-1")
    family_model_api.transport.responses.append(
        ProviderResponse(status_code=200, headers={}, content=b'{"data": []}')
    )

    result = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-check-1"},
    )

    assert result.status_code == 200, result.text
    assert result.json()["status"] == "reachable"
    assert [(method, url) for method, url, _, _ in family_model_api.transport.calls] == [
        ("GET", "https://provider.example/v1/models")
    ]
    headers = family_model_api.transport.calls[0][2]
    assert headers["Authorization"].startswith("Bearer ")


def test_connection_check_without_declared_free_probe_never_sends_a_request(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        display_name="DashScope",
        adapter_kind="dashscope_http",
        api_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        idempotency_key="profile-no-probe-1",
    )

    result = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/connection-check",
        json={"idempotency_key": "connection-no-probe-1"},
    )

    assert result.status_code == 200, result.text
    assert result.json() == {
        "status": "not_supported",
        "detail": "此服务没有可确认的免费连接检查；发布后可手动运行真实能力测试。",
        "checked_at": result.json()["checked_at"],
        "profile_version_number": 1,
    }
    assert family_model_api.transport.calls == []


def test_connection_check_replays_safe_result_and_hides_provider_response(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-connection-replay-1")
    family_model_api.transport.responses.append(
        ProviderResponse(
            status_code=200,
            headers={"x-provider-debug": "do-not-leak"},
            content=b'{"secret": "do-not-leak"}',
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
