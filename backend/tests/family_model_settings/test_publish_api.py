from __future__ import annotations

import json

from sqlalchemy import func, select

from app.models.family_model_settings import FamilyModelOperationReceipt

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
                "requested_model": "family-api-model",
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
        "change_note": "测试发布接口",
    }


def _prepare_publish(
    context: FamilyModelApiContext,
    *,
    profile_key: str = "publish-api-profile-1",
    draft_key: str = "publish-api-draft-1",
    publish_key: str = "publish-api-request-1",
) -> tuple[dict[str, object], dict[str, object]]:
    profile = context.create_profile(idempotency_key=profile_key)
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_llm_payload(str(profile["id"]))
        | {
            "base_draft_version_number": 0,
            "idempotency_key": draft_key,
        },
    )
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    validation_response = context.client.post(
        "/api/family/model-settings/draft/validate",
        json={"base_draft_version_number": draft["draft_version_number"]},
    )
    assert validation_response.status_code == 200, validation_response.text
    validation = validation_response.json()
    assert validation["valid"] is True
    settings_response = context.client.get("/api/family/model-settings")
    assert settings_response.status_code == 200, settings_response.text
    settings = settings_response.json()
    return (
        {
            "base_settings_version_number": settings["version_number"],
            "base_draft_version_number": draft["draft_version_number"],
            "idempotency_key": publish_key,
            "config_checksum": validation["config_checksum"],
            "price_checksum": validation["price_checksum"],
        },
        validation,
    )


def _publish(context: FamilyModelApiContext, payload: dict[str, object]):
    return context.client.post("/api/family/model-settings/publish", json=payload)


def _publish_receipt_count(context: FamilyModelApiContext) -> int:
    with context.session_factory() as db:
        return int(
            db.scalar(
                select(func.count())
                .select_from(FamilyModelOperationReceipt)
                .where(
                    FamilyModelOperationReceipt.operation
                    == "publish_family_model_configuration"
                )
            )
            or 0
        )


def test_owner_can_validate_and_publish_with_a_redacted_response(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, validation = _prepare_publish(family_model_api)

    assert SECRET_MARKER not in json.dumps(validation)
    published = _publish(
        family_model_api,
        request | {"current_password": "OwnerPass123"},
    )

    assert published.status_code == 200, published.text
    body = published.json()
    assert {
        "config_revision_id",
        "price_version_id",
        "settings_version_number",
        "config_checksum",
        "price_checksum",
    } <= set(body)
    serialized = json.dumps(body)
    assert SECRET_MARKER not in serialized
    assert "OwnerPass123" not in serialized
    assert "current_password" not in serialized


def test_member_cannot_validate_or_publish_family_model_settings(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, _ = _prepare_publish(family_model_api)
    family_model_api.use_member()

    validate = family_model_api.client.post(
        "/api/family/model-settings/draft/validate",
        json={"base_draft_version_number": request["base_draft_version_number"]},
    )
    publish = _publish(family_model_api, request)

    assert validate.status_code == 403
    assert publish.status_code == 403


def test_initial_publish_requires_the_current_owner_password_before_claiming(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, _ = _prepare_publish(family_model_api)

    missing = _publish(family_model_api, request)
    wrong = _publish(
        family_model_api,
        request | {"current_password": "definitely-not-the-owner-password"},
    )

    assert missing.status_code == 422
    assert missing.json()["detail"]["code"] == "family_model_owner_reauthentication_failed"
    assert wrong.status_code == 422
    assert wrong.json()["detail"]["code"] == "family_model_owner_reauthentication_failed"
    assert _publish_receipt_count(family_model_api) == 0

    succeeded = _publish(
        family_model_api,
        request | {"current_password": "OwnerPass123"},
    )
    assert succeeded.status_code == 200, succeeded.text


def test_publish_checksum_conflicts_replay_and_stale_responses_are_structured(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, _ = _prepare_publish(family_model_api)

    checksum_mismatch = _publish(
        family_model_api,
        request
        | {
            "idempotency_key": "publish-api-checksum-mismatch-1",
            "config_checksum": "0" * 64,
            "current_password": "OwnerPass123",
        },
    )
    assert checksum_mismatch.status_code == 422
    assert checksum_mismatch.json()["detail"]["code"] == "family_model_publish_checksum_mismatch"
    assert _publish_receipt_count(family_model_api) == 0

    first = _publish(
        family_model_api,
        request | {"current_password": "OwnerPass123"},
    )
    assert first.status_code == 200, first.text
    first_body = first.json()

    # This is the request a client sends after a successful commit whose HTTP
    # response was lost.  The active pointer has advanced, so it deliberately
    # omits the one-time first-publication password.
    replay = _publish(family_model_api, request)
    assert replay.status_code == 200, replay.text
    assert replay.json() == first_body

    same_key_different_confirmation = _publish(
        family_model_api,
        request | {"config_checksum": "f" * 64},
    )
    assert same_key_different_confirmation.status_code == 409
    assert (
        same_key_different_confirmation.json()["detail"]["code"]
        == "family_model_operation_idempotency_conflict"
    )

    stale = _publish(
        family_model_api,
        request | {"idempotency_key": "publish-api-stale-1"},
    )
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "family_model_settings_version_conflict"
    assert detail["current_settings_version_number"] == first_body["settings_version_number"]
    assert detail["current_config_revision_id"] == first_body["config_revision_id"]
