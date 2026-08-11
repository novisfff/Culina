from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from app.services.search.query_analysis import SearchQueryKind, SearchQueryProfile
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate

DEFAULT_SEMANTIC_MIN_SCORE = 0.48
SEMANTIC_RELEVANT_SCORE = 0.74
SEMANTIC_STRONG_SCORE = 0.82
DUAL_STRONG_SCORE = 0.60
BUSINESS_ADJUSTMENT_LIMIT = 0.05
MAX_WITHIN_LEVEL_SCORE = 0.999999


class SearchConfidenceLevel(IntEnum):
    EXACT = 0
    TITLE = 1
    STRONG = 2
    RELEVANT = 3
    WEAK = 4


@dataclass(frozen=True)
class LocalRankingScore:
    confidence_level: SearchConfidenceLevel
    keyword_confidence: float
    semantic_confidence: float
    agreement_bonus: float
    business_adjustment: float
    within_level_score: float
    final_score: float


def _confidence_level(
    candidate: SearchRankingCandidate,
    *,
    semantic_min_score: float,
) -> SearchConfidenceLevel | None:
    if candidate.literal_match is LiteralMatchKind.EXACT_NAME:
        return SearchConfidenceLevel.EXACT
    if candidate.literal_match in {LiteralMatchKind.TITLE_PREFIX, LiteralMatchKind.TITLE_CONTAINS}:
        return SearchConfidenceLevel.TITLE
    if candidate.literal_match is LiteralMatchKind.STRUCTURED_KEYWORD:
        return SearchConfidenceLevel.STRONG
    if candidate.trusted_keyword_match and candidate.semantic_score >= DUAL_STRONG_SCORE:
        return SearchConfidenceLevel.STRONG
    if not candidate.trusted_keyword_match and not candidate.detail_only_match and candidate.semantic_score >= SEMANTIC_STRONG_SCORE:
        return SearchConfidenceLevel.STRONG
    if candidate.trusted_keyword_match:
        return SearchConfidenceLevel.RELEVANT
    if not candidate.detail_only_match and candidate.semantic_score >= SEMANTIC_RELEVANT_SCORE:
        return SearchConfidenceLevel.RELEVANT
    if candidate.dual_source_match and candidate.semantic_score >= semantic_min_score:
        return SearchConfidenceLevel.RELEVANT
    if candidate.detail_only_match or candidate.semantic_score >= semantic_min_score:
        return SearchConfidenceLevel.WEAK
    return None


def _keyword_confidence(candidate: SearchRankingCandidate) -> float:
    field_cap = {
        LiteralMatchKind.EXACT_NAME: 1.0,
        LiteralMatchKind.TITLE_PREFIX: 0.95,
        LiteralMatchKind.TITLE_CONTAINS: 0.95,
        LiteralMatchKind.STRUCTURED_KEYWORD: 0.80,
        LiteralMatchKind.COMPACT_KEYWORD: 0.80,
        LiteralMatchKind.DETAIL: 0.35,
        LiteralMatchKind.NONE: 0.0,
    }[candidate.literal_match]
    return max(candidate.literal_confidence, candidate.keyword_score * field_cap)


def _semantic_confidence(
    candidate: SearchRankingCandidate,
    *,
    semantic_min_score: float,
) -> float:
    return max(
        0.0,
        min(
            (candidate.semantic_score - semantic_min_score) / (1.0 - semantic_min_score),
            1.0,
        ),
    )


def _weights(kind: SearchQueryKind) -> tuple[float, float, float]:
    if kind is SearchQueryKind.LITERAL:
        return 0.60, 0.35, 0.05
    if kind is SearchQueryKind.MIXED:
        return 0.45, 0.45, 0.10
    return 0.30, 0.60, 0.10


def _source_rank(candidate: SearchRankingCandidate) -> int:
    ranks = [rank for rank in (candidate.keyword_rank, candidate.semantic_rank) if rank is not None]
    return min(ranks) if ranks else 2**31 - 1


def rank_local_candidates(
    profile: SearchQueryProfile,
    candidates: list[SearchRankingCandidate],
    *,
    semantic_min_score: float = DEFAULT_SEMANTIC_MIN_SCORE,
) -> list[tuple[SearchRankingCandidate, LocalRankingScore]]:
    keyword_weight, semantic_weight, agreement_cap = _weights(profile.kind)
    ranked: list[tuple[SearchRankingCandidate, LocalRankingScore]] = []
    for candidate in candidates:
        confidence_level = _confidence_level(
            candidate,
            semantic_min_score=semantic_min_score,
        )
        if confidence_level is None:
            continue
        keyword_confidence = _keyword_confidence(candidate)
        semantic_confidence = _semantic_confidence(
            candidate,
            semantic_min_score=semantic_min_score,
        )
        agreement_bonus = agreement_cap if candidate.dual_source_match else 0.0
        base_relevance = min(
            keyword_confidence * keyword_weight + semantic_confidence * semantic_weight + agreement_bonus,
            1.0,
        )
        business_adjustment = candidate.signed_business_score * BUSINESS_ADJUSTMENT_LIMIT * base_relevance
        within_level_score = min(
            max(base_relevance + business_adjustment, 0.0),
            MAX_WITHIN_LEVEL_SCORE,
        )
        final_score = (4 - int(confidence_level)) + within_level_score
        ranked.append((candidate, LocalRankingScore(
            confidence_level=confidence_level,
            keyword_confidence=keyword_confidence,
            semantic_confidence=semantic_confidence,
            agreement_bonus=agreement_bonus,
            business_adjustment=business_adjustment,
            within_level_score=within_level_score,
            final_score=final_score,
        )))
    ranked.sort(key=lambda item: (
        int(item[1].confidence_level),
        -item[1].within_level_score,
        -item[0].literal_confidence,
        _source_rank(item[0]),
        item[0].entity_type,
        item[0].entity_id,
    ))
    return ranked
