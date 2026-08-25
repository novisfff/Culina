from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Food
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policies._common import (
    active_actor,
    allowed,
    decimal_value,
    denied,
    enum_value,
    requirements_verified,
)
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    CriticalEvidenceRequirement,
)


_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
_TOP_LEVEL_FIELDS = {
    "draftType", "schemaVersion", "date", "mealType", "participantUserIds", "foods",
    "notes", "mood", "mediaIds", "planItemId", "planItemBaseUpdatedAt",
}
_FOOD_REQUIRED_FIELDS = {"foodId", "name", "foodType", "servings", "note", "rating", "deductStock"}
_FOOD_ALLOWED_FIELDS = _FOOD_REQUIRED_FIELDS | {"stockCurrentQuantity", "stockUnit"}


class SimpleMealPolicy:
    key = "meal_log.simple_create"
    version = "meal_log.simple_create.v1"
    draft_types = frozenset({"meal_log"})
    revert_adapter_key = "meal_log.simple_create.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return (
            draft_type == "meal_log"
            and payload.get("schemaVersion") == "meal_log.v1"
            and "foods" in payload
            and not payload.get("action")
        )

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]:
        del db, family_id, actor_user_id
        requirements = [
            CriticalEvidenceRequirement("action", self.key, "explicit_action"),
            CriticalEvidenceRequirement("date", payload.get("date"), "date"),
            CriticalEvidenceRequirement("mealType", payload.get("mealType"), "meal_type"),
        ]
        foods = payload.get("foods")
        for index, item in enumerate(foods if isinstance(foods, list) else []):
            record = item if isinstance(item, dict) else {}
            requirements.extend((
                CriticalEvidenceRequirement(f"foods[{index}].foodId", record.get("foodId"), "entity_id"),
                CriticalEvidenceRequirement(f"foods[{index}].servings", record.get("servings"), "servings"),
            ))
        return tuple(requirements)

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        payload = context.payload
        foods = payload.get("foods")
        limit = AUTO_EXECUTION_CATALOG[self.key].limits["foods"]
        if (
            set(payload) != _TOP_LEVEL_FIELDS
            or payload.get("draftType") != "meal_log"
            or payload.get("schemaVersion") != "meal_log.v1"
            or not isinstance(foods, list)
            or not foods
            or len(foods) > limit
            or payload.get("participantUserIds") != [context.actor_user_id]
            or payload.get("mediaIds") != []
            or payload.get("planItemId") is not None
            or payload.get("planItemBaseUpdatedAt") is not None
            or payload.get("mealType") not in _MEAL_TYPES
            or not active_actor(context.db, family_id=context.family_id, actor_user_id=context.actor_user_id)
        ):
            reason = (
                "batch_limit_exceeded"
                if isinstance(foods, list) and len(foods) > limit
                else "domain_constraint_failed"
            )
            return denied(reason)
        try:
            date.fromisoformat(str(payload.get("date")))
        except (TypeError, ValueError):
            return denied()
        food_ids: list[str] = []
        records: list[dict[str, Any]] = []
        for item in foods:
            if (
                not isinstance(item, dict)
                or not _FOOD_REQUIRED_FIELDS.issubset(item)
                or set(item) - _FOOD_ALLOWED_FIELDS
                or item.get("deductStock") is not False
            ):
                return denied()
            servings = decimal_value(item.get("servings"))
            rating = item.get("rating")
            normalized_rating = decimal_value(rating) if rating is not None else None
            if servings is None or servings <= 0:
                return denied()
            if rating is not None and (
                normalized_rating is None or normalized_rating < Decimal("0.5") or normalized_rating > Decimal("5")
            ):
                return denied()
            food_id = str(item.get("foodId") or "")
            if not food_id or food_id in food_ids:
                return denied()
            food_ids.append(food_id)
            records.append(item)
        foods_by_id = {
            food.id: food
            for food in context.db.scalars(
                select(Food).where(Food.family_id == context.family_id, Food.id.in_(food_ids))
            )
        }
        if len(foods_by_id) != len(food_ids):
            return denied()
        for record in records:
            food = foods_by_id[str(record["foodId"])]
            if record.get("name") != food.name or record.get("foodType") != enum_value(food.type):
                return denied()
        requirements = self.evidence_requirements(
            db=context.db,
            family_id=context.family_id,
            actor_user_id=context.actor_user_id,
            payload=payload,
        )
        if not requirements_verified(context, requirements):
            return denied("intent_evidence_missing")
        return allowed()

    def lock_no_change_targets(self, context: AutoExecutionPolicyContext) -> bool:
        del context
        return False
