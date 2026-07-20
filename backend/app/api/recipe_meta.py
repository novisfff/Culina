from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, ActivityHighlightKind
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.models.domain import Food, FoodPlanItem, FoodScene, Recipe
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.recipes import (
    CompleteFoodPlanItemRequest,
    CreateFoodPlanItemRequest,
    CreateFoodSceneRequest,
    FoodPlanItemOut,
    FoodSceneOut,
    UpdateFoodPlanItemRequest,
    UpdateFoodSceneRequest,
)
from app.schemas.meal_logs import MealLogOut
from app.services.activity import ActivityHighlight, log_activity
from app.services.food_plan_completion import CompleteFoodPlanItemCommand, complete_food_plan_item
from app.services.food_plan_locking import (
    FoodPlanConflict,
    FoodPlanWriteIntent,
    discover_food_plan_write_intents,
    food_plan_conflict_detail,
    lock_food_plan_write_intents,
)
from app.services.meal_log_versions import MealLogConflictError, build_meal_log_conflict_detail
from app.services.media import replace_media_assets
from app.services.recipe_food_sync import ensure_food_for_recipe
from app.services.search.hybrid import hybrid_search
from app.services.search.indexing import delete_search_document
from app.services.search.jobs import enqueue_search_index_job
from app.services.serializers import serialize_food_plan_item, serialize_food_scene, serialize_recipe_plan_item

router = APIRouter(tags=["recipe-meta"])

MEAL_TYPE_LABELS = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐/夜宵",
}


def _load_recipe(db: Session, *, family_id: str, recipe_id: str) -> Recipe:
    recipe = db.scalar(select(Recipe).where(Recipe.family_id == family_id, Recipe.id == recipe_id))
    if recipe is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found")
    return recipe


def _load_food(db: Session, *, family_id: str, food_id: str) -> Food:
    food = db.scalar(select(Food).where(Food.family_id == family_id, Food.id == food_id).options(selectinload(Food.recipe)))
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    return food


def _load_food_for_recipe(db: Session, *, family_id: str, user_id: str, recipe_id: str) -> Food:
    recipe = _load_recipe(db, family_id=family_id, recipe_id=recipe_id)
    food, _ = ensure_food_for_recipe(db, family_id=family_id, user_id=user_id, recipe=recipe, sync_media=False)
    food.recipe = recipe
    return food


def _load_plan_item(db: Session, *, family_id: str, user_id: str, item_id: str) -> FoodPlanItem:
    item = db.scalar(
        select(FoodPlanItem)
        .where(
            FoodPlanItem.family_id == family_id,
            FoodPlanItem.user_id == user_id,
            FoodPlanItem.id == item_id,
        )
        .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food plan item not found")
    return item


def _raise_food_plan_conflict(exc: FoodPlanConflict) -> None:
    if exc.code == "food_plan_item_not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food plan item not found") from exc
    if exc.code == "food_plan_food_not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found") from exc
    if exc.code == "food_plan_food_required":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Food not found") from exc
    if exc.code in {
        "food_plan_item_stale",
        "food_plan_targets_changed",
        "food_plan_item_already_completed",
        "food_plan_food_mismatch",
        "food_plan_item_not_planned",
    }:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=food_plan_conflict_detail(exc)) from exc
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=food_plan_conflict_detail(exc)) from exc


def _raise_meal_log_conflict(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str | None,
    exc: MealLogConflictError,
) -> None:
    detail = build_meal_log_conflict_detail(
        db,
        family_id=family_id,
        meal_log_id=meal_log_id or "",
        code=exc.code,
        recovery_hint=exc.recovery_hint,
        message=exc.message,
    )
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc

def _lock_single_food_plan_intent(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    intent: FoodPlanWriteIntent,
):
    try:
        intents = discover_food_plan_write_intents(
            db,
            family_id=family_id,
            user_id=user_id,
            intents=[intent],
        )
        return lock_food_plan_write_intents(
            db,
            family_id=family_id,
            user_id=user_id,
            intents=intents,
        )
    except FoodPlanConflict as exc:
        _raise_food_plan_conflict(exc)


def _load_scene(db: Session, *, family_id: str, scene_id: str) -> FoodScene:
    scene = db.scalar(select(FoodScene).where(FoodScene.family_id == family_id, FoodScene.id == scene_id))
    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food scene not found")
    return scene


def _scene_media_map(db: Session, *, family_id: str, scene_ids: list[str]) -> dict:
    return build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="food_scene", entity_ids=scene_ids))


@router.get("/api/food-scenes", response_model=list[FoodSceneOut])
def list_food_scenes(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    scenes = list(
        db.scalars(
            select(FoodScene)
            .where(FoodScene.family_id == membership.family_id)
            .order_by(FoodScene.sort_order.asc(), FoodScene.created_at.asc())
        )
    )
    media_map = _scene_media_map(db, family_id=membership.family_id, scene_ids=[item.id for item in scenes])
    return [serialize_food_scene(item, media_map) for item in scenes]


@router.post("/api/food-scenes", response_model=FoodSceneOut, status_code=status.HTTP_201_CREATED)
def create_food_scene(
    payload: CreateFoodSceneRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scene name is required")
    existing = db.scalar(select(FoodScene).where(FoodScene.family_id == membership.family_id, FoodScene.name == name))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Food scene already exists")

    scene = FoodScene(
        id=create_id("food-scene"),
        family_id=membership.family_id,
        name=name,
        description=payload.description.strip(),
        image_prompt=payload.image_prompt.strip(),
        hidden=payload.hidden,
        custom=payload.custom,
        sort_order=payload.sort_order,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(scene)
    db.flush()
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=[payload.image_asset_id] if payload.image_asset_id else [],
        entity_type="food_scene",
        entity_id=scene.id,
    )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="food_scene",
                entity_id=scene.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="FoodScene",
        entity_id=scene.id,
        summary=f"新增食物场景 {scene.name}",
    )
    commit_session(db)
    db.refresh(scene)
    return serialize_food_scene(scene, _scene_media_map(db, family_id=membership.family_id, scene_ids=[scene.id]))


@router.patch("/api/food-scenes/{scene_id}", response_model=FoodSceneOut)
def update_food_scene(
    scene_id: str,
    payload: UpdateFoodSceneRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    scene = _load_scene(db, family_id=membership.family_id, scene_id=scene_id)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scene name is required")
        duplicate = db.scalar(
            select(FoodScene).where(
                FoodScene.family_id == membership.family_id,
                FoodScene.name == name,
                FoodScene.id != scene.id,
            )
        )
        if duplicate is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Food scene already exists")
        scene.name = name
    if payload.description is not None:
        scene.description = payload.description.strip()
    if payload.image_prompt is not None:
        scene.image_prompt = payload.image_prompt.strip()
    if payload.hidden is not None:
        scene.hidden = payload.hidden
    if payload.custom is not None:
        scene.custom = payload.custom
    if payload.sort_order is not None:
        scene.sort_order = payload.sort_order
    scene.updated_by = user.id
    if payload.image_asset_id is not None:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=[payload.image_asset_id] if payload.image_asset_id else [],
            entity_type="food_scene",
            entity_id=scene.id,
        )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="food_scene",
                entity_id=scene.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodScene",
        entity_id=scene.id,
        summary=f"更新食物场景 {scene.name}",
    )
    commit_session(db)
    db.refresh(scene)
    return serialize_food_scene(scene, _scene_media_map(db, family_id=membership.family_id, scene_ids=[scene.id]))


@router.delete("/api/food-scenes/{scene_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_food_scene(
    scene_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    scene = _load_scene(db, family_id=membership.family_id, scene_id=scene_id)
    title = scene.name
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=[],
        entity_type="food_scene",
        entity_id=scene.id,
    )
    db.delete(scene)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodScene",
        entity_id=scene_id,
        summary=f"删除食物场景 {title}",
    )
    commit_session(db)
    return None


@router.get("/api/food-plan", response_model=list[FoodPlanItemOut])
def list_food_plan(
    date_from: date = Query(...),
    date_to: date = Query(...),
    q: str = Query(default="", max_length=100),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    user, membership = auth
    query = q.strip()
    matching_ids: set[str] | None = None
    if query:
        search_result = hybrid_search(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            query=query,
            scopes=["meal_plan"],
            limit=200,
            offset=0,
        )
        matching_ids = {item.entity_id for item in search_result.items if item.entity_type == "meal_plan"}
        if not matching_ids:
            return []
    items = list(
        db.scalars(
            select(FoodPlanItem)
            .where(
                FoodPlanItem.family_id == membership.family_id,
                FoodPlanItem.user_id == user.id,
                FoodPlanItem.plan_date >= date_from,
                FoodPlanItem.plan_date <= date_to,
                *((FoodPlanItem.id.in_(matching_ids),) if matching_ids is not None else ()),
            )
            .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
            .order_by(FoodPlanItem.plan_date.asc(), FoodPlanItem.meal_type.asc(), FoodPlanItem.created_at.asc())
        )
    )
    return [serialize_food_plan_item(item) for item in items]


@router.get("/api/food-plan/{item_id}", response_model=FoodPlanItemOut)
def get_food_plan_item(
    item_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    item = _load_plan_item(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        item_id=item_id,
    )
    return serialize_food_plan_item(item)


@router.post("/api/food-plan", response_model=FoodPlanItemOut, status_code=status.HTTP_201_CREATED)
def create_food_plan_item(
    payload: CreateFoodPlanItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    locked = _lock_single_food_plan_intent(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        intent=FoodPlanWriteIntent(
            action="create",
            item_id=None,
            target_food_id=payload.food_id,
            base_updated_at=None,
        ),
    )
    food = locked.foods_by_id[payload.food_id]
    item = FoodPlanItem(
        id=create_id("food-plan"),
        family_id=membership.family_id,
        user_id=user.id,
        food_id=payload.food_id,
        plan_date=payload.plan_date,
        meal_type=payload.meal_type,
        note=payload.note,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(item)
    db.flush()
    enqueue_search_index_job(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        entity_type="meal_plan",
        entity_id=item.id,
        target_name=food.name,
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="FoodPlanItem",
        entity_id=item.id,
        summary=f"加入菜单计划 {food.name}",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL_PLAN,
            summary=(
                f"将 {food.name} 安排到 {item.plan_date.isoformat()} "
                f"{MEAL_TYPE_LABELS[item.meal_type.value]}"
            ),
        ),
    )
    commit_session(db)
    db.refresh(item)
    item.food = food
    return serialize_food_plan_item(item)


@router.post("/api/food-plan/{item_id}/complete", response_model=MealLogOut)
def complete_food_plan_item_route(
    item_id: str,
    payload: CompleteFoodPlanItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    command = CompleteFoodPlanItemCommand(
        family_id=membership.family_id,
        actor_user_id=user.id,
        item_id=item_id,
        food_plan_item_base_updated_at=payload.food_plan_item_base_updated_at,
        target_meal_log_id=payload.target_meal_log_id,
        expected_meal_log_row_version=payload.expected_meal_log_row_version,
    )
    try:
        result = complete_food_plan_item(db, command)
        commit_session(db)
    except FoodPlanConflict as exc:
        db.rollback()
        _raise_food_plan_conflict(exc)
    except MealLogConflictError as exc:
        db.rollback()
        _raise_meal_log_conflict(
            db,
            family_id=membership.family_id,
            meal_log_id=payload.target_meal_log_id,
            exc=exc,
        )
    return result


@router.patch("/api/food-plan/{item_id}", response_model=FoodPlanItemOut)
def update_food_plan_item(
    item_id: str,
    payload: UpdateFoodPlanItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    locked = _lock_single_food_plan_intent(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        intent=FoodPlanWriteIntent(
            action="update",
            item_id=item_id,
            target_food_id=payload.food_id,
            base_updated_at=None,
        ),
    )
    item = locked.items_by_id[item_id]
    before_material = (item.food_id, item.plan_date, item.meal_type)
    if payload.food_id is not None:
        item.food = locked.foods_by_id[payload.food_id]
        item.food_id = payload.food_id
    elif item.food_id in locked.foods_by_id:
        item.food = locked.foods_by_id[item.food_id]
    if payload.plan_date is not None:
        item.plan_date = payload.plan_date
    if payload.meal_type is not None:
        item.meal_type = payload.meal_type
    if payload.note is not None:
        item.note = payload.note
    if payload.status is not None:
        if payload.status not in {"planned", "cooked", "skipped"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid plan status")
        item.status = payload.status
        if payload.status != "cooked":
            item.completed_at = None
            item.meal_log_id = None
    item.updated_by = user.id
    after_material = (item.food_id, item.plan_date, item.meal_type)
    materially_changed = before_material != after_material
    food_name = item.food.name if item.food else "食物"
    highlight = (
        ActivityHighlight(
            kind=ActivityHighlightKind.MEAL_PLAN,
            summary=(
                f"将 {food_name} 安排到 {item.plan_date.isoformat()} "
                f"{MEAL_TYPE_LABELS[item.meal_type.value]}"
            ),
        )
        if materially_changed
        else None
    )
    enqueue_search_index_job(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        entity_type="meal_plan",
        entity_id=item.id,
        target_name=item.food.name if item.food else "餐食计划",
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodPlanItem",
        entity_id=item.id,
        summary=f"更新菜单计划 {food_name}",
        highlight=highlight,
    )
    commit_session(db)
    db.refresh(item)
    return serialize_food_plan_item(item)


@router.delete("/api/food-plan/{item_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_food_plan_item(
    item_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    locked = _lock_single_food_plan_intent(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        intent=FoodPlanWriteIntent(
            action="delete",
            item_id=item_id,
            target_food_id=None,
            base_updated_at=None,
        ),
    )
    item = locked.items_by_id[item_id]
    if item.food_id in locked.foods_by_id:
        item.food = locked.foods_by_id[item.food_id]
    food_name = item.food.name if item.food else "食物"
    delete_search_document(
        db,
        family_id=membership.family_id,
        entity_type="meal_plan",
        entity_id=item.id,
        delete_vector=True,
    )
    db.delete(item)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodPlanItem",
        entity_id=item.id,
        summary=f"移除菜单计划 {food_name}",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL_PLAN,
            summary=f"移除菜单计划 {food_name}",
        ),
    )
    commit_session(db)
    return None
