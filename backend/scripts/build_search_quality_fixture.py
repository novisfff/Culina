from __future__ import annotations

import json
from pathlib import Path

OUTPUT = Path(__file__).parents[1] / "tests/search/fixtures/local_ranking_quality_cases.json"


def candidate(
    entity_id: str,
    relevance: int,
    *,
    literal_match: str = "none",
    literal_confidence: float = 0.0,
    keyword_score: float = 0.0,
    semantic_score: float = 0.0,
    trusted_keyword_match: bool = False,
    detail_only_match: bool = False,
    dual_source_match: bool = False,
    business_score: float = 0.0,
) -> dict[str, object]:
    return {
        "entity_type": "recipe",
        "entity_id": entity_id,
        "relevance": relevance,
        "keyword_score": keyword_score,
        "semantic_score": semantic_score,
        "keyword_rank": 1 if keyword_score > 0 else None,
        "semantic_rank": 1 if semantic_score > 0 else None,
        "literal_match": literal_match,
        "literal_confidence": literal_confidence,
        "trusted_keyword_match": trusted_keyword_match,
        "detail_only_match": detail_only_match,
        "dual_source_match": dual_source_match,
        "signed_business_score": business_score,
        "positive_reasons": ["合成质量证据"],
    }


def build_cases() -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for index in range(20):
        primary_kind, primary_confidence = (
            ("exact_name", 1.0),
            ("title_prefix", 0.95),
            ("title_contains", 0.90),
        )[index % 3]
        secondary_kind, secondary_confidence = (
            ("title_prefix", 0.95)
            if primary_kind == "exact_name"
            else ("structured_keyword", 0.80)
        )
        literal_candidates = [
            candidate(f"literal-{index}-best", 3, literal_match=primary_kind, literal_confidence=primary_confidence, keyword_score=1.0, trusted_keyword_match=True),
            candidate(f"literal-{index}-secondary", 2, literal_match=secondary_kind, literal_confidence=secondary_confidence, keyword_score=0.9, trusted_keyword_match=True),
            candidate(f"literal-{index}-semantic", 1, semantic_score=0.84),
            candidate(f"literal-{index}-noise", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
        ]
        if index == 0:
            # Keep one deterministic long-tail case so Recall@20 exercises an
            # actual cutoff: the legacy score buries the relevant compact
            # keyword candidate below twenty business-boosted semantic decoys.
            literal_candidates.extend([
                candidate(
                    "literal-0-recall-target",
                    1,
                    literal_match="compact_keyword",
                    literal_confidence=0.70,
                    keyword_score=0.70,
                    trusted_keyword_match=True,
                ),
                candidate(
                    "literal-0-recall-l3-noise",
                    0,
                    literal_match="compact_keyword",
                    literal_confidence=0.70,
                    keyword_score=0.35,
                    trusted_keyword_match=True,
                ),
            ])
            literal_candidates.extend(
                candidate(
                    f"literal-0-legacy-decoy-{decoy_index:02d}",
                    0,
                    semantic_score=0.60,
                    business_score=1.0,
                )
                for decoy_index in range(20)
            )
        cases.append({
            "case_id": f"literal-{index + 1:02d}",
            "category": "literal",
            "query": f"家常菜{index + 1}",
            "candidates": literal_candidates,
        })
    semantic_queries = ["清淡暖胃", "适合老人", "孩子爱吃", "雨天热汤", "运动后补充", "夏天开胃", "不油腻", "软烂好嚼", "一锅完成", "下班很累", "周末慢炖", "便于带饭", "高温天凉菜", "深夜少负担", "早起有精神"]
    for index, query in enumerate(semantic_queries):
        cases.append({
            "case_id": f"semantic-{index + 1:02d}",
            "category": "semantic",
            "query": query,
            "candidates": [
                candidate(f"semantic-{index}-best", 3, semantic_score=0.91),
                candidate(f"semantic-{index}-related", 2, semantic_score=0.80),
                candidate(f"semantic-{index}-weak", 1, semantic_score=0.56),
                candidate(f"semantic-{index}-noise", 0, semantic_score=0.47),
            ],
        })
    intent_queries = ["快手", "简单", "早餐", "午餐", "晚餐", "夜宵", "库存", "补货", "临期", "今天", "明天", "本周", "计划", "做过", "记录"]
    for index, query in enumerate(intent_queries):
        cases.append({
            "case_id": f"intent-{index + 1:02d}",
            "category": "intent",
            "query": query,
            "candidates": [
                candidate(f"intent-{index}-best", 3, semantic_score=0.90, business_score=0.4),
                candidate(f"intent-{index}-related", 2, semantic_score=0.83),
                candidate(f"intent-{index}-literal", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.8, trusted_keyword_match=True),
                candidate(f"intent-{index}-noise", 0, semantic_score=0.50, business_score=1.0),
            ],
        })
    mixed_queries = ["鸡肉 快手", "番茄 晚餐", "牛奶 早餐", "豆腐 补货", "鲈鱼 今天", "面条 明天", "南瓜 本周", "米饭 计划", "鸡蛋 做过", "酸奶 记录"]
    for index, query in enumerate(mixed_queries):
        cases.append({
            "case_id": f"mixed-{index + 1:02d}",
            "category": "mixed",
            "query": query,
            "candidates": [
                candidate(f"mixed-{index}-best", 3, literal_match="structured_keyword", literal_confidence=0.80, keyword_score=0.85, semantic_score=0.82, trusted_keyword_match=True, dual_source_match=True, business_score=0.2),
                candidate(f"mixed-{index}-semantic", 2, semantic_score=0.88),
                candidate(f"mixed-{index}-literal", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.75, trusted_keyword_match=True),
                candidate(f"mixed-{index}-noise", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
            ],
        })
    for index in range(10):
        cases.append({
            "case_id": f"noise-{index + 1:02d}",
            "category": "noise",
            "query": "鸡肉" if index % 2 == 0 else "料",
            "candidates": [
                candidate(f"noise-{index}-exact", 3, literal_match="exact_name", literal_confidence=1.0, keyword_score=1.0, trusted_keyword_match=True),
                candidate(f"noise-{index}-prefix", 2, literal_match="title_prefix", literal_confidence=0.95, keyword_score=0.9, trusted_keyword_match=True),
                candidate(f"noise-{index}-structured", 2, literal_match="structured_keyword", literal_confidence=0.80, keyword_score=0.8, trusted_keyword_match=True),
                candidate(f"noise-{index}-dual", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.7, semantic_score=0.70, trusted_keyword_match=True, dual_source_match=True),
                candidate(f"noise-{index}-semantic", 1, semantic_score=0.75),
                candidate(f"noise-{index}-detail", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
                candidate(f"noise-{index}-below-floor", 0, semantic_score=0.47),
            ],
        })
    for index in range(10):
        cases.append({
            "case_id": f"business-{index + 1:02d}",
            "category": "business",
            "query": f"家庭晚餐{index + 1}",
            "candidates": [
                candidate(f"business-{index}-positive", 3, semantic_score=0.80, business_score=0.8),
                candidate(f"business-{index}-neutral", 2, semantic_score=0.80),
                candidate(f"business-{index}-negative", 1, semantic_score=0.80, business_score=-0.8),
                candidate(f"business-{index}-weak", 0, semantic_score=0.52, business_score=1.0),
            ],
        })
    entity_types = ("ingredient", "food", "recipe", "meal_plan")
    for case_index, case in enumerate(cases):
        case["scope_context"] = {
            "family_id": "synthetic-family-a",
            "user_id": "synthetic-user-a",
            "excluded_other_user_meal_plan_id": (
                f"synthetic-other-user-plan-{case_index:02d}" if case_index < 10 else None
            ),
        }
        for candidate_index, item in enumerate(case["candidates"]):
            item["entity_type"] = entity_types[(case_index + candidate_index) % len(entity_types)]
    assert len(cases) == 80
    return cases


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build_cases(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(build_cases())} cases to {OUTPUT}")


if __name__ == "__main__":
    main()
