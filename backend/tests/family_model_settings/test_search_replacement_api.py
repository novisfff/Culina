from __future__ import annotations

import json
from typing import Any

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile

from tests.family_model_settings._support import FamilyModelApiContext, SECRET_MARKER, family_model_api
from tests.family_model_settings.test_search_replacements import _activate_initial, _publish


def _replacement_input(
    *,
    base_settings_version_number: int,
    base_search_profile_id: str,
    provider_profile_id: str,
) -> dict[str, object]:
    return {
        "base_settings_version_number": base_settings_version_number,
        "base_search_profile_id": base_search_profile_id,
        "provider_profile_id": provider_profile_id,
        "requested_model": "family-api-embedding-b",
        "dimensions": 3,
        "rates": [
            {
                "capability": "embedding",
                "variant_key": "search",
                "meter": "embedding_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.03",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
    }


def _prepare_active_search(
    context: FamilyModelApiContext,
    *,
    suffix: str,
) -> tuple[str, str]:
    source = context.create_profile(idempotency_key=f"search-api-source-{suffix}")
    published = _publish(
        context,
        profile_id=str(source["id"]),
        id_suffix=f"search-api-initial-{suffix}",
    )
    base_profile_id = str(published["search_profile_id"])
    _activate_initial(context, base_profile_id)
    target = context.create_profile(
        display_name=f"家庭搜索 API {suffix}",
        idempotency_key=f"search-api-target-{suffix}",
    )
    return base_profile_id, str(target["id"])


def _safe_progress_fields() -> set[str]:
    return {
        "profile_id",
        "status",
        "total_documents",
        "indexed_documents",
        "failed_documents",
        "budget_blocked_documents",
        "retryable",
        "created_at",
        "activated_at",
    }


def _assert_safe_progress_shape(payload: dict[str, Any]) -> None:
    # ``activated_at`` is intentionally omitted from a provisioning response
    # by ``response_model_exclude_none`` and appears only after activation.
    assert set(payload) <= _safe_progress_fields()
    assert set(payload) >= _safe_progress_fields() - {"activated_at"}


def test_search_replacement_api_preview_create_replay_and_safe_progress(
    family_model_api: FamilyModelApiContext,
) -> None:
    base_profile_id, target_profile_id = _prepare_active_search(
        family_model_api,
        suffix="create",
    )
    settings = family_model_api.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    request = _replacement_input(
        base_settings_version_number=settings.json()["version_number"],
        base_search_profile_id=base_profile_id,
        provider_profile_id=target_profile_id,
    )

    preview = family_model_api.client.post(
        "/api/family/model-settings/search/replacements/preview",
        json=request,
    )
    assert preview.status_code == 200, preview.text
    assert set(preview.json()) == {
        "document_count",
        "minimum_estimated_tokens",
        "conservative_estimated_tokens",
        "minimum_estimated_cost_cny",
        "conservative_estimated_cost_cny",
        "confirmation_checksum",
    }
    assert preview.json()["confirmation_checksum"]

    created = family_model_api.client.post(
        "/api/family/model-settings/search/replacements",
        json=request
        | {
            "confirm_checksum": preview.json()["confirmation_checksum"],
            "current_password": "OwnerPass123",
            "idempotency_key": "search-api-create-replay-1",
        },
    )
    assert created.status_code == 200, created.text
    progress = created.json()
    _assert_safe_progress_shape(progress)
    assert progress["status"] == "provisioning"
    assert progress["total_documents"] == 0
    assert progress["retryable"] is False

    # Replaying begins with the idempotency receipt, before the now-stale base
    # settings version is checked. The only exposed record remains safe progress.
    replay = family_model_api.client.post(
        "/api/family/model-settings/search/replacements",
        json=request
        | {
            "confirm_checksum": preview.json()["confirmation_checksum"],
            "current_password": "OwnerPass123",
            "idempotency_key": "search-api-create-replay-1",
        },
    )
    assert replay.status_code == 200, replay.text
    assert replay.json() == progress

    status = family_model_api.client.get(
        f"/api/family/model-settings/search/replacements/{progress['profile_id']}"
    )
    assert status.status_code == 200, status.text
    assert status.json() == progress

    serialized = json.dumps(progress, ensure_ascii=False)
    for forbidden in (
        "qdrant",
        "collection",
        "provider_profile",
        "base_url",
        "credential",
        SECRET_MARKER,
    ):
        assert forbidden not in serialized


def test_search_replacement_api_owner_scope_retry_and_cancel(
    family_model_api: FamilyModelApiContext,
) -> None:
    base_profile_id, target_profile_id = _prepare_active_search(
        family_model_api,
        suffix="mutation",
    )
    settings = family_model_api.client.get("/api/family/model-settings")
    assert settings.status_code == 200, settings.text
    request = _replacement_input(
        base_settings_version_number=settings.json()["version_number"],
        base_search_profile_id=base_profile_id,
        provider_profile_id=target_profile_id,
    )
    preview = family_model_api.client.post(
        "/api/family/model-settings/search/replacements/preview",
        json=request,
    )
    assert preview.status_code == 200, preview.text
    created = family_model_api.client.post(
        "/api/family/model-settings/search/replacements",
        json=request
        | {
            "confirm_checksum": preview.json()["confirmation_checksum"],
            "current_password": "OwnerPass123",
            "idempotency_key": "search-api-create-mutation-1",
        },
    )
    assert created.status_code == 200, created.text
    profile_id = str(created.json()["profile_id"])

    with family_model_api.session_factory() as db:
        candidate = db.get(FamilySearchProfile, profile_id)
        assert candidate is not None
        candidate.status = FamilyModelSearchProfileStatus.FAILED
        db.commit()

    family_model_api.use_member()
    member = family_model_api.client.get(
        f"/api/family/model-settings/search/replacements/{profile_id}"
    )
    assert member.status_code == 403

    family_model_api.use_owner("family-b")
    other_family = family_model_api.client.get(
        f"/api/family/model-settings/search/replacements/{profile_id}"
    )
    assert other_family.status_code == 404
    assert other_family.json()["detail"]["code"] == "family_search_profile_not_found"

    family_model_api.use_owner("family-a")
    current_settings = family_model_api.client.get("/api/family/model-settings")
    assert current_settings.status_code == 200, current_settings.text
    retried = family_model_api.client.post(
        f"/api/family/model-settings/search/replacements/{profile_id}/retry",
        json={
            "base_settings_version_number": current_settings.json()["version_number"],
            "idempotency_key": "search-api-retry-mutation-1",
        },
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["status"] == "provisioning"
    _assert_safe_progress_shape(retried.json())

    current_settings = family_model_api.client.get("/api/family/model-settings")
    assert current_settings.status_code == 200, current_settings.text
    cancelled = family_model_api.client.post(
        f"/api/family/model-settings/search/replacements/{profile_id}/cancel",
        json={
            "base_settings_version_number": current_settings.json()["version_number"],
            "idempotency_key": "search-api-cancel-mutation-1",
        },
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"

    with family_model_api.session_factory() as db:
        family_settings = db.get(FamilyModelSettings, "family-a")
        assert family_settings is not None
        assert family_settings.active_search_profile_id == base_profile_id
