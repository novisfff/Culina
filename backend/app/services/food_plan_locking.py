from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import Food, FoodPlanItem
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets

FoodPlanAction = Literal["create", "update", "delete", "set_status"]


@dataclass(frozen=True, slots=True)
class FoodPlanWriteIntent:
    action: FoodPlanAction
    item_id: str | None
    target_food_id: str | None
    base_updated_at: datetime | None
    current_food_id: str | None = None


@dataclass(frozen=True, slots=True)
class LockedFoodPlanTargets:
    foods_by_id: dict[str, Food]
    items_by_id: dict[str, FoodPlanItem]


class FoodPlanConflict(ValueError):
    def __init__(self, code: str, message: str, *, meal_log_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.meal_log_id = meal_log_id


def food_plan_conflict_detail(exc: FoodPlanConflict) -> dict[str, str | None]:
    detail: dict[str, str | None] = {
        "code": exc.code,
        "message": exc.message,
    }
    if exc.meal_log_id is not None:
        detail["meal_log_id"] = exc.meal_log_id
    return detail


def _unique_sorted_ids(ids: Sequence[str | None]) -> list[str]:
    return sorted({item_id for item_id in ids if item_id})


def _normalize_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _parse_base_updated_at(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _normalize_datetime(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return _normalize_datetime(text)
    except ValueError as exc:
        raise FoodPlanConflict(
            "food_plan_base_updated_at_invalid",
            "baseUpdatedAt 格式不正确",
        ) from exc


def _assert_base_updated_at_matches(
    *,
    actual: datetime | None,
    expected: datetime | None,
    label: str,
) -> None:
    if expected is None:
        return
    actual_dt = _normalize_datetime(actual)
    expected_dt = _normalize_datetime(expected)
    if actual_dt is None or expected_dt is None or actual_dt != expected_dt:
        raise FoodPlanConflict(
            "food_plan_item_stale",
            f"{label}已被其他修改更新，请刷新后重试",
        )


def _operation_action(operation: Mapping[str, Any]) -> FoodPlanAction:
    action = str(operation.get("action") or "").strip()
    if action not in {"create", "update", "delete", "set_status"}:
        raise FoodPlanConflict("food_plan_action_invalid", f"不支持的菜单计划操作：{action or 'unknown'}")
    return action  # type: ignore[return-value]


def _operation_target_food_id(operation: Mapping[str, Any], *, action: FoodPlanAction) -> str | None:
    payload = operation.get("payload") or {}
    if not isinstance(payload, Mapping):
        payload = {}
    if action == "create":
        food_id = payload.get("foodId") or payload.get("food_id") or operation.get("foodId") or operation.get("food_id")
        return str(food_id).strip() if food_id else None
    if action == "update":
        food_id = payload.get("foodId") or payload.get("food_id")
        return str(food_id).strip() if food_id else None
    return None


def _operation_item_id(operation: Mapping[str, Any], *, action: FoodPlanAction) -> str | None:
    if action == "create":
        return None
    item_id = operation.get("targetId") or operation.get("target_id") or operation.get("item_id")
    return str(item_id).strip() if item_id else None


def _intent_from_operation(operation: Mapping[str, Any]) -> FoodPlanWriteIntent:
    action = _operation_action(operation)
    return FoodPlanWriteIntent(
        action=action,
        item_id=_operation_item_id(operation, action=action),
        target_food_id=_operation_target_food_id(operation, action=action),
        base_updated_at=_parse_base_updated_at(
            operation.get("baseUpdatedAt") if "baseUpdatedAt" in operation else operation.get("base_updated_at")
        ),
    )


def _load_plan_items_for_discovery(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    item_ids: Sequence[str],
) -> dict[str, FoodPlanItem]:
    ordered_ids = _unique_sorted_ids(list(item_ids))
    if not ordered_ids:
        return {}
    items = list(
        db.scalars(
            select(FoodPlanItem)
            .where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.user_id == user_id,
                FoodPlanItem.id.in_(ordered_ids),
            )
            .options(selectinload(FoodPlanItem.food))
        )
    )
    return {item.id: item for item in items}


def discover_food_plan_write_intents(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    operations: Sequence[Mapping[str, Any]] | None = None,
    intents: Sequence[FoodPlanWriteIntent] | None = None,
) -> list[FoodPlanWriteIntent]:
    """Pre-read plan candidates without locking and record current Food IDs."""
    if intents is None:
        if operations is None:
            return []
        base_intents = [_intent_from_operation(operation) for operation in operations]
    else:
        base_intents = list(intents)

    existing_ids = [intent.item_id for intent in base_intents if intent.item_id]
    items_by_id = _load_plan_items_for_discovery(
        db,
        family_id=family_id,
        user_id=user_id,
        item_ids=existing_ids,
    )

    discovered: list[FoodPlanWriteIntent] = []
    for intent in base_intents:
        if intent.action == "create":
            if not intent.target_food_id:
                raise FoodPlanConflict("food_plan_food_required", "餐食计划草稿必须引用食物库里的食物")
            discovered.append(intent)
            continue
        if not intent.item_id:
            raise FoodPlanConflict("food_plan_item_required", "菜单计划项 ID 不能为空")
        item = items_by_id.get(intent.item_id)
        if item is None:
            raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
        target_food_id = intent.target_food_id or item.food_id
        discovered.append(
            replace(
                intent,
                current_food_id=item.food_id,
                target_food_id=target_food_id,
            )
        )
    return discovered


def lock_food_plan_write_intents(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    intents: Sequence[FoodPlanWriteIntent],
) -> LockedFoodPlanTargets:
    """Lock Food parents first, then FoodPlanItem rows, and revalidate the whole set."""
    food_ids = _unique_sorted_ids(
        [
            *[intent.current_food_id for intent in intents],
            *[intent.target_food_id for intent in intents],
        ]
    )
    item_ids = _unique_sorted_ids([intent.item_id for intent in intents])

    try:
        foods_by_id = (
            lock_inventory_targets(
                db,
                family_id=family_id,
                food_ids=food_ids,
            ).foods
            if food_ids
            else {}
        )
    except InventoryTargetNotFoundError as exc:
        raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物") from exc

    items_by_id: dict[str, FoodPlanItem] = {}
    if item_ids:
        locked_items = list(
            db.scalars(
                select(FoodPlanItem)
                .where(
                    FoodPlanItem.family_id == family_id,
                    FoodPlanItem.user_id == user_id,
                    FoodPlanItem.id.in_(item_ids),
                )
                .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
                .order_by(FoodPlanItem.id.asc())
                .with_for_update()
            )
        )
        if len(locked_items) != len(item_ids):
            raise FoodPlanConflict("food_plan_targets_changed", "菜单计划目标已变化，请刷新后重试")
        items_by_id = {item.id: item for item in locked_items}

    for intent in intents:
        if intent.action == "create":
            assert intent.target_food_id is not None
            if intent.target_food_id not in foods_by_id:
                raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")
            continue

        assert intent.item_id is not None
        item = items_by_id.get(intent.item_id)
        if item is None:
            raise FoodPlanConflict("food_plan_targets_changed", "菜单计划目标已变化，请刷新后重试")
        if item.family_id != family_id or item.user_id != user_id:
            raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
        if intent.current_food_id is not None and item.food_id != intent.current_food_id:
            raise FoodPlanConflict("food_plan_targets_changed", "菜单计划目标已变化，请刷新后重试")
        if intent.current_food_id is not None and intent.current_food_id not in foods_by_id:
            raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")
        if intent.target_food_id is not None and intent.target_food_id not in foods_by_id:
            raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")
        _assert_base_updated_at_matches(
            actual=item.updated_at,
            expected=intent.base_updated_at,
            label="菜单计划",
        )
        if intent.action == "set_status":
            # Status validation stays at the caller; lock only ensures ownership and freshness.
            pass

    return LockedFoodPlanTargets(foods_by_id=foods_by_id, items_by_id=items_by_id)


def assert_food_plan_base_updated_at_matches(
    *,
    actual: datetime | None,
    expected: datetime | None,
    label: str = "菜单计划",
) -> None:
    """Public wrapper for plan-item baseUpdatedAt OCC checks."""
    _assert_base_updated_at_matches(actual=actual, expected=expected, label=label)


def normalize_food_plan_datetime(value: datetime | str | None) -> datetime | None:
    """Public wrapper for UTC datetime normalization used by plan writers."""
    return _normalize_datetime(value)


def lock_plan_item_after_food(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    item_id: str,
    expected_food_id: str,
    base_updated_at: datetime | None = None,
    require_planned: bool = False,
) -> FoodPlanItem:
    """Lock one FoodPlanItem after its Food parent is already locked."""
    plan_item = db.scalar(
        select(FoodPlanItem)
        .where(
            FoodPlanItem.family_id == family_id,
            FoodPlanItem.user_id == user_id,
            FoodPlanItem.id == item_id,
        )
        .options(selectinload(FoodPlanItem.food))
        .with_for_update()
    )
    if plan_item is None:
        raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
    if plan_item.food_id != expected_food_id:
        raise FoodPlanConflict("food_plan_food_mismatch", "菜单计划关联的食物已变化，请刷新后重试")
    _assert_base_updated_at_matches(
        actual=plan_item.updated_at,
        expected=base_updated_at,
        label="菜单计划",
    )
    if require_planned and plan_item.status != "planned":
        if plan_item.status == "cooked" or plan_item.meal_log_id:
            raise FoodPlanConflict(
                "food_plan_item_already_completed",
                "该菜单项已经记录完成",
                meal_log_id=plan_item.meal_log_id,
            )
        raise FoodPlanConflict(
            "food_plan_item_not_planned",
            "该菜单项当前不可完成",
        )
    return plan_item
