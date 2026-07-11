from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ActivityAction,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryStatus,
)
from app.core.utils import create_id, utcnow
from app.models.domain import Ingredient, IngredientInventoryState
from app.services.activity import log_activity
from app.services.inventory_operation_locking import lock_inventory_targets
from app.services.inventory_usage import tracks_quantity
from app.services.inventory_versions import bump_ingredient_collection, require_expected_version


PRESENCE_STATE_REQUIRED_CODE = "presence_state_required"
PRESENCE_STATE_REQUIRED_MESSAGE = "不记录数量的食材请使用库存状态接口"


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
