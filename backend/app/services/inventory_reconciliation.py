from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import (
    ActivityAction,
    ActivityHighlightKind,
    FoodType,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    UserRole,
)
from app.core.utils import utcnow
from app.models.domain import (
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    ShoppingListItem,
)
from app.repos.inventory_operations import claim_inventory_operation
from app.schemas.inventory_operations import (
    ExactIngredientReconciliationRequest,
    FoodReconciliationRequest,
    InventoryOperationDisplaySummary,
    InventoryOperationResult,
    InventoryReconciliationOut,
    InventoryReconciliationRequest,
    PresenceIngredientReconciliationRequest,
    ReconciliationBatchOut,
    ReconciliationScope,
    ReconciliationSummaryOut,
    SCOPE_CANONICAL_STORAGE,
    ExactIngredientReconciliationGroupOut,
    FoodReconciliationGroupOut,
    PresenceIngredientReconciliationGroupOut,
)
from app.schemas.inventory_states import IngredientInventoryStateOut
from app.services.activity import ActivityHighlight, log_activity
from app.services.food_stock import apply_food_inventory_confirm, apply_food_inventory_set_stock
from app.services.food_stock_quantity import normalize_food_stock_quantity, validate_food_stock_quantity_precision
from app.services.ingredient_inventory_state import (
    state_is_physically_present,
    upsert_inventory_state,
)
from app.services.ingredient_units import UnitConversionError, convert_quantity_to_default_unit
from app.services.inventory_confirmation import (
    FOOD_STALE_AFTER_DAYS,
    PRESENCE_INGREDIENT_STALE_AFTER_DAYS,
    aggregate_confirmation_status,
    confirmation_status,
    earliest_confirmation,
    stale_after_days_for_storage_location,
)
from app.services.inventory_operation_history import (
    canonical_request_hash,
    compute_can_revert,
    record_ingredient_collection_guard,
    record_operation_line,
    snapshot_food_inventory,
    snapshot_inventory_item,
    snapshot_inventory_state,
)
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.inventory_operations import create_inventory_batch
from app.services.inventory_overview import is_ready_like_food
from app.services.inventory_usage import remaining_quantity, tracks_quantity
from app.services.inventory_versions import InventoryConflictError, bump_ingredient_collection, require_expected_version
from app.services.serializers import serialize_ingredient_inventory_state


READY_LIKE_FOOD_TYPES = {
    FoodType.READY_MADE.value,
    FoodType.INSTANT.value,
    FoodType.PACKAGED.value,
}


class ReconciliationValidationError(ValueError):
    """Structured 422 validation error for inventory reconciliation."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        field_errors: list[dict[str, Any]] | None = None,
        conflicts: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field_errors = list(field_errors or [])
        self.conflicts = list(conflicts or [])


def validation_detail(error: ReconciliationValidationError) -> dict[str, Any]:
    return {
        "code": error.code,
        "message": error.message,
        "conflicts": error.conflicts,
        "field_errors": error.field_errors,
    }


def _as_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _field_error(
    *,
    field: str,
    code: str,
    message: str,
    entity_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"field": field, "code": code, "message": message}
    if entity_id is not None:
        payload["entity_id"] = entity_id
    return payload


def _raise_validation(
    message: str,
    *,
    code: str,
    field: str = "groups",
    entity_id: str | None = None,
) -> None:
    raise ReconciliationValidationError(
        message,
        code=code,
        field_errors=[_field_error(field=field, code=code, message=message, entity_id=entity_id)],
    )


def resolve_scope_storage_location(
    scope: ReconciliationScope,
    storage_location: str | None,
) -> str | None:
    """Return the effective storage filter label for location scopes, else None."""
    if scope in {"all", "suggested"}:
        return None
    if storage_location:
        return storage_location.strip() or SCOPE_CANONICAL_STORAGE[scope]
    return SCOPE_CANONICAL_STORAGE[scope]


def item_matches_scope_location(item: InventoryItem, *, scope_location: str | None) -> bool:
    if scope_location is None:
        return True
    return (item.storage_location or "").strip() == scope_location


def state_matches_scope_location(state: IngredientInventoryState, *, scope_location: str | None) -> bool:
    if scope_location is None:
        return True
    return (state.storage_location or "").strip() == scope_location


def food_matches_scope_location(food: Food, *, scope_location: str | None) -> bool:
    if scope_location is None:
        return True
    return (food.storage_location or "").strip() == scope_location


def physical_remaining_batches(
    items: list[InventoryItem],
    *,
    scope_location: str | None = None,
) -> list[InventoryItem]:
    result: list[InventoryItem] = []
    for item in items:
        if remaining_quantity(item) <= 0:
            continue
        if not item_matches_scope_location(item, scope_location=scope_location):
            continue
        result.append(item)
    result.sort(key=lambda item: item.id)
    return result


def _pending_shopping_by_target(
    db: Session,
    *,
    family_id: str,
) -> tuple[dict[str, str], dict[str, str]]:
    """Return (ingredient_id -> shopping_id, food_id -> shopping_id) for open items."""
    rows = list(
        db.scalars(
            select(ShoppingListItem)
            .where(
                ShoppingListItem.family_id == family_id,
                ShoppingListItem.done.is_(False),
            )
            .order_by(ShoppingListItem.id.asc())
        )
    )
    by_ingredient: dict[str, str] = {}
    by_food: dict[str, str] = {}
    for row in rows:
        if row.ingredient_id and row.ingredient_id not in by_ingredient:
            by_ingredient[row.ingredient_id] = row.id
        if row.food_id and row.food_id not in by_food:
            by_food[row.food_id] = row.id
    return by_ingredient, by_food


def _batch_out(
    item: InventoryItem,
    *,
    generated_at: datetime,
    business_date: date,
) -> ReconciliationBatchOut:
    status = confirmation_status(
        item.last_confirmed_at,
        generated_at=generated_at,
        stale_after_days=stale_after_days_for_storage_location(item.storage_location),
    )
    return ReconciliationBatchOut(
        inventory_item_id=item.id,
        row_version=int(item.row_version),
        remaining_quantity=remaining_quantity(item),
        unit=item.unit,
        status=item.status,
        purchase_date=item.purchase_date,
        expiry_date=item.expiry_date,
        storage_location=item.storage_location,
        notes=item.notes or "",
        confirmation_status=status,  # type: ignore[arg-type]
        last_confirmed_at=_as_aware(item.last_confirmed_at),
    )


def build_inventory_reconciliation(
    db: Session,
    *,
    family_id: str,
    scope: ReconciliationScope,
    storage_location: str | None,
    business_date: date,
    generated_at: datetime,
) -> InventoryReconciliationOut:
    scope_location = resolve_scope_storage_location(scope, storage_location)
    # For suggested, groups filter by confirmation, but exact batches are all physical rows.
    batch_scope_location = None if scope == "suggested" else scope_location

    ingredients = list(
        db.scalars(
            select(Ingredient)
            .where(Ingredient.family_id == family_id)
            .order_by(Ingredient.name.asc(), Ingredient.id.asc())
        )
    )
    ingredients_by_id = {item.id: item for item in ingredients}
    tracked_ids = [item.id for item in ingredients if tracks_quantity(item)]
    presence_ids = [item.id for item in ingredients if not tracks_quantity(item)]

    inventory_items = list(
        db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == family_id,
                InventoryItem.ingredient_id.in_(tracked_ids) if tracked_ids else False,
            )
            .options(selectinload(InventoryItem.ingredient))
            .order_by(InventoryItem.id.asc())
        )
    ) if tracked_ids else []
    items_by_ingredient: dict[str, list[InventoryItem]] = {}
    for item in inventory_items:
        items_by_ingredient.setdefault(item.ingredient_id, []).append(item)

    states = list(
        db.scalars(
            select(IngredientInventoryState)
            .where(
                IngredientInventoryState.family_id == family_id,
                IngredientInventoryState.ingredient_id.in_(presence_ids) if presence_ids else False,
            )
            .order_by(IngredientInventoryState.ingredient_id.asc())
        )
    ) if presence_ids else []
    states_by_ingredient = {state.ingredient_id: state for state in states}

    foods = list(
        db.scalars(
            select(Food)
            .where(Food.family_id == family_id)
            .order_by(Food.name.asc(), Food.id.asc())
        )
    )
    pending_by_ingredient, pending_by_food = _pending_shopping_by_target(db, family_id=family_id)

    groups: list[
        ExactIngredientReconciliationGroupOut
        | PresenceIngredientReconciliationGroupOut
        | FoodReconciliationGroupOut
    ] = []
    expired_physical_batches = 0

    for ingredient_id in sorted(tracked_ids):
        ingredient = ingredients_by_id[ingredient_id]
        scoped_batches = physical_remaining_batches(
            items_by_ingredient.get(ingredient_id, []),
            scope_location=batch_scope_location,
        )
        # Location scopes exclude ingredients with no in-scope physical rows.
        if scope not in {"all", "suggested"} and not physical_remaining_batches(
            items_by_ingredient.get(ingredient_id, []),
            scope_location=scope_location,
        ):
            continue
        if scope in {"all"} and not scoped_batches:
            continue
        if not scoped_batches:
            continue

        batch_outs = [
            _batch_out(item, generated_at=generated_at, business_date=business_date)
            for item in scoped_batches
        ]
        for item in scoped_batches:
            if item.expiry_date is not None and item.expiry_date < business_date:
                expired_physical_batches += 1

        group_status = aggregate_confirmation_status(
            [batch.confirmation_status for batch in batch_outs]
        )
        group_last = earliest_confirmation([batch.last_confirmed_at for batch in batch_outs])
        if scope == "suggested" and group_status == "current":
            continue

        groups.append(
            ExactIngredientReconciliationGroupOut(
                kind="exact_ingredient",
                ingredient_id=ingredient.id,
                ingredient_name=ingredient.name,
                ingredient_row_version=int(ingredient.row_version),
                confirmation_status=group_status,  # type: ignore[arg-type]
                last_confirmed_at=group_last,
                batches=batch_outs,
                pending_shopping_item_id=pending_by_ingredient.get(ingredient.id),
            )
        )

    for ingredient_id in sorted(presence_ids):
        ingredient = ingredients_by_id[ingredient_id]
        state = states_by_ingredient.get(ingredient_id)
        if state is None or not state_is_physically_present(state):
            continue
        if scope != "suggested" and not state_matches_scope_location(state, scope_location=scope_location):
            continue

        status = confirmation_status(
            state.last_confirmed_at,
            generated_at=generated_at,
            stale_after_days=PRESENCE_INGREDIENT_STALE_AFTER_DAYS,
        )
        if scope == "suggested" and status == "current":
            continue

        state_out = IngredientInventoryStateOut.model_validate(
            serialize_ingredient_inventory_state(state)
        )
        groups.append(
            PresenceIngredientReconciliationGroupOut(
                kind="presence_ingredient",
                ingredient_id=ingredient.id,
                ingredient_name=ingredient.name,
                ingredient_row_version=int(ingredient.row_version),
                state=state_out,
                confirmation_status=status,  # type: ignore[arg-type]
                pending_shopping_item_id=pending_by_ingredient.get(ingredient.id),
            )
        )

    for food in foods:
        if not is_ready_like_food(food) or food.type not in READY_LIKE_FOOD_TYPES:
            continue
        stock = normalize_food_stock_quantity(Decimal(str(food.stock_quantity or 0)))
        if stock <= 0:
            continue
        if scope != "suggested" and not food_matches_scope_location(food, scope_location=scope_location):
            continue
        status = confirmation_status(
            food.inventory_last_confirmed_at,
            generated_at=generated_at,
            stale_after_days=FOOD_STALE_AFTER_DAYS,
        )
        if scope == "suggested" and status == "current":
            continue
        groups.append(
            FoodReconciliationGroupOut(
                kind="food",
                food_id=food.id,
                food_name=food.name,
                row_version=int(food.row_version),
                stock_quantity=stock,
                stock_unit=food.stock_unit or "",
                expiry_date=food.expiry_date,
                storage_location=food.storage_location or None,
                confirmation_status=status,  # type: ignore[arg-type]
                last_confirmed_at=_as_aware(food.inventory_last_confirmed_at),
            )
        )

    # Stable group ordering: exact, presence, food; each by name then id.
    def _group_sort_key(group: Any) -> tuple[int, str, str]:
        if isinstance(group, ExactIngredientReconciliationGroupOut):
            return (0, group.ingredient_name, group.ingredient_id)
        if isinstance(group, PresenceIngredientReconciliationGroupOut):
            return (1, group.ingredient_name, group.ingredient_id)
        return (2, group.food_name, group.food_id)

    groups.sort(key=_group_sort_key)

    never_confirmed = sum(1 for group in groups if group.confirmation_status == "never_confirmed")
    stale = sum(1 for group in groups if group.confirmation_status == "stale")
    summary = ReconciliationSummaryOut(
        total_groups=len(groups),
        never_confirmed=never_confirmed,
        stale=stale,
        expired_physical_batches=expired_physical_batches,
    )
    return InventoryReconciliationOut(
        business_date=business_date,
        business_timezone="Asia/Shanghai",
        generated_at=_as_aware(generated_at) or generated_at,
        summary=summary,
        groups=groups,
    )


@dataclass(slots=True)
class _PreparedExact:
    request: ExactIngredientReconciliationRequest
    ingredient: Ingredient
    ingredient_before_version: int
    observed_items: list[InventoryItem]
    batch_before_snapshots: dict[str, dict[str, object]] = field(default_factory=dict)


@dataclass(slots=True)
class _PreparedPresence:
    request: PresenceIngredientReconciliationRequest
    ingredient: Ingredient
    ingredient_before_version: int
    state: IngredientInventoryState | None
    state_before_snapshot: dict[str, object] | None = None


@dataclass(slots=True)
class _PreparedFood:
    request: FoodReconciliationRequest
    food: Food
    food_before_snapshot: dict[str, object]


def _result_from_operation(
    operation: InventoryOperation,
    *,
    user_id: str,
    user_role: UserRole,
) -> InventoryOperationResult:
    summary_data = operation.summary_json or {}
    summary = InventoryOperationDisplaySummary(
        title=str(summary_data.get("title") or "完成了一次库存盘点"),
        description=str(summary_data.get("description") or ""),
        confirmed_count=int(summary_data.get("confirmed_count") or 0),
        adjusted_count=int(summary_data.get("adjusted_count") or 0),
        completed_count=int(summary_data.get("completed_count") or 0),
        partial_count=int(summary_data.get("partial_count") or 0),
    )
    return InventoryOperationResult(
        operation_id=operation.id,
        operation_type=operation.operation_type,
        status=operation.status,
        applied_at=operation.applied_at,
        revertible_until=operation.revertible_until,
        can_revert=compute_can_revert(
            operation,
            user_id=user_id,
            user_role=user_role,
            now=utcnow(),
        ),
        summary=summary,
    )


def _load_operation(db: Session, operation_id: str) -> InventoryOperation:
    operation = db.scalar(
        select(InventoryOperation)
        .where(InventoryOperation.id == operation_id)
        .options(selectinload(InventoryOperation.lines))
    )
    if operation is None:
        raise ValueError("库存操作不存在")
    return operation


def _confirm_batch(
    item: InventoryItem,
    *,
    user_id: str,
) -> None:
    item.last_confirmed_at = utcnow()
    item.last_confirmed_by = user_id
    item.last_confirmation_source = InventoryConfirmationSource.RECONCILIATION
    item.updated_by = user_id


def _apply_batch_remaining(
    item: InventoryItem,
    *,
    actual_remaining_quantity: Decimal,
    inventory_status: Any,
    purchase_date: date,
    expiry_date: date | None,
    storage_location: str,
    notes: str,
    user_id: str,
) -> None:
    expiry_changed = item.expiry_date != expiry_date
    item.quantity = item.consumed_quantity + item.disposed_quantity + actual_remaining_quantity
    item.status = inventory_status
    item.purchase_date = purchase_date
    item.expiry_date = expiry_date
    if expiry_changed:
        item.expiry_alert_snoozed_until = None
        item.expiry_reviewed_at = None
        item.expiry_reviewed_by = None
    item.storage_location = storage_location
    item.notes = notes or ""
    _confirm_batch(item, user_id=user_id)


def _validate_exact_batch_adjustments(
    group: ExactIngredientReconciliationRequest,
    *,
    group_index: int,
    ingredient: Ingredient,
) -> None:
    """Validate exact-batch fields that depend on the locked Ingredient profile.

    A newly created batch's unit cannot be checked by Pydantic alone because the
    conversion table belongs to the Ingredient.  Validate it during the
    preparation phase, before the mutation loops begin, so callers receive the
    reconciliation endpoint's structured 422 contract rather than a late 400
    from ``create_inventory_batch``.
    """
    for update_index, update in enumerate(group.updates):
        if update.expiry_date is not None and update.expiry_date < update.purchase_date:
            _raise_validation(
                "到期日不能早于采购日",
                code="invalid_date_range",
                field=f"groups.{group_index}.updates.{update_index}.expiry_date",
                entity_id=ingredient.id,
            )

    for create_index, create in enumerate(group.creates):
        if create.expiry_date is not None and create.expiry_date < create.purchase_date:
            _raise_validation(
                "到期日不能早于采购日",
                code="invalid_date_range",
                field=f"groups.{group_index}.creates.{create_index}.expiry_date",
                entity_id=ingredient.id,
            )
        try:
            normalized_quantity = convert_quantity_to_default_unit(
                create.actual_remaining_quantity,
                ingredient.default_unit,
                ingredient.unit_conversions,
                create.unit,
            )
        except UnitConversionError as exc:
            _raise_validation(
                str(exc),
                code="incompatible_unit",
                field=f"groups.{group_index}.creates.{create_index}.unit",
                entity_id=ingredient.id,
            )
        if normalized_quantity <= 0:
            _raise_validation(
                "新增批次换算后的数量必须大于 0",
                code="invalid_quantity",
                field=f"groups.{group_index}.creates.{create_index}.actual_remaining_quantity",
                entity_id=ingredient.id,
            )


def apply_inventory_reconciliation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: InventoryReconciliationRequest,
    business_date: date,
    user_role: UserRole = UserRole.MEMBER,
) -> InventoryOperationResult:
    """Validate and mutate the full reconciliation; never commit."""
    del business_date  # reserved for callers; scope validation uses locked current rows

    # Service-level duplicate guard (schema also checks).
    exact_ids = [
        group.ingredient_id
        for group in request.groups
        if isinstance(group, ExactIngredientReconciliationRequest)
    ]
    presence_ids = [
        group.ingredient_id
        for group in request.groups
        if isinstance(group, PresenceIngredientReconciliationRequest)
    ]
    food_ids = [
        group.food_id for group in request.groups if isinstance(group, FoodReconciliationRequest)
    ]
    if len(exact_ids) != len(set(exact_ids)) or len(presence_ids) != len(set(presence_ids)) or len(food_ids) != len(
        set(food_ids)
    ):
        _raise_validation("请求中包含重复目标", code="duplicate_request_item")

    request_hash = canonical_request_hash(request)
    provisional_summary = InventoryOperationDisplaySummary(
        title="完成了一次库存盘点",
        description="处理中",
    )
    operation, created = claim_inventory_operation(
        db,
        family_id=family_id,
        actor_id=user_id,
        operation_type=InventoryOperationType.RECONCILIATION,
        client_request_id=request.client_request_id,
        request_hash=request_hash,
        summary=provisional_summary,
    )
    if not created:
        existing = _load_operation(db, operation.id)
        return _result_from_operation(
            existing,
            user_id=user_id,
            user_role=user_role,
        )

    scope_location = resolve_scope_storage_location(request.scope, request.storage_location)
    # For suggested, observed set is all physical remaining batches across locations.
    observed_scope_location = None if request.scope == "suggested" else scope_location

    ingredient_ids = list(dict.fromkeys([*exact_ids, *presence_ids]))
    # Only lock existing states; first-create leaves state_id null (match shopping intake).
    state_ingredient_ids = list(
        dict.fromkeys(
            group.ingredient_id
            for group in request.groups
            if isinstance(group, PresenceIngredientReconciliationRequest) and group.state_id is not None
        )
    )
    optional_state_ingredient_ids = list(
        dict.fromkeys(
            group.ingredient_id
            for group in request.groups
            if isinstance(group, PresenceIngredientReconciliationRequest) and group.state_id is None
        )
    )
    inventory_item_ids: list[str] = []
    for group in request.groups:
        if isinstance(group, ExactIngredientReconciliationRequest):
            inventory_item_ids.extend(batch.inventory_item_id for batch in group.observed_batches)
            inventory_item_ids.extend(update.inventory_item_id for update in group.updates)

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            food_ids=food_ids,
            state_ingredient_ids=state_ingredient_ids,
            optional_state_ingredient_ids=optional_state_ingredient_ids,
            inventory_item_ids=inventory_item_ids,
        )
    except InventoryTargetNotFoundError as exc:
        # Missing/deleted targets are concurrent conflicts (409), not request validation.
        raise InventoryConflictError(
            str(exc),
            code="missing_target",
            conflicts=[
                {
                    "reason": "missing",
                    "message": str(exc),
                }
            ],
        ) from exc

    prepared_exact: list[_PreparedExact] = []
    prepared_presence: list[_PreparedPresence] = []
    prepared_food: list[_PreparedFood] = []

    # Prefetch all physical batches for exact ingredients to rebuild observed sets.
    exact_ingredient_ids = list(dict.fromkeys(exact_ids))
    all_items_for_exact: dict[str, list[InventoryItem]] = {ingredient_id: [] for ingredient_id in exact_ingredient_ids}
    if exact_ingredient_ids:
        all_items = list(
            db.scalars(
                select(InventoryItem)
                .where(
                    InventoryItem.family_id == family_id,
                    InventoryItem.ingredient_id.in_(exact_ingredient_ids),
                )
                .order_by(InventoryItem.id.asc())
                .with_for_update()
            )
        )
        for item in all_items:
            all_items_for_exact.setdefault(item.ingredient_id, []).append(item)
            # Ensure locked map has them for mutation.
            locked.inventory_items.setdefault(item.id, item)

    for group_index, group in enumerate(request.groups):
        if isinstance(group, ExactIngredientReconciliationRequest):
            ingredient = locked.ingredients.get(group.ingredient_id)
            if ingredient is None:
                raise InventoryConflictError(
                    "食材不存在或不属于当前家庭",
                    code="stale_version",
                    conflicts=[
                        {
                            "entity_type": "ingredient",
                            "entity_id": group.ingredient_id,
                            "reason": "missing",
                        }
                    ],
                )
            if not tracks_quantity(ingredient):
                raise InventoryConflictError(
                    "食材跟踪模式已变更，请刷新后重试",
                    code="tracking_mode_changed",
                    conflicts=[
                        {
                            "entity_type": "ingredient",
                            "entity_id": ingredient.id,
                            "expected_row_version": group.expected_ingredient_row_version,
                            "current_row_version": ingredient.row_version,
                            "reason": "tracking_mode_changed",
                        }
                    ],
                )

            current_scope_items = physical_remaining_batches(
                all_items_for_exact.get(ingredient.id, []),
                scope_location=observed_scope_location,
            )
            current_ids = {item.id for item in current_scope_items}
            submitted_ids = {batch.inventory_item_id for batch in group.observed_batches}
            if current_ids != submitted_ids:
                raise InventoryConflictError(
                    "盘点范围内的批次集合已变化，请刷新后重试",
                    code="scope_changed",
                    conflicts=[
                        {
                            "entity_type": "ingredient",
                            "entity_id": ingredient.id,
                            "expected_batch_ids": sorted(submitted_ids),
                            "current_batch_ids": sorted(current_ids),
                            "reason": "scope_changed",
                        }
                    ],
                )

            require_expected_version(
                ingredient,
                group.expected_ingredient_row_version,
                entity_type="ingredient",
                entity_id=ingredient.id,
            )

            observed_items: list[InventoryItem] = []
            batch_before: dict[str, dict[str, object]] = {}
            for observed in group.observed_batches:
                item = locked.inventory_items.get(observed.inventory_item_id)
                if item is None or item.ingredient_id != ingredient.id:
                    raise InventoryConflictError(
                        "库存批次不存在或不属于当前家庭",
                        code="stale_version",
                        conflicts=[
                            {
                                "entity_type": "inventory_item",
                                "entity_id": observed.inventory_item_id,
                                "reason": "missing",
                            }
                        ],
                    )
                require_expected_version(
                    item,
                    observed.expected_row_version,
                    entity_type="inventory_item",
                    entity_id=item.id,
                )
                observed_items.append(item)
                batch_before[item.id] = snapshot_inventory_item(item)

            _validate_exact_batch_adjustments(
                group,
                group_index=group_index,
                ingredient=ingredient,
            )

            prepared_exact.append(
                _PreparedExact(
                    request=group,
                    ingredient=ingredient,
                    ingredient_before_version=ingredient.row_version,
                    observed_items=observed_items,
                    batch_before_snapshots=batch_before,
                )
            )

        elif isinstance(group, PresenceIngredientReconciliationRequest):
            ingredient = locked.ingredients.get(group.ingredient_id)
            if ingredient is None:
                raise InventoryConflictError(
                    "食材不存在或不属于当前家庭",
                    code="stale_version",
                    conflicts=[
                        {
                            "entity_type": "ingredient",
                            "entity_id": group.ingredient_id,
                            "reason": "missing",
                        }
                    ],
                )
            if tracks_quantity(ingredient):
                raise InventoryConflictError(
                    "食材跟踪模式已变更，请刷新后重试",
                    code="tracking_mode_changed",
                    conflicts=[
                        {
                            "entity_type": "ingredient",
                            "entity_id": ingredient.id,
                            "expected_row_version": group.expected_ingredient_row_version,
                            "current_row_version": ingredient.row_version,
                            "reason": "tracking_mode_changed",
                        }
                    ],
                )
            require_expected_version(
                ingredient,
                group.expected_ingredient_row_version,
                entity_type="ingredient",
                entity_id=ingredient.id,
            )
            state = locked.states_by_ingredient_id.get(ingredient.id)
            if group.state_id is not None:
                if state is None or state.id != group.state_id:
                    raise InventoryConflictError(
                        "库存状态不存在或不属于当前食材",
                        code="stale_version",
                        conflicts=[
                            {
                                "entity_type": "ingredient_inventory_state",
                                "entity_id": group.state_id,
                                "reason": "missing",
                            }
                        ],
                    )
                assert group.expected_state_row_version is not None
                require_expected_version(
                    state,
                    group.expected_state_row_version,
                    entity_type="ingredient_inventory_state",
                    entity_id=state.id,
                )
            elif state is not None:
                # Client thought state was missing but it now exists.
                raise InventoryConflictError(
                    "库存状态已变化，请刷新后重试",
                    code="stale_version",
                    conflicts=[
                        {
                            "entity_type": "ingredient_inventory_state",
                            "entity_id": state.id,
                            "reason": "created_concurrently",
                        }
                    ],
                )
            prepared_presence.append(
                _PreparedPresence(
                    request=group,
                    ingredient=ingredient,
                    ingredient_before_version=ingredient.row_version,
                    state=state,
                    state_before_snapshot=snapshot_inventory_state(state) if state is not None else None,
                )
            )

        elif isinstance(group, FoodReconciliationRequest):
            food = locked.foods.get(group.food_id)
            if food is None:
                raise InventoryConflictError(
                    "食物不存在或不属于当前家庭",
                    code="stale_version",
                    conflicts=[
                        {
                            "entity_type": "food",
                            "entity_id": group.food_id,
                            "reason": "missing",
                        }
                    ],
                )
            if not is_ready_like_food(food) or food.type not in READY_LIKE_FOOD_TYPES:
                _raise_validation(
                    "只有成品、速食或包装食品可以盘点",
                    code="invalid_target",
                    field="food_id",
                    entity_id=food.id,
                )
            require_expected_version(
                food,
                group.expected_row_version,
                entity_type="food",
                entity_id=food.id,
            )
            if group.action == "set_stock":
                assert group.stock_quantity is not None
                try:
                    validate_food_stock_quantity_precision(group.stock_quantity)
                except ValueError as exc:
                    _raise_validation(
                        str(exc),
                        code="invalid_quantity",
                        field="stock_quantity",
                        entity_id=food.id,
                    )
                if (
                    group.stock_quantity > 0
                    and food.stock_unit
                    and group.stock_unit != food.stock_unit
                ):
                    _raise_validation(
                        f"当前食物库存单位是 {food.stock_unit}，不能按 {group.stock_unit} 盘点",
                        code="incompatible_unit",
                        field="stock_unit",
                        entity_id=food.id,
                    )
            prepared_food.append(
                _PreparedFood(
                    request=group,
                    food=food,
                    food_before_snapshot=snapshot_food_inventory(food),
                )
            )

    sequence = 1
    confirmed_count = 0
    adjusted_count = 0
    touched_ingredient_guards: dict[str, tuple[Ingredient, int]] = {}

    for prepared in prepared_exact:
        group = prepared.request
        ingredient = prepared.ingredient
        observed_by_id = {item.id: item for item in prepared.observed_items}

        if group.action == "confirm_all":
            for item in prepared.observed_items:
                before = prepared.batch_before_snapshots[item.id]
                _confirm_batch(item, user_id=user_id)
                db.flush()
                record_operation_line(
                    db,
                    operation=operation,
                    sequence=sequence,
                    entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
                    entity_id=item.id,
                    change_type=InventoryOperationChangeType.UPDATE,
                    before_snapshot=before,
                    after_snapshot=snapshot_inventory_item(item),
                    before_row_version=int(before["row_version"]),
                    after_row_version=item.row_version,
                    change_metadata={"action": "confirm_all"},
                )
                sequence += 1
            confirmed_count += 1
            bump_ingredient_collection(ingredient, user_id=user_id)

        elif group.action == "set_absent":
            for item in prepared.observed_items:
                before = prepared.batch_before_snapshots[item.id]
                _apply_batch_remaining(
                    item,
                    actual_remaining_quantity=Decimal("0"),
                    inventory_status=item.status,
                    purchase_date=item.purchase_date,
                    expiry_date=item.expiry_date,
                    storage_location=item.storage_location,
                    notes=item.notes or "",
                    user_id=user_id,
                )
                db.flush()
                record_operation_line(
                    db,
                    operation=operation,
                    sequence=sequence,
                    entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
                    entity_id=item.id,
                    change_type=InventoryOperationChangeType.UPDATE,
                    before_snapshot=before,
                    after_snapshot=snapshot_inventory_item(item),
                    before_row_version=int(before["row_version"]),
                    after_row_version=item.row_version,
                    change_metadata={"action": "set_absent"},
                )
                sequence += 1
            adjusted_count += 1
            bump_ingredient_collection(ingredient, user_id=user_id)

        elif group.action == "adjust_batches":
            updated_ids = {update.inventory_item_id for update in group.updates}
            for update in group.updates:
                item = observed_by_id[update.inventory_item_id]
                before = prepared.batch_before_snapshots[item.id]
                _apply_batch_remaining(
                    item,
                    actual_remaining_quantity=update.actual_remaining_quantity,
                    inventory_status=update.inventory_status,
                    purchase_date=update.purchase_date,
                    expiry_date=update.expiry_date,
                    storage_location=update.storage_location,
                    notes=update.notes,
                    user_id=user_id,
                )
                db.flush()
                record_operation_line(
                    db,
                    operation=operation,
                    sequence=sequence,
                    entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
                    entity_id=item.id,
                    change_type=InventoryOperationChangeType.UPDATE,
                    before_snapshot=before,
                    after_snapshot=snapshot_inventory_item(item),
                    before_row_version=int(before["row_version"]),
                    after_row_version=item.row_version,
                    change_metadata={"action": "adjust_batches", "client_line_id": None},
                )
                sequence += 1

            # Batches observed but not updated still receive confirmation.
            for item in prepared.observed_items:
                if item.id in updated_ids:
                    continue
                before = prepared.batch_before_snapshots[item.id]
                _confirm_batch(item, user_id=user_id)
                db.flush()
                record_operation_line(
                    db,
                    operation=operation,
                    sequence=sequence,
                    entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
                    entity_id=item.id,
                    change_type=InventoryOperationChangeType.UPDATE,
                    before_snapshot=before,
                    after_snapshot=snapshot_inventory_item(item),
                    before_row_version=int(before["row_version"]),
                    after_row_version=item.row_version,
                    change_metadata={"action": "confirm_observed"},
                )
                sequence += 1

            for create in group.creates:
                inventory_item = create_inventory_batch(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    ingredient=ingredient,
                    quantity=create.actual_remaining_quantity,
                    unit=create.unit,
                    status=create.inventory_status,
                    purchase_date=create.purchase_date,
                    expiry_date=create.expiry_date,
                    storage_location=create.storage_location,
                    notes=create.notes,
                    record_activity=False,
                    already_locked=True,
                )
                inventory_item.last_confirmed_at = utcnow()
                inventory_item.last_confirmed_by = user_id
                inventory_item.last_confirmation_source = InventoryConfirmationSource.RECONCILIATION
                db.flush()
                record_operation_line(
                    db,
                    operation=operation,
                    sequence=sequence,
                    entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
                    entity_id=inventory_item.id,
                    change_type=InventoryOperationChangeType.CREATE,
                    before_snapshot=None,
                    after_snapshot=snapshot_inventory_item(inventory_item),
                    before_row_version=None,
                    after_row_version=inventory_item.row_version,
                    change_metadata={
                        "action": "adjust_batches",
                        "client_line_id": create.client_line_id,
                    },
                )
                sequence += 1

            # create_inventory_batch already bumps when creates exist; still ensure one bump
            # when only updates/confirmations ran.
            if not group.creates:
                bump_ingredient_collection(ingredient, user_id=user_id)
            adjusted_count += 1

        if ingredient.id not in touched_ingredient_guards:
            touched_ingredient_guards[ingredient.id] = (ingredient, prepared.ingredient_before_version)

    for prepared in prepared_presence:
        group = prepared.request
        ingredient = prepared.ingredient
        # upsert re-locks; pass current versions after parent lock already held.
        state = upsert_inventory_state(
            db,
            family_id=family_id,
            user_id=user_id,
            ingredient=ingredient,
            expected_ingredient_row_version=ingredient.row_version,
            state_id=group.state_id,
            expected_state_row_version=group.expected_state_row_version,
            availability_level=group.availability_level,
            inventory_status=group.inventory_status,
            purchase_date=group.purchase_date,
            expiry_date=group.expiry_date,
            storage_location=group.storage_location,
            notes=group.notes,
            confirmation_source=InventoryConfirmationSource.RECONCILIATION,
            record_activity=False,
        )
        db.flush()
        change_type = (
            InventoryOperationChangeType.CREATE
            if prepared.state_before_snapshot is None
            else InventoryOperationChangeType.UPDATE
        )
        record_operation_line(
            db,
            operation=operation,
            sequence=sequence,
            entity_type=InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE,
            entity_id=state.id,
            change_type=change_type,
            before_snapshot=prepared.state_before_snapshot,
            after_snapshot=snapshot_inventory_state(state),
            before_row_version=(
                None
                if prepared.state_before_snapshot is None
                else int(prepared.state_before_snapshot["row_version"])
            ),
            after_row_version=state.row_version,
            change_metadata={"action": "presence_update"},
        )
        sequence += 1
        if group.availability_level is InventoryAvailabilityLevel.ABSENT:
            adjusted_count += 1
        elif prepared.state_before_snapshot is None:
            adjusted_count += 1
        else:
            previous_level = prepared.state_before_snapshot.get("availability_level")
            if previous_level != group.availability_level.value:
                adjusted_count += 1
            else:
                confirmed_count += 1
        if ingredient.id not in touched_ingredient_guards:
            touched_ingredient_guards[ingredient.id] = (ingredient, prepared.ingredient_before_version)

    for prepared in prepared_food:
        group = prepared.request
        food = prepared.food
        if group.action == "confirm":
            apply_food_inventory_confirm(
                db,
                family_id=family_id,
                user_id=user_id,
                food=food,
                record_activity=False,
            )
            confirmed_count += 1
        else:
            assert group.stock_quantity is not None
            apply_food_inventory_set_stock(
                db,
                family_id=family_id,
                user_id=user_id,
                food=food,
                stock_quantity=group.stock_quantity,
                stock_unit=group.stock_unit,
                expiry_date=group.expiry_date,
                storage_location=group.storage_location,
                record_activity=False,
            )
            adjusted_count += 1
        db.flush()
        record_operation_line(
            db,
            operation=operation,
            sequence=sequence,
            entity_type=InventoryOperationEntityType.FOOD,
            entity_id=food.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=prepared.food_before_snapshot,
            after_snapshot=snapshot_food_inventory(food),
            before_row_version=int(prepared.food_before_snapshot["row_version"]),
            after_row_version=food.row_version,
            change_metadata={"action": group.action},
        )
        sequence += 1

    for ingredient_id in sorted(touched_ingredient_guards):
        ingredient, before_version = touched_ingredient_guards[ingredient_id]
        record_ingredient_collection_guard(
            db,
            operation=operation,
            sequence=sequence,
            ingredient=ingredient,
            before_row_version=before_version,
            after_row_version=ingredient.row_version,
        )
        sequence += 1

    description = f"确认 {confirmed_count} 项"
    if adjusted_count:
        description = f"{description}，调整 {adjusted_count} 项"
    summary = InventoryOperationDisplaySummary(
        title="完成了一次库存盘点",
        description=description,
        confirmed_count=confirmed_count,
        adjusted_count=adjusted_count,
    )
    operation.summary_json = summary.model_dump(mode="json")
    if operation.applied_at is None:
        operation.applied_at = utcnow()
    if operation.revertible_until is None:
        operation.revertible_until = operation.applied_at + timedelta(minutes=15)
    if operation.status is None:
        operation.status = InventoryOperationStatus.APPLIED

    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="InventoryOperation",
        entity_id=operation.id,
        summary=f"完成了一次库存盘点：{description}",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.INVENTORY,
            summary=f"完成库存盘点并确认 {confirmed_count} 项、修正 {adjusted_count} 项",
        ),
    )
    db.flush()

    revertible_until = _as_aware(operation.revertible_until)
    return InventoryOperationResult(
        operation_id=operation.id,
        operation_type=operation.operation_type,
        status=operation.status,
        applied_at=_as_aware(operation.applied_at) or operation.applied_at,
        revertible_until=revertible_until or operation.revertible_until,
        can_revert=compute_can_revert(
            operation,
            user_id=user_id,
            user_role=user_role,
            now=utcnow(),
        ),
        summary=summary,
    )
