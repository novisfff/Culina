from __future__ import annotations

import math

import pytest

from app.models.domain import SearchDocument
from app.services.search.keyword_store import KeywordMatchMode, KeywordSearchHit
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, build_ranking_candidate
from app.services.search.scoring import SearchReason


def document(
    *,
    entity_id: str = "candidate",
    title: str = "三黄鸡",
    keywords: str = "三黄鸡 肉类",
    details: str = "",
    metadata: dict[str, object] | None = None,
) -> SearchDocument:
    return SearchDocument(
        id=f"doc-{entity_id}", family_id="family-1", entity_type="ingredient", entity_id=entity_id,
        title_text=title, keyword_text=keywords, detail_text=details, semantic_text=f"食材：{title}",
        metadata_json=metadata or {}, content_hash=f"hash-{entity_id}", document_builder_version="v1",
    )


def build(
    *,
    query: str,
    search_document: SearchDocument | None,
    exact: bool = False,
    hit: KeywordSearchHit | None = None,
    semantic_score: object = 0.0,
    business_reasons: list[SearchReason] | None = None,
):
    return build_ranking_candidate(
        profile=analyze_search_query(query),
        entity_type="ingredient",
        entity_id="candidate",
        document=search_document,
        exact_name_match=exact,
        keyword_hit=hit,
        keyword_rank=2 if hit else None,
        semantic_score=semantic_score,
        semantic_rank=3 if semantic_score else None,
        business_reasons=business_reasons or [],
    )


@pytest.mark.parametrize(
    ("query", "search_document", "exact", "expected_kind", "expected_confidence"),
    [
        ("三黄鸡", document(), True, LiteralMatchKind.EXACT_NAME, 1.0),
        ("三黄", document(), False, LiteralMatchKind.TITLE_PREFIX, 0.95),
        ("黄鸡", document(), False, LiteralMatchKind.TITLE_CONTAINS, 0.90),
        ("禽肉", document(metadata={"name": "三黄鸡", "category": "禽肉"}), False, LiteralMatchKind.STRUCTURED_KEYWORD, 0.80),
    ],
)
def test_build_ranking_candidate_classifies_strong_literal_evidence(
    query, search_document, exact, expected_kind, expected_confidence
) -> None:
    candidate = build(query=query, search_document=search_document, exact=exact)

    assert candidate.literal_match is expected_kind
    assert candidate.literal_confidence == expected_confidence


def test_safe_compact_keyword_does_not_cross_multi_character_tokens() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 1.0, ("keyword_text",), (KeywordMatchMode.SAFE_COMPACT,)
    )

    unsafe = build(query="鸡肉", search_document=document(keywords="三黄鸡 肉类"), hit=hit)
    safe = build(query="鸡肉", search_document=document(keywords="鸡 肉 肉类"), hit=hit)

    assert unsafe.literal_match is LiteralMatchKind.NONE
    assert unsafe.trusted_keyword_match is False
    assert safe.literal_match is LiteralMatchKind.COMPACT_KEYWORD
    assert safe.trusted_keyword_match is True


def test_detail_only_match_is_not_trusted_or_dual_source() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 1.0, ("detail_text",), (KeywordMatchMode.SUBSTRING,)
    )
    candidate = build(
        query="快手",
        search_document=document(details="适合快手晚餐"),
        hit=hit,
        semantic_score=0.80,
    )

    assert candidate.literal_match is LiteralMatchKind.DETAIL
    assert candidate.detail_only_match is True
    assert candidate.trusted_keyword_match is False
    assert candidate.dual_source_match is False


@pytest.mark.parametrize("invalid", [None, "bad", "0.8", math.nan, math.inf, -1.0, 2.0])
def test_invalid_semantic_scores_are_finite_and_clamped(invalid) -> None:
    candidate = build(query="晚餐", search_document=document(), semantic_score=invalid)

    assert math.isfinite(candidate.semantic_score)
    assert 0.0 <= candidate.semantic_score <= 1.0


def test_candidate_preserves_source_ranks_and_signed_business_score() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 0.8, ("keyword_text",), (KeywordMatchMode.MYSQL_FULLTEXT,)
    )
    candidate = build(
        query="三黄鸡",
        search_document=document(),
        hit=hit,
        semantic_score=0.75,
        business_reasons=[SearchReason("recent", "最近刚吃过", -0.35, "business")],
    )

    assert candidate.keyword_rank == 2
    assert candidate.semantic_rank == 3
    assert candidate.signed_business_score == -0.35
    assert "最近刚吃过" not in candidate.positive_reasons
