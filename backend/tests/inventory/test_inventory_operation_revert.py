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
from app.schemas.inventory_operations import SNAPSHOT_SCHEMA_VERSION
from app.services.inventory_operation_history import (
    InventoryOperationNotFoundError,
    InventoryOperationPermissionError,
    record_ingredient_collection_guard,
    record_operation_line,
    revert_inventory_operation,
    snapshot_food_inventory,
    snapshot_inventory_item,
    snapshot_inventory_state,
    snapshot_shopping_item,
    start_operation,
)
from app.services.inventory_versions import InventoryConflictError
from app.schemas.inventory_operations import InventoryOperationDisplaySummary
from tests._transaction_failure import fail_next_commit


@dataclass
class RevertCtx:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    owner_id: str
    member_id: str
    other_member_id: str
    other_family_user_id: str
    exact_ingredient_id: str
    presence_ingredient_id: str
    food_id: str
    shopping_id: str
    auth_user_id: str
    auth_role: UserRole


@pytest.fixture()
def revert_ctx() -> Iterator[RevertCtx]:
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
        family = Family(id="family-revert", name="撤销家庭", motto="", location="")
        other_family = Family(id="family-other-revert", name="其他家庭", motto="", location="")
        owner = User(id="user-owner", username="owner", display_name="管理员", avatar_seed="", is_active=True)
        member = User(id="user-member", username="member", display_name="成员甲", avatar_seed="", is_active=True)
        other_member = User(id="user-member-b", username="member-b", display_name="成员乙", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other", display_name="外人", avatar_seed="", is_active=True)
        memberships = [
            Membership(id="m-owner", family_id=family.id, user_id=owner.id, role=UserRole.OWNER, status=MembershipStatus.ACTIVE),
            Membership(id="m-member", family_id=family.id, user_id=member.id, role=UserRole.MEMBER, status=MembershipStatus.ACTIVE),
            Membership(id="m-member-b", family_id=family.id, user_id=other_member.id, role=UserRole.MEMBER, status=MembershipStatus.ACTIVE),
            Membership(id="m-other", family_id=other_family.id, user_id=other_user.id, role=UserRole.MEMBER, status=MembershipStatus.ACTIVE),
        ]
        exact = Ingredient(
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
            created_by=member.id,
            updated_by=member.id,
            row_version=4,
        )
        presence = Ingredient(
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
            created_by=member.id,
            updated_by=member.id,
            row_version=2,
        )
        food = Food(
            id="food-yogurt",
            family_id=family.id,
            name="酸奶",
            type=FoodType.READY_MADE.value,
            category="乳品",
            stock_quantity=Decimal("2"),
            stock_unit="盒",
            storage_location="冷藏",
            expiry_date=date(2026, 7, 20),
            created_by=member.id,
            updated_by=member.id,
            row_version=3,
        )
        shopping = ShoppingListItem(
            id="shopping-egg",
            family_id=family.id,
            ingredient_id=exact.id,
            title="鸡蛋",
            quantity=Decimal("6"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="早餐",
            done=False,
            created_by=member.id,
            updated_by=member.id,
            row_version=1,
        )
        db.add_all([family, other_family, owner, member, other_member, other_user, *memberships, exact, presence, food, shopping])
        db.commit()

    ctx = RevertCtx(
        client=TestClient(app),
        SessionLocal=SessionLocal,
        family_id="family-revert",
        other_family_id="family-other-revert",
        owner_id="user-owner",
        member_id="user-member",
        other_member_id="user-member-b",
        other_family_user_id="user-other",
        exact_ingredient_id="ingredient-egg",
        presence_ingredient_id="ingredient-salt",
        food_id="food-yogurt",
        shopping_id="shopping-egg",
        auth_user_id="user-member",
        auth_role=UserRole.MEMBER,
    )

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            user = db.get(User, ctx.auth_user_id)
            membership = db.scalar(
                select(Membership).where(
                    Membership.family_id == ctx.family_id,
                    Membership.user_id == ctx.auth_user_id,
                )
            )
            assert user is not None and membership is not None
            membership.role = ctx.auth_role
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    try:
        yield ctx
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _create_exact_batch_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    ingredient: Ingredient,
    shopping: ShoppingListItem | None = None,
    client_request_id: str = "req-create-batch",
    quantity: Decimal = Decimal("6"),
) -> tuple[InventoryOperation, InventoryItem]:
    before_ingredient_version = ingredient.row_version
    before_shopping = snapshot_shopping_item(shopping) if shopping is not None else None
    item = InventoryItem(
        id=f"inventory-created-{client_request_id}",
        family_id=family_id,
        ingredient_id=ingredient.id,
        quantity=quantity,
        consumed_quantity=Decimal("0"),
        disposed_quantity=Decimal("0"),
        unit="个",
        entered_quantity=quantity,
        entered_unit="个",
        status=InventoryStatus.FRESH,
        purchase_date=date(2026, 7, 12),
        expiry_date=date(2026, 7, 20),
        storage_location="冷藏",
        notes="",
        low_stock_threshold=Decimal("0"),
        created_by=actor_id,
        updated_by=actor_id,
        row_version=1,
    )
    db.add(item)
    ingredient.row_version += 1
    ingredient.updated_by = actor_id
    if shopping is not None:
        shopping.done = True
        shopping.updated_by = actor_id
    db.flush()

    operation = start_operation(
        db,
        family_id=family_id,
        actor_id=actor_id,
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id=client_request_id,
        request_hash=f"hash-{client_request_id}",
        summary=InventoryOperationDisplaySummary(title="登记本次购买", description="完成 1 项", completed_count=1),
    )
    sequence = 1
    record_operation_line(
        db,
        operation=operation,
        sequence=sequence,
        entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
        entity_id=item.id,
        change_type=InventoryOperationChangeType.CREATE,
        before_snapshot=None,
        after_snapshot=snapshot_inventory_item(item),
        before_row_version=None,
        after_row_version=item.row_version,
    )
    sequence += 1
    if shopping is not None:
        record_operation_line(
            db,
            operation=operation,
            sequence=sequence,
            entity_type=InventoryOperationEntityType.SHOPPING_LIST_ITEM,
            entity_id=shopping.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=before_shopping,
            after_snapshot=snapshot_shopping_item(shopping),
            before_row_version=int(before_shopping["row_version"]) if before_shopping else None,
            after_row_version=shopping.row_version,
            change_metadata={"result": "completed"},
        )
        sequence += 1
    record_ingredient_collection_guard(
        db,
        operation=operation,
        sequence=sequence,
        ingredient=ingredient,
        before_row_version=before_ingredient_version,
        after_row_version=ingredient.row_version,
    )
    db.flush()
    return operation, item


def test_member_reverts_own_operation_within_window(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        before_ingredient_version = ingredient.row_version
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
        )
        after_item_version = item.row_version
        after_ingredient_version = ingredient.row_version
        db.commit()
        operation_id = operation.id
        item_id = item.id

    now = utcnow()
    with revert_ctx.SessionLocal() as db:
        result = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=operation_id,
            now=now,
        )
        db.commit()
        assert result.status == InventoryOperationStatus.REVERTED
        assert result.can_revert is False
        assert db.get(InventoryItem, item_id) is None
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        assert shopping is not None and shopping.done is False
        assert ingredient is not None
        assert ingredient.row_version > after_ingredient_version
        assert ingredient.row_version > before_ingredient_version
        activity = db.scalar(
            select(ActivityLog).where(
                ActivityLog.entity_id == operation_id,
                ActivityLog.action == ActivityAction.REVERT,
            )
        )
        assert activity is not None
        assert "撤销了刚才的采购入库" in activity.summary


def test_owner_reverts_another_member_operation(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-owner-revert",
        )
        db.commit()
        operation_id = operation.id
        item_id = item.id

    with revert_ctx.SessionLocal() as db:
        result = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.owner_id,
            user_role=UserRole.OWNER,
            operation_id=operation_id,
            now=utcnow(),
        )
        db.commit()
        assert result.status == InventoryOperationStatus.REVERTED
        assert db.get(InventoryItem, item_id) is None


def test_member_cannot_revert_another_member_operation(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-member-forbidden",
        )
        db.commit()
        operation_id = operation.id
        item_id = item.id
        shopping_done = shopping.done

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryOperationPermissionError):
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.other_member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        db.rollback()
        assert db.get(InventoryItem, item_id) is not None
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert shopping is not None and shopping.done is shopping_done


def test_cross_family_operation_is_not_found(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        other_family_op = InventoryOperation(
            id="op-other-family",
            family_id=revert_ctx.other_family_id,
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            status=InventoryOperationStatus.APPLIED,
            client_request_id="req-other-family",
            request_hash="hash-other",
            actor_id=revert_ctx.other_family_user_id,
            applied_at=utcnow(),
            revertible_until=utcnow() + timedelta(minutes=15),
            summary_json={"title": "x", "description": "y"},
        )
        db.add(other_family_op)
        db.commit()

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryOperationNotFoundError):
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id="op-other-family",
                now=utcnow(),
            )


def test_expired_deadline_rejects(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-expired",
        )
        operation.applied_at = utcnow() - timedelta(minutes=20)
        operation.revertible_until = operation.applied_at + timedelta(minutes=15)
        db.commit()
        operation_id = operation.id
        item_id = item.id

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as raised:
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        assert raised.value.code == "operation_expired"
        db.rollback()
        assert db.get(InventoryItem, item_id) is not None
        operation = db.get(InventoryOperation, operation_id)
        assert operation is not None and operation.status == InventoryOperationStatus.APPLIED


def test_modified_entity_rejects(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-modified",
        )
        # Simulate post-apply mutation that advances after version.
        item.notes = "someone edited"
        item.updated_by = revert_ctx.owner_id
        db.flush()
        db.commit()
        operation_id = operation.id
        item_id = item.id

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as raised:
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        assert raised.value.code == "operation_modified_after_apply"
        db.rollback()
        assert db.get(InventoryItem, item_id) is not None


def test_changed_ingredient_guard_rejects(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-guard",
        )
        # Bump parent collection after apply without touching the created batch version.
        ingredient.row_version += 1
        ingredient.updated_by = revert_ctx.owner_id
        db.commit()
        operation_id = operation.id
        item_id = item.id

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as raised:
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        assert raised.value.code == "operation_modified_after_apply"
        db.rollback()
        assert db.get(InventoryItem, item_id) is not None


def test_consumed_created_batch_rejects(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-consumed",
        )
        item.consumed_quantity = Decimal("1")
        # Keep row_version equal to after_version so create-safety branch is exercised.
        item.row_version = 1
        db.commit()
        operation_id = operation.id
        item_id = item.id

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as raised:
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        assert raised.value.code == "operation_not_revertible"
        db.rollback()
        assert db.get(InventoryItem, item_id) is not None


def test_deleted_target_rejects(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-deleted",
        )
        db.delete(item)
        db.commit()
        operation_id = operation.id

    with revert_ctx.SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as raised:
            revert_inventory_operation(
                db,
                family_id=revert_ctx.family_id,
                user_id=revert_ctx.member_id,
                user_role=UserRole.MEMBER,
                operation_id=operation_id,
                now=utcnow(),
            )
        assert raised.value.code == "operation_not_revertible"


def test_repeated_revert_is_idempotent(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, _item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-idempotent-revert",
        )
        db.commit()
        operation_id = operation.id

    with revert_ctx.SessionLocal() as db:
        first = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=operation_id,
            now=utcnow(),
        )
        db.commit()
        assert first.status == InventoryOperationStatus.REVERTED

    with revert_ctx.SessionLocal() as db:
        activities_before = list(
            db.scalars(select(ActivityLog).where(ActivityLog.action == ActivityAction.REVERT))
        )
        second = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=operation_id,
            now=utcnow(),
        )
        db.commit()
        assert second.status == InventoryOperationStatus.REVERTED
        activities_after = list(
            db.scalars(select(ActivityLog).where(ActivityLog.action == ActivityAction.REVERT))
        )
        assert len(activities_after) == len(activities_before)


def test_state_create_deleted_and_state_update_restores(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.presence_ingredient_id)
        assert ingredient is not None
        before_ingredient_version = ingredient.row_version
        state = IngredientInventoryState(
            id="state-salt-created",
            family_id=revert_ctx.family_id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.SUFFICIENT,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 12),
            storage_location="常温",
            notes="新买",
            last_confirmed_at=utcnow(),
            last_confirmed_by=revert_ctx.member_id,
            last_confirmation_source=InventoryConfirmationSource.SHOPPING_INTAKE,
            created_by=revert_ctx.member_id,
            updated_by=revert_ctx.member_id,
            row_version=1,
        )
        db.add(state)
        ingredient.row_version += 1
        db.flush()
        create_op = start_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            client_request_id="req-state-create",
            request_hash="hash-state-create",
            summary=InventoryOperationDisplaySummary(title="登记本次购买", description="完成 1 项", completed_count=1),
        )
        record_operation_line(
            db,
            operation=create_op,
            sequence=1,
            entity_type=InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE,
            entity_id=state.id,
            change_type=InventoryOperationChangeType.CREATE,
            before_snapshot=None,
            after_snapshot=snapshot_inventory_state(state),
            before_row_version=None,
            after_row_version=state.row_version,
        )
        record_ingredient_collection_guard(
            db,
            operation=create_op,
            sequence=2,
            ingredient=ingredient,
            before_row_version=before_ingredient_version,
            after_row_version=ingredient.row_version,
        )
        db.commit()
        create_op_id = create_op.id

    with revert_ctx.SessionLocal() as db:
        result = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=create_op_id,
            now=utcnow(),
        )
        db.commit()
        assert result.status == InventoryOperationStatus.REVERTED
        assert db.get(IngredientInventoryState, "state-salt-created") is None

    # Update path
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.presence_ingredient_id)
        assert ingredient is not None
        state = IngredientInventoryState(
            id="state-salt-update",
            family_id=revert_ctx.family_id,
            ingredient_id=ingredient.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 1),
            storage_location="常温",
            notes="旧",
            created_by=revert_ctx.member_id,
            updated_by=revert_ctx.member_id,
            row_version=2,
        )
        db.add(state)
        db.flush()
        before = snapshot_inventory_state(state)
        before_ingredient_version = ingredient.row_version
        state.availability_level = InventoryAvailabilityLevel.SUFFICIENT
        state.notes = "新"
        state.updated_by = revert_ctx.member_id
        ingredient.row_version += 1
        db.flush()
        update_op = start_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            operation_type=InventoryOperationType.RECONCILIATION,
            client_request_id="req-state-update",
            request_hash="hash-state-update",
            summary=InventoryOperationDisplaySummary(title="完成了一次库存盘点", description="调整 1 项", adjusted_count=1),
        )
        record_operation_line(
            db,
            operation=update_op,
            sequence=1,
            entity_type=InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE,
            entity_id=state.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=before,
            after_snapshot=snapshot_inventory_state(state),
            before_row_version=int(before["row_version"]),
            after_row_version=state.row_version,
        )
        record_ingredient_collection_guard(
            db,
            operation=update_op,
            sequence=2,
            ingredient=ingredient,
            before_row_version=before_ingredient_version,
            after_row_version=ingredient.row_version,
        )
        after_state_version = state.row_version
        db.commit()
        update_op_id = update_op.id

    with revert_ctx.SessionLocal() as db:
        result = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=update_op_id,
            now=utcnow(),
        )
        db.commit()
        assert result.status == InventoryOperationStatus.REVERTED
        state = db.get(IngredientInventoryState, "state-salt-update")
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.LOW
        assert state.notes == "旧"
        assert state.row_version > after_state_version


def test_food_and_shopping_restore_together_and_versions_increase(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        food = db.get(Food, revert_ctx.food_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert food is not None and shopping is not None
        food_before = snapshot_food_inventory(food)
        shopping_before = snapshot_shopping_item(shopping)
        food.stock_quantity = Decimal("5")
        food.storage_location = "冷冻"
        food.updated_by = revert_ctx.member_id
        shopping.done = True
        shopping.quantity = Decimal("0")
        shopping.updated_by = revert_ctx.member_id
        db.flush()
        operation = start_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            client_request_id="req-food-shopping",
            request_hash="hash-food-shopping",
            summary=InventoryOperationDisplaySummary(title="登记本次购买", description="完成 1 项", completed_count=1),
        )
        record_operation_line(
            db,
            operation=operation,
            sequence=1,
            entity_type=InventoryOperationEntityType.FOOD,
            entity_id=food.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=food_before,
            after_snapshot=snapshot_food_inventory(food),
            before_row_version=int(food_before["row_version"]),
            after_row_version=food.row_version,
        )
        record_operation_line(
            db,
            operation=operation,
            sequence=2,
            entity_type=InventoryOperationEntityType.SHOPPING_LIST_ITEM,
            entity_id=shopping.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=shopping_before,
            after_snapshot=snapshot_shopping_item(shopping),
            before_row_version=int(shopping_before["row_version"]),
            after_row_version=shopping.row_version,
        )
        after_food_version = food.row_version
        after_shopping_version = shopping.row_version
        db.commit()
        operation_id = operation.id

    with revert_ctx.SessionLocal() as db:
        result = revert_inventory_operation(
            db,
            family_id=revert_ctx.family_id,
            user_id=revert_ctx.member_id,
            user_role=UserRole.MEMBER,
            operation_id=operation_id,
            now=utcnow(),
        )
        db.commit()
        assert result.status == InventoryOperationStatus.REVERTED
        food = db.get(Food, revert_ctx.food_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert food is not None and shopping is not None
        assert food.stock_quantity == Decimal("2.00")
        assert food.storage_location == "冷藏"
        assert shopping.done is False
        assert shopping.quantity == Decimal("6.00")
        assert food.row_version > after_food_version
        assert shopping.row_version > after_shopping_version


def test_forced_commit_failure_leaves_operation_applied(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-commit-fail",
        )
        db.commit()
        operation_id = operation.id
        item_id = item.id

    revert_ctx.auth_user_id = revert_ctx.member_id
    revert_ctx.auth_role = UserRole.MEMBER
    with fail_next_commit("revert commit failed"):
        with pytest.raises(RuntimeError, match="revert commit failed"):
            revert_ctx.client.post(f"/api/inventory/operations/{operation_id}/revert")

    with revert_ctx.SessionLocal() as db:
        operation = db.get(InventoryOperation, operation_id)
        assert operation is not None
        assert operation.status == InventoryOperationStatus.APPLIED
        assert db.get(InventoryItem, item_id) is not None
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert shopping is not None and shopping.done is True
        assert (
            db.scalar(
                select(ActivityLog).where(
                    ActivityLog.entity_id == operation_id,
                    ActivityLog.action == ActivityAction.REVERT,
                )
            )
            is None
        )


def test_api_list_detail_and_revert_matrix(revert_ctx: RevertCtx) -> None:
    with revert_ctx.SessionLocal() as db:
        ingredient = db.get(Ingredient, revert_ctx.exact_ingredient_id)
        shopping = db.get(ShoppingListItem, revert_ctx.shopping_id)
        assert ingredient is not None and shopping is not None
        operation, item = _create_exact_batch_operation(
            db,
            family_id=revert_ctx.family_id,
            actor_id=revert_ctx.member_id,
            ingredient=ingredient,
            shopping=shopping,
            client_request_id="req-api",
        )
        db.commit()
        operation_id = operation.id
        item_id = item.id

    revert_ctx.auth_user_id = revert_ctx.member_id
    revert_ctx.auth_role = UserRole.MEMBER

    listed = revert_ctx.client.get("/api/inventory/operations")
    assert listed.status_code == 200, listed.text
    payload = listed.json()
    assert len(payload) == 1
    assert payload[0]["operation_id"] == operation_id
    assert payload[0]["actor_display_name"] == "成员甲"
    assert payload[0]["can_revert"] is True

    detail = revert_ctx.client.get(f"/api/inventory/operations/{operation_id}")
    assert detail.status_code == 200, detail.text
    detail_payload = detail.json()
    assert "before_snapshot" not in detail_payload
    assert all(line["entity_type"] != "ingredient" for line in detail_payload["lines"])
    assert any(line["entity_type"] == "inventory_item" for line in detail_payload["lines"])

    forbidden = revert_ctx.client.get("/api/inventory/operations?limit=99")
    assert forbidden.status_code == 422

    # Member B forbidden
    revert_ctx.auth_user_id = revert_ctx.other_member_id
    forbidden_revert = revert_ctx.client.post(f"/api/inventory/operations/{operation_id}/revert")
    assert forbidden_revert.status_code == 403

    # Owner succeeds
    revert_ctx.auth_user_id = revert_ctx.owner_id
    revert_ctx.auth_role = UserRole.OWNER
    ok = revert_ctx.client.post(f"/api/inventory/operations/{operation_id}/revert")
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "reverted"

    with revert_ctx.SessionLocal() as db:
        assert db.get(InventoryItem, item_id) is None

    # Cross-family 404
    missing = revert_ctx.client.get("/api/inventory/operations/does-not-exist")
    assert missing.status_code == 404
