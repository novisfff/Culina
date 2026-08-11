from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

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
