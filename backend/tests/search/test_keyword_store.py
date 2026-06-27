from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import bindparam, create_engine
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session, sessionmaker

from app.models.domain import Base, Family
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import upsert_search_document
from app.services.search.keyword_store import _mysql_fulltext_statement, search_keyword_documents


def test_keyword_search_is_scoped_to_family_and_scores_title_matches() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add_all(
            [
                Family(id="family-1", name="一号家庭", created_at=now, updated_at=now),
                Family(id="family-2", name="二号家庭", created_at=now, updated_at=now),
            ]
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-1",
                title_text="番茄鸡蛋汤",
                keyword_text="番茄 鸡蛋 晚餐",
                detail_text="清淡快手",
                semantic_text="菜谱：番茄鸡蛋汤",
                metadata_json={"title": "番茄鸡蛋汤"},
                content_hash="hash-1",
            ),
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-2",
                entity_type="recipe",
                entity_id="recipe-2",
                title_text="番茄炒蛋",
                keyword_text="番茄 鸡蛋",
                detail_text="",
                semantic_text="菜谱：番茄炒蛋",
                metadata_json={"title": "番茄炒蛋"},
                content_hash="hash-2",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_keyword_documents(db, family_id="family-1", query="番茄", scopes=["recipe"], limit=10)

    assert [hit.entity_id for hit in hits] == ["recipe-1"]
    assert hits[0].matched_fields == ("title_text", "keyword_text")
    assert hits[0].keyword_score > 0.5


def test_mysql_keyword_search_statement_uses_fulltext_indexes() -> None:
    statement = (
        _mysql_fulltext_statement()
        .bindparams(bindparam("scopes", expanding=True))
        .params(family_id="family-1", scopes=["recipe", "food"], query="番茄", limit=10)
    )
    compiled = str(statement.compile(dialect=mysql.dialect(), compile_kwargs={"render_postcompile": True}))

    assert "MATCH(title_text) AGAINST" in compiled
    assert "MATCH(keyword_text) AGAINST" in compiled
    assert "MATCH(detail_text) AGAINST" in compiled
    assert "entity_type IN" in compiled
    assert "* 0.55" in compiled
    assert "* 0.35" in compiled
    assert "* 0.10" in compiled
