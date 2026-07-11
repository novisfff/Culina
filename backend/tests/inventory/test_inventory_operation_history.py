from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import BaseModel
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import (
    FoodType,
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
from app.schemas.inventory_operations import (
    SNAPSHOT_SCHEMA_VERSION,
    InventoryOperationDisplaySummary,
)
from app.services.inventory_operation_history import (
    canonical_request_hash,
    record_ingredient_collection_guard,
    record_operation_line,
    snapshot_food_inventory,
    snapshot_ingredient_collection_guard,
    snapshot_inventory_item,
    snapshot_inventory_state,
    snapshot_shopping_item,
    start_operation,
)
from app.services.inventory_versions import InventoryConflictError
from app.repos.inventory_operations import claim_inventory_operation, find_idempotent_operation


class _HashModel(BaseModel):
    a: Decimal
    b: str


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
        family = Family(id="family-ops", name="操作家庭", motto="", location="")
        user = User(
            id="user-ops",
            username="ops-user",
            display_name="操作用户",
            avatar_seed="",
            is_active=True,
        )
        ingredient = Ingredient(
            id="ingredient-tomato",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        state_ingredient = Ingredient(
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
        food = Food(
            id="food-yogurt",
            family_id=family.id,
            name="酸奶",
            type=FoodType.READY_MADE.value,
            category="饮品",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["breakfast"],
            source_name="",
            purchase_source="",
            scene="",
            notes="not inventory",
            routine_note="",
            stock_quantity=Decimal("2"),
            stock_unit="盒",
            storage_location="冷藏",
            favorite=False,
            created_by=user.id,
            updated_by=user.id,
        )
        item = InventoryItem(
            id="inventory-tomato-1",
            family_id=family.id,
            ingredient_id=ingredient.id,
            quantity=Decimal("5"),
            consumed_quantity=Decimal("1"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("5"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 1),
            expiry_date=date(2026, 7, 10),
            storage_location="冷藏",
            notes="首批",
            low_stock_threshold=Decimal("1"),
            created_by=user.id,
            updated_by=user.id,
        )
        item_two = InventoryItem(
            id="inventory-tomato-2",
            family_id=family.id,
            ingredient_id=ingredient.id,
            quantity=Decimal("3"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 5),
            storage_location="冷藏",
            notes="第二批",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        state = IngredientInventoryState(
            id="inventory-state-salt",
            family_id=family.id,
            ingredient_id=state_ingredient.id,
            availability_level=InventoryAvailabilityLevel.SUFFICIENT,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 1),
            expiry_date=date(2026, 12, 1),
            storage_location="常温",
            notes="够用",
            last_confirmed_at=datetime(2026, 7, 1, 8, 0, tzinfo=timezone.utc),
            last_confirmed_by=user.id,
            last_confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
            created_by=user.id,
            updated_by=user.id,
        )
        shopping = ShoppingListItem(
            id="shopping-tomato",
            family_id=family.id,
            ingredient_id=ingredient.id,
            food_id=None,
            title="番茄",
            quantity=Decimal("2"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            display_label=None,
            reason="补货",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        session.add_all(
            [
                family,
                user,
                ingredient,
                state_ingredient,
                food,
                item,
                item_two,
                state,
                shopping,
            ]
        )
        session.commit()
        yield session


def test_canonical_request_hash_is_order_and_decimal_stable() -> None:
    left = canonical_request_hash(_HashModel(a=Decimal("1.0"), b="x"))
    right = canonical_request_hash(_HashModel(b="x", a=Decimal("1.00")))
    assert left == right
    assert len(left) == 64


def test_canonical_request_hash_changes_with_user_intent() -> None:
    base = canonical_request_hash(_HashModel(a=Decimal("1.0"), b="x"))
    changed = canonical_request_hash(_HashModel(a=Decimal("2.0"), b="x"))
    assert base != changed


def test_snapshots_are_whitelist_only(db: Session) -> None:
    item = db.get(InventoryItem, "inventory-tomato-1")
    state = db.get(IngredientInventoryState, "inventory-state-salt")
    food = db.get(Food, "food-yogurt")
    shopping = db.get(ShoppingListItem, "shopping-tomato")
    ingredient = db.get(Ingredient, "ingredient-tomato")
    assert item is not None and state is not None and food is not None
    assert shopping is not None and ingredient is not None

    item_snap = snapshot_inventory_item(item)
    state_snap = snapshot_inventory_state(state)
    food_snap = snapshot_food_inventory(food)
    shopping_snap = snapshot_shopping_item(shopping)
    guard_snap = snapshot_ingredient_collection_guard(ingredient)

    for payload in (item_snap, state_snap, food_snap, shopping_snap, guard_snap):
        serialized = json.dumps(payload, default=str)
        assert "password_hash" not in serialized
        assert "__dict__" not in serialized
        assert "_sa_instance_state" not in serialized

    assert set(item_snap) == {
        "id",
        "family_id",
        "ingredient_id",
        "quantity",
        "consumed_quantity",
        "disposed_quantity",
        "unit",
        "entered_quantity",
        "entered_unit",
        "status",
        "purchase_date",
        "expiry_date",
        "storage_location",
        "notes",
        "low_stock_threshold",
        "last_confirmed_at",
        "last_confirmed_by",
        "last_confirmation_source",
        "row_version",
    }
    assert "created_by" not in item_snap
    assert item_snap["quantity"] == "5"
    assert item_snap["status"] == InventoryStatus.FRESH.value

    assert set(state_snap) == {
        "id",
        "family_id",
        "ingredient_id",
        "availability_level",
        "inventory_status",
        "purchase_date",
        "expiry_date",
        "storage_location",
        "notes",
        "expiry_alert_snoozed_until",
        "expiry_reviewed_at",
        "expiry_reviewed_by",
        "last_confirmed_at",
        "last_confirmed_by",
        "last_confirmation_source",
        "row_version",
    }
    assert "name" not in food_snap
    assert "notes" not in food_snap
    assert set(food_snap) == {
        "id",
        "family_id",
        "stock_quantity",
        "stock_unit",
        "storage_location",
        "expiry_date",
        "inventory_last_confirmed_at",
        "inventory_last_confirmed_by",
        "inventory_confirmation_source",
        "row_version",
    }
    assert set(shopping_snap) == {
        "id",
        "family_id",
        "ingredient_id",
        "food_id",
        "title",
        "quantity",
        "unit",
        "quantity_mode",
        "display_label",
        "reason",
        "done",
        "row_version",
    }
    assert set(guard_snap) == {
        "id",
        "family_id",
        "quantity_tracking_mode",
        "row_version",
    }
    assert guard_snap["quantity_tracking_mode"] == IngredientQuantityTrackingMode.TRACK_QUANTITY.value


def test_claim_same_request_same_hash_returns_existing(db: Session) -> None:
    summary = InventoryOperationDisplaySummary(title="采购入库", description="完成 1 项")
    first, created = claim_inventory_operation(
        db,
        family_id="family-ops",
        actor_id="user-ops",
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id="req-1",
        request_hash="hash-same",
        summary=summary,
    )
    db.flush()
    assert created is True
    assert first.status == InventoryOperationStatus.APPLIED
    assert first.summary_json["title"] == "采购入库"
    assert first.revertible_until - first.applied_at == timedelta(minutes=15)

    second, created_again = claim_inventory_operation(
        db,
        family_id="family-ops",
        actor_id="user-ops",
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id="req-1",
        request_hash="hash-same",
        summary=summary,
    )
    assert created_again is False
    assert second.id == first.id

    found = find_idempotent_operation(
        db,
        family_id="family-ops",
        client_request_id="req-1",
        request_hash="hash-same",
    )
    assert found is not None
    assert found.id == first.id


def test_claim_same_request_different_hash_raises_idempotency_conflict(db: Session) -> None:
    summary = InventoryOperationDisplaySummary(title="采购入库", description="完成 1 项")
    claim_inventory_operation(
        db,
        family_id="family-ops",
        actor_id="user-ops",
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id="req-conflict",
        request_hash="hash-a",
        summary=summary,
    )
    db.flush()

    with pytest.raises(InventoryConflictError) as raised:
        claim_inventory_operation(
            db,
            family_id="family-ops",
            actor_id="user-ops",
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            client_request_id="req-conflict",
            request_hash="hash-b",
            summary=summary,
        )
    assert raised.value.code == "idempotency_key_reused"

    with pytest.raises(InventoryConflictError) as found_raised:
        find_idempotent_operation(
            db,
            family_id="family-ops",
            client_request_id="req-conflict",
            request_hash="hash-b",
        )
    assert found_raised.value.code == "idempotency_key_reused"


def test_start_operation_sets_applied_window_without_commit(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    summary = InventoryOperationDisplaySummary(
        title="冰箱盘点",
        description="确认 2 项",
        confirmed_count=2,
    )
    commits: list[str] = []
    original_commit = db.commit

    def tracking_commit(*args, **kwargs):
        commits.append("commit")
        return original_commit(*args, **kwargs)

    monkeypatch.setattr(db, "commit", tracking_commit)

    operation = start_operation(
        db,
        family_id="family-ops",
        actor_id="user-ops",
        operation_type=InventoryOperationType.RECONCILIATION,
        client_request_id="req-start",
        request_hash="hash-start",
        summary=summary,
    )
    assert operation.status == InventoryOperationStatus.APPLIED
    assert operation.applied_at is not None
    assert operation.revertible_until == operation.applied_at + timedelta(minutes=15)
    assert operation.summary_json["confirmed_count"] == 2
    assert commits == []
    assert db.get(InventoryOperation, operation.id) is not None



def test_record_operation_line_and_ingredient_guard(db: Session) -> None:
    summary = InventoryOperationDisplaySummary(title="采购入库", description="完成 2 项")
    operation = start_operation(
        db,
        family_id="family-ops",
        actor_id="user-ops",
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id="req-lines",
        request_hash="hash-lines",
        summary=summary,
    )
    item_one = db.get(InventoryItem, "inventory-tomato-1")
    item_two = db.get(InventoryItem, "inventory-tomato-2")
    ingredient = db.get(Ingredient, "ingredient-tomato")
    assert item_one is not None and item_two is not None and ingredient is not None

    before_version = ingredient.row_version
    after_version = before_version + 1

    line_one = record_operation_line(
        db,
        operation=operation,
        sequence=1,
        entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
        entity_id=item_one.id,
        change_type=InventoryOperationChangeType.UPDATE,
        before_snapshot=snapshot_inventory_item(item_one),
        after_snapshot={**snapshot_inventory_item(item_one), "quantity": "6", "row_version": item_one.row_version + 1},
        before_row_version=item_one.row_version,
        after_row_version=item_one.row_version + 1,
    )
    line_two = record_operation_line(
        db,
        operation=operation,
        sequence=2,
        entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
        entity_id=item_two.id,
        change_type=InventoryOperationChangeType.UPDATE,
        before_snapshot=snapshot_inventory_item(item_two),
        after_snapshot={**snapshot_inventory_item(item_two), "quantity": "4", "row_version": item_two.row_version + 1},
        before_row_version=item_two.row_version,
        after_row_version=item_two.row_version + 1,
    )
    guard = record_ingredient_collection_guard(
        db,
        operation=operation,
        sequence=3,
        ingredient=ingredient,
        before_row_version=before_version,
        after_row_version=after_version,
    )
    db.flush()

    assert line_one.snapshot_schema_version == SNAPSHOT_SCHEMA_VERSION
    assert line_two.snapshot_schema_version == SNAPSHOT_SCHEMA_VERSION
    assert guard.entity_type == InventoryOperationEntityType.INGREDIENT
    assert guard.entity_id == ingredient.id
    assert guard.change_type == InventoryOperationChangeType.UPDATE
    assert guard.change_metadata == {"role": "collection_version_guard"}
    assert guard.before_row_version == before_version
    assert guard.after_row_version == after_version
    assert guard.before_snapshot == {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "quantity_tracking_mode": IngredientQuantityTrackingMode.TRACK_QUANTITY.value,
        "row_version": before_version,
    }
    assert guard.after_snapshot == {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "quantity_tracking_mode": IngredientQuantityTrackingMode.TRACK_QUANTITY.value,
        "row_version": after_version,
    }

    lines = list(
        db.scalars(
            select(InventoryOperationLine)
            .where(InventoryOperationLine.operation_id == operation.id)
            .order_by(InventoryOperationLine.sequence.asc())
        )
    )
    assert [line.entity_type for line in lines] == [
        InventoryOperationEntityType.INVENTORY_ITEM,
        InventoryOperationEntityType.INVENTORY_ITEM,
        InventoryOperationEntityType.INGREDIENT,
    ]
    guard_lines = [line for line in lines if line.entity_type == InventoryOperationEntityType.INGREDIENT]
    assert len(guard_lines) == 1
