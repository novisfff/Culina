from __future__ import annotations

import json
from pathlib import Path

FIXTURE_DIR = Path(__file__).parents[1] / "tests/search/fixtures"


def legacy_score(candidate: dict[str, object]) -> float:
    keyword = float(candidate["keyword_score"])
    semantic = float(candidate["semantic_score"])
    business = max(0.0, min(float(candidate["signed_business_score"]), 1.0))
    exact_bonus = 1.0 if candidate["literal_match"] == "exact_name" else 0.0
    title_bonus = 0.05 if candidate["literal_match"] in {"title_prefix", "title_contains"} else 0.0
    relevance = max(keyword, semantic)
    return keyword * 0.45 + semantic * 0.50 + business * 0.05 * relevance + exact_bonus + title_bonus


def main() -> None:
    cases = json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))
    recovered = 0
    relevant = 0
    for case in cases:
        ranked = sorted(case["candidates"], key=lambda item: (-legacy_score(item), str(item["entity_id"])))[:20]
        relevant_ids = {item["entity_id"] for item in case["candidates"] if int(item["relevance"]) > 0}
        ranked_ids = {item["entity_id"] for item in ranked}
        relevant += len(relevant_ids)
        recovered += len(relevant_ids & ranked_ids)
    payload = {
        "case_count": len(cases),
        "case_ids": [case["case_id"] for case in cases],
        "recall_at_20": round(recovered / relevant, 6),
    }
    (FIXTURE_DIR / "local_ranking_baseline.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
