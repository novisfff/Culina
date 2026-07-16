from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import FoodType, MealType, MediaSource, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Food, MealLog, MealLogFood, MediaAsset, Membership, User
from app.services import clock as clock_service


TODAY = date(2026, 7, 15)


@dataclass
class InsightHarness:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    owner_id: str


def _food_kwargs(food_id: str, family_id: str, name: str, food_type: FoodType, owner_id: str) -> dict[str, Any]:
    return {
        "id": food_id,
        "family_id": family_id,
        "name": name,
        "type": food_type,
        "category": "测试",
        "flavor_tags": [],
        "scene_tags": [],
        "suitable_meal_types": ["dinner"],
        "source_name": "",
        "purchase_source": "",
        "scene": "",
        "notes": "",
        "routine_note": "",
        "stock_unit": "",
        "favorite": False,
        "created_by": owner_id,
        "updated_by": owner_id,
    }


def _meal(
    meal_id: str,
    family_id: str,
    meal_date: date,
    owner_id: str,
    *,
    created_at: datetime | None = None,
    meal_type: MealType = MealType.DINNER,
) -> MealLog:
    stamp = created_at or datetime(
        meal_date.year,
        meal_date.month,
        meal_date.day,
        12,
        0,
        0,
        tzinfo=timezone.utc,
    )
    return MealLog(
        id=meal_id,
        family_id=family_id,
        date=meal_date,
        meal_type=meal_type,
        participant_user_ids=[owner_id],
        notes="",
        mood="",
        row_version=1,
        created_at=stamp,
        updated_at=stamp,
        created_by=owner_id,
        updated_by=owner_id,
    )


def _entry(
    entry_id: str,
    meal_log_id: str,
    food_id: str,
    *,
    rating: Decimal | float | None = None,
    created_at: datetime | None = None,
) -> MealLogFood:
    return MealLogFood(
        id=entry_id,
        meal_log_id=meal_log_id,
        food_id=food_id,
        servings=Decimal("1"),
        note="",
        rating=Decimal(str(rating)) if rating is not None else None,
        created_at=created_at or datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc),
    )


@pytest.fixture()
def harness() -> Iterator[InsightHarness]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )

    family_id = "family-main"
    other_family_id = "family-other"
    owner_id = "user-owner"
    other_user_id = "user-other"

    with SessionLocal() as db:
        db.add_all(
            [
                Family(id=family_id, name="主家庭", motto="", location=""),
                Family(id=other_family_id, name="其他家庭", motto="", location=""),
                User(id=owner_id, username="owner", display_name="Owner", avatar_seed="", is_active=True),
                User(id=other_user_id, username="other", display_name="Other", avatar_seed="", is_active=True),
                Membership(
                    id="membership-owner",
                    family_id=family_id,
                    user_id=owner_id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                Membership(
                    id="membership-other",
                    family_id=other_family_id,
                    user_id=other_user_id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth(db: Session = Depends(get_db)) -> tuple[User, Membership]:
        user = db.get(User, owner_id)
        membership = db.get(Membership, "membership-owner")
        assert user is not None
        assert membership is not None
        return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    original_now_utc = clock_service.now_utc
    clock_service.now_utc = lambda: datetime(2026, 7, 15, 4, 0, 0, tzinfo=timezone.utc)  # type: ignore[assignment]

    try:
        yield InsightHarness(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id=family_id,
            other_family_id=other_family_id,
            owner_id=owner_id,
        )
    finally:
        clock_service.now_utc = original_now_utc  # type: ignore[assignment]
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _add_food(
    db: Session,
    *,
    food_id: str,
    family_id: str,
    owner_id: str,
    name: str,
    food_type: FoodType,
) -> Food:
    food = Food(**_food_kwargs(food_id, family_id, name, food_type, owner_id))
    db.add(food)
    return food


def _seed_meals_for_food(
    db: Session,
    *,
    food_id: str,
    family_id: str,
    owner_id: str,
    meal_dates: list[date],
    ratings_by_meal: dict[date, list[Decimal | float | None]] | None = None,
    id_prefix: str = "m",
) -> None:
    ratings_by_meal = ratings_by_meal or {}
    for index, meal_date in enumerate(meal_dates):
        meal_id = f"{id_prefix}-{food_id}-{index}"
        created_at = datetime(
            meal_date.year,
            meal_date.month,
            meal_date.day,
            12,
            index % 12,
            0,
            tzinfo=timezone.utc,
        )
        db.add(_meal(meal_id, family_id, meal_date, owner_id, created_at=created_at))
        ratings = ratings_by_meal.get(meal_date, [None])
        for entry_index, rating in enumerate(ratings):
            db.add(
                _entry(
                    f"e-{meal_id}-{entry_index}",
                    meal_id,
                    food_id,
                    rating=rating,
                    created_at=created_at,
                )
            )


def test_insights_use_distinct_meals_and_meal_level_rating_average(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-ready",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="即食鸡胸",
            food_type=FoodType.READY_MADE,
        )
        # Meal 1: duplicate entries 5.0 and 4.0 → meal-level 4.5
        # Meal 2: single 4.0 → meal-level 4.0
        # average = 4.25, rating_count=2, meal_count=2
        day1 = TODAY - timedelta(days=5)
        day2 = TODAY - timedelta(days=10)
        meal1 = _meal("meal-dup-1", harness.family_id, day1, harness.owner_id)
        meal2 = _meal("meal-dup-2", harness.family_id, day2, harness.owner_id)
        db.add_all(
            [
                meal1,
                meal2,
                _entry("e1a", meal1.id, "food-ready", rating=5.0),
                _entry("e1b", meal1.id, "food-ready", rating=4.0),
                _entry("e2a", meal2.id, "food-ready", rating=4.0),
            ]
        )
        db.commit()

    response = harness.client.get("/api/meal-logs/insights")
    assert response.status_code == 200
    repurchase = next(item for item in response.json() if item["kind"] == "repurchase")
    assert repurchase["evidence"]["meal_count"] == 2
    assert repurchase["evidence"]["rating_count"] == 2
    assert repurchase["evidence"]["average_rating"] == 4.25
    assert repurchase["food"]["id"] == "food-ready"
    assert "值得回购" not in response.text  # no prewritten marketing sentences


@pytest.mark.parametrize(
    ("meal_count", "expect_frequent"),
    [
        (2, False),
        (3, True),
    ],
)
def test_frequent_recent_threshold(
    harness: InsightHarness,
    meal_count: int,
    expect_frequent: bool,
) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-freq",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="番茄炒蛋",
            food_type=FoodType.SELF_MADE,
        )
        dates = [TODAY - timedelta(days=i) for i in range(meal_count)]
        _seed_meals_for_food(
            db,
            food_id="food-freq",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=dates,
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    kinds = [item["kind"] for item in payload]
    if expect_frequent:
        assert "frequent_recent" in kinds
        frequent = next(item for item in payload if item["kind"] == "frequent_recent")
        assert frequent["evidence"]["meal_count"] == meal_count
        assert frequent["evidence"]["window_days"] == 30
        assert frequent["evidence"]["last_eaten_on"] == TODAY.isoformat()
    else:
        assert "frequent_recent" not in kinds


@pytest.mark.parametrize(
    ("history_count", "expect_missed"),
    [
        (1, False),
        (2, True),
    ],
)
def test_missed_history_threshold(
    harness: InsightHarness,
    history_count: int,
    expect_missed: bool,
) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-missed",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="红烧肉",
            food_type=FoodType.SELF_MADE,
        )
        # last eaten 45 days ago; older meals further back
        last = TODAY - timedelta(days=45)
        dates = [last - timedelta(days=10 * i) for i in range(history_count)]
        _seed_meals_for_food(
            db,
            food_id="food-missed",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=dates,
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    kinds = [item["kind"] for item in payload]
    if expect_missed:
        assert "missed" in kinds
        missed = next(item for item in payload if item["kind"] == "missed")
        assert missed["evidence"]["meal_count"] == history_count
        assert missed["evidence"]["last_eaten_on"] == last.isoformat()
    else:
        assert "missed" not in kinds


@pytest.mark.parametrize(
    ("days_ago", "expect_missed"),
    [
        (29, False),  # still inside recent window
        (30, True),
        (180, True),
        (181, False),  # too old
    ],
)
def test_missed_day_boundaries(
    harness: InsightHarness,
    days_ago: int,
    expect_missed: bool,
) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-boundary",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="边界菜",
            food_type=FoodType.SELF_MADE,
        )
        last = TODAY - timedelta(days=days_ago)
        older = last - timedelta(days=20)
        _seed_meals_for_food(
            db,
            food_id="food-boundary",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[last, older],
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    kinds = [item["kind"] for item in payload]
    assert ("missed" in kinds) is expect_missed


@pytest.mark.parametrize(
    ("rating_count", "average", "latest", "days_ago", "expect_repurchase"),
    [
        (1, 5.0, 5.0, 10, False),  # need >= 2 ratings
        # Numeric(2,1) stores half-star ratings; 3.5 + 4.0 => meal average 3.75 < 4.0
        (2, 3.75, 4.0, 10, False),  # average below 4.0
        (2, 4.0, 3.5, 10, False),  # latest below 4.0
        (2, 4.0, 4.0, 181, False),  # too old
        (2, 4.0, 4.0, 180, True),
        (2, 4.0, 4.0, 10, True),
    ],
)
def test_repurchase_thresholds(
    harness: InsightHarness,
    rating_count: int,
    average: float,
    latest: float,
    days_ago: int,
    expect_repurchase: bool,
) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-buy",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="回购候选",
            food_type=FoodType.PACKAGED,
        )
        # Construct meal-level ratings so average and latest match parameters.
        # latest meal is most recent; earlier meal(s) fill rating_count.
        latest_day = TODAY - timedelta(days=days_ago)
        if rating_count == 1:
            ratings_by_meal = {latest_day: [latest]}
            dates = [latest_day]
        else:
            older_day = latest_day - timedelta(days=5)
            # average of [other, latest] == average
            # other = 2*average - latest
            other = round(2 * average - latest, 2)
            ratings_by_meal = {
                older_day: [other],
                latest_day: [latest],
            }
            dates = [older_day, latest_day]
        _seed_meals_for_food(
            db,
            food_id="food-buy",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=dates,
            ratings_by_meal=ratings_by_meal,
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    kinds = [item["kind"] for item in payload]
    assert ("repurchase" in kinds) is expect_repurchase
    if expect_repurchase:
        item = next(row for row in payload if row["kind"] == "repurchase")
        assert item["evidence"]["rating_count"] == rating_count
        assert item["evidence"]["average_rating"] == pytest.approx(average)
        assert item["evidence"]["last_eaten_on"] == latest_day.isoformat()


@pytest.mark.parametrize(
    ("recent_count", "expect_repeated"),
    [
        (1, False),
        (2, True),
    ],
)
def test_repeated_choice_threshold(
    harness: InsightHarness,
    recent_count: int,
    expect_repeated: bool,
) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-repeat",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="常选外卖",
            food_type=FoodType.TAKEOUT,
        )
        # No ratings → cannot satisfy repurchase; only repeated_choice
        dates = [TODAY - timedelta(days=i) for i in range(recent_count)]
        _seed_meals_for_food(
            db,
            food_id="food-repeat",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=dates,
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    kinds = [item["kind"] for item in payload]
    assert ("repeated_choice" in kinds) is expect_repeated


@pytest.mark.parametrize(
    "food_type",
    [
        FoodType.READY_MADE,
        FoodType.INSTANT,
        FoodType.PACKAGED,
        FoodType.TAKEOUT,
        FoodType.DINING_OUT,
    ],
)
def test_purchase_insight_food_types_eligible(harness: InsightHarness, food_type: FoodType) -> None:
    with harness.SessionLocal() as db:
        food_id = f"food-{food_type.value}"
        _add_food(
            db,
            food_id=food_id,
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name=f"类型{food_type.value}",
            food_type=food_type,
        )
        day1 = TODAY - timedelta(days=3)
        day2 = TODAY - timedelta(days=8)
        _seed_meals_for_food(
            db,
            food_id=food_id,
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[day1, day2],
            ratings_by_meal={day1: [4.5], day2: [4.5]},
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert any(item["kind"] == "repurchase" and item["food"]["id"] == food_id for item in payload)


def test_self_made_not_eligible_for_purchase_insights(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-home",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="家常菜",
            food_type=FoodType.SELF_MADE,
        )
        day1 = TODAY - timedelta(days=2)
        day2 = TODAY - timedelta(days=4)
        _seed_meals_for_food(
            db,
            food_id="food-home",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[day1, day2],
            ratings_by_meal={day1: [5.0], day2: [5.0]},
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert not any(item["kind"] in {"repurchase", "repeated_choice"} for item in payload)


def test_asia_shanghai_utc_boundary_for_today(harness: InsightHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    # UTC 2026-07-14 16:00 → Asia/Shanghai 2026-07-15 00:00 → business today is 2026-07-15
    monkeypatch.setattr(
        clock_service,
        "now_utc",
        lambda: datetime(2026, 7, 14, 16, 0, 0, tzinfo=timezone.utc),
    )
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-tz",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="时区菜",
            food_type=FoodType.SELF_MADE,
        )
        # Exactly 30 days before Shanghai today 2026-07-15 → 2026-06-15 is boundary for missed
        last = date(2026, 6, 15)
        older = date(2026, 6, 1)
        _seed_meals_for_food(
            db,
            food_id="food-tz",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[last, older],
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert any(item["kind"] == "missed" and item["food"]["id"] == "food-tz" for item in payload)

    # One minute earlier still Shanghai 2026-07-14; last=2026-06-15 is only 29 days ago → not missed
    monkeypatch.setattr(
        clock_service,
        "now_utc",
        lambda: datetime(2026, 7, 14, 15, 59, 0, tzinfo=timezone.utc),
    )
    payload_before = harness.client.get("/api/meal-logs/insights").json()
    assert not any(item["kind"] == "missed" and item["food"]["id"] == "food-tz" for item in payload_before)


def test_selection_order_max_four_one_per_kind(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        # frequent: self-made eaten 3 times recently
        _add_food(
            db,
            food_id="food-freq-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="常吃A",
            food_type=FoodType.SELF_MADE,
        )
        _seed_meals_for_food(
            db,
            food_id="food-freq-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=i) for i in range(3)],
            id_prefix="freq",
        )

        # missed: history 2+, last 60 days ago
        _add_food(
            db,
            food_id="food-miss-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="想念A",
            food_type=FoodType.SELF_MADE,
        )
        missed_last = TODAY - timedelta(days=60)
        _seed_meals_for_food(
            db,
            food_id="food-miss-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[missed_last, missed_last - timedelta(days=20)],
            id_prefix="miss",
        )

        # repurchase: purchase type with good ratings
        _add_food(
            db,
            food_id="food-buy-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="回购A",
            food_type=FoodType.INSTANT,
        )
        buy_d1 = TODAY - timedelta(days=4)
        buy_d2 = TODAY - timedelta(days=12)
        _seed_meals_for_food(
            db,
            food_id="food-buy-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[buy_d1, buy_d2],
            ratings_by_meal={buy_d1: [4.5], buy_d2: [4.0]},
            id_prefix="buy",
        )

        # repeated: purchase type recent 2+, no ratings
        _add_food(
            db,
            food_id="food-rep-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="常选A",
            food_type=FoodType.TAKEOUT,
        )
        _seed_meals_for_food(
            db,
            food_id="food-rep-a",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=1), TODAY - timedelta(days=6)],
            id_prefix="rep",
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert len(payload) == 4
    assert [item["kind"] for item in payload] == [
        "frequent_recent",
        "missed",
        "repurchase",
        "repeated_choice",
    ]
    assert len({item["kind"] for item in payload}) == 4
    assert len({item["food"]["id"] for item in payload}) == 4


def test_repurchase_excludes_same_food_from_repeated_and_frequent_selects_next(
    harness: InsightHarness,
) -> None:
    with harness.SessionLocal() as db:
        # Food that qualifies for repurchase AND frequent AND repeated (3 recent meals + ratings)
        _add_food(
            db,
            food_id="food-strong",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="强证据",
            food_type=FoodType.READY_MADE,
        )
        strong_dates = [TODAY - timedelta(days=i) for i in range(3)]
        _seed_meals_for_food(
            db,
            food_id="food-strong",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=strong_dates,
            ratings_by_meal={
                strong_dates[0]: [5.0],
                strong_dates[1]: [4.5],
                strong_dates[2]: [4.0],
            },
            id_prefix="strong",
        )

        # Next frequent candidate (self-made, 3 recent)
        _add_food(
            db,
            food_id="food-next-freq",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="次常吃",
            food_type=FoodType.SELF_MADE,
        )
        _seed_meals_for_food(
            db,
            food_id="food-next-freq",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=i) for i in range(3)],
            id_prefix="nextf",
        )

        # Separate repeated candidate without ratings
        _add_food(
            db,
            food_id="food-next-rep",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="次常选",
            food_type=FoodType.DINING_OUT,
        )
        _seed_meals_for_food(
            db,
            food_id="food-next-rep",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=2), TODAY - timedelta(days=7)],
            id_prefix="nextr",
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    by_kind = {item["kind"]: item for item in payload}
    assert by_kind["repurchase"]["food"]["id"] == "food-strong"
    assert by_kind["frequent_recent"]["food"]["id"] == "food-next-freq"
    assert by_kind["repeated_choice"]["food"]["id"] == "food-next-rep"
    assert all(item["food"]["id"] != "food-strong" for item in payload if item["kind"] != "repurchase")


def test_frequent_tie_break_uses_last_date_then_food_id(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        # Same meal count=3; food-b has more recent last_eaten → wins
        for food_id, name, last_offset in [
            ("food-a", "菜A", 2),
            ("food-b", "菜B", 1),
        ]:
            _add_food(
                db,
                food_id=food_id,
                family_id=harness.family_id,
                owner_id=harness.owner_id,
                name=name,
                food_type=FoodType.SELF_MADE,
            )
            dates = [TODAY - timedelta(days=last_offset + i) for i in range(3)]
            _seed_meals_for_food(
                db,
                food_id=food_id,
                family_id=harness.family_id,
                owner_id=harness.owner_id,
                meal_dates=dates,
                id_prefix=food_id,
            )

        # Same last date and count: lower food id wins
        for food_id, name in [("food-z", "菜Z"), ("food-y", "菜Y")]:
            _add_food(
                db,
                food_id=food_id,
                family_id=harness.family_id,
                owner_id=harness.owner_id,
                name=name,
                food_type=FoodType.SELF_MADE,
            )
            dates = [TODAY - timedelta(days=5 + i) for i in range(3)]
            _seed_meals_for_food(
                db,
                food_id=food_id,
                family_id=harness.family_id,
                owner_id=harness.owner_id,
                meal_dates=dates,
                id_prefix=food_id,
            )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    frequent = next(item for item in payload if item["kind"] == "frequent_recent")
    assert frequent["food"]["id"] == "food-b"


def test_insufficient_evidence_returns_empty(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-once",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="只吃一次",
            food_type=FoodType.SELF_MADE,
        )
        _seed_meals_for_food(
            db,
            food_id="food-once",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=1)],
        )
        db.commit()

    response = harness.client.get("/api/meal-logs/insights")
    assert response.status_code == 200
    assert response.json() == []


def test_cross_family_meal_food_media_never_leaks(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-main",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="主家庭菜",
            food_type=FoodType.PACKAGED,
        )
        day1 = TODAY - timedelta(days=2)
        day2 = TODAY - timedelta(days=5)
        _seed_meals_for_food(
            db,
            food_id="food-main",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[day1, day2],
            ratings_by_meal={day1: [4.5], day2: [4.5]},
        )
        db.add(
            MediaAsset(
                id="media-main",
                family_id=harness.family_id,
                name="main.png",
                url="/media/family-main/main.png",
                file_path="family-main/main.png",
                source=MediaSource.UPLOAD,
                alt="主封面",
                entity_type="food",
                entity_id="food-main",
                created_by=harness.owner_id,
                created_at=datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc),
            )
        )

        # Other family has stronger stats and media that must never appear
        other_owner = "user-other"
        _add_food(
            db,
            food_id="food-other",
            family_id=harness.other_family_id,
            owner_id=other_owner,
            name="外家庭菜",
            food_type=FoodType.PACKAGED,
        )
        _seed_meals_for_food(
            db,
            food_id="food-other",
            family_id=harness.other_family_id,
            owner_id=other_owner,
            meal_dates=[TODAY - timedelta(days=i) for i in range(5)],
            ratings_by_meal={TODAY - timedelta(days=i): [5.0] for i in range(5)},
            id_prefix="other",
        )
        db.add(
            MediaAsset(
                id="media-other",
                family_id=harness.other_family_id,
                name="other.png",
                url="/media/family-other/other.png",
                file_path="family-other/other.png",
                source=MediaSource.UPLOAD,
                alt="外家庭封面",
                entity_type="food",
                entity_id="food-other",
                created_by=other_owner,
                created_at=datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc),
            )
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert payload
    food_ids = {item["food"]["id"] for item in payload}
    assert "food-other" not in food_ids
    assert "food-main" in food_ids
    for item in payload:
        cover = item["food"].get("cover")
        if cover is not None:
            assert cover["id"] != "media-other"
            assert "family-other" not in cover["url"]
    body = response_text = harness.client.get("/api/meal-logs/insights").text
    assert "food-other" not in body
    assert "media-other" not in body
    assert "外家庭" not in body
    del response_text


def test_cover_media_only_for_selected_foods(harness: InsightHarness) -> None:
    with harness.SessionLocal() as db:
        _add_food(
            db,
            food_id="food-selected",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="入选",
            food_type=FoodType.READY_MADE,
        )
        day1 = TODAY - timedelta(days=1)
        day2 = TODAY - timedelta(days=3)
        _seed_meals_for_food(
            db,
            food_id="food-selected",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[day1, day2],
            ratings_by_meal={day1: [4.5], day2: [4.5]},
        )
        db.add(
            MediaAsset(
                id="cover-selected",
                family_id=harness.family_id,
                name="selected.png",
                url="/media/family-main/selected.png",
                file_path="family-main/selected.png",
                source=MediaSource.UPLOAD,
                alt="入选封面",
                entity_type="food",
                entity_id="food-selected",
                created_by=harness.owner_id,
                created_at=datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc),
            )
        )

        # Non-selected food with media should not force media load leakage into response
        _add_food(
            db,
            food_id="food-not-selected",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            name="未入选",
            food_type=FoodType.SELF_MADE,
        )
        _seed_meals_for_food(
            db,
            food_id="food-not-selected",
            family_id=harness.family_id,
            owner_id=harness.owner_id,
            meal_dates=[TODAY - timedelta(days=1)],
        )
        db.add(
            MediaAsset(
                id="cover-not-selected",
                family_id=harness.family_id,
                name="not.png",
                url="/media/family-main/not.png",
                file_path="family-main/not.png",
                source=MediaSource.UPLOAD,
                alt="未入选封面",
                entity_type="food",
                entity_id="food-not-selected",
                created_by=harness.owner_id,
                created_at=datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc),
            )
        )
        db.commit()

    payload = harness.client.get("/api/meal-logs/insights").json()
    assert len(payload) == 1
    assert payload[0]["food"]["id"] == "food-selected"
    assert payload[0]["food"]["cover"]["id"] == "cover-selected"
    assert "cover-not-selected" not in harness.client.get("/api/meal-logs/insights").text
