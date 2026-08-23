from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageOperationSource,
)
from app.models.family_model_settings import FamilyModelCapabilityBinding
from app.repos.family_model_settings.profiles import get_family_model_settings
from app.services.family_model_settings.prices import (
    PublishFamilyPriceVersionCommand,
    publish_family_price_version,
    validate_complete_family_price_rates,
)
from app.services.family_model_settings.validation import price_checksum
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.subjects import ensure_user_subject
from app.services.model_usage.types import (
    ProviderRecoveryPolicy,
    UsageAttribution,
    UsageContext,
)

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


NOW = datetime(2026, 8, 18, 10, 0, tzinfo=timezone.utc)


def _publish_initial(context: FamilyModelApiContext) -> dict[str, object]:
    profile = context.create_profile(idempotency_key="linearization-profile-1")
    draft = context.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "family-linearization-model",
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
            "change_note": "初始化线性化测试",
            "base_draft_version_number": 0,
            "idempotency_key": "linearization-draft-1",
        },
    )
    assert draft.status_code == 200, draft.text
    settings = context.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    active = settings.json()
    assert active["active_config_revision_id"] is not None
    assert active["active_price_version_id"] is not None
    return {
        "config_revision_id": active["active_config_revision_id"],
        "price_version_id": active["active_price_version_id"],
        "settings_version_number": active["version_number"],
    }


def _price_input_rates(context: FamilyModelApiContext) -> list[dict[str, object]]:
    response = context.client.get("/api/family/model-settings/prices")
    assert response.status_code == 200, response.text
    fields = (
        "capability",
        "variant_key",
        "meter",
        "unit_quantity",
        "unit_price",
        "source_currency",
        "fx_to_cny",
        "reported_model_aliases",
    )
    return [
        {field: rate[field] for field in fields if field in rate}
        for rate in response.json()["current_rates"]
    ]


def _family_context(context: FamilyModelApiContext) -> UsageContext:
    with context.session_factory() as db:
        settings = get_family_model_settings(db, family_id="family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        binding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.family_id == "family-a",
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == ModelUsageCapability.LLM,
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert binding is not None
        subject = ensure_user_subject(db, family_id="family-a", user_id="owner-a")
        ensure_family_model_usage_defaults(
            db,
            family_id="family-a",
            creator_subject_id=subject.id,
        )
        db.commit()
        assert binding.provider_profile_id is not None
        assert binding.provider_profile_version_id is not None
        return UsageContext(
            attribution=UsageAttribution(
                family_id="family-a",
                attribution_kind=ModelUsageAttributionKind.USER,
                actor_user_id="owner-a",
                operation_source=ModelUsageOperationSource.INTERACTIVE,
                logical_operation_id="family-price-linearization",
            ),
            capability=ModelUsageCapability.LLM,
            provider=binding.provider_profile_id,
            requested_model=binding.requested_model,
            billing_model=binding.requested_model,
            variant_key=binding.variant_key,
            operation_kind="family-price-test",
            attempt_key="family-price-attempt-a",
            client_attempt_id="mua_family_price_a",
            config_revision_id=settings.active_config_revision_id,
            provider_profile_id=binding.provider_profile_id,
            provider_profile_version_id=binding.provider_profile_version_id,
        )


def test_price_selection_is_fixed_at_reservation_and_dispatch_pins_identity(
    family_model_api: FamilyModelApiContext,
) -> None:
    initial = _publish_initial(family_model_api)
    context = _family_context(family_model_api)
    estimate = estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10)

    with family_model_api.session_factory() as db:
        first = reserve_usage_in_session(
            db,
            context,
            estimate,
            fingerprint="family-price-fingerprint-a",
            at=NOW,
        )
        assert first.price_version_id == initial["price_version_id"]
        db.commit()

    rates = _price_input_rates(family_model_api)
    rates[0]["unit_price"] = "2.0"
    with family_model_api.session_factory() as db:
        settings = get_family_model_settings(db, family_id="family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        checksum = price_checksum(
            validate_complete_family_price_rates(
                db,
                family_id="family-a",
                config_revision_id=settings.active_config_revision_id,
                rates=rates,
            )
        )
        published = publish_family_price_version(
            db,
            PublishFamilyPriceVersionCommand(
                family_id="family-a",
                actor_user_id="owner-a",
                base_settings_version_number=settings.version_number,
                base_price_version_id=settings.active_price_version_id or "",
                idempotency_key="family-price-linearization-publish-1",
                confirm_checksum=checksum,
                change_note="调价后仅影响新预留",
                rates=rates,
            ),
            cipher=family_model_api.cipher,
        )
        db.commit()

    with family_model_api.session_factory() as db:
        replay = reserve_usage_in_session(
            db,
            context,
            estimate,
            fingerprint="family-price-fingerprint-a",
            at=NOW,
        )
        second_context = replace(
            context,
            attempt_key="family-price-attempt-b",
            client_attempt_id="mua_family_price_b",
        )
        second = reserve_usage_in_session(
            db,
            second_context,
            estimate,
            fingerprint="family-price-fingerprint-b",
            at=NOW,
        )
        permit = prepare_usage_dispatch_in_session(
            db,
            reservation_id=second.reservation_id or "",
            fingerprint="family-price-fingerprint-b",
            recovery_policy=ProviderRecoveryPolicy.none(),
            at=NOW,
        ).permit
        db.commit()

    assert replay.price_version_id == first.price_version_id
    assert second.price_version_id == published.price_version_id
    assert permit is not None
    assert permit.config_revision_id == context.config_revision_id
    assert permit.provider_profile_id == context.provider_profile_id
    assert permit.provider_profile_version_id == context.provider_profile_version_id
    assert permit.credential_secret_version_id is not None
