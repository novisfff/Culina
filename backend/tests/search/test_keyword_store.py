from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import bindparam, create_engine
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import Difficulty, IngredientExpiryMode
from app.models.domain import Base, Family, Ingredient, Recipe
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import upsert_search_document
from app.services.search.keyword_store import (
    KeywordSearchHit,
    _merge_keyword_hits,
    _mysql_fulltext_statement,
    _should_use_substring_fallback,
    search_exact_name_documents,
    search_keyword_documents,
)


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


def test_keyword_search_treats_title_contains_as_strong_match() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭", created_at=now, updated_at=now))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="ingredient-oil",
                title_text="食用油",
                keyword_text="调料 常温",
                detail_text="",
                semantic_text="食材：食用油",
                metadata_json={},
                content_hash="hash-oil",
            ),
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="ingredient-category",
                title_text="调味料",
                keyword_text="油脂",
                detail_text="",
                semantic_text="食材：调味料",
                metadata_json={},
                content_hash="hash-category",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_keyword_documents(db, family_id="family-1", query="油", scopes=["ingredient"], limit=10)

    assert [hit.entity_id for hit in hits] == ["ingredient-oil", "ingredient-category"]
    assert hits[0].keyword_score == 1.0
    assert hits[1].keyword_score < hits[0].keyword_score


def test_keyword_search_merges_fulltext_with_substring_fallback_for_short_chinese_query() -> None:
    assert _should_use_substring_fallback("油") is True
    hits = _merge_keyword_hits(
        [
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-oil",
                keyword_score=0.72,
                matched_fields=("title_text",),
            )
        ],
        [
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-oil",
                keyword_score=1.0,
                matched_fields=("title_text",),
            ),
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-soy-sauce",
                keyword_score=1.0,
                matched_fields=("title_text",),
            ),
        ],
        limit=10,
    )

    assert [hit.entity_id for hit in hits] == ["ingredient-oil", "ingredient-soy-sauce"]
    assert all(hit.keyword_score == 1.0 for hit in hits)


def test_exact_name_search_is_scoped_to_family_and_scope() -> None:
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
        db.add_all(
            [
                Ingredient(
                    id="ingredient-1",
                    family_id="family-1",
                    name="番茄",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Recipe(
                    id="recipe-1",
                    family_id="family-1",
                    title="番茄",
                    servings=1,
                    prep_minutes=10,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                ),
                Ingredient(
                    id="ingredient-2",
                    family_id="family-2",
                    name="番茄",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
            ]
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_exact_name_documents(db, family_id="family-1", query=" 番茄 ", scopes=["ingredient"], limit=10)

    assert [hit.entity_id for hit in hits] == ["ingredient-1"]
    assert hits[0].keyword_score == 1.0
    assert hits[0].matched_fields == ("title_text",)


def test_exact_name_search_does_not_require_search_document() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭", created_at=now, updated_at=now))
        db.add(
            Ingredient(
                family_id="family-1",
                id="ingredient-chicken",
                name="鸡",
                category="禽肉",
                default_unit="克",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
            )
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_exact_name_documents(db, family_id="family-1", query="鸡", scopes=["ingredient"], limit=10)

    assert [hit.entity_id for hit in hits] == ["ingredient-chicken"]


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
