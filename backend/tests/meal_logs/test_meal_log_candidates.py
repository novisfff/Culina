from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

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


@dataclass(frozen=True)
class CandidateSeed:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str


@pytest.fixture()
def seed_candidates() -> Iterator[CandidateSeed]:
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

    older_created = datetime(2026, 7, 15, 10, 0, 0, tzinfo=timezone.utc)
    newer_created = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
    tie_created = datetime(2026, 7, 15, 11, 0, 0, tzinfo=timezone.utc)

    with SessionLocal() as db:
        family = Family(id="family-main", name="主家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        owner = User(id="user-owner", username="owner", display_name="Owner", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other", display_name="Other", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-owner",
            family_id=family.id,
            user_id=owner.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )

        tomato = Food(
            id="food-tomato",
            family_id=family.id,
            name="番茄炒蛋",
            type=FoodType.SELF_MADE,
            category="家常",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        soup = Food(
            id="food-soup",
            family_id=family.id,
            name="紫菜汤",
            type=FoodType.SELF_MADE,
            category="汤",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        plain = Food(
            id="food-plain",
            family_id=family.id,
            name="白粥",
            type=FoodType.SELF_MADE,
            category="主食",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        other_food = Food(
            id="food-other",
            family_id=other_family.id,
            name="外家庭菜",
            type=FoodType.TAKEOUT,
            category="外卖",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=other_user.id,
            updated_by=other_user.id,
        )

        meal_newer = MealLog(
            id="meal-newer",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=newer_created,
            updated_at=newer_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_older = MealLog(
            id="meal-older",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=2,
            created_at=older_created,
            updated_at=older_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_tie_b = MealLog(
            id="meal-tie-b",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=tie_created,
            updated_at=tie_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_tie_a = MealLog(
            id="meal-tie-a",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=tie_created,
            updated_at=tie_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_no_media = MealLog(
            id="meal-no-media",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=datetime(2026, 7, 15, 8, 0, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 7, 15, 8, 0, 0, tzinfo=timezone.utc),
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_lunch = MealLog(
            id="meal-lunch",
            family_id=family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.LUNCH,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=newer_created,
            updated_at=newer_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_other_date = MealLog(
            id="meal-other-date",
            family_id=family.id,
            date=date(2026, 7, 14),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            row_version=1,
            created_at=newer_created,
            updated_at=newer_created,
            created_by=owner.id,
            updated_by=owner.id,
        )
        meal_other_family = MealLog(
            id="meal-other-family",
            family_id=other_family.id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=[other_user.id],
            notes="",
            mood="",
            row_version=1,
            created_at=newer_created,
            updated_at=newer_created,
            created_by=other_user.id,
            updated_by=other_user.id,
        )

        entries = [
            MealLogFood(
                id="entry-newer",
                meal_log_id=meal_newer.id,
                food_id=tomato.id,
                servings=Decimal("1"),
                note="",
                created_at=newer_created,
            ),
            MealLogFood(
                id="entry-older",
                meal_log_id=meal_older.id,
                food_id=soup.id,
                servings=Decimal("1"),
                note="",
                created_at=older_created,
            ),
            MealLogFood(
                id="entry-tie-a",
                meal_log_id=meal_tie_a.id,
                food_id=plain.id,
                servings=Decimal("1"),
                note="",
                created_at=tie_created,
            ),
            MealLogFood(
                id="entry-tie-b",
                meal_log_id=meal_tie_b.id,
                food_id=plain.id,
                servings=Decimal("1"),
                note="",
                created_at=tie_created,
            ),
            MealLogFood(
                id="entry-no-media",
                meal_log_id=meal_no_media.id,
                food_id=plain.id,
                servings=Decimal("1"),
                note="",
                created_at=datetime(2026, 7, 15, 8, 0, 0, tzinfo=timezone.utc),
            ),
            MealLogFood(
                id="entry-lunch",
                meal_log_id=meal_lunch.id,
                food_id=tomato.id,
                servings=Decimal("1"),
                note="",
                created_at=newer_created,
            ),
            MealLogFood(
                id="entry-other-date",
                meal_log_id=meal_other_date.id,
                food_id=tomato.id,
                servings=Decimal("1"),
                note="",
                created_at=newer_created,
            ),
            MealLogFood(
                id="entry-other-family",
                meal_log_id=meal_other_family.id,
                food_id=other_food.id,
                servings=Decimal("1"),
                note="",
                created_at=newer_created,
            ),
        ]

        media = [
            MediaAsset(
                id="meal-photo",
                family_id=family.id,
                name="meal.png",
                url="/media/family-main/meal.png",
                file_path="family-main/meal.png",
                source=MediaSource.UPLOAD,
                alt="餐食照片",
                entity_type="meal_log",
                entity_id=meal_newer.id,
                created_by=owner.id,
                created_at=newer_created,
            ),
            MediaAsset(
                id="meal-photo-extra",
                family_id=family.id,
                name="meal-extra.png",
                url="/media/family-main/meal-extra.png",
                file_path="family-main/meal-extra.png",
                source=MediaSource.UPLOAD,
                alt="第二张餐食照片",
                entity_type="meal_log",
                entity_id=meal_newer.id,
                created_by=owner.id,
                created_at=datetime(2026, 7, 15, 12, 5, 0, tzinfo=timezone.utc),
            ),
            MediaAsset(
                id="food-cover",
                family_id=family.id,
                name="soup.png",
                url="/media/family-main/soup.png",
                file_path="family-main/soup.png",
                source=MediaSource.UPLOAD,
                alt="菜品封面",
                entity_type="food",
                entity_id=soup.id,
                created_by=owner.id,
                created_at=older_created,
            ),
            MediaAsset(
                id="other-family-meal-photo",
                family_id=other_family.id,
                name="other.png",
                url="/media/family-other/other.png",
                file_path="family-other/other.png",
                source=MediaSource.UPLOAD,
                alt="外家庭餐食",
                entity_type="meal_log",
                entity_id=meal_other_family.id,
                created_by=other_user.id,
                created_at=newer_created,
            ),
        ]

        db.add_all(
            [
                family,
                other_family,
                owner,
                other_user,
                membership,
                other_membership,
                tomato,
                soup,
                plain,
                other_food,
                meal_newer,
                meal_older,
                meal_tie_a,
                meal_tie_b,
                meal_no_media,
                meal_lunch,
                meal_other_date,
                meal_other_family,
                *entries,
                *media,
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
        user = db.get(User, "user-owner")
        membership = db.get(Membership, "membership-owner")
        assert user is not None
        assert membership is not None
        return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield CandidateSeed(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-main",
            other_family_id="family-other",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_candidates_return_every_matching_family_meal_in_stable_order(seed_candidates: CandidateSeed) -> None:
    client = seed_candidates.client
    response = client.get("/api/meal-logs/candidates?date=2026-07-15&meal_type=dinner")
    assert response.status_code == 200
    payload = response.json()

    assert [item["meal_log_id"] for item in payload] == [
        "meal-newer",
        "meal-tie-a",
        "meal-tie-b",
        "meal-older",
        "meal-no-media",
    ]

    by_id = {item["meal_log_id"]: item for item in payload}

    newer = by_id["meal-newer"]
    assert newer["row_version"] == 1
    assert newer["date"] == "2026-07-15"
    assert newer["meal_type"] == "dinner"
    assert newer["foods"][0]["name"] == "番茄炒蛋"
    assert newer["foods"][0]["food_id"] == "food-tomato"
    assert newer["foods"][0]["food_type"] == "selfMade"
    assert newer["preview_media"]["id"] == "meal-photo"
    assert newer["photo_count"] == 2

    older = by_id["meal-older"]
    assert older["foods"][0]["name"] == "紫菜汤"
    assert older["foods"][0]["cover"]["id"] == "food-cover"
    assert older["preview_media"]["id"] == "food-cover"
    assert older["photo_count"] == 0

    no_media = by_id["meal-no-media"]
    assert no_media["preview_media"] is None
    assert no_media["foods"][0]["cover"] is None
    assert no_media["photo_count"] == 0

    returned_ids = {item["meal_log_id"] for item in payload}
    assert "meal-lunch" not in returned_ids
    assert "meal-other-date" not in returned_ids
    assert "meal-other-family" not in returned_ids


def test_candidates_exclude_other_family_date_and_meal_type(seed_candidates: CandidateSeed) -> None:
    client = seed_candidates.client

    lunch = client.get("/api/meal-logs/candidates?date=2026-07-15&meal_type=lunch")
    assert lunch.status_code == 200
    assert [item["meal_log_id"] for item in lunch.json()] == ["meal-lunch"]

    other_date = client.get("/api/meal-logs/candidates?date=2026-07-14&meal_type=dinner")
    assert other_date.status_code == 200
    assert [item["meal_log_id"] for item in other_date.json()] == ["meal-other-date"]

    empty = client.get("/api/meal-logs/candidates?date=2026-07-16&meal_type=dinner")
    assert empty.status_code == 200
    assert empty.json() == []


def test_candidates_require_date_and_meal_type(seed_candidates: CandidateSeed) -> None:
    client = seed_candidates.client
    missing_date = client.get("/api/meal-logs/candidates?meal_type=dinner")
    assert missing_date.status_code == 422

    missing_type = client.get("/api/meal-logs/candidates?date=2026-07-15")
    assert missing_type.status_code == 422
