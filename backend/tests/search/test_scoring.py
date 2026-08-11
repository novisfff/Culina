from __future__ import annotations

from app.services.search.keyword_store import KeywordSearchHit
from app.services.search.query_analysis import SearchQueryKind, SearchQueryProfile, analyze_search_query
from app.services.search.scoring import (
    SearchBusinessSignals,
    SearchReason,
    business_score_candidates,
    keyword_reason_candidates,
    reason_labels,
    semantic_reason_candidates,
    signed_business_score,
)


def test_semantic_reason_candidates_follow_thresholds() -> None:
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.83)[0].label == "语意接近：清淡晚饭"
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.74)[0].label == "适合这个搜索意图"
    assert semantic_reason_candidates(query="清淡晚饭", semantic_score=0.73) == []


def test_reason_labels_dedupes_limits_and_skips_negative_candidates() -> None:
    labels = reason_labels(
        [
            SearchReason(key="low", label="低权重", weight=0.1, source="business"),
            SearchReason(key="high", label="高权重", weight=1.0, source="keyword"),
            SearchReason(key="same-label", label="高权重", weight=0.9, source="semantic"),
            SearchReason(key="negative", label="负向信号", weight=-0.9, source="business"),
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
        profile=analyze_search_query("快手早餐"),
        metadata={"prep_minutes": 15, "difficulty": "easy", "scene_tags": ["早餐"]},
    )

    assert [reason.label for reason in reasons] == ["15 分钟内", "适合早餐", "做法简单"]


def test_business_score_candidates_use_recipe_business_signals() -> None:
    reasons = business_score_candidates(
        entity_type="recipe",
        profile=analyze_search_query("晚饭"),
        metadata={},
        signals=SearchBusinessSignals(availability="ready", never_used=True),
    )

    assert [reason.label for reason in reasons] == ["家里可做", "最近少吃"]
    assert signed_business_score(reasons) == 0.43


def test_business_score_candidates_use_food_metadata() -> None:
    reasons = business_score_candidates(
        entity_type="food",
        profile=analyze_search_query("早餐"),
        metadata={
            "suitable_meal_types": ["breakfast", "snack"],
            "favorite": True,
            "rating": 4,
            "repurchase": True,
        },
    )

    assert [reason.label for reason in reasons] == ["适合早餐", "已收藏", "高评分", "愿意复购"]


def test_business_score_candidates_use_food_business_signals() -> None:
    reasons = business_score_candidates(
        entity_type="food",
        profile=analyze_search_query("早餐"),
        metadata={"suitable_meal_types": ["breakfast"], "favorite": True},
        signals=SearchBusinessSignals(
            target_meal_type="breakfast",
            inventory_available=True,
            days_until_expiry=1,
            never_used=True,
        ),
    )

    assert [reason.label for reason in reasons] == ["适合早餐", "适合早餐", "库存可用", "1 天内到期", "最近少吃", "已收藏"]
    assert signed_business_score(reasons) == 1.0


def test_business_score_candidates_use_ingredient_business_signals() -> None:
    reasons = business_score_candidates(
        entity_type="ingredient",
        profile=analyze_search_query("番茄补货"),
        metadata={},
        signals=SearchBusinessSignals(inventory_available=True, days_until_expiry=2, low_stock=True),
    )

    assert [reason.label for reason in reasons] == ["库存中有", "临期优先", "低库存"]
    assert signed_business_score(reasons) == 0.62


def test_business_score_candidates_use_meal_plan_status_and_dates() -> None:
    reasons = business_score_candidates(
        entity_type="meal_plan",
        profile=analyze_search_query("明天早餐计划"),
        metadata={"meal_type": "breakfast", "status": "planned"},
        signals=SearchBusinessSignals(plan_date_delta=1),
    )

    assert [reason.key for reason in reasons] == ["meal_plan_breakfast", "meal_plan_planned", "meal_plan_tomorrow"]


def test_meal_plan_week_signal_requires_shared_week_intent() -> None:
    weekly_profile = analyze_search_query("本周")
    date_only_profile = SearchQueryProfile(
        original_text="本周",
        normalized_text="本周",
        compact_text="本周",
        kind=SearchQueryKind.INTENT,
        effective_length=2,
        intent_keys=("date",),
    )
    weekly_reasons = business_score_candidates(
        entity_type="meal_plan",
        profile=weekly_profile,
        metadata={},
        signals=SearchBusinessSignals(plan_date_delta=6),
    )
    date_only_reasons = business_score_candidates(
        entity_type="meal_plan",
        profile=date_only_profile,
        metadata={},
        signals=SearchBusinessSignals(plan_date_delta=6),
    )

    assert [reason.key for reason in weekly_reasons] == ["meal_plan_this_week"]
    assert date_only_reasons == []


def test_signed_business_score_preserves_negative_signals() -> None:
    profile = analyze_search_query("早餐")
    reasons = business_score_candidates(
        entity_type="food",
        profile=profile,
        metadata={},
        signals=SearchBusinessSignals(inventory_available=False, days_since_used=1),
    )

    assert signed_business_score(reasons) == -0.56
    assert "库存不足" not in reason_labels(reasons)
    assert "最近刚吃过" not in reason_labels(reasons)


def test_signed_business_score_clamps_both_directions() -> None:
    assert signed_business_score([
        SearchReason("a", "A", 0.8, "business"),
        SearchReason("b", "B", 0.7, "business"),
    ]) == 1.0
    assert signed_business_score([
        SearchReason("a", "A", -0.8, "business"),
        SearchReason("b", "B", -0.7, "business"),
    ]) == -1.0


def test_business_intent_uses_query_profile_keys() -> None:
    quick = business_score_candidates(
        entity_type="recipe",
        profile=analyze_search_query("速成"),
        metadata={"prep_minutes": 15, "difficulty": "easy"},
    )
    literal = business_score_candidates(
        entity_type="recipe",
        profile=analyze_search_query("十五分钟"),
        metadata={"prep_minutes": 15, "difficulty": "easy"},
    )

    assert [reason.key for reason in quick] == ["quick_recipe", "easy_recipe"]
    assert literal == []
