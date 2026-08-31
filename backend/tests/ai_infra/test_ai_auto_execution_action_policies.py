from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.ai.tools.draft_validation import (
    normalize_food_profile_draft_for_tools,
    normalize_meal_log_draft,
    normalize_meal_plan_draft,
    normalize_shopping_list_draft,
)
from app.core.enums import (
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    MealType,
    MembershipStatus,
    UserRole,
)
from app.models.domain import (
    Family,
    Food,
    FoodPlanItem,
    Ingredient,
    MealLog,
    MealLogFood,
    Membership,
    ShoppingListItem,
    User,
)
from app.services.ai_auto_execution.policy_registry import auto_execution_policy_registry
from app.services.ai_auto_execution.policy_types import (
    AutoExecutionPolicyContext,
    EffectiveAuthorization,
    IntentEvidenceValidation,
    TrustedResolutionSource,
)
from app.services.clock import today_for_family


REVERT_ADAPTER_KEYS = frozenset({
    "food.favorite.v1",
    "meal_log.rating.v1",
    "shopping_list.safe_write.v1",
    "meal_log.simple_create.v1",
    "meal_plan.simple_create.v1",
})


@dataclass(frozen=True)
class PolicySeed:
    db: Session
    family_id: str
    actor_id: str
    other_member_id: str
    food_ids: tuple[str, ...]
    tracked_ingredient_ids: tuple[str, ...]
    non_tracked_ingredient_id: str
    ready_food_ids: tuple[str, ...]
    unsafe_food_id: str
    meal_log_id: str
    meal_entry_ids: tuple[str, ...]
    forbidden_meal_log_id: str
    shopping_pending_id: str
    shopping_done_id: str
    shopping_non_tracked_id: str


@pytest.fixture()
def policy_seed(model_usage_db: Session) -> PolicySeed:
    db = model_usage_db
    family = Family(id="family-policy", name="策略家庭", motto="", location="")
    other_family = Family(id="family-policy-other", name="其他家庭", motto="", location="")
    actor = User(id="user-policy", username="policy", display_name="策略用户", avatar_seed="", is_active=True)
    other = User(id="user-policy-other", username="policy-other", display_name="另一成员", avatar_seed="", is_active=True)
    db.add_all([
        family,
        other_family,
        actor,
        other,
        Membership(
            id="membership-policy",
            family_id=family.id,
            user_id=actor.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        ),
        Membership(
            id="membership-policy-other",
            family_id=family.id,
            user_id=other.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        ),
    ])
    tracked_ingredients = [
        Ingredient(
            id=f"ingredient-policy-{index}",
            family_id=family.id,
            name=f"食材{index}",
            category="测试",
            default_unit="个",
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            notes="",
            created_by=actor.id,
            updated_by=actor.id,
        )
        for index in range(6)
    ]
    non_tracked = Ingredient(
        id="ingredient-policy-presence",
        family_id=family.id,
        name="食盐",
        category="调味",
        default_unit="袋",
        unit_conversions=[],
        quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
        default_storage="常温",
        default_expiry_mode=IngredientExpiryMode.NONE,
        notes="",
        created_by=actor.id,
        updated_by=actor.id,
    )
    foods = [
        Food(
            id=f"food-policy-{index}",
            family_id=family.id,
            name=f"家常菜{index}",
            type=FoodType.SELF_MADE.value,
            category="家常",
            favorite=index == 0,
            created_by=actor.id,
            updated_by=actor.id,
        )
        for index in range(6)
    ]
    ready_foods = [
        Food(
            id=f"food-policy-ready-{food_type.value}",
            family_id=family.id,
            name=f"可采购{food_type.value}",
            type=food_type.value,
            category="成品",
            stock_unit="盒",
            created_by=actor.id,
            updated_by=actor.id,
        )
        for food_type in (FoodType.READY_MADE, FoodType.INSTANT, FoodType.PACKAGED)
    ]
    unsafe_food = Food(
        id="food-policy-unsafe",
        family_id=family.id,
        name="堂食",
        type=FoodType.DINING_OUT.value,
        category="外食",
        created_by=actor.id,
        updated_by=actor.id,
    )
    other_family_food = Food(
        id="food-policy-cross-family",
        family_id=other_family.id,
        name="其他家庭食物",
        type=FoodType.PACKAGED.value,
        category="成品",
    )
    db.add_all([*tracked_ingredients, non_tracked, *foods, *ready_foods, unsafe_food, other_family_food])
    db.flush()

    meal = MealLog(
        id="meal-policy",
        family_id=family.id,
        date=today_for_family(family.id),
        meal_type=MealType.LUNCH,
        participant_user_ids=[actor.id],
        created_by=other.id,
        updated_by=other.id,
    )
    meal_entries = [
        MealLogFood(
            id=f"meal-entry-policy-{index}",
            meal_log_id=meal.id,
            food_id=food.id,
            servings=Decimal("1"),
            rating=Decimal("3") if index == 0 else None,
        )
        for index, food in enumerate(foods)
    ]
    forbidden_meal = MealLog(
        id="meal-policy-forbidden",
        family_id=family.id,
        date=today_for_family(family.id),
        meal_type=MealType.DINNER,
        participant_user_ids=[other.id],
        created_by=other.id,
        updated_by=other.id,
    )
    forbidden_entry = MealLogFood(
        id="meal-entry-policy-forbidden",
        meal_log_id=forbidden_meal.id,
        food_id=foods[0].id,
        servings=Decimal("1"),
    )
    shopping_pending = ShoppingListItem(
        id="shopping-policy-pending",
        family_id=family.id,
        ingredient_id=tracked_ingredients[0].id,
        title=tracked_ingredients[0].name,
        quantity=Decimal("2"),
        unit="个",
        quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        reason="旧备注",
        done=False,
        created_by=actor.id,
        updated_by=actor.id,
    )
    shopping_done = ShoppingListItem(
        id="shopping-policy-done",
        family_id=family.id,
        ingredient_id=tracked_ingredients[1].id,
        title=tracked_ingredients[1].name,
        quantity=Decimal("3"),
        unit="个",
        quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
        reason="",
        done=True,
        created_by=actor.id,
        updated_by=actor.id,
    )
    shopping_non_tracked = ShoppingListItem(
        id="shopping-policy-presence",
        family_id=family.id,
        ingredient_id=non_tracked.id,
        title=non_tracked.name,
        quantity=Decimal("1"),
        unit=non_tracked.default_unit,
        quantity_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
        display_label="需要补充",
        reason="",
        done=False,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add_all([
        meal,
        *meal_entries,
        forbidden_meal,
        forbidden_entry,
        shopping_pending,
        shopping_done,
        shopping_non_tracked,
    ])
    db.commit()
    return PolicySeed(
        db=db,
        family_id=family.id,
        actor_id=actor.id,
        other_member_id=other.id,
        food_ids=tuple(food.id for food in foods),
        tracked_ingredient_ids=tuple(item.id for item in tracked_ingredients),
        non_tracked_ingredient_id=non_tracked.id,
        ready_food_ids=tuple(item.id for item in ready_foods),
        unsafe_food_id=unsafe_food.id,
        meal_log_id=meal.id,
        meal_entry_ids=tuple(item.id for item in meal_entries),
        forbidden_meal_log_id=forbidden_meal.id,
        shopping_pending_id=shopping_pending.id,
        shopping_done_id=shopping_done.id,
        shopping_non_tracked_id=shopping_non_tracked.id,
    )


def _authorization() -> EffectiveAuthorization:
    return EffectiveAuthorization(True, "member_preference", {"member_preference_version": 1}, ())


def _action_message(action_key: str, payload: dict[str, Any]) -> str:
    if action_key == "food.set_favorite":
        return "收藏这个" if payload["payload"]["favorite"] else "取消收藏这个"
    if action_key == "meal_log.rate_food":
        return "给这些食物打 5 分"
    if action_key == "shopping_list.safe_write":
        operations = payload.get("operations") or []
        action = operations[0].get("action") if operations else "create"
        if action == "update":
            return "修改购物项"
        if action == "set_done":
            return "恢复购物项"
        return "买这些食材"
    if action_key == "meal_log.simple_create":
        return "记录一下今天午餐"
    if action_key == "meal_plan.simple_create":
        return "把这些安排到计划"
    raise AssertionError(action_key)


def _evaluate(
    seed: PolicySeed,
    *,
    draft_type: str,
    payload: dict[str, Any],
    message: str | None = None,
    action_quote: str | None = None,
    omitted_fields: set[str] | None = None,
    source_value_overrides: dict[str, Any] | None = None,
):
    policy = auto_execution_policy_registry.resolve_policy(draft_type=draft_type, payload=payload)
    assert policy is not None
    requirements = policy.evidence_requirements(
        db=seed.db,
        family_id=seed.family_id,
        actor_user_id=seed.actor_id,
        payload=payload,
    )
    omitted_fields = omitted_fields or set()
    action_fields = [item.field for item in requirements if item.matcher_key == "explicit_action" and item.field not in omitted_fields]
    fact_requirements = [item for item in requirements if item.matcher_key != "explicit_action" and item.field not in omitted_fields]
    facts = {item.field: item.expected_value for item in fact_requirements}
    facts.update(source_value_overrides or {})
    evidence_input = {
        "intentClarity": "explicit_complete",
        "sourceQuotes": ([{
            "fields": action_fields,
            "text": action_quote or message or _action_message(policy.key, payload),
        }] if action_fields else []),
        "resolutionSources": ([{
            "fields": [item.field for item in fact_requirements],
            "kind": "conversation_artifact",
            "referenceId": "artifact-policy-evidence",
            "entityId": "artifact-policy-subject",
            "rowVersion": 1,
        }] if fact_requirements else []),
        "ambiguityCodes": [],
        "defaultedFields": [],
    }
    trusted_sources = {
        "artifact-policy-evidence": TrustedResolutionSource(
            kind="conversation_artifact",
            reference_id="artifact-policy-evidence",
            family_id=seed.family_id,
            entity_versions={"artifact-policy-subject": 1},
            entity_values={"artifact-policy-subject": facts},
        )
    }
    return auto_execution_policy_registry.evaluate_draft(
        db=seed.db,
        family_id=seed.family_id,
        actor_user_id=seed.actor_id,
        draft_type=draft_type,
        payload=payload,
        evidence_input=evidence_input,
        current_message=message or _action_message(policy.key, payload),
        trusted_resolution_sources=trusted_sources,
        authorization=_authorization(),
        auto_execution_attempted=False,
        has_continuation=False,
        is_composite=False,
        has_external_side_effect=False,
        registered_revert_adapters=REVERT_ADAPTER_KEYS,
    )


def _no_change_context(seed: PolicySeed, *, draft_type: str, payload: dict[str, Any]) -> AutoExecutionPolicyContext:
    evidence, decision = _evaluate(seed, draft_type=draft_type, payload=payload)
    assert decision.route == "no_change"
    return AutoExecutionPolicyContext(
        db=seed.db,
        family_id=seed.family_id,
        actor_user_id=seed.actor_id,
        draft_type=draft_type,
        payload=payload,
        evidence=evidence,
        authorization=_authorization(),
        auto_execution_attempted=False,
        has_continuation=False,
        is_composite=False,
        has_external_side_effect=False,
        registered_revert_adapters=REVERT_ADAPTER_KEYS,
    )


def _favorite(seed: PolicySeed, *, favorite: bool, target_id: str | None = None) -> dict[str, Any]:
    food = seed.db.get(Food, target_id or seed.food_ids[0])
    assert food is not None
    return normalize_food_profile_draft_for_tools(seed.db, family_id=seed.family_id, payload={
        "draftType": "food_profile",
        "schemaVersion": "food_profile_operation.v1",
        "action": "set_favorite",
        "targetId": food.id,
        "baseUpdatedAt": food.updated_at.isoformat(),
        "payload": {"favorite": favorite},
    })


def _rating(seed: PolicySeed, *, count: int, target_id: str | None = None, value: float | None = 5) -> dict[str, Any]:
    meal_id = target_id or seed.meal_log_id
    meal = seed.db.scalar(
        select(MealLog).where(MealLog.id == meal_id).options(selectinload(MealLog.food_entries))
    )
    assert meal is not None
    return normalize_meal_log_draft(seed.db, family_id=seed.family_id, user_id=seed.actor_id, payload={
        "draftType": "meal_log",
        "schemaVersion": "meal_log_operation.v1",
        "action": "rate_food",
        "targetId": meal.id,
        "baseUpdatedAt": meal.updated_at.isoformat(),
        "payload": {
            "foodEntryRatings": [
                {"id": entry.id, "rating": value}
                for entry in meal.food_entries[:count]
            ]
        },
    })


def _plain_shopping(seed: PolicySeed, *, count: int, non_tracked: bool = False) -> dict[str, Any]:
    ingredient_ids = (
        [seed.non_tracked_ingredient_id]
        if non_tracked
        else list(seed.tracked_ingredient_ids[:count])
    )
    return normalize_shopping_list_draft(seed.db, family_id=seed.family_id, conversation_id="conversation", payload={
        "draftType": "shopping_list",
        "schemaVersion": "shopping_list.v1",
        "items": [
            {
                "title": f"item-{index}",
                "ingredient_id": ingredient_id,
                **({} if non_tracked else {"quantity": index + 1, "unit": "个"}),
            }
            for index, ingredient_id in enumerate(ingredient_ids)
        ],
    })


def _operation_shopping_create(seed: PolicySeed, *, count: int) -> dict[str, Any]:
    return normalize_shopping_list_draft(seed.db, family_id=seed.family_id, conversation_id="conversation", payload={
        "draftType": "shopping_list",
        "schemaVersion": "shopping_list_operation.v1",
        "operations": [
            {
                "operationId": f"operation-{index}",
                "action": "create",
                "payload": {
                    "title": f"item-{index}",
                    "ingredient_id": ingredient_id,
                    "quantity": index + 1,
                    "unit": "个",
                },
            }
            for index, ingredient_id in enumerate(seed.tracked_ingredient_ids[:count])
        ],
    })


def _shopping_update(seed: PolicySeed, *, target_id: str | None = None) -> dict[str, Any]:
    item = seed.db.get(ShoppingListItem, target_id or seed.shopping_pending_id)
    assert item is not None
    return normalize_shopping_list_draft(seed.db, family_id=seed.family_id, conversation_id="conversation", payload={
        "draftType": "shopping_list",
        "schemaVersion": "shopping_list_operation.v1",
        "operations": [{
            "operationId": "operation-update",
            "action": "update",
            "targetId": item.id,
            "baseUpdatedAt": item.updated_at.isoformat(),
            "payload": {
                "title": item.title,
                "ingredient_id": item.ingredient_id,
                "food_id": item.food_id,
                "quantity": float(item.quantity) + 1,
                "unit": item.unit,
                "reason": "新备注",
            },
        }],
    })


def _shopping_restore(seed: PolicySeed, *, target_ids: list[str] | None = None) -> dict[str, Any]:
    ids = target_ids or [seed.shopping_done_id]
    operations = []
    for index, target_id in enumerate(ids):
        item = seed.db.get(ShoppingListItem, target_id)
        assert item is not None
        operations.append({
            "operationId": f"operation-restore-{index}",
            "action": "set_done",
            "targetId": item.id,
            "baseUpdatedAt": item.updated_at.isoformat(),
            "payload": {"done": False},
        })
    return normalize_shopping_list_draft(seed.db, family_id=seed.family_id, conversation_id="conversation", payload={
        "draftType": "shopping_list",
        "schemaVersion": "shopping_list_operation.v1",
        "operations": operations,
    })


def _simple_meal(seed: PolicySeed, *, count: int) -> dict[str, Any]:
    return normalize_meal_log_draft(seed.db, family_id=seed.family_id, user_id=seed.actor_id, payload={
        "draftType": "meal_log",
        "schemaVersion": "meal_log.v1",
        "date": today_for_family(seed.family_id).isoformat(),
        "mealType": "lunch",
        "participantUserIds": [seed.actor_id],
        "foods": [
            {"foodId": food_id, "servings": index + 1}
            for index, food_id in enumerate(seed.food_ids[:count])
        ],
    })


def _simple_plan(seed: PolicySeed, *, count: int, start_offset: int = 10) -> dict[str, Any]:
    today = today_for_family(seed.family_id)
    return normalize_meal_plan_draft(seed.db, family_id=seed.family_id, user_id=seed.actor_id, payload={
        "draftType": "meal_plan",
        "schemaVersion": "meal_plan.v1",
        "items": [
            {
                "date": (today + timedelta(days=start_offset + index)).isoformat(),
                "mealType": "dinner",
                "title": f"plan-{index}",
                "foodId": food_id,
            }
            for index, food_id in enumerate(seed.food_ids[:count])
        ],
    })


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("simple_meal", "我打算记录一下今天午餐吃了番茄炒蛋"),
        ("simple_plan", "我打算把明晚的番茄炒蛋安排到计划"),
        ("simple_meal", "为什么要记录一下今天午餐？"),
        ("simple_plan", "为什么要把明晚的番茄炒蛋安排到计划？"),
        ("favorite", "这个已经收藏了"),
        ("rating", "为什么给这道菜打 5 分？"),
        ("shopping_update", "为什么要修改购物项？"),
        ("rating_cancel", "为什么要取消这道菜的评分？"),
    ],
)
def test_action_descriptions_and_questions_require_manual_confirmation(
    policy_seed: PolicySeed,
    case: str,
    message: str,
) -> None:
    if case == "favorite":
        draft_type, payload = "food_profile", _favorite(policy_seed, favorite=True)
    elif case == "rating":
        draft_type, payload = "meal_log", _rating(policy_seed, count=1)
    elif case == "rating_cancel":
        draft_type, payload = "meal_log", _rating(policy_seed, count=1, value=None)
    elif case == "shopping_update":
        draft_type, payload = "shopping_list", _shopping_update(policy_seed)
    elif case == "simple_meal":
        draft_type, payload = "meal_log", _simple_meal(policy_seed, count=1)
    elif case == "simple_plan":
        draft_type, payload = "meal_plan", _simple_plan(policy_seed, count=1)
    else:
        raise AssertionError(case)

    _, decision = _evaluate(
        policy_seed,
        draft_type=draft_type,
        payload=payload,
        message=message,
    )

    assert decision.route == "manual_confirmation"
    assert "source_value_unverifiable" in decision.reason_codes


@pytest.mark.parametrize(
    ("case", "message", "action_quote"),
    [
        ("favorite", "请复述：这个收藏了", "这个收藏了"),
        ("rating", "请总结：给这道菜打 5 分", "给这道菜打 5 分"),
        ("rating_cancel", "请翻译：取消这道菜的评分", "取消这道菜的评分"),
        ("shopping_update", "请解释：修改购物项", "修改购物项"),
        ("simple_meal", "请复述：记录一下今天午餐", "记录一下今天午餐"),
        ("simple_plan", "请总结：把明晚的番茄炒蛋安排到计划", "把明晚的番茄炒蛋安排到计划"),
    ],
)
def test_meta_requests_wrapping_action_quotes_require_manual_confirmation(
    policy_seed: PolicySeed,
    case: str,
    message: str,
    action_quote: str,
) -> None:
    if case == "favorite":
        draft_type, payload = "food_profile", _favorite(policy_seed, favorite=True)
    elif case == "rating":
        draft_type, payload = "meal_log", _rating(policy_seed, count=1)
    elif case == "rating_cancel":
        draft_type, payload = "meal_log", _rating(policy_seed, count=1, value=None)
    elif case == "shopping_update":
        draft_type, payload = "shopping_list", _shopping_update(policy_seed)
    elif case == "simple_meal":
        draft_type, payload = "meal_log", _simple_meal(policy_seed, count=1)
    elif case == "simple_plan":
        draft_type, payload = "meal_plan", _simple_plan(policy_seed, count=1)
    else:
        raise AssertionError(case)

    _, decision = _evaluate(
        policy_seed,
        draft_type=draft_type,
        payload=payload,
        message=message,
        action_quote=action_quote,
    )

    assert decision.route == "manual_confirmation"
    assert "source_value_unverifiable" in decision.reason_codes


@pytest.mark.parametrize("favorite", [True, False])
def test_favorite_policy_allows_only_exact_state_change(policy_seed: PolicySeed, favorite: bool) -> None:
    payload = _favorite(policy_seed, favorite=favorite)
    _, decision = _evaluate(policy_seed, draft_type="food_profile", payload=payload)
    current = policy_seed.db.get(Food, policy_seed.food_ids[0])
    assert current is not None
    assert decision.route == ("no_change" if current.favorite == favorite else "auto_execute")
    assert decision.policy_version == "food.set_favorite.v1"


def test_favorite_policy_rejects_extra_fields_or_cross_family(policy_seed: PolicySeed) -> None:
    extra = _favorite(policy_seed, favorite=False)
    extra["payload"]["notes"] = "x"
    _, extra_decision = _evaluate(policy_seed, draft_type="food_profile", payload=extra)
    stale = _favorite(policy_seed, favorite=False)
    stale["baseUpdatedAt"] = "2020-01-01T00:00:00+00:00"
    _, stale_decision = _evaluate(policy_seed, draft_type="food_profile", payload=stale)
    cross = deepcopy(stale)
    cross["targetId"] = "food-policy-cross-family"
    _, cross_decision = _evaluate(policy_seed, draft_type="food_profile", payload=cross)
    assert extra_decision.route == "manual_confirmation"
    assert stale_decision.route == "auto_execute"
    assert cross_decision.route == "manual_confirmation"


def test_favorite_policy_ignores_stale_entity_timestamp_for_explicit_set(policy_seed: PolicySeed) -> None:
    payload = _favorite(policy_seed, favorite=False)
    payload["baseUpdatedAt"] = "2020-01-01T00:00:00+00:00"

    _, decision = _evaluate(policy_seed, draft_type="food_profile", payload=payload)

    assert decision.route == "auto_execute"


def test_safe_mutation_normalizers_own_base_updated_at(policy_seed: PolicySeed) -> None:
    food = policy_seed.db.get(Food, policy_seed.food_ids[0])
    meal = policy_seed.db.get(MealLog, policy_seed.meal_log_id)
    shopping = policy_seed.db.get(ShoppingListItem, policy_seed.shopping_pending_id)
    assert food is not None and meal is not None and shopping is not None

    favorite = normalize_food_profile_draft_for_tools(
        policy_seed.db,
        family_id=policy_seed.family_id,
        payload={
            "draftType": "food_profile",
            "schemaVersion": "food_profile_operation.v1",
            "action": "set_favorite",
            "targetId": food.id,
            "payload": {"favorite": False},
        },
    )
    rating = normalize_meal_log_draft(
        policy_seed.db,
        family_id=policy_seed.family_id,
        user_id=policy_seed.actor_id,
        payload={
            "draftType": "meal_log",
            "schemaVersion": "meal_log_operation.v1",
            "action": "rate_food",
            "targetId": meal.id,
            "payload": {"foodEntryRatings": [{"id": policy_seed.meal_entry_ids[0], "rating": 5}]},
        },
    )
    restored = normalize_shopping_list_draft(
        policy_seed.db,
        family_id=policy_seed.family_id,
        conversation_id="conversation",
        payload={
            "draftType": "shopping_list",
            "schemaVersion": "shopping_list_operation.v1",
            "operations": [{
                "operationId": "restore-without-version",
                "action": "set_done",
                "targetId": policy_seed.shopping_done_id,
                "payload": {"done": False},
            }],
        },
    )

    assert favorite["baseUpdatedAt"] == food.updated_at.isoformat()
    assert rating["baseUpdatedAt"] == meal.updated_at.isoformat()
    assert restored["operations"][0]["baseUpdatedAt"] == policy_seed.db.get(
        ShoppingListItem, policy_seed.shopping_done_id
    ).updated_at.isoformat()


def test_rating_policy_ignores_unrelated_meal_log_changes(policy_seed: PolicySeed) -> None:
    payload = _rating(policy_seed, count=1)
    meal = policy_seed.db.get(MealLog, policy_seed.meal_log_id)
    assert meal is not None
    meal.notes = "用户在草稿生成后补充的备注"
    policy_seed.db.commit()

    _, decision = _evaluate(policy_seed, draft_type="meal_log", payload=payload)

    assert decision.route == "auto_execute"


def test_policy_registry_exposes_action_level_concurrency_strategies(policy_seed: PolicySeed) -> None:
    cases = (
        ("food_profile", _favorite(policy_seed, favorite=False), "idempotent_set"),
        ("meal_log", _rating(policy_seed, count=1), "field_patch"),
        ("shopping_list", _plain_shopping(policy_seed, count=1), "insert"),
        ("meal_log", _simple_meal(policy_seed, count=1), "insert"),
        ("meal_plan", _simple_plan(policy_seed, count=1), "insert"),
    )
    for draft_type, payload, expected in cases:
        policy = auto_execution_policy_registry.resolve_policy(draft_type=draft_type, payload=payload)
        assert policy is not None
        assert auto_execution_policy_registry.concurrency_strategy(
            policy_key=policy.key,
            draft_type=draft_type,
            payload=payload,
        ) == expected


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_rating_policy_hard_limits(policy_seed: PolicySeed, count: int, expected: str) -> None:
    payload = _rating(policy_seed, count=count)
    _, decision = _evaluate(policy_seed, draft_type="meal_log", payload=payload)
    assert decision.route == expected


def test_rating_policy_requires_creator_or_participant_and_exact_fields(policy_seed: PolicySeed) -> None:
    forbidden = _rating(policy_seed, count=1, target_id=policy_seed.forbidden_meal_log_id)
    _, forbidden_decision = _evaluate(policy_seed, draft_type="meal_log", payload=forbidden)
    extra = _rating(policy_seed, count=1)
    extra["payload"]["notes"] = "x"
    _, extra_decision = _evaluate(policy_seed, draft_type="meal_log", payload=extra)
    assert forbidden_decision.route == "manual_confirmation"
    assert extra_decision.route == "manual_confirmation"


def test_rating_policy_returns_no_change_only_when_every_rating_is_satisfied(policy_seed: PolicySeed) -> None:
    one = _rating(policy_seed, count=1, value=3)
    _, no_change = _evaluate(policy_seed, draft_type="meal_log", payload=one)
    partial = _rating(policy_seed, count=2, value=3)
    _, partial_decision = _evaluate(policy_seed, draft_type="meal_log", payload=partial)
    assert no_change.route == "no_change"
    assert partial_decision.route == "manual_confirmation"


def test_rating_no_change_lock_is_family_scoped_and_uses_meal_log_lock_order(policy_seed: PolicySeed) -> None:
    payload = _rating(policy_seed, count=1, value=3)
    policy = auto_execution_policy_registry.resolve_policy(draft_type="meal_log", payload=payload)
    assert policy is not None
    context = _no_change_context(policy_seed, draft_type="meal_log", payload=payload)
    from app.services.ai_auto_execution.policies import meal_rating

    real_lock = meal_rating.lock_meal_log_write_targets
    with patch.object(meal_rating, "lock_meal_log_write_targets", wraps=real_lock) as lock:
        assert policy.lock_no_change_targets(context)

    lock.assert_called_once_with(
        policy_seed.db,
        family_id=policy_seed.family_id,
        meal_log_id=policy_seed.meal_log_id,
    )


def test_rating_policy_domain_allows_explicit_cancellation(policy_seed: PolicySeed) -> None:
    payload = _rating(policy_seed, count=1, value=None)
    _, decision = _evaluate(
        policy_seed,
        draft_type="meal_log",
        payload=payload,
        message="取消这些食物的评分",
    )
    assert decision.route == "auto_execute"


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_plain_shopping_create_hard_limits(policy_seed: PolicySeed, count: int, expected: str) -> None:
    payload = _plain_shopping(policy_seed, count=count)
    _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
    assert decision.route == expected


def test_shopping_requirement_shapes_are_concrete_and_mode_specific(policy_seed: PolicySeed) -> None:
    cases = [
        (
            _plain_shopping(policy_seed, count=2),
            {"action", "items[0].ingredient_id", "items[0].quantity", "items[0].unit", "items[1].ingredient_id", "items[1].quantity", "items[1].unit"},
        ),
        (
            _operation_shopping_create(policy_seed, count=1),
            {"operations[0].action", "operations[0].payload.ingredient_id", "operations[0].payload.quantity", "operations[0].payload.unit"},
        ),
        (
            _shopping_update(policy_seed),
            {"operations[0].action", "operations[0].targetId", "operations[0].payload.quantity", "operations[0].payload.reason"},
        ),
        (
            _shopping_restore(policy_seed),
            {"operations[0].action", "operations[0].targetId", "operations[0].payload.done"},
        ),
    ]
    for payload, expected in cases:
        policy = auto_execution_policy_registry.resolve_policy(draft_type="shopping_list", payload=payload)
        assert policy is not None
        requirements = policy.evidence_requirements(
            db=policy_seed.db,
            family_id=policy_seed.family_id,
            actor_user_id=policy_seed.actor_id,
            payload=payload,
        )
        fields = {item.field for item in requirements}
        assert fields == expected
        assert all("[]" not in field for field in fields)


def test_operation_create_and_restore_do_not_require_nonexistent_fields(policy_seed: PolicySeed) -> None:
    create_payload = _operation_shopping_create(policy_seed, count=1)
    restore_payload = _shopping_restore(policy_seed)
    _, create_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=create_payload)
    _, restore_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=restore_payload)
    assert create_decision.route == "auto_execute"
    assert restore_decision.route == "auto_execute"


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_operation_shopping_create_hard_limits(policy_seed: PolicySeed, count: int, expected: str) -> None:
    payload = _operation_shopping_create(policy_seed, count=count)
    _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
    assert decision.route == expected


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_shopping_restore_hard_limits(policy_seed: PolicySeed, count: int, expected: str) -> None:
    items = [
        ShoppingListItem(
            id=f"shopping-policy-restore-{index}",
            family_id=policy_seed.family_id,
            ingredient_id=policy_seed.tracked_ingredient_ids[index],
            title=f"食材{index}",
            quantity=Decimal(index + 1),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="",
            done=True,
            created_by=policy_seed.actor_id,
            updated_by=policy_seed.actor_id,
        )
        for index in range(count)
    ]
    policy_seed.db.add_all(items)
    policy_seed.db.commit()
    payload = _shopping_restore(policy_seed, target_ids=[item.id for item in items])
    _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
    assert decision.route == expected


def test_shopping_update_and_restore_no_change_are_all_or_nothing(policy_seed: PolicySeed) -> None:
    update = _shopping_update(policy_seed)
    target = policy_seed.db.get(ShoppingListItem, policy_seed.shopping_pending_id)
    assert target is not None
    _, update_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=update)
    unchanged = deepcopy(update)
    unchanged["operations"][0]["payload"]["quantity"] = float(target.quantity)
    unchanged["operations"][0]["payload"]["reason"] = target.reason
    _, unchanged_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=unchanged)
    partial_restore = _shopping_restore(
        policy_seed,
        target_ids=[policy_seed.shopping_done_id, policy_seed.shopping_pending_id],
    )
    _, partial_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=partial_restore)
    assert update_decision.route == "auto_execute"
    assert unchanged_decision.route == "no_change"
    assert partial_decision.route == "manual_confirmation"


def test_shopping_no_change_lock_collects_family_targets_in_stable_id_order(policy_seed: PolicySeed) -> None:
    second = policy_seed.db.get(ShoppingListItem, policy_seed.shopping_done_id)
    first = policy_seed.db.get(ShoppingListItem, policy_seed.shopping_pending_id)
    assert first is not None and second is not None
    second.done = False
    policy_seed.db.commit()
    payload = _shopping_restore(
        policy_seed,
        target_ids=[second.id, first.id],
    )
    policy = auto_execution_policy_registry.resolve_policy(draft_type="shopping_list", payload=payload)
    assert policy is not None
    context = _no_change_context(policy_seed, draft_type="shopping_list", payload=payload)
    from app.services.ai_auto_execution.policies import shopping_safe_write

    real_lock = shopping_safe_write.lock_inventory_targets
    with patch.object(shopping_safe_write, "lock_inventory_targets", wraps=real_lock) as lock:
        assert policy.lock_no_change_targets(context)

    lock.assert_called_once_with(
        policy_seed.db,
        family_id=policy_seed.family_id,
        ingredient_ids=tuple(sorted((first.ingredient_id, second.ingredient_id))),
        food_ids=(),
        shopping_item_ids=tuple(sorted((first.id, second.id))),
    )


def test_non_tracked_shopping_uses_server_fixed_representation_without_quantity_evidence(policy_seed: PolicySeed) -> None:
    payload = _plain_shopping(policy_seed, count=1, non_tracked=True)
    policy = auto_execution_policy_registry.resolve_policy(draft_type="shopping_list", payload=payload)
    assert policy is not None
    requirements = policy.evidence_requirements(
        db=policy_seed.db,
        family_id=policy_seed.family_id,
        actor_user_id=policy_seed.actor_id,
        payload=payload,
    )
    assert {item.field for item in requirements} == {"action", "items[0].ingredient_id"}
    _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
    tampered = deepcopy(payload)
    tampered["items"][0]["display_label"] = "模型默认"
    _, tampered_decision = _evaluate(policy_seed, draft_type="shopping_list", payload=tampered)
    assert decision.route == "auto_execute"
    assert tampered_decision.route == "manual_confirmation"


def test_shopping_rejects_mixed_delete_done_true_target_replacement_and_extra_diff(policy_seed: PolicySeed) -> None:
    mixed = _operation_shopping_create(policy_seed, count=2)
    restore = _shopping_restore(policy_seed)
    mixed["operations"][1] = restore["operations"][0]
    delete = _shopping_restore(policy_seed)
    delete["operations"][0]["action"] = "delete"
    done = _shopping_restore(policy_seed)
    done["operations"][0]["payload"]["done"] = True
    replacement = _shopping_update(policy_seed)
    replacement["operations"][0]["payload"]["ingredient_id"] = policy_seed.tracked_ingredient_ids[3]
    extra = _shopping_update(policy_seed)
    extra["operations"][0]["payload"]["title"] = "替换标题"
    for payload in (mixed, delete, done, replacement, extra):
        _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
        assert decision.route == "manual_confirmation"


def test_shopping_ready_food_allowlist_is_exact(policy_seed: PolicySeed) -> None:
    for food_id in (*policy_seed.ready_food_ids, policy_seed.unsafe_food_id):
        food = policy_seed.db.get(Food, food_id)
        assert food is not None
        payload = {
            "draftType": "shopping_list",
            "schemaVersion": "shopping_list.v1",
            "items": [{
                "title": food.name,
                "ingredient_id": None,
                "food_id": food.id,
                "quantity": 1.0,
                "unit": "盒",
                "quantity_mode": "track_quantity",
                "display_label": None,
                "reason": "",
            }],
            "sourceDraftId": None,
        }
        _, decision = _evaluate(policy_seed, draft_type="shopping_list", payload=payload)
        expected = "auto_execute" if food_id in policy_seed.ready_food_ids else "manual_confirmation"
        assert decision.route == expected


def test_shopping_evidence_value_mismatch_and_missing_second_item_are_manual(policy_seed: PolicySeed) -> None:
    payload = _plain_shopping(policy_seed, count=2)
    _, mismatch = _evaluate(
        policy_seed,
        draft_type="shopping_list",
        payload=payload,
        source_value_overrides={"items[0].quantity": Decimal("99")},
    )
    _, missing = _evaluate(
        policy_seed,
        draft_type="shopping_list",
        payload=payload,
        omitted_fields={"items[1].ingredient_id", "items[1].quantity", "items[1].unit"},
    )
    assert mismatch.route == "manual_confirmation"
    assert "source_value_mismatch" in mismatch.reason_codes
    assert missing.route == "manual_confirmation"
    assert "intent_evidence_missing" in missing.reason_codes


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_simple_meal_hard_limits_and_indexed_requirements(policy_seed: PolicySeed, count: int, expected: str) -> None:
    payload = _simple_meal(policy_seed, count=count)
    policy = auto_execution_policy_registry.resolve_policy(draft_type="meal_log", payload=payload)
    assert policy is not None
    fields = {item.field for item in policy.evidence_requirements(
        db=policy_seed.db,
        family_id=policy_seed.family_id,
        actor_user_id=policy_seed.actor_id,
        payload=payload,
    )}
    assert "action" in fields and "date" in fields and "mealType" in fields
    assert all(f"foods[{index}].foodId" in fields and f"foods[{index}].servings" in fields for index in range(count))
    _, decision = _evaluate(policy_seed, draft_type="meal_log", payload=payload)
    assert decision.route == expected


def test_simple_meal_never_claims_no_change_or_a_target_lock_contract(policy_seed: PolicySeed) -> None:
    payload = _simple_meal(policy_seed, count=1)
    policy = auto_execution_policy_registry.resolve_policy(draft_type="meal_log", payload=payload)
    assert policy is not None
    evidence, decision = _evaluate(policy_seed, draft_type="meal_log", payload=payload)
    context = AutoExecutionPolicyContext(
        db=policy_seed.db,
        family_id=policy_seed.family_id,
        actor_user_id=policy_seed.actor_id,
        draft_type="meal_log",
        payload=payload,
        evidence=evidence,
        authorization=_authorization(),
        auto_execution_attempted=False,
        has_continuation=False,
        is_composite=False,
        has_external_side_effect=False,
        registered_revert_adapters=REVERT_ADAPTER_KEYS,
    )

    assert decision.route == "auto_execute"
    assert not policy.lock_no_change_targets(context)


def test_simple_meal_rejects_stock_media_plan_participants_and_operation_create(policy_seed: PolicySeed) -> None:
    base = _simple_meal(policy_seed, count=1)
    variants = []
    deduct = deepcopy(base)
    deduct["foods"][0]["deductStock"] = True
    variants.append(deduct)
    media = deepcopy(base)
    media["mediaIds"] = ["media-x"]
    variants.append(media)
    plan = deepcopy(base)
    plan["planItemId"] = "plan-x"
    variants.append(plan)
    participant = deepcopy(base)
    participant["participantUserIds"] = [policy_seed.actor_id, policy_seed.other_member_id]
    variants.append(participant)
    operation = {
        "draftType": "meal_log",
        "schemaVersion": "meal_log_operation.v1",
        "action": "create",
        "payload": base,
    }
    variants.append(operation)
    for payload in variants:
        decision = auto_execution_policy_registry.evaluate(replace(
            AutoExecutionPolicyContext(
                db=policy_seed.db,
                family_id=policy_seed.family_id,
                actor_user_id=policy_seed.actor_id,
                draft_type="meal_log",
                payload=payload,
                evidence=IntentEvidenceValidation("explicit_complete", {}, frozenset(), {}),
                authorization=_authorization(),
                auto_execution_attempted=False,
                has_continuation=False,
                is_composite=False,
                has_external_side_effect=False,
                registered_revert_adapters=REVERT_ADAPTER_KEYS,
            )
        ))
        assert decision.route == "manual_confirmation"


def test_field_complete_meal_statement_without_record_action_is_manual(policy_seed: PolicySeed) -> None:
    payload = _simple_meal(policy_seed, count=1)
    _, decision = _evaluate(
        policy_seed,
        draft_type="meal_log",
        payload=payload,
        message="今天午餐吃了家常菜0，1份",
    )
    assert decision.route == "manual_confirmation"


@pytest.mark.parametrize(("count", "expected"), [(1, "auto_execute"), (5, "auto_execute"), (6, "manual_confirmation")])
def test_simple_plan_hard_limits_and_indexed_requirements(policy_seed: PolicySeed, count: int, expected: str) -> None:
    payload = _simple_plan(policy_seed, count=count)
    policy = auto_execution_policy_registry.resolve_policy(draft_type="meal_plan", payload=payload)
    assert policy is not None
    fields = {item.field for item in policy.evidence_requirements(
        db=policy_seed.db,
        family_id=policy_seed.family_id,
        actor_user_id=policy_seed.actor_id,
        payload=payload,
    )}
    assert "action" in fields
    assert all(
        {f"items[{index}].date", f"items[{index}].mealType", f"items[{index}].foodId"}.issubset(fields)
        for index in range(count)
    )
    _, decision = _evaluate(policy_seed, draft_type="meal_plan", payload=payload)
    assert decision.route == expected


def test_simple_plan_no_change_requires_all_unique_planned_items(policy_seed: PolicySeed) -> None:
    payload = _simple_plan(policy_seed, count=2, start_offset=30)
    for index, item in enumerate(payload["items"]):
        policy_seed.db.add(FoodPlanItem(
            id=f"existing-plan-{index}",
            family_id=policy_seed.family_id,
            user_id=policy_seed.actor_id,
            food_id=item["foodId"],
            plan_date=date.fromisoformat(item["date"]),
            meal_type=MealType(item["mealType"]),
            status="planned",
            created_by=policy_seed.actor_id,
            updated_by=policy_seed.actor_id,
        ))
    policy_seed.db.commit()
    _, all_satisfied = _evaluate(policy_seed, draft_type="meal_plan", payload=payload)
    partial_payload = _simple_plan(policy_seed, count=2, start_offset=30)
    partial_payload["items"][1]["date"] = (date.fromisoformat(partial_payload["items"][1]["date"]) + timedelta(days=20)).isoformat()
    _, partial = _evaluate(policy_seed, draft_type="meal_plan", payload=partial_payload)
    duplicate = _simple_plan(policy_seed, count=2, start_offset=70)
    duplicate["items"][1] = deepcopy(duplicate["items"][0])
    _, duplicate_decision = _evaluate(policy_seed, draft_type="meal_plan", payload=duplicate)
    assert all_satisfied.route == "no_change"
    assert partial.route == "manual_confirmation"
    assert duplicate_decision.route == "manual_confirmation"


def test_simple_plan_no_change_lock_is_family_scoped_and_parent_first(policy_seed: PolicySeed) -> None:
    payload = _simple_plan(policy_seed, count=2, start_offset=90)
    for index, item in enumerate(reversed(payload["items"])):
        policy_seed.db.add(FoodPlanItem(
            id=f"locked-plan-{index}",
            family_id=policy_seed.family_id,
            user_id=policy_seed.actor_id,
            food_id=item["foodId"],
            plan_date=date.fromisoformat(item["date"]),
            meal_type=MealType(item["mealType"]),
            status="planned",
            created_by=policy_seed.actor_id,
            updated_by=policy_seed.actor_id,
        ))
    policy_seed.db.commit()
    policy = auto_execution_policy_registry.resolve_policy(draft_type="meal_plan", payload=payload)
    assert policy is not None
    context = _no_change_context(policy_seed, draft_type="meal_plan", payload=payload)
    from app.services.ai_auto_execution.policies import simple_plan

    real_lock = simple_plan.lock_inventory_targets
    with patch.object(simple_plan, "lock_inventory_targets", wraps=real_lock) as lock:
        assert policy.lock_no_change_targets(context)

    lock.assert_called_once_with(
        policy_seed.db,
        family_id=policy_seed.family_id,
        food_ids=tuple(sorted(item["foodId"] for item in payload["items"])),
    )


def test_simple_plan_rejects_operation_status_and_user_override(policy_seed: PolicySeed) -> None:
    base = _simple_plan(policy_seed, count=1)
    operation = {
        "draftType": "meal_plan",
        "schemaVersion": "meal_plan_operation.v1",
        "operations": [{"action": "set_status", "targetId": "plan", "payload": {"status": "cooked"}}],
        "source": {},
    }
    user_override = deepcopy(base)
    user_override["userId"] = policy_seed.other_member_id
    for payload in (operation, user_override):
        decision = auto_execution_policy_registry.evaluate(AutoExecutionPolicyContext(
            db=policy_seed.db,
            family_id=policy_seed.family_id,
            actor_user_id=policy_seed.actor_id,
            draft_type="meal_plan",
            payload=payload,
            evidence=IntentEvidenceValidation("explicit_complete", {}, frozenset(), {}),
            authorization=_authorization(),
            auto_execution_attempted=False,
            has_continuation=False,
            is_composite=False,
            has_external_side_effect=False,
            registered_revert_adapters=REVERT_ADAPTER_KEYS,
        ))
        assert decision.route == "manual_confirmation"


def test_field_complete_plan_statement_without_add_action_is_manual(policy_seed: PolicySeed) -> None:
    payload = _simple_plan(policy_seed, count=1)
    _, decision = _evaluate(
        policy_seed,
        draft_type="meal_plan",
        payload=payload,
        message="明晚吃家常菜0",
    )
    assert decision.route == "manual_confirmation"


def test_policy_evaluation_has_no_database_write_side_effects(policy_seed: PolicySeed) -> None:
    counts_before = {
        model.__name__: policy_seed.db.scalar(select(func.count(model.id)))
        for model in (Food, MealLog, MealLogFood, ShoppingListItem, FoodPlanItem)
    }
    payloads = [
        ("food_profile", _favorite(policy_seed, favorite=False)),
        ("meal_log", _rating(policy_seed, count=1)),
        ("shopping_list", _plain_shopping(policy_seed, count=1)),
        ("meal_log", _simple_meal(policy_seed, count=1)),
        ("meal_plan", _simple_plan(policy_seed, count=1)),
    ]
    for draft_type, payload in payloads:
        _evaluate(policy_seed, draft_type=draft_type, payload=payload)
    assert not policy_seed.db.new
    assert not policy_seed.db.dirty
    assert not policy_seed.db.deleted
    counts_after = {
        model.__name__: policy_seed.db.scalar(select(func.count(model.id)))
        for model in (Food, MealLog, MealLogFood, ShoppingListItem, FoodPlanItem)
    }
    assert counts_after == counts_before


def test_policy_versions_and_revert_keys_are_server_registered(policy_seed: PolicySeed) -> None:
    cases = {
        "food.set_favorite": ("food_profile", _favorite(policy_seed, favorite=False), "food.favorite.v1"),
        "meal_log.rate_food": ("meal_log", _rating(policy_seed, count=1), "meal_log.rating.v1"),
        "shopping_list.safe_write": (
            "shopping_list",
            _plain_shopping(policy_seed, count=1),
            "shopping_list.safe_write.v1",
        ),
        "meal_log.simple_create": ("meal_log", _simple_meal(policy_seed, count=1), "meal_log.simple_create.v1"),
        "meal_plan.simple_create": ("meal_plan", _simple_plan(policy_seed, count=1), "meal_plan.simple_create.v1"),
    }
    for key, (draft_type, payload, revert_key) in cases.items():
        if key == "food.set_favorite":
            payload["auto_execution_policy_key"] = "attacker.policy"
            payload["revert_adapter_key"] = "attacker.revert"
        policy = auto_execution_policy_registry.resolve_policy(draft_type=draft_type, payload=payload)
        assert policy is not None
        assert policy.key == key
        assert policy.version == f"{key}.v1"
        assert policy.revert_adapter_key == revert_key
