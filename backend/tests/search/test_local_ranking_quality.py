from __future__ import annotations

import json
from collections import Counter
from copy import deepcopy
from pathlib import Path

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from tests.search import ranking_quality
from tests.search.ranking_quality import (
    candidate_from_payload,
    evaluate_quality_cases,
    load_baseline,
    load_quality_cases,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def test_local_ranking_quality_fixture_has_fixed_coverage() -> None:
    cases = json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))
    baseline = json.loads((FIXTURE_DIR / "local_ranking_baseline.json").read_text(encoding="utf-8"))

    assert len(cases) == 80
    assert Counter(case["category"] for case in cases) == {
        "literal": 20,
        "semantic": 15,
        "intent": 15,
        "mixed": 10,
        "noise": 10,
        "business": 10,
    }
    assert len({case["case_id"] for case in cases}) == 80
    assert baseline == {
        "case_count": 80,
        "case_ids": [case["case_id"] for case in cases],
        "recall_at_20": 0.996169,
    }
    assert all(0 <= candidate["relevance"] <= 3 for case in cases for candidate in case["candidates"])
    assert all(len(case["candidates"]) >= 4 for case in cases)
    assert {
        candidate["entity_type"] for case in cases for candidate in case["candidates"]
    } == {"ingredient", "food", "recipe", "meal_plan"}
    assert sum(
        bool(case["scope_context"]["excluded_other_user_meal_plan_id"]) for case in cases
    ) == 10
    literal_best = [case["candidates"][0]["literal_match"] for case in cases if case["category"] == "literal"]
    assert Counter(literal_best) == {"exact_name": 7, "title_prefix": 7, "title_contains": 6}


def test_local_ranking_meets_offline_quality_gates() -> None:
    metrics = evaluate_quality_cases(load_quality_cases())
    baseline = load_baseline()

    assert metrics.case_count == 80
    assert metrics.direct_hit_top1 == 1.0
    assert metrics.mrr_at_10 >= 0.90
    assert metrics.ndcg_at_10 >= 0.85
    assert metrics.l4_top5_violations == 0
    assert metrics.recall_at_20 >= float(baseline["recall_at_20"])
    assert metrics.deterministic_rate == 1.0


def test_quality_fixture_has_a_discriminating_legacy_recall_cutoff() -> None:
    cases = load_quality_cases()
    baseline = load_baseline()
    metrics = evaluate_quality_cases(cases)

    assert any(len(case["candidates"]) > 20 for case in cases)
    assert float(baseline["recall_at_20"]) < 1.0
    assert metrics.recall_at_20 > float(baseline["recall_at_20"])


def test_deterministic_rate_reverses_each_case_candidate_order(monkeypatch) -> None:
    ranker = ranking_quality.rank_local_candidates
    candidate_orders: list[list[str]] = []

    def track_candidate_order(profile, candidates):
        candidate_orders.append([candidate.entity_id for candidate in candidates])
        return ranker(profile, candidates)

    monkeypatch.setattr(ranking_quality, "rank_local_candidates", track_candidate_order)

    evaluate_quality_cases([load_quality_cases()[0]])

    assert len(candidate_orders) == 2
    assert candidate_orders[0] == list(reversed(candidate_orders[1]))


def test_l4_top5_gate_requires_at_least_five_ranked_candidates() -> None:
    four_candidate_case = next(
        case for case in load_quality_cases() if len(case["candidates"]) == 4
    )
    five_candidate_case = deepcopy(four_candidate_case)
    extra_candidate = deepcopy(five_candidate_case["candidates"][1])
    extra_candidate["entity_id"] = "literal-extra-strong"
    five_candidate_case["candidates"].append(extra_candidate)

    four_candidate_metrics = evaluate_quality_cases([four_candidate_case])
    five_candidate_metrics = evaluate_quality_cases([five_candidate_case])

    assert four_candidate_metrics.l4_top5_violations == 0
    assert five_candidate_metrics.l4_top5_violations == 1


def test_l4_top5_gate_ignores_weak_results_without_high_confidence_candidates() -> None:
    no_high_confidence_case = deepcopy(
        next(case for case in load_quality_cases() if len(case["candidates"]) == 4)
    )
    no_high_confidence_case["case_id"] = "synthetic-l3-l4-only"
    candidates = no_high_confidence_case["candidates"]
    for index, candidate in enumerate(candidates[:3]):
        candidate.update({
            "entity_id": f"synthetic-relevant-{index}",
            "keyword_score": 0.7,
            "semantic_score": 0.0,
            "keyword_rank": index + 1,
            "semantic_rank": None,
            "literal_match": "compact_keyword",
            "literal_confidence": 0.7,
            "trusted_keyword_match": True,
            "detail_only_match": False,
            "dual_source_match": False,
        })
    for index, candidate in enumerate(candidates[3:]):
        candidate.update({
            "entity_id": f"synthetic-weak-{index}",
            "keyword_score": 1.0,
            "semantic_score": 0.0,
            "keyword_rank": index + 4,
            "semantic_rank": None,
            "literal_match": "detail",
            "literal_confidence": 0.35,
            "trusted_keyword_match": False,
            "detail_only_match": True,
            "dual_source_match": False,
        })
    candidates.append(deepcopy(candidates[-1]))
    candidates[-1]["entity_id"] = "synthetic-weak-2"

    ranked = rank_local_candidates(
        analyze_search_query(str(no_high_confidence_case["query"])),
        [candidate_from_payload(candidate) for candidate in candidates],
    )
    metrics = evaluate_quality_cases([no_high_confidence_case])

    assert len(ranked) >= 5
    assert all(score.confidence_level >= SearchConfidenceLevel.RELEVANT for _candidate, score in ranked)
    assert any(score.confidence_level is SearchConfidenceLevel.WEAK for _candidate, score in ranked[:5])
    assert metrics.l4_top5_violations == 0
