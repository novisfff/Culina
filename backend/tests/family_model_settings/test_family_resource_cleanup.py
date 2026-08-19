from __future__ import annotations

from sqlalchemy import select

from app.core.enums import (
    FamilyModelResourceOperationStatus,
    FamilyModelResourceOperationType,
    FamilyModelSearchProfileStatus,
)
from app.models.domain import Family
from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelResourceOperation,
    FamilySearchProfile,
)
from app.repos.family_model_settings.resource_operations import (
    insert_ensure_collection_operation,
)
from app.services.family_model_settings.maintenance import (
    delete_family_with_model_cleanup,
    process_family_model_resource_operations,
)

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api
from tests.family_model_settings.test_maintenance import FakeQdrantAdmin


def _profile(context: FamilyModelApiContext, *, suffix: str) -> tuple[str, str]:
    provider = context.create_profile(idempotency_key=f"cleanup-profile-{suffix}-1")
    with context.session_factory() as db:
        row = db.get(FamilyModelProviderProfile, provider["id"])
        assert row is not None and row.current_profile_version_id is not None
        profile = FamilySearchProfile(
            id=f"cleanup-search-{suffix}",
            family_id="family-a",
            provider_profile_id=row.id,
            provider_profile_version_id=row.current_profile_version_id,
            adapter_kind="openai_compatible_http",
            embedding_model="cleanup-embedding",
            dimensions=3,
            distance="Cosine",
            document_builder_version="v1",
            index_identity_checksum=(f"cleanup-{suffix}".ljust(64, "0"))[:64],
            qdrant_collection=f"culina_cleanup_{suffix}",
            status=FamilyModelSearchProfileStatus.PROVISIONING,
            created_by="owner-a",
        )
        db.add(profile)
        db.commit()
        return profile.id, profile.qdrant_collection


def test_family_delete_writes_non_cascading_tombstones_and_suppresses_ensure(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile_id, collection = _profile(family_model_api, suffix="family")
    with family_model_api.session_factory() as db:
        profile = db.get(FamilySearchProfile, profile_id)
        assert profile is not None
        ensure = insert_ensure_collection_operation(db, search_profile=profile)
        assert delete_family_with_model_cleanup(db, family_id="family-a") is True
        db.commit()

        assert db.get(Family, "family-a") is None
        ensure_row = db.get(FamilyModelResourceOperation, ensure.id)
        assert ensure_row is not None
        assert ensure_row.status is FamilyModelResourceOperationStatus.COMPLETED
        tombstones = tuple(
            db.scalars(
                select(FamilyModelResourceOperation).where(
                    FamilyModelResourceOperation.family_id_snapshot == "family-a",
                    FamilyModelResourceOperation.operation_type
                    == FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
                )
            )
        )
        assert [row.qdrant_collection_snapshot for row in tombstones] == [collection]


def test_delete_tombstone_finishes_after_family_rows_have_cascaded(
    family_model_api: FamilyModelApiContext,
) -> None:
    _, collection = _profile(family_model_api, suffix="worker")
    qdrant = FakeQdrantAdmin()
    qdrant.collections[collection] = 3
    with family_model_api.session_factory() as db:
        assert delete_family_with_model_cleanup(db, family_id="family-a") is True
        db.commit()
        stats = process_family_model_resource_operations(db, qdrant_admin=qdrant)
        db.commit()
        tombstone = db.scalar(
            select(FamilyModelResourceOperation).where(
                FamilyModelResourceOperation.family_id_snapshot == "family-a",
                FamilyModelResourceOperation.qdrant_collection_snapshot == collection,
                FamilyModelResourceOperation.operation_type
                == FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
            )
        )
        assert tombstone is not None
        assert tombstone.status is FamilyModelResourceOperationStatus.COMPLETED
        assert collection not in qdrant.collections
        assert stats.completed == 1
