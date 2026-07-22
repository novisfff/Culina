from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import (
    ActivityAction,
    ActivityHighlightKind,
    FoodType,
    IngredientExpiryMode,
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
    InventoryOperation,
    ShoppingListItem,
)
from app.repos.inventory_operations import claim_inventory_operation
from app.schemas.inventory_intake import (
    InventoryIntakeItemRequest,
    InventoryIntakeItemResult,
    InventoryIntakeRequest,
    InventoryIntakeResult,
)
from app.schemas.inventory_operations import InventoryOperationDisplaySummary
from app.services.activity import ActivityHighlight, log_activity
from app.services.food_stock import apply_food_stock_intake
from app.services.food_stock_quantity import validate_food_stock_quantity_precision
from app.services.ingredient_inventory_state import upsert_inventory_state
from app.services.ingredient_units import (
    UnitConversionError,
    convert_quantity_from_default_unit,
    convert_quantity_to_default_unit,
    normalize_unit_label,
)
from app.services.inventory_operation_history import (
    canonical_request_hash,
    compute_can_revert,
    record_ingredient_collection_guard,
    record_operation_line,
    snapshot_food_inventory,
    snapshot_inventory_item,
    snapshot_inventory_state,
    snapshot_shopping_item,
)
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.inventory_operations import create_inventory_batch
from app.services.inventory_overview import is_ready_like_food
from app.services.inventory_usage import tracks_quantity
from app.services.inventory_versions import InventoryConflictError, require_expected_version


def _as_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


READY_LIKE_FOOD_TYPES = {
    FoodType.READY_MADE.value,
    FoodType.INSTANT.value,
    FoodType.PACKAGED.value,
}


class InventoryIntakeValidationError(ValueError):
    """Structured 422 validation error for generalized inventory intake."""

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


def validation_detail(error: InventoryIntakeValidationError) -> dict[str, Any]:
    return {
        "code": error.code,
        "message": error.message,
        "conflicts": error.conflicts,
        "field_errors": error.field_errors,
    }


def _field_error(
    *,
    line_id: str | None,
    shopping_item_id: str | None,
    field: str,
    code: str,
    message: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "field": field,
        "code": code,
        "message": message,
    }
    if line_id is not None:
        payload["line_id"] = line_id
    if shopping_item_id is not None:
        payload["shopping_item_id"] = shopping_item_id
    return payload


def _raise_validation(
    message: str,
    *,
    code: str,
    line_id: str | None = None,
    shopping_item_id: str | None = None,
    field: str = "items",
) -> None:
    raise InventoryIntakeValidationError(
        message,
        code=code,
        field_errors=[
            _field_error(
                line_id=line_id,
                shopping_item_id=shopping_item_id,
                field=field,
                code=code,
                message=message,
            )
        ],
    )


def convert_actual_to_planned_unit(
    *,
    ingredient: Ingredient,
    actual_quantity: Decimal,
    actual_unit: str,
    planned_unit: str,
) -> Decimal:
    try:
        actual_in_default = convert_quantity_to_default_unit(
            actual_quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            actual_unit,
        )
        return convert_quantity_from_default_unit(
            actual_in_default,
            ingredient.default_unit,
            ingredient.unit_conversions,
            planned_unit,
        )
    except UnitConversionError as exc:
        raise InventoryIntakeValidationError(
            str(exc) or "单位无法换算",
            code="incompatible_unit",
            field_errors=[
                _field_error(
                    line_id=None,
                    shopping_item_id=None,
                    field="unit",
                    code="incompatible_unit",
                    message=str(exc) or "单位无法换算",
                )
            ],
        ) from exc


def _serialize_item_result(metadata: dict[str, Any]) -> InventoryIntakeItemResult:
    remaining = metadata.get("remaining_planned_quantity")
    remaining_decimal: Decimal | None
    if remaining is None:
        remaining_decimal = None
    elif isinstance(remaining, Decimal):
        remaining_decimal = remaining
    else:
        remaining_decimal = Decimal(str(remaining))
    return InventoryIntakeItemResult(
        line_id=str(metadata["line_id"]),
        source_kind=metadata["source_kind"],
        shopping_item_id=metadata.get("shopping_item_id"),
        result=metadata["result"],
        remaining_planned_quantity=remaining_decimal,
        inventory_item_id=metadata.get("inventory_item_id"),
        state_id=metadata.get("state_id"),
        food_id=metadata.get("food_id"),
    )


def _load_operation_with_lines(db: Session, operation_id: str) -> InventoryOperation:
    operation = db.scalar(
        select(InventoryOperation)
        .where(InventoryOperation.id == operation_id)
        .options(selectinload(InventoryOperation.lines))
    )
    if operation is None:
        raise ValueError("库存操作不存在")
    return operation


def _result_from_operation(
    operation: InventoryOperation,
    *,
    user_id: str,
    user_role: UserRole,
) -> InventoryIntakeResult:
    item_results: list[InventoryIntakeItemResult] = []
    for line in sorted(operation.lines, key=lambda item: item.sequence):
        metadata = line.change_metadata or {}
        if "result" not in metadata or "line_id" not in metadata or "source_kind" not in metadata:
            continue
        item_results.append(_serialize_item_result(metadata))

    summary_data = operation.summary_json or {}
    summary = InventoryOperationDisplaySummary(
        title=str(summary_data.get("title") or "登记本次购买"),
        description=str(summary_data.get("description") or ""),
        confirmed_count=int(summary_data.get("confirmed_count") or 0),
        adjusted_count=int(summary_data.get("adjusted_count") or 0),
        completed_count=int(summary_data.get("completed_count") or 0),
        partial_count=int(summary_data.get("partial_count") or 0),
    )
    return InventoryIntakeResult(
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
        items=item_results,
    )


@dataclass(slots=True)
class _PreparedIntakeItem:
    request_item: InventoryIntakeItemRequest
    shopping: ShoppingListItem | None = None
    ingredient: Ingredient | None = None
    food: Food | None = None
    state: IngredientInventoryState | None = None
    shopping_before_snapshot: dict[str, object] | None = None
    ingredient_before_version: int | None = None
    food_before_snapshot: dict[str, object] | None = None
    state_before_snapshot: dict[str, object] | None = None
    is_free_text_shopping: bool = False


def _resolve_target_ids(
    request: InventoryIntakeRequest,
) -> tuple[list[str], list[str], list[str], list[str], list[str]]:
    shopping_ids: list[str] = []
    ingredient_ids: list[str] = []
    food_ids: list[str] = []
    state_ingredient_ids: list[str] = []
    optional_state_ingredient_ids: list[str] = []
    for item in request.items:
        if item.shopping_item_id is not None:
            shopping_ids.append(item.shopping_item_id)
        if item.target_kind == "exact_ingredient" and item.target_id is not None:
            ingredient_ids.append(item.target_id)
        elif item.target_kind == "presence_ingredient" and item.target_id is not None:
            ingredient_ids.append(item.target_id)
            if item.state_id is not None:
                state_ingredient_ids.append(item.target_id)
            else:
                optional_state_ingredient_ids.append(item.target_id)
        elif item.target_kind == "food" and item.target_id is not None:
            food_ids.append(item.target_id)
    return (
        shopping_ids,
        ingredient_ids,
        food_ids,
        state_ingredient_ids,
        optional_state_ingredient_ids,
    )


def _ensure_manual_expiry(
    *,
    ingredient: Ingredient,
    expiry_date: date | None,
    line_id: str,
    shopping_item_id: str | None,
) -> None:
    if ingredient.default_expiry_mode is IngredientExpiryMode.MANUAL_DATE and expiry_date is None:
        _raise_validation(
            "该食材需要手动填写到期日",
            code="manual_expiry_required",
            line_id=line_id,
            shopping_item_id=shopping_item_id,
            field="expiry_date",
        )


def _bind_free_text_to_ingredient(shopping: ShoppingListItem, ingredient: Ingredient) -> None:
    shopping.ingredient_id = ingredient.id
    shopping.food_id = None
    shopping.title = ingredient.name
    shopping.quantity_mode = ingredient.quantity_tracking_mode
    if shopping.quantity_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
        shopping.display_label = shopping.display_label or "需要补充"
        shopping.quantity = shopping.quantity or Decimal("1")
        shopping.unit = shopping.unit or ingredient.default_unit or "份"
    else:
        shopping.display_label = None
        shopping.unit = shopping.unit or ingredient.default_unit


def _bind_free_text_to_food(shopping: ShoppingListItem, food: Food) -> None:
    shopping.food_id = food.id
    shopping.ingredient_id = None
    shopping.title = food.name
    shopping.quantity_mode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    shopping.display_label = None
    shopping.unit = shopping.unit or food.stock_unit or "份"


def _result_metadata(
    *,
    line_id: str,
    source_kind: str,
    shopping_item_id: str | None,
    result: str,
    remaining_planned_quantity: Decimal | None = None,
    inventory_item_id: str | None = None,
    state_id: str | None = None,
    food_id: str | None = None,
) -> dict[str, Any]:
    return {
        "line_id": line_id,
        "source_kind": source_kind,
        "shopping_item_id": shopping_item_id,
        "result": result,
        "remaining_planned_quantity": (
            str(remaining_planned_quantity) if isinstance(remaining_planned_quantity, Decimal) else None
        ),
        "inventory_item_id": inventory_item_id,
        "state_id": state_id,
        "food_id": food_id,
    }


def _line_identity_metadata(*, line_id: str, source_kind: str) -> dict[str, Any]:
    return {
        "line_id": line_id,
        "source_kind": source_kind,
    }


def apply_inventory_intake(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: InventoryIntakeRequest,
    business_date: date,
    user_role: UserRole = UserRole.MEMBER,
) -> InventoryIntakeResult:
    """Validate and mutate one complete intake operation; never commit."""
    del business_date  # intake_date comes from the request; business_date reserved for callers

    shopping_ids = [item.shopping_item_id for item in request.items if item.shopping_item_id is not None]
    if len(shopping_ids) != len(set(shopping_ids)):
        _raise_validation("请求中包含重复的采购项", code="duplicate_request_item", field="items")

    request_hash = canonical_request_hash(request)
    provisional_summary = InventoryOperationDisplaySummary(
        title="登记本次购买",
        description="处理中",
    )
    operation, created = claim_inventory_operation(
        db,
        family_id=family_id,
        actor_id=user_id,
        operation_type=InventoryOperationType.SHOPPING_INTAKE,
        client_request_id=request.client_request_id,
        request_hash=request_hash,
        summary=provisional_summary,
    )
    if not created:
        existing = _load_operation_with_lines(db, operation.id)
        return _result_from_operation(
            existing,
            user_id=user_id,
            user_role=user_role,
        )

    (
        shopping_ids,
        ingredient_ids,
        food_ids,
        state_ingredient_ids,
        optional_state_ingredient_ids,
    ) = _resolve_target_ids(request)

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            food_ids=food_ids,
            state_ingredient_ids=state_ingredient_ids,
            optional_state_ingredient_ids=optional_state_ingredient_ids,
            shopping_item_ids=shopping_ids,
        )
    except InventoryTargetNotFoundError as exc:
        raise InventoryIntakeValidationError(
            str(exc),
            code="invalid_target",
            field_errors=[
                _field_error(
                    line_id=None,
                    shopping_item_id=None,
                    field="items",
                    code="invalid_target",
                    message=str(exc),
                )
            ],
        ) from exc

    prepared: list[_PreparedIntakeItem] = []
    seen_food_targets: dict[str, str] = {}
    seen_presence_targets: dict[str, str] = {}

    for item in request.items:
        shopping: ShoppingListItem | None = None
        is_free_text = False
        shopping_before_snapshot: dict[str, object] | None = None

        if item.source_kind == "shopping_item":
            assert item.shopping_item_id is not None
            assert item.expected_shopping_item_row_version is not None
            shopping = locked.shopping_items.get(item.shopping_item_id)
            if shopping is None:
                _raise_validation(
                    "采购项不存在或不属于当前家庭",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="shopping_item_id",
                )
            assert shopping is not None
            require_expected_version(
                shopping,
                item.expected_shopping_item_row_version,
                entity_type="shopping_list_item",
                entity_id=shopping.id,
            )
            if shopping.done:
                raise InventoryConflictError(
                    "采购项已被其他成员完成，请刷新后重试",
                    code="stale_version",
                    conflicts=[
                        {
                            "entity_type": "shopping_list_item",
                            "entity_id": shopping.id,
                            "expected_row_version": item.expected_shopping_item_row_version,
                            "current_row_version": shopping.row_version,
                            "reason": "already_completed",
                        }
                    ],
                )
            is_free_text = shopping.ingredient_id is None and shopping.food_id is None
            shopping_before_snapshot = snapshot_shopping_item(shopping)

        prepared_item = _PreparedIntakeItem(
            request_item=item,
            shopping=shopping,
            is_free_text_shopping=is_free_text,
            shopping_before_snapshot=shopping_before_snapshot,
        )

        if item.action == "fulfill_without_stock":
            prepared.append(prepared_item)
            continue

        if item.target_kind == "exact_ingredient":
            assert item.target_id is not None
            assert item.actual_quantity is not None
            assert item.unit is not None
            assert item.inventory_status is not None
            assert item.expected_ingredient_row_version is not None
            ingredient = locked.ingredients.get(item.target_id)
            if ingredient is None:
                _raise_validation(
                    "食材不存在或不属于当前家庭",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            assert ingredient is not None
            if not tracks_quantity(ingredient):
                _raise_validation(
                    "精确采购目标必须是计量食材",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_kind",
                )
            if (
                item.source_kind == "shopping_item"
                and shopping is not None
                and not is_free_text
                and shopping.ingredient_id != ingredient.id
            ):
                _raise_validation(
                    "采购项目标与提交目标不一致",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            require_expected_version(
                ingredient,
                item.expected_ingredient_row_version,
                entity_type="ingredient",
                entity_id=ingredient.id,
            )
            _ensure_manual_expiry(
                ingredient=ingredient,
                expiry_date=item.expiry_date,
                line_id=item.line_id,
                shopping_item_id=item.shopping_item_id,
            )
            if item.expiry_date is not None and item.expiry_date < request.intake_date:
                _raise_validation(
                    "到期日不能早于采购日",
                    code="invalid_date_range",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="expiry_date",
                )
            planned_unit = ingredient.default_unit
            if shopping is not None:
                planned_unit = shopping.unit or ingredient.default_unit
            try:
                convert_actual_to_planned_unit(
                    ingredient=ingredient,
                    actual_quantity=item.actual_quantity,
                    actual_unit=item.unit,
                    planned_unit=planned_unit,
                )
            except InventoryIntakeValidationError as exc:
                if not exc.field_errors:
                    raise
                for field_error in exc.field_errors:
                    field_error["line_id"] = item.line_id
                    if item.shopping_item_id is not None:
                        field_error["shopping_item_id"] = item.shopping_item_id
                raise
            prepared_item.ingredient = ingredient
            prepared_item.ingredient_before_version = ingredient.row_version

        elif item.target_kind == "presence_ingredient":
            assert item.target_id is not None
            assert item.expected_ingredient_row_version is not None
            assert item.resulting_availability_level is not None
            assert item.inventory_status is not None
            ingredient = locked.ingredients.get(item.target_id)
            if ingredient is None:
                _raise_validation(
                    "食材不存在或不属于当前家庭",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            assert ingredient is not None
            if tracks_quantity(ingredient):
                _raise_validation(
                    "非精确采购目标必须是不计量食材",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_kind",
                )
            if (
                item.source_kind == "shopping_item"
                and shopping is not None
                and not is_free_text
                and shopping.ingredient_id != ingredient.id
            ):
                _raise_validation(
                    "采购项目标与提交目标不一致",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            prior_presence = seen_presence_targets.get(ingredient.id)
            if prior_presence is not None:
                _raise_validation(
                    "请求中包含重复的非精确食材目标",
                    code="duplicate_request_item",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            seen_presence_targets[ingredient.id] = item.line_id
            require_expected_version(
                ingredient,
                item.expected_ingredient_row_version,
                entity_type="ingredient",
                entity_id=ingredient.id,
            )
            if item.resulting_availability_level is InventoryAvailabilityLevel.ABSENT:
                _raise_validation(
                    "采购入库不能将食材标记为没有",
                    code="invalid_availability_level",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="resulting_availability_level",
                )
            _ensure_manual_expiry(
                ingredient=ingredient,
                expiry_date=item.expiry_date,
                line_id=item.line_id,
                shopping_item_id=item.shopping_item_id,
            )
            if item.expiry_date is not None and item.expiry_date < request.intake_date:
                _raise_validation(
                    "到期日不能早于采购日",
                    code="invalid_date_range",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="expiry_date",
                )
            state = locked.states_by_ingredient_id.get(ingredient.id)
            if item.state_id is not None:
                if state is None or state.id != item.state_id:
                    _raise_validation(
                        "库存状态不存在或不属于当前食材",
                        code="invalid_target",
                        line_id=item.line_id,
                        shopping_item_id=item.shopping_item_id,
                        field="state_id",
                    )
                assert state is not None
                if item.expected_state_row_version is None:
                    _raise_validation(
                        "更新库存状态时必须提供 expected_state_row_version",
                        code="invalid_target",
                        line_id=item.line_id,
                        shopping_item_id=item.shopping_item_id,
                        field="expected_state_row_version",
                    )
                require_expected_version(
                    state,
                    item.expected_state_row_version,
                    entity_type="ingredient_inventory_state",
                    entity_id=state.id,
                )
            prepared_item.ingredient = ingredient
            prepared_item.state = state
            prepared_item.ingredient_before_version = ingredient.row_version
            if state is not None:
                prepared_item.state_before_snapshot = snapshot_inventory_state(state)

        elif item.target_kind == "food":
            assert item.target_id is not None
            assert item.actual_quantity is not None
            assert item.unit is not None
            assert item.expected_food_row_version is not None
            food = locked.foods.get(item.target_id)
            if food is None:
                _raise_validation(
                    "食物不存在或不属于当前家庭",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            assert food is not None
            if not is_ready_like_food(food) or food.type not in READY_LIKE_FOOD_TYPES:
                _raise_validation(
                    "只有成品、速食或包装食品可以采购入库",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            if (
                item.source_kind == "shopping_item"
                and shopping is not None
                and not is_free_text
                and shopping.food_id != food.id
            ):
                _raise_validation(
                    "采购项目标与提交目标不一致",
                    code="invalid_target",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            prior_food = seen_food_targets.get(food.id)
            if prior_food is not None:
                _raise_validation(
                    "请求中包含重复的食物目标",
                    code="duplicate_request_item",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="target_id",
                )
            seen_food_targets[food.id] = item.line_id
            require_expected_version(
                food,
                item.expected_food_row_version,
                entity_type="food",
                entity_id=food.id,
            )
            if item.expiry_date is not None and item.expiry_date < request.intake_date:
                _raise_validation(
                    "到期日不能早于采购日",
                    code="invalid_date_range",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="expiry_date",
                )
            actual_unit = normalize_unit_label(item.unit) or normalize_unit_label(food.stock_unit) or "份"
            if item.source_kind == "shopping_item" and shopping is not None:
                planned_unit = normalize_unit_label(shopping.unit) or normalize_unit_label(food.stock_unit) or "份"
                if actual_unit != planned_unit:
                    _raise_validation(
                        "采购计划单位与实际入库单位不一致",
                        code="incompatible_unit",
                        line_id=item.line_id,
                        shopping_item_id=item.shopping_item_id,
                        field="unit",
                    )
            current_stock_unit = normalize_unit_label(food.stock_unit)
            if (
                current_stock_unit
                and Decimal(str(food.stock_quantity or 0)) > 0
                and actual_unit != current_stock_unit
            ):
                _raise_validation(
                    f"当前食物库存单位是 {current_stock_unit}，不能按 {actual_unit} 入库",
                    code="incompatible_unit",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="unit",
                )
            try:
                validate_food_stock_quantity_precision(item.actual_quantity)
            except ValueError as exc:
                _raise_validation(
                    str(exc),
                    code="invalid_quantity",
                    line_id=item.line_id,
                    shopping_item_id=item.shopping_item_id,
                    field="actual_quantity",
                )
            prepared_item.food = food
            prepared_item.food_before_snapshot = snapshot_food_inventory(food)
        else:
            _raise_validation(
                "不支持的入库动作",
                code="invalid_target",
                line_id=item.line_id,
                shopping_item_id=item.shopping_item_id,
            )

        prepared.append(prepared_item)

    item_results: list[InventoryIntakeItemResult] = []
    sequence = 1
    touched_ingredient_guards: dict[str, tuple[Ingredient, int]] = {}

    for prepared_item in prepared:
        item = prepared_item.request_item
        shopping = prepared_item.shopping
        result_label = "completed"
        remaining_value: Decimal | None = None
        inventory_item_id: str | None = None
        state_id: str | None = None
        food_id: str | None = None

        if item.target_kind == "exact_ingredient":
            ingredient = prepared_item.ingredient
            assert ingredient is not None
            assert item.actual_quantity is not None
            assert item.unit is not None
            assert item.inventory_status is not None

            planned_unit = ingredient.default_unit
            planned_quantity = Decimal("0")
            if shopping is not None:
                planned_unit = normalize_unit_label(shopping.unit) or ingredient.default_unit
                planned_quantity = Decimal(str(shopping.quantity or 0))

            inventory_item = create_inventory_batch(
                db,
                family_id=family_id,
                user_id=user_id,
                ingredient=ingredient,
                quantity=item.actual_quantity,
                unit=item.unit,
                status=item.inventory_status,
                purchase_date=request.intake_date,
                expiry_date=item.expiry_date,
                storage_location=item.storage_location or "",
                notes=item.notes,
                record_activity=False,
                already_locked=True,
            )
            inventory_item_id = inventory_item.id

            if item.source_kind == "shopping_item":
                assert shopping is not None
                actual_in_planned = convert_actual_to_planned_unit(
                    ingredient=ingredient,
                    actual_quantity=item.actual_quantity,
                    actual_unit=item.unit,
                    planned_unit=planned_unit,
                )
                if actual_in_planned < planned_quantity:
                    remaining_value = planned_quantity - actual_in_planned
                    shopping.quantity = remaining_value
                    shopping.done = False
                    result_label = "partial"
                else:
                    shopping.done = True
                    result_label = "completed"
                    remaining_value = None

                if prepared_item.is_free_text_shopping:
                    _bind_free_text_to_ingredient(shopping, ingredient)
                    if result_label == "completed":
                        shopping.unit = normalize_unit_label(item.unit) or ingredient.default_unit
                    else:
                        shopping.unit = planned_unit
                shopping.updated_by = user_id
            else:
                result_label = "direct_stocked"

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
                change_metadata=(
                    _result_metadata(
                        line_id=item.line_id,
                        source_kind=item.source_kind,
                        shopping_item_id=item.shopping_item_id,
                        result=result_label,
                        remaining_planned_quantity=remaining_value,
                        inventory_item_id=inventory_item_id,
                    )
                    if item.source_kind == "direct"
                    else _line_identity_metadata(line_id=item.line_id, source_kind=item.source_kind)
                ),
            )
            sequence += 1
            if (
                prepared_item.ingredient_before_version is not None
                and ingredient.id not in touched_ingredient_guards
            ):
                touched_ingredient_guards[ingredient.id] = (ingredient, prepared_item.ingredient_before_version)

        elif item.target_kind == "presence_ingredient":
            ingredient = prepared_item.ingredient
            assert ingredient is not None
            assert item.resulting_availability_level is not None
            assert item.inventory_status is not None
            if prepared_item.is_free_text_shopping and shopping is not None:
                _bind_free_text_to_ingredient(shopping, ingredient)

            state = upsert_inventory_state(
                db,
                family_id=family_id,
                user_id=user_id,
                ingredient=ingredient,
                expected_ingredient_row_version=ingredient.row_version,
                state_id=item.state_id,
                expected_state_row_version=item.expected_state_row_version,
                availability_level=item.resulting_availability_level,
                inventory_status=item.inventory_status,
                purchase_date=request.intake_date,
                expiry_date=item.expiry_date,
                storage_location=item.storage_location,
                notes=item.notes,
                confirmation_source=InventoryConfirmationSource.SHOPPING_INTAKE,
                record_activity=False,
            )
            state_id = state.id
            if item.source_kind == "shopping_item":
                assert shopping is not None
                shopping.done = True
                shopping.updated_by = user_id
                result_label = "stocked"
            else:
                result_label = "direct_stocked"

            db.flush()
            change_type = (
                InventoryOperationChangeType.CREATE
                if prepared_item.state_before_snapshot is None
                else InventoryOperationChangeType.UPDATE
            )
            record_operation_line(
                db,
                operation=operation,
                sequence=sequence,
                entity_type=InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE,
                entity_id=state.id,
                change_type=change_type,
                before_snapshot=prepared_item.state_before_snapshot,
                after_snapshot=snapshot_inventory_state(state),
                before_row_version=(
                    None
                    if prepared_item.state_before_snapshot is None
                    else int(prepared_item.state_before_snapshot["row_version"])
                ),
                after_row_version=state.row_version,
                change_metadata=(
                    _result_metadata(
                        line_id=item.line_id,
                        source_kind=item.source_kind,
                        shopping_item_id=item.shopping_item_id,
                        result=result_label,
                        state_id=state_id,
                    )
                    if item.source_kind == "direct"
                    else _line_identity_metadata(line_id=item.line_id, source_kind=item.source_kind)
                ),
            )
            sequence += 1
            if (
                prepared_item.ingredient_before_version is not None
                and ingredient.id not in touched_ingredient_guards
            ):
                touched_ingredient_guards[ingredient.id] = (ingredient, prepared_item.ingredient_before_version)

        elif item.target_kind == "food":
            food = prepared_item.food
            assert food is not None
            assert item.actual_quantity is not None
            assert item.unit is not None
            planned_quantity = Decimal("0")
            if shopping is not None:
                planned_quantity = Decimal(str(shopping.quantity or 0))
                if prepared_item.is_free_text_shopping:
                    _bind_free_text_to_food(shopping, food)

            apply_food_stock_intake(
                db,
                family_id=family_id,
                user_id=user_id,
                food=food,
                quantity=item.actual_quantity,
                unit=item.unit,
                expiry_date=item.expiry_date,
                storage_location=item.storage_location or "",
                note="",
                record_activity=False,
            )
            food_id = food.id
            if item.source_kind == "shopping_item":
                assert shopping is not None
                if item.actual_quantity < planned_quantity:
                    remaining_value = planned_quantity - item.actual_quantity
                    shopping.quantity = remaining_value
                    shopping.done = False
                    result_label = "partial"
                else:
                    shopping.done = True
                    result_label = "stocked"
                    remaining_value = None
                shopping.updated_by = user_id
            else:
                result_label = "direct_stocked"

            db.flush()
            record_operation_line(
                db,
                operation=operation,
                sequence=sequence,
                entity_type=InventoryOperationEntityType.FOOD,
                entity_id=food.id,
                change_type=InventoryOperationChangeType.UPDATE,
                before_snapshot=prepared_item.food_before_snapshot,
                after_snapshot=snapshot_food_inventory(food),
                before_row_version=(
                    None
                    if prepared_item.food_before_snapshot is None
                    else int(prepared_item.food_before_snapshot["row_version"])
                ),
                after_row_version=food.row_version,
                change_metadata=(
                    _result_metadata(
                        line_id=item.line_id,
                        source_kind=item.source_kind,
                        shopping_item_id=item.shopping_item_id,
                        result=result_label,
                        remaining_planned_quantity=remaining_value,
                        food_id=food_id,
                    )
                    if item.source_kind == "direct"
                    else _line_identity_metadata(line_id=item.line_id, source_kind=item.source_kind)
                ),
            )
            sequence += 1

        elif item.action == "fulfill_without_stock":
            assert shopping is not None
            shopping.done = True
            shopping.updated_by = user_id
            result_label = "completed_without_inventory"

        if item.source_kind == "shopping_item":
            assert shopping is not None
            db.flush()
            change_metadata = _result_metadata(
                line_id=item.line_id,
                source_kind=item.source_kind,
                shopping_item_id=shopping.id,
                result=result_label,
                remaining_planned_quantity=remaining_value,
                inventory_item_id=inventory_item_id,
                state_id=state_id,
                food_id=food_id,
            )
            record_operation_line(
                db,
                operation=operation,
                sequence=sequence,
                entity_type=InventoryOperationEntityType.SHOPPING_LIST_ITEM,
                entity_id=shopping.id,
                change_type=InventoryOperationChangeType.UPDATE,
                before_snapshot=prepared_item.shopping_before_snapshot,
                after_snapshot=snapshot_shopping_item(shopping),
                before_row_version=(
                    None
                    if prepared_item.shopping_before_snapshot is None
                    else int(prepared_item.shopping_before_snapshot["row_version"])
                ),
                after_row_version=shopping.row_version,
                change_metadata=change_metadata,
            )
            sequence += 1

        item_results.append(
            InventoryIntakeItemResult(
                line_id=item.line_id,
                source_kind=item.source_kind,
                shopping_item_id=item.shopping_item_id,
                result=result_label,  # pyright: ignore[reportArgumentType]
                remaining_planned_quantity=remaining_value,
                inventory_item_id=inventory_item_id,
                state_id=state_id,
                food_id=food_id,
            )
        )

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

    full_completed = sum(
        1
        for item in item_results
        if item.result in {"completed", "stocked", "completed_without_inventory", "direct_stocked"}
    )
    partial_only = sum(1 for item in item_results if item.result == "partial")
    description = f"完成 {full_completed} 项"
    if partial_only:
        description = f"{description}，部分买到 {partial_only} 项"
    summary = InventoryOperationDisplaySummary(
        title="登记本次购买",
        description=description,
        completed_count=full_completed,
        partial_count=partial_only,
        confirmed_count=full_completed,
        adjusted_count=partial_only,
    )
    operation.summary_json = summary.model_dump(mode="json")
    if operation.applied_at is None:
        operation.applied_at = utcnow()
    if operation.revertible_until is None:
        operation.revertible_until = operation.applied_at + timedelta(minutes=15)
    if operation.status is None:
        operation.status = InventoryOperationStatus.APPLIED

    highlight_count = full_completed + partial_only
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="InventoryOperation",
        entity_id=operation.id,
        summary=f"登记了本次购买：{description}",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.SHOPPING,
            summary=f"完成 {highlight_count} 项采购入库",
        ),
    )
    db.flush()

    revertible_until = _as_aware(operation.revertible_until)
    return InventoryIntakeResult(
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
        items=item_results,
    )
