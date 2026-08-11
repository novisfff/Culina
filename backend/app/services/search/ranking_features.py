from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from app.models.domain import SearchDocument
from app.services.search.keyword_store import KeywordMatchMode, KeywordSearchHit
from app.services.search.query_analysis import (
    SearchQueryProfile,
    compact_search_text,
    normalize_search_text,
    safe_token_contains,
)
from app.services.search.scoring import (
    SearchReason,
    keyword_reason_candidates,
    reason_labels,
    semantic_reason_candidates,
    signed_business_score,
)


class LiteralMatchKind(str, Enum):
    NONE = "none"
    DETAIL = "detail"
    COMPACT_KEYWORD = "compact_keyword"
    STRUCTURED_KEYWORD = "structured_keyword"
    TITLE_CONTAINS = "title_contains"
    TITLE_PREFIX = "title_prefix"
    EXACT_NAME = "exact_name"


@dataclass(frozen=True)
class SearchRankingCandidate:
    entity_type: str
    entity_id: str
    keyword_score: float
    semantic_score: float
    keyword_rank: int | None
    semantic_rank: int | None
    literal_match: LiteralMatchKind
    literal_confidence: float
    trusted_keyword_match: bool
    detail_only_match: bool
    dual_source_match: bool
    signed_business_score: float
    positive_reasons: tuple[str, ...]


def _finite_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    score = float(value)
    if not math.isfinite(score):
        return 0.0
    return max(0.0, min(score, 1.0))


def _valid_rank(value: int | None) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _metadata_values(document: SearchDocument) -> tuple[str, ...]:
    metadata = document.metadata_json or {}
    fields_by_type = {
        "ingredient": ("name", "category"),
        "food": ("name", "category", "flavor_tags", "scene_tags", "suitable_meal_types"),
        "recipe": ("title", "scene_tags", "ingredient_names"),
        "meal_plan": (
            "food_name",
            "recipe_title",
            "plan_date",
            "meal_type",
            "meal_type_label",
            "status",
            "status_label",
        ),
    }
    values: list[str] = []
    for field in fields_by_type.get(document.entity_type, ()):
        value = metadata.get(field)
        if isinstance(value, list):
            values.extend(str(item) for item in value if str(item).strip())
        elif value is not None and str(value).strip():
            values.append(str(value))
    return tuple(values)


def _title_match(profile: SearchQueryProfile, document: SearchDocument | None) -> LiteralMatchKind:
    if document is None or not profile.compact_text:
        return LiteralMatchKind.NONE
    compact_title = compact_search_text(document.title_text)
    if compact_title.startswith(profile.compact_text):
        return LiteralMatchKind.TITLE_PREFIX
    if profile.compact_text in compact_title:
        return LiteralMatchKind.TITLE_CONTAINS
    return LiteralMatchKind.NONE


def _structured_match(profile: SearchQueryProfile, document: SearchDocument | None) -> bool:
    if document is None:
        return False
    return any(safe_token_contains(profile.normalized_text, value) for value in _metadata_values(document))


def _keyword_match(
    profile: SearchQueryProfile,
    document: SearchDocument | None,
    hit: KeywordSearchHit | None,
) -> bool:
    if document is None or hit is None or "keyword_text" not in hit.matched_fields:
        return False
    if KeywordMatchMode.MYSQL_FULLTEXT in hit.match_modes:
        query_tokens = tuple(token for token in profile.normalized_text.split(" ") if token)
        return any(safe_token_contains(token, document.keyword_text) for token in query_tokens)
    if KeywordMatchMode.SUBSTRING in hit.match_modes:
        return normalize_search_text(profile.normalized_text) in normalize_search_text(document.keyword_text)
    return KeywordMatchMode.SAFE_COMPACT in hit.match_modes and safe_token_contains(
        profile.normalized_text,
        document.keyword_text,
    )


def _detail_match(hit: KeywordSearchHit | None) -> bool:
    return hit is not None and "detail_text" in hit.matched_fields


def _literal_reason(entity_type: str, literal: LiteralMatchKind) -> SearchReason | None:
    title_label = "名称匹配" if entity_type in {"ingredient", "food"} else "标题匹配"
    mapping = {
        LiteralMatchKind.EXACT_NAME: SearchReason("title_match", title_label, 1.2, "exact_name"),
        LiteralMatchKind.TITLE_PREFIX: SearchReason("title_match", title_label, 1.0, "literal"),
        LiteralMatchKind.TITLE_CONTAINS: SearchReason("title_match", title_label, 0.95, "literal"),
        LiteralMatchKind.STRUCTURED_KEYWORD: SearchReason("structured_match", "关键词匹配", 0.80, "literal"),
        LiteralMatchKind.COMPACT_KEYWORD: SearchReason("keyword_match", "关键词匹配", 0.70, "literal"),
        LiteralMatchKind.DETAIL: SearchReason("detail_match", "详情提到", 0.30, "literal"),
    }
    return mapping.get(literal)


def build_ranking_candidate(
    *,
    profile: SearchQueryProfile,
    entity_type: str,
    entity_id: str,
    document: SearchDocument | None,
    exact_name_match: bool,
    keyword_hit: KeywordSearchHit | None,
    keyword_rank: int | None,
    semantic_score: object,
    semantic_rank: int | None,
    business_reasons: Sequence[SearchReason],
) -> SearchRankingCandidate:
    normalized_semantic = _finite_score(semantic_score)
    normalized_keyword = _finite_score(keyword_hit.keyword_score if keyword_hit is not None else 0.0)
    title_match = _title_match(profile, document)
    structured_match = _structured_match(profile, document)
    keyword_match = _keyword_match(profile, document, keyword_hit)
    detail_match = _detail_match(keyword_hit)
    if exact_name_match:
        literal = LiteralMatchKind.EXACT_NAME
        literal_confidence = 1.0
    elif title_match is LiteralMatchKind.TITLE_PREFIX:
        literal = title_match
        literal_confidence = 0.95
    elif title_match is LiteralMatchKind.TITLE_CONTAINS:
        literal = title_match
        literal_confidence = 0.90
    elif structured_match:
        literal = LiteralMatchKind.STRUCTURED_KEYWORD
        literal_confidence = 0.80
    elif keyword_match:
        literal = LiteralMatchKind.COMPACT_KEYWORD
        literal_confidence = 0.70
    elif detail_match:
        literal = LiteralMatchKind.DETAIL
        literal_confidence = 0.35
    else:
        literal = LiteralMatchKind.NONE
        literal_confidence = 0.0
    trusted_keyword = literal in {
        LiteralMatchKind.EXACT_NAME,
        LiteralMatchKind.TITLE_PREFIX,
        LiteralMatchKind.TITLE_CONTAINS,
        LiteralMatchKind.STRUCTURED_KEYWORD,
        LiteralMatchKind.COMPACT_KEYWORD,
    }
    detail_only = literal is LiteralMatchKind.DETAIL
    dual_source = trusted_keyword and normalized_semantic >= 0.48
    reasons: list[SearchReason] = []
    literal_reason = _literal_reason(entity_type, literal)
    if literal_reason is not None:
        reasons.append(literal_reason)
    if keyword_hit is not None:
        reasons.extend(keyword_reason_candidates(keyword_hit))
    reasons.extend(semantic_reason_candidates(query=profile.normalized_text, semantic_score=normalized_semantic))
    reasons.extend(business_reasons)
    return SearchRankingCandidate(
        entity_type=entity_type,
        entity_id=entity_id,
        keyword_score=normalized_keyword,
        semantic_score=normalized_semantic,
        keyword_rank=_valid_rank(keyword_rank),
        semantic_rank=_valid_rank(semantic_rank),
        literal_match=literal,
        literal_confidence=literal_confidence,
        trusted_keyword_match=trusted_keyword,
        detail_only_match=detail_only,
        dual_source_match=dual_source,
        signed_business_score=signed_business_score(list(business_reasons)),
        positive_reasons=tuple(reason_labels(reasons)),
    )
