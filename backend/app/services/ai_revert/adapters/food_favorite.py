from __future__ import annotations

from app.core.enums import ActivityAction
from app.services.activity import log_activity
from app.services.ai_revert.errors import AIRevertAdapterVersionUnsupported, AIRevertTargetChanged
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets


class FoodFavoriteRevertAdapter:
    key = "food.favorite.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        expected_keys = {
            "schema_version",
            "food_id",
            "before_favorite",
            "after_favorite",
            "after_row_version",
        }
        if (
            not isinstance(payload, dict)
            or set(payload) != expected_keys
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or not isinstance(payload.get("food_id"), str)
            or type(payload.get("before_favorite")) is not bool
            or type(payload.get("after_favorite")) is not bool
            or type(payload.get("after_row_version")) is not int
        ):
            raise AIRevertAdapterVersionUnsupported()
        try:
            food = lock_inventory_targets(
                context.db,
                family_id=context.family_id,
                food_ids=(payload["food_id"],),
            ).foods[payload["food_id"]]
        except (InventoryTargetNotFoundError, KeyError) as exc:
            raise AIRevertTargetChanged() from exc
        if (
            int(food.row_version) != payload["after_row_version"]
            or bool(food.favorite) is not payload["after_favorite"]
        ):
            raise AIRevertTargetChanged()
        food.favorite = payload["before_favorite"]
        food.updated_by = context.actor_user_id
        log_activity(
            context.db,
            family_id=context.family_id,
            actor_id=context.actor_user_id,
            action=ActivityAction.UPDATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"撤销收藏状态变更 {food.name}",
        )
        context.db.flush()
        return AIRevertResult(
            result_json={"restored": True},
            entities=({"id": food.id, "label": food.name, "operation": "update"},),
            cache_scopes=("food", "ai_conversation"),
        )
