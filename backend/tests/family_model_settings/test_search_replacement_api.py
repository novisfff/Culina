from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

from sqlalchemy import select

from app.core.enums import FamilyModelSearchProfileStatus, ModelUsageCapability
from app.models.domain import SearchDocument, SearchIndexJob
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.services.search.embeddings import EmbeddingUnavailableError
from app.services.search.jobs import (
    MAX_ATTEMPTS,
    _mark_profile_job_failure,
    claim_pending_search_index_jobs,
)

from tests.family_model_settings._support import FamilyModelApiContext, SECRET_MARKER, family_model_api
from tests.family_model_settings.test_search_replacements import _activate_initial, _publish
from tests.family_model_settings.test_validation import _llm_payload


def _replacement_input(
    *,
    base_settings_version_number: int,
    base_search_profile_id: str,
    provider_profile_id: str,
    dimensions: int = 3,
) -> dict[str, object]:
    return {
        "base_settings_version_number": base_settings_version_number,
        "base_search_profile_id": base_search_profile_id,
        "provider_profile_id": provider_profile_id,
        "requested_model": "family-api-embedding-b",
        "dimensions": dimensions,
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
        "failure",
    }


def _assert_safe_progress_shape(payload: dict[str, Any]) -> None:
    # ``activated_at`` is intentionally omitted from a provisioning response
    # by ``response_model_exclude_none`` and appears only after activation.
    # ``failure`` follows the same rule until a job has actually failed.
    assert set(payload) <= _safe_progress_fields()
    assert set(payload) >= _safe_progress_fields() - {"activated_at", "failure"}


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

    current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert current.status_code == 200, current.text
    assert current.json() == progress

    family_model_api.use_member()
    member_current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert member_current.status_code == 403

    family_model_api.use_owner("family-b")
    other_family_current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert other_family_current.status_code == 200, other_family_current.text
    assert other_family_current.json() is None

    family_model_api.use_owner("family-a")

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

    current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert current.status_code == 200, current.text
    assert current.json() is None

    with family_model_api.session_factory() as db:
        family_settings = db.get(FamilyModelSettings, "family-a")
        assert family_settings is not None
        assert family_settings.active_search_profile_id == base_profile_id


def test_search_replacement_api_restores_failed_candidate_with_safe_diagnostics(
    family_model_api: FamilyModelApiContext,
) -> None:
    base_profile_id, target_profile_id = _prepare_active_search(
        family_model_api,
        suffix="failed-current",
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
            "idempotency_key": "search-api-create-failed-current-1",
        },
    )
    assert created.status_code == 200, created.text
    profile_id = str(created.json()["profile_id"])
    private_request_text = "家庭私密搜索正文"

    with family_model_api.session_factory() as db:
        candidate = db.get(FamilySearchProfile, profile_id)
        assert candidate is not None
        candidate.status = FamilyModelSearchProfileStatus.FAILED
        db.add(
            SearchIndexJob(
                id="search-job-failed-current",
                family_id="family-a",
                search_profile_id=profile_id,
                user_id="owner-a",
                status="failed",
                entity_type="ingredient",
                entity_id="ingredient-private",
                target_name=private_request_text,
                vector_status="failed",
                error=(
                    f"raw https://private.provider.example {SECRET_MARKER} "
                    f"{candidate.qdrant_collection} input={private_request_text}"
                ),
                error_code="search_embedding_provider_rejected",
                provider_http_status=400,
                provider_error_code="invalid_dimensions",
                provider_error_message=(
                    f"dimensions unsupported; input={private_request_text}; "
                    f"api_key={SECRET_MARKER}; collection={candidate.qdrant_collection}; "
                    "see https://private.provider.example/debug"
                ),
                request_sent=True,
                execution_certainty="confirmed_not_executed",
                attempt_count=3,
            )
        )
        collection = candidate.qdrant_collection
        db.commit()

    current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert current.status_code == 200, current.text
    payload = current.json()
    _assert_safe_progress_shape(payload)
    assert payload["profile_id"] == profile_id
    assert payload["status"] == "failed"
    assert payload["retryable"] is True
    assert payload["failure"] == {
        "code": "search_embedding_provider_rejected",
        "detail": "嵌入服务拒绝了请求（HTTP 400），现有索引未被替换。",
        "provider_http_status": 400,
        "provider_error_code": "invalid_dimensions",
        "provider_error_message": (
                "dimensions unsupported; request=[redacted]; [redacted]; "
                "collection=[collection]; see [provider-url]"
        ),
        "request_sent": True,
        "execution_certainty": "confirmed_not_executed",
    }

    serialized = json.dumps(payload, ensure_ascii=False)
    for forbidden in (
        private_request_text,
        SECRET_MARKER,
        collection,
        "private.provider.example",
        "qdrant",
    ):
        assert forbidden not in serialized


def test_failed_rebuild_pauses_pending_jobs_and_retry_resumes_all_documents(
    family_model_api: FamilyModelApiContext,
) -> None:
    base_profile_id, target_profile_id = _prepare_active_search(
        family_model_api,
        suffix="partial-failure",
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
            "idempotency_key": "search-api-create-partial-failure-1",
        },
    )
    assert created.status_code == 200, created.text
    profile_id = str(created.json()["profile_id"])

    documents: list[SearchDocument] = []
    profile_documents: list[FamilySearchProfileDocument] = []
    jobs: list[SearchIndexJob] = []
    for index in range(276):
        document_id = f"search-doc-partial-{index}"
        entity_id = f"ingredient-partial-{index}"
        content_hash = f"{index:064x}"
        documents.append(
            SearchDocument(
                id=document_id,
                family_id="family-a",
                entity_type="ingredient",
                entity_id=entity_id,
                title_text=f"食材 {index}",
                keyword_text=f"食材 {index}",
                detail_text="",
                semantic_text=f"食材：{index}",
                metadata_json={},
                content_hash=content_hash,
                document_builder_version="v1",
            )
        )
        profile_documents.append(
            FamilySearchProfileDocument(
                id=f"profile-doc-partial-{index}",
                family_id="family-a",
                search_profile_id=profile_id,
                search_document_id=document_id,
                content_hash=content_hash,
                status="failed" if index < 3 else ("indexing" if index == 3 else "pending"),
                error_code="search_embedding_provider_rejected" if index < 3 else None,
                attempt_count=1 if index < 3 else (MAX_ATTEMPTS - 1 if index == 3 else 0),
            )
        )
        jobs.append(
            SearchIndexJob(
                id=f"search-job-partial-{index}",
                family_id="family-a",
                search_profile_id=profile_id,
                price_version_id=None,
                user_id="owner-a",
                status="failed" if index < 3 else ("running" if index == 3 else "queued"),
                entity_type="ingredient",
                entity_id=entity_id,
                target_name=f"食材 {index}",
                vector_status="failed" if index < 3 else "pending",
                error="嵌入服务拒绝了请求" if index < 3 else None,
                error_code="search_embedding_provider_rejected" if index < 3 else None,
                attempt_count=1 if index < 3 else (MAX_ATTEMPTS - 1 if index == 3 else 0),
            )
        )

    with family_model_api.session_factory() as db:
        candidate = db.get(FamilySearchProfile, profile_id)
        assert candidate is not None
        assert candidate.candidate_price_version_id is not None
        for job in jobs:
            job.price_version_id = candidate.candidate_price_version_id
        db.add_all((*documents, *profile_documents, *jobs))
        db.commit()

    failure = EmbeddingUnavailableError(
        "embedding provider rejected request",
        code="search_embedding_provider_rejected",
        safe_detail="嵌入服务拒绝了请求（HTTP 400）：invalid_dimensions",
        status_code=400,
        provider_error_code="invalid_dimensions",
        provider_error_message="dimensions unsupported",
        request_sent=True,
        execution_certainty="confirmed_not_executed",
    )
    _mark_profile_job_failure(
        "search-job-partial-3",
        session_factory=family_model_api.session_factory,
        error=failure.safe_detail,
        error_code=failure.code,
        profile_status="failed",
        increment_provider_attempt=True,
        failure=failure,
    )

    with family_model_api.session_factory() as db:
        candidate = db.get(FamilySearchProfile, profile_id)
        assert candidate is not None
        assert candidate.status is FamilyModelSearchProfileStatus.FAILED
        status_counts = {
            status: db.query(FamilySearchProfileDocument)
            .filter(
                FamilySearchProfileDocument.search_profile_id == profile_id,
                FamilySearchProfileDocument.status == status,
            )
            .count()
            for status in ("failed", "pending")
        }
        job_counts = {
            status: db.query(SearchIndexJob)
            .filter(
                SearchIndexJob.search_profile_id == profile_id,
                SearchIndexJob.status == status,
            )
            .count()
            for status in ("failed", "cancelled", "queued")
        }
        assert status_counts == {"failed": 4, "pending": 272}
        assert job_counts == {"failed": 4, "cancelled": 272, "queued": 0}
        assert claim_pending_search_index_jobs(db, limit=16) == []

    current = family_model_api.client.get(
        "/api/family/model-settings/search/replacements/current"
    )
    assert current.status_code == 200, current.text
    assert current.json()["status"] == "failed"
    assert current.json()["total_documents"] == 276
    assert current.json()["failed_documents"] == 4

    current_settings = family_model_api.client.get("/api/family/model-settings")
    assert current_settings.status_code == 200, current_settings.text
    retried = family_model_api.client.post(
        f"/api/family/model-settings/search/replacements/{profile_id}/retry",
        json={
            "base_settings_version_number": current_settings.json()["version_number"],
            "idempotency_key": "search-api-retry-partial-failure-1",
        },
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["status"] == "provisioning"
    assert retried.json()["failed_documents"] == 0

    with family_model_api.session_factory() as db:
        assert db.query(FamilySearchProfileDocument).filter(
            FamilySearchProfileDocument.search_profile_id == profile_id,
            FamilySearchProfileDocument.status == "pending",
        ).count() == 276
        assert db.query(SearchIndexJob).filter(
            SearchIndexJob.search_profile_id == profile_id,
            SearchIndexJob.status == "queued",
            SearchIndexJob.attempt_count == 0,
        ).count() == 276
        assert len(claim_pending_search_index_jobs(db, limit=8)) == 8


def test_failed_rebuild_restores_active_embedding_draft_and_does_not_block_llm_save(
    family_model_api: FamilyModelApiContext,
) -> None:
    base_profile_id, target_profile_id = _prepare_active_search(
        family_model_api,
        suffix="draft-convergence",
    )

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        active_profile = db.get(FamilySearchProfile, base_profile_id)
        assert settings is not None and active_profile is not None
        assert settings.active_config_revision_id is not None
        active_embedding = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability
                == ModelUsageCapability.EMBEDDING,
                FamilyModelCapabilityBinding.variant_key == "search",
            )
        )
        assert active_embedding is not None
        active_profile.dimensions = 1536
        active_embedding.options_json = {
            **dict(active_embedding.options_json or {}),
            "dimensions": 1536,
        }
        db.commit()

    settings_response = family_model_api.client.get("/api/family/model-settings")
    assert settings_response.status_code == 200, settings_response.text
    request = _replacement_input(
        base_settings_version_number=settings_response.json()["version_number"],
        base_search_profile_id=base_profile_id,
        provider_profile_id=target_profile_id,
        dimensions=1024,
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
            "idempotency_key": "search-api-create-draft-convergence-1",
        },
    )
    assert created.status_code == 200, created.text
    candidate_profile_id = str(created.json()["profile_id"])

    with family_model_api.session_factory() as db:
        candidate = db.get(FamilySearchProfile, candidate_profile_id)
        draft = db.get(FamilyModelConfigDraft, "family-a")
        assert candidate is not None and candidate.candidate_price_version_id is not None
        assert draft is not None

        contaminated_payload = deepcopy(draft.payload_json)
        contaminated_payload["search_profile_id"] = candidate_profile_id
        contaminated_bindings = contaminated_payload["bindings"]
        assert isinstance(contaminated_bindings, list)
        embedding_index = next(
            index
            for index, binding in enumerate(contaminated_bindings)
            if binding["capability"] == "embedding" and binding["variant_key"] == "search"
        )
        contaminated_bindings[embedding_index] = {
            **contaminated_bindings[embedding_index],
            "provider_profile_id": target_profile_id,
            "requested_model": "family-api-embedding-b",
            "dimensions": 1024,
        }
        draft.payload_json = contaminated_payload
        draft.validation_status = "invalid"
        draft.validation_errors_json = [
            {
                "code": "family_search_profile_locked",
                "field": f"bindings.{embedding_index}",
            }
        ]
        contaminated_draft_version = draft.draft_version_number

        document = SearchDocument(
            id="search-doc-draft-convergence",
            family_id="family-a",
            entity_type="ingredient",
            entity_id="ingredient-draft-convergence",
            title_text="草稿收敛测试",
            keyword_text="草稿收敛测试",
            detail_text="",
            semantic_text="草稿收敛测试",
            metadata_json={},
            content_hash="d" * 64,
            document_builder_version="v1",
        )
        profile_document = FamilySearchProfileDocument(
            id="profile-doc-draft-convergence",
            family_id="family-a",
            search_profile_id=candidate_profile_id,
            search_document_id=document.id,
            content_hash=document.content_hash,
            status="indexing",
            attempt_count=MAX_ATTEMPTS - 1,
        )
        job = SearchIndexJob(
            id="search-job-draft-convergence",
            family_id="family-a",
            search_profile_id=candidate_profile_id,
            price_version_id=candidate.candidate_price_version_id,
            user_id="owner-a",
            status="running",
            entity_type="ingredient",
            entity_id=document.entity_id,
            target_name=document.title_text,
            vector_status="pending",
            attempt_count=MAX_ATTEMPTS - 1,
        )
        db.add_all((document, profile_document, job))
        db.commit()

    failure = EmbeddingUnavailableError(
        "embedding provider rejected request",
        code="search_embedding_provider_rejected",
        safe_detail="嵌入服务拒绝了请求（HTTP 400）：invalid_dimensions",
        status_code=400,
        provider_error_code="invalid_dimensions",
        provider_error_message="dimensions unsupported",
        request_sent=True,
        execution_certainty="confirmed_not_executed",
    )
    _mark_profile_job_failure(
        "search-job-draft-convergence",
        session_factory=family_model_api.session_factory,
        error=failure.safe_detail,
        error_code=failure.code,
        profile_status="failed",
        increment_provider_attempt=True,
        failure=failure,
    )

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        active_profile = db.get(FamilySearchProfile, base_profile_id)
        candidate = db.get(FamilySearchProfile, candidate_profile_id)
        draft = db.get(FamilyModelConfigDraft, "family-a")
        assert settings is not None and active_profile is not None
        assert candidate is not None and draft is not None
        assert settings.active_search_profile_id == base_profile_id
        assert active_profile.dimensions == 1536
        assert candidate.status is FamilyModelSearchProfileStatus.FAILED
        assert candidate.dimensions == 1024
        restored_embedding = next(
            binding
            for binding in draft.payload_json["bindings"]
            if binding["capability"] == "embedding" and binding["variant_key"] == "search"
        )
        assert restored_embedding["provider_profile_id"] == active_profile.provider_profile_id
        assert restored_embedding["requested_model"] == active_profile.embedding_model
        assert restored_embedding["dimensions"] == 1536
        assert draft.payload_json["search_profile_id"] == base_profile_id
        assert draft.draft_version_number == contaminated_draft_version + 1
        assert draft.validation_errors_json == []
        next_draft_version = draft.draft_version_number

    llm_payload = _llm_payload(target_profile_id)
    llm_payload["bindings"][0]["requested_model"] = "llm-after-failed-search-rebuild"  # type: ignore[index]
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json=llm_payload
        | {
            "base_draft_version_number": next_draft_version,
            "idempotency_key": "llm-save-after-failed-search-rebuild-1",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["validation_status"] == "valid"

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None and settings.active_config_revision_id is not None
        active_llm = db.scalar(
            select(FamilyModelCapabilityBinding).where(
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.capability == ModelUsageCapability.LLM,
                FamilyModelCapabilityBinding.variant_key == "primary",
            )
        )
        assert active_llm is not None
        assert active_llm.requested_model == "llm-after-failed-search-rebuild"
        assert settings.active_search_profile_id == base_profile_id
