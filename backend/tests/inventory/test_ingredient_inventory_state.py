from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import ModuleType

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, select
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


MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "3f4a5b6c7d8e_add_inventory_reconciliation.py"
)


def _load_migration_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "inventory_reconciliation_migration",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def test_representative_key_orders_by_earliest_expiry_then_recent_update() -> None:
    migration = _load_migration_module()
    older = {
        "id": "inventory-a",
        "expiry_date": date(2026, 7, 20),
        "updated_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
    }
    newer_same_expiry = {
        "id": "inventory-b",
        "expiry_date": date(2026, 7, 20),
        "updated_at": datetime(2026, 7, 5, tzinfo=timezone.utc),
    }
    later_expiry = {
        "id": "inventory-c",
        "expiry_date": date(2026, 8, 1),
        "updated_at": datetime(2026, 7, 10, tzinfo=timezone.utc),
    }
    null_expiry = {
        "id": "inventory-d",
        "expiry_date": None,
        "updated_at": datetime(2026, 7, 12, tzinfo=timezone.utc),
    }

    ordered = sorted(
        [null_expiry, later_expiry, older, newer_same_expiry],
        key=migration._representative_key,
    )
    assert [row["id"] for row in ordered] == [
        "inventory-b",
        "inventory-a",
        "inventory-c",
        "inventory-d",
    ]
    assert migration._representative_key(older) == (
        False,
        date(2026, 7, 20),
        -datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp(),
        "inventory-a",
    )
    assert migration._representative_key(null_expiry) == (
        True,
        date.max,
        -datetime(2026, 7, 12, tzinfo=timezone.utc).timestamp(),
        "inventory-d",
    )


def test_backfill_ingredient_inventory_states_selection_rules() -> None:
    migration = _load_migration_module()
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    metadata = sa.MetaData()
    sa.Table(
        "ingredients",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("family_id", sa.String(64), nullable=False),
        sa.Column("quantity_tracking_mode", sa.String(32), nullable=False),
    )
    sa.Table(
        "inventory_items",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("family_id", sa.String(64), nullable=False),
        sa.Column("ingredient_id", sa.String(64), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 2), nullable=False),
        sa.Column("disposed_quantity", sa.Numeric(10, 2), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("purchase_date", sa.Date(), nullable=True),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column("storage_location", sa.String(120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("updated_by", sa.String(64), nullable=True),
        sa.Column("expiry_alert_snoozed_until", sa.Date(), nullable=True),
        sa.Column("expiry_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expiry_reviewed_by", sa.String(64), nullable=True),
    )
    sa.Table(
        "ingredient_inventory_states",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("family_id", sa.String(64), nullable=False),
        sa.Column("ingredient_id", sa.String(64), nullable=False),
        sa.Column("availability_level", sa.String(32), nullable=False),
        sa.Column("inventory_status", sa.String(32), nullable=False),
        sa.Column("purchase_date", sa.Date(), nullable=True),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column("storage_location", sa.String(120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("expiry_alert_snoozed_until", sa.Date(), nullable=True),
        sa.Column("expiry_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expiry_reviewed_by", sa.String(64), nullable=True),
        sa.Column("last_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_confirmed_by", sa.String(64), nullable=True),
        sa.Column("last_confirmation_source", sa.String(32), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("updated_by", sa.String(64), nullable=True),
    )
    metadata.create_all(engine)

    ingredients = metadata.tables["ingredients"]
    inventory_items = metadata.tables["inventory_items"]
    states = metadata.tables["ingredient_inventory_states"]
    seed_now = datetime(2026, 7, 12, 1, 0, tzinfo=timezone.utc)

    with engine.begin() as connection:
        connection.execute(
            ingredients.insert(),
            [
                {
                    "id": "ingredient-salt",
                    "family_id": "family-1",
                    "quantity_tracking_mode": "not_track_quantity",
                },
                {
                    "id": "ingredient-oil",
                    "family_id": "family-1",
                    "quantity_tracking_mode": "not_track_quantity",
                },
                {
                    "id": "ingredient-sugar",
                    "family_id": "family-1",
                    "quantity_tracking_mode": "track_quantity",
                },
                {
                    "id": "ingredient-pepper",
                    "family_id": "family-1",
                    "quantity_tracking_mode": "not_track_quantity",
                },
            ],
        )
        connection.execute(
            inventory_items.insert(),
            [
                {
                    "id": "inv-salt-null",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-salt",
                    "quantity": Decimal("1"),
                    "disposed_quantity": Decimal("0"),
                    "status": "opened",
                    "purchase_date": date(2026, 6, 1),
                    "expiry_date": None,
                    "storage_location": "常温",
                    "notes": "null expiry",
                    "updated_at": datetime(2026, 7, 12, tzinfo=timezone.utc),
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": None,
                    "expiry_reviewed_at": None,
                    "expiry_reviewed_by": None,
                },
                {
                    "id": "inv-salt-later",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-salt",
                    "quantity": Decimal("1"),
                    "disposed_quantity": Decimal("0"),
                    "status": "fresh",
                    "purchase_date": date(2026, 6, 10),
                    "expiry_date": date(2026, 8, 1),
                    "storage_location": "常温",
                    "notes": "later expiry",
                    "updated_at": datetime(2026, 7, 11, tzinfo=timezone.utc),
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": date(2026, 7, 20),
                    "expiry_reviewed_at": datetime(2026, 7, 10, tzinfo=timezone.utc),
                    "expiry_reviewed_by": "user-1",
                },
                {
                    "id": "inv-salt-early-new",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-salt",
                    "quantity": Decimal("2"),
                    "disposed_quantity": Decimal("0.5"),
                    "status": "fresh",
                    "purchase_date": date(2026, 6, 5),
                    "expiry_date": date(2026, 7, 20),
                    "storage_location": "冷藏",
                    "notes": "representative",
                    "updated_at": datetime(2026, 7, 9, tzinfo=timezone.utc),
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": date(2026, 7, 15),
                    "expiry_reviewed_at": datetime(2026, 7, 8, tzinfo=timezone.utc),
                    "expiry_reviewed_by": "user-2",
                },
                {
                    "id": "inv-salt-early-old",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-salt",
                    "quantity": Decimal("1"),
                    "disposed_quantity": Decimal("0"),
                    "status": "opened",
                    "purchase_date": date(2026, 6, 4),
                    "expiry_date": date(2026, 7, 20),
                    "storage_location": "常温",
                    "notes": "same expiry older update",
                    "updated_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": None,
                    "expiry_reviewed_at": None,
                    "expiry_reviewed_by": None,
                },
                {
                    "id": "inv-oil-disposed",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-oil",
                    "quantity": Decimal("1"),
                    "disposed_quantity": Decimal("1"),
                    "status": "fresh",
                    "purchase_date": date(2026, 5, 1),
                    "expiry_date": date(2026, 7, 1),
                    "storage_location": "常温",
                    "notes": "fully disposed",
                    "updated_at": seed_now,
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": None,
                    "expiry_reviewed_at": None,
                    "expiry_reviewed_by": None,
                },
                {
                    "id": "inv-sugar-tracked",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-sugar",
                    "quantity": Decimal("3"),
                    "disposed_quantity": Decimal("0"),
                    "status": "fresh",
                    "purchase_date": date(2026, 6, 1),
                    "expiry_date": date(2026, 9, 1),
                    "storage_location": "常温",
                    "notes": "tracked",
                    "updated_at": seed_now,
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": None,
                    "expiry_reviewed_at": None,
                    "expiry_reviewed_by": None,
                },
                {
                    "id": "inv-pepper",
                    "family_id": "family-1",
                    "ingredient_id": "ingredient-pepper",
                    "quantity": Decimal("1"),
                    "disposed_quantity": Decimal("0"),
                    "status": "fresh",
                    "purchase_date": date(2026, 6, 12),
                    "expiry_date": None,
                    "storage_location": "常温",
                    "notes": "pepper",
                    "updated_at": seed_now,
                    "created_at": seed_now,
                    "created_by": "user-1",
                    "updated_by": "user-1",
                    "expiry_alert_snoozed_until": None,
                    "expiry_reviewed_at": None,
                    "expiry_reviewed_by": None,
                },
            ],
        )

        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration._backfill_ingredient_inventory_states()

        state_rows = connection.execute(
            select(states).order_by(states.c.ingredient_id)
        ).mappings().all()
        inventory_count = connection.execute(
            select(sa.func.count()).select_from(inventory_items)
        ).scalar_one()

    assert inventory_count == 7
    assert len(state_rows) == 2

    salt_state = next(row for row in state_rows if row["ingredient_id"] == "ingredient-salt")
    pepper_state = next(row for row in state_rows if row["ingredient_id"] == "ingredient-pepper")

    assert salt_state["availability_level"] == "present_unknown"
    assert salt_state["inventory_status"] == "fresh"
    assert salt_state["purchase_date"] == date(2026, 6, 5)
    assert salt_state["expiry_date"] == date(2026, 7, 20)
    assert salt_state["storage_location"] == "冷藏"
    assert salt_state["notes"] == "representative"
    assert salt_state["expiry_alert_snoozed_until"] == date(2026, 7, 15)
    assert salt_state["expiry_reviewed_at"] is not None
    assert salt_state["expiry_reviewed_at"].replace(tzinfo=timezone.utc) == datetime(
        2026, 7, 8, tzinfo=timezone.utc
    )
    assert salt_state["expiry_reviewed_by"] == "user-2"
    assert salt_state["last_confirmed_at"] is None
    assert salt_state["last_confirmed_by"] is None
    assert salt_state["last_confirmation_source"] is None
    assert salt_state["row_version"] == 1

    assert pepper_state["availability_level"] == "present_unknown"
    assert pepper_state["expiry_date"] is None
    assert pepper_state["last_confirmed_at"] is None
    assert pepper_state["last_confirmed_by"] is None
    assert pepper_state["last_confirmation_source"] is None

    ingredient_ids = {row["ingredient_id"] for row in state_rows}
    assert ingredient_ids == {"ingredient-salt", "ingredient-pepper"}
    assert "ingredient-oil" not in ingredient_ids
    assert "ingredient-sugar" not in ingredient_ids

    engine.dispose()
