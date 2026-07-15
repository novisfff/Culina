from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable

from sqlalchemy.orm import Session

from app.core.enums import FoodType
from app.repos.meal_log_insights import MealFoodOccurrence, list_meal_food_occurrences
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_log_insights import (
    MealInsightEvidenceOut,
    MealInsightFoodOut,
    MealInsightKind,
    MealInsightOut,
)
from app.services.serializers import serialize_media


RECENT_WINDOW_DAYS = 30
MISSED_MAX_DAYS = 180
FREQUENT_MIN_MEALS = 3
MISSED_MIN_MEALS = 2
REPURCHASE_MIN_RATINGS = 2
REPURCHASE_MIN_AVERAGE = Decimal("4.0")
REPEATED_CHOICE_MIN_MEALS = 2
MAX_INSIGHTS = 4
MAX_CANDIDATES_PER_KIND = 3
PURCHASE_INSIGHT_FOOD_TYPES = {
    FoodType.READY_MADE,
    FoodType.INSTANT,
    FoodType.PACKAGED,
    FoodType.TAKEOUT,
    FoodType.DINING_OUT,
}
PURCHASE_INSIGHT_FOOD_TYPE_VALUES = {
    item.value if hasattr(item, "value") else str(item) for item in PURCHASE_INSIGHT_FOOD_TYPES
}

_KIND_ORDER = (
    MealInsightKind.FREQUENT_RECENT,
    MealInsightKind.MISSED,
    MealInsightKind.REPURCHASE,
    MealInsightKind.REPEATED_CHOICE,
)


@dataclass
class _MealLevelFact:
    meal_log_id: str
    meal_date: date
    meal_created_at: datetime
    rating: Decimal | None


@dataclass
class _FoodAggregate:
    food_id: str
    food_name: str
    food_type: str
    meals: list[_MealLevelFact]

    @property
    def meal_count(self) -> int:
        return len(self.meals)

    @property
    def last_eaten_on(self) -> date:
        return max(meal.meal_date for meal in self.meals)

    @property
    def rated_meals(self) -> list[_MealLevelFact]:
        return [meal for meal in self.meals if meal.rating is not None]

    @property
    def rating_count(self) -> int:
        return len(self.rated_meals)

    @property
    def average_rating(self) -> Decimal | None:
        rated = self.rated_meals
        if not rated:
            return None
        total = sum((meal.rating for meal in rated if meal.rating is not None), Decimal("0"))
        return (total / Decimal(len(rated))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    @property
    def latest_rating(self) -> Decimal | None:
        rated = self.rated_meals
        if not rated:
            return None
        latest = max(
            rated,
            key=lambda meal: (meal.meal_date, meal.meal_created_at, meal.meal_log_id),
        )
        return latest.rating

    def recent_meal_count(self, today: date, window_days: int) -> int:
        start = today - timedelta(days=window_days)
        return sum(1 for meal in self.meals if start <= meal.meal_date <= today)

    def days_since_last(self, today: date) -> int:
        return (today - self.last_eaten_on).days


def _normalize_food_type(value: str | FoodType) -> str:
    return value.value if hasattr(value, "value") else str(value)


def _is_purchase_type(food_type: str) -> bool:
    return _normalize_food_type(food_type) in PURCHASE_INSIGHT_FOOD_TYPE_VALUES


def _aggregate_occurrences(occurrences: Iterable[MealFoodOccurrence]) -> list[_FoodAggregate]:
    meal_groups: dict[tuple[str, str], list[MealFoodOccurrence]] = {}
    food_meta: dict[str, tuple[str, str]] = {}

    for row in occurrences:
        key = (row.meal_log_id, row.food_id)
        meal_groups.setdefault(key, []).append(row)
        food_meta[row.food_id] = (row.food_name, _normalize_food_type(row.food_type))

    meals_by_food: dict[str, list[_MealLevelFact]] = {}
    for (meal_log_id, food_id), rows in meal_groups.items():
        ratings = [row.entry_rating for row in rows if row.entry_rating is not None]
        meal_rating: Decimal | None = None
        if ratings:
            total = sum(ratings, Decimal("0"))
            meal_rating = (total / Decimal(len(ratings))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        first = rows[0]
        meals_by_food.setdefault(food_id, []).append(
            _MealLevelFact(
                meal_log_id=meal_log_id,
                meal_date=first.meal_date,
                meal_created_at=first.meal_created_at,
                rating=meal_rating,
            )
        )

    aggregates: list[_FoodAggregate] = []
    for food_id, meals in meals_by_food.items():
        food_name, food_type = food_meta[food_id]
        aggregates.append(
            _FoodAggregate(
                food_id=food_id,
                food_name=food_name,
                food_type=food_type,
                meals=meals,
            )
        )
    return aggregates


def _average_rating_float(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value)


def _build_evidence(
    aggregate: _FoodAggregate,
    *,
    meal_count: int,
    window_days: int,
) -> MealInsightEvidenceOut:
    return MealInsightEvidenceOut(
        meal_count=meal_count,
        last_eaten_on=aggregate.last_eaten_on,
        rating_count=aggregate.rating_count,
        average_rating=_average_rating_float(aggregate.average_rating),
        window_days=window_days,
    )


def _frequent_candidates(aggregates: list[_FoodAggregate], today: date) -> list[_FoodAggregate]:
    start = today - timedelta(days=RECENT_WINDOW_DAYS)
    eligible: list[tuple[_FoodAggregate, int]] = []
    for item in aggregates:
        recent_count = sum(1 for meal in item.meals if start <= meal.meal_date <= today)
        if recent_count >= FREQUENT_MIN_MEALS:
            eligible.append((item, recent_count))
    eligible.sort(
        key=lambda pair: (
            -pair[1],
            -pair[0].last_eaten_on.toordinal(),
            pair[0].food_id,
        )
    )
    return [item for item, _ in eligible[:MAX_CANDIDATES_PER_KIND]]


def _missed_candidates(aggregates: list[_FoodAggregate], today: date) -> list[_FoodAggregate]:
    eligible: list[_FoodAggregate] = []
    for item in aggregates:
        if item.meal_count < MISSED_MIN_MEALS:
            continue
        days = item.days_since_last(today)
        if RECENT_WINDOW_DAYS <= days <= MISSED_MAX_DAYS:
            eligible.append(item)
    eligible.sort(
        key=lambda item: (
            -item.meal_count,
            -item.days_since_last(today),
            item.food_id,
        )
    )
    return eligible[:MAX_CANDIDATES_PER_KIND]


def _satisfies_repurchase(item: _FoodAggregate, today: date) -> bool:
    if not _is_purchase_type(item.food_type):
        return False
    if item.rating_count < REPURCHASE_MIN_RATINGS:
        return False
    average = item.average_rating
    latest = item.latest_rating
    if average is None or latest is None:
        return False
    if average < REPURCHASE_MIN_AVERAGE:
        return False
    if latest < REPURCHASE_MIN_AVERAGE:
        return False
    if item.days_since_last(today) > MISSED_MAX_DAYS:
        return False
    return True


def _repurchase_candidates(aggregates: list[_FoodAggregate], today: date) -> list[_FoodAggregate]:
    eligible = [item for item in aggregates if _satisfies_repurchase(item, today)]
    eligible.sort(
        key=lambda item: (
            -(item.average_rating or Decimal("0")),
            -item.rating_count,
            -item.last_eaten_on.toordinal(),
            item.food_id,
        )
    )
    return eligible[:MAX_CANDIDATES_PER_KIND]


def _repeated_choice_candidates(
    aggregates: list[_FoodAggregate],
    today: date,
    *,
    repurchase_food_ids: set[str],
) -> list[_FoodAggregate]:
    start = today - timedelta(days=RECENT_WINDOW_DAYS)
    eligible: list[tuple[_FoodAggregate, int]] = []
    for item in aggregates:
        if item.food_id in repurchase_food_ids:
            continue
        if not _is_purchase_type(item.food_type):
            continue
        # Exclude any food that satisfies repurchase thresholds (even if not selected)
        if _satisfies_repurchase(item, today):
            continue
        recent_count = sum(1 for meal in item.meals if start <= meal.meal_date <= today)
        if recent_count >= REPEATED_CHOICE_MIN_MEALS:
            eligible.append((item, recent_count))
    eligible.sort(
        key=lambda pair: (
            -pair[1],
            -pair[0].last_eaten_on.toordinal(),
            pair[0].food_id,
        )
    )
    return [item for item, _ in eligible[:MAX_CANDIDATES_PER_KIND]]


def _pick_first(
    candidates: list[_FoodAggregate],
    *,
    excluded_food_ids: set[str],
) -> _FoodAggregate | None:
    for item in candidates:
        if item.food_id not in excluded_food_ids:
            return item
    return None


def _load_cover_map(db: Session, *, family_id: str, food_ids: list[str]) -> dict[str, dict | None]:
    if not food_ids:
        return {}
    assets = get_media_assets_for_entities(
        db,
        family_id=family_id,
        entity_type="food",
        entity_ids=food_ids,
    )
    media_map = build_media_map(assets)
    covers: dict[str, dict | None] = {}
    for food_id in food_ids:
        food_assets = sorted(
            media_map.get(("food", food_id), []),
            key=lambda asset: (asset.created_at or datetime.min, asset.id),
        )
        covers[food_id] = serialize_media(food_assets[0]) if food_assets else None
    return covers


def build_meal_log_insights(
    db: Session,
    *,
    family_id: str,
    today: date,
) -> list[MealInsightOut]:
    occurrences = list_meal_food_occurrences(db, family_id=family_id)
    if not occurrences:
        return []

    aggregates = _aggregate_occurrences(occurrences)
    frequent = _frequent_candidates(aggregates, today)
    missed = _missed_candidates(aggregates, today)
    repurchase = _repurchase_candidates(aggregates, today)
    repurchase_food_ids = {item.food_id for item in aggregates if _satisfies_repurchase(item, today)}
    repeated = _repeated_choice_candidates(
        aggregates,
        today,
        repurchase_food_ids=repurchase_food_ids,
    )

    # Cross-kind selection:
    # 1) repurchase is strongest for purchase foods
    # 2) repeated never includes repurchase-eligible foods (already filtered)
    # 3) frequent skips foods already selected by stronger kinds
    # 4) missed is naturally exclusive with recent kinds by window
    selected: dict[MealInsightKind, _FoodAggregate] = {}
    taken_food_ids: set[str] = set()

    repurchase_pick = _pick_first(repurchase, excluded_food_ids=taken_food_ids)
    if repurchase_pick is not None:
        selected[MealInsightKind.REPURCHASE] = repurchase_pick
        taken_food_ids.add(repurchase_pick.food_id)

    repeated_pick = _pick_first(repeated, excluded_food_ids=taken_food_ids)
    if repeated_pick is not None:
        selected[MealInsightKind.REPEATED_CHOICE] = repeated_pick
        taken_food_ids.add(repeated_pick.food_id)

    frequent_pick = _pick_first(frequent, excluded_food_ids=taken_food_ids)
    if frequent_pick is not None:
        selected[MealInsightKind.FREQUENT_RECENT] = frequent_pick
        taken_food_ids.add(frequent_pick.food_id)

    missed_pick = _pick_first(missed, excluded_food_ids=taken_food_ids)
    if missed_pick is not None:
        selected[MealInsightKind.MISSED] = missed_pick
        taken_food_ids.add(missed_pick.food_id)

    ordered_kinds = [kind for kind in _KIND_ORDER if kind in selected][:MAX_INSIGHTS]
    if not ordered_kinds:
        return []

    selected_food_ids = [selected[kind].food_id for kind in ordered_kinds]
    cover_map = _load_cover_map(db, family_id=family_id, food_ids=selected_food_ids)

    insights: list[MealInsightOut] = []
    for kind in ordered_kinds:
        item = selected[kind]
        if kind == MealInsightKind.FREQUENT_RECENT:
            meal_count = item.recent_meal_count(today, RECENT_WINDOW_DAYS)
            window_days = RECENT_WINDOW_DAYS
        elif kind == MealInsightKind.MISSED:
            meal_count = item.meal_count
            window_days = item.days_since_last(today)
        elif kind == MealInsightKind.REPURCHASE:
            meal_count = item.meal_count
            window_days = MISSED_MAX_DAYS
        else:  # repeated_choice
            meal_count = item.recent_meal_count(today, RECENT_WINDOW_DAYS)
            window_days = RECENT_WINDOW_DAYS

        insights.append(
            MealInsightOut(
                kind=kind.value,
                food=MealInsightFoodOut(
                    id=item.food_id,
                    name=item.food_name,
                    food_type=item.food_type,
                    cover=cover_map.get(item.food_id),
                ),
                evidence=_build_evidence(item, meal_count=meal_count, window_days=window_days),
            )
        )
    return insights
