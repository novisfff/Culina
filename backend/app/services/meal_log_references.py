from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import MembershipStatus
from app.models.domain import Food, Membership, User
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets


@dataclass(frozen=True, slots=True)
class ValidatedMealLogReferences:
    foods_by_id: dict[str, Food]
    participant_user_ids: tuple[str, ...]


class MealLogReferenceError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def meal_log_reference_error_detail(exc: MealLogReferenceError) -> dict[str, str]:
    return {
        "code": exc.code,
        "message": exc.message,
    }


def lock_and_validate_meal_log_references(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    food_ids: Sequence[str],
    participant_user_ids: Sequence[str],
    prelocked_foods: Mapping[str, Food] | None = None,
) -> ValidatedMealLogReferences:
    requested_food_ids = [str(value).strip() for value in food_ids if str(value).strip()]
    if not requested_food_ids:
        raise MealLogReferenceError("meal_log_food_required", "餐食记录至少需要一个食物")
    if len(requested_food_ids) != len(set(requested_food_ids)):
        raise MealLogReferenceError("duplicate_meal_log_food", "同一食物不能重复加入一餐")

    ordered_food_ids = sorted(requested_food_ids)
    if prelocked_foods is None:
        try:
            foods_by_id = lock_inventory_targets(
                db,
                family_id=family_id,
                food_ids=ordered_food_ids,
            ).foods
        except InventoryTargetNotFoundError as exc:
            raise MealLogReferenceError("meal_log_food_not_found", "食物不存在或不属于当前家庭") from exc
    else:
        foods_by_id = {
            food_id: prelocked_foods[food_id]
            for food_id in ordered_food_ids
            if food_id in prelocked_foods
        }
        if len(foods_by_id) != len(ordered_food_ids) or any(
            food.family_id != family_id for food in foods_by_id.values()
        ):
            raise MealLogReferenceError("meal_log_food_not_found", "食物不存在或不属于当前家庭")

    normalized_participants = tuple(
        sorted({str(value).strip() for value in participant_user_ids if str(value).strip()})
    )
    if not normalized_participants:
        normalized_participants = (actor_user_id,)
    active_ids = set(
        db.scalars(
            select(Membership.user_id)
            .join(User, User.id == Membership.user_id)
            .where(
                Membership.family_id == family_id,
                Membership.user_id.in_(normalized_participants),
                Membership.status == MembershipStatus.ACTIVE,
                User.is_active.is_(True),
            )
        )
    )
    if active_ids != set(normalized_participants):
        raise MealLogReferenceError(
            "meal_log_participant_not_found",
            "参与成员不存在或不属于当前家庭",
        )
    return ValidatedMealLogReferences(
        foods_by_id=foods_by_id,
        participant_user_ids=normalized_participants,
    )
