from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import IngredientExpiryMode
from app.models.domain import Base, Family, Ingredient, SearchDocument
from scripts import rebuild_search_index


class _NoopSession:
    def __enter__(self) -> "_NoopSession":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    def commit(self) -> None:
        return None


def test_rebuild_search_index_indexes_selected_scope_for_family() -> None:
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    with SessionLocal() as db:
        db.add_all(
            [
                Family(id="family-1", name="一号家庭"),
                Family(id="family-2", name="二号家庭"),
                Ingredient(
                    id="ingredient-tomato",
                    family_id="family-1",
                    name="番茄",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                ),
                Ingredient(
                    id="ingredient-other",
                    family_id="family-2",
                    name="鸡蛋",
                    category="蛋奶",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                ),
            ]
        )
        db.commit()

    original_session_local = rebuild_search_index.SessionLocal
    rebuild_search_index.SessionLocal = SessionLocal
    try:
        stats = rebuild_search_index.rebuild_search_index(scopes=["ingredients"], family_id="family-1")
    finally:
        rebuild_search_index.SessionLocal = original_session_local

    assert stats == {"ingredients": 1, "foods": 0, "recipes": 0}
    with SessionLocal() as db:
        documents = list(db.scalars(select(SearchDocument)))
        assert len(documents) == 1
        assert documents[0].family_id == "family-1"
        assert documents[0].entity_id == "ingredient-tomato"


def test_index_all_pending_vectors_processes_until_empty_batch(monkeypatch) -> None:
    batches = [
        {"indexed": 20, "failed": 0, "skipped": 0},
        {"indexed": 3, "failed": 1, "skipped": 2},
        {"indexed": 0, "failed": 0, "skipped": 0},
    ]
    seen_batch_sizes: list[int] = []

    def fake_session_local() -> _NoopSession:
        return _NoopSession()

    def fake_index_pending_search_documents(db: _NoopSession, *, batch_size: int) -> dict[str, int]:
        del db
        seen_batch_sizes.append(batch_size)
        return batches.pop(0)

    monkeypatch.setattr(rebuild_search_index, "SessionLocal", fake_session_local)
    monkeypatch.setattr(rebuild_search_index, "index_pending_search_documents", fake_index_pending_search_documents)

    stats = rebuild_search_index.index_all_pending_vectors(batch_size=25)

    assert stats == {"indexed": 23, "failed": 1, "skipped": 2}
    assert seen_batch_sizes == [25, 25, 25]
