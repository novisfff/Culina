from __future__ import annotations

import os
import threading
from collections.abc import Callable, Iterator
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy.pool import NullPool

from app.core.deps import get_current_auth
from app.core.enums import (
    Difficulty,
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
    MealType,
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
    FoodPlanItem,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    MealLog,
    MealLogFood,
    Membership,
    Recipe,
    RecipeCookLog,
    RecipeIngredient,
    RecipeStep,
    ShoppingListItem,
    User,
)
from app.schemas.inventory_operations import (
    InventoryOperationDisplaySummary,
    InventoryReconciliationRequest,
    ShoppingIntakeRequest,
)
from app.services.ai_operations.meal_logs import execute_meal_log_draft
from app.services.ai_operations.meal_plans import execute_meal_plan_draft
from app.services.clock import today_for_family
from app.services.food_plan_locking import (
    FoodPlanConflict,
    FoodPlanWriteIntent,
    lock_food_plan_write_intents,
)
from app.services.ingredient_inventory_state import upsert_inventory_state
from app.services.inventory_expiry_actions import dispose_expired_inventory_items
from app.services.inventory_operation_history import (
    record_ingredient_collection_guard,
    record_operation_line,
    revert_inventory_operation,
    snapshot_inventory_item,
    snapshot_shopping_item,
    start_operation,
)
from app.services.inventory_operations import consume_ingredient_inventory
from app.services.inventory_reconciliation import apply_inventory_reconciliation
from app.services.inventory_usage import remaining_quantity
from app.services.inventory_versions import InventoryConflictError
from app.services.meal_log_references import (
    MealLogReferenceError,
    lock_and_validate_meal_log_references,
)
from app.services.recipe_cook_completion import (
    CompletionConflict,
    RecipeCookCompletionCommand,
    complete_recipe_cook,
)
from app.services.recipe_deletion import RecipeHasHistoryError, delete_recipe_with_guard
from app.schemas.inventory_intake import shopping_request_to_inventory_request
from app.services.inventory_intake import InventoryIntakeValidationError, apply_inventory_intake


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


def _run_barriered(
    workers: list[Callable[[], Any]],
    *,
    timeout: float = 25.0,
) -> list[Any]:
    """Run workers after a shared barrier so they race under MySQL locks."""
    barrier = threading.Barrier(len(workers), timeout=timeout)
    results: list[Any] = [None] * len(workers)
    errors: list[BaseException] = []

    def _wrap(index: int, worker: Callable[[], Any]) -> None:
        try:
            barrier.wait(timeout=timeout)
            results[index] = worker()
        except BaseException as exc:  # noqa: BLE001 - collect for re-raise after join
            errors.append(exc)

    threads = [
        threading.Thread(target=_wrap, args=(index, worker), daemon=True)
        for index, worker in enumerate(workers)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout + 5)
        if thread.is_alive():
            pytest.fail("barriered concurrency worker hung / deadlocked")
    if errors:
        raise errors[0]
    return results


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
    family_id = "family-mysql-concurrency"
    user_id = "user-mysql-concurrency"
    membership_id = "membership-mysql-concurrency"
    today = today_for_family(family_id)

    with SessionLocal() as db:
        family = Family(id=family_id, name="并发家庭", motto="", location="")
        user = User(
            id=user_id,
            username="mysql-concurrency-user",
            display_name="并发用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id=membership_id,
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        exact = Ingredient(
            id="ingredient-exact",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.DAYS,
            default_expiry_days=7,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        presence = Ingredient(
            id="ingredient-presence",
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
        presence_create = Ingredient(
            id="ingredient-presence-create",
            family_id=family.id,
            name="胡椒",
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
        # Fresh cold batch (usable by consume) plus room batch for scope races.
        item = InventoryItem(
            id="inventory-cold",
            family_id=family.id,
            ingredient_id=exact.id,
            quantity=Decimal("5"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("5"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today - timedelta(days=3),
            expiry_date=today + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        expired_item = InventoryItem(
            id="inventory-cold-expired",
            family_id=family.id,
            ingredient_id=exact.id,
            quantity=Decimal("2"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("2"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today - timedelta(days=10),
            expiry_date=today - timedelta(days=1),
            storage_location="冷藏",
            notes="过期",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        room_item = InventoryItem(
            id="inventory-room",
            family_id=family.id,
            ingredient_id=exact.id,
            quantity=Decimal("4"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("4"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today - timedelta(days=1),
            expiry_date=today + timedelta(days=10),
            storage_location="常温",
            notes="常温备用",
            low_stock_threshold=Decimal("0"),
            created_by=user.id,
            updated_by=user.id,
        )
        presence_state = IngredientInventoryState(
            id="state-presence",
            family_id=family.id,
            ingredient_id=presence.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 6, 1),
            expiry_date=None,
            storage_location="常温",
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        shopping = ShoppingListItem(
            id="shopping-exact",
            family_id=family.id,
            ingredient_id=exact.id,
            title="番茄",
            quantity=Decimal("6"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="并发采购",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        recipe = Recipe(
            id="recipe-mysql-cook",
            family_id=family.id,
            title="番茄快炒",
            servings=1,
            prep_minutes=10,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=[],
            created_by=user.id,
            updated_by=user.id,
        )
        recipe_ingredient = RecipeIngredient(
            id="recipe-ingredient-mysql-cook",
            recipe_id=recipe.id,
            ingredient_id=exact.id,
            ingredient_name="番茄",
            quantity=Decimal("1"),
            unit="个",
            note="",
            sort_order=0,
        )
        recipe_step = RecipeStep(
            id="recipe-step-mysql-cook",
            recipe_id=recipe.id,
            title="快炒",
            text="下锅炒熟",
            icon="pan",
            summary="",
            estimated_minutes=5,
            tip="",
            key_points=[],
            sort_order=0,
        )
        food = Food(
            id="food-mysql-cook",
            family_id=family.id,
            name="番茄快炒",
            type=FoodType.SELF_MADE.value,
            category="家常",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=[MealType.DINNER.value],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            storage_location="",
            favorite=False,
            recipe_id=recipe.id,
            created_by=user.id,
            updated_by=user.id,
        )
        alt_food = Food(
            id="food-mysql-alt",
            family_id=family.id,
            name="备用菜",
            type=FoodType.READY_MADE.value,
            category="外购",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=[MealType.DINNER.value],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            storage_location="",
            favorite=False,
            recipe_id=None,
            created_by=user.id,
            updated_by=user.id,
        )
        deletable_recipe = Recipe(
            id="recipe-mysql-deletable",
            family_id=family.id,
            title="可删菜谱",
            servings=1,
            prep_minutes=5,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=[],
            created_by=user.id,
            updated_by=user.id,
        )
        deletable_recipe_ingredient = RecipeIngredient(
            id="recipe-ingredient-mysql-deletable",
            recipe_id=deletable_recipe.id,
            ingredient_id=exact.id,
            ingredient_name="番茄",
            quantity=Decimal("1"),
            unit="个",
            note="",
            sort_order=0,
        )
        deletable_food = Food(
            id="food-mysql-deletable",
            family_id=family.id,
            name="可删菜谱",
            type=FoodType.SELF_MADE.value,
            category="家常",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=[MealType.DINNER.value],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            storage_location="",
            favorite=False,
            recipe_id=deletable_recipe.id,
            created_by=user.id,
            updated_by=user.id,
        )
        plan = FoodPlanItem(
            id="plan-mysql-cook",
            family_id=family.id,
            user_id=user.id,
            food_id=food.id,
            plan_date=today,
            meal_type=MealType.DINNER,
            note="并发计划",
            status="planned",
            created_by=user.id,
            updated_by=user.id,
        )
        rebind_plan = FoodPlanItem(
            id="plan-mysql-rebind",
            family_id=family.id,
            user_id=user.id,
            food_id=food.id,
            plan_date=today + timedelta(days=1),
            meal_type=MealType.DINNER,
            note="可改绑计划",
            status="planned",
            created_by=user.id,
            updated_by=user.id,
        )
        db.add_all(
            [
                family,
                user,
                membership,
                exact,
                presence,
                presence_create,
                item,
                expired_item,
                room_item,
                presence_state,
                shopping,
                recipe,
                recipe_ingredient,
                recipe_step,
                food,
                alt_food,
                deletable_recipe,
                deletable_recipe_ingredient,
                deletable_food,
                plan,
                rebind_plan,
            ]
        )
        db.commit()
        plan_base_updated_at = plan.updated_at
        rebind_plan_base_updated_at = rebind_plan.updated_at

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            auth_user = db.get(User, user_id)
            auth_membership = db.get(Membership, membership_id)
            assert auth_user is not None
            assert auth_membership is not None
            return auth_user, auth_membership

    def completion_command(
        request_id: str,
        *,
        recipe_id: str = "recipe-mysql-cook",
        food_plan_item_id: str | None = None,
        food_plan_item_base_updated_at=None,
        cook_date: date | None = None,
        servings: Decimal | None = None,
    ) -> RecipeCookCompletionCommand:
        return RecipeCookCompletionCommand(
            completion_request_id=request_id,
            family_id=family_id,
            actor_user_id=user_id,
            recipe_id=recipe_id,
            cook_date=cook_date or today,
            meal_type=MealType.DINNER,
            servings=servings or Decimal("1"),
            participant_user_ids=(user_id,),
            notes="mysql concurrency cook",
            food_plan_item_id=food_plan_item_id,
            food_plan_item_base_updated_at=food_plan_item_base_updated_at,
            result_note="",
            adjustments="",
            rating=None,
            allow_partial_inventory_deduction=False,
            inventory_expectation=None,
        )

    def complete_in_new_session(command: RecipeCookCompletionCommand):
        with SessionLocal() as db:
            result = complete_recipe_cook(db, command)
            db.commit()
            return result

    def complete_plan_in_new_session(request_id: str) -> tuple[str, Any]:
        command = completion_command(
            request_id,
            food_plan_item_id="plan-mysql-cook",
            food_plan_item_base_updated_at=plan_base_updated_at,
        )
        with SessionLocal() as db:
            try:
                result = complete_recipe_cook(db, command)
                db.commit()
                return "ok", result
            except (CompletionConflict, FoodPlanConflict) as exc:
                db.rollback()
                return "conflict", getattr(exc, "code", type(exc).__name__)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def count_completion_rows(request_id: str) -> int:
        with SessionLocal() as db:
            return int(
                db.scalar(
                    select(func.count())
                    .select_from(RecipeCookLog)
                    .where(
                        RecipeCookLog.family_id == family_id,
                        RecipeCookLog.completion_request_id == request_id,
                    )
                )
                or 0
            )

    def count_plan_meals(plan_id: str = "plan-mysql-cook") -> int:
        with SessionLocal() as db:
            plan_row = db.get(FoodPlanItem, plan_id)
            if plan_row is None:
                return 0
            if plan_row.status == "cooked" and plan_row.meal_log_id:
                return 1
            return 0

    def delete_recipe_in_new_session(recipe_id: str) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                delete_recipe_with_guard(
                    db,
                    family_id=family_id,
                    actor_id=user_id,
                    recipe_id=recipe_id,
                )
                db.commit()
                return "ok", recipe_id
            except RecipeHasHistoryError as exc:
                db.rollback()
                return "history", getattr(exc, "code", "recipe_has_history")
            except LookupError as exc:
                db.rollback()
                return "not_found", str(exc)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def create_rest_meal_log_in_new_session(food_id: str) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                references = lock_and_validate_meal_log_references(
                    db,
                    family_id=family_id,
                    actor_user_id=user_id,
                    food_ids=[food_id],
                    participant_user_ids=[user_id],
                )
                meal = MealLog(
                    id=f"meal-rest-{food_id}",
                    family_id=family_id,
                    date=today,
                    meal_type=MealType.DINNER,
                    participant_user_ids=list(references.participant_user_ids),
                    notes="rest race",
                    mood="",
                    created_by=user_id,
                    updated_by=user_id,
                )
                db.add(meal)
                db.flush()
                db.add(
                    MealLogFood(
                        id=f"meal-food-rest-{food_id}",
                        meal_log_id=meal.id,
                        food_id=food_id,
                        servings=Decimal("1"),
                        note="",
                    )
                )
                db.commit()
                return "ok", meal.id
            except MealLogReferenceError as exc:
                db.rollback()
                return "not_found", getattr(exc, "code", "meal_log_food_not_found")
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def create_ai_meal_log_in_new_session(food_id: str) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                result, _ids = execute_meal_log_draft(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    payload={
                        "action": "create",
                        "payload": {
                            "date": today.isoformat(),
                            "mealType": MealType.DINNER.value,
                            "foods": [{"foodId": food_id, "servings": 1}],
                            "participantUserIds": [user_id],
                            "notes": "ai race",
                        },
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
                db.commit()
                return "ok", result.get("id")
            except (MealLogReferenceError, ValueError, LookupError) as exc:
                db.rollback()
                return "not_found", str(exc)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def create_food_plan_in_new_session(food_id: str, plan_date: date | None = None) -> tuple[str, Any]:
        target_date = plan_date or (today + timedelta(days=2))
        with SessionLocal() as db:
            try:
                locked = lock_food_plan_write_intents(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    intents=[
                        FoodPlanWriteIntent(
                            action="create",
                            item_id=None,
                            target_food_id=food_id,
                            base_updated_at=None,
                        )
                    ],
                )
                item = FoodPlanItem(
                    id=f"plan-create-{food_id}",
                    family_id=family_id,
                    user_id=user_id,
                    food_id=food_id,
                    plan_date=target_date,
                    meal_type=MealType.DINNER,
                    note="race create",
                    status="planned",
                    created_by=user_id,
                    updated_by=user_id,
                )
                item.food = locked.foods_by_id[food_id]
                db.add(item)
                db.commit()
                return "ok", item.id
            except FoodPlanConflict as exc:
                db.rollback()
                return "conflict", getattr(exc, "code", "food_plan_conflict")
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def rebind_rest_plan_in_new_session(
        plan_id: str,
        target_food_id: str,
        *,
        base_updated_at=None,
    ) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                locked = lock_food_plan_write_intents(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    intents=[
                        FoodPlanWriteIntent(
                            action="update",
                            item_id=plan_id,
                            target_food_id=target_food_id,
                            base_updated_at=base_updated_at,
                            current_food_id=None,
                        )
                    ],
                )
                item = locked.items_by_id[plan_id]
                item.food_id = target_food_id
                item.food = locked.foods_by_id[target_food_id]
                item.updated_by = user_id
                db.commit()
                return "ok", item.id
            except FoodPlanConflict as exc:
                db.rollback()
                return "conflict", getattr(exc, "code", "food_plan_conflict")
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "error", f"{type(exc).__name__}: {exc}"

    def rebind_ai_plan_in_new_session(
        plan_id: str,
        target_food_id: str,
        *,
        base_updated_at=None,
    ) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                result, _ids = execute_meal_plan_draft(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    payload={
                        "operations": [
                            {
                                "operationId": f"rebind-{plan_id}",
                                "action": "update",
                                "targetId": plan_id,
                                "baseUpdatedAt": (
                                    base_updated_at.isoformat()
                                    if base_updated_at is not None
                                    else None
                                ),
                                "payload": {
                                    "foodId": target_food_id,
                                    "date": (today + timedelta(days=1)).isoformat(),
                                    "mealType": MealType.DINNER.value,
                                    "reason": "ai rebind",
                                },
                            }
                        ]
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
                db.commit()
                return "ok", result
            except Exception as exc:  # noqa: BLE001 - AI maps conflicts to AIConflictError/ValueError
                db.rollback()
                return "conflict", f"{type(exc).__name__}: {exc}"

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    try:
        yield {
            "client": TestClient(app),
            "SessionLocal": SessionLocal,
            "engine": engine,
            "family_id": family_id,
            "user_id": user_id,
            "exact_ingredient_id": "ingredient-exact",
            "presence_ingredient_id": "ingredient-presence",
            "presence_create_ingredient_id": "ingredient-presence-create",
            "item_id": "inventory-cold",
            "expired_item_id": "inventory-cold-expired",
            "room_item_id": "inventory-room",
            "presence_state_id": "state-presence",
            "shopping_id": "shopping-exact",
            "today": today,
            "recipe_id": "recipe-mysql-cook",
            "food_id": "food-mysql-cook",
            "alt_food_id": "food-mysql-alt",
            "deletable_recipe_id": "recipe-mysql-deletable",
            "deletable_food_id": "food-mysql-deletable",
            "plan_id": "plan-mysql-cook",
            "rebind_plan_id": "plan-mysql-rebind",
            "plan_base_updated_at": plan_base_updated_at,
            "rebind_plan_base_updated_at": rebind_plan_base_updated_at,
            "completion_command": completion_command,
            "complete_in_new_session": complete_in_new_session,
            "complete_plan_in_new_session": complete_plan_in_new_session,
            "count_completion_rows": count_completion_rows,
            "count_plan_meals": count_plan_meals,
            "delete_recipe_in_new_session": delete_recipe_in_new_session,
            "create_rest_meal_log_in_new_session": create_rest_meal_log_in_new_session,
            "create_ai_meal_log_in_new_session": create_ai_meal_log_in_new_session,
            "create_food_plan_in_new_session": create_food_plan_in_new_session,
            "rebind_rest_plan_in_new_session": rebind_rest_plan_in_new_session,
            "rebind_ai_plan_in_new_session": rebind_ai_plan_in_new_session,
        }
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _versions(ctx: dict) -> dict[str, int]:
    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        exact = db.get(Ingredient, ctx["exact_ingredient_id"])
        presence = db.get(Ingredient, ctx["presence_ingredient_id"])
        presence_create = db.get(Ingredient, ctx["presence_create_ingredient_id"])
        item = db.get(InventoryItem, ctx["item_id"])
        expired = db.get(InventoryItem, ctx["expired_item_id"])
        room = db.get(InventoryItem, ctx["room_item_id"])
        state = db.get(IngredientInventoryState, ctx["presence_state_id"])
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert all([exact, presence, presence_create, item, expired, room, state, shopping])
        return {
            "exact": exact.row_version,
            "presence": presence.row_version,
            "presence_create": presence_create.row_version,
            "item": item.row_version,
            "expired": expired.row_version,
            "room": room.row_version,
            "state": state.row_version,
            "shopping": shopping.row_version,
        }


def _count_ops(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(InventoryOperation)) or 0)


def _count_activity(db: Session, *, entity_type: str | None = "InventoryOperation") -> int:
    statement = select(func.count()).select_from(ActivityLog)
    if entity_type is not None:
        statement = statement.where(ActivityLog.entity_type == entity_type)
    return int(db.scalar(statement) or 0)


def _seed_ids(ctx: dict) -> set[str]:
    return {ctx["item_id"], ctx["expired_item_id"], ctx["room_item_id"]}


def _call_result(label: str, fn: Callable[[], Any]) -> tuple[str, str, Any]:
    try:
        value = fn()
        return label, "ok", value
    except InventoryConflictError as exc:
        return label, "conflict", getattr(exc, "code", "stale_version")
    except InventoryIntakeValidationError as exc:
        return label, "validation", getattr(exc, "code", "validation")
    except StaleDataError as exc:
        # Concurrent parent collection bump after the other session committed.
        return label, "conflict", f"stale_data:{exc}"
    except IntegrityError as exc:
        # Raw database errors are not structured API conflicts and must stay visible.
        return label, "integrity_error", f"integrity:{exc.orig if getattr(exc, 'orig', None) else exc}"
    except ValueError as exc:
        return label, "value_error", str(exc)
    except Exception as exc:  # noqa: BLE001
        return label, "error", f"{type(exc).__name__}: {exc}"


def _recon_confirm_request(ctx: dict, *, client_request_id: str, versions: dict[str, int] | None = None) -> InventoryReconciliationRequest:
    versions = versions or _versions(ctx)
    return InventoryReconciliationRequest.model_validate(
        {
            "client_request_id": client_request_id,
            "scope": "refrigerated",
            "groups": [
                {
                    "kind": "exact_ingredient",
                    "ingredient_id": ctx["exact_ingredient_id"],
                    "expected_ingredient_row_version": versions["exact"],
                    "action": "confirm_all",
                    "observed_batches": [
                        {
                            "inventory_item_id": ctx["item_id"],
                            "expected_row_version": versions["item"],
                        },
                        {
                            "inventory_item_id": ctx["expired_item_id"],
                            "expected_row_version": versions["expired"],
                        },
                    ],
                    "updates": [],
                    "creates": [],
                }
            ],
        }
    )


def _intake_request(
    ctx: dict,
    *,
    client_request_id: str,
    quantity: float = 6,
    expected_shopping_version: int | None = None,
    expected_ingredient_version: int | None = None,
) -> ShoppingIntakeRequest:
    versions = _versions(ctx)
    return ShoppingIntakeRequest.model_validate(
        {
            "client_request_id": client_request_id,
            "purchase_date": "2026-07-12",
            "items": [
                {
                    "shopping_item_id": ctx["shopping_id"],
                    "expected_shopping_item_row_version": expected_shopping_version or versions["shopping"],
                    "action": "stock_and_fulfill",
                    "target_kind": "exact_ingredient",
                    "target_id": ctx["exact_ingredient_id"],
                    "expected_ingredient_row_version": expected_ingredient_version or versions["exact"],
                    "actual_quantity": quantity,
                    "unit": "个",
                    "inventory_status": InventoryStatus.FRESH.value,
                    "expiry_date": "2026-07-20",
                    "storage_location": "冷藏",
                    "notes": "",
                }
            ],
        }
    )


def _create_revertible_operation(ctx: dict) -> tuple[str, str]:
    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        ingredient = db.get(Ingredient, ctx["exact_ingredient_id"])
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert ingredient is not None and shopping is not None
        before_ingredient_version = ingredient.row_version
        before_shopping = snapshot_shopping_item(shopping)
        item = InventoryItem(
            id="inventory-created-for-revert",
            family_id=ctx["family_id"],
            ingredient_id=ingredient.id,
            quantity=Decimal("6"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("6"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 12),
            expiry_date=date(2026, 7, 20),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("0"),
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
            row_version=1,
        )
        db.add(item)
        ingredient.row_version += 1
        ingredient.updated_by = ctx["user_id"]
        shopping.done = True
        shopping.updated_by = ctx["user_id"]
        db.flush()
        operation = start_operation(
            db,
            family_id=ctx["family_id"],
            actor_id=ctx["user_id"],
            operation_type=InventoryOperationType.SHOPPING_INTAKE,
            client_request_id="req-create-for-revert",
            request_hash="hash-create-for-revert",
            summary=InventoryOperationDisplaySummary(
                title="登记本次购买",
                description="完成 1 项",
                completed_count=1,
            ),
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
        record_operation_line(
            db,
            operation=operation,
            sequence=sequence,
            entity_type=InventoryOperationEntityType.SHOPPING_LIST_ITEM,
            entity_id=shopping.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=before_shopping,
            after_snapshot=snapshot_shopping_item(shopping),
            before_row_version=int(before_shopping["row_version"]),
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
        db.commit()
        return operation.id, item.id


def test_mysql_url_points_at_test_database_only() -> None:
    """Guardrail: never run this suite against a non-test database name."""
    url = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not url:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    database = (urlparse(url).path or "").lstrip("/")
    assert database.endswith("_test")


def test_two_session_versioned_dispose_returns_409_after_competing_write(
    mysql_concurrency_context: dict,
) -> None:
    """Legacy P0.1 race: Session B mutates first; Session A stale dispose conflicts without partial write."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    expired_id = ctx["expired_item_id"]

    with SessionLocal() as session_a:
        item_a = session_a.get(InventoryItem, expired_id)
        assert item_a is not None
        token_version = item_a.row_version
        assert token_version == 1

    with SessionLocal() as session_b:
        item_b = session_b.scalar(
            select(InventoryItem).where(InventoryItem.id == expired_id).with_for_update()
        )
        assert item_b is not None
        item_b.disposed_quantity = Decimal("1")
        item_b.updated_by = ctx["user_id"]
        session_b.commit()
        session_b.refresh(item_b)
        b_disposed = item_b.disposed_quantity
        b_version = item_b.row_version

    with SessionLocal() as session_a:
        with pytest.raises(InventoryConflictError) as exc_info:
            dispose_expired_inventory_items(
                session_a,
                family_id=ctx["family_id"],
                user_id=ctx["user_id"],
                actor_display_name="并发用户",
                ingredient_id=ctx["exact_ingredient_id"],
                item_refs=[
                    type("Ref", (), {"inventory_item_id": expired_id, "expected_row_version": token_version})()
                ],
                today=ctx["today"],
            )
        assert exc_info.value.code == "stale_version"
        session_a.rollback()

    with SessionLocal() as verify:
        item = verify.get(InventoryItem, expired_id)
        assert item is not None
        assert item.disposed_quantity == b_disposed == Decimal("1")
        assert item.row_version == b_version == 2
        assert remaining_quantity(item) == Decimal("1")


def test_reconciliation_versus_consume_one_stale_conflict(mysql_concurrency_context: dict) -> None:
    """1. Reconciliation and consume race: one succeeds, loser conflicts, no partial recon write."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    request = _recon_confirm_request(ctx, client_request_id="recon-vs-consume")

    def recon() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                "recon",
                lambda: (
                    apply_inventory_reconciliation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=request,
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )

    def consume() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            ingredient = db.get(Ingredient, ctx["exact_ingredient_id"])
            assert ingredient is not None

            def _run() -> dict:
                result = consume_ingredient_inventory(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    ingredient=ingredient,
                    quantity=Decimal("1"),
                    unit="个",
                    today=ctx["today"],
                )
                db.commit()
                return result

            return _call_result("consume", _run)

    results = _run_barriered([recon, consume])
    by_name = {label: (kind, payload) for label, kind, payload in results}
    assert by_name["recon"][0] in {"ok", "conflict"}, results
    assert by_name["consume"][0] in {"ok", "value_error", "conflict"}, results
    assert "ok" in {by_name["recon"][0], by_name["consume"][0]}, results

    with SessionLocal() as db:
        cold = db.get(InventoryItem, ctx["item_id"])
        expired = db.get(InventoryItem, ctx["expired_item_id"])
        room = db.get(InventoryItem, ctx["room_item_id"])
        assert cold and expired and room
        ops = _count_ops(db)
        activities = _count_activity(db)
        if by_name["recon"][0] == "ok" and by_name["consume"][0] == "ok":
            assert remaining_quantity(cold) + remaining_quantity(room) == Decimal("8")
            assert ops == 1
            assert activities == 1
            assert cold.last_confirmed_at is not None
        elif by_name["recon"][0] == "ok":
            assert remaining_quantity(cold) == Decimal("5")
            assert remaining_quantity(expired) == Decimal("2")
            assert cold.last_confirmed_at is not None
            assert expired.last_confirmed_at is not None
            assert room.last_confirmed_at is None
            assert ops == 1
            assert activities == 1
        else:
            # Consume won; recon must not leave operation/confirmation.
            assert remaining_quantity(cold) + remaining_quantity(room) == Decimal("8")
            assert cold.last_confirmed_at is None
            assert ops == 0
            assert activities == 0


def test_two_members_intake_same_shopping_item(mysql_concurrency_context: dict) -> None:
    """2. Two concurrent intakes of the same shopping item: one stock mutation only."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)
    request_a = _intake_request(
        ctx,
        client_request_id="intake-member-a",
        quantity=6,
        expected_shopping_version=versions["shopping"],
        expected_ingredient_version=versions["exact"],
    )
    request_b = _intake_request(
        ctx,
        client_request_id="intake-member-b",
        quantity=6,
        expected_shopping_version=versions["shopping"],
        expected_ingredient_version=versions["exact"],
    )

    def intake(request: ShoppingIntakeRequest, label: str) -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                label,
                lambda: (
                    apply_inventory_intake(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=shopping_request_to_inventory_request(request),
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )

    results = _run_barriered(
        [
            lambda: intake(request_a, "a"),
            lambda: intake(request_b, "b"),
        ]
    )
    kinds = [kind for _, kind, _ in results]
    assert kinds.count("ok") == 1, results
    assert any(kind in {"conflict", "validation", "value_error"} for kind in kinds), results

    with SessionLocal() as db:
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert shopping is not None and shopping.done is True
        batches = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.ingredient_id == ctx["exact_ingredient_id"],
                    InventoryItem.id.notin_(_seed_ids(ctx)),
                )
            )
        )
        assert len(batches) == 1
        assert remaining_quantity(batches[0]) == Decimal("6")
        assert _count_ops(db) == 1
        assert _count_activity(db) == 1


def test_partial_intake_versus_shopping_edit(mysql_concurrency_context: dict) -> None:
    """3. Partial intake races shopping edit: one writer wins, no partial stock/edit split."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)
    intake_request = _intake_request(
        ctx,
        client_request_id="intake-partial-race",
        quantity=2,
        expected_shopping_version=versions["shopping"],
        expected_ingredient_version=versions["exact"],
    )

    def intake() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                "intake",
                lambda: (
                    apply_inventory_intake(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=shopping_request_to_inventory_request(intake_request),
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )

    def edit() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            def _run() -> Decimal:
                from app.services.inventory_operation_locking import lock_inventory_targets
                from app.services.inventory_versions import require_expected_version

                locked = lock_inventory_targets(
                    db,
                    family_id=ctx["family_id"],
                    shopping_item_ids=[ctx["shopping_id"]],
                )
                shopping = locked.shopping_items[ctx["shopping_id"]]
                require_expected_version(
                    shopping,
                    versions["shopping"],
                    entity_type="shopping_list_item",
                    entity_id=shopping.id,
                )
                shopping.quantity = Decimal("10")
                shopping.updated_by = ctx["user_id"]
                db.commit()
                return shopping.quantity

            return _call_result("edit", _run)

    results = _run_barriered([intake, edit])
    by_name = {label: (kind, payload) for label, kind, payload in results}
    assert by_name["intake"][0] in {"ok", "conflict"}, results
    assert by_name["edit"][0] in {"ok", "conflict"}, results
    assert [by_name["intake"][0], by_name["edit"][0]].count("ok") == 1, results

    with SessionLocal() as db:
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert shopping is not None
        batches = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.ingredient_id == ctx["exact_ingredient_id"],
                    InventoryItem.id.notin_(_seed_ids(ctx)),
                )
            )
        )
        ops = _count_ops(db)
        if by_name["intake"][0] == "ok":
            assert by_name["edit"][0] == "conflict"
            assert shopping.done is False
            assert shopping.quantity == Decimal("4.00")
            assert len(batches) == 1
            assert remaining_quantity(batches[0]) == Decimal("2")
            assert ops == 1
            assert _count_activity(db) == 1
        else:
            assert by_name["edit"][0] == "ok"
            assert shopping.done is False
            assert shopping.quantity == Decimal("10.00")
            assert batches == []
            assert ops == 0
            assert _count_activity(db) == 0


def test_revert_versus_consume(mysql_concurrency_context: dict) -> None:
    """4. Revert races consume of the created batch: one path completes, no partial undo."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    operation_id, created_item_id = _create_revertible_operation(ctx)

    def revert() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                "revert",
                lambda: (
                    revert_inventory_operation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        user_role=UserRole.MEMBER,
                        operation_id=operation_id,
                        now=utcnow(),
                    ),
                    db.commit(),
                ),
            )

    def consume() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            ingredient = db.get(Ingredient, ctx["exact_ingredient_id"])
            assert ingredient is not None

            def _run() -> dict:
                result = consume_ingredient_inventory(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    ingredient=ingredient,
                    quantity=Decimal("1"),
                    unit="个",
                    today=ctx["today"],
                    inventory_item_id=created_item_id,
                )
                db.commit()
                return result

            return _call_result("consume", _run)

    results = _run_barriered([revert, consume])
    by_name = {label: (kind, payload) for label, kind, payload in results}
    assert by_name["revert"][0] in {"ok", "conflict"}, results
    assert by_name["consume"][0] in {"ok", "value_error", "conflict"}, results

    with SessionLocal() as db:
        operation = db.get(InventoryOperation, operation_id)
        created = db.get(InventoryItem, created_item_id)
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert operation is not None and shopping is not None
        if by_name["revert"][0] == "ok":
            assert operation.status == InventoryOperationStatus.REVERTED
            assert created is None
            assert shopping.done is False
            assert _count_activity(db, entity_type="InventoryOperation") >= 1
        else:
            assert operation.status == InventoryOperationStatus.APPLIED
            assert created is not None
            assert remaining_quantity(created) in {Decimal("5"), Decimal("6")}
            assert shopping.done is True
            if by_name["consume"][0] == "ok":
                assert remaining_quantity(created) == Decimal("5")


def test_reverse_request_ordering_no_stable_deadlock(mysql_concurrency_context: dict) -> None:
    """5. Two multi-entity requests reverse entity order without hanging on MySQL locks."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)

    groups_forward = [
        {
            "kind": "exact_ingredient",
            "ingredient_id": ctx["exact_ingredient_id"],
            "expected_ingredient_row_version": versions["exact"],
            "action": "confirm_all",
            "observed_batches": [
                {
                    "inventory_item_id": ctx["item_id"],
                    "expected_row_version": versions["item"],
                },
                {
                    "inventory_item_id": ctx["expired_item_id"],
                    "expected_row_version": versions["expired"],
                },
                {
                    "inventory_item_id": ctx["room_item_id"],
                    "expected_row_version": versions["room"],
                },
            ],
        },
        {
            "kind": "presence_ingredient",
            "ingredient_id": ctx["presence_ingredient_id"],
            "state_id": ctx["presence_state_id"],
            "expected_ingredient_row_version": versions["presence"],
            "expected_state_row_version": versions["state"],
            "availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
            "inventory_status": InventoryStatus.FRESH.value,
            "purchase_date": "2026-07-01",
            "expiry_date": None,
            "storage_location": "常温",
            "notes": "够用",
        },
    ]
    request_a = InventoryReconciliationRequest.model_validate(
        {"client_request_id": "recon-order-a", "scope": "all", "groups": groups_forward}
    )
    request_b = InventoryReconciliationRequest.model_validate(
        {"client_request_id": "recon-order-b", "scope": "all", "groups": list(reversed(groups_forward))}
    )

    def worker(request: InventoryReconciliationRequest, label: str) -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                label,
                lambda: (
                    apply_inventory_reconciliation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=request,
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )

    results = _run_barriered(
        [
            lambda: worker(request_a, "a"),
            lambda: worker(request_b, "b"),
        ],
        timeout=30.0,
    )
    kinds = [kind for _, kind, _ in results]
    assert all(kind in {"ok", "conflict"} for kind in kinds), results
    assert kinds.count("ok") == 1, results
    assert kinds.count("conflict") == 1, results

    with SessionLocal() as db:
        assert _count_ops(db) == 1
        assert _count_activity(db) == 1
        state = db.get(IngredientInventoryState, ctx["presence_state_id"])
        item = db.get(InventoryItem, ctx["item_id"])
        assert state is not None and item is not None
        assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
        assert item.last_confirmed_at is not None


def test_concurrent_first_state_creation_produces_one_row(mysql_concurrency_context: dict) -> None:
    """6. Concurrent first State creates produce exactly one row for the ingredient."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)
    ingredient_id = ctx["presence_create_ingredient_id"]

    def create(notes: str, label: str) -> tuple[str, str, Any]:
        with SessionLocal() as db:
            ingredient = db.get(Ingredient, ingredient_id)
            assert ingredient is not None

            def _run() -> str:
                state = upsert_inventory_state(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    ingredient=ingredient,
                    expected_ingredient_row_version=versions["presence_create"],
                    state_id=None,
                    expected_state_row_version=None,
                    availability_level=InventoryAvailabilityLevel.SUFFICIENT,
                    inventory_status=InventoryStatus.FRESH,
                    purchase_date=date(2026, 7, 12),
                    expiry_date=None,
                    storage_location="常温",
                    notes=notes,
                    confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
                    record_activity=True,
                )
                db.commit()
                return state.id

            return _call_result(label, _run)

    results = _run_barriered(
        [
            lambda: create("A", "a"),
            lambda: create("B", "b"),
        ]
    )
    kinds = [kind for _, kind, _ in results]
    assert kinds.count("ok") == 1, results
    assert kinds.count("conflict") == 1, results

    with SessionLocal() as db:
        states = list(
            db.scalars(
                select(IngredientInventoryState).where(
                    IngredientInventoryState.ingredient_id == ingredient_id
                )
            )
        )
        assert len(states) == 1
        assert states[0].availability_level == InventoryAvailabilityLevel.SUFFICIENT
        assert states[0].notes in {"A", "B"}


def test_state_manual_upsert_versus_reconciliation_one_stale(
    mysql_concurrency_context: dict,
) -> None:
    """7. Manual State upsert races State reconciliation: exactly one stale conflict."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)
    recon_request = InventoryReconciliationRequest.model_validate(
        {
            "client_request_id": "recon-state-race",
            "scope": "all",
            "groups": [
                {
                    "kind": "presence_ingredient",
                    "ingredient_id": ctx["presence_ingredient_id"],
                    "state_id": ctx["presence_state_id"],
                    "expected_ingredient_row_version": versions["presence"],
                    "expected_state_row_version": versions["state"],
                    "availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
                    "inventory_status": InventoryStatus.FRESH.value,
                    "purchase_date": "2026-07-01",
                    "expiry_date": None,
                    "storage_location": "常温",
                    "notes": "盘点",
                }
            ],
        }
    )

    def recon() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            return _call_result(
                "recon",
                lambda: (
                    apply_inventory_reconciliation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=recon_request,
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )

    def manual() -> tuple[str, str, Any]:
        with SessionLocal() as db:
            ingredient = db.get(Ingredient, ctx["presence_ingredient_id"])
            assert ingredient is not None

            def _run() -> str:
                state = upsert_inventory_state(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    ingredient=ingredient,
                    expected_ingredient_row_version=versions["presence"],
                    state_id=ctx["presence_state_id"],
                    expected_state_row_version=versions["state"],
                    availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
                    inventory_status=InventoryStatus.OPENED,
                    purchase_date=date(2026, 7, 2),
                    expiry_date=None,
                    storage_location="常温",
                    notes="手工",
                    confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
                    record_activity=True,
                )
                db.commit()
                return state.id

            return _call_result("manual", _run)

    results = _run_barriered([recon, manual])
    by_name = {label: (kind, payload) for label, kind, payload in results}
    assert by_name["recon"][0] in {"ok", "conflict"}, results
    assert by_name["manual"][0] in {"ok", "conflict"}, results
    assert [by_name["recon"][0], by_name["manual"][0]].count("ok") == 1, results
    assert [by_name["recon"][0], by_name["manual"][0]].count("conflict") == 1, results

    with SessionLocal() as db:
        state = db.get(IngredientInventoryState, ctx["presence_state_id"])
        assert state is not None
        ops = _count_ops(db)
        if by_name["recon"][0] == "ok":
            assert state.notes == "盘点"
            assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
            assert state.last_confirmation_source == InventoryConfirmationSource.RECONCILIATION
            assert ops == 1
            assert _count_activity(db) == 1
        else:
            assert state.notes == "手工"
            assert state.availability_level == InventoryAvailabilityLevel.PRESENT_UNKNOWN
            assert ops == 0


def test_out_of_scope_child_change_invalidates_scoped_reconciliation(
    mysql_concurrency_context: dict,
) -> None:
    """8. Out-of-scope child mutation bumps parent collection and invalidates scoped recon."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    versions = _versions(ctx)
    request = _recon_confirm_request(ctx, client_request_id="recon-scope-invalid", versions=versions)

    with SessionLocal() as db:
        room = db.get(InventoryItem, ctx["room_item_id"])
        exact = db.get(Ingredient, ctx["exact_ingredient_id"])
        assert room is not None and exact is not None
        room.notes = "常温并发改动"
        exact.row_version += 1
        db.commit()

    with SessionLocal() as db:
        with pytest.raises(InventoryConflictError) as exc_info:
            apply_inventory_reconciliation(
                db,
                family_id=ctx["family_id"],
                user_id=ctx["user_id"],
                request=request,
                business_date=ctx["today"],
            )
        assert exc_info.value.code == "stale_version"
        db.rollback()

    with SessionLocal() as db:
        item = db.get(InventoryItem, ctx["item_id"])
        assert item is not None
        assert item.last_confirmed_at is None
        assert remaining_quantity(item) == Decimal("5")
        assert _count_ops(db) == 0
        assert _count_activity(db) == 0


def test_concurrent_identical_client_request_id_replays_once(
    mysql_concurrency_context: dict,
) -> None:
    """9. Same client_request_id + payload concurrent: one stock mutation and same operation result."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    request = _intake_request(ctx, client_request_id="req-idempotent-concurrent", quantity=6)

    def worker(label: str) -> tuple[str, str, Any]:
        with SessionLocal() as db:
            def _run() -> dict:
                result = apply_inventory_intake(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    request=shopping_request_to_inventory_request(request),
                    business_date=ctx["today"],
                )
                db.commit()
                return {
                    "operation_id": result.operation_id,
                    "status": result.status.value if hasattr(result.status, "value") else result.status,
                    "inventory_item_id": result.items[0].inventory_item_id,
                }

            return _call_result(label, _run)

    results = _run_barriered(
        [
            lambda: worker("a"),
            lambda: worker("b"),
        ]
    )
    assert all(kind == "ok" for _, kind, _ in results), results
    bodies = [payload for _, kind, payload in results if kind == "ok"]
    assert bodies[0]["operation_id"] == bodies[1]["operation_id"]
    assert bodies[0]["inventory_item_id"] == bodies[1]["inventory_item_id"]
    assert bodies[0]["status"] == bodies[1]["status"] == "applied"

    with SessionLocal() as db:
        shopping = db.get(ShoppingListItem, ctx["shopping_id"])
        assert shopping is not None and shopping.done is True
        batches = list(
            db.scalars(
                select(InventoryItem).where(
                    InventoryItem.ingredient_id == ctx["exact_ingredient_id"],
                    InventoryItem.id.notin_(_seed_ids(ctx)),
                )
            )
        )
        assert len(batches) == 1
        assert remaining_quantity(batches[0]) == Decimal("6")
        assert _count_ops(db) == 1
        assert _count_activity(db) == 1
        assert batches[0].id == bodies[0]["inventory_item_id"]


def test_concurrent_identical_completion_request_replays_once(mysql_concurrency_context: dict) -> None:
    """Same completion_request_id races to one claim; loser replays the winner."""
    ctx = mysql_concurrency_context
    command = ctx["completion_command"]("same-request")
    results = _run_barriered(
        [
            lambda: ctx["complete_in_new_session"](command),
            lambda: ctx["complete_in_new_session"](command),
        ],
        timeout=30.0,
    )
    assert {result.replayed for result in results} == {False, True}
    assert {result.meal_log_id for result in results} == {results[0].meal_log_id}
    assert ctx["count_completion_rows"]("same-request") == 1

    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        meal_count = int(db.scalar(select(func.count()).select_from(MealLog)) or 0)
        assert meal_count == 1
        item = db.get(InventoryItem, ctx["item_id"])
        assert item is not None
        assert item.consumed_quantity == Decimal("1")


def test_different_requests_complete_one_plan_once(mysql_concurrency_context: dict) -> None:
    """Two different request ids racing the same plan complete it exactly once."""
    ctx = mysql_concurrency_context
    results = _run_barriered(
        [
            lambda: ctx["complete_plan_in_new_session"]("request-a"),
            lambda: ctx["complete_plan_in_new_session"]("request-b"),
        ],
        timeout=30.0,
    )
    assert sorted(result[0] for result in results) == ["conflict", "ok"]
    assert ctx["count_plan_meals"]() == 1

    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        plan = db.get(FoodPlanItem, ctx["plan_id"])
        assert plan is not None
        assert plan.status == "cooked"
        assert plan.meal_log_id is not None
        meal_count = int(db.scalar(select(func.count()).select_from(MealLog)) or 0)
        assert meal_count == 1


def test_cook_completion_versus_reconciliation_no_deadlock(mysql_concurrency_context: dict) -> None:
    """Cook completion and PR73 reconciliation share Ingredient/Food parents without hanging."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    command = ctx["completion_command"]("cook-vs-recon")
    request = _recon_confirm_request(ctx, client_request_id="recon-vs-cook")

    def cook() -> tuple[str, Any]:
        try:
            result = ctx["complete_in_new_session"](command)
            return "ok", result
        except Exception as exc:  # noqa: BLE001
            return "conflict", f"{type(exc).__name__}: {exc}"

    def recon() -> tuple[str, Any]:
        with SessionLocal() as db:
            return _call_result(
                "recon",
                lambda: (
                    apply_inventory_reconciliation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=request,
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )[1:]

    results = _run_barriered([cook, recon], timeout=30.0)
    kinds = [kind for kind, _ in results]
    assert all(kind in {"ok", "conflict"} for kind in kinds), results
    assert "ok" in kinds, results


def test_cook_completion_versus_shopping_intake_no_deadlock(mysql_concurrency_context: dict) -> None:
    """Cook completion and shopping intake share Ingredient parents without hanging."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    command = ctx["completion_command"]("cook-vs-intake")
    request = _intake_request(ctx, client_request_id="intake-vs-cook", quantity=6)

    def cook() -> tuple[str, Any]:
        try:
            return "ok", ctx["complete_in_new_session"](command)
        except Exception as exc:  # noqa: BLE001
            return "conflict", f"{type(exc).__name__}: {exc}"

    def intake() -> tuple[str, Any]:
        with SessionLocal() as db:
            kind_payload = _call_result(
                "intake",
                lambda: (
                    apply_inventory_intake(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        request=shopping_request_to_inventory_request(request),
                        business_date=ctx["today"],
                    ),
                    db.commit(),
                ),
            )
            return kind_payload[1], kind_payload[2]

    results = _run_barriered([cook, intake], timeout=30.0)
    kinds = [kind for kind, _ in results]
    assert all(kind in {"ok", "conflict", "validation"} for kind in kinds), results
    assert "ok" in kinds, results


def test_cook_completion_versus_inventory_undo_no_deadlock(mysql_concurrency_context: dict) -> None:
    """Cook completion and inventory undo/history share Ingredient parents without hanging."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    operation_id, _created_item_id = _create_revertible_operation(ctx)
    command = ctx["completion_command"]("cook-vs-undo")

    def cook() -> tuple[str, Any]:
        try:
            return "ok", ctx["complete_in_new_session"](command)
        except Exception as exc:  # noqa: BLE001
            return "conflict", f"{type(exc).__name__}: {exc}"

    def undo() -> tuple[str, Any]:
        with SessionLocal() as db:
            kind_payload = _call_result(
                "undo",
                lambda: (
                    revert_inventory_operation(
                        db,
                        family_id=ctx["family_id"],
                        user_id=ctx["user_id"],
                        user_role=UserRole.MEMBER,
                        operation_id=operation_id,
                        now=utcnow(),
                    ),
                    db.commit(),
                ),
            )
            return kind_payload[1], kind_payload[2]

    results = _run_barriered([cook, undo], timeout=30.0)
    kinds = [kind for kind, _ in results]
    assert all(kind in {"ok", "conflict", "value_error", "error"} for kind in kinds), results
    assert "ok" in kinds, results


def test_recipe_delete_versus_cook_completion_serializes(mysql_concurrency_context: dict) -> None:
    """Recipe delete and cook completion serialize on Recipe→Food parents."""
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    command = ctx["completion_command"]("cook-vs-delete", recipe_id=recipe_id)

    def cook() -> tuple[str, Any]:
        try:
            return "ok", ctx["complete_in_new_session"](command)
        except CompletionConflict as exc:
            return "conflict", getattr(exc, "code", "completion_conflict")
        except Exception as exc:  # noqa: BLE001
            return "error", f"{type(exc).__name__}: {exc}"

    results = _run_barriered(
        [
            cook,
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (
        ["conflict", "ok"],
        ["history", "ok"],
        ["not_found", "ok"],
    ), results

    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        recipe = db.get(Recipe, recipe_id)
        cook_logs = list(db.scalars(select(RecipeCookLog).where(RecipeCookLog.recipe_id == recipe_id)))
        if cook_logs:
            assert recipe is not None  # history retained the recipe
            assert len(cook_logs) == 1
        else:
            assert recipe is None


def test_recipe_delete_versus_rest_meal_log_create_serializes(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    food_id = ctx["deletable_food_id"]
    results = _run_barriered(
        [
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
            lambda: ctx["create_rest_meal_log_in_new_session"](food_id),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (["history", "ok"], ["not_found", "ok"]), results

    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        recipe = db.get(Recipe, recipe_id)
        meal_foods = list(db.scalars(select(MealLogFood).where(MealLogFood.food_id == food_id)))
        if meal_foods:
            assert recipe is not None
            assert len(meal_foods) == 1
        else:
            assert recipe is None


def test_recipe_delete_versus_ai_meal_log_create_serializes(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    food_id = ctx["deletable_food_id"]
    results = _run_barriered(
        [
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
            lambda: ctx["create_ai_meal_log_in_new_session"](food_id),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (["history", "ok"], ["not_found", "ok"]), results


def test_recipe_delete_versus_food_plan_create_serializes(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    food_id = ctx["deletable_food_id"]
    results = _run_barriered(
        [
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
            lambda: ctx["create_food_plan_in_new_session"](food_id),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (["conflict", "ok"], ["history", "ok"], ["not_found", "ok"]), results


def test_recipe_delete_versus_rest_food_plan_rebind_serializes(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    food_id = ctx["deletable_food_id"]
    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        plan = FoodPlanItem(
            id="plan-mysql-delete-rebind",
            family_id=ctx["family_id"],
            user_id=ctx["user_id"],
            food_id=ctx["food_id"],
            plan_date=ctx["today"] + timedelta(days=3),
            meal_type=MealType.DINNER,
            note="delete rebind",
            status="planned",
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
        )
        db.add(plan)
        db.commit()

    results = _run_barriered(
        [
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
            lambda: ctx["rebind_rest_plan_in_new_session"](
                "plan-mysql-delete-rebind",
                food_id,
            ),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (["conflict", "ok"], ["history", "ok"], ["not_found", "ok"]), results


def test_recipe_delete_versus_ai_food_plan_rebind_serializes(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    recipe_id = ctx["deletable_recipe_id"]
    food_id = ctx["deletable_food_id"]
    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        plan = FoodPlanItem(
            id="plan-mysql-delete-ai-rebind",
            family_id=ctx["family_id"],
            user_id=ctx["user_id"],
            food_id=ctx["food_id"],
            plan_date=ctx["today"] + timedelta(days=4),
            meal_type=MealType.DINNER,
            note="delete ai rebind",
            status="planned",
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
        )
        db.add(plan)
        db.commit()

    results = _run_barriered(
        [
            lambda: ctx["delete_recipe_in_new_session"](recipe_id),
            lambda: ctx["rebind_ai_plan_in_new_session"](
                "plan-mysql-delete-ai-rebind",
                food_id,
            ),
        ],
        timeout=30.0,
    )
    kinds = sorted(kind for kind, _ in results)
    assert kinds in (["conflict", "ok"], ["history", "ok"], ["not_found", "ok"]), results


def test_cook_completion_versus_ai_plan_rebind_no_deadlock(mysql_concurrency_context: dict) -> None:
    """Cook completion and AI plan rebind on the same Food/plan serialize without hanging."""
    ctx = mysql_concurrency_context
    command = ctx["completion_command"](
        "cook-vs-rebind",
        food_plan_item_id=ctx["rebind_plan_id"],
        food_plan_item_base_updated_at=ctx["rebind_plan_base_updated_at"],
    )

    def cook() -> tuple[str, Any]:
        try:
            return "ok", ctx["complete_in_new_session"](command)
        except (CompletionConflict, FoodPlanConflict) as exc:
            return "conflict", getattr(exc, "code", type(exc).__name__)
        except Exception as exc:  # noqa: BLE001
            return "error", f"{type(exc).__name__}: {exc}"

    results = _run_barriered(
        [
            cook,
            lambda: ctx["rebind_ai_plan_in_new_session"](
                ctx["rebind_plan_id"],
                ctx["alt_food_id"],
                base_updated_at=ctx["rebind_plan_base_updated_at"],
            ),
        ],
        timeout=30.0,
    )
    kinds = [kind for kind, _ in results]
    assert all(kind in {"ok", "conflict", "error"} for kind in kinds), results
    assert "ok" in kinds, results

    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        plan = db.get(FoodPlanItem, ctx["rebind_plan_id"])
        assert plan is not None
        if plan.status == "cooked":
            assert plan.food_id == ctx["food_id"]
            assert plan.meal_log_id is not None
        else:
            assert plan.food_id in {ctx["food_id"], ctx["alt_food_id"]}


def test_ai_batch_reversed_food_plan_order_no_deadlock(mysql_concurrency_context: dict) -> None:
    """AI batch A and batch B reverse model operation order over the same Food/plan sets."""
    ctx = mysql_concurrency_context
    SessionLocal = ctx["SessionLocal"]
    with SessionLocal() as db:
        plan_a = FoodPlanItem(
            id="plan-mysql-batch-a",
            family_id=ctx["family_id"],
            user_id=ctx["user_id"],
            food_id=ctx["food_id"],
            plan_date=ctx["today"] + timedelta(days=5),
            meal_type=MealType.DINNER,
            note="batch a",
            status="planned",
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
        )
        plan_b = FoodPlanItem(
            id="plan-mysql-batch-b",
            family_id=ctx["family_id"],
            user_id=ctx["user_id"],
            food_id=ctx["alt_food_id"],
            plan_date=ctx["today"] + timedelta(days=6),
            meal_type=MealType.DINNER,
            note="batch b",
            status="planned",
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
        )
        db.add_all([plan_a, plan_b])
        db.commit()
        plan_a_updated = plan_a.updated_at
        plan_b_updated = plan_b.updated_at

    ops_forward = [
        {
            "operationId": "op-a",
            "action": "update",
            "targetId": "plan-mysql-batch-a",
            "baseUpdatedAt": plan_a_updated.isoformat() if plan_a_updated else None,
            "payload": {
                "foodId": ctx["alt_food_id"],
                "date": (ctx["today"] + timedelta(days=5)).isoformat(),
                "mealType": MealType.DINNER.value,
                "reason": "forward a",
            },
        },
        {
            "operationId": "op-b",
            "action": "update",
            "targetId": "plan-mysql-batch-b",
            "baseUpdatedAt": plan_b_updated.isoformat() if plan_b_updated else None,
            "payload": {
                "foodId": ctx["food_id"],
                "date": (ctx["today"] + timedelta(days=6)).isoformat(),
                "mealType": MealType.DINNER.value,
                "reason": "forward b",
            },
        },
    ]
    ops_reverse = list(reversed(ops_forward))

    def run_batch(operations: list[dict], label: str) -> tuple[str, Any]:
        with SessionLocal() as db:
            try:
                result, _ids = execute_meal_plan_draft(
                    db,
                    family_id=ctx["family_id"],
                    user_id=ctx["user_id"],
                    payload={"operations": operations},
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
                db.commit()
                return "ok", (label, result)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                return "conflict", f"{label}:{type(exc).__name__}:{exc}"

    results = _run_barriered(
        [
            lambda: run_batch(ops_forward, "forward"),
            lambda: run_batch(ops_reverse, "reverse"),
        ],
        timeout=30.0,
    )
    kinds = [kind for kind, _ in results]
    assert all(kind in {"ok", "conflict"} for kind in kinds), results
    assert kinds.count("ok") >= 1, results
