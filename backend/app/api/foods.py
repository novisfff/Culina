from __future__ import annotations

from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, FoodType, MealType
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Food, MealLog, Recipe
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.foods import CreateFoodRequest, FoodOut, FoodRecommendationsOut, UpdateFoodFavoriteRequest, UpdateFoodRequest
from app.services.activity import log_activity
from app.services.clock import now_for_family
from app.services.ingredient_units import UnitConversionError
from app.services.inventory_usage import load_available_inventory_by_ingredient, recipe_availability_summary
from app.services.media import bind_media_assets, replace_media_assets
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.services.search.hybrid import hybrid_search
from app.services.search.indexing import upsert_food_search_document
from app.services.serializers import serialize_food

router = APIRouter(tags=["foods"])


SYNCED_SELF_MADE_MESSAGE = "家常菜由菜谱自动同步"
READY_LIKE_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value}
OUTSIDE_TYPES = {FoodType.TAKEOUT.value, FoodType.DINING_OUT.value}
POSITIVE_REASON_LABELS = {
    "target_meal": "适合{meal}",
    "meal_needed": "今天还没吃{meal}",
    "regular_meal": "适合正餐",
    "favorite": "已收藏",
    "frequent": "常吃",
    "high_rating": "高评分",
    "repurchase": "愿意复购",
    "expiring_today": "今天到期",
    "expiring_soon": "{days} 天内到期",
    "recipe_ready": "家里可直接做",
    "recipe_partial": "食材基本够",
    "quick_recipe": "20 分钟内",
    "fresh_gap": "最近没吃过",
}


def _merge_tags(*groups: list[str] | tuple[str, ...] | None) -> list[str]:
    tags: list[str] = []
    for group in groups:
        for value in group or []:
            tag = str(value).strip()
            if tag and tag not in tags:
                tags.append(tag)
    return tags


def _normalize_meal_type_value(value: MealType | str) -> str:
    return value.value if isinstance(value, MealType) else value


def _resolve_target_meal_type(now: datetime, meal_logs: list[MealLog], meal_type: MealType | None) -> MealType:
    if meal_type is not None:
        return meal_type
    current_time = now.time()
    if time(4, 0) <= current_time < time(9, 30):
        target = MealType.BREAKFAST
    elif time(9, 30) <= current_time < time(13, 30):
        target = MealType.LUNCH
    elif time(13, 30) <= current_time < time(20, 30):
        target = MealType.DINNER
    else:
        target = MealType.SNACK
    if any(log.date == now.date() and _normalize_meal_type_value(log.meal_type) == target.value for log in meal_logs):
        return {
            MealType.BREAKFAST: MealType.LUNCH,
            MealType.LUNCH: MealType.DINNER,
            MealType.DINNER: MealType.SNACK,
            MealType.SNACK: MealType.BREAKFAST,
        }[target]
    return target


def _food_usage(food: Food, meal_logs: list[MealLog], today: date) -> tuple[int, int, date | None, bool]:
    count_90_days = 0
    last_used: date | None = None
    eaten_today = False
    window_start = today - timedelta(days=90)
    for log in meal_logs:
        if not any(entry.food_id == food.id for entry in log.food_entries):
            continue
        if window_start <= log.date <= today:
            count_90_days += 1
        if last_used is None or log.date > last_used:
            last_used = log.date
        if log.date == today:
            eaten_today = True
    days_since = (today - last_used).days if last_used is not None else 999
    return count_90_days, days_since, last_used, eaten_today


def _days_until(value: date | None, today: date) -> int | None:
    return None if value is None else (value - today).days


def _food_has_missing_decision_info(food: Food) -> bool:
    food_type = food.type.value if hasattr(food.type, "value") else food.type
    if not food.suitable_meal_types:
        return True
    if food_type != FoodType.SELF_MADE.value and not food.source_name.strip() and not food.purchase_source.strip():
        return True
    if not food.routine_note.strip() and not food.notes.strip() and not food.scene.strip() and not (food.scene_tags or []):
        return True
    if food_type in READY_LIKE_TYPES and (food.stock_quantity is None or food.stock_quantity <= 0 or not food.stock_unit.strip() or food.expiry_date is None):
        return True
    return False


def _reason_text(key: str, *, target_meal_type: MealType, days: int | None = None) -> str:
    template = POSITIVE_REASON_LABELS[key]
    meal_labels = {
        MealType.BREAKFAST: "早餐",
        MealType.LUNCH: "午餐",
        MealType.DINNER: "晚餐",
        MealType.SNACK: "加餐",
    }
    return template.format(meal=meal_labels[target_meal_type], days=days or 0)


def _score_food(
    *,
    food: Food,
    meal_logs: list[MealLog],
    target_meal_type: MealType,
    target_date: date,
    recipe_availability_by_id: dict[str, dict],
) -> dict:
    food_type = food.type.value if hasattr(food.type, "value") else food.type
    target_meal_value = target_meal_type.value
    suitable_meals = [_normalize_meal_type_value(item) for item in (food.suitable_meal_types or [])]
    score = 0.0
    reason_scores: list[tuple[float, str]] = []
    recipe_availability = None

    def add(value: float, reason_key: str | None = None, days: int | None = None) -> None:
        nonlocal score
        score += value
        if reason_key and value > 0:
            reason_scores.append((value, _reason_text(reason_key, target_meal_type=target_meal_type, days=days)))

    if target_meal_value in suitable_meals:
        add(180, "target_meal")
    elif target_meal_type in {MealType.LUNCH, MealType.DINNER} and any(item in {"lunch", "dinner"} for item in suitable_meals):
        add(50, "regular_meal")

    target_meal_missing = not any(log.date == target_date and _normalize_meal_type_value(log.meal_type) == target_meal_type.value for log in meal_logs)
    if target_meal_missing:
        add(60, "meal_needed")

    usage_count, days_since, _, eaten_today = _food_usage(food, meal_logs, target_date)
    if eaten_today:
        add(-220)
    elif days_since <= 1:
        add(-160)
    elif days_since <= 3:
        add(-90)
    elif days_since <= 7:
        add(-35)
    elif days_since >= 8 and usage_count > 0:
        add(25, "fresh_gap")

    if food.favorite:
        add(70, "favorite")
    if usage_count >= 3:
        add(45, "frequent")
    if food.rating is not None and food.rating >= 4:
        add(55, "high_rating")
    elif food.rating is not None and food.rating < 3:
        add(-20)
    if food.repurchase is True:
        add(45, "repurchase")
    elif food.repurchase is False:
        add(-140)

    if food_type in READY_LIKE_TYPES:
        days = _days_until(food.expiry_date, target_date)
        if food.stock_quantity is not None and food.stock_quantity <= 0:
            add(-180)
        if days is not None:
            if days <= 0:
                add(260, "expiring_today")
            elif days <= 3:
                add(220, "expiring_soon", days=days)
            elif days <= 7:
                add(150, "expiring_soon", days=days)

    if food_type == FoodType.SELF_MADE.value:
        if food.recipe is None:
            add(-90)
        else:
            recipe_availability = recipe_availability_by_id.get(food.recipe.id)
            if recipe_availability["availability"] == "ready":
                add(130, "recipe_ready")
            elif recipe_availability["availability"] == "partial":
                add(40, "recipe_partial")
            else:
                add(-90)
            if food.recipe.prep_minutes <= 20:
                add(35, "quick_recipe")

    if _food_has_missing_decision_info(food):
        add(-35)

    primary_action = (
        "cook_recipe"
        if food_type == FoodType.SELF_MADE.value and food.recipe_id
        else "quick_add_meal"
        if food_type in OUTSIDE_TYPES or food_type in READY_LIKE_TYPES
        else "review_food"
    )
    reasons = [reason for _, reason in sorted(reason_scores, key=lambda item: item[0], reverse=True)]
    deduped_reasons = list(dict.fromkeys(reasons))[:3] or ["可作为备选"]
    return {
        "food": food,
        "score": score,
        "reasons": deduped_reasons,
        "primary_action": primary_action,
        "recipe_availability": recipe_availability,
        "food_type": food_type,
        "is_expiring": food_type in READY_LIKE_TYPES and (_days_until(food.expiry_date, target_date) is not None and (_days_until(food.expiry_date, target_date) or 0) <= 7),
    }


def _recommendation_bucket(food_type: str) -> str:
    if food_type == FoodType.SELF_MADE.value:
        return "selfMade"
    if food_type in OUTSIDE_TYPES:
        return "outside"
    if food_type in READY_LIKE_TYPES:
        return "ready"
    return food_type


def _diversify_recommendations(scored: list[dict], limit: int) -> list[dict]:
    if limit <= 3:
        return scored[:limit]
    expiring = [item for item in scored if item["is_expiring"]]
    selected: list[dict] = []
    for item in expiring[:3]:
        if item not in selected:
            selected.append(item)
    for bucket in ["selfMade", "outside", "ready"]:
        if len(selected) >= 3:
            break
        candidate = next((item for item in scored if item not in selected and _recommendation_bucket(item["food_type"]) == bucket), None)
        if candidate:
            selected.append(candidate)
    for item in scored:
        if len(selected) >= limit:
            break
        if item not in selected:
            selected.append(item)
    return selected[:limit]


def _reject_synced_food_payload(payload: CreateFoodRequest | UpdateFoodRequest) -> None:
    if payload.type == FoodType.SELF_MADE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=SYNCED_SELF_MADE_MESSAGE)
    if payload.recipe_id is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="普通食物不能关联菜谱")


def _apply_food_payload(food: Food, payload: CreateFoodRequest | UpdateFoodRequest) -> None:
    food.name = payload.name
    food.type = payload.type.value
    food.category = payload.category
    food.flavor_tags = payload.flavor_tags
    food.scene_tags = _merge_tags(payload.scene_tags, payload.scene.split("、") if payload.scene else [], payload.flavor_tags)
    food.suitable_meal_types = [item.value for item in payload.suitable_meal_types]
    food.source_name = payload.source_name
    food.purchase_source = payload.purchase_source
    food.scene = payload.scene
    food.notes = payload.notes
    food.routine_note = payload.routine_note
    food.price = payload.price
    food.rating = payload.rating
    food.repurchase = payload.repurchase
    food.expiry_date = payload.expiry_date
    food.stock_quantity = payload.stock_quantity
    food.stock_unit = payload.stock_unit
    food.favorite = payload.favorite
    food.recipe_id = payload.recipe_id


def _apply_self_made_food_profile(food: Food, payload: UpdateFoodRequest) -> None:
    food.flavor_tags = payload.flavor_tags
    food.scene_tags = _merge_tags(payload.scene_tags, payload.scene.split("、") if payload.scene else [], payload.flavor_tags)
    food.suitable_meal_types = [item.value for item in payload.suitable_meal_types]
    food.scene = payload.scene
    food.notes = payload.notes
    food.routine_note = payload.routine_note
    food.favorite = payload.favorite


@router.get("/api/foods/recommendations", response_model=FoodRecommendationsOut)
def recommend_foods(
    limit: int = Query(default=12, ge=3, le=30),
    now: datetime | None = Query(default=None),
    meal_type: MealType | None = Query(default=None),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    resolved_now = now or now_for_family(membership.family_id)
    foods = list(
        db.scalars(
            select(Food)
            .where(Food.family_id == membership.family_id)
            .options(
                selectinload(Food.recipe).selectinload(Recipe.ingredient_items),
                selectinload(Food.recipe).selectinload(Recipe.steps),
                selectinload(Food.recipe).selectinload(Recipe.cook_logs),
            )
        )
    )
    meal_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == membership.family_id)
            .options(selectinload(MealLog.food_entries))
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    target_meal_type = _resolve_target_meal_type(resolved_now, meal_logs, meal_type)
    target_date = resolved_now.date()
    if meal_type is None and target_meal_type == MealType.BREAKFAST and resolved_now.time() >= time(20, 30):
        target_date = target_date + timedelta(days=1)
    recipes = [food.recipe for food in foods if food.recipe is not None]
    ingredient_ids = [item.ingredient_id for recipe in recipes for item in recipe.ingredient_items if item.ingredient_id]
    inventory_by_ingredient = load_available_inventory_by_ingredient(db, family_id=membership.family_id, ingredient_ids=ingredient_ids, today=target_date)
    try:
        recipe_availability_by_id = {
            recipe.id: recipe_availability_summary(
                db,
                family_id=membership.family_id,
                recipe=recipe,
                today=target_date,
                inventory_by_ingredient=inventory_by_ingredient,
            )
            for recipe in recipes
        }
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    scored = [
        _score_food(
            food=food,
            meal_logs=meal_logs,
            target_meal_type=target_meal_type,
            target_date=target_date,
            recipe_availability_by_id=recipe_availability_by_id,
        )
        for food in foods
    ]
    scored.sort(key=lambda item: (item["score"], item["food"].updated_at), reverse=True)
    selected = _diversify_recommendations(scored, limit)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[item["food"].id for item in selected]))
    return {
        "target_meal_type": target_meal_type,
        "target_date": target_date,
        "items": [
            {
                "food": serialize_food(item["food"], media_map),
                "score": item["score"],
                "reasons": item["reasons"],
                "primary_action": item["primary_action"],
                "recipe_availability": item["recipe_availability"],
            }
            for item in selected
        ],
    }


@router.get("/api/foods", response_model=list[FoodOut])
def list_foods(
    q: str = Query(default="", max_length=100),
    limit: int | None = Query(default=None, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    query = q.strip()
    if query:
        search_limit = limit or 100
        search_offset = offset if limit is not None else 0
        search_result = hybrid_search(
            db,
            family_id=membership.family_id,
            query=query,
            scopes=["food"],
            limit=search_limit,
            offset=search_offset,
        )
        ids = [item.entity_id for item in search_result.items if item.entity_type == "food"]
        if not ids:
            return []
        foods_by_id = {
            item.id: item
            for item in db.scalars(select(Food).where(Food.family_id == membership.family_id, Food.id.in_(ids)))
        }
        foods = [foods_by_id[item_id] for item_id in ids if item_id in foods_by_id]
        media_map = build_media_map(
            get_media_assets_for_entities(
                db,
                family_id=membership.family_id,
                entity_type="food",
                entity_ids=[food.id for food in foods],
            )
        )
        return [serialize_food(food, media_map) for food in foods]

    statement = select(Food).where(Food.family_id == membership.family_id)
    statement = statement.order_by(Food.updated_at.desc(), Food.id)
    if limit is not None:
        statement = statement.offset(offset).limit(limit)
    foods = list(db.scalars(statement))
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id for food in foods]))
    return [serialize_food(food, media_map) for food in foods]


@router.post("/api/foods", response_model=FoodOut, status_code=status.HTTP_201_CREATED)
def create_food(
    payload: CreateFoodRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    _reject_synced_food_payload(payload)
    food = Food(
        id=create_id("food"),
        family_id=membership.family_id,
        created_by=user.id,
        updated_by=user.id,
    )
    _apply_food_payload(food, payload)
    db.add(food)
    db.flush()
    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="food", entity_id=food.id)
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="food",
                entity_id=food.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"新增{'家常菜' if food.type == FoodType.SELF_MADE.value else '食物'} {food.name}",
    )
    upsert_food_search_document(db, food)
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)


@router.patch("/api/foods/{food_id}", response_model=FoodOut)
def update_food(
    food_id: str,
    payload: UpdateFoodRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == membership.family_id))
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    if food.type == FoodType.SELF_MADE.value or food.recipe_id is not None:
        if payload.type != FoodType.SELF_MADE or payload.recipe_id != food.recipe_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=SYNCED_SELF_MADE_MESSAGE)
        _apply_self_made_food_profile(food, payload)
        food.updated_by = user.id
    else:
        _reject_synced_food_payload(payload)
        _apply_food_payload(food, payload)
        food.updated_by = user.id
        replace_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="food", entity_id=food.id)
        if payload.pending_image_job_id:
            try:
                attach_image_generation_job_to_entity(
                    db,
                    family_id=membership.family_id,
                    job_id=payload.pending_image_job_id,
                    entity_type="food",
                    entity_id=food.id,
                )
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"更新食物 {food.name}",
    )
    upsert_food_search_document(db, food)
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)


@router.patch("/api/foods/{food_id}/favorite", response_model=FoodOut)
def update_food_favorite(
    food_id: str,
    payload: UpdateFoodFavoriteRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == membership.family_id))
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    food.favorite = payload.favorite
    food.updated_by = user.id
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"{food.name}已{'加入' if food.favorite else '移出'}收藏",
    )
    upsert_food_search_document(db, food)
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="food", entity_ids=[food.id]))
    return serialize_food(food, media_map)
