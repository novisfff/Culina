from __future__ import annotations

import inspect

from app.services.model_usage.configured_variants import configured_usage_variants

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _publish_family_llm(
    context: FamilyModelApiContext,
    *,
    family_id: str,
    suffix: str,
    model: str,
) -> tuple[str, str]:
    context.use_owner(family_id)
    profile = context.create_profile(
        display_name=f"家庭模型 {suffix}",
        idempotency_key=f"variant-profile-{suffix}",
    )
    draft = context.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": model,
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
            "change_note": f"配置 {suffix}",
            "base_draft_version_number": 0,
            "idempotency_key": f"variant-draft-{suffix}",
        },
    )
    assert draft.status_code == 200, draft.text
    validation = context.client.post(
        "/api/family/model-settings/draft/validate",
        json={"base_draft_version_number": draft.json()["draft_version_number"]},
    )
    assert validation.status_code == 200, validation.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    published = context.client.post(
        "/api/family/model-settings/publish",
        json={
            "base_settings_version_number": settings.json()["version_number"],
            "base_draft_version_number": draft.json()["draft_version_number"],
            "idempotency_key": f"variant-publish-{suffix}",
            "config_checksum": validation.json()["config_checksum"],
            "price_checksum": validation.json()["price_checksum"],
            "current_password": "OwnerPass123",
        },
    )
    assert published.status_code == 200, published.text
    return str(profile["id"]), str(published.json()["config_revision_id"])


def test_configured_variants_come_from_one_family_revision(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile_a, revision_a = _publish_family_llm(
        family_model_api,
        family_id="family-a",
        suffix="a",
        model="family-a-model",
    )
    profile_b, revision_b = _publish_family_llm(
        family_model_api,
        family_id="family-b",
        suffix="b",
        model="family-b-model",
    )

    with family_model_api.session_factory() as db:
        first = configured_usage_variants(
            db,
            family_id="family-a",
            config_revision_id=revision_a,
        )
        second = configured_usage_variants(
            db,
            family_id="family-b",
            config_revision_id=revision_b,
        )

    assert {(item.provider, item.billing_model) for item in first} == {
        (profile_a, "family-a-model")
    }
    assert {(item.provider, item.billing_model) for item in second} == {
        (profile_b, "family-b-model")
    }
    assert first[0].variant_key == "primary"


def test_configured_variants_does_not_accept_settings() -> None:
    assert list(inspect.signature(configured_usage_variants).parameters) == [
        "db",
        "family_id",
        "config_revision_id",
    ]
