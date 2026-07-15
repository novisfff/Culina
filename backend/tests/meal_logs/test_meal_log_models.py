from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine, insert, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import MealLogRecordStatus, MealLogRecordTargetKind, MealType
from app.core.utils import utcnow
from app.models.domain import Base, Family, MealLog, MealLogFood, MealLogRecordOperation, User


@pytest.fixture()
def db() -> Iterator[Session]:
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
    with SessionLocal() as session:
        family = Family(id="family-meal-model", name="餐食模型家庭", motto="", location="")
        user = User(
            id="user-meal-model",
            username="meal-model-user",
            display_name="餐食模型用户",
            avatar_seed="",
            is_active=True,
        )
        session.add_all([family, user])
        session.commit()
        yield session

    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def family(db: Session) -> Family:
    return db.get(Family, "family-meal-model")  # type: ignore[return-value]


@pytest.fixture()
def user(db: Session) -> User:
    return db.get(User, "user-meal-model")  # type: ignore[return-value]


def test_meal_log_has_integer_version_and_operation_effect_ids(db: Session, family: Family, user: User) -> None:
    meal = MealLog(
        id="meal-versioned",
        family_id=family.id,
        date=date(2026, 7, 15),
        meal_type=MealType.DINNER,
        participant_user_ids=[user.id],
        notes="",
        mood="",
        created_by=user.id,
        updated_by=user.id,
    )
    operation = MealLogRecordOperation(
        id="meal-record-op-1",
        family_id=family.id,
        client_request_id="request-1",
        request_hash="a" * 64,
        status=MealLogRecordStatus.APPLIED,
        target_kind=MealLogRecordTargetKind.NEW,
        meal_log_id=meal.id,
        created_entry_ids_json=["meal-food-1"],
        created_food_ids_json=["food-new-1"],
        result_json={"outcome": "created"},
        revert_result_json=None,
        created_by=user.id,
        applied_at=utcnow(),
        revertible_until=utcnow() + timedelta(minutes=15),
    )
    db.add_all([meal, operation])
    db.commit()
    assert meal.row_version == 1
    assert operation.created_entry_ids_json == ["meal-food-1"]
    assert operation.created_food_ids_json == ["food-new-1"]
    assert operation.meal_log_id == "meal-versioned"
    assert operation.revert_result_json is None


def test_meal_log_record_operation_client_request_id_unique_per_family(
    db: Session, family: Family, user: User
) -> None:
    applied_at = utcnow()
    first = MealLogRecordOperation(
        id="meal-record-op-unique-1",
        family_id=family.id,
        client_request_id="request-unique",
        request_hash="b" * 64,
        status=MealLogRecordStatus.APPLIED,
        target_kind=MealLogRecordTargetKind.NEW,
        meal_log_id="meal-unique-1",
        created_entry_ids_json=[],
        created_food_ids_json=[],
        result_json={"outcome": "created"},
        created_by=user.id,
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
    )
    db.add(first)
    db.commit()

    db.add(
        MealLogRecordOperation(
            id="meal-record-op-unique-2",
            family_id=family.id,
            client_request_id="request-unique",
            request_hash="c" * 64,
            status=MealLogRecordStatus.APPLIED,
            target_kind=MealLogRecordTargetKind.EXISTING,
            meal_log_id="meal-unique-2",
            created_entry_ids_json=[],
            created_food_ids_json=[],
            result_json={"outcome": "appended"},
            created_by=user.id,
            applied_at=applied_at,
            revertible_until=applied_at + timedelta(minutes=15),
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_meal_log_record_operation_meal_log_id_is_not_null_and_survives_meal_delete(
    db: Session, family: Family, user: User
) -> None:
    meal = MealLog(
        id="meal-survives",
        family_id=family.id,
        date=date(2026, 7, 15),
        meal_type=MealType.LUNCH,
        participant_user_ids=[user.id],
        notes="",
        mood="",
        created_by=user.id,
        updated_by=user.id,
    )
    applied_at = utcnow()
    operation = MealLogRecordOperation(
        id="meal-record-op-survives",
        family_id=family.id,
        client_request_id="request-survives",
        request_hash="d" * 64,
        status=MealLogRecordStatus.APPLIED,
        target_kind=MealLogRecordTargetKind.NEW,
        meal_log_id=meal.id,
        created_entry_ids_json=["meal-food-survives"],
        created_food_ids_json=[],
        result_json={"outcome": "created"},
        created_by=user.id,
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
    )
    db.add_all([meal, operation])
    db.commit()

    db.delete(meal)
    db.commit()
    db.refresh(operation)
    assert operation.meal_log_id == "meal-survives"

    meal_log_id_column = MealLogRecordOperation.__table__.c.meal_log_id
    assert meal_log_id_column.nullable is False
    assert len(meal_log_id_column.foreign_keys) == 0

    with pytest.raises(IntegrityError):
        db.execute(
            insert(MealLogRecordOperation).values(
                id="meal-record-op-null-meal",
                family_id=family.id,
                client_request_id="request-null-meal",
                request_hash="e" * 64,
                status=MealLogRecordStatus.APPLIED.value,
                target_kind=MealLogRecordTargetKind.NEW.value,
                meal_log_id=None,
                created_entry_ids_json=[],
                created_food_ids_json=[],
                result_json={"outcome": "created"},
                created_by=user.id,
                applied_at=applied_at,
                revertible_until=applied_at + timedelta(minutes=15),
                created_at=applied_at,
                updated_at=applied_at,
            )
        )
        db.flush()
    db.rollback()


def test_meal_log_record_operation_revert_result_json_is_nullable(
    db: Session, family: Family, user: User
) -> None:
    applied_at = utcnow()
    operation = MealLogRecordOperation(
        id="meal-record-op-nullable-revert",
        family_id=family.id,
        client_request_id="request-nullable-revert",
        request_hash="f" * 64,
        status=MealLogRecordStatus.APPLIED,
        target_kind=MealLogRecordTargetKind.NEW,
        meal_log_id="meal-nullable-revert",
        created_entry_ids_json=[],
        created_food_ids_json=[],
        result_json={"outcome": "created"},
        revert_result_json=None,
        created_by=user.id,
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
    )
    db.add(operation)
    db.commit()
    db.refresh(operation)

    assert operation.revert_result_json is None
    assert MealLogRecordOperation.__table__.c.revert_result_json.nullable is True
    assert MealLogRecordOperation.__table__.c.result_json.nullable is False


def test_meal_log_read_indexes_exist() -> None:
    meal_log_indexes = {index.name: index for index in MealLog.__table__.indexes}
    meal_log_food_indexes = {index.name: index for index in MealLogFood.__table__.indexes}

    family_date_type_created = meal_log_indexes["ix_meal_logs_family_date_type_created"]
    assert [column.name for column in family_date_type_created.columns] == [
        "family_id",
        "date",
        "meal_type",
        "created_at",
    ]

    log_food = meal_log_food_indexes["ix_meal_log_foods_log_food"]
    assert [column.name for column in log_food.columns] == ["meal_log_id", "food_id"]
    assert log_food.unique is False


def test_meal_log_version_column_and_mapper_configured() -> None:
    assert MealLog.__mapper__.version_id_col is not None
    assert MealLog.__mapper__.version_id_col.key == "row_version"
    columns = {column.name for column in inspect(MealLog).columns}
    assert "row_version" in columns


def test_meal_log_record_status_and_target_kind_enum_values() -> None:
    assert MealLogRecordStatus.APPLIED.value == "applied"
    assert MealLogRecordStatus.REVERTED.value == "reverted"
    assert MealLogRecordTargetKind.NEW.value == "new"
    assert MealLogRecordTargetKind.EXISTING.value == "existing"
