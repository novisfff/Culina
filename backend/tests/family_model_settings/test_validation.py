from __future__ import annotations

from copy import deepcopy

import pytest

from app.models.family_model_settings import (
    FamilyModelConfigDraft,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
)
from app.services.family_model_settings.validation import (
    ValidateDraftCommand,
    validate_family_model_draft,
)

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _llm_payload(profile_id: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-primary-model",
                "max_output_tokens": 1024,
            }
        ],
        "price_rates": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "meter": meter,
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
            for meter in (
                "uncached_input_tokens",
                "cached_input_tokens",
                "output_tokens",
            )
        ],
        "change_note": "测试家庭模型配置",
    }


def _save_draft(
    context: FamilyModelApiContext,
    payload: dict[str, object],
    *,
    base_draft_version_number: int = 0,
    idempotency_key: str = "validation-draft-save-1",
) -> dict[str, object]:
    response = context.client.put(
        "/api/family/model-settings/draft",
        json=payload
        | {
            "base_draft_version_number": base_draft_version_number,
            "idempotency_key": idempotency_key,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _validate(
    context: FamilyModelApiContext,
    *,
    family_id: str = "family-a",
    actor_user_id: str = "owner-a",
    base_draft_version_number: int | None = None,
):
    with context.session_factory() as db:
        result = validate_family_model_draft(
            db,
            ValidateDraftCommand(
                family_id=family_id,
                actor_user_id=actor_user_id,
                network_policy=context.policy,
                base_draft_version_number=base_draft_version_number,
            ),
        )
        db.commit()
        return result


def _profile_version(db, profile_id: str) -> tuple[FamilyModelProviderProfile, FamilyModelProviderProfileVersion]:
    profile = db.get(FamilyModelProviderProfile, profile_id)
    assert profile is not None and profile.current_profile_version_id is not None
    version = db.get(FamilyModelProviderProfileVersion, profile.current_profile_version_id)
    assert version is not None
    return profile, version


def test_validation_returns_checksums_and_only_persists_safe_error_facts(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-valid-1")
    draft = _save_draft(family_model_api, _llm_payload(str(profile["id"])))

    result = _validate(
        family_model_api,
        base_draft_version_number=int(draft["draft_version_number"]),
    )

    assert result.valid is True
    assert result.config_checksum is not None and len(result.config_checksum) == 64
    assert result.price_checksum is not None and len(result.price_checksum) == 64
    assert result.errors == ()
    with family_model_api.session_factory() as db:
        saved = db.get(FamilyModelConfigDraft, "family-a")
        assert saved is not None
        assert saved.validation_status == "valid"
        assert saved.validation_errors_json == []
        assert "sk-family-model-secret-marker" not in str(saved.validation_errors_json)


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        ("missing_secret", "family_model_credentials_missing"),
        ("unsupported_adapter", "family_model_provider_protocol_unsupported"),
        (
            "scope_mismatch",
            "family_model_provider_scope_change_requires_new_profile",
        ),
        ("missing_price", "family_model_price_incomplete"),
        ("unsupported_scheme", "family_model_billing_scheme_unsupported"),
        ("blocked_endpoint", "family_model_endpoint_blocked"),
        ("public_no_auth", "family_model_provider_protocol_unsupported"),
    ],
)
def test_validation_returns_stable_codes_for_mandatory_publish_rules(
    family_model_api: FamilyModelApiContext,
    mutation: str,
    expected_code: str,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key=f"validation-profile-{mutation}-1"
    )
    payload = _llm_payload(str(profile["id"]))
    if mutation == "missing_price":
        payload["price_rates"] = list(payload["price_rates"])[:-1]
    draft = _save_draft(
        family_model_api,
        payload,
        idempotency_key=f"validation-draft-{mutation}-1",
    )

    with family_model_api.session_factory() as db:
        current_profile, version = _profile_version(db, str(profile["id"]))
        if mutation == "missing_secret":
            current_profile.current_secret_version_id = None
        elif mutation == "unsupported_adapter":
            version.adapter_kind = "openai_realtime"
            version.api_base_url = "wss://provider.example/v1"
            version.websocket_base_url = None
            version.credential_scope_checksum = current_profile.credential_scope_checksum
        elif mutation == "scope_mismatch":
            version.credential_scope_checksum = "0" * 64
        elif mutation == "unsupported_scheme":
            stored = db.get(FamilyModelConfigDraft, "family-a")
            assert stored is not None
            unsafe = deepcopy(stored.payload_json)
            unsafe["bindings"][0]["billing_scheme_key"] = "image-count-v1"
            stored.payload_json = unsafe
        elif mutation == "blocked_endpoint":
            version.api_base_url = "http://127.0.0.1/v1"
        elif mutation == "public_no_auth":
            version.auth_mode = "no_auth"
        db.commit()

    result = _validate(
        family_model_api,
        base_draft_version_number=int(draft["draft_version_number"]),
    )

    assert result.valid is False
    assert expected_code in {issue.code for issue in result.errors}
    with family_model_api.session_factory() as db:
        saved = db.get(FamilyModelConfigDraft, "family-a")
        assert saved is not None
        assert saved.validation_status == "invalid"
        assert {item["code"] for item in saved.validation_errors_json} >= {expected_code}


def test_validation_rejects_cross_family_profile_references_without_leaking_metadata(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-family-a-1")
    with family_model_api.session_factory() as db:
        db.add(
            FamilyModelConfigDraft(
                family_id="family-b",
                draft_version_number=1,
                payload_json=_llm_payload(str(profile["id"])),
                updated_by="owner-b",
            )
        )
        db.commit()

    result = _validate(
        family_model_api,
        family_id="family-b",
        actor_user_id="owner-b",
        base_draft_version_number=1,
    )

    assert result.valid is False
    assert "family_model_provider_not_found" in {issue.code for issue in result.errors}
    assert str(profile["id"]) not in str(tuple(issue.record() for issue in result.errors))


def test_validation_rejects_llm_fallback_without_primary(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-fallback-1")
    payload = _llm_payload(str(profile["id"]))
    payload["bindings"] = [
        {
            "capability": "llm",
            "variant_key": "fallback",
            "enabled": True,
            "provider_profile_id": profile["id"],
            "requested_model": "family-fallback-model",
            "max_output_tokens": 1024,
        }
    ]
    payload["price_rates"] = [
        {**rate, "variant_key": "fallback"}
        for rate in payload["price_rates"]
    ]
    draft = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-draft-fallback-1",
    )

    result = _validate(
        family_model_api,
        base_draft_version_number=int(draft["draft_version_number"]),
    )

    assert result.valid is False
    assert "family_model_llm_fallback_requires_primary" in {
        issue.code for issue in result.errors
    }
