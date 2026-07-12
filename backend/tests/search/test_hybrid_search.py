from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.core.enums import (
    Difficulty,
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryStatus,
    MealType,
)
from app.models.domain import (
    Family,
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    MealLog,
    MealLogFood,
    Recipe,
    RecipeIngredient,
    SearchDocument,
)
from app.services.search.documents import SearchDocumentPayload
from app.services.search import hybrid as hybrid_module
from app.services.search.hybrid import MAX_RERANK_DOCUMENT_CHARS, _rerank_document_texts, hybrid_search
from app.services.search.indexing import upsert_search_document
from app.services.search.rerank import RerankResult
from app.services.search.vector_store import VectorSearchHit
from app.services.clock import today_for_family
from tests.search._support import ExplodingEmbeddingClient, ExplodingVectorStore, FakeEmbeddingClient, FakeRerankClient, FakeVectorStore, search_settings, session_factory


def test_rerank_document_texts_preserve_priority_fields_before_truncating_long_fields() -> None:
    long_detail = "；".join([f"细节{i}" for i in range(800)])
    long_semantic = "。".join([f"语义{i}" for i in range(800)])
    document = SearchDocument(
        id="search-doc-long",
        family_id="family-1",
        entity_type="ingredient",
        entity_id="ingredient-chicken",
        title_text="三黄鸡",
        keyword_text="三黄鸡 鸡肉 肉类 冷藏",
        detail_text=long_detail,
        semantic_text=long_semantic,
        metadata_json={},
        content_hash="hash-long",
        document_builder_version="v1",
    )

    name_text, full_text = _rerank_document_texts(document)

    assert name_text == "类型：食材\n名称：三黄鸡"
    assert len(full_text) <= MAX_RERANK_DOCUMENT_CHARS
    assert "类型：食材" in full_text
    assert "名称：三黄鸡" in full_text
    assert "关键词：三黄鸡 鸡肉 肉类 冷藏" in full_text
    assert full_text.endswith("…")


def test_hybrid_search_merges_keyword_and_semantic_hits() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Recipe(
                    id="recipe-keyword",
                    family_id="family-1",
                    title="番茄鸡蛋汤",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                ),
                Recipe(
                    id="recipe-semantic",
                    family_id="family-1",
                    title="清淡快手面",
                    servings=1,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                ),
            ]
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-keyword",
                title_text="番茄鸡蛋汤",
                keyword_text="番茄 鸡蛋 晚餐",
                detail_text="清淡",
                semantic_text="菜谱：番茄鸡蛋汤",
                metadata_json={},
                content_hash="hash-1",
            ),
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-semantic",
                title_text="清淡快手面",
                keyword_text="面 早餐",
                detail_text="",
                semantic_text="菜谱：清淡快手面",
                metadata_json={"prep_minutes": 12, "difficulty": "easy", "scene_tags": ["番茄"]},
                content_hash="hash-2",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-keyword", semantic_score=0.86, semantic_rank=1),
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-semantic", semantic_score=0.9, semantic_rank=2),
                ]
            ),
        )

    assert response.degraded is False
    ids = [item.entity_id for item in response.items]
    assert "recipe-keyword" in ids
    assert "recipe-semantic" in ids
    keyword_item = next(item for item in response.items if item.entity_id == "recipe-keyword")
    assert keyword_item.keyword_score > 0
    assert keyword_item.semantic_score == 0.86
    assert any(reason.startswith("语意接近") for reason in keyword_item.match_reason)
    semantic_item = next(item for item in response.items if item.entity_id == "recipe-semantic")
    assert semantic_item.business_score > 0
    assert "适合番茄" in semantic_item.match_reason


def test_hybrid_search_switch_disables_vector_and_rerank(monkeypatch) -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        ingredient = Ingredient(
            id="ingredient-tomato",
            family_id="family-1",
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text="番茄 蔬菜",
                detail_text="适合快手晚餐",
                semantic_text="食材：番茄",
                metadata_json={},
                content_hash="hash-ingredient",
            ),
        )
        db.commit()

    monkeypatch.setattr(
        hybrid_module,
        "get_settings",
        lambda: search_settings(search_hybrid_enabled=False),
    )

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=ExplodingEmbeddingClient(),
            vector_store=ExplodingVectorStore(),
            rerank_client=FakeRerankClient([RerankResult(index=0, relevance_score=1.0)]),
        )

    assert response.search_mode == "keyword"
    assert response.degraded is False
    assert [item.entity_id for item in response.items] == ["ingredient-tomato"]
    assert response.items[0].semantic_score == 0


def test_hybrid_search_prioritizes_exact_name_over_high_semantic_hit() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        exact = Ingredient(
            id="ingredient-exact",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        semantic = Ingredient(
            id="ingredient-semantic",
            family_id=family.id,
            name="西红柿罐头",
            category="罐头",
            default_unit="罐",
            unit_conversions=[],
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add_all([family, exact, semantic])
        db.flush()
        for ingredient in (exact, semantic):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id=family.id,
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=ingredient.category,
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}",
                    metadata_json={},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-semantic", semantic_score=0.99, semantic_rank=1),
                ]
            ),
        )

    assert [item.entity_id for item in response.items][:2] == ["ingredient-exact", "ingredient-semantic"]
    assert response.items[0].exact_name_match is True
    assert response.items[0].match_reason[:1] == ["名称匹配"]


def test_hybrid_search_includes_exact_name_without_search_document() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        ingredient = Ingredient(
            id="ingredient-chicken",
            family_id=family.id,
            name="鸡",
            category="禽肉",
            default_unit="克",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add_all([family, ingredient])
        db.commit()

    original_search_keyword_documents = hybrid_module.search_keyword_documents
    hybrid_module.search_keyword_documents = lambda *args, **kwargs: []
    try:
        with SessionLocal() as db:
            response = hybrid_search(
                db,
                family_id="family-1",
                query="鸡",
                scopes=["ingredient"],
                limit=10,
                offset=0,
                embedding_client=FakeEmbeddingClient(),
                vector_store=FakeVectorStore([]),
            )
    finally:
        hybrid_module.search_keyword_documents = original_search_keyword_documents

    assert response.total == 1
    assert response.items[0].entity_id == "ingredient-chicken"
    assert response.items[0].exact_name_match is True


def test_hybrid_search_drops_exact_name_hits_without_business_entity() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="ingredient-missing",
                title_text="番茄",
                keyword_text="蔬菜",
                detail_text="",
                semantic_text="食材：番茄",
                metadata_json={},
                content_hash="hash-missing",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert response.total == 0
    assert response.items == []


def test_hybrid_search_drops_semantic_hits_without_current_search_document() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add(
            Recipe(
                id="recipe-kept",
                family_id="family-1",
                title="番茄鸡蛋汤",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=[],
            )
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-kept",
                title_text="番茄鸡蛋汤",
                keyword_text="番茄 鸡蛋 晚餐",
                detail_text="",
                semantic_text="菜谱：番茄鸡蛋汤",
                metadata_json={},
                content_hash="hash-kept",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="清淡晚饭",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-kept", semantic_score=0.91, semantic_rank=1),
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-stale", semantic_score=0.99, semantic_rank=2),
                ]
            ),
        )

    assert response.total == 1
    assert [item.entity_id for item in response.items] == ["recipe-kept"]


def test_hybrid_search_drops_weak_semantic_only_hits() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Recipe(
                    id="recipe-relevant",
                    family_id="family-1",
                    title="番茄鸡蛋汤",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                ),
                Recipe(
                    id="recipe-weak",
                    family_id="family-1",
                    title="盒装牛奶",
                    servings=1,
                    prep_minutes=1,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                ),
            ]
        )
        db.flush()
        for recipe in db.scalars(select(Recipe)):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id="family-1",
                    entity_type="recipe",
                    entity_id=recipe.id,
                    title_text=recipe.title,
                    keyword_text=recipe.title,
                    detail_text="",
                    semantic_text=f"菜谱：{recipe.title}",
                    metadata_json={},
                    content_hash=f"hash-{recipe.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="西红柿",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-relevant", semantic_score=0.56, semantic_rank=1),
                    VectorSearchHit(entity_type="recipe", entity_id="recipe-weak", semantic_score=0.38, semantic_rank=2),
                ]
            ),
        )

    assert response.total == 1
    assert [item.entity_id for item in response.items] == ["recipe-relevant"]


def test_hybrid_search_keeps_lower_confidence_ingredient_semantic_hits() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Ingredient(
                    id="ingredient-kept",
                    family_id="family-1",
                    name="西红柿",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-weak",
                    family_id="family-1",
                    name="盒装牛奶",
                    category="乳制品",
                    default_unit="盒",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
            ]
        )
        db.flush()
        for ingredient in db.scalars(select(Ingredient)):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id="family-1",
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=ingredient.category,
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}",
                    metadata_json={},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-kept", semantic_score=0.50, semantic_rank=1),
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-weak", semantic_score=0.38, semantic_rank=2),
                ]
            ),
        )

    assert response.total == 1
    assert [item.entity_id for item in response.items] == ["ingredient-kept"]


def test_hybrid_search_reranks_keyword_and_semantic_candidates() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Ingredient(
                    id="ingredient-keyword",
                    family_id="family-1",
                    name="冷冻鸡肉块",
                    category="肉类",
                    default_unit="克",
                    unit_conversions=[],
                    default_storage="冷冻",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-semantic",
                    family_id="family-1",
                    name="三黄鸡",
                    category="肉类",
                    default_unit="只",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-egg",
                    family_id="family-1",
                    name="鸡蛋",
                    category="蛋奶",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-weak",
                    family_id="family-1",
                    name="青椒",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
            ]
        )
        db.flush()
        for ingredient in db.scalars(select(Ingredient)):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id="family-1",
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=f"{ingredient.name} {ingredient.category}",
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}；分类：{ingredient.category}",
                    metadata_json={},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    reranker = FakeRerankClient(
        [
            RerankResult(index=0, relevance_score=0.95),
            RerankResult(index=2, relevance_score=0.80),
            RerankResult(index=4, relevance_score=0.20),
        ]
    )
    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡肉",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-semantic", semantic_score=0.84, semantic_rank=1),
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-egg", semantic_score=0.76, semantic_rank=2),
                    VectorSearchHit(entity_type="ingredient", entity_id="ingredient-weak", semantic_score=0.30, semantic_rank=3),
                ]
            ),
            rerank_client=reranker,
        )

    assert response.degraded is False
    assert [item.entity_id for item in response.items] == ["ingredient-semantic", "ingredient-keyword"]
    assert len(reranker.documents) == 6
    assert all(len(document) <= 2048 for document in reranker.documents)
    assert "青椒" not in "\n".join(reranker.documents)
    assert response.items[0].score > response.items[1].score


def test_hybrid_search_keeps_literal_fallback_after_rerank_matches() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Ingredient(
                    id="ingredient-rerank",
                    family_id="family-1",
                    name="三黄鸡",
                    category="肉类",
                    default_unit="只",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-literal",
                    family_id="family-1",
                    name="冷冻鸡肉块",
                    category="肉类",
                    default_unit="克",
                    unit_conversions=[],
                    default_storage="冷冻",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
            ]
        )
        db.flush()
        for ingredient in db.scalars(select(Ingredient)):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id="family-1",
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=f"{ingredient.name} {ingredient.category}",
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}",
                    metadata_json={"name": ingredient.name, "category": ingredient.category},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡肉",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [VectorSearchHit(entity_type="ingredient", entity_id="ingredient-rerank", semantic_score=0.90, semantic_rank=1)]
            ),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.92),
                    RerankResult(index=1, relevance_score=0.92),
                    RerankResult(index=2, relevance_score=0.20),
                    RerankResult(index=3, relevance_score=0.20),
                ]
            ),
        )

    assert [item.entity_id for item in response.items] == ["ingredient-rerank", "ingredient-literal"]
    assert response.items[0].score > response.items[1].score
    assert response.items[1].match_reason[0] == "名称包含"


def test_hybrid_search_keeps_double_character_literal_hit_with_low_rerank() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        ingredient = Ingredient(
            id="ingredient-chicken",
            family_id="family-1",
            name="冷冻鸡肉块",
            category="肉类",
            default_unit="克",
            unit_conversions=[],
            default_storage="冷冻",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text=f"{ingredient.name} {ingredient.category}",
                detail_text="",
                semantic_text=f"食材：{ingredient.name}",
                metadata_json={"name": ingredient.name, "category": ingredient.category},
                content_hash="hash-chicken",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡肉",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.20),
                    RerankResult(index=1, relevance_score=0.20),
                ]
            ),
        )

    assert response.total == 1
    assert response.items[0].entity_id == "ingredient-chicken"
    assert response.items[0].match_reason[0] == "名称包含"


def test_hybrid_search_uses_single_character_title_contains_as_literal_fallback() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        ingredient = Ingredient(
            id="ingredient-oil",
            family_id="family-1",
            name="食用油",
            category="调味料",
            default_unit="瓶",
            unit_conversions=[],
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text=f"{ingredient.name} {ingredient.category}",
                detail_text="",
                semantic_text=f"食材：{ingredient.name}",
                metadata_json={"name": ingredient.name, "category": ingredient.category},
                content_hash="hash-oil",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="油",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.57),
                    RerankResult(index=1, relevance_score=0.57),
                ]
            ),
        )

    assert response.total == 1
    assert response.items[0].entity_id == "ingredient-oil"
    assert response.items[0].match_reason[0] == "名称包含"


def test_hybrid_search_does_not_use_single_character_keyword_as_literal_fallback() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        ingredient = Ingredient(
            id="ingredient-seasoning",
            family_id="family-1",
            name="盐",
            category="调味料",
            default_unit="克",
            unit_conversions=[],
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text=f"{ingredient.name} {ingredient.category}",
                detail_text="",
                semantic_text=f"食材：{ingredient.name}",
                metadata_json={"name": ingredient.name, "category": ingredient.category},
                content_hash="hash-seasoning",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="料",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.57),
                    RerankResult(index=1, relevance_score=0.57),
                ]
            ),
        )

    assert response.total == 0
    assert response.items == []


def test_hybrid_search_matches_compact_keyword_text_for_literal_fallback() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        ingredient = Ingredient(
            id="ingredient-spaced-keyword",
            family_id="family-1",
            name="冷冻肉块",
            category="肉类",
            default_unit="克",
            unit_conversions=[],
            default_storage="冷冻",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add(ingredient)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text="鸡 肉 肉类",
                detail_text="",
                semantic_text=f"食材：{ingredient.name}",
                metadata_json={"name": ingredient.name, "category": ingredient.category},
                content_hash="hash-spaced-keyword",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡肉",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.20),
                    RerankResult(index=1, relevance_score=0.20),
                ]
            ),
        )

    assert response.total == 1
    assert response.items[0].entity_id == "ingredient-spaced-keyword"
    assert response.items[0].match_reason[0] == "关键词匹配"


def test_hybrid_search_does_not_use_detail_text_as_literal_fallback() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        recipe = Recipe(
            id="recipe-detail",
            family_id="family-1",
            title="番茄汤",
            servings=2,
            prep_minutes=12,
            difficulty=Difficulty.EASY,
            tips="快手晚餐",
            scene_tags=[],
        )
        db.add(recipe)
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id=recipe.id,
                title_text=recipe.title,
                keyword_text=recipe.title,
                detail_text="适合快手晚餐",
                semantic_text=f"菜谱：{recipe.title}",
                metadata_json={"title": recipe.title, "scene_tags": [], "ingredient_names": []},
                content_hash="hash-detail",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="快手",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
            rerank_client=FakeRerankClient(
                [
                    RerankResult(index=0, relevance_score=0.57),
                    RerankResult(index=1, relevance_score=0.57),
                ]
            ),
        )

    assert response.total == 0
    assert response.items == []


def test_hybrid_search_keeps_exact_name_before_reranked_candidates() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        exact = Ingredient(
            id="ingredient-exact",
            family_id=family.id,
            name="鸡",
            category="肉类",
            default_unit="只",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        semantic = Ingredient(
            id="ingredient-semantic",
            family_id=family.id,
            name="三黄鸡",
            category="肉类",
            default_unit="只",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add_all([family, exact, semantic])
        db.flush()
        for ingredient in (exact, semantic):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id=family.id,
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=ingredient.category,
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}",
                    metadata_json={},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [VectorSearchHit(entity_type="ingredient", entity_id="ingredient-semantic", semantic_score=0.99, semantic_rank=1)]
            ),
            rerank_client=FakeRerankClient([RerankResult(index=0, relevance_score=0.99)]),
        )

    assert [item.entity_id for item in response.items] == ["ingredient-exact", "ingredient-semantic"]
    assert response.items[0].exact_name_match is True


def test_hybrid_search_falls_back_when_rerank_fails() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        db.add_all(
            [
                Ingredient(
                    id="ingredient-keyword",
                    family_id="family-1",
                    name="冷冻鸡肉块",
                    category="肉类",
                    default_unit="克",
                    unit_conversions=[],
                    default_storage="冷冻",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
                Ingredient(
                    id="ingredient-semantic",
                    family_id="family-1",
                    name="三黄鸡",
                    category="肉类",
                    default_unit="只",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                ),
            ]
        )
        db.flush()
        for ingredient in db.scalars(select(Ingredient)):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id="family-1",
                    entity_type="ingredient",
                    entity_id=ingredient.id,
                    title_text=ingredient.name,
                    keyword_text=f"{ingredient.name} {ingredient.category}",
                    detail_text="",
                    semantic_text=f"食材：{ingredient.name}",
                    metadata_json={},
                    content_hash=f"hash-{ingredient.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="鸡肉",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore(
                [VectorSearchHit(entity_type="ingredient", entity_id="ingredient-semantic", semantic_score=0.70, semantic_rank=1)]
            ),
            rerank_client=FakeRerankClient(fail=True),
        )

    assert response.degraded is True
    assert [item.entity_id for item in response.items] == ["ingredient-semantic", "ingredient-keyword"]


def test_hybrid_search_drops_hits_without_business_entity() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        recipe = Recipe(
            id="recipe-kept",
            family_id="family-1",
            title="番茄汤",
            servings=2,
            prep_minutes=12,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=[],
        )
        db.add(recipe)
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-kept",
                title_text="番茄汤",
                keyword_text="番茄",
                detail_text="",
                semantic_text="菜谱：番茄汤",
                metadata_json={},
                content_hash="hash-kept",
            ),
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-missing-entity",
                title_text="番茄旧菜谱",
                keyword_text="番茄",
                detail_text="",
                semantic_text="菜谱：番茄旧菜谱",
                metadata_json={},
                content_hash="hash-missing",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert response.total == 1
    assert [item.entity_id for item in response.items] == ["recipe-kept"]


def test_hybrid_search_adds_recipe_availability_business_signal() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        ingredient = Ingredient(
            id="ingredient-tomato",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        recipe = Recipe(
            id="recipe-ready",
            family_id=family.id,
            title="番茄汤",
            servings=2,
            prep_minutes=12,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=["晚餐"],
        )
        recipe.ingredient_items = [
            RecipeIngredient(
                id="recipe-ingredient-ready",
                recipe_id=recipe.id,
                ingredient_id=ingredient.id,
                ingredient_name="番茄",
                quantity=Decimal("1"),
                unit="个",
                note="",
                sort_order=0,
            )
        ]
        inventory = InventoryItem(
            id="inventory-tomato",
            family_id=family.id,
            ingredient_id=ingredient.id,
            quantity=Decimal("3"),
            consumed_quantity=Decimal("0"),
            unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date.today(),
            storage_location="冷藏",
            low_stock_threshold=Decimal("0"),
        )
        db.add_all([family, ingredient, recipe, inventory])
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id=family.id,
                entity_type="recipe",
                entity_id=recipe.id,
                title_text=recipe.title,
                keyword_text="番茄 晚餐",
                detail_text="",
                semantic_text="菜谱：番茄汤",
                metadata_json={"prep_minutes": 12, "difficulty": "easy", "scene_tags": ["晚餐"]},
                content_hash="hash-ready",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["recipe"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert response.items[0].entity_id == "recipe-ready"
    assert response.items[0].business_score >= 0.35
    assert "家里可做" in response.items[0].match_reason


def test_hybrid_search_adds_food_inventory_and_recent_usage_signals() -> None:
    SessionLocal = session_factory()
    family_today = today_for_family("family-1")
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        expiring = Food(
            id="food-expiring",
            family_id=family.id,
            name="早餐酸奶",
            type=FoodType.READY_MADE.value,
            category="乳制品",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["breakfast"],
            source_name="",
            purchase_source="",
            scene="早餐",
            notes="",
            routine_note="",
            stock_quantity=Decimal("2"),
            stock_unit="盒",
            expiry_date=family_today,
        )
        recent_missing = Food(
            id="food-recent",
            family_id=family.id,
            name="早餐面包",
            type=FoodType.READY_MADE.value,
            category="烘焙",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["breakfast"],
            source_name="",
            purchase_source="",
            scene="早餐",
            notes="",
            routine_note="",
            stock_quantity=Decimal("0"),
            stock_unit="个",
            expiry_date=family_today,
        )
        meal_log = MealLog(
            id="meal-recent",
            family_id=family.id,
            date=family_today,
            meal_type=MealType.BREAKFAST,
            participant_user_ids=[],
            notes="",
            mood="",
        )
        db.add_all([family, expiring, recent_missing, meal_log])
        db.flush()
        db.add(MealLogFood(id="meal-food-recent", meal_log_id=meal_log.id, food_id=recent_missing.id, servings=1, note=""))
        for food in (expiring, recent_missing):
            upsert_search_document(
                db,
                SearchDocumentPayload(
                    family_id=family.id,
                    entity_type="food",
                    entity_id=food.id,
                    title_text=food.name,
                    keyword_text="早餐",
                    detail_text="",
                    semantic_text=f"食物：{food.name}",
                    metadata_json={"suitable_meal_types": ["breakfast"]},
                    content_hash=f"hash-{food.id}",
                ),
            )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="早餐",
            scopes=["food"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert [item.entity_id for item in response.items] == ["food-expiring", "food-recent"]
    assert response.items[0].business_score > response.items[1].business_score
    assert "今天到期" in response.items[0].match_reason


def test_hybrid_search_adds_ingredient_inventory_signals() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        ingredient = Ingredient(
            id="ingredient-tomato",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        inventory = InventoryItem(
            id="inventory-tomato",
            family_id=family.id,
            ingredient_id=ingredient.id,
            quantity=Decimal("2"),
            consumed_quantity=Decimal("1"),
            unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date.today(),
            expiry_date=date.today() + timedelta(days=2),
            storage_location="冷藏",
            low_stock_threshold=Decimal("1"),
        )
        db.add_all([family, ingredient, inventory])
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id=family.id,
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text="番茄 蔬菜",
                detail_text="",
                semantic_text="食材：番茄",
                metadata_json={},
                content_hash="hash-ingredient",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="番茄",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert response.items[0].entity_id == "ingredient-tomato"
    assert response.items[0].business_score > 0.5
    assert "临期优先" in response.items[0].match_reason


def test_hybrid_search_marks_presence_low_state_as_low_stock() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        ingredient = Ingredient(
            id="ingredient-oyster-sauce",
            family_id=family.id,
            name="蚝油",
            category="调味",
            default_unit="瓶",
            unit_conversions=[],
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
        )
        state = IngredientInventoryState(
            id="inventory-state-oyster-sauce",
            family_id=family.id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.OPENED,
            storage_location="常温",
            notes="快用完了",
        )
        db.add_all([family, ingredient, state])
        db.flush()
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id=family.id,
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text="蚝油 调味 补货",
                detail_text="",
                semantic_text="食材：蚝油",
                metadata_json={},
                content_hash="hash-presence-ingredient",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        response = hybrid_search(
            db,
            family_id="family-1",
            query="补货",
            scopes=["ingredient"],
            limit=10,
            offset=0,
            embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([]),
        )

    assert [item.entity_id for item in response.items] == ["ingredient-oyster-sauce"]
    assert "低库存" in response.items[0].match_reason
