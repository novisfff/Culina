from __future__ import annotations

from app.services.ai_revert.errors import (
    AIRevertAdapterVersionUnsupported,
    AIRevertDependencyExists,
    AIRevertTargetChanged,
)
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.meal_log_record_history import (
    RECORD_OPERATION_DEPENDENCY_EXISTS_CODE,
    RECORD_OPERATION_TARGET_CHANGED_CODE,
    MealRecordHistoryError,
    MealRecordHistoryNotFoundError,
    MealRecordHistoryPermissionError,
    revert_record_operation,
)


class SimpleMealRevertAdapter:
    key = "meal_log.simple_create.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema_version", "meal_log_record_operation_id"}
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or not isinstance(payload.get("meal_log_record_operation_id"), str)
            or not payload["meal_log_record_operation_id"].strip()
            or not isinstance(context.operation.business_entity_ids, list)
            or len(context.operation.business_entity_ids) != 1
            or not isinstance(context.operation.business_entity_ids[0], str)
            or not context.operation.business_entity_ids[0].strip()
        ):
            raise AIRevertAdapterVersionUnsupported()
        try:
            response = revert_record_operation(
                context.db,
                family_id=context.family_id,
                actor_user_id=context.actor_user_id,
                user_role=context.actor_role,
                operation_id=payload["meal_log_record_operation_id"],
                now=context.now,
                require_pristine_target=True,
            )
        except (MealRecordHistoryNotFoundError, MealRecordHistoryPermissionError) as exc:
            raise AIRevertTargetChanged() from exc
        except MealRecordHistoryError as exc:
            if exc.code == RECORD_OPERATION_DEPENDENCY_EXISTS_CODE:
                raise AIRevertDependencyExists() from exc
            if exc.code == RECORD_OPERATION_TARGET_CHANGED_CODE:
                raise AIRevertTargetChanged() from exc
            raise AIRevertTargetChanged() from exc

        meal_log = response.meal_log.model_dump(mode="json") if response.meal_log is not None else None
        operation_kind = "update" if meal_log is not None else "delete"
        meal_log_id = (
            response.meal_log.id
            if response.meal_log is not None
            else str(context.operation.business_entity_ids[0])
        )
        return AIRevertResult(
            result_json=response.model_dump(mode="json"),
            entities=({"id": meal_log_id, "label": "餐食记录", "operation": operation_kind},),
            cache_scopes=("meal_log", "ai_conversation"),
        )
