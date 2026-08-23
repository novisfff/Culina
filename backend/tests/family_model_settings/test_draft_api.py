from __future__ import annotations

from sqlalchemy import select

from app.models.family_model_settings import FamilyModelConfigDraft

from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)


def _draft_payload(profile_id: str | None = None) -> dict[str, object]:
    binding: dict[str, object] = {
        "capability": "llm",
        "variant_key": "primary",
        "enabled": False,
        "max_output_tokens": 2048,
    }
    if profile_id is not None:
        binding["provider_profile_id"] = profile_id
    return {"bindings": [binding], "change_note": "保存草稿"}


def _embedding_draft_payload(profile_id: str) -> dict[str, object]:
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
                "unit_quantity": "1000000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        "change_note": "配置家庭搜索向量",
    }


def test_draft_initial_save_and_same_request_replay(
    family_model_api: FamilyModelApiContext,
) -> None:
    request = _draft_payload() | {
        "base_draft_version_number": 0,
        "idempotency_key": "draft-save-1",
    }
    first = family_model_api.client.put("/api/family/model-settings/draft", json=request)
    replay = family_model_api.client.put("/api/family/model-settings/draft", json=request)

    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    assert first.json() == replay.json()
    assert first.json()["draft_version_number"] == 1
    with family_model_api.session_factory() as db:
        draft = db.get(FamilyModelConfigDraft, "family-a")
        assert draft is not None
        assert draft.draft_version_number == 1


def test_stale_draft_save_returns_current_version(
    family_model_api: FamilyModelApiContext,
) -> None:
    first = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=_draft_payload()
        | {"base_draft_version_number": 0, "idempotency_key": "draft-first-1"},
    )
    stale = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=_draft_payload()
        | {"base_draft_version_number": 0, "idempotency_key": "draft-stale-1"},
    )

    assert first.status_code == 200
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "family_model_settings_version_conflict"
    assert stale.json()["detail"]["current_draft_version_number"] == 1


def test_draft_is_family_scoped_and_does_not_persist_write_only_values(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="draft-profile-a-1")
    family_model_api.use_owner("family-b")
    cross_family = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=_draft_payload(profile["id"])
        | {"base_draft_version_number": 0, "idempotency_key": "draft-cross-family-1"},
    )
    assert cross_family.status_code == 404
    assert cross_family.json()["detail"]["code"] == "family_model_provider_not_found"

    family_model_api.use_owner("family-a")
    unsafe = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=_draft_payload()
        | {
            "base_draft_version_number": 0,
            "idempotency_key": "draft-secret-smuggling-1",
            "api_key": SECRET_MARKER,
        },
    )
    assert unsafe.status_code == 422
    response = family_model_api.client.get("/api/family/model-settings/draft")
    assert response.status_code == 200
    assert SECRET_MARKER not in response.text
    with family_model_api.session_factory() as db:
        assert db.scalar(select(FamilyModelConfigDraft)) is None


def test_same_key_with_different_draft_payload_is_a_conflict(
    family_model_api: FamilyModelApiContext,
) -> None:
    first = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=_draft_payload()
        | {"base_draft_version_number": 0, "idempotency_key": "draft-key-reuse-1"},
    )
    second = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": False,
                    "max_output_tokens": 1024,
                }
            ],
            "base_draft_version_number": 1,
            "idempotency_key": "draft-key-reuse-1",
        },
    )
    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "family_model_operation_idempotency_conflict"


def test_initial_embedding_requires_explicit_confirmation_and_returns_profile_identity(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(idempotency_key="draft-initial-search-profile-1")
    payload = _embedding_draft_payload(str(profile["id"]))

    unconfirmed = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=payload
        | {
            "base_draft_version_number": 0,
            "idempotency_key": "draft-initial-search-unconfirmed-1",
        },
    )

    assert unconfirmed.status_code == 422
    assert unconfirmed.json()["detail"]["code"] == "family_search_initial_confirmation_required"

    confirmed = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=payload
        | {
            "base_draft_version_number": 0,
            "idempotency_key": "draft-initial-search-confirmed-1",
            "confirm_initial_search_index": True,
        },
    )

    assert confirmed.status_code == 200, confirmed.text
    profile_id = confirmed.json()["payload"]["search_profile_id"]
    assert isinstance(profile_id, str) and profile_id

    loaded = family_model_api.client.get("/api/family/model-settings/draft")
    assert loaded.status_code == 200
    assert loaded.json()["payload"]["search_profile_id"] == profile_id

    changed_payload = _embedding_draft_payload(str(profile["id"]))
    changed_payload["bindings"][0]["requested_model"] = "different-embedding-model"
    changed = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=changed_payload
        | {
            "search_profile_id": profile_id,
            "base_config_revision_id": confirmed.json()["base_config_revision_id"],
            "base_draft_version_number": confirmed.json()["draft_version_number"],
            "idempotency_key": "draft-initial-search-illegal-change-1",
            "confirm_initial_search_index": True,
        },
    )

    assert changed.status_code == 422
    assert changed.json()["detail"]["code"] == "family_search_profile_locked"
