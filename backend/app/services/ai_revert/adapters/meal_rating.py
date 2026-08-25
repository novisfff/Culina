from __future__ import annotations

from decimal import Decimal

from app.core.enums import ActivityAction
from app.services.activity import log_activity
from app.services.ai_revert.errors import AIRevertAdapterVersionUnsupported, AIRevertTargetChanged
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.meal_log_versions import (
    MealLogConflictError,
    bump_meal_log_collection,
    lock_meal_log_write_targets,
)


def _rating(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise AIRevertAdapterVersionUnsupported()
    try:
        return Decimal(str(value))
    except Exception as exc:
        raise AIRevertAdapterVersionUnsupported() from exc


class MealRatingRevertAdapter:
    key = "meal_log.rating.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        if (
            not isinstance(payload, dict)
            or set(payload) != {
                "schema_version",
                "meal_log_id",
                "after_meal_log_row_version",
                "entries",
            }
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or not isinstance(payload.get("meal_log_id"), str)
            or type(payload.get("after_meal_log_row_version")) is not int
            or not isinstance(payload.get("entries"), list)
            or not payload["entries"]
        ):
            raise AIRevertAdapterVersionUnsupported()
        entry_records: list[tuple[str, Decimal | None, Decimal | None]] = []
        for item in payload["entries"]:
            if not isinstance(item, dict) or set(item) != {
                "meal_log_food_id",
                "before_rating",
                "after_rating",
            } or not isinstance(item.get("meal_log_food_id"), str):
                raise AIRevertAdapterVersionUnsupported()
            entry_records.append(
                (
                    item["meal_log_food_id"],
                    _rating(item["before_rating"]),
                    _rating(item["after_rating"]),
                )
            )
        if [item[0] for item in entry_records] != sorted({item[0] for item in entry_records}):
            raise AIRevertAdapterVersionUnsupported()
        try:
            locked = lock_meal_log_write_targets(
                context.db,
                family_id=context.family_id,
                meal_log_id=payload["meal_log_id"],
            )
        except MealLogConflictError as exc:
            raise AIRevertTargetChanged() from exc
        meal_log = locked.meal_log
        entries = {entry.id: entry for entry in meal_log.food_entries}
        if int(meal_log.row_version) != payload["after_meal_log_row_version"]:
            raise AIRevertTargetChanged()
        for entry_id, _before, after in entry_records:
            entry = entries.get(entry_id)
            if entry is None or _rating(entry.rating) != after:
                raise AIRevertTargetChanged()
        for entry_id, before, _after in entry_records:
            entries[entry_id].rating = before
        bump_meal_log_collection(meal_log, user_id=context.actor_user_id)
        log_activity(
            context.db,
            family_id=context.family_id,
            actor_id=context.actor_user_id,
            action=ActivityAction.UPDATE,
            entity_type="MealLog",
            entity_id=meal_log.id,
            summary="撤销餐食记录评分变更",
        )
        context.db.flush()
        return AIRevertResult(
            result_json={"restored": True},
            entities=({"id": meal_log.id, "label": "餐食记录", "operation": "update"},),
            cache_scopes=("meal_log", "ai_conversation"),
        )
