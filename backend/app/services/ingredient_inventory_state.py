from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ActivityAction,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryStatus,
)
from app.core.utils import create_id, utcnow
from app.models.domain import Ingredient, IngredientInventoryState, InventoryItem
from app.schemas.ingredients import (
    ExactTransitionResolution,
    IngredientTrackingModeTransitionRequest,
    PresenceTransitionResolution,
)
from app.services.activity import log_activity
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.inventory_usage import remaining_quantity, tracks_quantity
from app.services.inventory_versions import (
    InventoryConflictError,
    bump_ingredient_collection,
    require_expected_version,
)


PRESENCE_STATE_REQUIRED_CODE = "presence_state_required"
PRESENCE_STATE_REQUIRED_MESSAGE = "不记录数量的食材请使用库存状态接口"
TRACKING_TRANSITION_REQUIRED_CODE = "tracking_transition_required"
TRACKING_TRANSITION_REQUIRED_MESSAGE = "修改数量记录方式请使用专用的跟踪模式切换接口"


class PresenceStateRequiredError(ValueError):
    """Raised when a precise inventory path is used for a presence ingredient."""

    def __init__(self, message: str = PRESENCE_STATE_REQUIRED_MESSAGE) -> None:
        super().__init__(message)
        self.code = PRESENCE_STATE_REQUIRED_CODE
        self.message = message


def presence_state_required_detail(message: str = PRESENCE_STATE_REQUIRED_MESSAGE) -> dict[str, str]:
    return {
        "code": PRESENCE_STATE_REQUIRED_CODE,
        "message": message,
    }


def tracking_transition_required_detail(
    message: str = TRACKING_TRANSITION_REQUIRED_MESSAGE,
) -> dict[str, str]:
    return {
        "code": TRACKING_TRANSITION_REQUIRED_CODE,
        "message": message,
    }


def state_is_physically_present(state: IngredientInventoryState) -> bool:
    return state.availability_level != InventoryAvailabilityLevel.ABSENT


def state_is_usable(state: IngredientInventoryState, *, business_date: date) -> bool:
    if not state_is_physically_present(state):
        return False
    return state.expiry_date is None or state.expiry_date >= business_date


def list_inventory_states(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str] | None = None,
) -> list[IngredientInventoryState]:
    statement = select(IngredientInventoryState).where(IngredientInventoryState.family_id == family_id)
    ids = [item for item in (ingredient_ids or []) if item]
    if ids:
        statement = statement.where(IngredientInventoryState.ingredient_id.in_(list(dict.fromkeys(ids))))
    statement = statement.order_by(
        IngredientInventoryState.updated_at.desc(),
        IngredientInventoryState.ingredient_id.asc(),
    )
    return list(db.scalars(statement))


def load_presence_states_by_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str],
) -> dict[str, IngredientInventoryState]:
    ids = list(dict.fromkeys(item for item in ingredient_ids if item))
    if not ids:
        return {}
    states = list_inventory_states(db, family_id=family_id, ingredient_ids=ids)
    return {state.ingredient_id: state for state in states}


def upsert_inventory_state(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient: Ingredient,
    expected_ingredient_row_version: int,
    state_id: str | None,
    expected_state_row_version: int | None,
    availability_level: InventoryAvailabilityLevel,
    inventory_status: InventoryStatus,
    purchase_date: date | None,
    expiry_date: date | None,
    storage_location: str | None,
    notes: str,
    confirmation_source: InventoryConfirmationSource | None,
    record_activity: bool = False,
) -> IngredientInventoryState:
    if tracks_quantity(ingredient):
        raise ValueError("精确计量食材请使用库存批次接口")

    locked = lock_inventory_targets(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient.id],
        state_ingredient_ids=[ingredient.id] if state_id is not None else (),
    )
    locked_ingredient = locked.ingredients.get(ingredient.id)
    if locked_ingredient is None:
        raise ValueError("食材不存在或不属于当前家庭")
    ingredient = locked_ingredient
    if tracks_quantity(ingredient):
        raise ValueError("精确计量食材请使用库存批次接口")

    require_expected_version(
        ingredient,
        expected_ingredient_row_version,
        entity_type="ingredient",
        entity_id=ingredient.id,
    )

    existing = locked.states_by_ingredient_id.get(ingredient.id)
    if existing is None:
        existing = db.scalar(
            select(IngredientInventoryState).where(
                IngredientInventoryState.family_id == family_id,
                IngredientInventoryState.ingredient_id == ingredient.id,
            )
        )

    if state_id is None:
        if existing is not None:
            raise ValueError("该食材已有库存状态，请携带 state_id 与 expected_state_row_version 更新")
        state = IngredientInventoryState(
            id=create_id("inventory-state"),
            family_id=family_id,
            ingredient_id=ingredient.id,
            availability_level=availability_level,
            inventory_status=inventory_status,
            notes=notes or "",
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(state)
    else:
        if existing is None or existing.id != state_id:
            raise ValueError("库存状态不存在或不属于当前食材")
        if expected_state_row_version is None:
            raise ValueError("更新库存状态时必须提供 expected_state_row_version")
        require_expected_version(
            existing,
            expected_state_row_version,
            entity_type="ingredient_inventory_state",
            entity_id=existing.id,
        )
        state = existing

    previous_expiry = state.expiry_date
    resolved_purchase_date = purchase_date
    resolved_expiry_date = expiry_date
    resolved_storage = storage_location.strip() if storage_location else None

    if availability_level is InventoryAvailabilityLevel.ABSENT:
        resolved_purchase_date = None
        resolved_expiry_date = None
        resolved_storage = None
        state.expiry_alert_snoozed_until = None
        state.expiry_reviewed_at = None
        state.expiry_reviewed_by = None
    else:
        if not resolved_storage:
            resolved_storage = ingredient.default_storage or "常温"
        if resolved_purchase_date is not None and resolved_expiry_date is not None:
            if resolved_expiry_date < resolved_purchase_date:
                raise ValueError("到期日不能早于采购日")
        if previous_expiry != resolved_expiry_date:
            state.expiry_alert_snoozed_until = None
            state.expiry_reviewed_at = None
            state.expiry_reviewed_by = None

    state.availability_level = availability_level
    state.inventory_status = inventory_status
    state.purchase_date = resolved_purchase_date
    state.expiry_date = resolved_expiry_date
    state.storage_location = resolved_storage
    state.notes = notes or ""
    state.updated_by = user_id

    if confirmation_source is not None:
        state.last_confirmed_at = utcnow()
        state.last_confirmed_by = user_id
        state.last_confirmation_source = confirmation_source

    bump_ingredient_collection(ingredient, user_id=user_id)
    db.flush()

    if record_activity:
        if availability_level is InventoryAvailabilityLevel.ABSENT:
            summary = f"确认没有 {ingredient.name}"
        elif availability_level is InventoryAvailabilityLevel.LOW:
            summary = f"确认 {ingredient.name} 余量偏低"
        elif availability_level is InventoryAvailabilityLevel.SUFFICIENT:
            summary = f"确认 {ingredient.name} 充足"
        else:
            summary = f"确认已有 {ingredient.name}"
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE if state_id is not None else ActivityAction.CREATE,
            entity_type="IngredientInventoryState",
            entity_id=state.id,
            summary=summary,
        )
    return state


def _physical_remaining_batches(items: list[InventoryItem]) -> list[InventoryItem]:
    result = [item for item in items if remaining_quantity(item) > 0]
    result.sort(key=lambda item: item.id)
    return result


def _apply_presence_fields(
    state: IngredientInventoryState,
    *,
    ingredient: Ingredient,
    resolution: PresenceTransitionResolution,
    user_id: str,
) -> None:
    previous_expiry = state.expiry_date
    resolved_purchase_date = resolution.purchase_date
    resolved_expiry_date = resolution.expiry_date
    resolved_storage = resolution.storage_location.strip() if resolution.storage_location else None

    if resolution.availability_level is InventoryAvailabilityLevel.ABSENT:
        resolved_purchase_date = None
        resolved_expiry_date = None
        resolved_storage = None
        state.expiry_alert_snoozed_until = None
        state.expiry_reviewed_at = None
        state.expiry_reviewed_by = None
    else:
        if not resolved_storage:
            resolved_storage = ingredient.default_storage or "常温"
        if resolved_purchase_date is not None and resolved_expiry_date is not None:
            if resolved_expiry_date < resolved_purchase_date:
                raise ValueError("到期日不能早于采购日")
        if previous_expiry != resolved_expiry_date:
            state.expiry_alert_snoozed_until = None
            state.expiry_reviewed_at = None
            state.expiry_reviewed_by = None

    state.availability_level = resolution.availability_level
    state.inventory_status = resolution.inventory_status
    state.purchase_date = resolved_purchase_date
    state.expiry_date = resolved_expiry_date
    state.storage_location = resolved_storage
    state.notes = resolution.notes or ""
    state.updated_by = user_id

    if resolution.mark_inventory_confirmed:
        state.last_confirmed_at = utcnow()
        state.last_confirmed_by = user_id
        state.last_confirmation_source = InventoryConfirmationSource.MANUAL_ENTRY


def _clear_state_for_exact_mode(state: IngredientInventoryState, *, user_id: str) -> None:
    state.availability_level = InventoryAvailabilityLevel.ABSENT
    state.inventory_status = InventoryStatus.FRESH
    state.purchase_date = None
    state.expiry_date = None
    state.storage_location = None
    state.notes = ""
    state.expiry_alert_snoozed_until = None
    state.expiry_reviewed_at = None
    state.expiry_reviewed_by = None
    state.updated_by = user_id


def transition_ingredient_tracking_mode(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient_id: str,
    request: IngredientTrackingModeTransitionRequest,
) -> Ingredient:
    """Atomically switch Ingredient quantity tracking mode with explicit inventory resolution.

    Transitions are not recorded in the 15-minute InventoryOperation history.
    """
    if request.target_mode is IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
        return _transition_exact_to_presence(
            db,
            family_id=family_id,
            user_id=user_id,
            ingredient_id=ingredient_id,
            request=request,
        )
    return _transition_presence_to_exact(
        db,
        family_id=family_id,
        user_id=user_id,
        ingredient_id=ingredient_id,
        request=request,
    )


def _transition_exact_to_presence(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient_id: str,
    request: IngredientTrackingModeTransitionRequest,
) -> Ingredient:
    assert request.presence_resolution is not None
    resolution = request.presence_resolution

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=[ingredient_id],
        )
    except InventoryTargetNotFoundError as exc:
        raise InventoryConflictError(
            str(exc),
            code="stale_version",
            conflicts=[
                {
                    "entity_type": "ingredient",
                    "entity_id": ingredient_id,
                    "reason": "missing",
                }
            ],
        ) from exc

    ingredient = locked.ingredients.get(ingredient_id)
    if ingredient is None:
        raise InventoryConflictError(
            "食材不存在或不属于当前家庭",
            code="stale_version",
            conflicts=[
                {
                    "entity_type": "ingredient",
                    "entity_id": ingredient_id,
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
                    "expected_row_version": request.expected_ingredient_row_version,
                    "current_row_version": ingredient.row_version,
                    "reason": "tracking_mode_changed",
                }
            ],
        )

    require_expected_version(
        ingredient,
        request.expected_ingredient_row_version,
        entity_type="ingredient",
        entity_id=ingredient.id,
    )

    all_items = list(
        db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == family_id,
                InventoryItem.ingredient_id == ingredient.id,
            )
            .order_by(InventoryItem.id.asc())
            .with_for_update()
        )
    )
    current_physical = _physical_remaining_batches(all_items)
    current_ids = {item.id for item in current_physical}
    submitted_ids = {batch.inventory_item_id for batch in request.observed_batches}
    if current_ids != submitted_ids:
        raise InventoryConflictError(
            "当前精确库存批次集合已变化，请刷新后重试",
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

    items_by_id = {item.id: item for item in all_items}
    for observed in request.observed_batches:
        item = items_by_id.get(observed.inventory_item_id)
        if item is None:
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

    existing_state = db.scalar(
        select(IngredientInventoryState)
        .where(
            IngredientInventoryState.family_id == family_id,
            IngredientInventoryState.ingredient_id == ingredient.id,
        )
        .with_for_update()
    )
    if existing_state is not None:
        if request.expected_state_row_version is None:
            raise InventoryConflictError(
                "库存状态已变化，请刷新后重试",
                code="stale_version",
                conflicts=[
                    {
                        "entity_type": "ingredient_inventory_state",
                        "entity_id": existing_state.id,
                        "reason": "missing_expected_version",
                        "current_row_version": existing_state.row_version,
                    }
                ],
            )
        require_expected_version(
            existing_state,
            request.expected_state_row_version,
            entity_type="ingredient_inventory_state",
            entity_id=existing_state.id,
        )
        state = existing_state
    else:
        if request.expected_state_row_version is not None:
            raise InventoryConflictError(
                "库存状态不存在，请刷新后重试",
                code="stale_version",
                conflicts=[
                    {
                        "entity_type": "ingredient_inventory_state",
                        "entity_id": ingredient.id,
                        "reason": "missing",
                        "expected_row_version": request.expected_state_row_version,
                    }
                ],
            )
        state = IngredientInventoryState(
            id=create_id("inventory-state"),
            family_id=family_id,
            ingredient_id=ingredient.id,
            availability_level=resolution.availability_level,
            inventory_status=resolution.inventory_status,
            notes=resolution.notes or "",
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(state)

    ingredient.quantity_tracking_mode = IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY
    ingredient.default_low_stock_threshold = None
    _apply_presence_fields(state, ingredient=ingredient, resolution=resolution, user_id=user_id)
    bump_ingredient_collection(ingredient, user_id=user_id)
    db.flush()

    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"将 {ingredient.name} 切换为只记录有无",
    )
    return ingredient


def _transition_presence_to_exact(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient_id: str,
    request: IngredientTrackingModeTransitionRequest,
) -> Ingredient:
    assert request.exact_resolution is not None
    resolution: ExactTransitionResolution = request.exact_resolution

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=[ingredient_id],
        )
    except InventoryTargetNotFoundError as exc:
        raise InventoryConflictError(
            str(exc),
            code="stale_version",
            conflicts=[
                {
                    "entity_type": "ingredient",
                    "entity_id": ingredient_id,
                    "reason": "missing",
                }
            ],
        ) from exc

    ingredient = locked.ingredients.get(ingredient_id)
    if ingredient is None:
        raise InventoryConflictError(
            "食材不存在或不属于当前家庭",
            code="stale_version",
            conflicts=[
                {
                    "entity_type": "ingredient",
                    "entity_id": ingredient_id,
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
                    "expected_row_version": request.expected_ingredient_row_version,
                    "current_row_version": ingredient.row_version,
                    "reason": "tracking_mode_changed",
                }
            ],
        )

    require_expected_version(
        ingredient,
        request.expected_ingredient_row_version,
        entity_type="ingredient",
        entity_id=ingredient.id,
    )

    existing_state = db.scalar(
        select(IngredientInventoryState)
        .where(
            IngredientInventoryState.family_id == family_id,
            IngredientInventoryState.ingredient_id == ingredient.id,
        )
        .with_for_update()
    )
    if existing_state is not None:
        if request.expected_state_row_version is None:
            raise InventoryConflictError(
                "库存状态已变化，请刷新后重试",
                code="stale_version",
                conflicts=[
                    {
                        "entity_type": "ingredient_inventory_state",
                        "entity_id": existing_state.id,
                        "reason": "missing_expected_version",
                        "current_row_version": existing_state.row_version,
                    }
                ],
            )
        require_expected_version(
            existing_state,
            request.expected_state_row_version,
            entity_type="ingredient_inventory_state",
            entity_id=existing_state.id,
        )
    elif request.expected_state_row_version is not None:
        raise InventoryConflictError(
            "库存状态不存在，请刷新后重试",
            code="stale_version",
            conflicts=[
                {
                    "entity_type": "ingredient_inventory_state",
                    "entity_id": ingredient.id,
                    "reason": "missing",
                    "expected_row_version": request.expected_state_row_version,
                }
            ],
        )

    ingredient.quantity_tracking_mode = IngredientQuantityTrackingMode.TRACK_QUANTITY

    if not resolution.confirm_absent:
        from app.services.inventory_operations import create_inventory_batch

        assert resolution.quantity is not None
        assert resolution.unit is not None
        assert resolution.inventory_status is not None
        assert resolution.purchase_date is not None
        assert resolution.storage_location is not None
        create_inventory_batch(
            db,
            family_id=family_id,
            user_id=user_id,
            ingredient=ingredient,
            quantity=Decimal(resolution.quantity),
            unit=resolution.unit,
            status=resolution.inventory_status,
            purchase_date=resolution.purchase_date,
            expiry_date=resolution.expiry_date,
            storage_location=resolution.storage_location,
            notes=resolution.notes or "",
            record_activity=False,
            already_locked=True,
        )
    else:
        bump_ingredient_collection(ingredient, user_id=user_id)

    if existing_state is not None:
        _clear_state_for_exact_mode(existing_state, user_id=user_id)

    db.flush()
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"将 {ingredient.name} 切换为记录数量",
    )
    return ingredient
