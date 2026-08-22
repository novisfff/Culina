from __future__ import annotations

from app.core.enums import FamilyModelSearchProfileStatus
from sqlalchemy.orm import Session

from app.models.domain import Family, SearchDocument
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile
from app.repos.family_model_settings.search_profiles import (
    ensure_profile_document,
    get_profile_document,
    profile_document_counts,
    refresh_profile_progress,
)


def _profile(*, family_id: str, profile_id: str) -> FamilySearchProfile:
    return FamilySearchProfile(
        id=profile_id,
        family_id=family_id,
        provider_profile_id=f"provider-{family_id}",
        provider_profile_version_id=f"provider-version-{family_id}",
        adapter_kind="openai_compatible_http",
        embedding_model="embedding-test",
        dimensions=2,
        distance="Cosine",
        document_builder_version="v1",
        index_identity_checksum=f"identity-{profile_id}",
        qdrant_collection=f"culina_fsp_{profile_id}",
        status=FamilyModelSearchProfileStatus.PROVISIONING,
    )


def _document(*, family_id: str, document_id: str) -> SearchDocument:
    return SearchDocument(
        id=document_id,
        family_id=family_id,
        entity_type="ingredient",
        entity_id=f"entity-{document_id}",
        title_text="番茄",
        keyword_text="番茄",
        detail_text="",
        semantic_text="食材：番茄",
        metadata_json={},
        content_hash=f"content-{document_id}",
        document_builder_version="v1",
    )


def _add_families(db: Session) -> None:
    db.add_all(
        (
            Family(id="family-a", name="A", motto="", location=""),
            Family(id="family-b", name="B", motto="", location=""),
            FamilyModelSettings(family_id="family-a"),
            FamilyModelSettings(family_id="family-b"),
        )
    )
    db.flush()


def test_search_profile_document_identity_is_family_scoped(model_usage_db: Session) -> None:
    db = model_usage_db
    _add_families(db)
    profile_a = _profile(family_id="family-a", profile_id="profile-a")
    profile_b = _profile(family_id="family-b", profile_id="profile-b")
    document_a = _document(family_id="family-a", document_id="document-a")
    db.add_all((profile_a, profile_b, document_a))
    db.flush()

    row = ensure_profile_document(
        db,
        family_id=profile_a.family_id,
        search_profile_id=profile_a.id,
        search_document_id=document_a.id,
        content_hash=document_a.content_hash,
    )

    assert get_profile_document(
        db,
        family_id=profile_b.family_id,
        search_profile_id=profile_a.id,
        search_document_id=document_a.id,
    ) is None
    assert row.status == "pending"


def test_profile_document_progress_tracks_indexed_failed_and_budget_blocked(
    model_usage_db: Session,
) -> None:
    db = model_usage_db
    _add_families(db)
    profile = _profile(family_id="family-a", profile_id="profile-progress")
    documents = tuple(
        _document(family_id="family-a", document_id=f"document-{number}")
        for number in range(4)
    )
    db.add(profile)
    db.add_all(documents)
    db.flush()
    rows = [
        ensure_profile_document(
            db,
            family_id="family-a",
            search_profile_id=profile.id,
            search_document_id=document.id,
            content_hash=document.content_hash,
        )
        for document in documents
    ]
    rows[0].status = "indexed"
    rows[1].status = "indexed"
    rows[2].status = "failed"
    rows[3].status = "budget_blocked"

    counts = refresh_profile_progress(db, profile=profile)

    assert counts.total == 4
    assert counts.indexed == 2
    assert counts.failed == 1
    assert counts.budget_blocked == 1
    assert not counts.ready
    assert profile_document_counts(
        db, family_id="family-a", search_profile_id=profile.id
    ) == counts
    assert (profile.total_documents, profile.indexed_documents, profile.failed_documents) == (4, 2, 1)
