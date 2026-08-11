from __future__ import annotations

import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from time import perf_counter

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.enums import (
    FoodType,
    InventoryAvailabilityLevel,
    ModelUsageAttributionKind,
    ModelUsageOperationSource,
)
from app.core.utils import create_id
from app.models.domain import Food, FoodPlanItem, Ingredient, InventoryItem, MealLog, Recipe, SearchDocument
from app.services.clock import today_for_family
from app.services.ingredient_units import UnitConversionError
from app.services.ingredient_inventory_state import state_is_usable
from app.services.inventory_usage import (
    load_available_inventory_by_ingredient,
    load_presence_states_for_ingredients,
    recipe_availability_summary,
    remaining_quantity,
    tracks_quantity,
)
from app.services.model_usage.errors import ModelUsageError
from app.services.model_usage.types import UsageAttribution
from app.services.recipe_recommendations import recipe_recommendation_usage_maps
from app.services.search.embeddings import (
    EmbeddingClient,
    EmbeddingUnavailableError,
    MeteredEmbeddingResult,
    build_embedding_client,
)
from app.services.search.keyword_store import KeywordMatchMode, KeywordSearchHit, search_exact_name_documents, search_keyword_documents
from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import SearchQueryProfile, analyze_search_query
from app.services.search.ranking_features import SearchRankingCandidate, build_ranking_candidate
from app.services.search.rerank import RerankClient, RerankUnavailableError, build_rerank_client
from app.services.search.scoring import SearchBusinessSignals, business_score_candidates
from app.services.search.vector_store import VectorSearchHit, VectorStore, VectorStoreUnavailableError, build_vector_store

logger = logging.getLogger(__name__)

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
    degradation_code: str | None = None


@dataclass(frozen=True)
class HybridSearchDiagnostics:
    query_profile: str
    keyword_candidate_count: int
    semantic_candidate_count: int
    dual_source_count: int
    level_0_count: int
    level_1_count: int
    level_2_count: int
    level_3_count: int
    level_4_count: int
    local_ranking_duration_ms: float

    def as_log_fields(self, *, rerank_used: bool, degradation_code: str | None) -> dict[str, object]:
        return {
            "query_profile": self.query_profile,
            "keyword_candidate_count": self.keyword_candidate_count,
            "semantic_candidate_count": self.semantic_candidate_count,
            "dual_source_count": self.dual_source_count,
            "level_0_count": self.level_0_count,
            "level_1_count": self.level_1_count,
            "level_2_count": self.level_2_count,
            "level_3_count": self.level_3_count,
            "level_4_count": self.level_4_count,
            "local_ranking_duration_ms": round(self.local_ranking_duration_ms, 3),
            "rerank_used": rerank_used,
            "degradation_code": degradation_code,
        }


def hybrid_search(
    db: Session,
    *,
    family_id: str,
    user_id: str | None = None,
    query: str,
    scopes: list[str],
    limit: int,
    offset: int,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
    rerank_client: RerankClient | None = None,
) -> HybridSearchResponse:
    response_query = query.strip()
    profile = analyze_search_query(response_query)
    if not profile.compact_text:
        return HybridSearchResponse(items=[], total=0, query=response_query, degraded=False)
    recall_query = profile.normalized_text

    settings = get_settings()
    requested_window = offset + limit
    keyword_limit = max(80, requested_window * 4)
    semantic_limit = max(80, requested_window * 4)
    hybrid_enabled = settings.search_hybrid_enabled
    exact_name_hits = search_exact_name_documents(
        db,
        family_id=family_id,
        user_id=user_id,
        query=recall_query,
        scopes=scopes,
        limit=keyword_limit,
    )
    keyword_hits = search_keyword_documents(
        db,
        family_id=family_id,
        user_id=user_id,
        query=recall_query,
        scopes=scopes,
        limit=keyword_limit,
    )

    degraded = False
    degradation_code: str | None = None
    semantic_hits: list[VectorSearchHit] = []
    search_request_id = create_id("search-request") if hybrid_enabled else None
    if hybrid_enabled:
        embedding_client = embedding_client or build_embedding_client()
        vector_store = vector_store or build_vector_store()
        try:
            query_embedding = embedding_client.embed_text(
                recall_query,
                attribution=_query_usage_attribution(
                    family_id=family_id,
                    user_id=user_id,
                    logical_operation_id=search_request_id,
                ),
                attempt_key=f"{search_request_id}:embedding:query",
            )
            query_vector = _require_single_vector(query_embedding)
            semantic_hits = _search_vectors(
                vector_store=vector_store,
                family_id=family_id,
                user_id=user_id,
                scopes=scopes,
                vector=query_vector,
                limit=semantic_limit,
            )
        except ModelUsageError as exc:
            degraded = True
            degradation_code = exc.code
        except EmbeddingUnavailableError:
            degraded = True
            degradation_code = "search_embedding_unavailable"
        except VectorStoreUnavailableError:
            degraded = True
            degradation_code = "search_vector_unavailable"

    rerank_client = (rerank_client or build_rerank_client()) if hybrid_enabled else None
    rerank_attribution = (
        _query_usage_attribution(
            family_id=family_id,
            user_id=user_id,
            logical_operation_id=search_request_id,
        )
        if search_request_id is not None
        else None
    )
    local_results, documents_by_key, diagnostics = _merge_and_rank_hits(
        db,
        family_id=family_id,
        user_id=user_id,
        profile=profile,
        exact_name_hits=exact_name_hits,
        keyword_hits=keyword_hits,
        semantic_hits=semantic_hits,
        semantic_min_score=settings.search_semantic_min_score,
    )
    merged, rerank_degraded, rerank_degradation_code, rerank_used = _sort_with_rerank(
        query=recall_query,
        results=local_results,
        documents_by_key=documents_by_key,
        rerank_client=rerank_client,
        rerank_min_score=settings.search_rerank_min_score or DEFAULT_RERANK_MIN_SCORE,
        literal_fallback_min_score=settings.search_literal_fallback_min_score or DEFAULT_LITERAL_FALLBACK_MIN_SCORE,
        rerank_candidate_limit=settings.search_rerank_candidate_limit or DEFAULT_RERANK_CANDIDATE_LIMIT,
        rerank_attribution=rerank_attribution,
        rerank_attempt_key=f"{search_request_id}:rerank" if search_request_id is not None else None,
    )
    degraded = degraded or rerank_degraded
    if degradation_code is None and rerank_degradation_code is not None:
        degradation_code = rerank_degradation_code
    logger.info(
        "Hybrid search local ranking completed",
        extra={
            "search_diagnostics": diagnostics.as_log_fields(
                rerank_used=rerank_used,
                degradation_code=degradation_code,
            )
        },
    )
    paged = merged[offset : offset + limit]
    return HybridSearchResponse(
        items=paged,
        total=len(merged),
        query=response_query,
        search_mode="hybrid" if hybrid_enabled else "keyword",
        degraded=degraded,
        degradation_code=degradation_code,
    )


def _query_usage_attribution(
    *,
    family_id: str,
    user_id: str | None,
    logical_operation_id: str,
) -> UsageAttribution:
    """Build only trusted search attribution from the route/tool context.

    Runtime request paths pass ``user_id`` and therefore create a user event.
    The system branch keeps direct service callers deterministic while callers
    are migrated; it never derives a user identity from request content.
    """

    if user_id:
        return UsageAttribution(
            family_id=family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=user_id,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id=logical_operation_id,
        )
    return UsageAttribution(
        family_id=family_id,
        attribution_kind=ModelUsageAttributionKind.SYSTEM,
        actor_user_id=None,
        operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
        logical_operation_id=logical_operation_id,
    )


def _require_single_vector(result: MeteredEmbeddingResult) -> list[float]:
    if len(result.vectors) != 1:
        raise EmbeddingUnavailableError("embedding response count mismatch")
    return result.vectors[0]


def _merge_and_rank_hits(
    db: Session,
    *,
    family_id: str,
    user_id: str | None,
    profile: SearchQueryProfile,
    exact_name_hits: list[KeywordSearchHit],
    keyword_hits: list[KeywordSearchHit],
    semantic_hits: list[VectorSearchHit],
    semantic_min_score: float,
) -> tuple[list[HybridSearchResult], dict[tuple[str, str], SearchDocument], HybridSearchDiagnostics]:
    exact_by_key = {(hit.entity_type, hit.entity_id): hit for hit in exact_name_hits}
    keyword_by_key = {(hit.entity_type, hit.entity_id): hit for hit in keyword_hits}
    keyword_rank_by_key = {
        (hit.entity_type, hit.entity_id): rank for rank, hit in enumerate(keyword_hits, start=1)
    }
    exact_rank_by_key = {
        (hit.entity_type, hit.entity_id): rank for rank, hit in enumerate(exact_name_hits, start=1)
    }
    semantic_by_key: dict[tuple[str, str], VectorSearchHit] = {}
    for hit in semantic_hits:
        key = (hit.entity_type, hit.entity_id)
        existing = semantic_by_key.get(key)
        if existing is None or (
            _normalized_semantic_sort_score(hit.semantic_score), -hit.semantic_rank
        ) > (
            _normalized_semantic_sort_score(existing.semantic_score), -existing.semantic_rank
        ):
            semantic_by_key[key] = hit
    keys = set(exact_by_key) | set(keyword_by_key)
    keys.update(
        key for key, hit in semantic_by_key.items()
        if key in exact_by_key
        or key in keyword_by_key
        or _normalized_semantic_sort_score(hit.semantic_score) >= semantic_min_score
    )
    documents_by_key = _load_candidate_documents(db, family_id=family_id, keys=sorted(keys))
    keys = {key for key in keys if key in documents_by_key or key in exact_by_key}
    existing_keys = _load_existing_business_keys(
        db, family_id=family_id, user_id=user_id, keys=sorted(keys),
    )
    keys &= existing_keys
    business_signals = _load_business_signals(
        db, family_id=family_id, user_id=user_id, keys=sorted(keys),
    )

    def combined_keyword_hit(key: tuple[str, str]) -> KeywordSearchHit | None:
        hits = [hit for hit in (keyword_by_key.get(key), exact_by_key.get(key)) if hit is not None]
        if not hits:
            return None
        field_order = ("title_text", "keyword_text", "detail_text")
        mode_order = (
            KeywordMatchMode.MYSQL_FULLTEXT,
            KeywordMatchMode.SUBSTRING,
            KeywordMatchMode.SAFE_COMPACT,
        )
        return KeywordSearchHit(
            entity_type=key[0],
            entity_id=key[1],
            keyword_score=max(hit.keyword_score for hit in hits),
            matched_fields=tuple(field for field in field_order if any(field in hit.matched_fields for hit in hits)),
            match_modes=tuple(mode for mode in mode_order if any(mode in hit.match_modes for hit in hits)),
        )

    candidates: list[SearchRankingCandidate] = []
    for key in sorted(keys):
        document = documents_by_key.get(key)
        keyword_hit = combined_keyword_hit(key)
        semantic_hit = semantic_by_key.get(key)
        reasons = business_score_candidates(
            entity_type=key[0],
            profile=profile,
            metadata=(document.metadata_json if document is not None else {}) or {},
            signals=business_signals.get(key),
        )
        candidates.append(build_ranking_candidate(
            profile=profile,
            entity_type=key[0],
            entity_id=key[1],
            document=document,
            exact_name_match=key in exact_by_key,
            keyword_hit=keyword_hit,
            keyword_rank=keyword_rank_by_key.get(key, exact_rank_by_key.get(key)),
            semantic_score=semantic_hit.semantic_score if semantic_hit is not None else 0.0,
            semantic_rank=semantic_hit.semantic_rank if semantic_hit is not None else None,
            business_reasons=reasons,
        ))
    ranking_started_at = perf_counter()
    ranked = rank_local_candidates(profile, candidates)
    ranking_duration_ms = (perf_counter() - ranking_started_at) * 1000
    level_counts = Counter(score.confidence_level for _candidate, score in ranked)
    results = [
        HybridSearchResult(
            entity_type=candidate.entity_type,
            entity_id=candidate.entity_id,
            score=score.final_score,
            keyword_score=candidate.keyword_score,
            semantic_score=candidate.semantic_score,
            business_score=candidate.signed_business_score,
            exact_name_match=candidate.literal_match.value == "exact_name",
            local_score=score.final_score,
            literal_score=candidate.literal_confidence,
            literal_reason=candidate.positive_reasons[0] if candidate.literal_confidence > 0 and candidate.positive_reasons else "",
            match_reason=list(candidate.positive_reasons),
        )
        for candidate, score in ranked
    ]
    diagnostics = HybridSearchDiagnostics(
        query_profile=profile.kind.value,
        keyword_candidate_count=len(keyword_hits),
        semantic_candidate_count=len(semantic_hits),
        dual_source_count=sum(candidate.dual_source_match for candidate in candidates),
        level_0_count=level_counts[SearchConfidenceLevel.EXACT],
        level_1_count=level_counts[SearchConfidenceLevel.TITLE],
        level_2_count=level_counts[SearchConfidenceLevel.STRONG],
        level_3_count=level_counts[SearchConfidenceLevel.RELEVANT],
        level_4_count=level_counts[SearchConfidenceLevel.WEAK],
        local_ranking_duration_ms=ranking_duration_ms,
    )
    return results, documents_by_key, diagnostics


def _normalized_semantic_sort_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    score = float(value)
    return score if math.isfinite(score) else 0.0


def _with_global_semantic_ranks(hits: list[VectorSearchHit], *, limit: int) -> list[VectorSearchHit]:
    ordered = sorted(
        hits,
        key=lambda item: (
            -_normalized_semantic_sort_score(item.semantic_score),
            item.semantic_rank,
            item.entity_type,
            item.entity_id,
        ),
    )[:limit]
    return [
        VectorSearchHit(hit.entity_type, hit.entity_id, hit.semantic_score, rank)
        for rank, hit in enumerate(ordered, start=1)
    ]


def _search_vectors(
    *,
    vector_store: VectorStore,
    family_id: str,
    user_id: str | None,
    scopes: list[str],
    vector: list[float],
    limit: int,
) -> list[VectorSearchHit]:
    if not user_id or "meal_plan" not in scopes:
        return _with_global_semantic_ranks(
            vector_store.search(family_id=family_id, scopes=scopes, vector=vector, limit=limit),
            limit=limit,
        )
    hits: list[VectorSearchHit] = []
    other_scopes = [scope for scope in scopes if scope != "meal_plan"]
    if other_scopes:
        hits.extend(vector_store.search(
            family_id=family_id, scopes=other_scopes, vector=vector, limit=limit, user_id=None,
        ))
    hits.extend(vector_store.search(
        family_id=family_id, scopes=["meal_plan"], vector=vector, limit=limit, user_id=user_id,
    ))
    return _with_global_semantic_ranks(hits, limit=limit)


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
    rerank_attribution: UsageAttribution | None,
    rerank_attempt_key: str | None,
) -> tuple[list[HybridSearchResult], bool, str | None, bool]:
    local_sorted = list(results)
    local_position_by_key = {
        (item.entity_type, item.entity_id): position
        for position, item in enumerate(local_sorted)
    }
    if rerank_client is None or not rerank_client.enabled or not local_sorted:
        return _local_rerank_fallback(local_sorted), False, None, False

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
        return local_sorted, False, None, False

    try:
        rerank_results = rerank_client.rerank(
            query=query,
            documents=rerank_documents,
            top_n=len(rerank_documents),
            attribution=rerank_attribution,
            attempt_key=rerank_attempt_key,
        )
    except ModelUsageError as exc:
        return _local_rerank_fallback(local_sorted), True, exc.code, True
    except RerankUnavailableError as exc:
        return _local_rerank_fallback(local_sorted), True, exc.code, True

    rerank_scores: dict[tuple[str, str], float] = {}
    for item in rerank_results:
        if item.index >= len(rerank_doc_keys):
            continue
        key = rerank_doc_keys[item.index]
        rerank_scores[key] = max(rerank_scores.get(key, 0.0), item.relevance_score)

    def result_bucket(item: HybridSearchResult) -> int | None:
        key = (item.entity_type, item.entity_id)
        if item.exact_name_match:
            item.score = item.local_score
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

    def sort_key(item: HybridSearchResult) -> tuple[int, float, float, int]:
        key = (item.entity_type, item.entity_id)
        bucket = bucket_by_key[key]
        return (bucket, -item.score, -item.local_score, local_position_by_key[key])

    return sorted(filtered_results, key=sort_key), False, None, True


def _local_rerank_fallback(results: list[HybridSearchResult]) -> list[HybridSearchResult]:
    """Return the unfiltered local ranking after a remote rerank is skipped.

    Rerank normally replaces ``score`` with a provider bucket score.  A
    blocked or unavailable provider must not leave stale/zero scores behind or
    drop local candidates; the local score remains the response score.
    """

    for item in results:
        item.score = item.local_score
    return results


def _rerank_document_texts(document: SearchDocument) -> list[str]:
    entity_label = {"ingredient": "食材", "food": "食物", "recipe": "菜谱", "meal_plan": "餐食计划"}.get(document.entity_type, document.entity_type)
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
    user_id: str | None,
    keys: list[tuple[str, str]],
) -> set[tuple[str, str]]:
    if not keys:
        return set()
    ingredient_ids = [entity_id for entity_type, entity_id in keys if entity_type == "ingredient"]
    food_ids = [entity_id for entity_type, entity_id in keys if entity_type == "food"]
    recipe_ids = [entity_id for entity_type, entity_id in keys if entity_type == "recipe"]
    meal_plan_ids = [entity_id for entity_type, entity_id in keys if entity_type == "meal_plan"]
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
    if meal_plan_ids and user_id:
        existing.update(
            ("meal_plan", entity_id)
            for entity_id in db.scalars(
                select(FoodPlanItem.id).where(
                    FoodPlanItem.family_id == family_id,
                    FoodPlanItem.user_id == user_id,
                    FoodPlanItem.id.in_(meal_plan_ids),
                )
            )
        )
    return existing


def _load_business_signals(
    db: Session,
    *,
    family_id: str,
    user_id: str | None,
    keys: list[tuple[str, str]],
) -> dict[tuple[str, str], SearchBusinessSignals]:
    recipe_ids = [entity_id for entity_type, entity_id in keys if entity_type == "recipe"]
    food_ids = [entity_id for entity_type, entity_id in keys if entity_type == "food"]
    ingredient_ids = [entity_id for entity_type, entity_id in keys if entity_type == "ingredient"]
    meal_plan_ids = [entity_id for entity_type, entity_id in keys if entity_type == "meal_plan"]
    if not recipe_ids and not food_ids and not ingredient_ids and not meal_plan_ids:
        return {}
    today = today_for_family(family_id)
    signals: dict[tuple[str, str], SearchBusinessSignals] = {}
    if ingredient_ids:
        signals.update(_load_ingredient_business_signals(db, family_id=family_id, ingredient_ids=ingredient_ids, today=today))
    if food_ids:
        signals.update(_load_food_business_signals(db, family_id=family_id, food_ids=food_ids, today=today))
    if meal_plan_ids and user_id:
        signals.update(_load_meal_plan_business_signals(db, family_id=family_id, user_id=user_id, meal_plan_ids=meal_plan_ids, today=today))
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
    presence_states = load_presence_states_for_ingredients(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient.id for ingredient in ingredients if not tracks_quantity(ingredient)],
    )
    signals: dict[tuple[str, str], SearchBusinessSignals] = {}
    for ingredient in ingredients:
        if tracks_quantity(ingredient):
            available_items = inventory_by_ingredient.get(ingredient.id, [])
            signals[("ingredient", ingredient.id)] = SearchBusinessSignals(
                inventory_available=bool(available_items),
                days_until_expiry=_nearest_expiry_days(available_items, today=today),
                low_stock=_has_low_stock_item(ingredient, available_items),
            )
            continue
        state = presence_states.get(ingredient.id)
        usable = state is not None and state_is_usable(state, business_date=today)
        days_until_expiry = None
        if state is not None and state.expiry_date is not None:
            days_until_expiry = (state.expiry_date - today).days
        signals[("ingredient", ingredient.id)] = SearchBusinessSignals(
            inventory_available=usable,
            days_until_expiry=days_until_expiry,
            low_stock=(
                state is not None
                and state.availability_level is InventoryAvailabilityLevel.LOW
            ),
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


def _load_meal_plan_business_signals(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    meal_plan_ids: list[str],
    today,
) -> dict[tuple[str, str], SearchBusinessSignals]:
    items = list(
        db.scalars(
            select(FoodPlanItem).where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.user_id == user_id,
                FoodPlanItem.id.in_(meal_plan_ids),
            )
        )
    )
    signals: dict[tuple[str, str], SearchBusinessSignals] = {}
    for item in items:
        meal_type = item.meal_type.value if hasattr(item.meal_type, "value") else str(item.meal_type)
        signals[("meal_plan", item.id)] = SearchBusinessSignals(
            plan_date_delta=(item.plan_date - today).days if item.plan_date is not None else None,
            meal_type=meal_type,
            plan_status=str(item.status or ""),
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
