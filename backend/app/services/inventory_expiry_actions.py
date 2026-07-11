from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal, Sequence

from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.enums import ActivityAction
from app.core.utils import utcnow
from app.models.domain import Ingredient, InventoryItem
from app.services.activity import log_activity
from app.services.inventory_operation_locking import lock_inventory_targets
from app.services.inventory_operations import dispose_inventory_quantity
from app.services.inventory_usage import remaining_quantity
from app.services.inventory_versions import (
    InventoryConflictError,
    STALE_INVENTORY_DETAIL,
    bump_ingredient_collection,
    require_expected_version,
)

# Back-compat alias used by API routes and existing tests.
InventoryStaleVersionError = InventoryConflictError

MAX_SNOOZE_DAYS = 30
MAX_ACTIONABLE_DAYS = 7


def _format_month_day(value: date) -> str:
    return f"{value.month}月{value.day}日"


def _submitted_item_ids(item_refs: Sequence[object]) -> list[str]:
    item_ids: list[str] = []
    for ref in item_refs:
        inventory_item_id = getattr(ref, "inventory_item_id", None)
        if inventory_item_id is None and isinstance(ref, dict):
            inventory_item_id = ref["inventory_item_id"]
        if not inventory_item_id:
            raise ValueError("库存批次不能为空")
        item_ids.append(str(inventory_item_id))
    return item_ids


def _expected_versions(item_refs: Sequence[object]) -> dict[str, int]:
    expected: dict[str, int] = {}
    for ref in item_refs:
        inventory_item_id = getattr(ref, "inventory_item_id", None)
        expected_row_version = getattr(ref, "expected_row_version", None)
        if inventory_item_id is None and isinstance(ref, dict):
            inventory_item_id = ref["inventory_item_id"]
            expected_row_version = ref["expected_row_version"]
        expected[str(inventory_item_id)] = int(expected_row_version)
    return expected


def _flush_versioned_inventory(db: Session) -> None:
    """Flush versioned inventory writes; map optimistic-lock conflicts to domain stale errors."""
    try:
        db.flush()
    except StaleDataError as exc:
        raise InventoryConflictError() from exc


def lock_and_validate_versioned_items(
    db: Session,
    *,
    family_id: str,
    ingredient_id: str,
    item_refs: Sequence[object],
) -> tuple[Ingredient, list[InventoryItem]]:
    submitted_ids = _submitted_item_ids(item_refs)
    if not submitted_ids:
        raise ValueError("库存批次不能为空")
    if len(set(submitted_ids)) != len(submitted_ids):
        raise ValueError("不能提交重复的库存批次")

    expected_versions = _expected_versions(item_refs)
    locked = lock_inventory_targets(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient_id],
        inventory_item_ids=submitted_ids,
    )
    ingredient = locked.ingredients.get(ingredient_id)
    if ingredient is None:
        raise ValueError("食材不存在或不属于当前家庭")
    items_by_id = locked.inventory_items
    if len(items_by_id) != len(set(submitted_ids)):
        raise ValueError("部分库存批次不存在或不属于当前家庭")

    ordered_items: list[InventoryItem] = []
    for item_id in submitted_ids:
        item = items_by_id[item_id]
        if item.ingredient_id != ingredient_id:
            raise ValueError("库存批次不属于该食材")
        # Version must win over mutable business state (remaining qty / expiry).
        # Concurrent consume/dispose that exhausts a batch also bumps row_version;
        # clients must get 409 so they refresh, not a 400 that leaves a stale dialog.
        require_expected_version(
            item,
            expected_versions[item_id],
            entity_type="inventory_item",
            entity_id=item.id,
        )
        if remaining_quantity(item) <= 0:
            raise ValueError("库存批次已无剩余数量")
        if item.expiry_date is None:
            raise ValueError("库存批次缺少到期日")
        ordered_items.append(item)
    return ingredient, ordered_items


def _validate_snooze_window(*, today: date, snoozed_until: date) -> None:
    if not (today < snoozed_until <= today + timedelta(days=MAX_SNOOZE_DAYS)):
        raise ValueError("提醒日期必须晚于今天且不超过 30 天")


def _assert_snooze_eligibility(
    items: list[InventoryItem],
    *,
    action: Literal["retain_expired", "snooze_upcoming"],
    today: date,
) -> None:
    actionable_cutoff = today + timedelta(days=MAX_ACTIONABLE_DAYS)
    for item in items:
        expiry_date = item.expiry_date
        if expiry_date is None:
            raise ValueError("库存批次缺少到期日")
        if expiry_date > actionable_cutoff:
            raise ValueError("只能处理 7 天内到期的库存批次")
        if item.expiry_alert_snoozed_until is not None and item.expiry_alert_snoozed_until > today:
            raise ValueError("该库存批次提醒尚未到期，暂时不能再次延后")
        is_expired = expiry_date < today
        if action == "retain_expired" and not is_expired:
            raise ValueError("暂时保留仅适用于已过期批次")
        if action == "snooze_upcoming" and is_expired:
            raise ValueError("稍后提醒仅适用于未过期批次")


def snooze_expiry_alerts(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    actor_display_name: str,
    ingredient_id: str,
    action: Literal["retain_expired", "snooze_upcoming"],
    item_refs: Sequence[object],
    snoozed_until: date,
    today: date,
    reviewed_at: datetime | None = None,
) -> dict:
    _validate_snooze_window(today=today, snoozed_until=snoozed_until)
    ingredient, items = lock_and_validate_versioned_items(
        db,
        family_id=family_id,
        ingredient_id=ingredient_id,
        item_refs=item_refs,
    )
    _assert_snooze_eligibility(items, action=action, today=today)

    review_timestamp = reviewed_at or utcnow()
    reviewed_expired_count = 0
    for item in items:
        item.expiry_alert_snoozed_until = snoozed_until
        item.updated_by = user_id
        if action == "retain_expired":
            item.expiry_reviewed_at = review_timestamp
            item.expiry_reviewed_by = user_id
            reviewed_expired_count += 1

    bump_ingredient_collection(ingredient, user_id=user_id)

    if action == "retain_expired":
        summary = (
            f"{actor_display_name}确认{ingredient.name} {len(items)} 个过期批次暂时保留，"
            f"{_format_month_day(snoozed_until)}再次提醒"
        )
    else:
        summary = (
            f"{actor_display_name}将{ingredient.name} {len(items)} 个临期批次提醒延后至"
            f"{_format_month_day(snoozed_until)}"
        )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=summary,
    )
    _flush_versioned_inventory(db)

    return {
        "ingredient_id": ingredient.id,
        "snoozed_item_ids": [item.id for item in items],
        "snoozed_count": len(items),
        "reviewed_expired_count": reviewed_expired_count,
        "snoozed_until": snoozed_until,
    }


def correct_inventory_expiry_date(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    actor_display_name: str,
    inventory_item_id: str,
    expiry_date: date,
    expected_row_version: int,
) -> InventoryItem:
    # Discover ingredient_id first without taking locks out of order.
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    provisional = db.scalar(
        select(InventoryItem)
        .where(
            InventoryItem.family_id == family_id,
            InventoryItem.id == inventory_item_id,
        )
        .options(selectinload(InventoryItem.ingredient))
    )
    if provisional is None:
        raise ValueError("库存批次不存在或不属于当前家庭")

    locked = lock_inventory_targets(
        db,
        family_id=family_id,
        ingredient_ids=[provisional.ingredient_id],
        inventory_item_ids=[inventory_item_id],
    )
    item = locked.inventory_items.get(inventory_item_id)
    ingredient = locked.ingredients.get(provisional.ingredient_id)
    if item is None or ingredient is None:
        raise ValueError("库存批次不存在或不属于当前家庭")
    require_expected_version(
        item,
        expected_row_version,
        entity_type="inventory_item",
        entity_id=item.id,
    )

    old_expiry = item.expiry_date
    item.expiry_date = expiry_date
    item.expiry_alert_snoozed_until = None
    item.expiry_reviewed_at = None
    item.expiry_reviewed_by = None
    item.updated_by = user_id
    bump_ingredient_collection(ingredient, user_id=user_id)

    old_label = old_expiry.isoformat() if old_expiry is not None else "未设置"
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="InventoryItem",
        entity_id=item.id,
        summary=f"{actor_display_name}将{ingredient.name}到期日从{old_label}更正为{expiry_date.isoformat()}",
    )
    _flush_versioned_inventory(db)
    return item


def dispose_expired_inventory_items(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    actor_display_name: str,
    ingredient_id: str,
    item_refs: Sequence[object],
    today: date,
) -> dict:
    ingredient, items = lock_and_validate_versioned_items(
        db,
        family_id=family_id,
        ingredient_id=ingredient_id,
        item_refs=item_refs,
    )
    for item in items:
        expiry_date = item.expiry_date
        if expiry_date is None:
            raise ValueError("库存批次缺少到期日")
        if expiry_date >= today:
            raise ValueError("只能销毁已过期的库存批次")

    disposed_item_ids: list[str] = []
    for item in items:
        dispose_inventory_quantity(
            db,
            family_id=family_id,
            user_id=user_id,
            item=item,
            quantity=None,
            unit=item.unit,
            reason="过期销毁",
            record_activity=False,
        )
        disposed_item_ids.append(item.id)

    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"{actor_display_name}销毁{ingredient.name} {len(disposed_item_ids)} 个过期批次",
    )
    _flush_versioned_inventory(db)
    return {
        "ingredient_id": ingredient.id,
        "disposed_item_ids": disposed_item_ids,
        "disposed_count": len(disposed_item_ids),
    }
