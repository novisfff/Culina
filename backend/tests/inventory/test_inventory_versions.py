from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import (
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryStatus,
)
from app.models.domain import Base, Family, Food, Ingredient, InventoryItem, ShoppingListItem, User
from app.services.food_stock import apply_food_stock_consume, apply_food_stock_dispose, apply_food_stock_restock
from app.services.inventory_operation_locking import (
    InventoryTargetNotFoundError,
    lock_inventory_targets,
)
from app.services.inventory_operations import (
    consume_ingredient_inventory,
    create_inventory_batch,
    dispose_inventory_quantity,
)
from app.services.inventory_versions import (
    InventoryConflictError,
    bump_ingredient_collection,
    require_expected_version,
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
        family = Family(id="family-version", name="版本家庭", motto="", location="")
        user = User(
            id="user-version",
            username="version-user",
            display_name="版本用户",
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
            notes="",
            routine_note="",
            stock_quantity=Decimal("2"),
            stock_unit="盒",
            storage_location="冷藏",
            favorite=False,
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
            reason="测试",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        session.add_all([family, user, ingredient, food, shopping])
        session.commit()
        yield session


def _reload_ingredient(db: Session, ingredient_id: str = "ingredient-tomato") -> Ingredient:
    ingredient = db.get(Ingredient, ingredient_id)
    assert ingredient is not None
    db.refresh(ingredient)
    return ingredient


def _reload_item(db: Session, item_id: str) -> InventoryItem:
    item = db.get(InventoryItem, item_id)
    assert item is not None
    db.refresh(item)
    return item


def test_require_expected_version_rejects_stale_before_mutation(db: Session) -> None:
    ingredient = _reload_ingredient(db)
    assert ingredient.row_version == 1
    with pytest.raises(InventoryConflictError) as raised:
        require_expected_version(
            ingredient,
            99,
            entity_type="ingredient",
            entity_id=ingredient.id,
        )
    error = raised.value
    assert error.code == "stale_version"
    assert error.conflicts == [
        {
            "entity_type": "ingredient",
            "entity_id": ingredient.id,
            "expected_row_version": 99,
            "current_row_version": 1,
        }
    ]
    assert ingredient.row_version == 1
    assert ingredient.updated_by == "user-version"


def test_bump_ingredient_collection_advances_exactly_once(db: Session) -> None:
    ingredient = _reload_ingredient(db)
    before = ingredient.row_version
    bump_ingredient_collection(ingredient, user_id="user-version")
    db.flush()
    db.refresh(ingredient)
    assert ingredient.row_version == before + 1
    assert ingredient.updated_by == "user-version"


def test_create_consume_dispose_bump_parent_and_child_versions(db: Session) -> None:
    ingredient = _reload_ingredient(db)
    before = ingredient.row_version

    item = create_inventory_batch(
        db,
        family_id="family-version",
        user_id="user-version",
        ingredient=ingredient,
        quantity=Decimal("5"),
        unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        expiry_date=date(2026, 7, 10),
        storage_location="冷藏",
    )
    db.flush()
    db.refresh(ingredient)
    db.refresh(item)
    assert item.row_version == 1
    assert ingredient.row_version == before + 1
    after_create = ingredient.row_version
    item_before = item.row_version

    consume_ingredient_inventory(
        db,
        family_id="family-version",
        user_id="user-version",
        ingredient=ingredient,
        quantity=Decimal("2"),
        unit="个",
        today=date(2026, 7, 2),
    )
    db.flush()
    db.refresh(ingredient)
    changed_item = _reload_item(db, item.id)
    assert ingredient.row_version == after_create + 1
    assert changed_item.row_version == item_before + 1
    after_consume = ingredient.row_version
    item_before = changed_item.row_version

    dispose_inventory_quantity(
        db,
        family_id="family-version",
        user_id="user-version",
        item=changed_item,
        quantity=Decimal("1"),
        unit="个",
        reason="测试销毁",
    )
    db.flush()
    db.refresh(ingredient)
    disposed_item = _reload_item(db, item.id)
    assert ingredient.row_version == after_consume + 1
    assert disposed_item.row_version == item_before + 1
    assert disposed_item.consumed_quantity == Decimal("2")
    assert disposed_item.disposed_quantity == Decimal("1")


def test_food_stock_mutations_advance_food_row_version(db: Session) -> None:
    food = db.get(Food, "food-yogurt")
    assert food is not None
    assert food.row_version == 1

    apply_food_stock_restock(
        db,
        family_id="family-version",
        user_id="user-version",
        food=food,
        quantity=Decimal("1"),
        unit="盒",
        expiry_date=date(2026, 7, 20),
        purchase_source="盒马",
        storage_location="冷藏",
    )
    db.refresh(food)
    assert food.stock_quantity == Decimal("3")
    assert food.row_version == 2

    apply_food_stock_consume(
        db,
        family_id="family-version",
        user_id="user-version",
        food=food,
        quantity=Decimal("1"),
        unit="盒",
    )
    db.refresh(food)
    assert food.stock_quantity == Decimal("2")
    assert food.row_version == 3

    apply_food_stock_dispose(
        db,
        family_id="family-version",
        user_id="user-version",
        food=food,
        quantity=Decimal("1"),
        unit="盒",
        reason="破损",
    )
    db.refresh(food)
    assert food.stock_quantity == Decimal("1")
    assert food.row_version == 4


def test_shopping_edit_advances_shopping_row_version(db: Session) -> None:
    item = db.get(ShoppingListItem, "shopping-tomato")
    assert item is not None
    assert item.row_version == 1
    item.quantity = Decimal("5")
    item.updated_by = "user-version"
    db.flush()
    db.refresh(item)
    assert item.row_version == 2


def test_lock_inventory_targets_orders_and_rejects_missing(db: Session) -> None:
    ingredient = _reload_ingredient(db)
    item = create_inventory_batch(
        db,
        family_id="family-version",
        user_id="user-version",
        ingredient=ingredient,
        quantity=Decimal("3"),
        unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        expiry_date=None,
        storage_location="冷藏",
    )
    db.flush()

    locked = lock_inventory_targets(
        db,
        family_id="family-version",
        ingredient_ids=[ingredient.id],
        food_ids=["food-yogurt"],
        inventory_item_ids=[item.id],
        shopping_item_ids=["shopping-tomato"],
    )
    assert set(locked.ingredients) == {ingredient.id}
    assert set(locked.foods) == {"food-yogurt"}
    assert set(locked.inventory_items) == {item.id}
    assert set(locked.shopping_items) == {"shopping-tomato"}

    with pytest.raises(InventoryTargetNotFoundError):
        lock_inventory_targets(
            db,
            family_id="family-version",
            inventory_item_ids=[item.id, "inventory-missing"],
        )


def test_stale_expected_version_on_locked_item_before_dispose(db: Session) -> None:
    ingredient = _reload_ingredient(db)
    item = create_inventory_batch(
        db,
        family_id="family-version",
        user_id="user-version",
        ingredient=ingredient,
        quantity=Decimal("3"),
        unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 1),
        expiry_date=None,
        storage_location="冷藏",
    )
    db.flush()
    before_ingredient = ingredient.row_version
    before_item = item.row_version

    with pytest.raises(InventoryConflictError) as raised:
        require_expected_version(
            item,
            before_item + 5,
            entity_type="inventory_item",
            entity_id=item.id,
        )
    assert raised.value.code == "stale_version"

    # No mutation after failed version check.
    db.refresh(ingredient)
    db.refresh(item)
    assert ingredient.row_version == before_ingredient
    assert item.row_version == before_item
    assert item.disposed_quantity == Decimal("0")
