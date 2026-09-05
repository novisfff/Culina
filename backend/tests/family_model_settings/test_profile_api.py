from __future__ import annotations

from sqlalchemy import select

from app.api import family_model_settings as family_model_settings_api
from app.core.enums import FamilyModelSearchProfileStatus
from app.main import app
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.services.family_model_settings.errors import FamilyModelCredentialConfigurationError

from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)


def test_member_cannot_access_owner_model_settings_api(
    family_model_api: FamilyModelApiContext,
) -> None:
    family_model_api.use_member()

    for method, path in (
        ("get", "/api/family/model-settings"),
        ("get", "/api/family/model-settings/draft"),
        ("post", "/api/family/model-settings/provider-profiles"),
    ):
        response = (
            getattr(family_model_api.client, method)(
                path, json={"idempotency_key": "member-blocked-1"}
            )
            if method == "post"
            else getattr(family_model_api.client, method)(path)
        )
        assert response.status_code == 403


def test_member_cannot_update_provider_key(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile()
    settings = family_model_api.client.get("/api/family/model-settings").json()
    family_model_api.use_member()

    response = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/rotate-key",
        json={
            "new_api_key": "sk-member-must-not-write",
            "base_settings_version_number": settings["version_number"],
            "idempotency_key": "profile-member-update-key-1",
        },
    )

    assert response.status_code == 403


def test_profile_create_response_is_write_only_for_key(
    family_model_api: FamilyModelApiContext,
) -> None:
    response = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "家用模型",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "https://provider.example/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "profile-create-redacted-1",
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert SECRET_MARKER not in response.text
    assert "ciphertext" not in response.text.lower()
    assert "api_key" not in payload
    assert payload["credential"]["configured"] is True
    assert payload["credential"]["version_number"] == 1
    with family_model_api.session_factory() as db:
        profile = db.scalar(select(FamilyModelProviderProfile))
        secret = db.scalar(select(FamilyModelSecretVersion))
        assert profile is not None and secret is not None
        assert secret.ciphertext is not None
        assert SECRET_MARKER.encode() not in secret.ciphertext
        assert profile.current_secret_version_id == secret.id


def test_create_dashscope_profile_uses_server_owned_endpoints(
    family_model_api: FamilyModelApiContext,
) -> None:
    response = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "通义千问",
            "adapter_kind": "dashscope",
            "auth_mode": "api_key",
            "api_key": SECRET_MARKER,
            "idempotency_key": "dashscope-profile-1",
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["api_base_url"] == "https://dashscope.aliyuncs.com/api/v1"
    assert body["websocket_base_url"] == "wss://dashscope.aliyuncs.com/api-ws/v1"


def test_invalid_provider_request_never_echoes_write_only_key(
    family_model_api: FamilyModelApiContext,
) -> None:
    response = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "不应写入",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "no_auth",
            "api_base_url": "https://provider.example/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "invalid-provider-secret-1",
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "family_model_request_invalid"
    assert SECRET_MARKER not in response.text


def test_blocked_provider_address_returns_an_actionable_safe_code(
    family_model_api: FamilyModelApiContext,
) -> None:
    response = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "明文公网服务",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "http://47.93.215.184:31317/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "blocked-provider-address-1",
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "family_model_endpoint_insecure_transport_not_allowed"
        }
    }
    assert SECRET_MARKER not in response.text


def test_missing_server_credential_keyring_returns_a_stable_service_error(
    family_model_api: FamilyModelApiContext,
) -> None:
    def raise_configuration_error():
        raise FamilyModelCredentialConfigurationError(
            "family_model_credential_keyring_file_missing"
        )

    app.dependency_overrides[
        family_model_settings_api.get_family_model_credential_cipher
    ] = raise_configuration_error

    response = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "家用模型",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "https://provider.example/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "profile-create-missing-keyring-1",
        },
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": {"code": "family_model_credential_configuration_invalid"}
    }
    assert SECRET_MARKER not in response.text


def test_create_profile_replay_returns_the_safe_original_result(
    family_model_api: FamilyModelApiContext,
) -> None:
    created = family_model_api.create_profile(idempotency_key="profile-replay-1")
    replay = family_model_api.client.post(
        "/api/family/model-settings/provider-profiles",
        json={
            "display_name": "家庭 OpenAI",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "https://provider.example/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "profile-replay-1",
        },
    )

    assert replay.status_code == 201
    assert replay.json() == created
    with family_model_api.session_factory() as db:
        assert len(tuple(db.scalars(select(FamilyModelProviderProfile)))) == 1


def test_profile_patch_rejects_scope_changes_and_cross_family_ids(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile()
    scope_change = family_model_api.client.patch(
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "base_profile_version_number": profile["version_number"],
            "idempotency_key": "profile-scope-change-1",
            "api_base_url": "https://other.example/v1",
        },
    )
    assert scope_change.status_code == 422

    family_model_api.use_owner("family-b")
    cross_family = family_model_api.client.patch(
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "display_name": "不应读取",
            "base_profile_version_number": 1,
            "idempotency_key": "profile-cross-family-1",
        },
    )
    assert cross_family.status_code == 404
    assert cross_family.json()["detail"]["code"] == "family_model_provider_not_found"


def test_profile_patch_uses_profile_occ_and_archive_rejects_draft_reference(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile()
    draft_response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": False,
                    "provider_profile_id": profile["id"],
                    "max_output_tokens": 512,
                }
            ],
            "base_draft_version_number": 0,
            "idempotency_key": "draft-for-archive-api-1",
        },
    )
    assert draft_response.status_code == 200, draft_response.text
    archived = family_model_api.client.patch(
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "status": "archived",
            "base_profile_version_number": profile["version_number"],
            "idempotency_key": "profile-archive-1",
        },
    )
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "family_model_provider_profile_in_use"


def test_profile_archive_rejects_active_binding_reference(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-active-binding-1")
    with family_model_api.session_factory() as db:
        revision = FamilyModelConfigRevision(
            id="revision-active-binding",
            family_id="family-a",
            version_number=1,
            config_checksum="a" * 64,
            change_note="",
            published_by="owner-a",
        )
        db.add(revision)
        db.flush()
        db.add(
            FamilyModelCapabilityBinding(
                id="binding-active-profile",
                family_id="family-a",
                config_revision_id=revision.id,
                capability="llm",
                variant_key="primary",
                enabled=True,
                provider_profile_id=profile["id"],
                requested_model="model",
                options_json={},
                billing_scheme_key="llm-split-v1",
                identity_checksum="b" * 64,
            )
        )
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        settings.active_config_revision_id = revision.id
        db.commit()
    response = family_model_api.client.patch(
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "status": "archived",
            "base_profile_version_number": profile["version_number"],
            "idempotency_key": "profile-active-archive-1",
        },
    )
    assert response.status_code == 409


def test_profile_delete_removes_unbound_profile_and_secret_versions(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-delete-unused-1")

    response = family_model_api.client.request(
        "DELETE",
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "base_profile_version_number": profile["version_number"],
            "confirmation_name": profile["display_name"],
            "idempotency_key": "profile-delete-unused-1",
        },
    )

    assert response.status_code == 204, response.text
    with family_model_api.session_factory() as db:
        assert db.scalar(
            select(FamilyModelProviderProfile).where(
                FamilyModelProviderProfile.id == profile["id"]
            )
        ) is None
        assert db.scalar(select(FamilyModelSecretVersion)) is None


def test_profile_delete_returns_actionable_draft_binding_references(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-delete-draft-1")
    draft_response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "chat-model",
                    "max_output_tokens": 512,
                }
            ],
            "base_draft_version_number": 0,
            "idempotency_key": "draft-for-delete-api-1",
        },
    )
    assert draft_response.status_code == 200, draft_response.text

    response = family_model_api.client.request(
        "DELETE",
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "base_profile_version_number": profile["version_number"],
            "confirmation_name": profile["display_name"],
            "idempotency_key": "profile-delete-draft-2",
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "family_model_provider_profile_in_use"
    assert {
        reference["type"] for reference in detail["blocking_references"]
    } == {"config_draft", "active_config"}
    draft_reference = next(
        reference for reference in detail["blocking_references"]
        if reference["type"] == "config_draft"
    )
    assert draft_reference == {
        "type": "config_draft",
        "name": "当前编辑中的配置",
        "description": "功能设置草稿中的对话与生成 · 主要模型",
        "resource_id": "family-a",
        "can_unbind": True,
    }


def test_profile_deletion_check_returns_search_profile_reference(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-delete-search-1")
    with family_model_api.session_factory() as db:
        provider = db.scalar(
            select(FamilyModelProviderProfile).where(
                FamilyModelProviderProfile.id == profile["id"]
            )
        )
        assert provider is not None and provider.current_profile_version_id is not None
        db.add(
            FamilySearchProfile(
                id="search-profile-delete-check",
                family_id="family-a",
                provider_profile_id=provider.id,
                provider_profile_version_id=provider.current_profile_version_id,
                adapter_kind="openai_compatible_http",
                embedding_model="text-embedding-3-small",
                dimensions=1536,
                distance="Cosine",
                document_builder_version="v1",
                index_identity_checksum="d" * 64,
                qdrant_collection="culina_delete_check",
                status=FamilyModelSearchProfileStatus.ACTIVE,
                created_by="owner-a",
            )
        )
        db.commit()

    response = family_model_api.client.get(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/deletion-check"
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "can_delete": False,
        "blocking_references": [
            {
                "type": "search_profile",
                "name": "智能搜索",
                "description": "向量索引使用模型：text-embedding-3-small",
                "resource_id": "search-profile-delete-check",
                "can_unbind": True,
            }
        ],
    }


def test_profile_delete_detaches_historical_capability_binding_before_removing_profile(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-delete-history-1")
    with family_model_api.session_factory() as db:
        profile_row = db.scalar(
            select(FamilyModelProviderProfile).where(
                FamilyModelProviderProfile.id == profile["id"]
            )
        )
        assert profile_row is not None and profile_row.current_profile_version_id is not None
        revision = FamilyModelConfigRevision(
            id="revision-delete-history",
            family_id="family-a",
            version_number=91,
            config_checksum="c" * 64,
            change_note="",
            published_by="owner-a",
        )
        db.add(revision)
        db.flush()
        db.add(
            FamilyModelCapabilityBinding(
                id="binding-delete-history",
                family_id="family-a",
                config_revision_id=revision.id,
                capability="llm",
                variant_key="primary",
                enabled=True,
                provider_profile_id=profile["id"],
                provider_profile_version_id=profile_row.current_profile_version_id,
                requested_model="history-model",
                options_json={},
                billing_scheme_key="llm-split-v1",
                identity_checksum="d" * 64,
            )
        )
        db.commit()

    response = family_model_api.client.request(
        "DELETE",
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "base_profile_version_number": profile["version_number"],
            "confirmation_name": profile["display_name"],
            "idempotency_key": "profile-delete-history-2",
        },
    )

    assert response.status_code == 204, response.text


def test_profile_delete_detaches_disabled_binding_in_active_revision(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="profile-delete-disabled-1")
    with family_model_api.session_factory() as db:
        profile_row = db.scalar(
            select(FamilyModelProviderProfile).where(
                FamilyModelProviderProfile.id == profile["id"]
            )
        )
        assert profile_row is not None and profile_row.current_profile_version_id is not None
        revision = FamilyModelConfigRevision(
            id="revision-delete-disabled",
            family_id="family-a",
            version_number=92,
            config_checksum="e" * 64,
            change_note="",
            published_by="owner-a",
        )
        db.add(revision)
        db.flush()
        db.add(
            FamilyModelCapabilityBinding(
                id="binding-delete-disabled",
                family_id="family-a",
                config_revision_id=revision.id,
                capability="llm",
                variant_key="fallback",
                enabled=False,
                provider_profile_id=profile["id"],
                provider_profile_version_id=profile_row.current_profile_version_id,
                requested_model="disabled-model",
                options_json={},
                billing_scheme_key="llm-split-v1",
                identity_checksum="f" * 64,
            )
        )
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        settings.active_config_revision_id = revision.id
        db.commit()

    response = family_model_api.client.request(
        "DELETE",
        f"/api/family/model-settings/provider-profiles/{profile['id']}",
        json={
            "base_profile_version_number": profile["version_number"],
            "confirmation_name": profile["display_name"],
            "idempotency_key": "profile-delete-disabled-2",
        },
    )

    assert response.status_code == 204, response.text


def test_update_key_does_not_require_account_password_or_echo_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile()
    settings = family_model_api.client.get("/api/family/model-settings").json()
    response = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/rotate-key",
        json={
            "new_api_key": "sk-rotated-secret-marker",
            "base_settings_version_number": settings["version_number"],
            "idempotency_key": "profile-rotate-api-1",
        },
    )
    assert response.status_code == 200, response.text
    assert "sk-rotated-secret-marker" not in response.text
    assert response.json()["configured"] is True
