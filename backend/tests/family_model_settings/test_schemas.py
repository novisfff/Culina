from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.family_model_settings import (
    FamilyModelConfigDraftPayload,
    ProviderProfileCreateRequest,
    ProviderProfileOut,
    ProviderProfilePatchRequest,
    RotateProviderProfileSecretOut,
)


def test_provider_request_forbids_server_owned_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        ProviderProfileCreateRequest.model_validate(
            {
                "family_id": "other-family",
                "display_name": "家用模型",
                "adapter_kind": "openai_compatible_http",
                "auth_mode": "api_key",
                "api_base_url": "https://example.com/v1",
                "api_key": "secret",
                "arbitrary_option": True,
                "idempotency_key": "profile-create-1",
            }
        )


def test_dashscope_provider_only_requires_api_key_and_uses_official_endpoints() -> None:
    payload = ProviderProfileCreateRequest.model_validate(
        {
            "display_name": "通义千问",
            "adapter_kind": "dashscope",
            "api_key": "sk-test",
            "idempotency_key": "dashscope-create-1",
        }
    )
    assert payload.api_base_url == "https://dashscope.aliyuncs.com/api/v1"
    assert payload.websocket_base_url == "wss://dashscope.aliyuncs.com/api-ws/v1"
    assert payload.auth_mode == "api_key"


def test_provider_response_has_no_encrypted_or_plain_secret_fields() -> None:
    assert {
        "api_key",
        "new_api_key",
        "nonce",
        "ciphertext",
        "auth_tag",
        "secret_fingerprint",
    }.isdisjoint(ProviderProfileOut.model_fields)


def test_secret_rotation_response_exposes_configuration_state_not_a_secret_fingerprint() -> None:
    assert {
        "api_key",
        "new_api_key",
        "nonce",
        "ciphertext",
        "auth_tag",
        "secret_fingerprint",
        "fingerprint_label",
    }.isdisjoint(RotateProviderProfileSecretOut.model_fields)


def test_provider_patch_cannot_change_credential_scope() -> None:
    assert {
        "adapter_kind",
        "auth_mode",
        "api_base_url",
        "websocket_base_url",
        "workspace_id",
        "region",
        "project_id",
        "api_key",
    }.isdisjoint(ProviderProfilePatchRequest.model_fields)
    with pytest.raises(ValidationError):
        ProviderProfilePatchRequest.model_validate(
            {
                "base_profile_version_number": 1,
                "idempotency_key": "profile-patch-1",
                "api_base_url": "https://another.example/v1",
            }
        )


def test_draft_uses_a_closed_discriminated_binding_union() -> None:
    payload = FamilyModelConfigDraftPayload.model_validate(
        {
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": "profile-1",
                    "requested_model": "family-chat",
                    "max_output_tokens": 2048,
                },
                {
                    "capability": "embedding",
                    "variant_key": "search",
                    "enabled": True,
                    "provider_profile_id": "profile-1",
                    "requested_model": "family-embedding",
                    "dimensions": 1024,
                },
            ]
        }
    )

    assert [binding.capability for binding in payload.bindings] == ["llm", "embedding"]
    with pytest.raises(ValidationError):
        FamilyModelConfigDraftPayload.model_validate(
            {
                "bindings": [
                    {
                        "capability": "llm",
                        "variant_key": "primary",
                        "enabled": True,
                        "provider_profile_id": "profile-1",
                        "requested_model": "family-chat",
                        "max_output_tokens": 2048,
                        "unknown_option": "blocked",
                    }
                ]
            }
        )


def test_draft_rejects_duplicate_capability_variant_identities() -> None:
    with pytest.raises(ValidationError):
        FamilyModelConfigDraftPayload.model_validate(
            {
                "bindings": [
                    {
                        "capability": "llm",
                        "variant_key": "primary",
                        "enabled": False,
                        "max_output_tokens": 1024,
                    },
                    {
                        "capability": "llm",
                        "variant_key": "primary",
                        "enabled": False,
                        "max_output_tokens": 2048,
                    },
                ]
            }
        )
