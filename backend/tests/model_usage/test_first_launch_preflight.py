from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageOperationSource,
    ModelUsageReservationStatus,
)
from app.models.domain import Family
from app.models.model_usage import ModelUsageReservation
from app.services.model_usage import preflight
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.pricing import PublishPriceCommand, publish_price_manifest
from app.services.model_usage.pricing_manifest import validate_price_manifest
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.subjects import ensure_system_subject
from app.services.model_usage.types import UsageAttribution, UsageContext


AT = datetime(2026, 7, 30, 1, tzinfo=timezone.utc)


def _seven_capability_settings() -> Settings:
    return Settings(
        model_usage_required=True,
        model_usage_maintenance_enabled=True,
        model_usage_receipt_integrity_active_key_id="active",
        model_usage_receipt_integrity_keys_json=SecretStr(
            json.dumps({"active": {"key": "first-launch-test-key", "retireAfter": None}})
        ),
        ai_provider="openai",
        ai_model="gpt-first-launch-test",
        search_hybrid_enabled=False,
        search_embedding_provider="openai",
        search_embedding_model="embedding-first-launch-test",
        search_embedding_dimensions=1536,
        search_rerank_provider="openai",
        search_rerank_model="rerank-first-launch-test",
        search_rerank_candidate_limit=20,
        ai_stt_provider="openai",
        ai_stt_model="stt-first-launch-test",
        ai_stt_audio_format="webm",
        ai_tts_provider="openai",
        ai_tts_model="tts-first-launch-test",
        ai_tts_voice="alloy",
        ai_realtime_provider="dashscope",
        ai_realtime_model="realtime-first-launch-test",
        ai_realtime_voice="Cherry",
        ai_image_reference_provider="disabled",
        ai_image_reference_model="",
        ai_image_text_provider="openai",
        ai_image_text_model="image-first-launch-test",
    )


def _price_manifest(settings: Settings) -> dict[str, object]:
    variants = configured_usage_variants(settings)
    rates: list[dict[str, str]] = []
    for variant in variants:
        for meter in sorted(variant.billable_meters, key=lambda item: item.value):
            rates.append(
                {
                    "provider": variant.provider,
                    "billingModel": variant.billing_model,
                    "capability": variant.capability.value,
                    "variant": variant.variant_key,
                    "billingSchemeKey": variant.billing_scheme_key,
                    "meter": meter.value,
                    "meterRole": "billable",
                    "unitQuantity": "1",
                    "unitPrice": "1.000000000000",
                    "sourceCurrency": "CNY",
                }
            )
    return {
        "catalogVersion": "first-launch-test-v1",
        "effectiveFrom": "2026-07-01T00:00:00+08:00",
        "reviewedAt": "2026-07-01T00:00:00+08:00",
        "sourceRef": "tests:first-launch-preflight",
        "changeNote": "test-only first launch catalog",
        "fxRates": {"CNY": "1.000000000000"},
        "modelAliases": {},
        "rates": rates,
    }


def _seed_first_launch_database(db: Session, settings: Settings) -> None:
    family = Family(
        id="family-first-launch",
        name="首发预检家庭",
        motto="",
        location="",
    )
    db.add(family)
    db.flush()
    creator_subject = ensure_system_subject(db, family_id=family.id)
    ensure_family_model_usage_defaults(
        db,
        family_id=family.id,
        creator_subject_id=creator_subject.id,
    )

    variants = configured_usage_variants(settings)
    manifest = _price_manifest(settings)
    validated = validate_price_manifest(manifest, configured_variants=variants)
    publish_price_manifest(
        db,
        PublishPriceCommand(
            manifest=manifest,
            configured_variants=variants,
            operator="first-launch-test-operator",
            change_ticket="CULINA-TEST-LAUNCH",
            confirm_checksum=validated.checksum,
        ),
    )
    db.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL)"))
    db.execute(text("INSERT INTO alembic_version (version_num) VALUES ('test-head')"))
    db.flush()


def test_first_launch_preflight_is_all_or_nothing(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _seven_capability_settings()
    _seed_first_launch_database(model_usage_db, settings)
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"test-head"}),
        raising=False,
    )

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.required_capabilities == frozenset(ModelUsageCapability)
    assert report.missing_capabilities == frozenset()
    assert report.unregistered_send_points == frozenset()
    assert report.stale_registry_send_points == frozenset()
    assert report.missing_idempotency_uniques == frozenset()
    assert report.missing_guardrail_meter_coverage == frozenset()
    assert report.unsupported_lease_boundary_cumulative_meters == frozenset()
    assert report.receipt_integrity_keyring_valid is True
    assert report.price_coverage_healthy is True, report.as_dict()
    assert report.maintenance_enabled is True
    assert report.fail_open_proof_ttl_valid is True
    assert report.sdk_retry_configuration_gaps == frozenset()
    assert report.active_provider_attempts == 0
    assert report.database_at_head is True
    assert report.ready is True
    assert report.blockers == ()


@pytest.mark.parametrize(
    "status",
    (
        ModelUsageReservationStatus.RESERVED,
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.UNCERTAIN,
    ),
)
def test_first_launch_preflight_blocks_active_provider_attempts(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    status: ModelUsageReservationStatus,
) -> None:
    settings = _seven_capability_settings()
    _seed_first_launch_database(model_usage_db, settings)
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"test-head"}),
        raising=False,
    )
    decision = reserve_usage_in_session(
        model_usage_db,
        UsageContext(
            attribution=UsageAttribution(
                family_id="family-first-launch",
                attribution_kind=ModelUsageAttributionKind.SYSTEM,
                actor_user_id=None,
                operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
                logical_operation_id="first-launch-active-attempt",
            ),
            capability=ModelUsageCapability.LLM,
            provider="openai",
            requested_model="gpt-first-launch-test",
            billing_model="gpt-first-launch-test",
            variant_key="default",
            operation_kind="first_launch_preflight_test",
            attempt_key=f"first-launch-{status.value}",
            client_attempt_id=f"mua_first_launch_{status.value}",
        ),
        estimate_llm(input_tokens=1, cached_input_tokens=0, max_output_tokens=1),
        fingerprint=f"first-launch-{status.value}",
        at=AT,
    )
    assert decision.reservation_id is not None
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    reservation.status = status
    model_usage_db.flush()

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.active_provider_attempts == 1
    assert report.ready is False
    assert "model_usage_active_provider_attempts_present" in report.blockers


def test_first_launch_preflight_blocks_openai_realtime_without_source_ownership(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _seven_capability_settings().model_copy(
        update={"ai_realtime_provider": "openai"}
    )
    _seed_first_launch_database(model_usage_db, settings)
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"test-head"}),
        raising=False,
    )

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.ready is False
    assert "model_usage_provider_source_send_unregistered" in report.registry_errors
    assert "model_usage_provider_source_send_unregistered" in report.blockers


def test_schema_preflight_reports_actual_missing_idempotency_unique(
    model_usage_db: Session,
) -> None:
    model_usage_db.execute(text("DROP TABLE model_usage_reservations"))
    model_usage_db.execute(
        text(
            "CREATE TABLE model_usage_reservations ("
            "id VARCHAR(64) PRIMARY KEY, "
            "family_id VARCHAR(64) NOT NULL, "
            "attempt_key VARCHAR(255) NOT NULL"
            ")"
        )
    )
    model_usage_db.flush()

    missing_tables, missing_uniques = preflight.schema_preflight_gaps(model_usage_db)

    assert missing_tables == frozenset()
    assert "model_usage_reservations:attempt_key,family_id" in missing_uniques


@pytest.mark.parametrize(
    ("settings_update", "expected_blocker"),
    (
        ({"model_usage_maintenance_enabled": False}, "model_usage_maintenance_disabled"),
        ({"model_usage_fail_open_proof_ttl_seconds": 10}, "model_usage_fail_open_proof_ttl_invalid"),
        (
            {
                "model_usage_receipt_integrity_active_key_id": "",
                "model_usage_receipt_integrity_keys_json": SecretStr(""),
            },
            "receipt_integrity_keyring_required",
        ),
    ),
)
def test_first_launch_preflight_reports_invalid_release_configuration(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    settings_update: dict[str, object],
    expected_blocker: str,
) -> None:
    baseline_settings = _seven_capability_settings()
    _seed_first_launch_database(model_usage_db, baseline_settings)
    settings = baseline_settings.model_copy(update=settings_update)
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"test-head"}),
        raising=False,
    )

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.ready is False
    assert expected_blocker in report.blockers


def test_first_launch_preflight_blocks_missing_price_coverage(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _seven_capability_settings()
    _seed_first_launch_database(model_usage_db, settings)
    model_usage_db.execute(text("DELETE FROM model_usage_price_rates"))
    model_usage_db.execute(text("DELETE FROM model_usage_price_versions"))
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"test-head"}),
        raising=False,
    )

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.price_coverage_healthy is False
    assert report.ready is False
    assert "model_usage_price_coverage_missing" in report.blockers


def test_first_launch_preflight_blocks_database_not_at_current_head(
    model_usage_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _seven_capability_settings()
    _seed_first_launch_database(model_usage_db, settings)
    monkeypatch.setattr(
        preflight,
        "source_migration_heads",
        lambda: frozenset({"different-source-head"}),
        raising=False,
    )

    report = preflight.run_first_launch_preflight(settings, db=model_usage_db, at=AT)

    assert report.database_at_head is False
    assert report.ready is False
    assert "database_not_at_current_alembic_head" in report.blockers
