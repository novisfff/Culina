from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import (
    ActivityAction,
    ActivityHighlightKind,
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryOperationType,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.db.session import get_db
from app.main import app
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
    Membership,
    ShoppingListItem,
    User,
)
from app.services.inventory_usage import remaining_quantity
from tests._transaction_failure import fail_next_commit


@dataclass(frozen=True)
class ReconApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    user_id: str
    egg_id: str
    salt_id: str
    oil_id: str
    food_id: str
    empty_food_id: str
    batch_cold_fresh_id: str
    batch_cold_expired_id: str
    batch_cold_zero_id: str
    batch_room_id: str
    salt_state_id: str
    oil_state_id: str
    pending_egg_shopping_id: str


@pytest.fixture()
def recon_api_context() -> Iterator[ReconApiContext]:
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

    with SessionLocal() as db:
        family = Family(id="family-recon", name="盘点家庭", motto="", location="")
        user = User(id="user-recon", username="recon-user", display_name="盘点员", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-recon",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        egg = Ingredient(
            id="ingredient-egg",
            family_id=family.id,
            name="鸡蛋",
            category="蛋奶",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.DAYS,
            default_expiry_days=14,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
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
        oil = Ingredient(
            id="ingredient-oil",
            family_id=family.id,
            name="油",
            category="调味",
            default_unit="瓶",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        food = Food(
            id="food-beef",
            family_id=family.id,
            name="卤牛肉",
            type=FoodType.READY_MADE.value,
            category="熟食",
            stock_quantity=Decimal("2"),
            stock_unit="份",
            storage_location="冷藏",
            expiry_date=date(2026, 7, 15),
            created_by=user.id,
            updated_by=user.id,
        )
        empty_food = Food(
            id="food-empty",
            family_id=family.id,
            name="空酸奶",
            type=FoodType.READY_MADE.value,
            category="乳品",
            stock_quantity=Decimal("0"),
            stock_unit="盒",
            storage_location="冷藏",
            created_by=user.id,
            updated_by=user.id,
        )

        batch_cold_fresh = InventoryItem(
            id="batch-cold-fresh",
            family_id=family.id,
            ingredient_id=egg.id,
            quantity=Decimal("6"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("6"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 1),
            expiry_date=date(2026, 7, 20),
            storage_location="冷藏",
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        batch_cold_expired = InventoryItem(
            id="batch-cold-expired",
            family_id=family.id,
            ingredient_id=egg.id,
            quantity=Decimal("3"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("3"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 1),
            expiry_date=date(2026, 6, 20),
            storage_location="冷藏",
            notes="过期",
            created_by=user.id,
            updated_by=user.id,
        )
        batch_cold_zero = InventoryItem(
            id="batch-cold-zero",
            family_id=family.id,
            ingredient_id=egg.id,
            quantity=Decimal("2"),
            consumed_quantity=Decimal("2"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("2"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 15),
            expiry_date=date(2026, 7, 1),
            storage_location="冷藏",
            notes="已用完",
            created_by=user.id,
            updated_by=user.id,
        )
        batch_room = InventoryItem(
            id="batch-room",
            family_id=family.id,
            ingredient_id=egg.id,
            quantity=Decimal("4"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("4"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 5),
            expiry_date=date(2026, 8, 1),
            storage_location="常温",
            notes="常温备用",
            created_by=user.id,
            updated_by=user.id,
        )
        salt_state = IngredientInventoryState(
            id="state-salt",
            family_id=family.id,
            ingredient_id=salt.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 1),
            expiry_date=None,
            storage_location="常温",
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        oil_state = IngredientInventoryState(
            id="state-oil",
            family_id=family.id,
            ingredient_id=oil.id,
            availability_level=InventoryAvailabilityLevel.ABSENT,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=None,
            expiry_date=None,
            storage_location=None,
            notes="已用完",
            created_by=user.id,
            updated_by=user.id,
        )
        pending_egg = ShoppingListItem(
            id="shopping-egg-pending",
            family_id=family.id,
            ingredient_id=egg.id,
            title="鸡蛋",
            quantity=Decimal("10"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="补货",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )

        db.add_all(
            [
                family,
                user,
                membership,
                egg,
                salt,
                oil,
                food,
                empty_food,
                batch_cold_fresh,
                batch_cold_expired,
                batch_cold_zero,
                batch_room,
                salt_state,
                oil_state,
                pending_egg,
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        db = SessionLocal()
        try:
            return db.get(User, user.id), db.get(Membership, membership.id)
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    client = TestClient(app)
    try:
        yield ReconApiContext(
            client=client,
            SessionLocal=SessionLocal,
            family_id=family.id,
            user_id=user.id,
            egg_id=egg.id,
            salt_id=salt.id,
            oil_id=oil.id,
            food_id=food.id,
            empty_food_id=empty_food.id,
            batch_cold_fresh_id=batch_cold_fresh.id,
            batch_cold_expired_id=batch_cold_expired.id,
            batch_cold_zero_id=batch_cold_zero.id,
            batch_room_id=batch_room.id,
            salt_state_id=salt_state.id,
            oil_state_id=oil_state.id,
            pending_egg_shopping_id=pending_egg.id,
        )
    finally:
        app.dependency_overrides.clear()
        client.close()
        engine.dispose()


def _highlight_rows(db: Session, *, family_id: str) -> list[ActivityLog]:
    return list(
        db.scalars(
            select(ActivityLog)
            .where(
                ActivityLog.family_id == family_id,
                ActivityLog.highlight_kind.is_not(None),
            )
            .order_by(ActivityLog.created_at, ActivityLog.id)
        )
    )


def _versions(ctx: ReconApiContext) -> dict[str, int]:
    with ctx.SessionLocal() as db:
        egg = db.get(Ingredient, ctx.egg_id)
        salt = db.get(Ingredient, ctx.salt_id)
        food = db.get(Food, ctx.food_id)
        salt_state = db.get(IngredientInventoryState, ctx.salt_state_id)
        fresh = db.get(InventoryItem, ctx.batch_cold_fresh_id)
        expired = db.get(InventoryItem, ctx.batch_cold_expired_id)
        room = db.get(InventoryItem, ctx.batch_room_id)
        assert egg and salt and food and salt_state and fresh and expired and room
        return {
            "egg": egg.row_version,
            "salt": salt.row_version,
            "food": food.row_version,
            "salt_state": salt_state.row_version,
            "fresh": fresh.row_version,
            "expired": expired.row_version,
            "room": room.row_version,
        }


def test_refrigerated_read_scope_matrix(recon_api_context: ReconApiContext) -> None:
    response = recon_api_context.client.get(
        "/api/inventory/reconciliation",
        params={"scope": "refrigerated"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["business_timezone"] == "Asia/Shanghai"
    assert payload["business_date"]  # from today_for_family

    groups = payload["groups"]
    kinds = {group["kind"] for group in groups}
    assert "exact_ingredient" in kinds
    assert "food" in kinds
    # present salt is 常温; absent oil excluded; empty food excluded
    presence_ids = [g["ingredient_id"] for g in groups if g["kind"] == "presence_ingredient"]
    assert recon_api_context.salt_id not in presence_ids
    assert recon_api_context.oil_id not in presence_ids

    egg_group = next(g for g in groups if g["kind"] == "exact_ingredient" and g["ingredient_id"] == recon_api_context.egg_id)
    batch_ids = {b["inventory_item_id"] for b in egg_group["batches"]}
    assert recon_api_context.batch_cold_fresh_id in batch_ids
    assert recon_api_context.batch_cold_expired_id in batch_ids
    assert recon_api_context.batch_cold_zero_id not in batch_ids
    assert recon_api_context.batch_room_id not in batch_ids
    assert egg_group["pending_shopping_item_id"] == recon_api_context.pending_egg_shopping_id
    assert egg_group["ingredient_row_version"] >= 1
    assert egg_group["default_unit"] == "个"
    assert egg_group["unit_conversions"] == []

    food_group = next(g for g in groups if g["kind"] == "food")
    assert food_group["food_id"] == recon_api_context.food_id
    assert Decimal(str(food_group["stock_quantity"])) == Decimal("2")


def test_suggested_includes_all_physical_batches_for_stale_or_never(recon_api_context: ReconApiContext) -> None:
    # All current rows are never_confirmed by default, so suggested should include them.
    response = recon_api_context.client.get(
        "/api/inventory/reconciliation",
        params={"scope": "suggested"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    egg_group = next(
        g for g in payload["groups"] if g["kind"] == "exact_ingredient" and g["ingredient_id"] == recon_api_context.egg_id
    )
    batch_ids = {b["inventory_item_id"] for b in egg_group["batches"]}
    # suggested returns ALL physical remaining batches across locations
    assert recon_api_context.batch_cold_fresh_id in batch_ids
    assert recon_api_context.batch_cold_expired_id in batch_ids
    assert recon_api_context.batch_room_id in batch_ids
    assert recon_api_context.batch_cold_zero_id not in batch_ids
    assert egg_group["confirmation_status"] == "never_confirmed"

    salt_group = next(
        g
        for g in payload["groups"]
        if g["kind"] == "presence_ingredient" and g["ingredient_id"] == recon_api_context.salt_id
    )
    assert salt_group["confirmation_status"] == "never_confirmed"
    assert salt_group["state"]["id"] == recon_api_context.salt_state_id

    # Mark food as currently confirmed so it drops out of suggested.
    with recon_api_context.SessionLocal() as db:
        food = db.get(Food, recon_api_context.food_id)
        assert food is not None
        food.inventory_last_confirmed_at = datetime.now(timezone.utc)
        food.inventory_last_confirmed_by = recon_api_context.user_id
        food.inventory_confirmation_source = InventoryConfirmationSource.MANUAL_ENTRY
        db.commit()

    response2 = recon_api_context.client.get(
        "/api/inventory/reconciliation",
        params={"scope": "suggested"},
    )
    assert response2.status_code == 200
    food_ids = [g["food_id"] for g in response2.json()["groups"] if g["kind"] == "food"]
    assert recon_api_context.food_id not in food_ids


def test_room_temperature_presence_and_excludes_absent(recon_api_context: ReconApiContext) -> None:
    response = recon_api_context.client.get(
        "/api/inventory/reconciliation",
        params={"scope": "room_temperature"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    presence_ids = [g["ingredient_id"] for g in payload["groups"] if g["kind"] == "presence_ingredient"]
    assert recon_api_context.salt_id in presence_ids
    assert recon_api_context.oil_id not in presence_ids
    egg_groups = [g for g in payload["groups"] if g["kind"] == "exact_ingredient"]
    if egg_groups:
        batch_ids = {b["inventory_item_id"] for b in egg_groups[0]["batches"]}
        assert recon_api_context.batch_room_id in batch_ids
        assert recon_api_context.batch_cold_fresh_id not in batch_ids


def test_confirm_all_exact_and_food_confirm(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-confirm-1",
        "scope": "refrigerated",
        "storage_location": None,
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "confirm_all",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [],
                "creates": [],
            },
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            },
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["operation_type"] == InventoryOperationType.RECONCILIATION.value
    assert body["status"] == "applied"
    assert body["summary"]["confirmed_count"] >= 1

    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        expired = db.get(InventoryItem, recon_api_context.batch_cold_expired_id)
        room = db.get(InventoryItem, recon_api_context.batch_room_id)
        food = db.get(Food, recon_api_context.food_id)
        ops = list(db.scalars(select(InventoryOperation)))
        activities = list(
            db.scalars(select(ActivityLog).where(ActivityLog.entity_type == "InventoryOperation"))
        )
        assert fresh is not None and fresh.last_confirmed_at is not None
        assert fresh.last_confirmation_source == InventoryConfirmationSource.RECONCILIATION
        assert remaining_quantity(fresh) == Decimal("6")
        assert expired is not None and expired.last_confirmed_at is not None
        assert remaining_quantity(expired) == Decimal("3")
        # out-of-scope untouched
        assert room is not None and room.last_confirmed_at is None
        assert remaining_quantity(room) == Decimal("4")
        assert food is not None and food.inventory_last_confirmed_at is not None
        assert food.stock_quantity == Decimal("2.00")
        assert len(ops) == 1
        assert len(activities) == 1
        lines = list(db.scalars(select(InventoryOperationLine)))
        assert any(line.entity_type.value == "ingredient" for line in lines)


def test_set_absent_includes_expired_and_leaves_out_of_scope(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-absent-1",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "set_absent",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        expired = db.get(InventoryItem, recon_api_context.batch_cold_expired_id)
        room = db.get(InventoryItem, recon_api_context.batch_room_id)
        assert fresh is not None and remaining_quantity(fresh) == Decimal("0")
        assert expired is not None and remaining_quantity(expired) == Decimal("0")
        assert room is not None and remaining_quantity(room) == Decimal("4")


def test_adjust_batches_quantity_and_create(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-adjust-1",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                        "actual_remaining_quantity": "4",
                        "inventory_status": InventoryStatus.OPENED.value,
                        "purchase_date": "2026-07-01",
                        "expiry_date": "2026-07-18",
                        "storage_location": "冷藏",
                        "notes": "纠错",
                    }
                ],
                "creates": [
                    {
                        "client_line_id": "line-new-1",
                        "actual_remaining_quantity": "2",
                        "unit": "个",
                        "inventory_status": InventoryStatus.FRESH.value,
                        "purchase_date": "2026-07-12",
                        "expiry_date": "2026-07-26",
                        "storage_location": "冷藏",
                        "notes": "漏记",
                    }
                ],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        expired = db.get(InventoryItem, recon_api_context.batch_cold_expired_id)
        assert fresh is not None
        assert remaining_quantity(fresh) == Decimal("4")
        assert fresh.status == InventoryStatus.OPENED
        assert fresh.notes == "纠错"
        assert fresh.unit == "个"
        assert fresh.entered_quantity == Decimal("6.00")
        assert expired is not None
        assert remaining_quantity(expired) == Decimal("3")
        assert expired.last_confirmed_at is not None
        created = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.family_id == recon_api_context.family_id,
                    InventoryItem.id.notin_(
                        [
                            recon_api_context.batch_cold_fresh_id,
                            recon_api_context.batch_cold_expired_id,
                            recon_api_context.batch_cold_zero_id,
                            recon_api_context.batch_room_id,
                        ]
                    ),
                )
            )
        )
        assert len(created) == 1
        assert remaining_quantity(created[0]) == Decimal("2")
        assert created[0].last_confirmation_source == InventoryConfirmationSource.RECONCILIATION


def test_adjust_batch_expiry_clears_reminder_and_revert_restores_it(
    recon_api_context: ReconApiContext,
) -> None:
    original_expiry = date(2026, 7, 20)
    original_snoozed_until = date(2026, 7, 25)
    original_reviewed_at = datetime(2026, 7, 10, 8, 30, tzinfo=timezone.utc)
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        assert fresh.expiry_date == original_expiry
        fresh.expiry_alert_snoozed_until = original_snoozed_until
        fresh.expiry_reviewed_at = original_reviewed_at
        fresh.expiry_reviewed_by = recon_api_context.user_id
        db.commit()

    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-adjust-expiry-reminder",
        "scope": "refrigerated",
        "storage_location": None,
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                        "actual_remaining_quantity": "6",
                        "inventory_status": InventoryStatus.FRESH.value,
                        "purchase_date": "2026-07-01",
                        "expiry_date": "2026-07-18",
                        "storage_location": "冷藏",
                        "notes": "",
                    }
                ],
                "creates": [],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]

    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        assert fresh.expiry_date == date(2026, 7, 18)
        assert fresh.expiry_alert_snoozed_until is None
        assert fresh.expiry_reviewed_at is None
        assert fresh.expiry_reviewed_by is None

    revert_response = recon_api_context.client.post(
        f"/api/inventory/operations/{operation_id}/revert"
    )
    assert revert_response.status_code == 200, revert_response.text

    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        assert fresh.expiry_date == original_expiry
        assert fresh.expiry_alert_snoozed_until == original_snoozed_until
        assert fresh.expiry_reviewed_at is not None
        restored_reviewed_at = fresh.expiry_reviewed_at
        if restored_reviewed_at.tzinfo is None:
            restored_reviewed_at = restored_reviewed_at.replace(tzinfo=timezone.utc)
        assert restored_reviewed_at == original_reviewed_at
        assert fresh.expiry_reviewed_by == recon_api_context.user_id


def test_presence_and_food_set_stock(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-presence-food",
        "scope": "all",
        "groups": [
            {
                "kind": "presence_ingredient",
                "ingredient_id": recon_api_context.salt_id,
                "state_id": recon_api_context.salt_state_id,
                "expected_ingredient_row_version": versions["salt"],
                "expected_state_row_version": versions["salt_state"],
                "availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
                "inventory_status": InventoryStatus.FRESH.value,
                "purchase_date": "2026-07-01",
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "够用",
            },
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "set_stock",
                "stock_quantity": "5",
                "stock_unit": "份",
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
            },
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    with recon_api_context.SessionLocal() as db:
        state = db.get(IngredientInventoryState, recon_api_context.salt_state_id)
        food = db.get(Food, recon_api_context.food_id)
        shopping = list(db.scalars(select(ShoppingListItem).where(ShoppingListItem.done.is_(False))))
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
        assert state.last_confirmation_source == InventoryConfirmationSource.RECONCILIATION
        assert food is not None
        assert food.stock_quantity == Decimal("5.00")
        assert food.expiry_date == date(2026, 7, 20)
        # low does not create shopping; existing pending remains only egg
        assert all(item.ingredient_id != recon_api_context.salt_id for item in shopping)


def test_food_quantity_precision_is_rejected_before_any_reconciliation_mutation(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-food-precision",
        "scope": "all",
        "groups": [
            {
                "kind": "presence_ingredient",
                "ingredient_id": recon_api_context.salt_id,
                "state_id": recon_api_context.salt_state_id,
                "expected_ingredient_row_version": versions["salt"],
                "expected_state_row_version": versions["salt_state"],
                "availability_level": "sufficient",
                "inventory_status": "fresh",
                "purchase_date": "2026-07-12",
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "够用",
            },
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "set_stock",
                "stock_quantity": "1.25",
                "stock_unit": "份",
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
            },
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_quantity"
    assert detail["field_errors"] == [
        {
            "field": "stock_quantity",
            "code": "invalid_quantity",
            "message": "库存数量最多保留 1 位小数",
            "entity_id": recon_api_context.food_id,
        }
    ]
    with recon_api_context.SessionLocal() as db:
        salt_state = db.get(IngredientInventoryState, recon_api_context.salt_state_id)
        food = db.get(Food, recon_api_context.food_id)
        assert salt_state is not None and food is not None
        assert salt_state.availability_level == InventoryAvailabilityLevel.LOW
        assert food.stock_quantity == Decimal("2.00")
        assert db.scalar(select(InventoryOperation)) is None


def test_food_set_stock_rejects_a_different_unit_before_any_reconciliation_mutation(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-food-incompatible-unit",
        "scope": "all",
        "groups": [
            {
                "kind": "presence_ingredient",
                "ingredient_id": recon_api_context.salt_id,
                "state_id": recon_api_context.salt_state_id,
                "expected_ingredient_row_version": versions["salt"],
                "expected_state_row_version": versions["salt_state"],
                "availability_level": "sufficient",
                "inventory_status": "fresh",
                "purchase_date": "2026-07-12",
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "不应写入",
            },
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "set_stock",
                "stock_quantity": "2",
                "stock_unit": "盒",
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
            },
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "incompatible_unit",
        "message": "当前食物库存单位是 份，不能按 盒 盘点",
        "conflicts": [],
        "field_errors": [
            {
                "field": "stock_unit",
                "code": "incompatible_unit",
                "message": "当前食物库存单位是 份，不能按 盒 盘点",
                "entity_id": recon_api_context.food_id,
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        salt_state = db.get(IngredientInventoryState, recon_api_context.salt_state_id)
        food = db.get(Food, recon_api_context.food_id)
        assert salt_state is not None and food is not None
        assert salt_state.availability_level == InventoryAvailabilityLevel.LOW
        assert food.stock_quantity == Decimal("2.00")
        assert food.stock_unit == "份"
        assert food.expiry_date == date(2026, 7, 15)
        assert db.scalar(select(InventoryOperation)) is None


def test_reconciliation_schema_errors_use_the_structured_detail_contract(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-food-missing-location",
        "scope": "all",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "set_stock",
                "stock_quantity": "2",
                "stock_unit": "份",
                "expiry_date": "2026-07-20",
                "storage_location": None,
            }
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_request",
        "message": "正库存必须提供存放位置",
        "conflicts": [],
        "field_errors": [
            {
                "field": "groups.0.storage_location",
                "code": "invalid_request",
                "message": "正库存必须提供存放位置",
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None


def test_adjust_batches_rejects_an_unsupported_new_batch_unit_before_any_mutation(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-invalid-create-unit",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                        "actual_remaining_quantity": "4",
                        "inventory_status": InventoryStatus.OPENED.value,
                        "purchase_date": "2026-07-01",
                        "expiry_date": "2026-07-18",
                        "storage_location": "冷藏",
                        "notes": "不应写入",
                    }
                ],
                "creates": [
                    {
                        "client_line_id": "line-invalid-unit",
                        "actual_remaining_quantity": "2",
                        "unit": "盒",
                        "inventory_status": InventoryStatus.FRESH.value,
                        "purchase_date": "2026-07-12",
                        "expiry_date": "2026-07-26",
                        "storage_location": "冷藏",
                        "notes": "不应创建",
                    }
                ],
            }
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "incompatible_unit",
        "message": "不支持单位 盒",
        "conflicts": [],
        "field_errors": [
            {
                "field": "groups.0.creates.0.unit",
                "code": "incompatible_unit",
                "message": "不支持单位 盒",
                "entity_id": recon_api_context.egg_id,
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        assert remaining_quantity(fresh) == Decimal("6")
        assert fresh.notes == ""
        assert db.scalar(select(InventoryOperation)) is None


def test_adjust_batches_rejects_a_new_batch_that_rounds_to_zero_quantity(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-zero-after-normalization",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [],
                "creates": [
                    {
                        "client_line_id": "line-rounds-to-zero",
                        "actual_remaining_quantity": "0.001",
                        "unit": "个",
                        "inventory_status": InventoryStatus.FRESH.value,
                        "purchase_date": "2026-07-12",
                        "expiry_date": None,
                        "storage_location": "冷藏",
                        "notes": "不应创建",
                    }
                ],
            }
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_quantity",
        "message": "新增批次换算后的数量必须大于 0",
        "conflicts": [],
        "field_errors": [
            {
                "field": "groups.0.creates.0.actual_remaining_quantity",
                "code": "invalid_quantity",
                "message": "新增批次换算后的数量必须大于 0",
                "entity_id": recon_api_context.egg_id,
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None


def test_adjust_batches_rejects_a_new_batch_expiring_before_its_purchase_date(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-invalid-create-date-range",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [],
                "creates": [
                    {
                        "client_line_id": "line-invalid-date-range",
                        "actual_remaining_quantity": "2",
                        "unit": "个",
                        "inventory_status": InventoryStatus.FRESH.value,
                        "purchase_date": "2026-07-12",
                        "expiry_date": "2026-07-01",
                        "storage_location": "冷藏",
                        "notes": "不应创建",
                    }
                ],
            }
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_date_range",
        "message": "到期日不能早于采购日",
        "conflicts": [],
        "field_errors": [
            {
                "field": "groups.0.creates.0.expiry_date",
                "code": "invalid_date_range",
                "message": "到期日不能早于采购日",
                "entity_id": recon_api_context.egg_id,
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None
        created = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.family_id == recon_api_context.family_id,
                    InventoryItem.ingredient_id == recon_api_context.egg_id,
                )
            )
        )
        assert {item.id for item in created} == {
            recon_api_context.batch_cold_fresh_id,
            recon_api_context.batch_cold_expired_id,
            recon_api_context.batch_cold_zero_id,
            recon_api_context.batch_room_id,
        }


def test_adjust_batches_rejects_an_updated_batch_expiring_before_its_purchase_date(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-invalid-update-date-range",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "adjust_batches",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
                "updates": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                        "actual_remaining_quantity": "4",
                        "inventory_status": InventoryStatus.OPENED.value,
                        "purchase_date": "2026-07-12",
                        "expiry_date": "2026-07-01",
                        "storage_location": "冷藏",
                        "notes": "不应写入",
                    }
                ],
                "creates": [],
            }
        ],
    }

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_date_range",
        "message": "到期日不能早于采购日",
        "conflicts": [],
        "field_errors": [
            {
                "field": "groups.0.updates.0.expiry_date",
                "code": "invalid_date_range",
                "message": "到期日不能早于采购日",
                "entity_id": recon_api_context.egg_id,
            }
        ],
    }
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        assert fresh.purchase_date == date(2026, 7, 1)
        assert fresh.expiry_date == date(2026, 7, 20)
        assert db.scalar(select(InventoryOperation)) is None


def test_stale_child_version_409(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-stale-child",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "confirm_all",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": 1,
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    # Force child version ahead of expected.
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None
        fresh.notes = "外部改动"
        db.commit()
        db.refresh(fresh)
        assert fresh.row_version > 1

    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "stale_version"
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None
        assert _highlight_rows(db, family_id=recon_api_context.family_id) == []


def test_out_of_scope_parent_version_409(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    # Bump parent via out-of-scope room batch edit.
    with recon_api_context.SessionLocal() as db:
        room = db.get(InventoryItem, recon_api_context.batch_room_id)
        egg = db.get(Ingredient, recon_api_context.egg_id)
        assert room is not None and egg is not None
        room.notes = "常温改动"
        egg.row_version += 1
        db.commit()
        db.refresh(egg)
        current_egg_version = egg.row_version

    payload = {
        "client_request_id": "recon-stale-parent",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "confirm_all",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "stale_version"
    with recon_api_context.SessionLocal() as db:
        egg = db.get(Ingredient, recon_api_context.egg_id)
        assert egg is not None and egg.row_version == current_egg_version
        assert db.scalar(select(InventoryOperation)) is None


def test_scope_changed_new_in_scope_batch_409(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    with recon_api_context.SessionLocal() as db:
        egg = db.get(Ingredient, recon_api_context.egg_id)
        assert egg is not None
        new_batch = InventoryItem(
            id="batch-cold-new",
            family_id=recon_api_context.family_id,
            ingredient_id=egg.id,
            quantity=Decimal("1"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("1"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 12),
            expiry_date=date(2026, 7, 25),
            storage_location="冷藏",
            notes="新增",
            created_by=recon_api_context.user_id,
            updated_by=recon_api_context.user_id,
        )
        egg.row_version += 1
        db.add(new_batch)
        db.commit()
        db.refresh(egg)
        current_egg_version = egg.row_version

    payload = {
        "client_request_id": "recon-scope-changed",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": current_egg_version,
                "action": "confirm_all",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "scope_changed"


def test_tracking_mode_changed_409(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    with recon_api_context.SessionLocal() as db:
        egg = db.get(Ingredient, recon_api_context.egg_id)
        assert egg is not None
        egg.quantity_tracking_mode = IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY
        db.commit()

    payload = {
        "client_request_id": "recon-mode-changed",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "confirm_all",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "tracking_mode_changed"


def test_missing_entity_409(recon_api_context: ReconApiContext) -> None:
    payload = {
        "client_request_id": "recon-missing",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": "ingredient-does-not-exist",
                "expected_ingredient_row_version": 1,
                "action": "confirm_all",
                "observed_batches": [],
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "missing_target"
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None


def test_idempotent_replay(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-idempotent",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            }
        ],
    }
    first = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert first.status_code == 200, first.text
    second = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["operation_id"] == first.json()["operation_id"]
    with recon_api_context.SessionLocal() as db:
        assert len(list(db.scalars(select(InventoryOperation)))) == 1


def test_reconciliation_writes_one_highlight_and_replay_does_not_duplicate(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-highlight-1",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            }
        ],
    }
    first = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    replay = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    with recon_api_context.SessionLocal() as db:
        assert len(list(db.scalars(select(InventoryOperation)))) == 1
        highlights = _highlight_rows(db, family_id=recon_api_context.family_id)
        assert len(highlights) == 1
        assert highlights[0].highlight_kind is ActivityHighlightKind.INVENTORY
        assert highlights[0].highlight_summary == "完成库存盘点并确认 1 项、修正 0 项"


def test_idempotent_reconciliation_replay_computes_can_revert_for_requesting_member(
    recon_api_context: ReconApiContext,
) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-idempotent-permission",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            }
        ],
    }
    first = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["can_revert"] is True

    with recon_api_context.SessionLocal() as db:
        second_user = User(
            id="user-recon-second",
            username="recon-second",
            display_name="另一成员",
            avatar_seed="",
            is_active=True,
        )
        second_membership = Membership(
            id="membership-recon-second",
            family_id=recon_api_context.family_id,
            user_id=second_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        db.add_all([second_user, second_membership])
        db.commit()

    def override_second_auth() -> tuple[User, Membership]:
        with recon_api_context.SessionLocal() as db:
            user = db.get(User, "user-recon-second")
            membership = db.get(Membership, "membership-recon-second")
            assert user is not None and membership is not None
            return user, membership

    app.dependency_overrides[get_current_auth] = override_second_auth
    member_replay = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert member_replay.status_code == 200, member_replay.text
    assert member_replay.json()["can_revert"] is False

    with recon_api_context.SessionLocal() as db:
        membership = db.get(Membership, "membership-recon-second")
        assert membership is not None
        membership.role = UserRole.OWNER
        db.commit()

    owner_replay = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert owner_replay.status_code == 200, owner_replay.text
    assert owner_replay.json()["can_revert"] is True


def test_forced_commit_failure_rolls_back(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-rollback",
        "scope": "refrigerated",
        "groups": [
            {
                "kind": "exact_ingredient",
                "ingredient_id": recon_api_context.egg_id,
                "expected_ingredient_row_version": versions["egg"],
                "action": "set_absent",
                "observed_batches": [
                    {
                        "inventory_item_id": recon_api_context.batch_cold_fresh_id,
                        "expected_row_version": versions["fresh"],
                    },
                    {
                        "inventory_item_id": recon_api_context.batch_cold_expired_id,
                        "expected_row_version": versions["expired"],
                    },
                ],
            }
        ],
    }
    with fail_next_commit("recon commit failed"):
        with pytest.raises(RuntimeError, match="recon commit failed"):
            recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    with recon_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, recon_api_context.batch_cold_fresh_id)
        assert fresh is not None and remaining_quantity(fresh) == Decimal("6")
        assert db.scalar(select(InventoryOperation)) is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "InventoryOperation")) is None
        assert _highlight_rows(db, family_id=recon_api_context.family_id) == []


def test_duplicate_group_rejected(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-dup",
        "scope": "all",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            },
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "confirm",
            },
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "duplicate_request_item"
    assert "message" in detail
    with recon_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryOperation)) is None


def test_presence_first_create_with_null_state_id(recon_api_context: ReconApiContext) -> None:
    # Add a presence-tracked ingredient that has no state row yet.
    with recon_api_context.SessionLocal() as db:
        pepper = Ingredient(
            id="ingredient-pepper",
            family_id=recon_api_context.family_id,
            name="胡椒",
            category="调味",
            default_unit="瓶",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=recon_api_context.user_id,
            updated_by=recon_api_context.user_id,
        )
        db.add(pepper)
        db.commit()
        db.refresh(pepper)
        pepper_version = pepper.row_version

    payload = {
        "client_request_id": "recon-presence-create",
        "scope": "all",
        "groups": [
            {
                "kind": "presence_ingredient",
                "ingredient_id": "ingredient-pepper",
                "state_id": None,
                "expected_ingredient_row_version": pepper_version,
                "expected_state_row_version": None,
                "availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
                "inventory_status": InventoryStatus.FRESH.value,
                "purchase_date": "2026-07-01",
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "首建",
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    with recon_api_context.SessionLocal() as db:
        state = db.scalar(
            select(IngredientInventoryState).where(
                IngredientInventoryState.ingredient_id == "ingredient-pepper"
            )
        )
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
        assert state.storage_location == "常温"
        assert state.last_confirmation_source == InventoryConfirmationSource.RECONCILIATION
        ops = list(db.scalars(select(InventoryOperation)))
        assert len(ops) == 1


def test_food_set_stock_zero_clears_location(recon_api_context: ReconApiContext) -> None:
    versions = _versions(recon_api_context)
    payload = {
        "client_request_id": "recon-food-zero",
        "scope": "all",
        "groups": [
            {
                "kind": "food",
                "food_id": recon_api_context.food_id,
                "expected_row_version": versions["food"],
                "action": "set_stock",
                "stock_quantity": "0",
                "stock_unit": None,
                "expiry_date": None,
                "storage_location": None,
            }
        ],
    }
    response = recon_api_context.client.post("/api/inventory/reconciliations", json=payload)
    assert response.status_code == 200, response.text
    with recon_api_context.SessionLocal() as db:
        food = db.get(Food, recon_api_context.food_id)
        assert food is not None
        assert food.stock_quantity == Decimal("0.00")
        assert (food.storage_location or "") == ""


def test_confirmation_status_helper_boundaries() -> None:
    from app.services.inventory_confirmation import confirmation_status

    generated = datetime(2026, 7, 12, 12, 0, tzinfo=timezone.utc)
    assert confirmation_status(None, generated_at=generated, stale_after_days=7) == "never_confirmed"
    assert (
        confirmation_status(
            generated - timedelta(days=6),
            generated_at=generated,
            stale_after_days=7,
        )
        == "current"
    )
    assert (
        confirmation_status(
            generated - timedelta(days=8),
            generated_at=generated,
            stale_after_days=7,
        )
        == "stale"
    )
