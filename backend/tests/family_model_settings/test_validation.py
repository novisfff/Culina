from __future__ import annotations

from copy import deepcopy
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.enums import (
    FamilyModelConfigRevisionStatus,
    FamilyModelPricePurpose,
    FamilyModelSearchProfileStatus,
)
from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.services.family_model_settings.validation import (
    ValidateDraftCommand,
    validate_family_model_draft,
)

from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)


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


def _image_payload(profile_id: str, *, model: str = "family-image-model") -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "image_generation",
                "variant_key": "text",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": model,
                "image_size": "1024x1024",
                "response_format": "b64_json",
            }
        ],
        "price_rates": [
            {
                "capability": "image_generation",
                "variant_key": "text",
                "meter": "generated_images",
                "unit_quantity": "1",
                "unit_price": "0.02",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        "change_note": "测试图片能力",
    }


def _save_draft(
    context: FamilyModelApiContext,
    payload: dict[str, object],
    *,
    base_draft_version_number: int = 0,
    idempotency_key: str = "validation-draft-save-1",
    confirm_initial_search_index: bool = False,
) -> dict[str, object]:
    request = payload | {
        "base_draft_version_number": base_draft_version_number,
        "idempotency_key": idempotency_key,
    }
    if confirm_initial_search_index:
        request["confirm_initial_search_index"] = True
    response = context.client.put(
        "/api/family/model-settings/draft",
        json=request,
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


def test_save_applies_valid_capability_when_another_capability_is_invalid(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-independent-1")
    payload = _llm_payload(str(profile["id"]))
    payload["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "",
        "dimensions": 1536,
    })

    saved = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-independent-save-1",
    )

    assert saved["validation_status"] == "invalid"
    assert "family_model_requested_model_required" in {
        item["code"] for item in saved["validation_errors"]
    }
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is not None
        active_bindings = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        assert {(item.capability.value, item.variant_key) for item in active_bindings} == {
            ("llm", "primary")
        }


def test_invalid_llm_primary_does_not_activate_fallback_from_same_payload(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-independent-2")
    payload = _llm_payload(str(profile["id"]))
    payload["bindings"] = [
        {
            "capability": "llm",
            "variant_key": "primary",
            "enabled": True,
            "provider_profile_id": str(profile["id"]),
            "requested_model": "",
            "max_output_tokens": 1024,
        },
        {
            "capability": "llm",
            "variant_key": "fallback",
            "enabled": True,
            "provider_profile_id": str(profile["id"]),
            "requested_model": "fallback-model",
            "max_output_tokens": 1024,
        },
    ]
    payload["price_rates"] = [
        {**rate, "variant_key": variant}
        for variant in ("primary", "fallback")
        for rate in _llm_payload(str(profile["id"]))["price_rates"]
    ]

    saved = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-independent-save-2",
    )

    assert saved["validation_status"] == "invalid"
    assert "family_model_requested_model_required" in {
        item["code"] for item in saved["validation_errors"]
    }
    assert "family_model_llm_fallback_requires_primary" in {
        item["code"] for item in saved["validation_errors"]
    }
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is None


def test_invalid_llm_primary_edit_keeps_existing_primary_and_allows_fallback_edit(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-independent-3")
    initial_payload = _llm_payload(str(profile["id"]))
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-independent-save-3-initial",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        initial_revision_id = settings.active_config_revision_id
        assert initial_revision_id is not None

    payload = deepcopy(initial_payload)
    payload["bindings"] = [
        {
            "capability": "llm",
            "variant_key": "primary",
            "enabled": True,
            "provider_profile_id": str(profile["id"]),
            "requested_model": "",
            "max_output_tokens": 1024,
        },
        {
            "capability": "llm",
            "variant_key": "fallback",
            "enabled": True,
            "provider_profile_id": str(profile["id"]),
            "requested_model": "new-fallback-model",
            "max_output_tokens": 1024,
        },
    ]
    payload["price_rates"] = [
        {**rate, "variant_key": variant}
        for variant in ("primary", "fallback")
        for rate in _llm_payload(str(profile["id"]))["price_rates"]
    ]

    saved = _save_draft(
        family_model_api,
        payload,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-independent-save-3-edit",
    )

    assert saved["validation_status"] == "invalid"
    error_codes = {item["code"] for item in saved["validation_errors"]}
    assert "family_model_requested_model_required" in error_codes
    assert "family_model_llm_fallback_requires_primary" not in error_codes
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id != initial_revision_id
        active_bindings = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        active_models = {
            (item.capability.value, item.variant_key): item.requested_model
            for item in active_bindings
            if item.enabled
        }
        assert active_models == {
            ("llm", "primary"): "family-primary-model",
            ("llm", "fallback"): "new-fallback-model",
        }


def test_fixing_one_invalid_capability_later_activates_it_without_losing_active_sibling(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-independent-4")
    first_payload = _llm_payload(str(profile["id"]))
    first_payload["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "",
        "dimensions": 1536,
    })
    first = _save_draft(
        family_model_api,
        first_payload,
        idempotency_key="validation-independent-save-4-first",
    )

    fixed_payload = deepcopy(first_payload)
    fixed_payload["bindings"][-1]["requested_model"] = "embedding-model"  # type: ignore[index]
    fixed_payload["price_rates"].append({  # type: ignore[union-attr]
        "capability": "embedding",
        "variant_key": "search",
        "meter": "embedding_tokens",
        "unit_quantity": "1000000",
        "unit_price": "0.01",
        "source_currency": "CNY",
        "fx_to_cny": "1",
    })  # type: ignore[union-attr]
    second = _save_draft(
        family_model_api,
        fixed_payload,
        base_draft_version_number=int(first["draft_version_number"]),
        idempotency_key="validation-independent-save-4-second",
        confirm_initial_search_index=True,
    )

    assert second["validation_status"] == "valid", second
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        active_bindings = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        assert {
            (item.capability.value, item.variant_key, item.requested_model)
            for item in active_bindings
            if item.enabled
        } == {
            ("llm", "primary", "family-primary-model"),
            ("embedding", "search", "embedding-model"),
        }


def test_sparse_save_preserves_an_unresolved_sibling_draft(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-sparse-sibling-profile-1"
    )
    first_payload = _llm_payload(str(profile["id"]))
    first_payload["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "",
        "dimensions": 1536,
    })
    first = _save_draft(
        family_model_api,
        first_payload,
        idempotency_key="validation-sparse-sibling-save-1",
    )

    second = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"]), model="sparse-image-model"),
        base_draft_version_number=int(first["draft_version_number"]),
        idempotency_key="validation-sparse-sibling-save-2",
    )

    assert second["validation_status"] == "invalid"
    assert "family_model_requested_model_required" in {
        item["code"] for item in second["validation_errors"]
    }
    bindings = {
        (item["capability"], item["variant_key"]): item
        for item in second["payload"]["bindings"]
    }
    assert ("embedding", "search") in bindings
    assert bindings[("embedding", "search")]["requested_model"] == ""
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        assert {
            (item.capability.value, item.variant_key)
            for item in active
            if item.enabled
        } == {
            ("llm", "primary"),
            ("image_generation", "text"),
        }


def test_get_draft_recovers_from_structurally_corrupt_legacy_json_without_secrets(
    family_model_api: FamilyModelApiContext,
) -> None:
    with family_model_api.session_factory() as db:
        db.add(
            FamilyModelConfigDraft(
                family_id="family-a",
                draft_version_number=7,
                payload_json={
                    "api_key": SECRET_MARKER,
                    "bindings": [
                        {
                            "capability": "llm",
                            "variant_key": "primary",
                            "enabled": False,
                            "max_output_tokens": 64,
                            "removed_option": SECRET_MARKER,
                        },
                        {"capability": "removed", "variant_key": "legacy"},
                    ],
                    "price_rates": [{"not": "a-rate"}],
                    "change_note": "历史草稿",
                },
                validation_status="valid",
                validation_errors_json=[
                    {"code": "family_model_draft_invalid", "api_key": SECRET_MARKER}
                ],
                updated_by="owner-a",
            )
        )
        db.commit()

    response = family_model_api.client.get("/api/family/model-settings/draft")

    assert response.status_code == 200, response.text
    assert SECRET_MARKER not in response.text
    body = response.json()
    assert body["validation_status"] == "invalid"
    assert body["payload"]["bindings"][0]["capability"] == "llm"
    assert all("api_key" not in item for item in body["validation_errors"])


def test_locked_embedding_candidate_is_not_stored_as_active_identity_when_sibling_succeeds(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-locked-embedding-profile-1"
    )
    initial_payload = _llm_payload(str(profile["id"]))
    initial_payload["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "locked-embedding-model",
        "dimensions": 1536,
    })
    initial_payload["price_rates"].append({
        "capability": "embedding",
        "variant_key": "search",
        "meter": "embedding_tokens",
        "unit_quantity": "1000000",
        "unit_price": "0.01",
        "source_currency": "CNY",
        "fx_to_cny": "1",
    })
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-locked-embedding-save-1",
        confirm_initial_search_index=True,
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        revision = db.get(FamilyModelConfigRevision, settings.active_config_revision_id)
        assert revision is not None and revision.search_profile_id is not None
        search = db.get(FamilySearchProfile, revision.search_profile_id)
        assert search is not None
        search.status = FamilyModelSearchProfileStatus.ACTIVE
        settings.active_search_profile_id = search.id
        db.commit()

    changed = _image_payload(str(profile["id"]), model="sibling-image-model")
    changed["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "illegal-embedding-change",
        "dimensions": 1536,
    })
    changed["price_rates"].append({
        "capability": "embedding",
        "variant_key": "search",
        "meter": "embedding_tokens",
        "unit_quantity": "1000000",
        "unit_price": "0.02",
        "source_currency": "CNY",
        "fx_to_cny": "1",
    })
    saved = _save_draft(
        family_model_api,
        changed,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-locked-embedding-save-2",
    )

    assert saved["validation_status"] == "invalid"
    assert "family_search_profile_locked" in {
        item["code"] for item in saved["validation_errors"]
    }
    embedding = next(
        item
        for item in saved["payload"]["bindings"]
        if item["capability"] == "embedding"
    )
    assert embedding["requested_model"] == "locked-embedding-model"
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        assert {
            (item.capability.value, item.variant_key, item.requested_model)
            for item in active
            if item.enabled
        } == {
            ("llm", "primary", "family-primary-model"),
            ("embedding", "search", "locked-embedding-model"),
            ("image_generation", "text", "sibling-image-model"),
        }


def test_price_only_edit_does_not_revalidate_an_active_provider(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-price-disabled-1")
    initial_payload = _llm_payload(str(profile["id"]))
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-price-disabled-save-1",
    )
    with family_model_api.session_factory() as db:
        current = db.get(FamilyModelProviderProfile, str(profile["id"]))
        assert current is not None
        current.status = "disabled"
        db.commit()

    changed = deepcopy(initial_payload)
    changed["price_rates"][0]["unit_price"] = "0.02"  # type: ignore[index]
    saved = _save_draft(
        family_model_api,
        changed,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-price-disabled-save-2",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_price_version_id is not None
        rate = db.scalar(
            select(ModelUsagePriceRate).where(
                ModelUsagePriceRate.price_version_id == settings.active_price_version_id,
                ModelUsagePriceRate.meter == "uncached_input_tokens",
            )
        )
        assert rate is not None
        assert rate.unit_price == Decimal("0.02")


def test_unknown_legacy_binding_options_do_not_block_an_unrelated_save(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-legacy-options-1")
    initial_payload = _llm_payload(str(profile["id"]))
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-legacy-options-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
            )
        )
        assert binding is not None
        binding.options_json = {**binding.options_json, "removed_legacy_option": "ignored"}
        db.commit()

    changed = deepcopy(initial_payload)
    changed["price_rates"][0]["unit_price"] = "0.03"  # type: ignore[index]
    saved = _save_draft(
        family_model_api,
        changed,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-legacy-options-save-2",
    )

    assert saved["validation_status"] == "valid", saved


def test_initial_search_confirmation_only_blocks_embedding_and_not_a_valid_llm(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-mixed-initial-1")
    payload = _llm_payload(str(profile["id"]))
    payload["bindings"].append({
        "capability": "embedding",
        "variant_key": "search",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "family-embedding-model",
        "dimensions": 1536,
    })
    payload["price_rates"].append({
        "capability": "embedding",
        "variant_key": "search",
        "meter": "embedding_tokens",
        "unit_quantity": "1000000",
        "unit_price": "0.01",
        "source_currency": "CNY",
        "fx_to_cny": "1",
    })

    saved = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-mixed-initial-save-1",
    )

    assert saved["validation_status"] == "invalid"
    assert "family_search_initial_confirmation_required" in {
        item["code"] for item in saved["validation_errors"]
    }
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        assert {
            (binding.capability.value, binding.variant_key)
            for binding in active
            if binding.enabled
        } == {("llm", "primary")}


def test_sparse_price_edit_keeps_active_binding_without_provider_validation(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-sparse-price-1")
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-sparse-price-save-1",
    )
    with family_model_api.session_factory() as db:
        provider = db.get(FamilyModelProviderProfile, str(profile["id"]))
        assert provider is not None
        provider.status = "disabled"
        db.commit()

    changed = {
        "price_rates": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "meter": "uncached_input_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.04",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        "base_config_revision_id": initial["base_config_revision_id"],
        "base_draft_version_number": initial["draft_version_number"],
        "idempotency_key": "validation-sparse-price-save-2",
    }
    response = family_model_api.client.put("/api/family/model-settings/draft", json=changed)
    assert response.status_code == 200, response.text
    assert response.json()["validation_status"] == "valid", response.text


def test_disabled_binding_with_legacy_prices_does_not_block_other_cards(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-disabled-price-1")
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-disabled-price-save-1",
    )
    disabled_payload = {
        "bindings": [{
            "capability": "llm",
            "variant_key": "primary",
            "enabled": False,
            "max_output_tokens": 1024,
        }],
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
            for meter in ("uncached_input_tokens", "cached_input_tokens", "output_tokens")
        ],
        "base_draft_version_number": initial["draft_version_number"],
        "idempotency_key": "validation-disabled-price-save-2",
    }
    response = family_model_api.client.put("/api/family/model-settings/draft", json=disabled_payload)
    assert response.status_code == 200, response.text
    assert response.json()["validation_status"] == "valid", response.text


def test_identical_errors_for_different_capabilities_keep_distinct_field_paths(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-error-paths-1")
    response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": str(profile["id"]),
                    "requested_model": "",
                    "max_output_tokens": 1024,
                },
                {
                    "capability": "embedding",
                    "variant_key": "search",
                    "enabled": True,
                    "provider_profile_id": str(profile["id"]),
                    "requested_model": "",
                    "dimensions": 1536,
                },
            ],
            "base_draft_version_number": 0,
            "idempotency_key": "validation-error-paths-save-1",
        },
    )
    assert response.status_code == 200, response.text
    paths = {
        (item["code"], item.get("field"))
        for item in response.json()["validation_errors"]
    }
    assert ("family_model_requested_model_required", "bindings.0") in paths
    assert ("family_model_requested_model_required", "bindings.1") in paths


def test_validation_error_paths_follow_normalized_binding_order(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-error-order-profile-1")
    # The request deliberately puts LLM before Image, while the persisted
    # payload is normalized by capability identity (Image before LLM).
    response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": str(profile["id"]),
                    "requested_model": "",
                    "max_output_tokens": 1024,
                },
                {
                    "capability": "image_generation",
                    "variant_key": "text",
                    "enabled": True,
                    "requested_model": "image-model",
                    "image_size": "1024x1024",
                },
            ],
            "base_draft_version_number": 0,
            "idempotency_key": "validation-error-order-save-1",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    normalized_order = [
        (binding["capability"], binding["variant_key"])
        for binding in body["payload"]["bindings"]
    ]
    assert normalized_order == [("image_generation", "text"), ("llm", "primary")]
    paths = {
        (item["code"], item.get("field"))
        for item in body["validation_errors"]
    }
    assert ("family_model_provider_required", "bindings.0") in paths
    assert ("family_model_requested_model_required", "bindings.1") in paths


def test_sparse_price_error_path_follows_merged_rate_order(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-rate-order-profile-1")
    initial_payload = _llm_payload(str(profile["id"]))
    image = _image_payload(str(profile["id"]))
    initial_payload["bindings"].extend(image["bindings"])  # type: ignore[union-attr]
    initial_payload["price_rates"].extend(image["price_rates"])  # type: ignore[union-attr]
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-rate-order-save-1",
    )

    response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [deepcopy(initial_payload["bindings"][0])],  # type: ignore[index]
            "price_rates": [{
                "capability": "llm",
                "variant_key": "primary",
                "meter": "input_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }],
            "base_draft_version_number": initial["draft_version_number"],
            "idempotency_key": "validation-rate-order-save-2",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    invalid_index = next(
        index
        for index, rate in enumerate(body["payload"]["price_rates"])
        if rate["capability"] == "llm" and rate["meter"] == "input_tokens"
    )
    assert {
        (item["code"], item.get("field"))
        for item in body["validation_errors"]
    } >= {("family_model_price_incomplete", f"price_rates.{invalid_index}")}


def test_non_search_edit_ignores_a_stale_search_profile_pointer(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-profile-stale-search-1")
    payload = _llm_payload(str(profile["id"]))
    payload["search_profile_id"] = "historical-missing-search-profile"
    saved = _save_draft(
        family_model_api,
        payload,
        idempotency_key="validation-stale-search-save-1",
    )
    assert saved["validation_status"] == "valid", saved


def test_stale_active_price_pointer_recovers_latest_active_snapshot_for_sibling_edit(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-price-pointer-profile-1")
    initial_payload = _llm_payload(str(profile["id"]))
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-price-pointer-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        revision_id = settings.active_config_revision_id
        assert revision_id is not None
        # Deliberately point at a non-active legacy row attached to the same
        # revision. The save path must recover the real active snapshot.
        stale = ModelUsagePriceVersion(
            id="stale-price-pointer",
            family_id="family-a",
            config_revision_id=revision_id,
            purpose=FamilyModelPricePurpose.LEGACY_GLOBAL,
            version_number=999999,
            status="draft",
            effective_from=utcnow(),
            reviewed_at=utcnow(),
            source_ref="legacy",
            change_note="legacy",
            operator="owner-a",
            manifest_checksum="0" * 64,
            model_aliases_json={},
            fx_rates_json={"CNY": "1"},
        )
        db.add(stale)
        db.flush()
        settings.active_price_version_id = stale.id
        db.commit()

    image_payload = _image_payload(str(profile["id"]))
    saved = _save_draft(
        family_model_api,
        image_payload,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-price-pointer-save-2",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_price_version_id is not None
        llm_rate = db.scalar(
            select(ModelUsagePriceRate).where(
                ModelUsagePriceRate.price_version_id == settings.active_price_version_id,
                ModelUsagePriceRate.capability == "llm",
                ModelUsagePriceRate.variant_key == "primary",
                ModelUsagePriceRate.meter == "uncached_input_tokens",
            )
        )
        assert llm_rate is not None
        assert llm_rate.unit_price == Decimal("0.01")


def test_stale_active_revision_pointer_does_not_become_new_revision_parent(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-revision-pointer-profile-1")
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-revision-pointer-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        settings.active_config_revision_id = "missing-active-revision"
        db.commit()

    changed = _image_payload(str(profile["id"]), model="image-after-stale-revision")
    saved = _save_draft(
        family_model_api,
        changed,
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-revision-pointer-save-2",
    )
    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        revision = db.get(FamilyModelConfigRevision, settings.active_config_revision_id)
        assert revision is not None
        assert revision.base_revision_id != "missing-active-revision"


def test_stale_active_provider_version_does_not_block_sibling_save(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-provider-version-pointer-profile-1"
    )
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-provider-version-pointer-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == "family-a",
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == "llm",
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert binding is not None
        # Simulate a legacy row whose immutable pointer was deleted during a
        # provider-profile repair. The next edit must not copy this ID.
        binding.provider_profile_version_id = "missing-provider-profile-version"
        db.commit()

    saved = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"]), model="image-after-stale-provider-version"),
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-provider-version-pointer-save-2",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active_primary = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == "family-a",
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == "llm",
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert active_primary is not None
        assert active_primary.provider_profile_version_id != "missing-provider-profile-version"
        assert active_primary.enabled is False


def test_superseded_active_revision_pointer_uses_latest_published_baseline(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-revision-status-profile-1"
    )
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-revision-status-save-1",
    )
    second = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"])),
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-revision-status-save-2",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        latest_revision_id = settings.active_config_revision_id
        old_revision_id = db.scalar(
            select(FamilyModelConfigRevision.id).where(
                FamilyModelConfigRevision.family_id == "family-a",
                FamilyModelConfigRevision.id != latest_revision_id,
            )
        )
        assert old_revision_id is not None
        settings.active_config_revision_id = old_revision_id
        db.commit()

    saved = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"]), model="image-after-stale-status"),
        base_draft_version_number=int(second["draft_version_number"]),
        idempotency_key="validation-revision-status-save-3",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        revision = db.get(FamilyModelConfigRevision, settings.active_config_revision_id)
        assert revision is not None
        assert revision.base_revision_id == latest_revision_id
        assert revision.base_revision_id != old_revision_id
        old_revision = db.get(FamilyModelConfigRevision, old_revision_id)
        assert old_revision is not None
        assert old_revision.status == FamilyModelConfigRevisionStatus.SUPERSEDED


def test_disabling_llm_primary_cannot_leave_an_enabled_fallback_orphaned(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-fallback-disable-profile-1")
    initial_payload = _llm_payload(str(profile["id"]))
    initial_payload["bindings"].append({
        "capability": "llm",
        "variant_key": "fallback",
        "enabled": True,
        "provider_profile_id": str(profile["id"]),
        "requested_model": "family-fallback-model",
        "max_output_tokens": 1024,
    })
    initial_payload["price_rates"].extend(
        {**rate, "variant_key": "fallback"}
        for rate in _llm_payload(str(profile["id"]))["price_rates"]
    )
    initial = _save_draft(
        family_model_api,
        initial_payload,
        idempotency_key="validation-fallback-disable-save-1",
    )

    disabled_primary = {
        "bindings": [{
            "capability": "llm",
            "variant_key": "primary",
            "enabled": False,
            "max_output_tokens": 1024,
        }],
        "base_draft_version_number": initial["draft_version_number"],
        "idempotency_key": "validation-fallback-disable-save-2",
    }
    response = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=disabled_primary,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["validation_status"] == "invalid"
    assert "family_model_llm_fallback_requires_primary" in {
        item["code"] for item in body["validation_errors"]
    }

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id
                )
            )
        )
        enabled = {
            (binding.capability.value, binding.variant_key)
            for binding in active
            if binding.enabled
        }
        assert enabled == {
            ("llm", "primary"),
            ("llm", "fallback"),
        }


def test_malformed_legacy_binding_and_rate_rows_are_ignored_for_unrelated_save(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-malformed-history-profile-1")
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-malformed-history-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == "llm",
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert binding is not None
        binding.options_json = {
            "max_output_tokens": "not-an-int",
            "supports_vision": "not-a-bool",
            "prompt_cache_enabled": None,
        }
        binding.billing_scheme_key = "removed-billing-scheme"
        price = db.get(ModelUsagePriceVersion, settings.active_price_version_id)
        assert price is not None
        # This is a known enum value but not a billable meter owned by LLM.
        db.add(
            ModelUsagePriceRate(
                id="legacy-invalid-llm-meter",
                price_version_id=price.id,
                provider=str(profile["id"]),
                billing_model="family-primary-model",
                capability="llm",
                variant_key="primary",
                billing_scheme_key="llm-split-v1",
                meter="input_tokens",
                meter_role="informational",
                unit_quantity=Decimal("1"),
                unit_price=Decimal("99"),
                source_currency="CNY",
                fx_to_cny=Decimal("1"),
                unit_price_cny=Decimal("99"),
                reported_model_aliases=[],
            )
        )
        db.commit()

    saved = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"])),
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-malformed-history-save-2",
    )
    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_price_version_id is not None
        rates = tuple(
            db.scalars(
                select(ModelUsagePriceRate).where(
                    ModelUsagePriceRate.price_version_id == settings.active_price_version_id,
                    ModelUsagePriceRate.capability == "llm",
                    ModelUsagePriceRate.variant_key == "primary",
                )
            )
        )
        assert {rate.meter.value for rate in rates} == {
            "uncached_input_tokens",
            "cached_input_tokens",
            "output_tokens",
        }


def test_unknown_legacy_binding_variant_does_not_make_sibling_save_fail(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="validation-unknown-variant-profile-1")
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-unknown-variant-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == "llm",
            )
        )
        assert binding is not None
        binding.variant_key = "removed-variant"
        db.commit()

    saved = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"])),
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-unknown-variant-save-2",
    )
    assert saved["validation_status"] == "valid", saved


def test_valid_search_pointer_survives_a_missing_active_revision(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-orphan-search-pointer-profile-1"
    )
    with family_model_api.session_factory() as db:
        provider = db.get(FamilyModelProviderProfile, str(profile["id"]))
        settings = db.get(FamilyModelSettings, "family-a")
        assert provider is not None
        assert provider.current_profile_version_id is not None
        assert settings is not None
        search = FamilySearchProfile(
            id="orphan-search-pointer-profile",
            family_id="family-a",
            provider_profile_id=provider.id,
            provider_profile_version_id=provider.current_profile_version_id,
            adapter_kind="openai_compatible_http",
            embedding_model="orphan-embedding-model",
            dimensions=1536,
            distance="Cosine",
            document_builder_version="v1",
            index_identity_checksum="orphan-search-pointer".ljust(64, "0"),
            qdrant_collection="culina_orphan_search_pointer",
            status=FamilyModelSearchProfileStatus.ACTIVE,
            created_by="owner-a",
        )
        db.add(search)
        settings.active_search_profile_id = search.id
        db.commit()

    saved = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-orphan-search-pointer-save-1",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        revision = db.get(FamilyModelConfigRevision, settings.active_config_revision_id)
        assert revision is not None
        assert revision.search_profile_id == "orphan-search-pointer-profile"


def test_malformed_enabled_legacy_binding_is_inert_during_sibling_save(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="validation-malformed-core-profile-1"
    )
    initial = _save_draft(
        family_model_api,
        _llm_payload(str(profile["id"])),
        idempotency_key="validation-malformed-core-save-1",
    )
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == "family-a",
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == "llm",
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert binding is not None
        binding.requested_model = ""
        db.commit()

    saved = _save_draft(
        family_model_api,
        _image_payload(str(profile["id"]), model="image-with-malformed-sibling"),
        base_draft_version_number=int(initial["draft_version_number"]),
        idempotency_key="validation-malformed-core-save-2",
    )

    assert saved["validation_status"] == "valid", saved
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active = tuple(
            db.scalars(
                select(FamilyModelCapabilityBinding).where(
                    FamilyModelCapabilityBinding.family_id == "family-a",
                    FamilyModelCapabilityBinding.config_revision_id
                    == settings.active_config_revision_id,
                )
            )
        )
        primary = next(
            binding
            for binding in active
            if binding.capability.value == "llm" and binding.variant_key == "primary"
        )
        assert primary.enabled is False
