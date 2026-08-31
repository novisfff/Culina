from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Food
from app.services.inventory_operation_locking import lock_inventory_targets
from app.services.ai_auto_execution.policies._common import (
    active_actor,
    allowed,
    denied,
    requirements_verified,
)
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    ConcurrencyStrategy,
    CriticalEvidenceRequirement,
)


class FoodFavoritePolicy:
    key = "food.set_favorite"
    version = "food.set_favorite.v1"
    draft_types = frozenset({"food_profile"})
    revert_adapter_key = "food.favorite.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return draft_type == "food_profile" and payload.get("action") == "set_favorite"

    def concurrency_strategy(
        self,
        *,
        draft_type: str,
        payload: dict[str, Any],
    ) -> ConcurrencyStrategy:
        del draft_type, payload
        return "idempotent_set"

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]:
        del db, family_id, actor_user_id
        favorite_payload = payload.get("payload")
        favorite = favorite_payload.get("favorite") if isinstance(favorite_payload, dict) else None
        return (
            CriticalEvidenceRequirement("action", f"set_favorite:{str(favorite).lower()}", "explicit_action"),
            CriticalEvidenceRequirement("targetId", payload.get("targetId"), "entity_id"),
            CriticalEvidenceRequirement("payload.favorite", favorite, "boolean_direction"),
        )

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        payload = context.payload
        if set(payload) != {
            "draftType", "schemaVersion", "action", "targetId", "baseUpdatedAt", "before", "payload",
        }:
            return denied()
        favorite_payload = payload.get("payload")
        if (
            payload.get("draftType") != "food_profile"
            or payload.get("schemaVersion") != "food_profile_operation.v1"
            or payload.get("action") != "set_favorite"
            or not isinstance(payload.get("before"), dict)
            or not isinstance(favorite_payload, dict)
            or set(favorite_payload) != {"favorite"}
            or not isinstance(favorite_payload.get("favorite"), bool)
            or not active_actor(context.db, family_id=context.family_id, actor_user_id=context.actor_user_id)
        ):
            return denied()
        food = context.db.scalar(
            select(Food).where(Food.family_id == context.family_id, Food.id == str(payload.get("targetId") or ""))
        )
        if food is None:
            return denied()
        requirements = self.evidence_requirements(
            db=context.db,
            family_id=context.family_id,
            actor_user_id=context.actor_user_id,
            payload=payload,
        )
        if not requirements_verified(context, requirements):
            return denied("intent_evidence_missing")
        return allowed(all_targets_satisfied=food.favorite is favorite_payload["favorite"])

    def lock_no_change_targets(self, context: AutoExecutionPolicyContext) -> bool:
        target_id = str(context.payload.get("targetId") or "").strip()
        if not target_id:
            return False
        return target_id in lock_inventory_targets(
            context.db,
            family_id=context.family_id,
            food_ids=(target_id,),
        ).foods
