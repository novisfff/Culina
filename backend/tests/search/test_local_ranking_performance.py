from __future__ import annotations

import json
import time

from app.services.search.local_ranking import rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate


def _performance_candidates() -> list[SearchRankingCandidate]:
    candidates: list[SearchRankingCandidate] = []
    literal_cycle = (
        LiteralMatchKind.TITLE_CONTAINS,
        LiteralMatchKind.STRUCTURED_KEYWORD,
        LiteralMatchKind.COMPACT_KEYWORD,
        LiteralMatchKind.NONE,
        LiteralMatchKind.DETAIL,
    )
    for index in range(160):
        literal = literal_cycle[index % len(literal_cycle)]
        trusted = literal not in {LiteralMatchKind.NONE, LiteralMatchKind.DETAIL}
        semantic = 0.48 + (index % 53) / 100
        candidates.append(SearchRankingCandidate(
            entity_type=("ingredient", "food", "recipe", "meal_plan")[index % 4],
            entity_id=f"perf-{index:03d}",
            keyword_score=(index % 11) / 10,
            semantic_score=min(semantic, 1.0),
            keyword_rank=index + 1 if trusted else None,
            semantic_rank=160 - index,
            literal_match=literal,
            literal_confidence={
                LiteralMatchKind.TITLE_CONTAINS: 0.90,
                LiteralMatchKind.STRUCTURED_KEYWORD: 0.80,
                LiteralMatchKind.COMPACT_KEYWORD: 0.70,
                LiteralMatchKind.NONE: 0.0,
                LiteralMatchKind.DETAIL: 0.35,
            }[literal],
            trusted_keyword_match=trusted,
            detail_only_match=literal is LiteralMatchKind.DETAIL,
            dual_source_match=trusted and semantic >= 0.48,
            signed_business_score=((index % 21) - 10) / 10,
            positive_reasons=(),
        ))
    return candidates


def test_local_ranking_160_candidate_performance_reference() -> None:
    profile = analyze_search_query("鸡肉 快手")
    candidates = _performance_candidates()
    durations_ms: list[float] = []
    expected_order = None
    for _run in range(200):
        started = time.perf_counter()
        ranked = rank_local_candidates(profile, candidates)
        durations_ms.append((time.perf_counter() - started) * 1000)
        order = [candidate.entity_id for candidate, _score in ranked]
        expected_order = order if expected_order is None else expected_order
        assert order == expected_order
    ordered = sorted(durations_ms)
    p95 = ordered[int(len(ordered) * 0.95) - 1]
    report = {"candidate_count": 160, "runs": 200, "p95_ms": round(p95, 3)}
    print("local_ranking_performance=" + json.dumps(report, sort_keys=True))
    assert report["candidate_count"] == 160
    assert report["runs"] == 200
    assert p95 > 0
