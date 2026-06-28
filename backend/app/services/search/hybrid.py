from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.enums import FoodType
from app.models.domain import Food, Ingredient, InventoryItem, MealLog, Recipe, SearchDocument
from app.services.clock import today_for_family
from app.services.ingredient_units import UnitConversionError
from app.services.inventory_usage import load_available_inventory_by_ingredient, recipe_availability_summary, remaining_quantity, tracks_quantity
from app.services.recipe_recommendations import recipe_recommendation_usage_maps
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.keyword_store import KeywordSearchHit, search_exact_name_documents, search_keyword_documents
from app.services.search.rerank import RerankClient, RerankUnavailableError, build_rerank_client
from app.services.search.scoring import SearchBusinessSignals, score_search_candidate
from app.services.search.vector_store import VectorSearchHit, VectorStore, VectorStoreUnavailableError, build_vector_store

DEFAULT_RERANK_SEMANTIC_MIN_SCORE = 0.48
DEFAULT_RERANK_MIN_SCORE = 0.58
DEFAULT_LITERAL_FALLBACK_MIN_SCORE = 0.70
DEFAULT_RERANK_CANDIDATE_LIMIT = 50
MAX_RERANK_DOCUMENT_CHARS = 2048


@dataclass
class HybridSearchResult:
    entity_type: str
    entity_id: str
    score: float
    keyword_score: float = 0.0
    semantic_score: float = 0.0
    business_score: float = 0.0
    exact_name_match: bool = False
    local_score: float = 0.0
    literal_score: float = 0.0
    literal_reason: str = ""
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
    rerank_client: RerankClient | None = None,
) -> HybridSearchResponse:
    normalized_query = query.strip()
    if not normalized_query:
        return HybridSearchResponse(items=[], total=0, query=normalized_query, degraded=False)

    settings = get_settings()
    requested_window = offset + limit
    keyword_limit = max(80, requested_window * 4)
    semantic_limit = max(80, requested_window * 4)
    hybrid_enabled = settings.search_hybrid_enabled
    exact_name_hits = search_exact_name_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=keyword_limit,
    )
    keyword_hits = search_keyword_documents(
        db,
        family_id=family_id,
        query=normalized_query,
        scopes=scopes,
        limit=keyword_limit,
    )

    degraded = False
    semantic_hits: list[VectorSearchHit] = []
    if hybrid_enabled:
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

    rerank_client = (rerank_client or build_rerank_client()) if hybrid_enabled else None
    merged, rerank_degraded = _merge_hits(
        db,
        family_id=family_id,
        query=normalized_query,
        exact_name_hits=exact_name_hits,
        keyword_hits=keyword_hits,
        semantic_hits=semantic_hits,
        rerank_client=rerank_client,
        rerank_semantic_min_score=settings.search_rerank_semantic_min_score or DEFAULT_RERANK_SEMANTIC_MIN_SCORE,
        rerank_min_score=settings.search_rerank_min_score or DEFAULT_RERANK_MIN_SCORE,
        literal_fallback_min_score=settings.search_literal_fallback_min_score or DEFAULT_LITERAL_FALLBACK_MIN_SCORE,
        rerank_candidate_limit=settings.search_rerank_candidate_limit or DEFAULT_RERANK_CANDIDATE_LIMIT,
    )
    degraded = degraded or rerank_degraded
    paged = merged[offset : offset + limit]
    return HybridSearchResponse(
        items=paged,
        total=len(merged),
        query=normalized_query,
        search_mode="hybrid" if hybrid_enabled else "keyword",
        degraded=degraded,
    )


def _merge_hits(
    db: Session,
    *,
    family_id: str,
    query: str,
    exact_name_hits: list[KeywordSearchHit],
    keyword_hits: list[KeywordSearchHit],
    semantic_hits: list[VectorSearchHit],
    rerank_client: RerankClient | None,
    rerank_semantic_min_score: float,
    rerank_min_score: float,
    literal_fallback_min_score: float,
    rerank_candidate_limit: int,
) -> tuple[list[HybridSearchResult], bool]:
    by_key: dict[tuple[str, str], HybridSearchResult] = {}
    exact_name_by_key = {(hit.entity_type, hit.entity_id): hit for hit in exact_name_hits}
    keyword_by_key = {(hit.entity_type, hit.entity_id): hit for hit in keyword_hits}
    for hit in exact_name_hits:
        by_key[(hit.entity_type, hit.entity_id)] = HybridSearchResult(
            entity_type=hit.entity_type,
            entity_id=hit.entity_id,
            score=0,
            keyword_score=hit.keyword_score,
            exact_name_match=True,
        )
    for hit in keyword_hits:
        key = (hit.entity_type, hit.entity_id)
        result = by_key.get(key)
        if result is None:
            by_key[key] = HybridSearchResult(
                entity_type=hit.entity_type,
                entity_id=hit.entity_id,
                score=0,
                keyword_score=hit.keyword_score,
            )
        else:
            result.keyword_score = max(result.keyword_score, hit.keyword_score)
    for hit in semantic_hits:
        key = (hit.entity_type, hit.entity_id)
        if key not in keyword_by_key and key not in exact_name_by_key and hit.semantic_score < rerank_semantic_min_score:
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

    documents_by_key = _load_candidate_documents(db, family_id=family_id, keys=list(by_key))
    by_key = {key: result for key, result in by_key.items() if key in documents_by_key or result.exact_name_match}
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
            exact_name_match=result.exact_name_match,
            metadata=(documents_by_key.get(key).metadata_json if key in documents_by_key else {}) or {},
            business_signals=business_signals_by_key.get(key),
        )
        result.score = score.final_score
        result.local_score = score.final_score
        result.business_score = score.business_score
        result.match_reason = score.reasons
        literal_score, literal_reason = _literal_fallback_score(
            query=query,
            document=documents_by_key.get(key),
        )
        result.literal_score = literal_score
        result.literal_reason = literal_reason
    return _sort_with_rerank(
        query=query,
        results=list(by_key.values()),
        documents_by_key=documents_by_key,
        rerank_client=rerank_client,
        rerank_min_score=rerank_min_score,
        literal_fallback_min_score=literal_fallback_min_score,
        rerank_candidate_limit=rerank_candidate_limit,
    )


def _load_candidate_documents(
    db: Session,
    *,
    family_id: str,
    keys: list[tuple[str, str]],
) -> dict[tuple[str, str], SearchDocument]:
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
        (document.entity_type, document.entity_id): document
        for document in documents
    }


def _sort_with_rerank(
    *,
    query: str,
    results: list[HybridSearchResult],
    documents_by_key: dict[tuple[str, str], SearchDocument],
    rerank_client: RerankClient | None,
    rerank_min_score: float,
    literal_fallback_min_score: float,
    rerank_candidate_limit: int,
) -> tuple[list[HybridSearchResult], bool]:
    local_sorted = sorted(
        results,
        key=lambda item: (-int(item.exact_name_match), -item.local_score, item.entity_type, item.entity_id),
    )
    if rerank_client is None or not rerank_client.enabled or not local_sorted:
        return local_sorted, False

    rerank_doc_keys: list[tuple[str, str]] = []
    rerank_documents: list[str] = []
    rerank_candidate_count = 0
    for result in local_sorted:
        if result.exact_name_match:
            continue
        key = (result.entity_type, result.entity_id)
        document = documents_by_key.get(key)
        if document is None:
            continue
        rerank_doc_keys.extend([key, key])
        rerank_documents.extend(_rerank_document_texts(document))
        rerank_candidate_count += 1
        if rerank_candidate_count >= rerank_candidate_limit:
            break
    if rerank_candidate_count <= 0:
        for result in local_sorted:
            if result.exact_name_match:
                result.score = round(3.0 + result.local_score, 6)
        return local_sorted, False

    try:
        rerank_results = rerank_client.rerank(query=query, documents=rerank_documents, top_n=len(rerank_documents))
    except RerankUnavailableError:
        return local_sorted, True

    rerank_scores: dict[tuple[str, str], float] = {}
    for item in rerank_results:
        if item.index >= len(rerank_doc_keys):
            continue
        key = rerank_doc_keys[item.index]
        rerank_scores[key] = max(rerank_scores.get(key, 0.0), item.relevance_score)

    def result_bucket(item: HybridSearchResult) -> int | None:
        key = (item.entity_type, item.entity_id)
        if item.exact_name_match:
            item.score = round(3.0 + item.local_score, 6)
            return 0
        rerank_score = rerank_scores.get(key, 0.0)
        if rerank_score >= rerank_min_score:
            item.score = round(2.0 + rerank_score, 6)
            return 1
        if item.literal_score >= literal_fallback_min_score:
            item.score = round(1.0 + item.literal_score, 6)
            if item.literal_reason and item.literal_reason not in item.match_reason:
                item.match_reason = [item.literal_reason, *item.match_reason][:3]
            return 2
        return None

    bucket_by_key: dict[tuple[str, str], int] = {}
    filtered_results: list[HybridSearchResult] = []
    for item in results:
        bucket = result_bucket(item)
        if bucket is None:
            continue
        bucket_by_key[(item.entity_type, item.entity_id)] = bucket
        filtered_results.append(item)

    def sort_key(item: HybridSearchResult) -> tuple[int, float, float, str, str]:
        bucket = bucket_by_key[(item.entity_type, item.entity_id)]
        return (bucket, -item.score, -item.local_score, item.entity_type, item.entity_id)

    return sorted(filtered_results, key=sort_key), False


def _literal_fallback_score(*, query: str, document: SearchDocument | None) -> tuple[float, str]:
    if document is None:
        return 0.0, ""
    normalized_query = _normalize_literal_text(query)
    compact_query = _compact_literal_text(normalized_query)
    if not normalized_query or not compact_query:
        return 0.0, ""
    single_cjk_query = _is_single_cjk_query(normalized_query)

    scores: list[tuple[float, str]] = []
    title = _normalize_literal_text(document.title_text)
    compact_title = _compact_literal_text(title)
    if compact_title.startswith(compact_query):
        scores.append((0.95, "名称包含"))
    elif compact_query in compact_title:
        scores.append((0.85, "名称包含"))
    if single_cjk_query:
        return _best_literal_score(scores)

    keyword_values = _literal_keyword_values(document)
    for value, reason in keyword_values:
        normalized_value = _normalize_literal_text(value)
        if not normalized_value:
            continue
        compact_value = _compact_literal_text(normalized_value)
        tokens = set(normalized_value.split())
        if normalized_query in tokens:
            scores.append((0.80, reason))
        elif compact_query in compact_value:
            scores.append((0.70, reason))

    return _best_literal_score(scores)


def _best_literal_score(scores: list[tuple[float, str]]) -> tuple[float, str]:
    if not scores:
        return 0.0, ""
    scores.sort(key=lambda item: item[0], reverse=True)
    bonus = min(max(len(scores) - 1, 0) * 0.02, 0.05)
    return min(scores[0][0] + bonus, 1.0), scores[0][1]


def _literal_keyword_values(document: SearchDocument) -> list[tuple[str, str]]:
    metadata = document.metadata_json or {}
    values = [(document.keyword_text, "关键词匹配")]
    if document.entity_type == "ingredient":
        values.extend(_metadata_strings(metadata, {"name": "关键词匹配", "category": "分类匹配"}))
    elif document.entity_type == "food":
        values.extend(
            _metadata_strings(
                metadata,
                {
                    "name": "关键词匹配",
                    "category": "分类匹配",
                    "flavor_tags": "关键词匹配",
                    "scene_tags": "关键词匹配",
                    "suitable_meal_types": "关键词匹配",
                },
            )
        )
    elif document.entity_type == "recipe":
        values.extend(
            _metadata_strings(
                metadata,
                {
                    "title": "关键词匹配",
                    "scene_tags": "关键词匹配",
                    "ingredient_names": "食材匹配",
                },
            )
        )
    return values


def _metadata_strings(metadata: dict[str, object], reasons_by_key: dict[str, str]) -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []
    for key, reason in reasons_by_key.items():
        value = metadata.get(key)
        if isinstance(value, list):
            values.extend((str(item), reason) for item in value if str(item).strip())
        elif value is not None and str(value).strip():
            values.append((str(value), reason))
    return values


def _normalize_literal_text(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _compact_literal_text(value: object) -> str:
    return "".join(char for char in _normalize_literal_text(value) if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def _is_single_cjk_query(value: str) -> bool:
    return len(value) < 2 and any("\u4e00" <= char <= "\u9fff" for char in value)


def _rerank_document_texts(document: SearchDocument) -> list[str]:
    entity_label = {"ingredient": "食材", "food": "食物", "recipe": "菜谱"}.get(document.entity_type, document.entity_type)
    name_text = _build_limited_rerank_document(
        [
            ("类型", entity_label),
            ("名称", document.title_text),
        ]
    )
    parts = [
        ("类型", entity_label),
        ("名称", document.title_text),
        ("关键词", document.keyword_text),
        ("详情", document.detail_text),
        ("语义描述", document.semantic_text),
    ]
    full_text = _build_limited_rerank_document(parts)
    return [name_text, full_text]


def _build_limited_rerank_document(fields: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for label, raw_value in fields:
        value = str(raw_value or "").strip()
        if not value:
            continue
        prefix = f"{label}："
        separator_length = 1 if lines else 0
        remaining = MAX_RERANK_DOCUMENT_CHARS - len("\n".join(lines)) - separator_length
        if remaining <= len(prefix) + 1:
            break
        available_value_chars = remaining - len(prefix)
        if len(value) > available_value_chars:
            value = _truncate_rerank_field(value, available_value_chars)
        lines.append(f"{prefix}{value}")
    return "\n".join(lines)


def _truncate_rerank_field(value: str, max_chars: int) -> str:
    if max_chars <= 1:
        return "…"[:max_chars]
    if len(value) <= max_chars:
        return value
    boundary_limit = max_chars - 1
    boundary = max(
        value.rfind(separator, 0, boundary_limit)
        for separator in ("\n", "；", "。", "，", "、", " ")
    )
    if boundary >= max(12, boundary_limit // 2):
        return value[:boundary].rstrip() + "…"
    return value[:boundary_limit].rstrip() + "…"


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
