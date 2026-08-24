from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import MealLog
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policies._common import (
    active_actor,
    allowed,
    decimal_value,
    denied,
    requirements_verified,
    version_matches,
)
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    CriticalEvidenceRequirement,
)


class MealRatingPolicy:
    key = "meal_log.rate_food"
    version = "meal_log.rate_food.v1"
    draft_types = frozenset({"meal_log"})
    revert_adapter_key = "meal_log.rating.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return draft_type == "meal_log" and payload.get("action") == "rate_food"

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
            CriticalEvidenceRequirement("action", "meal_log.rate_food", "explicit_action"),
            CriticalEvidenceRequirement("targetId", payload.get("targetId"), "entity_id"),
        ]
        rating_payload = payload.get("payload")
        ratings = rating_payload.get("foodEntryRatings") if isinstance(rating_payload, dict) else None
        for index, item in enumerate(ratings if isinstance(ratings, list) else []):
            record = item if isinstance(item, dict) else {}
            requirements.extend((
                CriticalEvidenceRequirement(
                    f"payload.foodEntryRatings[{index}].id", record.get("id"), "entity_id"
                ),
                CriticalEvidenceRequirement(
                    f"payload.foodEntryRatings[{index}].rating", record.get("rating"), "rating"
                ),
            ))
        return tuple(requirements)

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        payload = context.payload
        if set(payload) != {
            "draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "before", "payload",
        }:
            return denied()
        rating_payload = payload.get("payload")
        ratings = rating_payload.get("foodEntryRatings") if isinstance(rating_payload, dict) else None
        limit = AUTO_EXECUTION_CATALOG[self.key].limits["items"]
        if (
            payload.get("draftType") != "meal_log"
            or payload.get("schemaVersion") != "meal_log_operation.v1"
            or payload.get("action") != "rate_food"
            or not isinstance(payload.get("before"), dict)
            or not isinstance(rating_payload, dict)
            or set(rating_payload) != {"foodEntryRatings"}
            or not isinstance(ratings, list)
            or not ratings
            or len(ratings) > limit
            or not active_actor(context.db, family_id=context.family_id, actor_user_id=context.actor_user_id)
        ):
            reason = (
                "batch_limit_exceeded"
                if isinstance(ratings, list) and len(ratings) > limit
                else "domain_constraint_failed"
            )
            return denied(reason)
        requested: dict[str, Decimal | None] = {}
        for item in ratings:
            if not isinstance(item, dict) or set(item) != {"id", "rating"}:
                return denied()
            entry_id = str(item.get("id") or "")
            if not entry_id or entry_id in requested:
                return denied()
            rating = item.get("rating")
            if rating is not None:
                normalized_rating = decimal_value(rating)
                if normalized_rating is None or normalized_rating < Decimal("0.5") or normalized_rating > Decimal("5"):
                    return denied()
                rating = normalized_rating
            requested[entry_id] = rating

        meal_log = context.db.scalar(
            select(MealLog)
            .where(MealLog.family_id == context.family_id, MealLog.id == str(payload.get("targetId") or ""))
            .options(selectinload(MealLog.food_entries))
        )
        if meal_log is None:
            return denied()
        if not version_matches(meal_log.updated_at, payload.get("baseUpdatedAt")):
            return denied("target_stale")
        if (
            meal_log.created_by != context.actor_user_id
            and context.actor_user_id not in set(meal_log.participant_user_ids or [])
        ):
            return denied()
        entries = {entry.id: entry for entry in meal_log.food_entries}
        if set(requested) - set(entries):
            return denied()
        requirements = self.evidence_requirements(
            db=context.db,
            family_id=context.family_id,
            actor_user_id=context.actor_user_id,
            payload=payload,
        )
        if not requirements_verified(context, requirements):
            return denied("intent_evidence_missing")
        satisfied = [
            (entries[entry_id].rating is None and rating is None)
            or (
                entries[entry_id].rating is not None
                and rating is not None
                and Decimal(str(entries[entry_id].rating)) == Decimal(str(rating))
            )
            for entry_id, rating in requested.items()
        ]
        if any(satisfied) and not all(satisfied):
            return denied()
        return allowed(all_targets_satisfied=all(satisfied))
