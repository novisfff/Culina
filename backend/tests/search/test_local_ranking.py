from __future__ import annotations

from dataclasses import replace

import pytest

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate


def candidate(entity_id: str, **overrides) -> SearchRankingCandidate:
    values = {
        "entity_type": "recipe", "entity_id": entity_id, "keyword_score": 0.0,
        "semantic_score": 0.0, "keyword_rank": None, "semantic_rank": None,
        "literal_match": LiteralMatchKind.NONE, "literal_confidence": 0.0,
        "trusted_keyword_match": False, "detail_only_match": False,
        "dual_source_match": False, "signed_business_score": 0.0, "positive_reasons": (),
    }
    values.update(overrides)
    return SearchRankingCandidate(**values)


@pytest.mark.parametrize(("item", "expected"), [
    (candidate("exact", literal_match=LiteralMatchKind.EXACT_NAME, literal_confidence=1.0, keyword_score=1.0, trusted_keyword_match=True), SearchConfidenceLevel.EXACT),
    (candidate("title", literal_match=LiteralMatchKind.TITLE_CONTAINS, literal_confidence=0.9, keyword_score=0.8, trusted_keyword_match=True), SearchConfidenceLevel.TITLE),
    (candidate("structured", literal_match=LiteralMatchKind.STRUCTURED_KEYWORD, literal_confidence=0.8, keyword_score=0.8, trusted_keyword_match=True), SearchConfidenceLevel.STRONG),
    (candidate("dual-strong", literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, keyword_score=0.7, semantic_score=0.60, trusted_keyword_match=True, dual_source_match=True), SearchConfidenceLevel.STRONG),
    (candidate("semantic-strong", semantic_score=0.82), SearchConfidenceLevel.STRONG),
    (candidate("keyword", literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, keyword_score=0.7, trusted_keyword_match=True), SearchConfidenceLevel.RELEVANT),
    (candidate("semantic", semantic_score=0.74), SearchConfidenceLevel.RELEVANT),
    (candidate("detail", literal_match=LiteralMatchKind.DETAIL, literal_confidence=0.35, keyword_score=1.0, detail_only_match=True), SearchConfidenceLevel.WEAK),
    (candidate("semantic-weak", semantic_score=0.48), SearchConfidenceLevel.WEAK),
])
def test_confidence_level_contract(item, expected) -> None:
    ranked = rank_local_candidates(analyze_search_query("晚餐"), [item])
    assert ranked[0][1].confidence_level is expected


def test_pure_semantic_below_floor_is_filtered_but_keyword_evidence_survives() -> None:
    below = candidate("below", semantic_score=0.479999)
    keyword = candidate("keyword", semantic_score=0.2, keyword_score=0.6, literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, trusted_keyword_match=True)
    ranked = rank_local_candidates(analyze_search_query("鸡肉"), [below, keyword])
    assert [item.entity_id for item, _score in ranked] == ["keyword"]


def test_semantic_calibration_boundaries() -> None:
    items = [candidate("floor", semantic_score=0.48), candidate("top", semantic_score=1.0)]
    scores = {item.entity_id: score for item, score in rank_local_candidates(analyze_search_query("清淡"), items)}
    assert scores["floor"].semantic_confidence == 0.0
    assert scores["top"].semantic_confidence == 1.0


def test_query_kind_changes_only_within_level_weighting() -> None:
    item = candidate("dual", keyword_score=0.8, semantic_score=0.8, literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, trusted_keyword_match=True, dual_source_match=True)
    literal_score = rank_local_candidates(analyze_search_query("鸡肉"), [item])[0][1]
    mixed_score = rank_local_candidates(analyze_search_query("鸡肉 快手"), [item])[0][1]
    intent_score = rank_local_candidates(analyze_search_query("快手"), [item])[0][1]
    assert {literal_score.confidence_level, mixed_score.confidence_level, intent_score.confidence_level} == {SearchConfidenceLevel.STRONG}
    assert literal_score.agreement_bonus == 0.05
    assert mixed_score.agreement_bonus == 0.10
    assert intent_score.agreement_bonus == 0.10


def test_signed_business_adjustment_is_bounded_and_cannot_change_level() -> None:
    base = candidate("base", semantic_score=0.80)
    positive = replace(base, entity_id="positive", signed_business_score=1.0)
    negative = replace(base, entity_id="negative", signed_business_score=-1.0)
    ranked = rank_local_candidates(analyze_search_query("家庭晚餐"), [base, positive, negative])
    scores = {item.entity_id: score for item, score in ranked}
    assert scores["positive"].business_adjustment == pytest.approx(scores["positive"].within_level_score / 21, abs=0.002)
    assert scores["negative"].business_adjustment < 0
    assert {score.confidence_level for score in scores.values()} == {SearchConfidenceLevel.RELEVANT}
    assert [item.entity_id for item, _score in ranked] == ["positive", "base", "negative"]


def test_stable_tie_break_uses_literal_then_source_rank_then_identity() -> None:
    candidates = [candidate("z", semantic_score=0.75, semantic_rank=2), candidate("a", semantic_score=0.75, semantic_rank=2), candidate("rank-one", semantic_score=0.75, semantic_rank=1)]
    first = rank_local_candidates(analyze_search_query("清淡"), candidates)
    second = rank_local_candidates(analyze_search_query("清淡"), list(reversed(candidates)))
    assert [item.entity_id for item, _score in first] == ["rank-one", "a", "z"]
    assert [item.entity_id for item, _score in first] == [item.entity_id for item, _score in second]
    assert all(0.0 <= score.final_score < 5.0 for _item, score in first)
