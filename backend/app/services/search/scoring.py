from __future__ import annotations

from dataclasses import dataclass

from app.services.search.keyword_store import KeywordSearchHit

KEYWORD_WEIGHT = 0.45
SEMANTIC_WEIGHT = 0.50
BUSINESS_WEIGHT = 0.05
TITLE_MATCH_BONUS = 0.05
EXACT_NAME_BONUS = 1.0


@dataclass(frozen=True)
class SearchReason:
    key: str
    label: str
    weight: float
    source: str


@dataclass(frozen=True)
class SearchScore:
    final_score: float
    business_score: float
    reasons: list[str]


@dataclass(frozen=True)
class SearchBusinessSignals:
    availability: str | None = None
    availability_score: float | None = None
    days_since_used: int | None = None
    never_used: bool = False
    target_meal_type: str | None = None
    inventory_available: bool | None = None
    days_until_expiry: int | None = None
    low_stock: bool = False


def score_search_candidate(
    *,
    entity_type: str,
    query: str,
    keyword_score: float,
    semantic_score: float,
    keyword_hit: KeywordSearchHit | None,
    exact_name_match: bool = False,
    metadata: dict[str, object] | None = None,
    business_signals: SearchBusinessSignals | None = None,
) -> SearchScore:
    business = business_score_candidates(
        entity_type=entity_type,
        query=query,
        metadata=metadata or {},
        signals=business_signals,
    )
    business_score = max(min(sum(candidate.weight for candidate in business), 1.0), 0.0)
    relevance_score = max(keyword_score, semantic_score)
    business_contribution = business_score * BUSINESS_WEIGHT * relevance_score
    final_score = keyword_score * KEYWORD_WEIGHT + semantic_score * SEMANTIC_WEIGHT + business_contribution
    reason_candidates: list[SearchReason] = []
    if keyword_hit is not None:
        reason_candidates.extend(keyword_reason_candidates(keyword_hit))
        if "title_text" in keyword_hit.matched_fields:
            final_score += TITLE_MATCH_BONUS
    if exact_name_match:
        final_score += EXACT_NAME_BONUS
        reason_candidates.append(
            SearchReason(
                key="title_match",
                label="名称匹配" if entity_type in {"ingredient", "food"} else "标题匹配",
                weight=1.2,
                source="exact_name",
            )
        )
    reason_candidates.extend(semantic_reason_candidates(query=query, semantic_score=semantic_score))
    if business_contribution > 0 and (keyword_hit is not None or semantic_score >= 0.74):
        reason_candidates.extend(business)
    return SearchScore(
        final_score=final_score,
        business_score=business_score,
        reasons=reason_labels(reason_candidates),
    )


def keyword_reason_candidates(hit: KeywordSearchHit) -> list[SearchReason]:
    reasons: list[SearchReason] = []
    if "title_text" in hit.matched_fields:
        reasons.append(
            SearchReason(
                key="title_match",
                label="名称匹配" if hit.entity_type in {"ingredient", "food"} else "标题匹配",
                weight=1.0,
                source="keyword",
            )
        )
    if "keyword_text" in hit.matched_fields:
        reasons.append(SearchReason(key="keyword_match", label="关键词匹配", weight=0.7, source="keyword"))
    if "detail_text" in hit.matched_fields:
        reasons.append(SearchReason(key="detail_match", label="详情提到", weight=0.3, source="keyword"))
    return reasons


def semantic_reason_candidates(*, query: str, semantic_score: float) -> list[SearchReason]:
    if semantic_score >= 0.82:
        return [SearchReason(key="semantic_close", label=f"语意接近：{query}", weight=semantic_score, source="semantic")]
    if semantic_score >= 0.74:
        return [SearchReason(key="semantic_intent", label="适合这个搜索意图", weight=semantic_score, source="semantic")]
    return []


def business_score_candidates(
    *,
    entity_type: str,
    query: str,
    metadata: dict[str, object],
    signals: SearchBusinessSignals | None = None,
) -> list[SearchReason]:
    if entity_type == "recipe":
        return _recipe_business_candidates(query=query, metadata=metadata, signals=signals)
    if entity_type == "food":
        return _food_business_candidates(query=query, metadata=metadata, signals=signals)
    if entity_type == "ingredient":
        return _ingredient_business_candidates(query=query, signals=signals)
    return []


def reason_labels(candidates: list[SearchReason], *, limit: int = 3) -> list[str]:
    labels: list[str] = []
    seen_keys: set[str] = set()
    for candidate in sorted(candidates, key=lambda item: item.weight, reverse=True):
        if candidate.weight <= 0 or candidate.key in seen_keys or candidate.label in labels:
            continue
        seen_keys.add(candidate.key)
        labels.append(candidate.label)
        if len(labels) >= limit:
            break
    return labels


def _recipe_business_candidates(
    *,
    query: str,
    metadata: dict[str, object],
    signals: SearchBusinessSignals | None,
) -> list[SearchReason]:
    reasons: list[SearchReason] = []
    if signals is not None:
        if signals.availability == "ready":
            reasons.append(SearchReason(key="recipe_ready", label="家里可做", weight=0.35, source="business"))
        elif signals.availability == "partial":
            reasons.append(SearchReason(key="recipe_partial", label="食材基本够", weight=0.18, source="business"))
        if signals.never_used or (signals.days_since_used is not None and signals.days_since_used >= 14):
            reasons.append(SearchReason(key="fresh_gap", label="最近少吃", weight=0.08, source="business"))
        elif signals.days_since_used is not None and signals.days_since_used <= 2:
            reasons.append(SearchReason(key="recently_used", label="最近刚吃过", weight=-0.35, source="business"))
    prep_minutes = _int_value(metadata.get("prep_minutes"))
    if prep_minutes is not None and prep_minutes <= 20 and _contains_any(query, {"快手", "简单", "省时", "快", "速成"}):
        reasons.append(SearchReason(key="quick_recipe", label=f"{prep_minutes} 分钟内", weight=0.32, source="business"))
    scene_tags = _string_list(metadata.get("scene_tags"))
    matched_scene = next((tag for tag in scene_tags if tag and tag.lower() in query), "")
    if matched_scene:
        reasons.append(SearchReason(key="scene_match", label=f"适合{matched_scene}", weight=0.22, source="business"))
    difficulty = str(metadata.get("difficulty") or "").lower()
    if difficulty == "easy" and _contains_any(query, {"简单", "容易", "新手", "快手"}):
        reasons.append(SearchReason(key="easy_recipe", label="做法简单", weight=0.18, source="business"))
    return reasons


def _ingredient_business_candidates(
    *,
    query: str,
    signals: SearchBusinessSignals | None,
) -> list[SearchReason]:
    reasons: list[SearchReason] = []
    if signals is None:
        return reasons
    if signals.inventory_available is True:
        reasons.append(SearchReason(key="ingredient_inventory_available", label="库存中有", weight=0.22, source="business"))
    if signals.days_until_expiry is not None:
        if signals.days_until_expiry <= 0:
            reasons.append(SearchReason(key="ingredient_expiring_today", label="今天到期", weight=0.30, source="business"))
        elif signals.days_until_expiry <= 3:
            reasons.append(SearchReason(key="ingredient_expiring_soon", label="临期优先", weight=0.24, source="business"))
    if signals.low_stock:
        weight = 0.16 if _contains_any(query, {"补货", "快没了", "低库存", "不足", "采购", "买"}) else 0.08
        reasons.append(SearchReason(key="ingredient_low_stock", label="低库存", weight=weight, source="business"))
    return reasons


def _food_business_candidates(
    *,
    query: str,
    metadata: dict[str, object],
    signals: SearchBusinessSignals | None,
) -> list[SearchReason]:
    reasons: list[SearchReason] = []
    meal_label_by_value = {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}
    suitable_meals = _string_list(metadata.get("suitable_meal_types"))
    for meal_value, meal_label in meal_label_by_value.items():
        if meal_value in suitable_meals and meal_label in query:
            reasons.append(SearchReason(key=f"suitable_{meal_value}", label=f"适合{meal_label}", weight=0.28, source="business"))
            break
    if signals is not None:
        if signals.target_meal_type in suitable_meals:
            meal_label = meal_label_by_value.get(signals.target_meal_type or "", "")
            if meal_label:
                reasons.append(SearchReason(key="target_meal", label=f"适合{meal_label}", weight=0.24, source="business"))
        if signals.inventory_available is True:
            reasons.append(SearchReason(key="inventory_available", label="库存可用", weight=0.18, source="business"))
        elif signals.inventory_available is False:
            reasons.append(SearchReason(key="inventory_missing", label="库存不足", weight=-0.28, source="business"))
        if signals.days_until_expiry is not None:
            if signals.days_until_expiry <= 0:
                reasons.append(SearchReason(key="expiring_today", label="今天到期", weight=0.34, source="business"))
            elif signals.days_until_expiry <= 3:
                reasons.append(SearchReason(key="expiring_soon", label=f"{signals.days_until_expiry} 天内到期", weight=0.26, source="business"))
        if signals.never_used or (signals.days_since_used is not None and signals.days_since_used >= 8):
            reasons.append(SearchReason(key="fresh_gap", label="最近少吃", weight=0.08, source="business"))
        elif signals.days_since_used is not None and signals.days_since_used <= 2:
            reasons.append(SearchReason(key="recently_used", label="最近刚吃过", weight=-0.28, source="business"))
        if signals.availability == "ready":
            reasons.append(SearchReason(key="recipe_ready", label="家里可做", weight=0.24, source="business"))
        elif signals.availability == "partial":
            reasons.append(SearchReason(key="recipe_partial", label="食材基本够", weight=0.12, source="business"))
    if metadata.get("favorite") is True:
        reasons.append(SearchReason(key="favorite", label="已收藏", weight=0.22, source="business"))
    rating = _float_value(metadata.get("rating"))
    if rating is not None and rating >= 4:
        reasons.append(SearchReason(key="high_rating", label="高评分", weight=0.18, source="business"))
    if metadata.get("repurchase") is True:
        reasons.append(SearchReason(key="repurchase", label="愿意复购", weight=0.14, source="business"))
    return reasons


def _contains_any(query: str, values: set[str]) -> bool:
    return any(value in query for value in values)


def _string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    return []


def _int_value(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _float_value(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
