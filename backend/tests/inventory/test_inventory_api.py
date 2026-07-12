from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import (
    ActivityAction,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.core.utils import utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    ActivityLog,
    Base,
    Family,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    Membership,
    User,
)
from app.services.clock import today_for_family
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
from tests._transaction_failure import fail_next_commit



@dataclass(frozen=True)
class InventoryApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    other_user_id: str
    membership_id: str
    ingredient_id: str
    other_ingredient_id: str
    item_id: str
    other_item_id: str


@pytest.fixture()
def inventory_api_context() -> Iterator[InventoryApiContext]:
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
    today = today_for_family("family-inventory")

    with SessionLocal() as db:
        family = Family(id="family-inventory", name="库存家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        user = User(id="user-inventory", username="inventory-user", display_name="库存用户", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other-inventory-user", display_name="其他用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-inventory",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        ingredient = Ingredient(
            id="ingredient-own",
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
        other_ingredient = Ingredient(
            id="ingredient-other",
            family_id=other_family.id,
            name="鸡蛋",
            category="蛋奶",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        own_item = InventoryItem(
            id="inventory-own",
            family_id=family.id,
            ingredient_id=ingredient.id,
            ingredient=ingredient,
            quantity=Decimal("10"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("10"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today,
            expiry_date=today + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("2"),
            created_by=user.id,
            updated_by=user.id,
        )
        other_item = InventoryItem(
            id="inventory-other",
            family_id=other_family.id,
            ingredient_id=other_ingredient.id,
            ingredient=other_ingredient,
            quantity=Decimal("12"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("12"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today,
            expiry_date=today + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("2"),
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        db.add_all(
            [
                family,
                other_family,
                user,
                other_user,
                membership,
                other_membership,
                ingredient,
                other_ingredient,
                own_item,
                other_item,
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
        with SessionLocal() as db:
            user = db.get(User, "user-inventory")
            membership = db.get(Membership, "membership-inventory")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield InventoryApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-inventory",
            other_family_id="family-other",
            user_id="user-inventory",
            other_user_id="user-other",
            membership_id="membership-inventory",
            ingredient_id="ingredient-own",
            other_ingredient_id="ingredient-other",
            item_id="inventory-own",
            other_item_id="inventory-other",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_list_inventory_returns_only_current_family_items(inventory_api_context: InventoryApiContext) -> None:
    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        item.last_confirmed_at = utcnow()
        item.last_confirmed_by = inventory_api_context.user_id
        item.last_confirmation_source = InventoryConfirmationSource.RECONCILIATION
        db.commit()
        expected_row_version = item.row_version

    response = inventory_api_context.client.get("/api/inventory")

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [inventory_api_context.item_id]
    assert payload[0]["family_id"] == inventory_api_context.family_id
    assert payload[0]["ingredient_name"] == "番茄"
    assert payload[0]["row_version"] == expected_row_version
    assert payload[0]["expiry_alert_snoozed_until"] is None
    assert payload[0]["expiry_reviewed_at"] is None
    assert payload[0]["expiry_reviewed_by"] is None
    assert payload[0]["last_confirmed_at"] is not None
    assert payload[0]["last_confirmed_by"] == inventory_api_context.user_id
    assert payload[0]["last_confirmation_source"] == "reconciliation"


def test_create_inventory_item_sets_audit_fields_and_activity_log(inventory_api_context: InventoryApiContext) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 4,
            "unit": "个",
            "status": "fresh",
            "purchase_date": "2026-06-28",
            "expiry_date": "2026-07-03",
            "storage_location": "冷藏",
            "notes": "周末采购",
            "low_stock_threshold": 1,
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["family_id"] == inventory_api_context.family_id
    assert payload["ingredient_id"] == inventory_api_context.ingredient_id
    assert payload["created_by"] == inventory_api_context.user_id
    assert payload["updated_by"] == inventory_api_context.user_id
    assert payload["row_version"] == 1
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, payload["id"])
        assert item is not None
        assert item.family_id == inventory_api_context.family_id
        assert item.created_by == inventory_api_context.user_id
        assert item.updated_by == inventory_api_context.user_id
        assert item.row_version == 1
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        assert ingredient.row_version == 2

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.CREATE,
                ActivityLog.entity_type == "InventoryItem",
                ActivityLog.entity_id == item.id,
            )
        )
        assert log is not None
        assert log.summary == "录入库存 番茄 4个"


def test_create_inventory_item_rejects_other_family_ingredient_without_side_effects(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory",
        json={
            "ingredient_id": inventory_api_context.other_ingredient_id,
            "quantity": 6,
            "unit": "个",
            "status": "fresh",
            "purchase_date": "2026-06-28",
            "expiry_date": "2026-07-03",
            "storage_location": "冷藏",
            "notes": "不应创建",
            "low_stock_threshold": 1,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with inventory_api_context.SessionLocal() as db:
        created = db.scalar(
            select(InventoryItem).where(
                InventoryItem.family_id == inventory_api_context.family_id,
                InventoryItem.ingredient_id == inventory_api_context.other_ingredient_id,
            )
        )
        assert created is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "录入库存 鸡蛋 6个")) is None


def test_consume_inventory_updates_current_family_batch_and_activity_log(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 3,
            "unit": "个",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "unit": "个",
        "consumed_quantity": 3.0,
        "affected_item_ids": [inventory_api_context.item_id],
    }

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.consumed_quantity == Decimal("3")
        assert item.updated_by == inventory_api_context.user_id
        assert item.row_version == 2
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        assert ingredient.row_version == 2

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "Ingredient",
                ActivityLog.entity_id == inventory_api_context.ingredient_id,
            )
        )
        assert log is not None
        assert log.summary == "消费食材 番茄 3个"


def test_consume_inventory_rolls_back_deduction_when_commit_fails(inventory_api_context: InventoryApiContext) -> None:
    with fail_next_commit("inventory commit failed"):
        with pytest.raises(RuntimeError, match="inventory commit failed"):
            inventory_api_context.client.post(
                "/api/inventory/consume",
                json={
                    "ingredient_id": inventory_api_context.ingredient_id,
                    "quantity": 3,
                    "unit": "个",
                },
            )

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.consumed_quantity == Decimal("0")
        assert item.updated_by == inventory_api_context.user_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "消费食材 番茄 3个")) is None


def test_consume_inventory_rejects_other_family_ingredient_without_side_effects(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.other_ingredient_id,
            "quantity": 3,
            "unit": "个",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with inventory_api_context.SessionLocal() as db:
        other_item = db.get(InventoryItem, inventory_api_context.other_item_id)
        assert other_item is not None
        assert other_item.consumed_quantity == Decimal("0")
        assert other_item.updated_by == inventory_api_context.other_user_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "消费食材 鸡蛋 3个")) is None


def test_dispose_inventory_updates_current_family_batch_and_activity_log(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.item_id,
            "expected_row_version": 1,
            "quantity": 2,
            "unit": "个",
            "reason": "坏掉",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "inventory_item_id": inventory_api_context.item_id,
        "unit": "个",
        "disposed_quantity": 2.0,
        "remaining_quantity": 8.0,
    }

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.disposed_quantity == Decimal("2")
        assert item.updated_by == inventory_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "InventoryItem",
                ActivityLog.entity_id == inventory_api_context.item_id,
            )
        )
        assert log is not None
        assert log.summary == "销毁库存 番茄 2个：坏掉"


def test_dispose_inventory_rejects_other_family_item_without_modifying_it(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.other_item_id,
            "expected_row_version": 1,
            "quantity": 2,
            "unit": "个",
            "reason": "坏掉",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "库存批次不存在或不属于当前家庭"

    with inventory_api_context.SessionLocal() as db:
        other_item = db.get(InventoryItem, inventory_api_context.other_item_id)
        assert other_item is not None
        assert other_item.disposed_quantity == Decimal("0")
        assert other_item.updated_by == inventory_api_context.other_user_id
        assert (
            db.scalar(
                select(ActivityLog).where(
                    ActivityLog.family_id == inventory_api_context.family_id,
                    ActivityLog.entity_id == inventory_api_context.other_item_id,
                )
            )
            is None
        )


def test_inventory_requires_authentication(inventory_api_context: InventoryApiContext) -> None:
    app.dependency_overrides.pop(get_current_auth, None)

    response = inventory_api_context.client.get("/api/inventory")

    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"



def _business_today(family_id: str = "family-inventory"):
    return today_for_family(family_id)


def _add_inventory_item(
    ctx: InventoryApiContext,
    *,
    item_id: str,
    ingredient_id: str | None = None,
    family_id: str | None = None,
    quantity: str = "5",
    consumed: str = "0",
    disposed: str = "0",
    expiry_date=None,
    purchase_date=None,
    storage_location: str = "冷藏",
    row_version: int = 1,
    expiry_alert_snoozed_until=None,
    expiry_reviewed_at=None,
    expiry_reviewed_by=None,
    updated_by: str | None = None,
) -> None:
    today = _business_today(ctx.family_id)
    with ctx.SessionLocal() as db:
        item = InventoryItem(
            id=item_id,
            family_id=family_id or ctx.family_id,
            ingredient_id=ingredient_id or ctx.ingredient_id,
            quantity=Decimal(quantity),
            consumed_quantity=Decimal(consumed),
            disposed_quantity=Decimal(disposed),
            unit="个",
            entered_quantity=Decimal(quantity),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=purchase_date or today,
            expiry_date=expiry_date,
            storage_location=storage_location,
            notes="",
            low_stock_threshold=Decimal("0"),
            row_version=row_version,
            expiry_alert_snoozed_until=expiry_alert_snoozed_until,
            expiry_reviewed_at=expiry_reviewed_at,
            expiry_reviewed_by=expiry_reviewed_by,
            created_by=updated_by or ctx.user_id,
            updated_by=updated_by or ctx.user_id,
        )
        db.add(item)
        db.commit()


def _add_family_ingredient(
    ctx: InventoryApiContext,
    *,
    ingredient_id: str,
    name: str,
    family_id: str | None = None,
) -> None:
    with ctx.SessionLocal() as db:
        ingredient = Ingredient(
            id=ingredient_id,
            family_id=family_id or ctx.family_id,
            name=name,
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=ctx.user_id,
            updated_by=ctx.user_id,
        )
        db.add(ingredient)
        db.commit()


def _versioned_item(item_id: str, expected_row_version: int = 1) -> dict:
    return {"inventory_item_id": item_id, "expected_row_version": expected_row_version}


def _reload_item(ctx: InventoryApiContext, item_id: str) -> InventoryItem:
    with ctx.SessionLocal() as db:
        item = db.get(InventoryItem, item_id)
        assert item is not None
        db.expunge(item)
        return item


def test_snooze_two_expired_batches_writes_common_review_and_snooze(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=3)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-expired-a",
        expiry_date=today - timedelta(days=2),
        quantity="3",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-expired-b",
        expiry_date=today - timedelta(days=1),
        quantity="4",
    )

    response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-expired-a"),
                _versioned_item("inventory-expired-b"),
            ],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "snoozed_item_ids": ["inventory-expired-a", "inventory-expired-b"],
        "snoozed_count": 2,
        "reviewed_expired_count": 2,
        "snoozed_until": snoozed_until.isoformat(),
    }

    first = _reload_item(inventory_api_context, "inventory-expired-a")
    second = _reload_item(inventory_api_context, "inventory-expired-b")
    assert first.expiry_date == today - timedelta(days=2)
    assert second.expiry_date == today - timedelta(days=1)
    assert first.quantity == Decimal("3")
    assert second.quantity == Decimal("4")
    assert first.expiry_alert_snoozed_until == snoozed_until
    assert second.expiry_alert_snoozed_until == snoozed_until
    assert first.expiry_reviewed_by == inventory_api_context.user_id
    assert second.expiry_reviewed_by == inventory_api_context.user_id
    assert first.expiry_reviewed_at is not None
    assert second.expiry_reviewed_at is not None
    assert first.expiry_reviewed_at == second.expiry_reviewed_at
    assert first.updated_by == inventory_api_context.user_id
    assert second.updated_by == inventory_api_context.user_id
    assert first.row_version == 2
    assert second.row_version == 2

    with inventory_api_context.SessionLocal() as db:
        logs = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.family_id == inventory_api_context.family_id,
                    ActivityLog.actor_id == inventory_api_context.user_id,
                    ActivityLog.entity_type == "Ingredient",
                    ActivityLog.entity_id == inventory_api_context.ingredient_id,
                )
            )
        )
        assert len(logs) == 1
        assert "暂时保留" in logs[0].summary
        assert "番茄" in logs[0].summary
        assert "2" in logs[0].summary
        assert f"{snoozed_until.month}月{snoozed_until.day}日" in logs[0].summary


def test_snooze_upcoming_batch_writes_alert_date_without_review_attribution(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-upcoming",
        expiry_date=today + timedelta(days=3),
        quantity="2",
    )

    response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "snooze_upcoming",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-upcoming")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["reviewed_expired_count"] == 0
    assert payload["snoozed_count"] == 1
    assert payload["snoozed_item_ids"] == ["inventory-upcoming"]

    item = _reload_item(inventory_api_context, "inventory-upcoming")
    assert item.expiry_alert_snoozed_until == snoozed_until
    assert item.expiry_reviewed_at is None
    assert item.expiry_reviewed_by is None
    assert item.expiry_date == today + timedelta(days=3)
    assert item.row_version == 2


def test_mixed_expired_and_upcoming_snooze_is_rejected_atomically(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-mixed-expired",
        expiry_date=today - timedelta(days=1),
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-mixed-upcoming",
        expiry_date=today + timedelta(days=2),
    )

    response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-mixed-expired"),
                _versioned_item("inventory-mixed-upcoming"),
            ],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert response.status_code == 400
    first = _reload_item(inventory_api_context, "inventory-mixed-expired")
    second = _reload_item(inventory_api_context, "inventory-mixed-upcoming")
    assert first.expiry_alert_snoozed_until is None
    assert second.expiry_alert_snoozed_until is None
    assert first.row_version == 1
    assert second.row_version == 1


def test_retain_expired_rejects_non_expired_and_snooze_upcoming_rejects_expired(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-not-expired",
        expiry_date=today + timedelta(days=1),
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-is-expired",
        expiry_date=today - timedelta(days=1),
    )

    retain_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-not-expired")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    upcoming_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "snooze_upcoming",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-is-expired")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert retain_response.status_code == 400
    assert upcoming_response.status_code == 400
    assert _reload_item(inventory_api_context, "inventory-not-expired").expiry_alert_snoozed_until is None
    assert _reload_item(inventory_api_context, "inventory-is-expired").expiry_alert_snoozed_until is None


def test_snooze_window_and_future_snooze_reentry_rules(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-eight-days",
        expiry_date=today + timedelta(days=8),
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-seven-days",
        expiry_date=today + timedelta(days=7),
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-future-snoozed",
        expiry_date=today + timedelta(days=3),
        expiry_alert_snoozed_until=today + timedelta(days=1),
    )

    eight_day_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "snooze_upcoming",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-eight-days")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    seven_day_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "snooze_upcoming",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-seven-days")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    future_snoozed_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "snooze_upcoming",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-future-snoozed")],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert eight_day_response.status_code == 400
    assert seven_day_response.status_code == 200, seven_day_response.text
    assert future_snoozed_response.status_code == 400
    assert _reload_item(inventory_api_context, "inventory-eight-days").expiry_alert_snoozed_until is None
    assert _reload_item(inventory_api_context, "inventory-seven-days").expiry_alert_snoozed_until == snoozed_until
    assert _reload_item(inventory_api_context, "inventory-future-snoozed").expiry_alert_snoozed_until == today + timedelta(days=1)


def test_row_becomes_actionable_again_on_snooze_date(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    next_snooze = today + timedelta(days=3)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-snooze-due",
        expiry_date=today - timedelta(days=1),
        expiry_alert_snoozed_until=today,
        expiry_reviewed_at=None,
        expiry_reviewed_by=None,
    )

    response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-snooze-due")],
            "snoozed_until": next_snooze.isoformat(),
        },
    )

    assert response.status_code == 200, response.text
    item = _reload_item(inventory_api_context, "inventory-snooze-due")
    assert item.expiry_alert_snoozed_until == next_snooze
    assert item.expiry_reviewed_by == inventory_api_context.user_id
    assert item.expiry_reviewed_at is not None


def test_reminder_dates_outside_valid_window_are_rejected(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-date-window",
        expiry_date=today - timedelta(days=1),
    )

    on_today = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-date-window")],
            "snoozed_until": today.isoformat(),
        },
    )
    too_far = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-date-window")],
            "snoozed_until": (today + timedelta(days=31)).isoformat(),
        },
    )
    boundary_ok = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-date-window")],
            "snoozed_until": (today + timedelta(days=30)).isoformat(),
        },
    )

    assert on_today.status_code == 400
    assert too_far.status_code == 400
    assert boundary_ok.status_code == 200, boundary_ok.text
    item = _reload_item(inventory_api_context, "inventory-date-window")
    assert item.expiry_alert_snoozed_until == today + timedelta(days=30)


def test_correct_expiry_date_clears_review_and_snooze_metadata(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    reviewed_at = today  # placeholder only for setup; actual field is datetime
    from app.core.utils import utcnow

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        item.expiry_date = today - timedelta(days=1)
        item.expiry_alert_snoozed_until = today + timedelta(days=2)
        item.expiry_reviewed_at = utcnow()
        item.expiry_reviewed_by = inventory_api_context.user_id
        db.commit()

    with inventory_api_context.SessionLocal() as db:
        prepared = db.get(InventoryItem, inventory_api_context.item_id)
        assert prepared is not None
        prepared_version = prepared.row_version

    corrected = today + timedelta(days=9)
    response = inventory_api_context.client.patch(
        f"/api/inventory/{inventory_api_context.item_id}/expiry-date",
        json={
            "expiry_date": corrected.isoformat(),
            "expected_row_version": prepared_version,
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == inventory_api_context.item_id
    assert payload["expiry_date"] == corrected.isoformat()
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None
    assert payload["row_version"] == prepared_version + 1

    item = _reload_item(inventory_api_context, inventory_api_context.item_id)
    assert item.expiry_date == corrected
    assert item.expiry_alert_snoozed_until is None
    assert item.expiry_reviewed_at is None
    assert item.expiry_reviewed_by is None
    assert item.updated_by == inventory_api_context.user_id
    assert item.row_version == prepared_version + 1

    with inventory_api_context.SessionLocal() as db:
        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.entity_type == "InventoryItem",
                ActivityLog.entity_id == inventory_api_context.item_id,
            )
        )
        assert log is not None
        assert "到期日" in log.summary or "过期" in log.summary or "日期" in log.summary


def test_versioned_dispose_expired_succeeds_for_selected_expired_rows(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-dispose-a",
        expiry_date=today - timedelta(days=2),
        quantity="3",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-dispose-b",
        expiry_date=today - timedelta(days=1),
        quantity="2",
        expiry_alert_snoozed_until=today + timedelta(days=2),
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-dispose-keep",
        expiry_date=today - timedelta(days=3),
        quantity="5",
    )

    response = inventory_api_context.client.post(
        "/api/inventory/dispose-expired",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-dispose-a"),
                _versioned_item("inventory-dispose-b"),
            ],
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "disposed_item_ids": ["inventory-dispose-a", "inventory-dispose-b"],
        "disposed_count": 2,
    }

    disposed_a = _reload_item(inventory_api_context, "inventory-dispose-a")
    disposed_b = _reload_item(inventory_api_context, "inventory-dispose-b")
    kept = _reload_item(inventory_api_context, "inventory-dispose-keep")
    assert disposed_a.disposed_quantity == Decimal("3")
    assert disposed_b.disposed_quantity == Decimal("2")
    assert kept.disposed_quantity == Decimal("0")
    assert disposed_a.row_version == 2
    assert disposed_b.row_version == 2
    assert kept.row_version == 1

    with inventory_api_context.SessionLocal() as db:
        logs = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.family_id == inventory_api_context.family_id,
                    ActivityLog.entity_type == "Ingredient",
                    ActivityLog.entity_id == inventory_api_context.ingredient_id,
                    ActivityLog.summary.contains("销毁"),
                )
            )
        )
        assert len(logs) == 1


def test_stale_review_correction_and_disposal_return_409_without_partial_writes(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-a",
        expiry_date=today - timedelta(days=1),
        quantity="3",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-b",
        expiry_date=today - timedelta(days=1),
        quantity="4",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-correct",
        expiry_date=today - timedelta(days=1),
        quantity="1",
    )
    with inventory_api_context.SessionLocal() as db:
        # Force persisted versions without going through version_id_col mutation rules.
        db.execute(
            InventoryItem.__table__.update()
            .where(InventoryItem.id == "inventory-stale-b")
            .values(row_version=2)
        )
        db.execute(
            InventoryItem.__table__.update()
            .where(InventoryItem.id == "inventory-stale-correct")
            .values(row_version=3)
        )
        db.commit()

    review_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-stale-a", 1),
                _versioned_item("inventory-stale-b", 1),
            ],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    correction_response = inventory_api_context.client.patch(
        f"/api/inventory/inventory-stale-correct/expiry-date",
        json={
            "expiry_date": (today + timedelta(days=5)).isoformat(),
            "expected_row_version": 1,
        },
    )
    disposal_response = inventory_api_context.client.post(
        "/api/inventory/dispose-expired",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-stale-a", 1),
                _versioned_item("inventory-stale-b", 1),
            ],
        },
    )

    assert review_response.status_code == 409
    assert correction_response.status_code == 409
    assert disposal_response.status_code == 409

    stale_a = _reload_item(inventory_api_context, "inventory-stale-a")
    stale_b = _reload_item(inventory_api_context, "inventory-stale-b")
    stale_correct = _reload_item(inventory_api_context, "inventory-stale-correct")
    assert stale_a.expiry_alert_snoozed_until is None
    assert stale_b.expiry_alert_snoozed_until is None
    assert stale_a.disposed_quantity == Decimal("0")
    assert stale_b.disposed_quantity == Decimal("0")
    assert stale_a.row_version == 1
    assert stale_b.row_version == 2
    assert stale_correct.expiry_date == today - timedelta(days=1)
    assert stale_correct.row_version == 3
    assert stale_a.expiry_reviewed_at is None
    assert stale_b.expiry_reviewed_at is None


def test_expiry_actions_reject_invalid_rows_without_partial_writes(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_family_ingredient(inventory_api_context, ingredient_id="ingredient-second", name="黄瓜")
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-valid-expired",
        expiry_date=today - timedelta(days=1),
        quantity="3",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-other-ingredient",
        ingredient_id="ingredient-second",
        expiry_date=today - timedelta(days=1),
        quantity="2",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-exhausted",
        expiry_date=today - timedelta(days=1),
        quantity="2",
        disposed="2",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-no-expiry",
        expiry_date=None,
        quantity="2",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-not-expired-dispose",
        expiry_date=today + timedelta(days=1),
        quantity="2",
    )

    cases = [
        (
            "mixed ingredient",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item("inventory-other-ingredient"),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
        (
            "missing row",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item("inventory-missing"),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
        (
            "other family",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item(inventory_api_context.other_item_id),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
        (
            "exhausted",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item("inventory-exhausted"),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
        (
            "missing expiry",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item("inventory-no-expiry"),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
        (
            "duplicate ids",
            {
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [
                    _versioned_item("inventory-valid-expired"),
                    _versioned_item("inventory-valid-expired"),
                ],
                "snoozed_until": snoozed_until.isoformat(),
            },
        ),
    ]

    for label, payload in cases:
        response = inventory_api_context.client.post("/api/inventory/snooze-expiry-alerts", json=payload)
        assert response.status_code == 400, f"{label}: {response.text}"
        valid = _reload_item(inventory_api_context, "inventory-valid-expired")
        assert valid.expiry_alert_snoozed_until is None
        assert valid.row_version == 1

    non_expired_dispose = inventory_api_context.client.post(
        "/api/inventory/dispose-expired",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-valid-expired"),
                _versioned_item("inventory-not-expired-dispose"),
            ],
        },
    )
    assert non_expired_dispose.status_code == 400
    assert _reload_item(inventory_api_context, "inventory-valid-expired").disposed_quantity == Decimal("0")
    assert _reload_item(inventory_api_context, "inventory-not-expired-dispose").disposed_quantity == Decimal("0")


def test_valid_plus_stale_row_leaves_both_unchanged(
    inventory_api_context: InventoryApiContext,
) -> None:
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-ok",
        expiry_date=today - timedelta(days=1),
        quantity="3",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-partner",
        expiry_date=today - timedelta(days=1),
        quantity="4",
    )
    with inventory_api_context.SessionLocal() as db:
        db.execute(
            InventoryItem.__table__.update()
            .where(InventoryItem.id == "inventory-stale-partner")
            .values(row_version=5)
        )
        db.commit()

    response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [
                _versioned_item("inventory-ok", 1),
                _versioned_item("inventory-stale-partner", 1),
            ],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )

    assert response.status_code == 409
    ok_item = _reload_item(inventory_api_context, "inventory-ok")
    stale_item = _reload_item(inventory_api_context, "inventory-stale-partner")
    assert ok_item.expiry_alert_snoozed_until is None
    assert stale_item.expiry_alert_snoozed_until is None
    assert ok_item.row_version == 1
    assert stale_item.row_version == 5



def test_stale_version_with_exhausted_or_changed_expiry_returns_409(
    inventory_api_context: InventoryApiContext,
) -> None:
    """Mutable business-state failures must not mask a stale expected_row_version.

    Concurrent consume/dispose that exhausts a batch (or corrects expiry) bumps
    row_version. A client still holding the old version must get 409 so the UI
    can refresh, not 400 about remaining quantity / missing expiry.
    """
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-exhausted",
        expiry_date=today - timedelta(days=1),
        quantity="3",
        disposed="3",
        row_version=1,
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-stale-cleared-expiry",
        expiry_date=today - timedelta(days=1),
        quantity="2",
    )
    with inventory_api_context.SessionLocal() as db:
        # Simulate concurrent mutations: version advanced, mutable fields changed.
        db.execute(
            InventoryItem.__table__.update()
            .where(InventoryItem.id == "inventory-stale-exhausted")
            .values(row_version=4)
        )
        db.execute(
            InventoryItem.__table__.update()
            .where(InventoryItem.id == "inventory-stale-cleared-expiry")
            .values(row_version=6, expiry_date=None)
        )
        db.commit()

    exhausted_response = inventory_api_context.client.post(
        "/api/inventory/snooze-expiry-alerts",
        json={
            "action": "retain_expired",
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-stale-exhausted", 1)],
            "snoozed_until": snoozed_until.isoformat(),
        },
    )
    cleared_response = inventory_api_context.client.post(
        "/api/inventory/dispose-expired",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "items": [_versioned_item("inventory-stale-cleared-expiry", 1)],
        },
    )

    assert exhausted_response.status_code == 409, exhausted_response.text
    exhausted_detail = exhausted_response.json()["detail"]
    assert isinstance(exhausted_detail, dict)
    assert exhausted_detail["code"] == "stale_version"
    assert exhausted_detail["message"] == STALE_INVENTORY_DETAIL
    assert exhausted_detail["conflicts"] == [
        {
            "entity_type": "inventory_item",
            "entity_id": "inventory-stale-exhausted",
            "expected_row_version": 1,
            "current_row_version": 4,
        }
    ]
    assert cleared_response.status_code == 409, cleared_response.text
    cleared_detail = cleared_response.json()["detail"]
    assert isinstance(cleared_detail, dict)
    assert cleared_detail["code"] == "stale_version"
    assert cleared_detail["conflicts"][0]["entity_id"] == "inventory-stale-cleared-expiry"
    assert cleared_detail["conflicts"][0]["current_row_version"] == 6

    exhausted = _reload_item(inventory_api_context, "inventory-stale-exhausted")
    cleared = _reload_item(inventory_api_context, "inventory-stale-cleared-expiry")
    assert exhausted.row_version == 4
    assert exhausted.expiry_alert_snoozed_until is None
    assert cleared.row_version == 6
    assert cleared.expiry_date is None
    assert cleared.disposed_quantity == Decimal("0")


def test_stale_data_error_on_service_flush_maps_to_409(
    inventory_api_context: InventoryApiContext,
) -> None:
    """Flush-time optimistic-lock failures must surface as 409, not 500."""
    today = _business_today()
    snoozed_until = today + timedelta(days=2)
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-flush-stale",
        expiry_date=today - timedelta(days=1),
        quantity="3",
    )

    def flush_raising_stale(self, *args, **kwargs):
        raise StaleDataError(
            "UPDATE statement on table 'inventory_items' expected to update 1 row(s); 0 were matched."
        )

    with patch.object(Session, "flush", flush_raising_stale):
        response = inventory_api_context.client.post(
            "/api/inventory/snooze-expiry-alerts",
            json={
                "action": "retain_expired",
                "ingredient_id": inventory_api_context.ingredient_id,
                "items": [_versioned_item("inventory-flush-stale", 1)],
                "snoozed_until": snoozed_until.isoformat(),
            },
        )

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == STALE_INVENTORY_DETAIL
    item = _reload_item(inventory_api_context, "inventory-flush-stale")
    assert item.expiry_alert_snoozed_until is None
    assert item.expiry_reviewed_at is None
    assert item.row_version == 1

def test_consume_and_dispose_increment_row_version(
    inventory_api_context: InventoryApiContext,
) -> None:
    """ORM updates via consume/dispose must bump row_version without manual increments."""
    item_before = _reload_item(inventory_api_context, inventory_api_context.item_id)
    assert item_before.row_version == 1

    consume_response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 2,
            "unit": "个",
        },
    )
    assert consume_response.status_code == 200, consume_response.text
    after_consume = _reload_item(inventory_api_context, inventory_api_context.item_id)
    assert after_consume.consumed_quantity == Decimal("2")
    assert after_consume.row_version == 2

    dispose_response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.item_id,
            "expected_row_version": after_consume.row_version,
            "quantity": 1,
            "unit": "个",
            "reason": "测试销毁",
        },
    )
    assert dispose_response.status_code == 200, dispose_response.text
    after_dispose = _reload_item(inventory_api_context, inventory_api_context.item_id)
    assert after_dispose.disposed_quantity == Decimal("1")
    assert after_dispose.row_version == 3


def test_dispose_rejects_stale_expected_row_version_with_structured_409(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.item_id,
            "expected_row_version": 99,
            "quantity": 1,
            "unit": "个",
            "reason": "坏掉",
        },
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "stale_version"
    assert detail["message"] == STALE_INVENTORY_DETAIL
    assert detail["conflicts"] == [
        {
            "entity_type": "inventory_item",
            "entity_id": inventory_api_context.item_id,
            "expected_row_version": 99,
            "current_row_version": 1,
        }
    ]
    item = _reload_item(inventory_api_context, inventory_api_context.item_id)
    assert item.disposed_quantity == Decimal("0")
    assert item.row_version == 1


def test_dispose_locks_parent_before_child(
    inventory_api_context: InventoryApiContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ordinary dispose must request Ingredient then InventoryItem in one ordered lock."""
    from app.services import inventory_operations

    observed: list[tuple[list[str], list[str]]] = []
    original = inventory_operations.lock_inventory_targets

    def tracking_lock(*args, **kwargs):
        observed.append(
            (
                list(kwargs.get("ingredient_ids") or []),
                list(kwargs.get("inventory_item_ids") or []),
            )
        )
        return original(*args, **kwargs)

    monkeypatch.setattr(inventory_operations, "lock_inventory_targets", tracking_lock)

    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.item_id,
            "expected_row_version": 1,
            "quantity": 1,
            "unit": "个",
            "reason": "锁顺序",
        },
    )
    assert response.status_code == 200, response.text
    assert observed
    ingredient_ids, inventory_item_ids = observed[0]
    assert ingredient_ids == [inventory_api_context.ingredient_id]
    assert inventory_item_ids == [inventory_api_context.item_id]


def test_expired_snoozed_batch_is_not_available_for_consumption(
    inventory_api_context: InventoryApiContext,
) -> None:
    """Snooze is reminder metadata only; expired stock stays unavailable for consume."""
    today = _business_today()
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-expired-snoozed",
        expiry_date=today - timedelta(days=1),
        quantity="5",
        expiry_alert_snoozed_until=today + timedelta(days=3),
    )
    # Exhaust the fresh fixture batch so only the expired snoozed row remains.
    with inventory_api_context.SessionLocal() as db:
        fresh = db.get(InventoryItem, inventory_api_context.item_id)
        assert fresh is not None
        fresh.disposed_quantity = fresh.quantity
        db.commit()

    response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 1,
            "unit": "个",
        },
    )
    assert response.status_code == 400
    assert "最多只能消费" in response.json()["detail"]

    item = _reload_item(inventory_api_context, "inventory-expired-snoozed")
    assert item.consumed_quantity == Decimal("0")
    assert item.expiry_date == today - timedelta(days=1)
    assert item.expiry_alert_snoozed_until == today + timedelta(days=3)
    assert item.row_version == 1


def test_expired_snoozed_batch_excluded_from_available_low_stock_quantity(
    inventory_api_context: InventoryApiContext,
) -> None:
    """Low-stock available quantity sums only non-expired remaining; snooze does not restore expired."""
    from app.services.inventory_usage import (
        inventory_remaining_in_default,
        load_available_inventory_by_ingredient,
        remaining_quantity,
    )

    today = _business_today()
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-fresh-for-low-stock",
        expiry_date=today + timedelta(days=5),
        quantity="1",
    )
    _add_inventory_item(
        inventory_api_context,
        item_id="inventory-expired-for-low-stock",
        expiry_date=today - timedelta(days=1),
        quantity="10",
        expiry_alert_snoozed_until=today + timedelta(days=4),
    )
    with inventory_api_context.SessionLocal() as db:
        # Exhaust fixture row so available is only the fresh 1 unit batch.
        fixture = db.get(InventoryItem, inventory_api_context.item_id)
        assert fixture is not None
        fixture.disposed_quantity = fixture.quantity
        db.commit()

    with inventory_api_context.SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        available = load_available_inventory_by_ingredient(
            db,
            family_id=inventory_api_context.family_id,
            ingredient_ids=[ingredient.id],
            today=today,
        ).get(ingredient.id, [])
        available_ids = {item.id for item in available}
        assert "inventory-fresh-for-low-stock" in available_ids
        assert "inventory-expired-for-low-stock" not in available_ids
        available_total = sum(
            (inventory_remaining_in_default(item, ingredient) for item in available),
            Decimal("0"),
        )
        assert available_total == Decimal("1")

        expired = db.get(InventoryItem, "inventory-expired-for-low-stock")
        assert expired is not None
        assert remaining_quantity(expired) == Decimal("10")
        assert expired.expiry_alert_snoozed_until == today + timedelta(days=4)



def test_update_ingredient_rejects_tracking_mode_change_with_structured_422(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    with inventory_api_context.SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        payload = {
            "expected_row_version": ingredient.row_version,
            "name": ingredient.name,
            "category": ingredient.category,
            "default_unit": ingredient.default_unit,
            "unit_conversions": [],
            "quantity_tracking_mode": "not_track_quantity",
            "default_storage": ingredient.default_storage,
            "default_expiry_mode": ingredient.default_expiry_mode.value
            if hasattr(ingredient.default_expiry_mode, "value")
            else ingredient.default_expiry_mode,
            "default_expiry_days": ingredient.default_expiry_days,
            "default_low_stock_threshold": None,
            "notes": ingredient.notes,
            "media_ids": [],
        }

    response = client.patch(f"/api/ingredients/{inventory_api_context.ingredient_id}", json=payload)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "tracking_transition_required"
    assert "跟踪模式" in detail["message"] or "数量记录" in detail["message"]

    with inventory_api_context.SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
        assert ingredient.row_version == 1


def test_update_ingredient_rejects_stale_profile_version_without_overwrite(
    inventory_api_context: InventoryApiContext,
) -> None:
    with inventory_api_context.SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        stale_version = ingredient.row_version
        payload = {
            "expected_row_version": stale_version,
            "name": "旧表单里的番茄",
            "category": ingredient.category,
            "default_unit": ingredient.default_unit,
            "unit_conversions": [],
            "quantity_tracking_mode": ingredient.quantity_tracking_mode.value,
            "default_storage": ingredient.default_storage,
            "default_expiry_mode": ingredient.default_expiry_mode.value,
            "default_expiry_days": ingredient.default_expiry_days,
            "default_low_stock_threshold": ingredient.default_low_stock_threshold,
            "notes": ingredient.notes,
            "media_ids": [],
        }
        db.execute(
            Ingredient.__table__.update()
            .where(Ingredient.id == ingredient.id)
            .values(name="家人刚改过的番茄", row_version=stale_version + 1)
        )
        db.commit()

    response = inventory_api_context.client.patch(
        f"/api/ingredients/{inventory_api_context.ingredient_id}",
        json=payload,
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "stale_version"
    assert detail["conflicts"] == [
        {
            "entity_type": "ingredient",
            "entity_id": inventory_api_context.ingredient_id,
            "expected_row_version": stale_version,
            "current_row_version": stale_version + 1,
        }
    ]

    with inventory_api_context.SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        assert ingredient.name == "家人刚改过的番茄"
        assert ingredient.row_version == stale_version + 1


def test_exact_to_presence_transition_with_physical_rows_and_no_false_confirmation(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert ingredient is not None and item is not None
        expected_ingredient_version = ingredient.row_version
        observed = [{"inventory_item_id": item.id, "expected_row_version": item.row_version}]
        before_item_qty = item.quantity
        before_item_version = item.row_version

    response = client.patch(
        f"/api/ingredients/{inventory_api_context.ingredient_id}/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "not_track_quantity",
            "observed_batches": observed,
            "presence_resolution": {
                "availability_level": "present_unknown",
                "inventory_status": "fresh",
                "purchase_date": "2026-07-01",
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
                "notes": "mode switch",
                "mark_inventory_confirmed": False,
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["quantity_tracking_mode"] == "not_track_quantity"
    assert body["row_version"] == expected_ingredient_version + 1

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        item = db.get(InventoryItem, inventory_api_context.item_id)
        state = db.scalar(
            select(IngredientInventoryState).where(
                IngredientInventoryState.ingredient_id == inventory_api_context.ingredient_id
            )
        )
        assert ingredient is not None and item is not None and state is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY
        assert item.quantity == before_item_qty
        assert item.row_version == before_item_version
        assert state.availability_level == InventoryAvailabilityLevel.PRESENT_UNKNOWN
        assert state.storage_location == "冷藏"
        assert state.purchase_date.isoformat() == "2026-07-01"
        assert state.expiry_date.isoformat() == "2026-07-20"
        assert state.notes == "mode switch"
        assert state.last_confirmed_at is None
        assert state.last_confirmed_by is None
        assert state.last_confirmation_source is None
        assert db.scalar(select(InventoryOperation).where(InventoryOperation.family_id == inventory_api_context.family_id)) is None


def test_exact_to_presence_marks_confirmation_only_when_requested(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert ingredient is not None and item is not None
        expected_ingredient_version = ingredient.row_version
        observed = [{"inventory_item_id": item.id, "expected_row_version": item.row_version}]

    response = client.patch(
        f"/api/ingredients/{inventory_api_context.ingredient_id}/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "not_track_quantity",
            "observed_batches": observed,
            "presence_resolution": {
                "availability_level": "low",
                "inventory_status": "opened",
                "purchase_date": "2026-07-02",
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "",
                "mark_inventory_confirmed": True,
            },
        },
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        state = db.scalar(
            select(IngredientInventoryState).where(
                IngredientInventoryState.ingredient_id == inventory_api_context.ingredient_id
            )
        )
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.LOW
        assert state.last_confirmed_at is not None
        assert state.last_confirmed_by == inventory_api_context.user_id
        assert state.last_confirmation_source == InventoryConfirmationSource.MANUAL_ENTRY


def test_exact_to_presence_without_physical_rows_sets_absent(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        item.disposed_quantity = item.quantity
        db.commit()
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        expected_ingredient_version = ingredient.row_version

    response = client.patch(
        f"/api/ingredients/{inventory_api_context.ingredient_id}/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "not_track_quantity",
            "observed_batches": [],
            "presence_resolution": {
                "availability_level": "absent",
                "inventory_status": "fresh",
                "purchase_date": None,
                "expiry_date": None,
                "storage_location": None,
                "notes": "",
                "mark_inventory_confirmed": True,
            },
        },
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        state = db.scalar(
            select(IngredientInventoryState).where(
                IngredientInventoryState.ingredient_id == inventory_api_context.ingredient_id
            )
        )
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.ABSENT
        assert state.storage_location is None
        assert state.purchase_date is None
        assert state.expiry_date is None


def test_exact_to_presence_rejects_stale_batch_version(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert ingredient is not None and item is not None
        expected_ingredient_version = ingredient.row_version
        stale_batch_version = item.row_version + 3

    response = client.patch(
        f"/api/ingredients/{inventory_api_context.ingredient_id}/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "not_track_quantity",
            "observed_batches": [
                {
                    "inventory_item_id": inventory_api_context.item_id,
                    "expected_row_version": stale_batch_version,
                }
            ],
            "presence_resolution": {
                "availability_level": "sufficient",
                "inventory_status": "fresh",
                "storage_location": "冷藏",
                "notes": "",
                "mark_inventory_confirmed": False,
            },
        },
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "stale_version"
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, inventory_api_context.ingredient_id)
        assert ingredient is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
        assert (
            db.scalar(
                select(IngredientInventoryState).where(
                    IngredientInventoryState.ingredient_id == inventory_api_context.ingredient_id
                )
            )
            is None
        )


def test_presence_to_exact_creates_real_batch_and_clears_state(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        ingredient = Ingredient(
            id="ingredient-oil",
            family_id=inventory_api_context.family_id,
            name="食用油",
            category="调味",
            default_unit="ml",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        legacy = InventoryItem(
            id="inventory-oil-legacy",
            family_id=inventory_api_context.family_id,
            ingredient_id=ingredient.id,
            quantity=Decimal("1"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="ml",
            status=InventoryStatus.FRESH,
            purchase_date=today_for_family(inventory_api_context.family_id),
            storage_location="常温",
            notes="legacy placeholder",
            low_stock_threshold=Decimal("0"),
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        state = IngredientInventoryState(
            id="inventory-state-oil",
            family_id=inventory_api_context.family_id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.SUFFICIENT,
            inventory_status=InventoryStatus.OPENED,
            purchase_date=today_for_family(inventory_api_context.family_id),
            expiry_date=today_for_family(inventory_api_context.family_id) + timedelta(days=30),
            storage_location="常温",
            notes="presence",
            last_confirmed_at=utcnow(),
            last_confirmed_by=inventory_api_context.user_id,
            last_confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
            row_version=2,
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        db.add_all([ingredient, legacy, state])
        db.commit()
        expected_ingredient_version = ingredient.row_version
        expected_state_version = state.row_version
        legacy_row_version = legacy.row_version

    response = client.patch(
        "/api/ingredients/ingredient-oil/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "track_quantity",
            "expected_state_row_version": expected_state_version,
            "observed_batches": [],
            "exact_resolution": {
                "confirm_absent": False,
                "quantity": "500",
                "unit": "ml",
                "inventory_status": "fresh",
                "purchase_date": today_for_family(inventory_api_context.family_id).isoformat(),
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "real initial stock",
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["quantity_tracking_mode"] == "track_quantity"

    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-oil")
        state = db.get(IngredientInventoryState, "inventory-state-oil")
        legacy = db.get(InventoryItem, "inventory-oil-legacy")
        new_items = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.ingredient_id == "ingredient-oil",
                    InventoryItem.id != "inventory-oil-legacy",
                )
            )
        )
        assert ingredient is not None and state is not None and legacy is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
        assert state.availability_level == InventoryAvailabilityLevel.ABSENT
        assert state.storage_location is None
        assert state.purchase_date is None
        assert state.expiry_date is None
        assert state.notes == ""
        assert state.last_confirmed_at is None
        assert state.last_confirmed_by is None
        assert state.last_confirmation_source is None
        assert legacy.quantity == legacy.consumed_quantity + legacy.disposed_quantity
        assert legacy.disposed_quantity == Decimal("0")
        assert legacy.row_version > legacy_row_version
        assert len(new_items) == 1
        assert new_items[0].quantity == Decimal("500")
        assert new_items[0].unit == "ml"
        assert new_items[0].notes == "real initial stock"
        exact_remaining = sum(
            (
                item.quantity - item.consumed_quantity - item.disposed_quantity
                for item in [legacy, *new_items]
            ),
            Decimal("0"),
        )
        assert exact_remaining == Decimal("500")
        assert db.scalar(select(InventoryOperation).where(InventoryOperation.family_id == inventory_api_context.family_id)) is None


def test_presence_to_exact_confirm_absent_creates_no_batch(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        ingredient = Ingredient(
            id="ingredient-pepper",
            family_id=inventory_api_context.family_id,
            name="胡椒",
            category="调味",
            default_unit="g",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        state = IngredientInventoryState(
            id="inventory-state-pepper",
            family_id=inventory_api_context.family_id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
            inventory_status=InventoryStatus.FRESH,
            storage_location="常温",
            notes="temp",
            row_version=1,
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        legacy = InventoryItem(
            id="inventory-pepper-legacy",
            family_id=inventory_api_context.family_id,
            ingredient_id=ingredient.id,
            quantity=Decimal("3"),
            consumed_quantity=Decimal("1"),
            disposed_quantity=Decimal("0"),
            unit="g",
            status=InventoryStatus.FRESH,
            purchase_date=today_for_family(inventory_api_context.family_id),
            storage_location="常温",
            notes="legacy exact stock",
            low_stock_threshold=Decimal("0"),
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        db.add_all([ingredient, state, legacy])
        db.commit()
        expected_ingredient_version = ingredient.row_version
        expected_state_version = state.row_version
        legacy_row_version = legacy.row_version

    response = client.patch(
        "/api/ingredients/ingredient-pepper/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "track_quantity",
            "expected_state_row_version": expected_state_version,
            "observed_batches": [],
            "exact_resolution": {
                "confirm_absent": True,
                "quantity": None,
                "unit": None,
                "inventory_status": None,
                "purchase_date": None,
                "expiry_date": None,
                "storage_location": None,
                "notes": "",
            },
        },
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-pepper")
        state = db.get(IngredientInventoryState, "inventory-state-pepper")
        items = list(db.scalars(select(InventoryItem).where(InventoryItem.ingredient_id == "ingredient-pepper")))
        assert ingredient is not None and state is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
        assert state.availability_level == InventoryAvailabilityLevel.ABSENT
        assert len(items) == 1
        assert items[0].id == "inventory-pepper-legacy"
        assert items[0].quantity == items[0].consumed_quantity + items[0].disposed_quantity
        assert items[0].disposed_quantity == Decimal("0")
        assert items[0].row_version > legacy_row_version


def test_presence_to_exact_rejects_stale_state_and_rolls_back(
    inventory_api_context: InventoryApiContext,
) -> None:
    client = inventory_api_context.client
    SessionLocal = inventory_api_context.SessionLocal
    with SessionLocal() as db:
        ingredient = Ingredient(
            id="ingredient-sugar",
            family_id=inventory_api_context.family_id,
            name="糖",
            category="调味",
            default_unit="g",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        state = IngredientInventoryState(
            id="inventory-state-sugar",
            family_id=inventory_api_context.family_id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.OPENED,
            storage_location="常温",
            notes="keep",
            created_by=inventory_api_context.user_id,
            updated_by=inventory_api_context.user_id,
        )
        db.add_all([ingredient, state])
        db.commit()
        db.refresh(ingredient)
        db.refresh(state)
        # Advance past the initial version so an expected_state_row_version=1 is stale.
        state.notes = "bumped"
        db.commit()
        db.refresh(ingredient)
        db.refresh(state)
        assert state.row_version >= 2
        expected_ingredient_version = ingredient.row_version
        stale_state_version = 1

    response = client.patch(
        "/api/ingredients/ingredient-sugar/tracking-mode",
        json={
            "expected_ingredient_row_version": expected_ingredient_version,
            "target_mode": "track_quantity",
            "expected_state_row_version": stale_state_version,
            "observed_batches": [],
            "exact_resolution": {
                "confirm_absent": False,
                "quantity": "100",
                "unit": "g",
                "inventory_status": "fresh",
                "purchase_date": today_for_family(inventory_api_context.family_id).isoformat(),
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "",
            },
        },
    )
    assert response.status_code == 409, response.text
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, "ingredient-sugar")
        state = db.get(IngredientInventoryState, "inventory-state-sugar")
        items = list(db.scalars(select(InventoryItem).where(InventoryItem.ingredient_id == "ingredient-sugar")))
        assert ingredient is not None and state is not None
        assert ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY
        assert state.availability_level == InventoryAvailabilityLevel.LOW
        assert state.storage_location == "常温"
        assert items == []
