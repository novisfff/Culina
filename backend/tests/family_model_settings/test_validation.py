from __future__ import annotations

from copy import deepcopy

import pytest
from sqlalchemy import select

from app.models.family_model_settings import (
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
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


def test_missing_prices_are_completed_with_zero_rates_and_saved_config_activates(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-zero-price-1")
    payload = _llm_payload(str(profile["id"]))
    payload["price_rates"] = []

    saved = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-zero-price-save-1",
    )

    assert saved["validation_status"] == "valid"
    assert saved["validation_errors"] == []
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is not None
        assert settings.active_price_version_id is not None
        rates = tuple(
            db.scalars(
                select(ModelUsagePriceRate).where(
                    ModelUsagePriceRate.price_version_id == settings.active_price_version_id
                )
            )
        )
        assert {rate.meter.value for rate in rates} == {
            "uncached_input_tokens",
            "cached_input_tokens",
            "output_tokens",
        }
        assert all(rate.unit_price == 0 for rate in rates)


def test_incomplete_saved_config_is_non_blocking_and_keeps_previous_active_snapshot(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-incomplete-1")
    active = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-active-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        active_revision_id = settings.active_config_revision_id
        active_price_id = settings.active_price_version_id

    incomplete = _llm_payload(str(profile["id"]))
    incomplete["bindings"][0]["requested_model"] = ""  # type: ignore[index]
    saved = _save_draft(
        family_model_api,
        incomplete,
        base_draft_version_number=int(active["draft_version_number"]),
        idempotency_key="validation-incomplete-save-1",
    )

    assert saved["validation_status"] == "invalid"
    assert "family_model_requested_model_required" in {
        item["code"] for item in saved["validation_errors"]
    }
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id == active_revision_id
        assert settings.active_price_version_id == active_price_id


def test_repeated_identical_config_save_reuses_runtime_snapshots(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-reuse-1")
    payload = _llm_payload(str(profile["id"]))
    first = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-reuse-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        first_revision_id = settings.active_config_revision_id
        first_price_id = settings.active_price_version_id
        first_settings_version = settings.version_number

    second = _save_draft(
        family_model_api,
        payload,
        base_draft_version_number=int(first["draft_version_number"]),
        idempotency_key="validation-reuse-save-2",
    )

    assert second["validation_status"] == "valid"
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id == first_revision_id
        assert settings.active_price_version_id == first_price_id
        assert settings.version_number == first_settings_version
        assert len(tuple(db.scalars(select(FamilyModelConfigRevision)))) == 1
        assert len(tuple(db.scalars(select(ModelUsagePriceVersion)))) == 1


def test_price_only_change_reuses_config_revision_and_activates_new_price_snapshot(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-price-change-1")
    payload = _llm_payload(str(profile["id"]))
    first = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-price-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        first_revision_id = settings.active_config_revision_id
        first_price_id = settings.active_price_version_id

    changed = deepcopy(payload)
    changed["price_rates"][0]["unit_price"] = "0.02"  # type: ignore[index]
    saved = _save_draft(
        family_model_api,
        changed,
        base_draft_version_number=int(first["draft_version_number"]),
        idempotency_key="validation-price-save-2",
    )

    assert saved["validation_status"] == "valid"
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id == first_revision_id
        assert settings.active_price_version_id != first_price_id
        assert len(tuple(db.scalars(select(FamilyModelConfigRevision)))) == 1
        assert len(tuple(db.scalars(select(ModelUsagePriceVersion)))) == 2


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        ("missing_secret", "family_model_credentials_missing"),
        ("unsupported_adapter", "family_model_provider_protocol_unsupported"),
        (
            "scope_mismatch",
            "family_model_provider_scope_change_requires_new_profile",
        ),
        ("unsupported_scheme", "family_model_billing_scheme_unsupported"),
        ("blocked_endpoint", "family_model_endpoint_address_forbidden"),
        ("public_no_auth", "family_model_provider_protocol_unsupported"),
    ],
)
def test_validation_returns_stable_codes_for_required_configuration_rules(
    family_model_api: FamilyModelApiContext,
    mutation: str,
    expected_code: str,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key=f"validation-profile-{mutation}-1"
    )
    payload = _llm_payload(str(profile["id"]))
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
