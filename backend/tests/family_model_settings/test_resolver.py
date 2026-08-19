from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from app.core.enums import FamilyModelSecretStatus
from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelSecretVersion,
    FamilyModelSettings,
)
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _llm_payload(profile_id: str, *, model: str = "family-primary-model") -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": model,
                "max_output_tokens": 256,
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
        "change_note": "resolver test",
    }


def _publish_llm(context: FamilyModelApiContext, *, model: str = "family-primary-model") -> dict[str, Any]:
    profile = context.create_profile(
        display_name=f"家庭 OpenAI {model}",
        idempotency_key=f"resolver-profile-{model}",
    )
    current_draft = context.client.get("/api/family/model-settings/draft")
    assert current_draft.status_code in {200, 404}, current_draft.text
    base_draft_version_number = (
        int(current_draft.json()["draft_version_number"])
        if current_draft.status_code == 200
        else 0
    )
    base_config_revision_id = (
        current_draft.json().get("base_config_revision_id")
        if current_draft.status_code == 200
        else None
    )
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_llm_payload(str(profile["id"]), model=model)
        | {
            "base_config_revision_id": base_config_revision_id,
            "base_draft_version_number": base_draft_version_number,
            "idempotency_key": f"resolver-draft-{model}",
        },
    )
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    validation = context.client.post(
        "/api/family/model-settings/draft/validate",
        json={"base_draft_version_number": draft["draft_version_number"]},
    )
    assert validation.status_code == 200, validation.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    published = context.client.post(
        "/api/family/model-settings/publish",
        json={
            "base_settings_version_number": settings.json()["version_number"],
            "base_draft_version_number": draft["draft_version_number"],
            "idempotency_key": f"resolver-publish-{model}",
            "config_checksum": validation.json()["config_checksum"],
            "price_checksum": validation.json()["price_checksum"],
            "current_password": "OwnerPass123",
        },
    )
    assert published.status_code == 200, published.text
    return {"profile": profile, "published": published.json()}


def _resolver(context: FamilyModelApiContext, db: Any) -> FamilyModelConfigurationResolver:
    return FamilyModelConfigurationResolver(
        db,
        network_policy=context.policy,
        cipher=context.cipher,
    )


def test_resolve_active_returns_immutable_binding_without_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    prepared = _publish_llm(family_model_api)
    with family_model_api.session_factory() as db:
        resolved = _resolver(family_model_api, db).resolve_active("family-a", "llm", "primary")

    assert resolved.config_revision_id == prepared["published"]["config_revision_id"]
    assert resolved.requested_model == "family-primary-model"
    assert not hasattr(resolved, "api_key")
    assert resolved.provider_profile_id == prepared["profile"]["id"]


def test_resolve_historical_revision_keeps_its_model_binding(
    family_model_api: FamilyModelApiContext,
) -> None:
    first = _publish_llm(family_model_api, model="family-old-model")
    second = _publish_llm(family_model_api, model="family-new-model")

    with family_model_api.session_factory() as db:
        resolver = _resolver(family_model_api, db)
        active = resolver.resolve_active("family-a", "llm", "primary")
        historical = resolver.resolve_revision(
            "family-a",
            str(first["published"]["config_revision_id"]),
            "llm",
            "primary",
        )

    assert active.config_revision_id == second["published"]["config_revision_id"]
    assert active.requested_model == "family-new-model"
    assert historical.config_revision_id == first["published"]["config_revision_id"]
    assert historical.requested_model == "family-old-model"


@pytest.mark.parametrize(
    ("state", "code"),
    (
        ("unconfigured", "family_model_settings_not_configured"),
        ("disabled", "family_model_capability_disabled"),
        ("cross_family", "family_model_configuration_not_found"),
    ),
)
def test_resolver_fails_closed_for_unavailable_bindings(
    family_model_api: FamilyModelApiContext,
    state: str,
    code: str,
) -> None:
    prepared = _publish_llm(family_model_api) if state != "unconfigured" else None
    with family_model_api.session_factory() as db:
        resolver = _resolver(family_model_api, db)
        if state == "unconfigured":
            with pytest.raises(FamilyModelSettingsError) as raised:
                resolver.resolve_active("family-b", "llm", "primary")
        elif state == "disabled":
            assert prepared is not None
            with pytest.raises(FamilyModelSettingsError) as raised:
                resolver.resolve_revision(
                    "family-a",
                    str(prepared["published"]["config_revision_id"]),
                    "llm",
                    "fallback",
                )
        else:
            assert prepared is not None
            with pytest.raises(FamilyModelSettingsError) as raised:
                resolver.resolve_revision(
                    "family-b",
                    str(prepared["published"]["config_revision_id"]),
                    "llm",
                    "primary",
                )
    assert raised.value.code == code


def test_resolve_dispatch_credential_uses_secret_fixed_by_dispatch_permit(
    family_model_api: FamilyModelApiContext,
) -> None:
    prepared = _publish_llm(family_model_api)
    profile_id = str(prepared["profile"]["id"])
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = _resolver(family_model_api, db).resolve_revision(
            "family-a", settings.active_config_revision_id, "llm", "primary"
        )
        old_secret_id = db.scalar(
            select(FamilyModelSecretVersion.id)
            .where(
                FamilyModelSecretVersion.family_id == "family-a",
                FamilyModelSecretVersion.profile_id == profile_id,
            )
            .order_by(FamilyModelSecretVersion.version_number.asc())
            .limit(1)
        )
        assert old_secret_id is not None
        settings_version = settings.version_number

    rotated = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile_id}/rotate-key",
        json={
            "current_password": "OwnerPass123",
            "new_api_key": "sk-family-model-rotated-marker",
            "base_settings_version_number": settings_version,
            "idempotency_key": "resolver-rotate-secret",
        },
    )
    assert rotated.status_code == 200, rotated.text

    with family_model_api.session_factory() as db:
        resolver = _resolver(family_model_api, db)
        old_credential = resolver.resolve_dispatch_credential(binding, old_secret_id)
        profile = db.scalar(
            select(FamilyModelProviderProfile).where(
                FamilyModelProviderProfile.family_id == "family-a",
                FamilyModelProviderProfile.id == profile_id,
            )
        )
        assert profile is not None and profile.current_secret_version_id is not None
        latest = resolver.resolve_dispatch_credential(
            binding,
            profile.current_secret_version_id,
        )
        old = db.get(FamilyModelSecretVersion, old_secret_id)

    assert old is not None and old.status is FamilyModelSecretStatus.REVOKED
    assert old_credential.api_key == "sk-family-model-secret-marker"
    assert latest.api_key == "sk-family-model-rotated-marker"


def test_resolve_dispatch_credential_rejects_destroyed_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    prepared = _publish_llm(family_model_api)
    profile_id = str(prepared["profile"]["id"])
    with family_model_api.session_factory() as db:
        resolver = _resolver(family_model_api, db)
        binding = resolver.resolve_active("family-a", "llm", "primary")
        secret = db.scalar(
            select(FamilyModelSecretVersion)
            .where(
                FamilyModelSecretVersion.family_id == "family-a",
                FamilyModelSecretVersion.profile_id == profile_id,
            )
        )
        assert secret is not None
        secret.status = FamilyModelSecretStatus.DESTROYED
        secret.nonce = None
        secret.ciphertext = None
        secret.auth_tag = None
        db.commit()
        with pytest.raises(FamilyModelSettingsError) as raised:
            resolver.resolve_dispatch_credential(binding, secret.id)

    assert raised.value.code == "family_model_secret_unavailable"
