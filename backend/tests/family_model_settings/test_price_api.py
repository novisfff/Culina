from __future__ import annotations

import json

from app.repos.family_model_settings.profiles import get_family_model_settings
from app.services.family_model_settings.prices import validate_complete_family_price_rates
from app.services.family_model_settings.validation import price_checksum

from tests.family_model_settings._support import SECRET_MARKER, FamilyModelApiContext, family_model_api


def _llm_payload(profile_id: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-price-api-model",
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
        "change_note": "初始化家庭价格",
    }


def _publish_initial_configuration(context: FamilyModelApiContext) -> dict[str, object]:
    profile = context.create_profile(idempotency_key="price-api-profile-1")
    saved = context.client.put(
        "/api/family/model-settings/draft",
        json=_llm_payload(str(profile["id"]))
        | {
            "base_draft_version_number": 0,
            "idempotency_key": "price-api-draft-1",
        },
    )
    assert saved.status_code == 200, saved.text
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


def _price_input_rates(prices: dict[str, object]) -> list[dict[str, object]]:
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
        {field: row[field] for field in fields if field in row}
        for row in prices["current_rates"]  # type: ignore[index]
    ]


def _checksum(context: FamilyModelApiContext, rates: list[dict[str, object]]) -> str:
    with context.session_factory() as db:
        settings = get_family_model_settings(db, family_id="family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        validated = validate_complete_family_price_rates(
            db,
            family_id="family-a",
            config_revision_id=settings.active_config_revision_id,
            rates=rates,
        )
        return price_checksum(validated)


def test_price_draft_and_publish_are_owner_scoped_and_replay_safe(
    family_model_api: FamilyModelApiContext,
) -> None:
    initial = _publish_initial_configuration(family_model_api)
    prices_response = family_model_api.client.get("/api/family/model-settings/prices")
    assert prices_response.status_code == 200, prices_response.text
    prices = prices_response.json()
    rates = _price_input_rates(prices)
    rates[0]["unit_price"] = "0"
    config_draft = family_model_api.client.get("/api/family/model-settings/draft")
    assert config_draft.status_code == 200, config_draft.text

    saved = family_model_api.client.put(
        "/api/family/model-settings/prices/draft",
        json={
            "base_draft_version_number": config_draft.json()["draft_version_number"],
            "base_price_version_id": initial["price_version_id"],
            "idempotency_key": "price-api-save-draft-1",
            "rates": rates,
            "change_note": "本地模型输入免费",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["rates"][0]["unit_price"] == "0"

    refreshed = family_model_api.client.get("/api/family/model-settings/prices")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["draft"]["base_price_version_id"] == initial["price_version_id"]
    assert SECRET_MARKER not in json.dumps(refreshed.json())

    settings = family_model_api.client.get("/api/family/model-settings").json()
    request = {
        "base_settings_version_number": settings["version_number"],
        "base_price_version_id": initial["price_version_id"],
        "idempotency_key": "price-api-publish-1",
        "confirm_checksum": _checksum(family_model_api, rates),
        "change_note": "本地模型输入免费",
        "rates": rates,
    }
    first = family_model_api.client.post(
        "/api/family/model-settings/prices/publish", json=request
    )
    assert first.status_code == 200, first.text
    first_body = first.json()
    assert first_body["price_version_id"] != initial["price_version_id"]
    assert first_body["config_revision_id"] == initial["config_revision_id"]

    replay = family_model_api.client.post(
        "/api/family/model-settings/prices/publish", json=request
    )
    assert replay.status_code == 200, replay.text
    assert replay.json() == first_body

    conflict = family_model_api.client.post(
        "/api/family/model-settings/prices/publish",
        json=request | {"change_note": "同键不同确认"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "family_model_operation_idempotency_conflict"

    stale = family_model_api.client.post(
        "/api/family/model-settings/prices/publish",
        json=request | {"idempotency_key": "price-api-stale-1"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_price_version_id"] == first_body["price_version_id"]


def test_member_cannot_read_or_write_family_prices(
    family_model_api: FamilyModelApiContext,
) -> None:
    _publish_initial_configuration(family_model_api)
    family_model_api.use_member()

    read = family_model_api.client.get("/api/family/model-settings/prices")
    draft = family_model_api.client.put(
        "/api/family/model-settings/prices/draft",
        json={
            "base_draft_version_number": 0,
            "idempotency_key": "price-api-member-draft-1",
            "rates": [],
            "change_note": "无权限",
        },
    )
    publish = family_model_api.client.post(
        "/api/family/model-settings/prices/publish",
        json={
            "base_settings_version_number": 1,
            "base_price_version_id": "price",
            "idempotency_key": "price-api-member-publish-1",
            "confirm_checksum": "0" * 64,
            "change_note": "无权限",
            "rates": [],
        },
    )

    assert read.status_code == 403
    assert draft.status_code == 403
    assert publish.status_code == 403
