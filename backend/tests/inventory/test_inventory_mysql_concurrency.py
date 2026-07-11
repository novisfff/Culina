from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import timedelta
from decimal import Decimal
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.deps import get_current_auth
from app.core.enums import (
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Ingredient, InventoryItem, Membership, User
from app.services.clock import today_for_family
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL


def _require_test_mysql_url() -> str:
    url = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not url:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    parsed = urlparse(url)
    database = (parsed.path or "").lstrip("/")
    if not database:
        pytest.fail("CULINA_TEST_MYSQL_URL must include a database name ending in _test")
    if not database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


@pytest.fixture()
def mysql_concurrency_context() -> Iterator[dict]:
    url = _require_test_mysql_url()
    engine = create_engine(url, poolclass=NullPool, future=True, pool_pre_ping=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    today = today_for_family("family-mysql-concurrency")
    with SessionLocal() as db:
        family = Family(id="family-mysql-concurrency", name="并发家庭", motto="", location="")
        user = User(
            id="user-mysql-concurrency",
            username="mysql-concurrency-user",
            display_name="并发用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id="membership-mysql-concurrency",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        ingredient = Ingredient(
            id="ingredient-mysql-concurrency",
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
        item = InventoryItem(
            id="inventory-mysql-concurrency",
            family_id=family.id,
            ingredient_id=ingredient.id,
            quantity=Decimal("5"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("5"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today - timedelta(days=3),
            expiry_date=today - timedelta(days=1),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        db.add_all([family, user, membership, ingredient, item])
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            auth_user = db.get(User, "user-mysql-concurrency")
            auth_membership = db.get(Membership, "membership-mysql-concurrency")
            assert auth_user is not None
            assert auth_membership is not None
            return auth_user, auth_membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    try:
        yield {
            "client": TestClient(app),
            "SessionLocal": SessionLocal,
            "engine": engine,
            "family_id": "family-mysql-concurrency",
            "user_id": "user-mysql-concurrency",
            "ingredient_id": "ingredient-mysql-concurrency",
            "item_id": "inventory-mysql-concurrency",
            "today": today,
        }
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_two_session_versioned_dispose_returns_409_after_competing_write(
    mysql_concurrency_context: dict,
) -> None:
    """Session B mutates first; session A stale versioned dispose must 409 without partial write."""
    SessionLocal = mysql_concurrency_context["SessionLocal"]
    client: TestClient = mysql_concurrency_context["client"]
    item_id = mysql_concurrency_context["item_id"]
    ingredient_id = mysql_concurrency_context["ingredient_id"]

    # Session A loads the dialog token (version N).
    with SessionLocal() as session_a:
        item_a = session_a.get(InventoryItem, item_id)
        assert item_a is not None
        token_version = item_a.row_version
        assert token_version == 1

    # Session B performs an ordinary disposal and commits version N+1.
    with SessionLocal() as session_b:
        item_b = session_b.scalar(
            select(InventoryItem)
            .where(InventoryItem.id == item_id)
            .with_for_update()
        )
        assert item_b is not None
        assert item_b.row_version == token_version
        item_b.disposed_quantity = Decimal("1")
        item_b.updated_by = mysql_concurrency_context["user_id"]
        session_b.commit()
        session_b.refresh(item_b)
        assert item_b.row_version == token_version + 1
        b_disposed = item_b.disposed_quantity
        b_version = item_b.row_version

    # Session A submits the stale versioned action through the owning HTTP boundary.
    response = client.post(
        "/api/inventory/dispose-expired",
        json={
            "ingredient_id": ingredient_id,
            "items": [
                {
                    "inventory_item_id": item_id,
                    "expected_row_version": token_version,
                }
            ],
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == STALE_INVENTORY_DETAIL

    with SessionLocal() as verify:
        item = verify.get(InventoryItem, item_id)
        assert item is not None
        assert item.disposed_quantity == b_disposed
        assert item.row_version == b_version
        assert item.disposed_quantity == Decimal("1")
        assert item.row_version == 2


def test_mysql_url_points_at_test_database_only() -> None:
    """Guardrail: never run this suite against a non-test database name."""
    url = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not url:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    database = (urlparse(url).path or "").lstrip("/")
    assert database.endswith("_test")
