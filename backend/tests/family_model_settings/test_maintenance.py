from __future__ import annotations

import asyncio
from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import select

from app.core.enums import (
    FamilyModelResourceOperationStatus,
    FamilyModelSearchProfileStatus,
    FamilyModelSecretStatus,
)
from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelResourceOperation,
    FamilyModelSecretVersion,
    FamilySearchProfile,
)
from app.repos.family_model_settings.resource_operations import (
    insert_ensure_collection_operation,
)
from app.services.family_model_settings.maintenance import (
    maintain_family_model_settings,
    process_family_model_resource_operations,
    queue_expired_search_profile_cleanup_tombstones,
)
import app.main as main

from tests.family_model_settings._support import FamilyModelApiContext, family_model_api


class FakeQdrantAdmin:
    def __init__(self) -> None:
        self.collections: dict[str, int] = {}
        self.ensure_calls: list[str] = []
        self.delete_calls: list[str] = []
        self.fail_next_ensure = False

    def ensure_collection(self, *, collection: str, dimensions: int) -> None:
        self.ensure_calls.append(collection)
        if self.fail_next_ensure:
            self.fail_next_ensure = False
            raise RuntimeError("injected qdrant failure")
        self.collections.setdefault(collection, dimensions)

    def delete_collection(self, *, collection: str) -> None:
        self.delete_calls.append(collection)
        self.collections.pop(collection, None)


def _search_profile(
    context: FamilyModelApiContext,
    *,
    profile_id: str,
    status: FamilyModelSearchProfileStatus,
    suffix: str,
    created_at=None,
) -> FamilySearchProfile:
    with context.session_factory() as db:
        provider = db.get(FamilyModelProviderProfile, profile_id)
        assert provider is not None and provider.current_profile_version_id is not None
        search = FamilySearchProfile(
            id=f"maintenance-search-{suffix}",
            family_id="family-a",
            provider_profile_id=provider.id,
            provider_profile_version_id=provider.current_profile_version_id,
            adapter_kind="openai_compatible_http",
            embedding_model="maintenance-embedding",
            dimensions=3,
            distance="Cosine",
            document_builder_version="v1",
            index_identity_checksum=(f"maintenance-{suffix}".ljust(64, "0"))[:64],
            qdrant_collection=f"culina_maintenance_{suffix}",
            status=status,
            created_by="owner-a",
            created_at=created_at or utcnow(),
        )
        db.add(search)
        db.commit()
        return search


def test_maintenance_destroys_only_unreferenced_expired_revoked_secret(
    family_model_api: FamilyModelApiContext,
) -> None:
    created = family_model_api.create_profile(idempotency_key="maintenance-secret-profile-1")
    now = utcnow()
    with family_model_api.session_factory() as db:
        provider = db.get(FamilyModelProviderProfile, created["id"])
        assert provider is not None
        revoked = FamilyModelSecretVersion(
            id="maintenance-revoked-secret",
            family_id="family-a",
            profile_id=provider.id,
            version_number=99,
            encryption_key_id="test-key",
            nonce=b"nonce",
            ciphertext=b"ciphertext",
            auth_tag=b"tag",
            secret_fingerprint="f" * 64,
            status=FamilyModelSecretStatus.REVOKED,
            revoked_at=now - timedelta(days=2),
            created_by="owner-a",
        )
        db.add(revoked)
        db.commit()
        stats = maintain_family_model_settings(db, now=now)
        db.commit()
        refreshed = db.get(FamilyModelSecretVersion, revoked.id)
        assert refreshed is not None
        assert refreshed.status is FamilyModelSecretStatus.DESTROYED
        assert refreshed.ciphertext is None
        assert stats.destroyed_secrets == 1


def test_expired_cleanup_tombstones_are_idempotent(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = family_model_api.create_profile(idempotency_key="maintenance-cleanup-profile-1")
    old = utcnow() - timedelta(days=30)
    _search_profile(
        family_model_api,
        profile_id=str(provider["id"]),
        status=FamilyModelSearchProfileStatus.FAILED,
        suffix="old",
        created_at=old,
    )
    now = utcnow()
    with family_model_api.session_factory() as db:
        assert queue_expired_search_profile_cleanup_tombstones(
            db, cutoff=now - timedelta(days=7)
        ) == 1
        assert queue_expired_search_profile_cleanup_tombstones(
            db, cutoff=now - timedelta(days=7)
        ) == 0
        db.commit()


def test_pending_ensure_is_durable_and_retries_after_qdrant_failure(
    family_model_api: FamilyModelApiContext,
) -> None:
    provider = family_model_api.create_profile(idempotency_key="maintenance-ensure-profile-1")
    profile = _search_profile(
        family_model_api,
        profile_id=str(provider["id"]),
        status=FamilyModelSearchProfileStatus.PROVISIONING,
        suffix="ensure",
    )
    qdrant = FakeQdrantAdmin()
    now = utcnow()
    with family_model_api.session_factory() as db:
        operation = insert_ensure_collection_operation(db, search_profile=profile)
        db.commit()

    qdrant.fail_next_ensure = True
    with family_model_api.session_factory() as db:
        first = process_family_model_resource_operations(
            db, now=now, qdrant_admin=qdrant
        )
        db.commit()
        row = db.get(FamilyModelResourceOperation, operation.id)
        assert row is not None
        assert row.status is FamilyModelResourceOperationStatus.RETRY_WAIT
        assert first.retried == 1

    with family_model_api.session_factory() as db:
        second = process_family_model_resource_operations(
            db,
            now=now + timedelta(hours=2),
            qdrant_admin=qdrant,
        )
        db.commit()
        row = db.get(FamilyModelResourceOperation, operation.id)
        assert row is not None
        assert row.status is FamilyModelResourceOperationStatus.COMPLETED
        assert qdrant.collections[profile.qdrant_collection] == profile.dimensions
        assert qdrant.ensure_calls == [profile.qdrant_collection, profile.qdrant_collection]
        assert second.completed == 1


def test_lifespan_starts_and_stops_family_model_maintenance_worker(monkeypatch) -> None:
    events: list[str] = []

    class FakeDb:
        def begin(self):
            return nullcontext()

    class RecordingWorker:
        def __init__(self, name: str) -> None:
            self.name = name

        def start(self) -> None:
            events.append(f"{self.name}:start")

        def stop(self) -> None:
            events.append(f"{self.name}:stop")

    monkeypatch.setattr(main, "SessionLocal", lambda: nullcontext(FakeDb()))
    monkeypatch.setattr(main, "initialize_configured_admin", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "ImageGenerationWorker", lambda: RecordingWorker("image"))
    monkeypatch.setattr(main, "SearchIndexWorker", lambda: RecordingWorker("search"))
    monkeypatch.setattr(main, "ModelUsageMaintenanceWorker", lambda: RecordingWorker("usage"))
    monkeypatch.setattr(
        main,
        "FamilyModelSettingsMaintenanceWorker",
        lambda: RecordingWorker("family-model"),
    )
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            model_usage_required=False,
            model_usage_maintenance_enabled=False,
            family_model_maintenance_enabled=True,
        ),
    )

    async def exercise_lifespan() -> None:
        async with main.lifespan(object()):
            assert events == ["image:start", "search:start", "family-model:start"]

    asyncio.run(exercise_lifespan())
    assert events == [
        "image:start",
        "search:start",
        "family-model:start",
        "family-model:stop",
        "search:stop",
        "image:stop",
    ]
