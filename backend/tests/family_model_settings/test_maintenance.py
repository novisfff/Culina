from __future__ import annotations

import asyncio
from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace

import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.dialects import mysql

from app.core.enums import (
    FamilyModelResourceOperationStatus,
    FamilyModelSearchProfileStatus,
    FamilyModelSecretStatus,
)
from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelSettings,
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
from app.services.family_model_settings.errors import FamilyModelCredentialConfigurationError
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


def test_maintenance_activates_a_valid_draft_left_by_the_legacy_publish_flow(
    family_model_api: FamilyModelApiContext,
) -> None:
    profile = family_model_api.create_profile(
        idempotency_key="maintenance-legacy-draft-profile-1"
    )
    saved = family_model_api.client.put(
        "/api/family/model-settings/draft",
        json={
            "bindings": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "enabled": True,
                    "provider_profile_id": profile["id"],
                    "requested_model": "maintenance-legacy-model",
                    "max_output_tokens": 256,
                }
            ],
            "price_rates": [
                {
                    "capability": "llm",
                    "variant_key": "primary",
                    "meter": meter,
                    "unit_quantity": "1000000",
                    "unit_price": "0",
                    "source_currency": "CNY",
                    "fx_to_cny": "1",
                }
                for meter in (
                    "uncached_input_tokens",
                    "cached_input_tokens",
                    "output_tokens",
                )
            ],
            "change_note": "旧发布流程遗留草稿",
            "base_draft_version_number": 0,
            "idempotency_key": "maintenance-legacy-draft-save-1",
        },
    )
    assert saved.status_code == 200, saved.text

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is not None
        settings.active_config_revision_id = None
        settings.active_price_version_id = None
        db.commit()

    with family_model_api.session_factory() as db:
        settings = db.get(FamilyModelSettings, "family-a")
        assert settings is not None
        assert settings.active_config_revision_id is None

        stats = maintain_family_model_settings(
            db,
            network_policy=family_model_api.policy,
        )
        db.commit()

        assert stats.applied_configurations == 1
        db.refresh(settings)
        assert settings.active_config_revision_id is not None

    status = family_model_api.client.get("/api/ai/status")
    assert status.status_code == 200, status.text
    assert status.json()["configured"] is True
    assert status.json()["capabilities"]["llm"] == "available"


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


def test_expired_cleanup_scan_skips_locked_profiles() -> None:
    statements = []

    class RecordingDb:
        def scalars(self, statement):
            statements.append(statement)
            return iter(())

        def flush(self) -> None:
            return None

    assert queue_expired_search_profile_cleanup_tombstones(
        RecordingDb(), cutoff=utcnow()
    ) == 0
    assert len(statements) == 1
    sql = str(statements[0].compile(dialect=mysql.dialect())).upper()
    assert "FOR UPDATE SKIP LOCKED" in sql


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
    monkeypatch.setattr(main, "ensure_media_bucket", lambda: events.append("media:private"))
    monkeypatch.setattr(
        main,
        "validate_family_model_credential_keyring_references",
        lambda *_args, **_kwargs: events.append("credentials:validate"),
    )
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
            assert events == [
                "credentials:validate",
                "media:private",
                "image:start",
                "search:start",
                "family-model:start",
            ]

    asyncio.run(exercise_lifespan())
    assert events == [
        "credentials:validate",
        "media:private",
        "image:start",
        "search:start",
        "family-model:start",
        "family-model:stop",
        "search:stop",
        "image:stop",
    ]


def test_startup_rejects_a_missing_local_keyring_when_the_database_retains_references(
    family_model_api: FamilyModelApiContext,
    tmp_path,
) -> None:
    family_model_api.create_profile()
    keyring_path = tmp_path / "secrets" / "family-model-keyring.json"
    empty_local_settings = SimpleNamespace(
        environment="local",
        family_model_credential_active_key_id="",
        family_model_credential_keys_json=SecretStr(""),
        family_model_credential_keyring_file=str(keyring_path),
    )

    with family_model_api.session_factory() as db:
        with pytest.raises(
            FamilyModelCredentialConfigurationError,
            match="family_model_credential_referenced_key_missing",
        ):
            main.validate_family_model_credential_keyring_references(
                db,
                current_settings=empty_local_settings,
            )
    assert not keyring_path.exists()


def test_startup_generates_a_local_keyring_before_any_credentials_exist(
    family_model_api: FamilyModelApiContext,
    tmp_path,
) -> None:
    keyring_path = tmp_path / "secrets" / "family-model-keyring.json"
    empty_local_settings = SimpleNamespace(
        environment="local",
        family_model_credential_active_key_id="",
        family_model_credential_keys_json=SecretStr(""),
        family_model_credential_keyring_file=str(keyring_path),
    )

    with family_model_api.session_factory() as db:
        main.validate_family_model_credential_keyring_references(
            db,
            current_settings=empty_local_settings,
        )
    assert keyring_path.is_file()
