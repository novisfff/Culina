from __future__ import annotations

from sqlalchemy import select

from app.core.enums import ActivityAction
from app.models.domain import FoodPlanItem
from app.services.activity import log_activity
from app.services.ai_revert.errors import (
    AIRevertAdapterVersionUnsupported,
    AIRevertDependencyExists,
    AIRevertTargetChanged,
)
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.search.jobs import enqueue_search_document_deletion_job


class SimplePlanRevertAdapter:
    key = "meal_plan.simple_create.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema_version", "items"}
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or not isinstance(payload.get("items"), list)
            or not payload["items"]
        ):
            raise AIRevertAdapterVersionUnsupported()
        records: list[dict] = []
        for record in payload["items"]:
            if (
                not isinstance(record, dict)
                or set(record) != {"food_plan_item_id", "after_row_version"}
                or not isinstance(record.get("food_plan_item_id"), str)
                or type(record.get("after_row_version")) is not int
            ):
                raise AIRevertAdapterVersionUnsupported()
            records.append(record)
        item_ids = [record["food_plan_item_id"] for record in records]
        if item_ids != sorted(set(item_ids)):
            raise AIRevertAdapterVersionUnsupported()

        discovered = list(
            context.db.scalars(
                select(FoodPlanItem).where(
                    FoodPlanItem.family_id == context.family_id,
                    FoodPlanItem.id.in_(item_ids),
                )
            )
        )
        food_ids = tuple(sorted({item.food_id for item in discovered}))
        try:
            lock_inventory_targets(context.db, family_id=context.family_id, food_ids=food_ids)
        except InventoryTargetNotFoundError as exc:
            raise AIRevertTargetChanged() from exc
        items_list = list(
            context.db.scalars(
                select(FoodPlanItem)
                .where(
                    FoodPlanItem.family_id == context.family_id,
                    FoodPlanItem.id.in_(item_ids),
                )
                .order_by(FoodPlanItem.id.asc())
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        if len(items_list) != len(item_ids) or {item.food_id for item in items_list} != set(food_ids):
            raise AIRevertTargetChanged()
        items = {item.id: item for item in items_list}
        for record in records:
            item = items[record["food_plan_item_id"]]
            if item.status == "cooked" or item.meal_log_id is not None:
                raise AIRevertDependencyExists()
            if item.status != "planned" or int(item.row_version) != record["after_row_version"]:
                raise AIRevertTargetChanged()

        entities = tuple(
            {
                "id": item_id,
                "label": items[item_id].food.name if items[item_id].food else "餐食计划",
                "operation": "delete",
            }
            for item_id in item_ids
        )
        for item_id in item_ids:
            item = items[item_id]
            enqueue_search_document_deletion_job(
                context.db,
                family_id=context.family_id,
                user_id=context.actor_user_id,
                entity_type="meal_plan",
                entity_id=item.id,
                target_name=item.food.name if item.food else "餐食计划",
            )
            context.db.delete(item)
            log_activity(
                context.db,
                family_id=context.family_id,
                actor_id=context.actor_user_id,
                action=ActivityAction.UPDATE,
                entity_type="FoodPlanItem",
                entity_id=item.id,
                summary="撤销 AI 餐食计划创建",
            )
        context.db.flush()
        return AIRevertResult(
            result_json={"restored": True, "count": len(records)},
            entities=entities,
            cache_scopes=("meal_plan", "ai_conversation"),
        )
