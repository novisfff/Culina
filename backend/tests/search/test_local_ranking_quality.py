from __future__ import annotations

import json
from collections import Counter
from copy import deepcopy
from pathlib import Path

from tests.search.ranking_quality import evaluate_quality_cases, load_baseline, load_quality_cases

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
        "recall_at_20": 1.0,
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


def test_l4_top5_gate_requires_at_least_five_ranked_candidates() -> None:
    four_candidate_case = load_quality_cases()[0]
    five_candidate_case = deepcopy(four_candidate_case)
    extra_candidate = deepcopy(five_candidate_case["candidates"][1])
    extra_candidate["entity_id"] = "literal-extra-strong"
    five_candidate_case["candidates"].append(extra_candidate)

    four_candidate_metrics = evaluate_quality_cases([four_candidate_case])
    five_candidate_metrics = evaluate_quality_cases([five_candidate_case])

    assert four_candidate_metrics.l4_top5_violations == 0
    assert five_candidate_metrics.l4_top5_violations == 1
