from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import Difficulty, FoodType, IngredientExpiryMode, InventoryStatus, MealType
from app.models.domain import Base, Family, Food, Ingredient, InventoryItem, MealLog, MealLogFood, Recipe, RecipeIngredient
from app.services.search.documents import SearchDocumentPayload
from app.services.search.hybrid import hybrid_search
from app.services.search.indexing import upsert_search_document
from app.services.search.vector_store import VectorSearchHit


@dataclass
class FakeEmbeddingClient:
    model: str = "fake"
    dimensions: int = 2

    def embed_text(self, text: str) -> list[float]:
        del text
        return [0.1, 0.2]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2] for _ in texts]


class FakeVectorStore:
    def __init__(self, hits: list[VectorSearchHit]) -> None:
        self.hits = hits

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, vector
        return [hit for hit in self.hits if hit.entity_type in scopes][:limit]


def _session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)


def test_hybrid_search_merges_keyword_and_semantic_hits() -> None:
    SessionLocal = _session_factory()
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


def test_hybrid_search_drops_semantic_hits_without_current_search_document() -> None:
    SessionLocal = _session_factory()
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
    SessionLocal = _session_factory()
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


def test_hybrid_search_drops_hits_without_business_entity() -> None:
    SessionLocal = _session_factory()
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
    SessionLocal = _session_factory()
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
    SessionLocal = _session_factory()
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
            expiry_date=date.today(),
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
            expiry_date=date.today(),
        )
        meal_log = MealLog(
            id="meal-recent",
            family_id=family.id,
            date=date.today(),
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
    SessionLocal = _session_factory()
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
