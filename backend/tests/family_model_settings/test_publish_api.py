from __future__ import annotations

import json

from sqlalchemy import func, select

from app.models.family_model_settings import FamilyModelOperationReceipt, FamilyModelSettings

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


def test_owner_save_automatically_applies_a_redacted_configuration(
    family_model_api: FamilyModelApiContext,
) -> None:
    _, validation = _prepare_publish(family_model_api)

    assert SECRET_MARKER not in json.dumps(validation)
    settings = family_model_api.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    body = settings.json()
    assert body["active_config_revision_id"] is not None
    assert body["active_price_version_id"] is not None
    serialized = json.dumps(body)
    assert SECRET_MARKER not in serialized
    assert "current_password" not in serialized
    assert _publish_receipt_count(family_model_api) == 0


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


def test_complete_save_does_not_require_an_owner_password_or_publish_receipt(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, validation = _prepare_publish(family_model_api)

    assert validation["valid"] is True
    assert request["base_settings_version_number"] > 1
    assert _publish_receipt_count(family_model_api) == 0


def test_legacy_publish_route_reports_that_the_saved_configuration_is_already_active(
    family_model_api: FamilyModelApiContext,
) -> None:
    request, _ = _prepare_publish(family_model_api)

    response = _publish(family_model_api, request)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "family_model_configuration_already_published"
    assert _publish_receipt_count(family_model_api) == 0


def test_legacy_publish_route_cannot_activate_an_initial_configuration(
    family_model_api: FamilyModelApiContext,
) -> None:
    """The retired unified endpoint must never become an activation backdoor."""

    response = _publish(
        family_model_api,
        {
            "base_settings_version_number": 1,
            "base_draft_version_number": 1,
            "idempotency_key": "legacy-initial-publish-1",
            "config_checksum": "0" * 64,
            "price_checksum": "0" * 64,
            "current_password": "OwnerPass123",
        },
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "family_model_configuration_already_published"
    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is None
        assert settings.active_price_version_id is None
    assert _publish_receipt_count(family_model_api) == 0
