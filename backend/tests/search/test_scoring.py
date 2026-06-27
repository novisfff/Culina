from __future__ import annotations

from app.services.search.keyword_store import KeywordSearchHit
from app.services.search.scoring import (
    SearchBusinessSignals,
    SearchReason,
    business_score_candidates,
    keyword_reason_candidates,
    reason_labels,
    score_search_candidate,
    semantic_reason_candidates,
)


def test_score_search_candidate_applies_title_bonus_and_keyword_reasons() -> None:
    keyword_hit = KeywordSearchHit(
        entity_type="ingredient",
        entity_id="ingredient-tomato",
        keyword_score=1.0,
        matched_fields=("title_text", "keyword_text", "detail_text"),
    )

    score = score_search_candidate(
        entity_type="ingredient",
        query="番茄",
        keyword_score=1.0,
        semantic_score=0.0,
        keyword_hit=keyword_hit,
    )

    assert score.final_score == 0.5
    assert score.business_score == 0.0
    assert score.reasons == ["名称匹配", "关键词匹配", "详情提到"]


def test_semantic_reason_candidates_follow_thresholds() -> None:
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.83)[0].label == "语意接近：清淡晚饭"
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.74)[0].label == "适合这个搜索意图"
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.73) == []


def test_reason_labels_dedupes_and_limits_by_weight() -> None:
    labels = reason_labels(
        [
            SearchReason(key="low", label="低权重", weight=0.1, source="business"),
            SearchReason(key="high", label="高权重", weight=1.0, source="keyword"),
            SearchReason(key="same-label", label="高权重", weight=0.9, source="semantic"),
            SearchReason(key="mid", label="中权重", weight=0.5, source="business"),
            SearchReason(key="next", label="次高权重", weight=0.8, source="business"),
        ]
    )

    assert labels == ["高权重", "次高权重", "中权重"]


def test_keyword_reason_candidates_use_recipe_title_label() -> None:
    hit = KeywordSearchHit(
        entity_type="recipe",
        entity_id="recipe-1",
        keyword_score=1.0,
        matched_fields=("title_text",),
    )

    assert keyword_reason_candidates(hit)[0].label == "标题匹配"


def test_business_score_candidates_use_recipe_metadata() -> None:
    reasons = business_score_candidates(
        entity_type="recipe",
        query="快手早餐",
        metadata={"prep_minutes": 15, "difficulty": "easy", "scene_tags": ["早餐"]},
    )

    assert [reason.label for reason in reasons] == ["15 分钟内", "适合早餐", "做法简单"]


def test_score_search_candidate_uses_recipe_business_signals() -> None:
    ready_score = score_search_candidate(
        entity_type="recipe",
        query="晚饭",
        keyword_score=0.0,
        semantic_score=0.8,
        keyword_hit=None,
        business_signals=SearchBusinessSignals(availability="ready", never_used=True),
    )
    recent_score = score_search_candidate(
        entity_type="recipe",
        query="晚饭",
        keyword_score=0.0,
        semantic_score=0.8,
        keyword_hit=None,
        business_signals=SearchBusinessSignals(availability="ready", days_since_used=1),
    )

    assert round(ready_score.business_score, 2) == 0.43
    assert ready_score.reasons[:2] == ["适合这个搜索意图", "家里可做"]
    assert recent_score.business_score == 0.0
    assert "最近刚吃过" not in recent_score.reasons


def test_business_score_candidates_use_food_metadata() -> None:
    reasons = business_score_candidates(
        entity_type="food",
        query="早餐",
        metadata={
            "suitable_meal_types": ["breakfast", "snack"],
            "favorite": True,
            "rating": 4,
            "repurchase": True,
        },
    )

    assert [reason.label for reason in reasons] == ["适合早餐", "已收藏", "高评分", "愿意复购"]


def test_score_search_candidate_uses_food_business_signals() -> None:
    expiring_score = score_search_candidate(
        entity_type="food",
        query="早餐",
        keyword_score=0.0,
        semantic_score=0.8,
        keyword_hit=None,
        metadata={"suitable_meal_types": ["breakfast"], "favorite": True},
        business_signals=SearchBusinessSignals(
            target_meal_type="breakfast",
            inventory_available=True,
            days_until_expiry=1,
            never_used=True,
        ),
    )
    recent_missing_score = score_search_candidate(
        entity_type="food",
        query="早餐",
        keyword_score=0.0,
        semantic_score=0.8,
        keyword_hit=None,
        metadata={"suitable_meal_types": ["breakfast"]},
        business_signals=SearchBusinessSignals(
            target_meal_type="breakfast",
            inventory_available=False,
            days_since_used=1,
        ),
    )

    assert expiring_score.business_score > 0.8
    assert "1 天内到期" in expiring_score.reasons
    assert recent_missing_score.business_score == 0.0
    assert "库存不足" not in recent_missing_score.reasons
    assert "最近刚吃过" not in recent_missing_score.reasons


def test_score_search_candidate_uses_ingredient_business_signals() -> None:
    replenishment_score = score_search_candidate(
        entity_type="ingredient",
        query="番茄补货",
        keyword_score=0.0,
        semantic_score=0.0,
        keyword_hit=None,
        business_signals=SearchBusinessSignals(
            inventory_available=True,
            days_until_expiry=2,
            low_stock=True,
        ),
    )
    missing_score = score_search_candidate(
        entity_type="ingredient",
        query="番茄",
        keyword_score=0.0,
        semantic_score=0.8,
        keyword_hit=None,
        business_signals=SearchBusinessSignals(inventory_available=False),
    )

    assert round(replenishment_score.business_score, 2) == 0.62
    assert replenishment_score.final_score == 0.0
    assert replenishment_score.reasons == []
    assert missing_score.business_score == 0.0


def test_business_score_only_lightly_adjusts_relevant_results() -> None:
    plain_score = score_search_candidate(
        entity_type="food",
        query="西红柿",
        keyword_score=0.0,
        semantic_score=0.6,
        keyword_hit=None,
    )
    business_score = score_search_candidate(
        entity_type="food",
        query="西红柿",
        keyword_score=0.0,
        semantic_score=0.6,
        keyword_hit=None,
        metadata={"favorite": True, "rating": 5, "repurchase": True},
        business_signals=SearchBusinessSignals(inventory_available=True, days_until_expiry=0, never_used=True),
    )

    assert business_score.business_score == 1.0
    assert round(business_score.final_score - plain_score.final_score, 3) == 0.03
