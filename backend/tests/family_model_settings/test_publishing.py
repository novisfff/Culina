from __future__ import annotations

from copy import deepcopy
from dataclasses import replace

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.enums import (
    FamilyModelResourceOperationStatus,
    FamilyModelResourceOperationType,
    FamilyModelSearchProfileStatus,
)
from app.models.domain import ActivityLog
from app.models.family_model_settings import (
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilyModelOperationReceipt,
    FamilyModelResourceOperation,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.services.family_model_settings.errors import (
    FamilyModelOperationIdempotencyConflict,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.publishing import (
    PublishConfigurationCommand,
    publish_family_model_configuration,
)
from app.services.family_model_settings.validation import (
    ValidateDraftCommand,
    validate_family_model_draft,
)

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


def _llm_payload(profile_id: str, *, max_output_tokens: int = 1024) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-primary-model",
                "max_output_tokens": max_output_tokens,
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
        "change_note": "发布家庭模型配置",
    }


def _embedding_payload(profile_id: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "embedding",
                "variant_key": "search",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-embedding-model",
                "dimensions": 1536,
            }
        ],
        "price_rates": [
            {
                "capability": "embedding",
                "variant_key": "search",
                "meter": "embedding_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        "change_note": "发布家庭搜索模型",
    }


def _save_draft(
    context: FamilyModelApiContext,
    payload: dict[str, object],
    *,
    base_draft_version_number: int = 0,
    idempotency_key: str,
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


def _validate_and_command(
    context: FamilyModelApiContext,
    *,
    draft_version_number: int,
    idempotency_key: str,
) -> PublishConfigurationCommand:
    with context.session_factory() as db:
        validation = validate_family_model_draft(
            db,
            ValidateDraftCommand(
                family_id="family-a",
                actor_user_id="owner-a",
                network_policy=context.policy,
                base_draft_version_number=draft_version_number,
            ),
        )
        assert validation.valid is True
        assert validation.config_checksum is not None
        assert validation.price_checksum is not None
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        command = PublishConfigurationCommand(
            family_id="family-a",
            actor_user_id="owner-a",
            base_settings_version_number=settings.version_number,
            base_draft_version_number=draft_version_number,
            idempotency_key=idempotency_key,
            confirm_config_checksum=validation.config_checksum,
            confirm_price_checksum=validation.price_checksum,
            network_policy=context.policy,
        )
        db.commit()
        return command


def _prepare_publish(
    context: FamilyModelApiContext,
    *,
    payload: dict[str, object],
    draft_key: str,
    publish_key: str,
    base_draft_version_number: int = 0,
) -> PublishConfigurationCommand:
    draft = _save_draft(
        context,
        payload,
        base_draft_version_number=base_draft_version_number,
        idempotency_key=draft_key,
    )
    return _validate_and_command(
        context,
        draft_version_number=int(draft["draft_version_number"]),
        idempotency_key=publish_key,
    )


def _publish(
    context: FamilyModelApiContext,
    command: PublishConfigurationCommand,
):
    with context.session_factory() as db:
        result = publish_family_model_configuration(db, command, cipher=context.cipher)
        db.commit()
        return result


def test_publish_rolls_back_all_rows_if_a_price_rate_insert_fails(
    family_model_api: FamilyModelApiContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-rollback-1")
    command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-rollback-1",
        publish_key="publishing-rollback-1",
    )

    def raise_integrity_error(*args, **kwargs) -> None:
        del args, kwargs
        raise IntegrityError("insert price rate", {}, RuntimeError("injected failure"))

    monkeypatch.setattr(
        "app.services.family_model_settings.publishing.insert_family_price_rates",
        raise_integrity_error,
    )
    with family_model_api.session_factory() as db:
        with pytest.raises(IntegrityError):
            publish_family_model_configuration(db, command, cipher=family_model_api.cipher)
        db.rollback()
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is None
        assert settings.active_price_version_id is None
        assert db.scalar(select(func.count()).select_from(FamilyModelConfigRevision)) == 0
        assert db.scalar(select(func.count()).select_from(ModelUsagePriceVersion)) == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(FamilyModelOperationReceipt)
                .where(
                    FamilyModelOperationReceipt.operation
                    == "publish_family_model_configuration"
                )
            )
            == 0
        )


def test_same_publish_key_replays_the_committed_result_without_second_write(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-replay-1")
    command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-replay-1",
        publish_key="publishing-replay-1",
    )

    first = _publish(family_model_api, command)
    second = _publish(family_model_api, command)

    assert second == first
    with family_model_api.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(FamilyModelConfigRevision)) == 1
        assert db.scalar(select(func.count()).select_from(ModelUsagePriceVersion)) == 1
        assert (
            db.scalar(
                select(func.count())
                .select_from(FamilyModelOperationReceipt)
                .where(
                    FamilyModelOperationReceipt.operation
                    == "publish_family_model_configuration"
                )
            )
            == 1
        )


def test_same_publish_key_with_a_different_confirmation_is_a_stable_conflict(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-key-conflict-1")
    command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-key-conflict-1",
        publish_key="publishing-key-conflict-1",
    )
    _publish(family_model_api, command)
    changed_confirmation = replace(command, confirm_price_checksum="0" * 64)

    with family_model_api.session_factory() as db:
        with pytest.raises(FamilyModelOperationIdempotencyConflict):
            publish_family_model_configuration(
                db,
                changed_confirmation,
                cipher=family_model_api.cipher,
            )


def test_stale_publish_returns_current_settings_version_and_revision(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-stale-1")
    command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-stale-1",
        publish_key="publishing-stale-winner-1",
    )
    result = _publish(family_model_api, command)
    stale = replace(command, idempotency_key="publishing-stale-loser-1")

    with family_model_api.session_factory() as db:
        with pytest.raises(FamilyModelSettingsVersionConflict) as raised:
            publish_family_model_configuration(db, stale, cipher=family_model_api.cipher)
        assert raised.value.current_settings_version_number == result.settings_version_number
        assert raised.value.current_config_revision_id == result.config_revision_id


def test_initial_embedding_publish_persists_a_durable_collection_ensure_operation(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-embedding-1")
    command = _prepare_publish(
        family_model_api,
        payload=_embedding_payload(str(profile["id"])),
        draft_key="publishing-draft-embedding-1",
        publish_key="publishing-embedding-1",
    )

    result = _publish(family_model_api, command)

    assert result.search_profile_id is not None
    with family_model_api.session_factory() as db:
        profile_row = db.get(FamilySearchProfile, result.search_profile_id)
        assert profile_row is not None
        assert profile_row.status is FamilyModelSearchProfileStatus.PROVISIONING
        operation = db.scalar(
            select(FamilyModelResourceOperation).where(
                FamilyModelResourceOperation.operation_type
                == FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION,
                FamilyModelResourceOperation.search_profile_id_snapshot == result.search_profile_id,
            )
        )
        assert operation is not None
        assert operation.status is FamilyModelResourceOperationStatus.PENDING
        assert operation.qdrant_collection_snapshot == profile_row.qdrant_collection


def test_new_config_revision_can_reuse_an_unchanged_price_manifest(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-price-reuse-1")
    first_command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-price-reuse-1",
        publish_key="publishing-price-reuse-first-1",
    )
    first = _publish(family_model_api, first_command)
    draft_response = family_model_api.client.get("/api/family/model-settings/draft")
    assert draft_response.status_code == 200
    next_payload = deepcopy(draft_response.json()["payload"])
    next_payload["bindings"][0]["max_output_tokens"] = 2048
    next_payload["change_note"] = "只变更输出上限"
    second_command = _prepare_publish(
        family_model_api,
        payload=next_payload,
        base_draft_version_number=draft_response.json()["draft_version_number"],
        draft_key="publishing-draft-price-reuse-2",
        publish_key="publishing-price-reuse-second-1",
    )

    second = _publish(family_model_api, second_command)

    assert second.config_revision_id != first.config_revision_id
    assert second.price_version_id != first.price_version_id
    assert second.price_checksum == first.price_checksum
    with family_model_api.session_factory() as db:
        assert db.scalar(select(func.count()).select_from(ModelUsagePriceVersion)) == 2


def test_publish_activity_log_is_exactly_redacted(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="publishing-profile-activity-1")
    command = _prepare_publish(
        family_model_api,
        payload=_llm_payload(str(profile["id"])),
        draft_key="publishing-draft-activity-1",
        publish_key="publishing-activity-1",
    )

    result = _publish(family_model_api, command)

    with family_model_api.session_factory() as db:
        activity = db.scalar(
            select(ActivityLog).where(
                ActivityLog.entity_type == "FamilyModelConfiguration",
                ActivityLog.entity_id == result.config_revision_id,
            )
        )
        assert activity is not None
        assert activity.summary == "更新了家庭 AI 服务配置"
        assert activity.entity_type == "FamilyModelConfiguration"
        assert "provider.example" not in activity.summary
        assert "family-primary-model" not in activity.summary
        assert "sk-family-model-secret-marker" not in activity.summary
