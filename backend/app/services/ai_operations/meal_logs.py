from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, MealType
from app.core.utils import utcnow
from app.models.domain import Food, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_logs import CreateMealLogRequest, MealLogFoodRatingIn, UpdateMealCompositionRequest
from app.schemas.meal_recording import RecordMealRequest
from app.services.activity import log_activity
from app.services.ai_auto_execution.catalog import AUTO_EXECUTION_CATALOG
from app.services.ai_auto_execution.policy_types import AICacheScope, ConcurrencyStrategy, DraftExecutionReceipt
from app.services.food_plan_locking import FoodPlanConflict, lock_plan_item_after_food
from app.services.food_stock import apply_food_stock_consume
from app.services.meal_log_references import MealLogReferenceError, lock_and_validate_meal_log_references
from app.services.meal_log_composition import MealCompositionValidationError, update_meal_composition
from app.services.meal_log_versions import (
    MealLogConflictError,
    bump_meal_log_collection,
    lock_meal_log_write_targets,
)
from app.services.meal_log_writes import MealEntryWrite, create_meal_log_with_entries
from app.services.meal_recording import record_meal
from app.services.media import bind_media_assets, replace_media_assets
from app.services.serializers import serialize_meal_log
from app.services.ai_operations.registry_types import DraftExecuteContext


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
_RATING_FIELDS = {
    "draftType",
    "schemaVersion",
    "action",
    "targetId",
    "baseUpdatedAt",
    "before",
    "payload",
}
_RATING_QUANTUM = Decimal("0.1")
_SIMPLE_MEAL_FIELDS = {
    "draftType",
    "schemaVersion",
    "date",
    "mealType",
    "participantUserIds",
    "foods",
    "notes",
    "mood",
    "mediaIds",
    "planItemId",
    "planItemBaseUpdatedAt",
}
_SIMPLE_MEAL_FOOD_REQUIRED_FIELDS = {
    "foodId",
    "name",
    "foodType",
    "servings",
    "note",
    "rating",
    "deductStock",
}
_SIMPLE_MEAL_FOOD_ALLOWED_FIELDS = _SIMPLE_MEAL_FOOD_REQUIRED_FIELDS | {
    "stockCurrentQuantity",
    "stockUnit",
}


def _canonical_rating(value: float | Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value)).quantize(_RATING_QUANTUM, rounding=ROUND_HALF_UP)


def _rating_revert_eligible(items: object) -> bool:
    if (
        not isinstance(items, list)
        or not items
        or len(items) > AUTO_EXECUTION_CATALOG["meal_log.rate_food"].limits["items"]
    ):
        return False
    entry_ids: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"id", "rating"}:
            return False
        entry_id = str(item.get("id") or "")
        if not entry_id or entry_id in entry_ids:
            return False
        entry_ids.add(entry_id)
        rating = item.get("rating")
        if rating is None:
            continue
        if isinstance(rating, bool):
            return False
        try:
            normalized = Decimal(str(rating))
        except Exception:
            return False
        if not normalized.is_finite() or not Decimal("0.5") <= normalized <= Decimal("5"):
            return False
    return True


def _simple_meal_ledger_eligible(context: DraftExecuteContext) -> bool:
    payload = context.payload
    foods = payload.get("foods")
    if (
        context.committed_at is None
        or context.revertible_until is None
        or set(payload) != _SIMPLE_MEAL_FIELDS
        or payload.get("draftType") != "meal_log"
        or payload.get("schemaVersion") != "meal_log.v1"
        or payload.get("participantUserIds") != [context.user_id]
        or payload.get("mediaIds") != []
        or payload.get("planItemId") is not None
        or payload.get("planItemBaseUpdatedAt") is not None
        or not isinstance(foods, list)
        or not foods
        or len(foods) > AUTO_EXECUTION_CATALOG["meal_log.simple_create"].limits["foods"]
    ):
        return False
    food_ids: set[str] = set()
    records: list[dict[str, Any]] = []
    for item in foods:
        if (
            not isinstance(item, dict)
            or not _SIMPLE_MEAL_FOOD_REQUIRED_FIELDS.issubset(item)
            or set(item) - _SIMPLE_MEAL_FOOD_ALLOWED_FIELDS
            or item.get("deductStock") is not False
        ):
            return False
        food_id = str(item.get("foodId") or "").strip()
        if not food_id or food_id in food_ids:
            return False
        food_ids.add(food_id)
        records.append(item)
    foods_by_id = {
        food.id: food
        for food in context.db.scalars(
            select(Food).where(Food.family_id == context.family_id, Food.id.in_(sorted(food_ids)))
        )
    }
    if set(foods_by_id) != food_ids:
        return False
    references_match = all(
        record.get("name") == foods_by_id[str(record["foodId"])].name
        and record.get("foodType")
        == (
            foods_by_id[str(record["foodId"])].type.value
            if hasattr(foods_by_id[str(record["foodId"])].type, "value")
            else str(foods_by_id[str(record["foodId"])].type)
        )
        for record in records
    )
    if not references_match:
        return False
    try:
        _simple_meal_record_request(context)
    except ValidationError:
        return False
    return True


def _simple_meal_record_request(context: DraftExecuteContext) -> RecordMealRequest:
    payload = context.payload
    return RecordMealRequest.model_validate(
        {
            "client_request_id": f"ai:{context.operation_idempotency_key}",
            "date": payload["date"],
            "meal_type": payload["mealType"],
            "target": {"kind": "new"},
            "entries": [
                {
                    "food_id": item["foodId"],
                    "servings": item["servings"],
                    "note": item["note"],
                    "rating": item["rating"],
                }
                for item in payload["foods"]
            ],
            "notes": payload["notes"],
            "mood": payload["mood"],
        }
    )


def _execute_simple_meal_ledger(context: DraftExecuteContext) -> DraftExecutionReceipt:
    assert context.committed_at is not None
    assert context.revertible_until is not None
    request = _simple_meal_record_request(context)
    response = record_meal(
        context.db,
        family_id=context.family_id,
        actor_user_id=context.user_id,
        request=request,
        now=context.committed_at,
        revertible_until=context.revertible_until,
    )
    return DraftExecutionReceipt(
        business_entity=response.meal_log.model_dump(mode="json"),
        entity_ids=(response.meal_log.id,),
        cache_scopes=("meal_log", "ai_conversation"),
        revert_adapter_key="meal_log.simple_create.v1",
        revert_context={
            "schema_version": 1,
            "meal_log_record_operation_id": response.operation.id,
        },
    )


def _serialize_meal_log(db: Session, *, family_id: str, meal_log_id: str) -> dict[str, Any]:
    refreshed = db.scalar(
        select(MealLog)
        .where(MealLog.id == meal_log_id)
        .options(
            selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
            selectinload(MealLog.deduction_suggestions),
        )
    )
    assert refreshed is not None
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="meal_log",
            entity_ids=[refreshed.id],
        )
    )
    return serialize_meal_log(refreshed, media_map)


def execute_meal_log_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
    concurrency_strategy: ConcurrencyStrategy = "entity_version",
    revert_capture: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    action = str(payload.get("action") or "")
    if action == "update_composition":
        if (payload.get("payload") or {}).get("inventoryAdjustment") != "none":
            raise ValueError("餐食组成纠错不能调整历史库存")
        request = UpdateMealCompositionRequest.model_validate(
            {
                "expected_row_version": payload.get("expectedRowVersion"),
                "food_entries": [
                    {
                        "id": item.get("entryId"),
                        "food_id": item.get("foodId"),
                        "servings": item.get("servings"),
                        "note": item.get("note") or "",
                    }
                    for item in (payload.get("payload") or {}).get("foods") or []
                    if isinstance(item, dict)
                ],
            }
        )
        try:
            meal_log = update_meal_composition(
                db,
                family_id=family_id,
                actor_user_id=user_id,
                meal_log_id=str(payload.get("targetId") or ""),
                expected_row_version=request.expected_row_version,
                food_entries=request.food_entries,
            )
        except MealCompositionValidationError as exc:
            raise ValueError(exc.message) from exc
        return _serialize_meal_log(db, family_id=family_id, meal_log_id=meal_log.id), [meal_log.id]
    if action in {"update_details", "rate_food"}:
        meal_log_id = str(payload.get("targetId") or "")
        if not meal_log_id:
            raise AIConflictError("餐食记录不存在或已被删除")
        try:
            # Task 2 order: discover entry Foods unlocked → sorted Food locks → MealLog lock → revalidate.
            locked = lock_meal_log_write_targets(
                db,
                family_id=family_id,
                meal_log_id=meal_log_id,
            )
        except MealLogConflictError as exc:
            if exc.code == "meal_log_not_found":
                raise AIConflictError("餐食记录不存在或已被删除") from exc
            raise AIConflictError(exc.message) from exc

        meal_log = locked.meal_log
        # Full-detail updates retain the entity OCC contract.  Rating-only
        # writes are explicit field patches: the lock/re-read above supplies
        # the latest row and unrelated meal-log edits must not block them.
        if not (action == "rate_food" and concurrency_strategy == "field_patch"):
            assert_updated_at_matches(
                actual=meal_log.updated_at,
                expected=str(payload.get("baseUpdatedAt")),
                label="餐食记录",
            )
        if action == "update_details":
            draft = payload.get("payload") or {}
            participant_user_ids = draft.get("participantUserIds")
            notes = draft.get("notes")
            mood = draft.get("mood")
            media_ids = draft.get("mediaIds")
            try:
                references = lock_and_validate_meal_log_references(
                    db,
                    family_id=family_id,
                    actor_user_id=user_id,
                    food_ids=[entry.food_id for entry in meal_log.food_entries],
                    participant_user_ids=(
                        participant_user_ids
                        if participant_user_ids is not None
                        else meal_log.participant_user_ids
                    ),
                    prelocked_foods=locked.foods_by_id,
                )
            except MealLogReferenceError as exc:
                raise ValueError(exc.message) from exc
            meal_log.participant_user_ids = list(references.participant_user_ids)
            meal_log.notes = notes or ""
            meal_log.mood = mood or ""
            replace_media_assets(
                db,
                family_id=family_id,
                media_ids=list(media_ids or []),
                entity_type="meal_log",
                entity_id=meal_log.id,
            )
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="MealLog",
                entity_id=meal_log.id,
                summary="AI 补充餐食记录详情",
            )
        else:
            raw_ratings = (payload.get("payload") or {}).get("foodEntryRatings") or []
            ratings = [MealLogFoodRatingIn.model_validate(item) for item in raw_ratings]
            try:
                # Rating-only: lock foods with actor-only participants so historical
                # members who left the family do not block the rating update.
                lock_and_validate_meal_log_references(
                    db,
                    family_id=family_id,
                    actor_user_id=user_id,
                    food_ids=[entry.food_id for entry in meal_log.food_entries],
                    participant_user_ids=[user_id],
                    prelocked_foods=locked.foods_by_id,
                )
            except MealLogReferenceError as exc:
                raise ValueError(exc.message) from exc
            entries_by_id = {entry.id: entry for entry in meal_log.food_entries}
            changed_entries: list[tuple[MealLogFood, Decimal | None]] = []
            for item in ratings:
                entry = entries_by_id.get(item.id)
                if entry is None:
                    raise ValueError("评分草稿引用了不属于该餐食记录的食物项")
                next_rating = _canonical_rating(item.rating)
                before_rating = Decimal(str(entry.rating)) if entry.rating is not None else None
                if before_rating != next_rating:
                    changed_entries.append((entry, before_rating))
                entry.rating = next_rating
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="MealLog",
                entity_id=meal_log.id,
                summary="AI 更新餐食记录评分",
            )
        bump_meal_log_collection(meal_log, user_id=user_id)
        db.flush()
        if action == "rate_food" and revert_capture is not None and changed_entries:
            revert_capture.update(
                {
                    "schema_version": 1,
                    "meal_log_id": meal_log.id,
                    "after_meal_log_row_version": int(meal_log.row_version),
                    "entries": [
                        {
                            "meal_log_food_id": entry.id,
                            "before_rating": float(before_rating) if before_rating is not None else None,
                            "after_rating": float(entry.rating) if entry.rating is not None else None,
                        }
                        for entry, before_rating in sorted(changed_entries, key=lambda pair: pair[0].id)
                    ],
                }
            )
        return _serialize_meal_log(db, family_id=family_id, meal_log_id=meal_log.id), [meal_log.id]

    effective_payload = (
        payload.get("payload")
        if action == "create" and isinstance(payload.get("payload"), dict)
        else payload
    )
    effective_foods = [item for item in effective_payload.get("foods") or [] if isinstance(item, dict)]
    food_ids = [str(item.get("foodId") or "").strip() for item in effective_foods]
    participant_user_ids = effective_payload.get("participantUserIds") or [user_id]
    try:
        references = lock_and_validate_meal_log_references(
            db,
            family_id=family_id,
            actor_user_id=user_id,
            food_ids=food_ids,
            participant_user_ids=participant_user_ids,
        )
    except MealLogReferenceError as exc:
        raise ValueError(exc.message) from exc

    deducting_ids = {
        str(item.get("foodId") or "")
        for item in effective_foods
        if item.get("deductStock") is True and str(item.get("foodId") or "")
    }
    if deducting_ids - set(references.foods_by_id):
        raise ValueError("餐食记录扣减项包含不存在或不属于当前家庭的食物")

    food_entries = []
    for item in effective_foods:
        food_id = str(item.get("foodId") or "").strip()
        food = references.foods_by_id.get(food_id)
        if food is None:
            raise ValueError("草稿包含不属于当前家庭的食物")
        food_entries.append((food, item))
    request = CreateMealLogRequest.model_validate(
        {
            "date": effective_payload["date"],
            "meal_type": effective_payload["mealType"],
            "food_entries": [
                {
                    "food_id": food.id,
                    "servings": item.get("servings") or 1,
                    "note": item.get("note") or "",
                    "rating": item.get("rating"),
                }
                for food, item in food_entries
            ],
            "participant_user_ids": list(references.participant_user_ids),
            "notes": effective_payload.get("notes") or "",
            "mood": effective_payload.get("mood") or "",
            "media_ids": effective_payload.get("mediaIds") or [],
        }
    )
    meal_type = request.meal_type if isinstance(request.meal_type, MealType) else MealType(request.meal_type)
    meal_log, _ = create_meal_log_with_entries(
        db,
        family_id=family_id,
        user_id=user_id,
        date=request.date,
        meal_type=meal_type,
        entries=[
            MealEntryWrite(
                food_id=entry_payload.food_id,
                servings=Decimal(str(entry_payload.servings)),
                note=entry_payload.note,
                rating=Decimal(str(entry_payload.rating)) if entry_payload.rating is not None else None,
            )
            for entry_payload in request.food_entries
        ],
        participant_user_ids=list(references.participant_user_ids),
        notes=request.notes,
        mood=request.mood,
    )
    for food, item in food_entries:
        if item.get("deductStock") is not True:
            continue
        apply_food_stock_consume(
            db,
            family_id=family_id,
            user_id=user_id,
            food=food,
            quantity=Decimal(str(item["stockQuantity"])),
            unit=str(item["stockUnit"]),
            note=f"AI 餐食记录 {meal_log.id}",
        )
    if request.media_ids:
        bind_media_assets(
            db,
            family_id=family_id,
            media_ids=list(request.media_ids),
            entity_type="meal_log",
            entity_id=meal_log.id,
        )
    plan_item_id = effective_payload.get("planItemId")
    if plan_item_id:
        # Prefer the first food entry as the expected plan target; create path
        # already validated foods and locked them via meal-log references.
        if not food_entries:
            raise AIConflictError("关联计划项需要至少一个食物")
        expected_food_id = food_entries[0][0].id
        base_updated_raw = effective_payload.get("planItemBaseUpdatedAt")
        base_updated_at = None
        if base_updated_raw:
            try:
                text = str(base_updated_raw).strip()
                if text.endswith("Z"):
                    text = f"{text[:-1]}+00:00"
                base_updated_at = datetime.fromisoformat(text)
            except ValueError as exc:
                raise ValueError("planItemBaseUpdatedAt 格式不正确") from exc
        try:
            plan_item = lock_plan_item_after_food(
                db,
                family_id=family_id,
                user_id=user_id,
                item_id=str(plan_item_id),
                expected_food_id=expected_food_id,
                base_updated_at=base_updated_at,
                require_planned=True,
            )
        except FoodPlanConflict as exc:
            if exc.code == "food_plan_item_not_found":
                raise AIConflictError("关联计划项不存在或已被删除") from exc
            raise AIConflictError(str(exc.message or exc)) from exc
        plan_item.status = "cooked"
        plan_item.completed_at = utcnow()
        plan_item.meal_log_id = meal_log.id
        plan_item.updated_by = user_id
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary="AI 创建餐食记录",
    )
    return _serialize_meal_log(db, family_id=family_id, meal_log_id=meal_log.id), [meal_log.id]


def execute_meal_log_draft_receipt(context: DraftExecuteContext) -> DraftExecutionReceipt:
    if _simple_meal_ledger_eligible(context):
        return _execute_simple_meal_ledger(context)
    revert_context: dict[str, Any] = {}
    business_entity, entity_ids = execute_meal_log_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
        concurrency_strategy=context.concurrency_strategy,
        revert_capture=revert_context,
    )
    payload = context.payload
    effective_payload = (
        payload.get("payload")
        if payload.get("action") == "create" and isinstance(payload.get("payload"), dict)
        else payload
    )
    scopes: list[AICacheScope] = ["meal_log"]
    if any(
        isinstance(item, dict) and item.get("deductStock") is True
        for item in effective_payload.get("foods") or []
    ):
        scopes.append("food")
    if effective_payload.get("planItemId"):
        scopes.append("meal_plan")
    scopes.append("ai_conversation")
    rating_payload = payload.get("payload")
    rating_items = (
        rating_payload.get("foodEntryRatings")
        if isinstance(rating_payload, dict)
        else None
    )
    eligible = (
        set(payload) == _RATING_FIELDS
        and payload.get("draftType") == "meal_log"
        and payload.get("schemaVersion") == "meal_log_operation.v1"
        and payload.get("action") == "rate_food"
        and isinstance(payload.get("before"), dict)
        and isinstance(rating_payload, dict)
        and set(rating_payload) == {"foodEntryRatings"}
        and _rating_revert_eligible(rating_items)
        and bool(revert_context)
        and len(revert_context["entries"]) == len(rating_items)
    )
    return DraftExecutionReceipt(
        business_entity=business_entity,
        entity_ids=tuple(sorted(entity_ids)),
        cache_scopes=tuple(scopes),
        revert_adapter_key="meal_log.rating.v1" if eligible else None,
        revert_context=revert_context if eligible else None,
    )
