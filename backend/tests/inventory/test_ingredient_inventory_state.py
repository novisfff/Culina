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
from sqlalchemy import create_engine, event, inspect, select
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
    ActivityLog,
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



# ---------------------------------------------------------------------------
# Task 3: IngredientInventoryState is the only presence truth
# ---------------------------------------------------------------------------


@pytest.fixture()
def state_api_context():
    from collections.abc import Iterator as _Iterator
    from fastapi.testclient import TestClient

    from app.core.deps import get_current_auth
    from app.core.enums import MembershipStatus, UserRole
    from app.db.session import get_db
    from app.main import app
    from app.models.domain import Membership

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
        other_family = Family(id="family-2", name="其他家庭", motto="", location="")
        user = User(id="user-1", username="state-user", display_name="状态用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-1",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        salt = Ingredient(
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
        other_salt = Ingredient(
            id="ingredient-other-salt",
            family_id=other_family.id,
            name="其他盐",
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
        legacy = InventoryItem(
            id="inventory-salt-legacy",
            family_id=family.id,
            ingredient_id=salt.id,
            quantity=Decimal("1"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="袋",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 1),
            storage_location="常温",
            notes="legacy placeholder",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        state = IngredientInventoryState(
            id="inventory-state-salt",
            family_id=family.id,
            ingredient_id=salt.id,
            availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
            inventory_status=InventoryStatus.FRESH,
            storage_location="常温",
            notes="",
            row_version=1,
            created_by=user.id,
            updated_by=user.id,
        )
        session.add_all([family, other_family, user, membership, salt, other_salt, legacy, state])
        session.commit()

    def override_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth():
        with SessionLocal() as db:
            user = db.get(User, "user-1")
            membership = db.get(Membership, "membership-1")
            assert user is not None and membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    try:
        yield TestClient(app), SessionLocal
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_list_inventory_excludes_legacy_presence_placeholder(state_api_context) -> None:
    client, _ = state_api_context
    assert client.get("/api/inventory").json() == []


def test_list_states_returns_presence_state(state_api_context) -> None:
    client, _ = state_api_context
    payload = client.get("/api/inventory/states").json()
    assert len(payload) == 1
    assert payload[0]["availability_level"] == "present_unknown"
    assert payload[0]["ingredient_id"] == "ingredient-salt"


def test_post_inventory_presence_returns_422_without_creating_row(state_api_context) -> None:
    client, SessionLocal = state_api_context
    response = client.post(
        "/api/inventory",
        json={
            "ingredient_id": "ingredient-salt",
            "status": "fresh",
            "purchase_date": "2026-07-12",
            "storage_location": "常温",
            "notes": "should fail",
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "presence_state_required"
    with SessionLocal() as db:
        count = db.scalar(
            select(sa.func.count()).select_from(InventoryItem).where(
                InventoryItem.family_id == "family-1",
                InventoryItem.ingredient_id == "ingredient-salt",
            )
        )
        assert count == 1


def test_upsert_state_repeat_updates_one_row_and_absent_clears_metadata(state_api_context) -> None:
    client, SessionLocal = state_api_context
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        state = db.get(IngredientInventoryState, "inventory-state-salt")
        assert ingredient is not None and state is not None
        first = client.put(
            "/api/inventory/states/ingredient-salt",
            json={
                "expected_ingredient_row_version": ingredient.row_version,
                "state_id": state.id,
                "expected_state_row_version": state.row_version,
                "availability_level": "low",
                "inventory_status": "opened",
                "purchase_date": "2026-07-01",
                "expiry_date": "2026-12-01",
                "storage_location": "常温",
                "notes": "开封",
            },
        )
    assert first.status_code == 200, first.text
    first_payload = first.json()
    assert first_payload["availability_level"] == "low"
    assert first_payload["last_confirmation_source"] == "manual_entry"

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        state = db.get(IngredientInventoryState, "inventory-state-salt")
        assert ingredient is not None and state is not None
        second = client.put(
            "/api/inventory/states/ingredient-salt",
            json={
                "expected_ingredient_row_version": ingredient.row_version,
                "state_id": state.id,
                "expected_state_row_version": state.row_version,
                "availability_level": "absent",
                "inventory_status": "fresh",
                "notes": "",
            },
        )
    assert second.status_code == 200, second.text
    payload = second.json()
    assert payload["availability_level"] == "absent"
    assert payload["purchase_date"] is None
    assert payload["expiry_date"] is None
    assert payload["storage_location"] is None
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None
    with SessionLocal() as db:
        count = db.scalar(
            select(sa.func.count()).select_from(IngredientInventoryState).where(
                IngredientInventoryState.family_id == "family-1",
                IngredientInventoryState.ingredient_id == "ingredient-salt",
            )
        )
        assert count == 1


def test_upsert_state_cross_family_404(state_api_context) -> None:
    client, _ = state_api_context
    response = client.put(
        "/api/inventory/states/ingredient-other-salt",
        json={
            "expected_ingredient_row_version": 1,
            "availability_level": "present_unknown",
            "inventory_status": "fresh",
            "storage_location": "常温",
        },
    )
    assert response.status_code == 404


def test_dispose_legacy_presence_inventory_item_returns_422(state_api_context) -> None:
    client, _ = state_api_context
    response = client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": "inventory-salt-legacy",
            "expected_row_version": 1,
            "reason": "清理",
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "presence_state_required"


def test_state_is_usable_semantics() -> None:
    from app.services.ingredient_inventory_state import state_is_physically_present, state_is_usable

    present = IngredientInventoryState(
        id="s1",
        family_id="f",
        ingredient_id="i",
        availability_level=InventoryAvailabilityLevel.SUFFICIENT,
        inventory_status=InventoryStatus.FRESH,
        expiry_date=date(2026, 7, 12),
    )
    expired = IngredientInventoryState(
        id="s2",
        family_id="f",
        ingredient_id="i",
        availability_level=InventoryAvailabilityLevel.SUFFICIENT,
        inventory_status=InventoryStatus.FRESH,
        expiry_date=date(2026, 7, 10),
    )
    absent = IngredientInventoryState(
        id="s3",
        family_id="f",
        ingredient_id="i",
        availability_level=InventoryAvailabilityLevel.ABSENT,
        inventory_status=InventoryStatus.FRESH,
    )
    business = date(2026, 7, 12)
    assert state_is_physically_present(present) is True
    assert state_is_usable(present, business_date=business) is True
    assert state_is_physically_present(expired) is True
    assert state_is_usable(expired, business_date=business) is False
    assert state_is_physically_present(absent) is False
    assert state_is_usable(absent, business_date=business) is False


# ---------------------------------------------------------------------------
# Task 4: State expiry action center
# ---------------------------------------------------------------------------


def _seed_actionable_state(
    SessionLocal,
    *,
    expiry_date,
    availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
    snoozed_until=None,
    reviewed_at=None,
    reviewed_by=None,
    purchase_date=None,
    row_version=1,
    last_confirmed_at=None,
    last_confirmed_by=None,
    last_confirmation_source=None,
):
    with SessionLocal() as db:
        state = db.get(IngredientInventoryState, "inventory-state-salt")
        ingredient = db.get(Ingredient, "ingredient-salt")
        assert state is not None and ingredient is not None
        state.availability_level = availability_level
        state.expiry_date = expiry_date
        state.purchase_date = purchase_date or date(2026, 6, 1)
        state.storage_location = "常温"
        state.expiry_alert_snoozed_until = snoozed_until
        state.expiry_reviewed_at = reviewed_at
        state.expiry_reviewed_by = reviewed_by
        state.last_confirmed_at = last_confirmed_at
        state.last_confirmed_by = last_confirmed_by
        state.last_confirmation_source = last_confirmation_source
        db.commit()
        state_id = state.id
        ingredient_id = ingredient.id
        if row_version != 1:
            # Bypass version_id_col mutation rules so tests can seed stale versions.
            db.execute(
                IngredientInventoryState.__table__.update()
                .where(IngredientInventoryState.id == state_id)
                .values(row_version=row_version)
            )
            db.commit()
        state = db.get(IngredientInventoryState, state_id)
        ingredient = db.get(Ingredient, ingredient_id)
        assert state is not None and ingredient is not None
        return {
            "state_id": state.id,
            "state_row_version": state.row_version,
            "ingredient_row_version": ingredient.row_version,
            "expiry_date": state.expiry_date,
        }


def test_state_retain_expired_preserves_expiry_and_writes_review(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(SessionLocal, expiry_date=today - timedelta(days=2))
    snoozed_until = today + timedelta(days=3)

    response = client.post(
        "/api/inventory/states/ingredient-salt/snooze-expiry-alert",
        json={
            "action": "retain_expired",
            "state_id": seed["state_id"],
            "expected_row_version": seed["state_row_version"],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["expiry_date"] == seed["expiry_date"].isoformat()
    assert payload["expiry_alert_snoozed_until"] == snoozed_until.isoformat()
    assert payload["expiry_reviewed_by"] == "user-1"
    assert payload["expiry_reviewed_at"] is not None
    assert payload["last_confirmation_source"] is None
    assert payload["row_version"] == seed["state_row_version"] + 1

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        assert ingredient is not None
        assert ingredient.row_version == seed["ingredient_row_version"] + 1
        logs = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.family_id == "family-1",
                    ActivityLog.entity_type == "IngredientInventoryState",
                    ActivityLog.entity_id == seed["state_id"],
                )
            )
        )
        assert any("暂时保留" in log.summary for log in logs)


def test_state_snooze_upcoming_without_review_attribution(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(SessionLocal, expiry_date=today + timedelta(days=2))
    snoozed_until = today + timedelta(days=2)

    response = client.post(
        "/api/inventory/states/ingredient-salt/snooze-expiry-alert",
        json={
            "action": "snooze_upcoming",
            "state_id": seed["state_id"],
            "expected_row_version": seed["state_row_version"],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["expiry_date"] == seed["expiry_date"].isoformat()
    assert payload["expiry_alert_snoozed_until"] == snoozed_until.isoformat()
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None
    assert payload["row_version"] == seed["state_row_version"] + 1


def test_state_correct_expiry_date_clears_review_and_snooze(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(
        SessionLocal,
        expiry_date=today - timedelta(days=1),
        snoozed_until=today + timedelta(days=2),
        reviewed_at=utcnow(),
        reviewed_by="user-1",
    )
    corrected = today + timedelta(days=9)

    response = client.patch(
        "/api/inventory/states/ingredient-salt/expiry-date",
        json={
            "state_id": seed["state_id"],
            "expected_row_version": seed["state_row_version"],
            "expiry_date": corrected.isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["expiry_date"] == corrected.isoformat()
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None
    assert payload["row_version"] == seed["state_row_version"] + 1

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        assert ingredient is not None
        assert ingredient.row_version == seed["ingredient_row_version"] + 1


def test_state_set_absent_clears_expiry_fields(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(
        SessionLocal,
        expiry_date=today - timedelta(days=1),
        snoozed_until=today + timedelta(days=2),
        reviewed_at=utcnow(),
        reviewed_by="user-1",
        last_confirmed_at=utcnow(),
        last_confirmed_by="user-1",
        last_confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
    )

    response = client.post(
        "/api/inventory/states/ingredient-salt/set-absent",
        json={
            "state_id": seed["state_id"],
            "expected_row_version": seed["state_row_version"],
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["availability_level"] == "absent"
    assert payload["expiry_date"] is None
    assert payload["purchase_date"] is None
    assert payload["storage_location"] is None
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None
    # Expiry disposal must not claim a fresh inventory confirmation.
    assert payload["last_confirmation_source"] == "manual_entry"
    assert payload["row_version"] == seed["state_row_version"] + 1

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        assert ingredient is not None
        assert ingredient.row_version == seed["ingredient_row_version"] + 1


def test_state_expiry_actions_reject_stale_version_without_writes(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(
        SessionLocal,
        expiry_date=today - timedelta(days=1),
        row_version=3,
    )
    snoozed_until = today + timedelta(days=2)

    retain = client.post(
        "/api/inventory/states/ingredient-salt/snooze-expiry-alert",
        json={
            "action": "retain_expired",
            "state_id": seed["state_id"],
            "expected_row_version": 1,
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    correct = client.patch(
        "/api/inventory/states/ingredient-salt/expiry-date",
        json={
            "state_id": seed["state_id"],
            "expected_row_version": 1,
            "expiry_date": (today + timedelta(days=5)).isoformat(),
        },
    )
    absent = client.post(
        "/api/inventory/states/ingredient-salt/set-absent",
        json={
            "state_id": seed["state_id"],
            "expected_row_version": 1,
        },
    )
    assert retain.status_code == 409, retain.text
    assert correct.status_code == 409, correct.text
    assert absent.status_code == 409, absent.text
    for response in (retain, correct, absent):
        detail = response.json()["detail"]
        assert detail["code"] == "stale_version"
        assert detail["conflicts"][0]["entity_type"] == "ingredient_inventory_state"
        assert detail["conflicts"][0]["current_row_version"] == 3

    with SessionLocal() as db:
        state = db.get(IngredientInventoryState, seed["state_id"])
        ingredient = db.get(Ingredient, "ingredient-salt")
        assert state is not None and ingredient is not None
        assert state.row_version == 3
        assert state.expiry_alert_snoozed_until is None
        assert state.availability_level == InventoryAvailabilityLevel.PRESENT_UNKNOWN
        assert ingredient.row_version == seed["ingredient_row_version"]


def test_state_expiry_actions_reject_cross_family(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    with SessionLocal() as db:
        other_state = IngredientInventoryState(
            id="inventory-state-other",
            family_id="family-2",
            ingredient_id="ingredient-other-salt",
            availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
            inventory_status=InventoryStatus.FRESH,
            storage_location="常温",
            expiry_date=today - timedelta(days=1),
            notes="",
            row_version=1,
            created_by="user-1",
            updated_by="user-1",
        )
        db.add(other_state)
        db.commit()

    retain = client.post(
        "/api/inventory/states/ingredient-other-salt/snooze-expiry-alert",
        json={
            "action": "retain_expired",
            "state_id": "inventory-state-other",
            "expected_row_version": 1,
            "snoozed_until": (today + timedelta(days=2)).isoformat(),
        },
    )
    absent = client.post(
        "/api/inventory/states/ingredient-other-salt/set-absent",
        json={
            "state_id": "inventory-state-other",
            "expected_row_version": 1,
        },
    )
    assert retain.status_code == 400
    assert absent.status_code == 400
    with SessionLocal() as db:
        other = db.get(IngredientInventoryState, "inventory-state-other")
        assert other is not None
        assert other.expiry_alert_snoozed_until is None
        assert other.availability_level == InventoryAvailabilityLevel.PRESENT_UNKNOWN


def test_state_upsert_confirmation_does_not_touch_expiry_review_fields(state_api_context) -> None:
    """Manual confirmation / reconciliation-style confirmation must not rewrite expiry review metadata."""
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    reviewed_at = utcnow()
    seed = _seed_actionable_state(
        SessionLocal,
        expiry_date=today + timedelta(days=10),
        snoozed_until=today + timedelta(days=1),
        reviewed_at=reviewed_at,
        reviewed_by="user-1",
    )

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-salt")
        state = db.get(IngredientInventoryState, seed["state_id"])
        assert ingredient is not None and state is not None
        response = client.put(
            "/api/inventory/states/ingredient-salt",
            json={
                "expected_ingredient_row_version": ingredient.row_version,
                "state_id": state.id,
                "expected_state_row_version": state.row_version,
                "availability_level": "sufficient",
                "inventory_status": "opened",
                "purchase_date": state.purchase_date.isoformat() if state.purchase_date else None,
                "expiry_date": state.expiry_date.isoformat() if state.expiry_date else None,
                "storage_location": state.storage_location,
                "notes": "confirmed",
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["availability_level"] == "sufficient"
    assert payload["last_confirmation_source"] == "manual_entry"
    assert payload["expiry_alert_snoozed_until"] == (today + timedelta(days=1)).isoformat()
    assert payload["expiry_reviewed_by"] == "user-1"
    assert payload["expiry_reviewed_at"] is not None


def test_state_set_absent_rejects_non_expired(state_api_context) -> None:
    from app.services.clock import today_for_family

    client, SessionLocal = state_api_context
    today = today_for_family("family-1")
    seed = _seed_actionable_state(SessionLocal, expiry_date=today + timedelta(days=1))
    response = client.post(
        "/api/inventory/states/ingredient-salt/set-absent",
        json={
            "state_id": seed["state_id"],
            "expected_row_version": seed["state_row_version"],
        },
    )
    assert response.status_code == 400
    with SessionLocal() as db:
        state = db.get(IngredientInventoryState, seed["state_id"])
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.PRESENT_UNKNOWN


def test_state_first_create_rejects_a_state_created_after_client_snapshot(db: Session) -> None:
    from app.services.ingredient_inventory_state import upsert_inventory_state
    from app.services.inventory_versions import InventoryConflictError

    ingredient = db.get(Ingredient, "ingredient-salt")
    assert ingredient is not None
    state = IngredientInventoryState(
        id="inventory-state-concurrent-create",
        family_id="family-1",
        ingredient_id=ingredient.id,
        availability_level=InventoryAvailabilityLevel.LOW,
        inventory_status=InventoryStatus.FRESH,
        storage_location="常温",
        notes="家人已创建",
        created_by="user-1",
        updated_by="user-1",
    )
    db.add(state)
    db.commit()
    db.refresh(ingredient)

    with pytest.raises(InventoryConflictError) as raised:
        upsert_inventory_state(
            db,
            family_id="family-1",
            user_id="user-1",
            ingredient=ingredient,
            expected_ingredient_row_version=ingredient.row_version,
            state_id=None,
            expected_state_row_version=None,
            availability_level=InventoryAvailabilityLevel.SUFFICIENT,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 12),
            expiry_date=None,
            storage_location="常温",
            notes="客户端首建",
            confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
        )

    assert raised.value.code == "stale_version"
    assert raised.value.conflicts == [
        {
            "entity_type": "ingredient_inventory_state",
            "entity_id": state.id,
            "reason": "created_concurrently",
            "current_row_version": state.row_version,
        }
    ]


def _capture_transition_child_reads(db: Session) -> tuple[list[tuple[type, bool]], object]:
    observed: list[tuple[type, bool]] = []

    def receive_orm_execute(execute_state) -> None:
        if not execute_state.is_select:
            return
        statement = execute_state.statement
        entities = {
            description.get("entity")
            for description in getattr(statement, "column_descriptions", [])
        }
        for entity in (IngredientInventoryState, InventoryItem):
            if entity in entities:
                observed.append(
                    (entity, getattr(statement, "_for_update_arg", None) is not None)
                )

    event.listen(db, "do_orm_execute", receive_orm_execute)
    return observed, receive_orm_execute


def test_transition_service_exact_to_presence_matrix(db: Session) -> None:
    from app.schemas.ingredients import IngredientTrackingModeTransitionRequest
    from app.services.ingredient_inventory_state import transition_ingredient_tracking_mode

    exact = Ingredient(
        id="ingredient-egg",
        family_id="family-1",
        name="鸡蛋",
        category="蛋奶",
        default_unit="个",
        default_storage="冷藏",
        default_expiry_mode=IngredientExpiryMode.NONE,
        unit_conversions=[],
        quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        notes="",
        created_by="user-1",
        updated_by="user-1",
    )
    batch = InventoryItem(
        id="inventory-egg-1",
        family_id="family-1",
        ingredient_id=exact.id,
        quantity=Decimal("6"),
        consumed_quantity=Decimal("0"),
        disposed_quantity=Decimal("0"),
        unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        storage_location="冷藏",
        notes="",
        low_stock_threshold=Decimal("0"),
        created_by="user-1",
        updated_by="user-1",
    )
    db.add_all([exact, batch])
    db.commit()
    db.refresh(exact)
    db.refresh(batch)

    request = IngredientTrackingModeTransitionRequest(
        expected_ingredient_row_version=exact.row_version,
        target_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
        observed_batches=[{"inventory_item_id": batch.id, "expected_row_version": batch.row_version}],
        presence_resolution={
            "availability_level": InventoryAvailabilityLevel.SUFFICIENT,
            "inventory_status": InventoryStatus.FRESH,
            "purchase_date": date(2026, 7, 1),
            "expiry_date": date(2026, 7, 10),
            "storage_location": "冷藏",
            "notes": "service",
            "mark_inventory_confirmed": False,
        },
    )
    child_reads, listener = _capture_transition_child_reads(db)
    try:
        transition_ingredient_tracking_mode(
            db,
            family_id="family-1",
            user_id="user-1",
            ingredient_id=exact.id,
            request=request,
        )
    finally:
        event.remove(db, "do_orm_execute", listener)
    assert {entity for entity, _ in child_reads} == {
        IngredientInventoryState,
        InventoryItem,
    }
    assert all(is_locking_read for _, is_locking_read in child_reads)
    db.commit()
    db.refresh(exact)
    db.refresh(batch)
    state = db.scalar(
        select(IngredientInventoryState).where(IngredientInventoryState.ingredient_id == exact.id)
    )
    assert exact.quantity_tracking_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY
    assert batch.quantity == Decimal("6")
    assert state is not None
    assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
    assert state.last_confirmed_at is None


def test_transition_service_presence_to_exact_never_reuses_placeholder(db: Session) -> None:
    from app.schemas.ingredients import IngredientTrackingModeTransitionRequest
    from app.services.ingredient_inventory_state import transition_ingredient_tracking_mode

    ingredient = db.get(Ingredient, "ingredient-salt")
    assert ingredient is not None
    legacy = InventoryItem(
        id="inventory-salt-placeholder",
        family_id="family-1",
        ingredient_id=ingredient.id,
        quantity=Decimal("1"),
        consumed_quantity=Decimal("0"),
        disposed_quantity=Decimal("0"),
        unit="袋",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        storage_location="常温",
        notes="placeholder",
        low_stock_threshold=Decimal("0"),
        created_by="user-1",
        updated_by="user-1",
    )
    state = IngredientInventoryState(
        id="inventory-state-salt-transition",
        family_id="family-1",
        ingredient_id=ingredient.id,
        availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
        inventory_status=InventoryStatus.FRESH,
        storage_location="常温",
        notes="presence",
        last_confirmed_at=utcnow(),
        last_confirmed_by="user-1",
        last_confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
        row_version=1,
        created_by="user-1",
        updated_by="user-1",
    )
    db.add_all([legacy, state])
    db.commit()
    db.refresh(ingredient)
    db.refresh(state)

    request = IngredientTrackingModeTransitionRequest(
        expected_ingredient_row_version=ingredient.row_version,
        target_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        expected_state_row_version=state.row_version,
        exact_resolution={
            "confirm_absent": False,
            "quantity": Decimal("250"),
            "unit": "袋",
            "inventory_status": InventoryStatus.FRESH,
            "purchase_date": date(2026, 7, 12),
            "expiry_date": None,
            "storage_location": "常温",
            "notes": "real",
        },
    )
    child_reads, listener = _capture_transition_child_reads(db)
    try:
        transition_ingredient_tracking_mode(
            db,
            family_id="family-1",
            user_id="user-1",
            ingredient_id=ingredient.id,
            request=request,
        )
    finally:
        event.remove(db, "do_orm_execute", listener)
    assert {entity for entity, _ in child_reads} == {
        IngredientInventoryState,
        InventoryItem,
    }
    assert all(is_locking_read for _, is_locking_read in child_reads)
    db.commit()
    db.refresh(ingredient)
    db.refresh(legacy)
    db.refresh(state)
    new_items = list(
        db.scalars(
            select(InventoryItem).where(
                InventoryItem.ingredient_id == ingredient.id,
                InventoryItem.id != legacy.id,
            )
        )
    )
    assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
    assert legacy.quantity == Decimal("0")
    assert legacy.consumed_quantity == Decimal("0")
    assert legacy.disposed_quantity == Decimal("0")
    assert len(new_items) == 1
    assert new_items[0].quantity == Decimal("250")
    assert state.availability_level == InventoryAvailabilityLevel.ABSENT
    assert state.storage_location is None
    assert state.last_confirmed_at is None
    assert state.last_confirmed_by is None
    assert state.last_confirmation_source is None
