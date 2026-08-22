from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from threading import Barrier

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.db.base import Base
from app.models.domain import Family
from app.models.family_model_settings import FamilyModelConfigDraft, FamilyModelSettings
from app.services.family_model_settings.credentials import FamilyModelCredentialCipher
from app.services.family_model_settings.drafts import SaveConfigDraftCommand, save_config_draft
from app.services.family_model_settings.errors import FamilyModelSettingsVersionConflict

from tests.family_model_settings._support import make_cipher


def _mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


@dataclass(frozen=True, slots=True)
class DraftMysqlContext:
    SessionLocal: sessionmaker[Session]
    cipher: FamilyModelCredentialCipher

    def save(self, *, index: int, base_version: int):
        with self.SessionLocal() as db:
            try:
                result = save_config_draft(
                    db,
                    SaveConfigDraftCommand(
                        family_id="family-draft-mysql",
                        actor_user_id=f"owner-{index}",
                        base_draft_version_number=base_version,
                        idempotency_key=f"draft-mysql-{base_version}-{index}",
                        payload={
                            "bindings": [
                                {
                                    "capability": "llm",
                                    "variant_key": "primary",
                                    "enabled": False,
                                    "max_output_tokens": 1024 + index,
                                }
                            ],
                            "change_note": f"并发保存 {index}",
                        },
                    ),
                    cipher=self.cipher,
                )
                db.commit()
                return result
            except FamilyModelSettingsVersionConflict as exc:
                db.rollback()
                return exc

    def draft_version(self) -> int:
        with self.SessionLocal() as db:
            draft = db.get(FamilyModelConfigDraft, "family-draft-mysql")
            return draft.draft_version_number if draft is not None else 0


@pytest.fixture()
def draft_mysql_context() -> DraftMysqlContext:
    engine = create_engine(_mysql_url(), poolclass=NullPool, pool_pre_ping=True, future=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    with SessionLocal() as db:
        db.add(Family(id="family-draft-mysql", name="并发家庭", motto="", location=""))
        db.flush()
        db.add(FamilyModelSettings(family_id="family-draft-mysql"))
        db.commit()
    try:
        yield DraftMysqlContext(SessionLocal=SessionLocal, cipher=make_cipher())
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def _race(context: DraftMysqlContext, *, base_version: int):
    barrier = Barrier(2, timeout=20)

    def run(index: int):
        barrier.wait(timeout=20)
        return context.save(index=index, base_version=base_version)

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(run, range(2)))


@pytest.mark.parametrize("existing", [False, True])
def test_mysql_concurrent_draft_saves_advance_exactly_once(
    draft_mysql_context: DraftMysqlContext,
    existing: bool,
) -> None:
    context = draft_mysql_context
    base_version = 0
    if existing:
        first = context.save(index=9, base_version=0)
        assert not isinstance(first, FamilyModelSettingsVersionConflict)
        base_version = 1

    results = _race(context, base_version=base_version)

    assert sum(not isinstance(result, FamilyModelSettingsVersionConflict) for result in results) == 1
    conflicts = [result for result in results if isinstance(result, FamilyModelSettingsVersionConflict)]
    assert len(conflicts) == 1
    assert conflicts[0].current_draft_version_number == base_version + 1
    assert context.draft_version() == base_version + 1


def test_mysql_same_idempotency_key_replays_the_winner_without_reexecution(
    draft_mysql_context: DraftMysqlContext,
) -> None:
    context = draft_mysql_context
    barrier = Barrier(2, timeout=20)

    def run() -> object:
        barrier.wait(timeout=20)
        return context.save(index=0, base_version=0)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        first, second = (future.result() for future in futures)

    assert not isinstance(first, FamilyModelSettingsVersionConflict)
    assert not isinstance(second, FamilyModelSettingsVersionConflict)
    assert first == second
    assert context.draft_version() == 1
