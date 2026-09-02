from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.models.domain import Food, FoodPlanItem
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
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
from app.services.inventory_operation_locking import lock_inventory_targets


_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
_TOP_LEVEL_FIELDS = {"draftType", "schemaVersion", "items", "source"}
_ITEM_FIELDS = {
    "date", "mealType", "title", "foodId", "recipeId", "reason", "usedInventory",
    "missingIngredients", "missingIngredientItems", "source",
}


class SimplePlanPolicy:
    key = "meal_plan.simple_create"
    version = "meal_plan.simple_create.v1"
    draft_types = frozenset({"meal_plan"})
    revert_adapter_key = "meal_plan.simple_create.v1"

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool:
        return (
            draft_type == "meal_plan"
            and payload.get("schemaVersion") == "meal_plan.v1"
            and "items" in payload
            and "operations" not in payload
        )

    def concurrency_strategy(
        self,
        *,
        draft_type: str,
        payload: dict[str, Any],
    ) -> ConcurrencyStrategy:
        del draft_type, payload
        return "insert"

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]:
        del db, family_id, actor_user_id
        requirements = [CriticalEvidenceRequirement("action", self.key, "explicit_action")]
        items = payload.get("items")
        for index, item in enumerate(items if isinstance(items, list) else []):
            record = item if isinstance(item, dict) else {}
            requirements.extend((
                CriticalEvidenceRequirement(f"items[{index}].date", record.get("date"), "date"),
                CriticalEvidenceRequirement(f"items[{index}].mealType", record.get("mealType"), "meal_type"),
                CriticalEvidenceRequirement(f"items[{index}].foodId", record.get("foodId"), "entity_id"),
            ))
        return tuple(requirements)

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation:
        payload = context.payload
        items = payload.get("items")
        limit = AUTO_EXECUTION_CATALOG[self.key].limits["items"]
        if (
            set(payload) != _TOP_LEVEL_FIELDS
            or payload.get("draftType") != "meal_plan"
            or payload.get("schemaVersion") != "meal_plan.v1"
            or not isinstance(payload.get("source"), dict)
            or not isinstance(items, list)
            or not items
            or len(items) > limit
            or not active_actor(context.db, family_id=context.family_id, actor_user_id=context.actor_user_id)
        ):
            reason = (
                "batch_limit_exceeded"
                if isinstance(items, list) and len(items) > limit
                else "domain_constraint_failed"
            )
            return denied(reason)
        normalized_items: list[tuple[date, str, str]] = []
        records: list[dict[str, Any]] = []
        for item in items:
            if (
                not isinstance(item, dict)
                or set(item) != _ITEM_FIELDS
                or item.get("mealType") not in _MEAL_TYPES
                or item.get("missingIngredients") != []
                or item.get("missingIngredientItems") != []
                or not isinstance(item.get("usedInventory"), list)
                or not isinstance(item.get("source"), dict)
            ):
                return denied()
            try:
                plan_date = date.fromisoformat(str(item.get("date")))
            except ValueError:
                return denied()
            food_id = str(item.get("foodId") or "")
            key = (plan_date, str(item["mealType"]), food_id)
            if not food_id or key in normalized_items:
                return denied()
            normalized_items.append(key)
            records.append(item)
        food_ids = [food_id for _, _, food_id in normalized_items]
        foods_by_id = {
            food.id: food
            for food in context.db.scalars(
                select(Food).where(Food.family_id == context.family_id, Food.id.in_(food_ids))
            )
        }
        if len(foods_by_id) != len(set(food_ids)):
            return denied()
        for record in records:
            food = foods_by_id[str(record["foodId"])]
            if record.get("title") != food.name:
                return denied()
            recipe_id = str(record.get("recipeId") or "") or None
            if recipe_id != food.recipe_id:
                return denied()
        requirements = self.evidence_requirements(
            db=context.db,
            family_id=context.family_id,
            actor_user_id=context.actor_user_id,
            payload=payload,
        )
        if not requirements_verified(context, requirements):
            return denied("intent_evidence_missing")
        satisfaction: list[bool] = []
        for plan_date, meal_type, food_id in normalized_items:
            existing = list(context.db.scalars(
                select(FoodPlanItem).where(
                    FoodPlanItem.family_id == context.family_id,
                    FoodPlanItem.user_id == context.actor_user_id,
                    FoodPlanItem.food_id == food_id,
                    FoodPlanItem.plan_date == plan_date,
                    FoodPlanItem.meal_type == meal_type,
                )
            ))
            if len(existing) > 1 or (existing and existing[0].status != "planned"):
                return denied()
            satisfaction.append(bool(existing))
        if any(satisfaction) and not all(satisfaction):
            return denied()
        return allowed(all_targets_satisfied=all(satisfaction))

    def lock_no_change_targets(self, context: AutoExecutionPolicyContext) -> bool:
        items = context.payload.get("items")
        if not isinstance(items, list) or not items:
            return False
        keys: set[tuple[date, str, str]] = set()
        for item in items:
            if not isinstance(item, dict):
                return False
            food_id = str(item.get("foodId") or "").strip()
            meal_type = str(item.get("mealType") or "").strip()
            try:
                plan_date = date.fromisoformat(str(item.get("date") or ""))
            except ValueError:
                return False
            if not food_id or meal_type not in _MEAL_TYPES:
                return False
            keys.add((plan_date, meal_type, food_id))
        if len(keys) != len(items):
            return False
        food_ids = tuple(sorted({food_id for _, _, food_id in keys}))
        lock_inventory_targets(
            context.db,
            family_id=context.family_id,
            food_ids=food_ids,
        )
        locked_items = list(
            context.db.scalars(
                select(FoodPlanItem)
                .where(
                    FoodPlanItem.family_id == context.family_id,
                    FoodPlanItem.user_id == context.actor_user_id,
                    tuple_(
                        FoodPlanItem.plan_date,
                        FoodPlanItem.meal_type,
                        FoodPlanItem.food_id,
                    ).in_(tuple(sorted(keys))),
                )
                .order_by(FoodPlanItem.id.asc())
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        locked_keys = {
            (item.plan_date, str(getattr(item.meal_type, "value", item.meal_type)), item.food_id)
            for item in locked_items
        }
        return len(locked_items) == len(keys) and locked_keys == keys
