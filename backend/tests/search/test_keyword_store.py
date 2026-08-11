from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import bindparam, create_engine
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import Difficulty, IngredientExpiryMode
from app.models.domain import Base, Family, Ingredient, Recipe, SearchDocument
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import upsert_search_document
from app.services.search.keyword_store import (
    KeywordMatchMode,
    KeywordSearchHit,
    _compact_matched_fields,
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


def _private_search_document(
    *,
    entity_type: str,
    entity_id: str,
    user_id: str | None,
    title_text: str,
    keyword_text: str,
    updated_at: datetime,
) -> SearchDocument:
    metadata_json = {"user_id": user_id} if user_id is not None else {}
    return SearchDocument(
        id=f"doc-{entity_id}",
        family_id="family-1",
        entity_type=entity_type,
        entity_id=entity_id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text="",
        semantic_text=title_text,
        metadata_json=metadata_json,
        content_hash=f"hash-{entity_id}",
        document_builder_version="v1",
        created_at=updated_at,
        updated_at=updated_at,
    )


def test_keyword_search_filters_private_meal_plans_before_like_limit() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭", created_at=now, updated_at=now))
        db.add(
            _private_search_document(
                entity_type="meal_plan",
                entity_id="current-user-plan",
                user_id="user-current",
                title_text="private dinner current",
                keyword_text="private dinner",
                updated_at=now,
            )
        )
        db.add_all(
            _private_search_document(
                entity_type="meal_plan",
                entity_id=f"other-user-plan-{index}",
                user_id="user-other",
                title_text=f"private dinner other {index}",
                keyword_text="private dinner",
                updated_at=now + timedelta(minutes=index + 1),
            )
            for index in range(3)
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_keyword_documents(
            db,
            family_id="family-1",
            user_id="user-current",
            query="private dinner",
            scopes=["meal_plan"],
            limit=3,
        )

    assert [hit.entity_id for hit in hits] == ["current-user-plan"]


def test_keyword_search_filters_private_meal_plans_before_compact_scan_limit() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭", created_at=now, updated_at=now))
        db.add(
            _private_search_document(
                entity_type="meal_plan",
                entity_id="current-user-plan",
                user_id="user-current",
                title_text="当前计划",
                keyword_text="鸡 肉",
                updated_at=now,
            )
        )
        db.add_all(
            _private_search_document(
                entity_type="meal_plan",
                entity_id=f"other-user-plan-{index}",
                user_id="user-other",
                title_text=f"其他计划 {index}",
                keyword_text="鸡 肉",
                updated_at=now + timedelta(minutes=index + 1),
            )
            for index in range(300)
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_keyword_documents(
            db,
            family_id="family-1",
            user_id="user-current",
            query="鸡肉",
            scopes=["meal_plan"],
            limit=1,
        )

    assert [hit.entity_id for hit in hits] == ["current-user-plan"]


def test_keyword_search_without_user_excludes_private_plans_before_mixed_scope_limit() -> None:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭", created_at=now, updated_at=now))
        db.add_all(
            [
                _private_search_document(
                    entity_type="recipe",
                    entity_id="family-recipe",
                    user_id=None,
                    title_text="family dinner recipe",
                    keyword_text="family dinner",
                    updated_at=now,
                ),
                _private_search_document(
                    entity_type="meal_plan",
                    entity_id="private-plan",
                    user_id="user-other",
                    title_text="family dinner private plan",
                    keyword_text="family dinner",
                    updated_at=now + timedelta(minutes=1),
                ),
            ]
        )
        db.commit()

    with SessionLocal() as db:
        hits = search_keyword_documents(
            db,
            family_id="family-1",
            query="family dinner",
            scopes=["recipe", "meal_plan"],
            limit=1,
        )

    assert [(hit.entity_type, hit.entity_id) for hit in hits] == [("recipe", "family-recipe")]


def test_keyword_search_merges_fulltext_with_substring_fallback_for_short_chinese_query() -> None:
    assert _should_use_substring_fallback("油") is True
    hits = _merge_keyword_hits(
        [
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-oil",
                keyword_score=0.72,
                matched_fields=("title_text",),
                match_modes=(KeywordMatchMode.MYSQL_FULLTEXT,),
            )
        ],
        [
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-oil",
                keyword_score=1.0,
                matched_fields=("title_text",),
                match_modes=(KeywordMatchMode.SUBSTRING,),
            ),
            KeywordSearchHit(
                entity_type="ingredient",
                entity_id="ingredient-soy-sauce",
                keyword_score=1.0,
                matched_fields=("title_text",),
                match_modes=(KeywordMatchMode.SAFE_COMPACT,),
            ),
        ],
        limit=10,
    )

    assert [hit.entity_id for hit in hits] == ["ingredient-oil", "ingredient-soy-sauce"]
    assert all(hit.keyword_score == 1.0 for hit in hits)


def test_merge_keyword_hits_preserves_fields_and_all_match_modes() -> None:
    hits = _merge_keyword_hits(
        [KeywordSearchHit("ingredient", "chicken", 0.6, ("keyword_text",), (KeywordMatchMode.MYSQL_FULLTEXT,))],
        [KeywordSearchHit("ingredient", "chicken", 0.8, ("title_text",), (KeywordMatchMode.SAFE_COMPACT,))],
        limit=10,
    )

    assert hits == [
        KeywordSearchHit(
            "ingredient",
            "chicken",
            0.8,
            ("title_text", "keyword_text"),
            (KeywordMatchMode.MYSQL_FULLTEXT, KeywordMatchMode.SAFE_COMPACT),
        )
    ]


def test_compact_matcher_joins_only_single_cjk_keyword_tokens() -> None:
    safe = SearchDocument(
        id="doc-safe", family_id="family-1", entity_type="ingredient", entity_id="safe",
        title_text="冷冻肉块", keyword_text="鸡 肉 肉类", detail_text="", semantic_text="食材", metadata_json={},
        content_hash="safe", document_builder_version="v1",
    )
    unsafe = SearchDocument(
        id="doc-unsafe", family_id="family-1", entity_type="ingredient", entity_id="unsafe",
        title_text="三黄鸡", keyword_text="三黄鸡 肉类", detail_text="", semantic_text="食材", metadata_json={},
        content_hash="unsafe", document_builder_version="v1",
    )

    assert _compact_matched_fields(safe, "鸡肉") == ["keyword_text"]
    assert _compact_matched_fields(unsafe, "鸡肉") == []


def test_single_cjk_compact_fallback_does_not_match_inside_multi_char_keyword() -> None:
    document = SearchDocument(
        id="doc-seasoning", family_id="family-1", entity_type="ingredient", entity_id="seasoning",
        title_text="盐", keyword_text="调味料", detail_text="常温放置", semantic_text="食材", metadata_json={},
        content_hash="seasoning", document_builder_version="v1",
    )

    assert _compact_matched_fields(document, "料") == []


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
        .params(family_id="family-1", user_id="user-1", scopes=["recipe", "meal_plan"], query="番茄", limit=10)
    )
    compiled = str(statement.compile(dialect=mysql.dialect(), compile_kwargs={"render_postcompile": True}))

    assert "MATCH(title_text) AGAINST" in compiled
    assert "MATCH(keyword_text) AGAINST" in compiled
    assert "MATCH(detail_text) AGAINST" in compiled
    assert "entity_type IN" in compiled
    assert "%s IS NOT NULL" in compiled
    assert "JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.user_id')) = %s" in compiled
    assert "* 0.55" in compiled
    assert "* 0.35" in compiled
    assert "* 0.10" in compiled
