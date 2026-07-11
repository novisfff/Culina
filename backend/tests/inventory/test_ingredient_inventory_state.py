from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import (
    ActivityAction,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    InventoryStatus,
)
from app.core.utils import utcnow
from app.models.domain import (
    Base,
    Family,
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    InventoryOperationLine,
    ShoppingListItem,
    User,
)


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
        family = Family(id="family-1", name="测试家庭", motto="", location="")
        user = User(id="user-1", username="state-user", display_name="状态用户", avatar_seed="", is_active=True)
        ingredient = Ingredient(
            id="ingredient-salt",
            family_id=family.id,
            name="盐",
            category="调味",
            default_unit="袋",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        session.add_all([family, user, ingredient])
        session.commit()
        yield session

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_presence_state_is_unique_per_family_ingredient(db: Session) -> None:
    first = IngredientInventoryState(
        id="inventory-state-1",
        family_id="family-1",
        ingredient_id="ingredient-salt",
        availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
        inventory_status=InventoryStatus.FRESH,
        storage_location="常温",
        notes="",
        row_version=1,
    )
    db.add(first)
    db.commit()
    db.add(
        IngredientInventoryState(
            id="inventory-state-2",
            family_id="family-1",
            ingredient_id="ingredient-salt",
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.OPENED,
            storage_location="常温",
            notes="",
            row_version=1,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_state_defaults_and_nullable_confirmation_fields(db: Session) -> None:
    state = IngredientInventoryState(
        id="inventory-state-defaults",
        family_id="family-1",
        ingredient_id="ingredient-salt",
        availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
        storage_location="常温",
    )
    db.add(state)
    db.commit()
    db.refresh(state)

    assert state.row_version == 1
    assert state.inventory_status == InventoryStatus.FRESH
    assert state.notes == ""
    assert state.purchase_date is None
    assert state.expiry_date is None
    assert state.expiry_alert_snoozed_until is None
    assert state.expiry_reviewed_at is None
    assert state.expiry_reviewed_by is None
    assert state.last_confirmed_at is None
    assert state.last_confirmed_by is None
    assert state.last_confirmation_source is None


def test_operation_client_request_id_unique_per_family(db: Session) -> None:
    applied_at = utcnow()
    first = InventoryOperation(
        id="inventory-operation-1",
        family_id="family-1",
        operation_type=InventoryOperationType.RECONCILIATION,
        status=InventoryOperationStatus.APPLIED,
        client_request_id="req-1",
        request_hash="hash-a",
        actor_id="user-1",
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
        summary_json={},
    )
    db.add(first)
    db.commit()

    db.add(
        InventoryOperation(
            id="inventory-operation-2",
            family_id="family-1",
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            status=InventoryOperationStatus.APPLIED,
            client_request_id="req-1",
            request_hash="hash-b",
            actor_id="user-1",
            applied_at=applied_at,
            revertible_until=applied_at + timedelta(minutes=15),
            summary_json={},
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_operation_line_entity_unique_within_operation(db: Session) -> None:
    applied_at = datetime(2026, 7, 12, 8, 0, tzinfo=timezone.utc)
    operation = InventoryOperation(
        id="inventory-operation-lines",
        family_id="family-1",
        operation_type=InventoryOperationType.RECONCILIATION,
        status=InventoryOperationStatus.APPLIED,
        client_request_id="req-lines",
        request_hash="hash-lines",
        actor_id="user-1",
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
        summary_json={"count": 1},
    )
    first_line = InventoryOperationLine(
        id="inventory-operation-line-1",
        operation_id=operation.id,
        sequence=1,
        entity_type=InventoryOperationEntityType.INGREDIENT,
        entity_id="ingredient-salt",
        change_type=InventoryOperationChangeType.UPDATE,
        before_snapshot={"row_version": 1},
        after_snapshot={"row_version": 2},
        before_row_version=1,
        after_row_version=2,
    )
    db.add_all([operation, first_line])
    db.commit()

    db.add(
        InventoryOperationLine(
            id="inventory-operation-line-2",
            operation_id=operation.id,
            sequence=2,
            entity_type=InventoryOperationEntityType.INGREDIENT,
            entity_id="ingredient-salt",
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot={"row_version": 2},
            after_snapshot={"row_version": 3},
            before_row_version=2,
            after_row_version=3,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_versioned_entities_default_row_version_to_one(db: Session) -> None:
    ingredient = db.get(Ingredient, "ingredient-salt")
    assert ingredient is not None
    assert ingredient.row_version == 1

    food = Food(
        id="food-1",
        family_id="family-1",
        name="卤牛肉",
        type="selfMade",
        category="熟食",
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=[],
        source_name="",
        purchase_source="",
        scene="",
        notes="",
        routine_note="",
        stock_unit="份",
        storage_location="冷藏",
    )
    shopping = ShoppingListItem(
        id="shopping-1",
        family_id="family-1",
        title="厨房纸",
        quantity=1,
        unit="卷",
        reason="",
        done=False,
    )
    item = InventoryItem(
        id="inventory-1",
        family_id="family-1",
        ingredient_id="ingredient-salt",
        quantity=1,
        unit="袋",
        status=InventoryStatus.FRESH,
        purchase_date=datetime(2026, 7, 1).date(),
        storage_location="常温",
        notes="",
    )
    db.add_all([food, shopping, item])
    db.commit()
    db.refresh(food)
    db.refresh(shopping)
    db.refresh(item)

    assert food.row_version == 1
    assert shopping.row_version == 1
    assert item.row_version == 1
    assert item.last_confirmed_at is None
    assert item.last_confirmed_by is None
    assert item.last_confirmation_source is None
    assert food.inventory_last_confirmed_at is None
    assert food.inventory_last_confirmed_by is None
    assert food.inventory_confirmation_source is None


def test_activity_action_includes_revert() -> None:
    assert ActivityAction.REVERT.value == "revert"


def test_confirmation_source_and_availability_enum_values() -> None:
    assert InventoryAvailabilityLevel.PRESENT_UNKNOWN.value == "present_unknown"
    assert InventoryAvailabilityLevel.LOW.value == "low"
    assert InventoryAvailabilityLevel.SUFFICIENT.value == "sufficient"
    assert InventoryAvailabilityLevel.ABSENT.value == "absent"
    assert InventoryConfirmationSource.MANUAL_ENTRY.value == "manual_entry"
    assert InventoryConfirmationSource.RECONCILIATION.value == "reconciliation"
    assert InventoryConfirmationSource.SHOPPING_INTAKE.value == "shopping_intake"


def test_mapper_version_columns_configured() -> None:
    assert Ingredient.__mapper__.version_id_col is not None
    assert Ingredient.__mapper__.version_id_col.key == "row_version"
    assert Food.__mapper__.version_id_col.key == "row_version"
    assert ShoppingListItem.__mapper__.version_id_col.key == "row_version"
    assert InventoryItem.__mapper__.version_id_col.key == "row_version"
    assert IngredientInventoryState.__mapper__.version_id_col.key == "row_version"

    state_columns = {column.name for column in inspect(IngredientInventoryState).columns}
    assert "last_confirmed_at" in state_columns
    assert "last_confirmed_by" in state_columns
    assert "last_confirmation_source" in state_columns
    assert "expiry_alert_snoozed_until" in state_columns
    assert "expiry_reviewed_at" in state_columns
    assert "expiry_reviewed_by" in state_columns
