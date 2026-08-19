"""Family-scoped persistence helpers for immutable search profiles.

The legacy ``search_documents`` table remains the canonical text source.  A
profile document is the lifecycle record for one immutable vector index, so a
single document may deliberately have one active and one provisioning row at
the same time.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.domain import SearchDocument
from app.models.family_model_settings import (
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.services.family_model_settings.errors import FamilyModelSettingsError


@dataclass(frozen=True, slots=True)
class SearchProfileDocumentCounts:
    total: int
    indexed: int
    failed: int
    budget_blocked: int

    @property
    def ready(self) -> bool:
        return self.total == self.indexed and self.failed == 0 and self.budget_blocked == 0


def get_search_profile(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    for_update: bool = False,
) -> FamilySearchProfile | None:
    statement = select(FamilySearchProfile).where(
        FamilySearchProfile.family_id == family_id,
        FamilySearchProfile.id == search_profile_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def require_search_profile(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    for_update: bool = False,
) -> FamilySearchProfile:
    profile = get_search_profile(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
        for_update=for_update,
    )
    if profile is None:
        raise FamilyModelSettingsError("family_search_profile_not_found")
    return profile


def lock_search_profile(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
) -> FamilySearchProfile:
    return require_search_profile(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
        for_update=True,
    )


def get_profile_document(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    search_document_id: str,
    for_update: bool = False,
) -> FamilySearchProfileDocument | None:
    statement = select(FamilySearchProfileDocument).where(
        FamilySearchProfileDocument.family_id == family_id,
        FamilySearchProfileDocument.search_profile_id == search_profile_id,
        FamilySearchProfileDocument.search_document_id == search_document_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def require_profile_document(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    search_document_id: str,
    for_update: bool = False,
) -> FamilySearchProfileDocument:
    row = get_profile_document(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
        search_document_id=search_document_id,
        for_update=for_update,
    )
    if row is None:
        raise FamilyModelSettingsError("family_search_profile_document_not_found")
    return row


def ensure_profile_document(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    search_document_id: str,
    content_hash: str,
) -> FamilySearchProfileDocument:
    """Create or refresh a profile-owned vector lifecycle record.

    The profile lookup is deliberate: it makes an untrusted profile ID from a
    different family indistinguishable from a missing profile and prevents a
    cross-family row from being inserted through the composite identity.
    """

    require_search_profile(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
    )
    row = get_profile_document(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
        search_document_id=search_document_id,
        for_update=True,
    )
    if row is None:
        row = FamilySearchProfileDocument(
            family_id=family_id,
            search_profile_id=search_profile_id,
            search_document_id=search_document_id,
            content_hash=content_hash,
            status="pending",
        )
        db.add(row)
        db.flush()
        return row
    if row.content_hash != content_hash:
        row.content_hash = content_hash
        row.status = "pending"
        row.vector_json = None
        row.vector_dimensions = None
        row.error_code = None
        row.indexed_at = None
    return row


def upsert_profile_document_snapshot(
    db: Session,
    *,
    profile: FamilySearchProfile,
    document: SearchDocument,
) -> FamilySearchProfileDocument:
    if profile.family_id != document.family_id:
        raise FamilyModelSettingsError("family_search_profile_document_family_mismatch")
    return ensure_profile_document(
        db,
        family_id=profile.family_id,
        search_profile_id=profile.id,
        search_document_id=document.id,
        content_hash=document.content_hash,
    )


def list_profile_documents(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    statuses: tuple[str, ...] | None = None,
    for_update: bool = False,
) -> tuple[FamilySearchProfileDocument, ...]:
    statement = select(FamilySearchProfileDocument).where(
        FamilySearchProfileDocument.family_id == family_id,
        FamilySearchProfileDocument.search_profile_id == search_profile_id,
    )
    if statuses is not None:
        statement = statement.where(FamilySearchProfileDocument.status.in_(statuses))
    if for_update:
        statement = statement.with_for_update()
    statement = statement.order_by(
        FamilySearchProfileDocument.created_at.asc(),
        FamilySearchProfileDocument.id.asc(),
    )
    return tuple(db.scalars(statement))


def profile_document_counts(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
) -> SearchProfileDocumentCounts:
    rows = db.execute(
        select(
            func.count(FamilySearchProfileDocument.id),
            func.sum(case((FamilySearchProfileDocument.status == "indexed", 1), else_=0)),
            func.sum(case((FamilySearchProfileDocument.status == "failed", 1), else_=0)),
            func.sum(
                case((FamilySearchProfileDocument.status == "budget_blocked", 1), else_=0)
            ),
        ).where(
            FamilySearchProfileDocument.family_id == family_id,
            FamilySearchProfileDocument.search_profile_id == search_profile_id,
        )
    ).one()
    return SearchProfileDocumentCounts(
        total=int(rows[0] or 0),
        indexed=int(rows[1] or 0),
        failed=int(rows[2] or 0),
        budget_blocked=int(rows[3] or 0),
    )


def refresh_profile_progress(
    db: Session,
    *,
    profile: FamilySearchProfile,
) -> SearchProfileDocumentCounts:
    counts = profile_document_counts(
        db,
        family_id=profile.family_id,
        search_profile_id=profile.id,
    )
    profile.total_documents = counts.total
    profile.indexed_documents = counts.indexed
    profile.failed_documents = counts.failed
    return counts


def list_profiles_accepting_document_updates(
    db: Session,
    *,
    family_id: str,
) -> tuple[FamilySearchProfile, ...]:
    """Return exactly the current active profile plus live provisioning work.

    A failed, cancelled, superseded or retired profile must never get an
    incremental write merely because it still exists for audit/cleanup.
    """

    settings = db.get(FamilyModelSettings, family_id)
    active_id = settings.active_search_profile_id if settings is not None else None
    statement = select(FamilySearchProfile).where(
        FamilySearchProfile.family_id == family_id,
        (
            (FamilySearchProfile.id == active_id)
            | (FamilySearchProfile.status == FamilyModelSearchProfileStatus.PROVISIONING)
        ),
    ).order_by(FamilySearchProfile.created_at.asc(), FamilySearchProfile.id.asc())
    return tuple(db.scalars(statement))


def candidate_price_version_id(
    db: Session,
    *,
    profile: FamilySearchProfile,
) -> str | None:
    """Return the candidate's dedicated immutable price identity.

    The profile pointer is authoritative for new rows.  The fallback makes
    this helper safe for a briefly partially-created transaction only; it is
    still constrained to the same family/profile and candidate purpose.
    """

    if profile.candidate_price_version_id:
        return profile.candidate_price_version_id
    return db.scalar(
        select(ModelUsagePriceVersion.id).where(
            ModelUsagePriceVersion.family_id == profile.family_id,
            ModelUsagePriceVersion.search_profile_id == profile.id,
            ModelUsagePriceVersion.purpose == "search_rebuild_candidate",
        )
    )
