from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import FoodType
from app.models.domain import Food, Ingredient, InventoryItem, MealLog, Recipe, SearchDocument
from app.services.clock import today_for_family
from app.services.ingredient_units import UnitConversionError
from app.services.inventory_usage import load_available_inventory_by_ingredient, recipe_availability_summary, remaining_quantity, tracks_quantity
from app.services.recipe_recommendations import recipe_recommendation_usage_maps
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.keyword_store import KeywordSearchHit, search_keyword_documents
from app.services.search.scoring import SearchBusinessSignals, score_search_candidate
from app.services.search.vector_store import VectorSearchHit, VectorStore, VectorStoreUnavailableError, build_vector_store

SEMANTIC_ONLY_MIN_SCORE_BY_TYPE = {
    "ingredient": 0.58,
    "food": 0.52,
    "recipe": 0.48,
}
DEFAULT_SEMANTIC_ONLY_MIN_SCORE = 0.52


@dataclass
class HybridSearchResult:
    entity_type: str
    entity_id: str
    score: float
    keyword_score: float = 0.0
    semantic_score: float = 0.0
    business_score: float = 0.0
    match_reason: list[str] = field(default_factory=list)


@dataclass
class HybridSearchResponse:
    items: list[HybridSearchResult]
    total: int
    query: str
    search_mode: str = "hybrid"
    degraded: bool = False


def hybrid_search(
    db: Session,
    *,
    family_id: str,
    query: str,
    scopes: list[str],
    limit: int,
    offset: int,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
) -> HybridSearchResponse:
    normalized_query = query.strip()
    if not normalized_query:
        return HybridSearchResponse(items=[], total=0, query=normalized_query, degraded=False)

    requested_window = offset + limit
    keyword_limit = max(80, requested_window * 4)
    semantic_limit = max(80, requested_window * 4)
    keyword_hits = search_keyword_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=keyword_limit,
    )

    degraded = False
    semantic_hits: list[VectorSearchHit] = []
    embedding_client = embedding_client or build_embedding_client()
    vector_store = vector_store or build_vector_store()
    try:
        query_vector = embedding_client.embed_text(normalized_query)
        semantic_hits = vector_store.search(
            family_id=family_id,
            scopes=scopes,
            vector=query_vector,
            limit=semantic_limit,
        )
    except (EmbeddingUnavailableError, VectorStoreUnavailableError):
        degraded = True

    merged = _merge_hits(
        db,
        family_id=family_id,
        query=normalized_query,
        keyword_hits=keyword_hits,
        semantic_hits=semantic_hits,
    )
    paged = merged[offset : offset + limit]
    return HybridSearchResponse(
        items=paged,
        total=len(merged),
        query=normalized_query,
        degraded=degraded,
    )


def _merge_hits(
    db: Session,
    *,
    family_id: str,
    query: str,
    keyword_hits: list[KeywordSearchHit],
    semantic_hits: list[VectorSearchHit],
) -> list[HybridSearchResult]:
    by_key: dict[tuple[str, str], HybridSearchResult] = {}
    keyword_by_key = {(hit.entity_type, hit.entity_id): hit for hit in keyword_hits}
    for hit in keyword_hits:
        by_key[(hit.entity_type, hit.entity_id)] = HybridSearchResult(
            entity_type=hit.entity_type,
            entity_id=hit.entity_id,
            score=0,
            keyword_score=hit.keyword_score,
        )
    for hit in semantic_hits:
        key = (hit.entity_type, hit.entity_id)
        min_semantic_score = SEMANTIC_ONLY_MIN_SCORE_BY_TYPE.get(hit.entity_type, DEFAULT_SEMANTIC_ONLY_MIN_SCORE)
        if key not in keyword_by_key and hit.semantic_score < min_semantic_score:
            continue
        result = by_key.get(key)
        if result is None:
            result = HybridSearchResult(
                entity_type=hit.entity_type,
                entity_id=hit.entity_id,
                score=0,
            )
            by_key[key] = result
        result.semantic_score = max(result.semantic_score, hit.semantic_score)

    metadata_by_key = _load_candidate_metadata(db, family_id=family_id, keys=list(by_key))
    by_key = {key: result for key, result in by_key.items() if key in metadata_by_key}
    existing_keys = _load_existing_business_keys(db, family_id=family_id, keys=list(by_key))
    by_key = {key: result for key, result in by_key.items() if key in existing_keys}
    business_signals_by_key = _load_business_signals(db, family_id=family_id, keys=list(by_key))
    for key, result in by_key.items():
        score = score_search_candidate(
            entity_type=result.entity_type,
            query=query,
            keyword_score=result.keyword_score,
            semantic_score=result.semantic_score,
            keyword_hit=keyword_by_key.get(key),
            metadata=metadata_by_key.get(key),
            business_signals=business_signals_by_key.get(key),
        )
        result.score = score.final_score
        result.business_score = score.business_score
        result.match_reason = score.reasons
    return sorted(by_key.values(), key=lambda item: (-item.score, item.entity_type, item.entity_id))


def _load_candidate_metadata(
    db: Session,
    *,
    family_id: str,
    keys: list[tuple[str, str]],
) -> dict[tuple[str, str], dict[str, object]]:
    if not keys:
        return {}
    conditions = [
        (SearchDocument.entity_type == entity_type) & (SearchDocument.entity_id == entity_id)
        for entity_type, entity_id in keys
    ]
    documents = db.scalars(
        select(SearchDocument).where(
            SearchDocument.family_id == family_id,
            or_(*conditions),
        )
    )
    return {
        (document.entity_type, document.entity_id): document.metadata_json or {}
        for document in documents
    }


def _load_existing_business_keys(
    db: Session,
    *,
    family_id: str,
    keys: list[tuple[str, str]],
) -> set[tuple[str, str]]:
    if not keys:
        return set()
    ingredient_ids = [entity_id for entity_type, entity_id in keys if entity_type == "ingredient"]
    food_ids = [entity_id for entity_type, entity_id in keys if entity_type == "food"]
    recipe_ids = [entity_id for entity_type, entity_id in keys if entity_type == "recipe"]
    existing: set[tuple[str, str]] = set()
    if ingredient_ids:
        existing.update(
            ("ingredient", entity_id)
            for entity_id in db.scalars(
                select(Ingredient.id).where(Ingredient.family_id == family_id, Ingredient.id.in_(ingredient_ids))
            )
        )
    if food_ids:
        existing.update(
            ("food", entity_id)
            for entity_id in db.scalars(
                select(Food.id).where(Food.family_id == family_id, Food.id.in_(food_ids))
            )
        )
    if recipe_ids:
        existing.update(
            ("recipe", entity_id)
            for entity_id in db.scalars(
                select(Recipe.id).where(Recipe.family_id == family_id, Recipe.id.in_(recipe_ids))
            )
        )
    return existing


def _load_business_signals(
    db: Session,
    *,
    family_id: str,
    keys: list[tuple[str, str]],
) -> dict[tuple[str, str], SearchBusinessSignals]:
    recipe_ids = [entity_id for entity_type, entity_id in keys if entity_type == "recipe"]
    food_ids = [entity_id for entity_type, entity_id in keys if entity_type == "food"]
    ingredient_ids = [entity_id for entity_type, entity_id in keys if entity_type == "ingredient"]
    if not recipe_ids and not food_ids and not ingredient_ids:
        return {}
    today = today_for_family(family_id)
    signals: dict[tuple[str, str], SearchBusinessSignals] = {}
    if ingredient_ids:
        signals.update(_load_ingredient_business_signals(db, family_id=family_id, ingredient_ids=ingredient_ids, today=today))
    if food_ids:
        signals.update(_load_food_business_signals(db, family_id=family_id, food_ids=food_ids, today=today))
    if not recipe_ids:
        return signals
    recipes = list(
        db.scalars(
            select(Recipe)
            .where(Recipe.family_id == family_id, Recipe.id.in_(recipe_ids))
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.cook_logs))
        )
    )
    if not recipes:
        return signals
    ingredient_ids = [item.ingredient_id for recipe in recipes for item in recipe.ingredient_items if item.ingredient_id]
    inventory_by_ingredient = load_available_inventory_by_ingredient(db, family_id=family_id, ingredient_ids=ingredient_ids, today=today)
    availability_by_id: dict[str, dict] = {}
    for recipe in recipes:
        try:
            availability_by_id[recipe.id] = recipe_availability_summary(
                db,
                family_id=family_id,
                recipe=recipe,
                today=today,
                inventory_by_ingredient=inventory_by_ingredient,
            )
        except UnitConversionError:
            continue
    foods = list(db.scalars(select(Food).where(Food.family_id == family_id)))
    meal_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == family_id)
            .options(selectinload(MealLog.food_entries))
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    _, last_used_at = recipe_recommendation_usage_maps(recipes=recipes, meal_logs=meal_logs, foods=foods, today=today)
    for recipe in recipes:
        availability = availability_by_id.get(recipe.id)
        last_used = last_used_at.get(recipe.id)
        signals[("recipe", recipe.id)] = SearchBusinessSignals(
            availability=str(availability.get("availability")) if availability else None,
            availability_score=float(availability.get("availability_score", 0)) if availability else None,
            days_since_used=(today - last_used).days if last_used is not None else None,
            never_used=last_used is None,
        )
    return signals


def _load_ingredient_business_signals(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: list[str],
    today,
) -> dict[tuple[str, str], SearchBusinessSignals]:
    ingredients = list(db.scalars(select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id.in_(ingredient_ids))))
    if not ingredients:
        return {}
    inventory_by_ingredient = load_available_inventory_by_ingredient(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient.id for ingredient in ingredients],
        today=today,
    )
    signals: dict[tuple[str, str], SearchBusinessSignals] = {}
    for ingredient in ingredients:
        available_items = inventory_by_ingredient.get(ingredient.id, [])
        signals[("ingredient", ingredient.id)] = SearchBusinessSignals(
            inventory_available=bool(available_items),
            days_until_expiry=_nearest_expiry_days(available_items, today=today),
            low_stock=_has_low_stock_item(ingredient, available_items),
        )
    return signals


def _load_food_business_signals(
    db: Session,
    *,
    family_id: str,
    food_ids: list[str],
    today,
) -> dict[tuple[str, str], SearchBusinessSignals]:
    foods = list(
        db.scalars(
            select(Food)
            .where(Food.family_id == family_id, Food.id.in_(food_ids))
            .options(selectinload(Food.recipe).selectinload(Recipe.ingredient_items), selectinload(Food.recipe).selectinload(Recipe.cook_logs))
        )
    )
    if not foods:
        return {}
    meal_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == family_id)
            .options(selectinload(MealLog.food_entries))
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    target_meal_type = _target_meal_type_from_recent_logs(meal_logs, today=today)
    recipe_availability_by_id: dict[str, dict] = {}
    recipes = [food.recipe for food in foods if food.recipe is not None]
    if recipes:
        ingredient_ids = [item.ingredient_id for recipe in recipes for item in recipe.ingredient_items if item.ingredient_id]
        inventory_by_ingredient = load_available_inventory_by_ingredient(db, family_id=family_id, ingredient_ids=ingredient_ids, today=today)
        for recipe in recipes:
            try:
                recipe_availability_by_id[recipe.id] = recipe_availability_summary(
                    db,
                    family_id=family_id,
                    recipe=recipe,
                    today=today,
                    inventory_by_ingredient=inventory_by_ingredient,
                )
            except UnitConversionError:
                continue
    signals = {}
    for food in foods:
        days_since_used = _days_since_food_used(food.id, meal_logs, today=today)
        availability = recipe_availability_by_id.get(food.recipe.id, {}).get("availability") if food.recipe is not None else None
        signals[("food", food.id)] = SearchBusinessSignals(
            availability=str(availability) if availability else None,
            days_since_used=days_since_used,
            never_used=days_since_used is None,
            target_meal_type=target_meal_type,
            inventory_available=_food_inventory_available(food),
            days_until_expiry=(food.expiry_date - today).days if food.expiry_date is not None else None,
        )
    return signals


def _nearest_expiry_days(items: list[InventoryItem], *, today) -> int | None:
    expiry_days = [(item.expiry_date - today).days for item in items if item.expiry_date is not None]
    return min(expiry_days) if expiry_days else None


def _has_low_stock_item(ingredient: Ingredient, items: list[InventoryItem]) -> bool:
    if not tracks_quantity(ingredient):
        return False
    for item in items:
        threshold = item.low_stock_threshold
        if threshold is not None and threshold > 0 and remaining_quantity(item) <= threshold:
            return True
    return False


def _food_inventory_available(food: Food) -> bool | None:
    food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
    if food_type not in {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}:
        return None
    if food.stock_quantity is None:
        return None
    return food.stock_quantity > 0


def _days_since_food_used(food_id: str, meal_logs: list[MealLog], *, today) -> int | None:
    last_used = None
    for log in meal_logs:
        if any(entry.food_id == food_id for entry in log.food_entries):
            if last_used is None or log.date > last_used:
                last_used = log.date
    return (today - last_used).days if last_used is not None else None


def _target_meal_type_from_recent_logs(meal_logs: list[MealLog], *, today) -> str:
    logged_today = {str(log.meal_type.value if hasattr(log.meal_type, "value") else log.meal_type) for log in meal_logs if log.date == today}
    for meal_type in ("breakfast", "lunch", "dinner", "snack"):
        if meal_type not in logged_today:
            return meal_type
    return "snack"
