from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, FoodType, IngredientQuantityTrackingMode
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Food, Ingredient, ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest, ShoppingListItemOut, UpdateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.serializers import serialize_shopping_item

router = APIRouter(tags=["shopping-list"])

READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


def _resolve_shopping_target(
    *,
    ingredient_id: str | None,
    food_id: str | None,
    family_id: str,
    db: Session,
) -> tuple[Ingredient | None, Food | None]:
    if bool(ingredient_id) == bool(food_id):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购项必须且只能选择一个采购对象")
    if ingredient_id:
        ingredient = db.scalar(select(Ingredient).where(Ingredient.id == ingredient_id, Ingredient.family_id == family_id))
        if ingredient is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
        return ingredient, None
    food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    if food.type not in READY_LIKE_FOOD_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="只有成品、速食或包装食品可以加入采购")
    return None, food


@router.get("/api/shopping-list", response_model=list[ShoppingListItemOut])
def list_shopping_items(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    items = list(
        db.scalars(
            select(ShoppingListItem)
            .where(ShoppingListItem.family_id == membership.family_id)
            .order_by(ShoppingListItem.updated_at.desc())
        )
    )
    return [serialize_shopping_item(item) for item in items]


@router.post("/api/shopping-list", response_model=ShoppingListItemOut, status_code=status.HTTP_201_CREATED)
def create_shopping_item(
    payload: CreateShoppingListItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient, food = _resolve_shopping_target(
        ingredient_id=payload.ingredient_id,
        food_id=payload.food_id,
        family_id=membership.family_id,
        db=db,
    )
    if ingredient is not None:
        payload.title = ingredient.name
        payload.quantity_mode = ingredient.quantity_tracking_mode
        payload.unit = payload.unit or ingredient.default_unit
    elif food is not None:
        payload.title = food.name
        payload.quantity_mode = IngredientQuantityTrackingMode.TRACK_QUANTITY
        payload.unit = payload.unit or food.stock_unit or "份"
        payload.display_label = None
    if payload.quantity_mode.value == "not_track_quantity":
        payload.display_label = payload.display_label or "需要补充"
        payload.quantity = payload.quantity or 1
    if payload.quantity is None or payload.quantity <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购数量必须大于 0")
    if not payload.unit:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购单位不能为空")
    item = ShoppingListItem(
        id=create_id("shopping"),
        family_id=membership.family_id,
        ingredient_id=ingredient.id if ingredient is not None else None,
        food_id=food.id if food is not None else None,
        title=payload.title,
        quantity=payload.quantity or 1,
        unit=payload.unit or "份",
        quantity_mode=payload.quantity_mode,
        display_label=payload.display_label,
        reason=payload.reason,
        done=False,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(item)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="ShoppingListItem",
        entity_id=item.id,
        summary=f"加入购物清单 {item.title}",
    )
    commit_session(db)
    return serialize_shopping_item(item)


@router.patch("/api/shopping-list/{item_id}", response_model=ShoppingListItemOut)
def update_shopping_item(
    item_id: str,
    payload: UpdateShoppingListItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    item = db.scalar(select(ShoppingListItem).where(ShoppingListItem.id == item_id, ShoppingListItem.family_id == membership.family_id))
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping item not found")
    ingredient = None
    food = None
    content_fields = payload.model_fields_set - {"done"}
    target_changed = False
    if content_fields:
        has_target_field = "ingredient_id" in payload.model_fields_set or "food_id" in payload.model_fields_set
        ingredient_id = payload.ingredient_id if "ingredient_id" in payload.model_fields_set else (None if has_target_field else item.ingredient_id)
        food_id = payload.food_id if "food_id" in payload.model_fields_set else (None if has_target_field else item.food_id)
        ingredient, food = _resolve_shopping_target(
            ingredient_id=ingredient_id,
            food_id=food_id,
            family_id=membership.family_id,
            db=db,
        )
        target_changed = ingredient_id != item.ingredient_id or food_id != item.food_id

    if ingredient is not None:
        item.title = ingredient.name
    elif food is not None:
        item.title = food.name
    elif "title" in payload.model_fields_set and payload.title is not None:
        item.title = payload.title
    if ingredient is not None:
        item.ingredient_id = ingredient.id
        item.food_id = None
    elif food is not None:
        item.food_id = food.id
        item.ingredient_id = None
    if ingredient is not None:
        item.quantity_mode = ingredient.quantity_tracking_mode
        item.unit = payload.unit or (item.unit if not target_changed else None) or ingredient.default_unit
    elif food is not None:
        item.quantity_mode = IngredientQuantityTrackingMode.TRACK_QUANTITY
        item.unit = payload.unit or (item.unit if not target_changed else None) or food.stock_unit or "份"
        item.display_label = None
    elif "quantity_mode" in payload.model_fields_set and payload.quantity_mode is not None:
        item.quantity_mode = payload.quantity_mode
    if "quantity" in payload.model_fields_set and payload.quantity is not None:
        item.quantity = payload.quantity
    if "unit" in payload.model_fields_set and payload.unit is not None:
        item.unit = payload.unit
    if "display_label" in payload.model_fields_set:
        item.display_label = payload.display_label
    if "reason" in payload.model_fields_set and payload.reason is not None:
        item.reason = payload.reason
    if "done" in payload.model_fields_set and payload.done is not None:
        item.done = payload.done

    if item.quantity_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
        item.quantity = item.quantity or 1
        item.unit = item.unit or "份"
        item.display_label = item.display_label or "需要补充"
    else:
        if item.quantity is None or item.quantity <= 0:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购数量必须大于 0")
        if not item.unit:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购单位不能为空")
        item.display_label = None

    item.updated_by = user.id
    if payload.model_fields_set == {"done"}:
        summary = f"{item.title}已标记为{'完成' if item.done else '待办'}"
    else:
        summary = f"更新购物清单 {item.title}"
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="ShoppingListItem",
        entity_id=item.id,
        summary=summary,
    )
    commit_session(db)
    db.refresh(item)
    return serialize_shopping_item(item)


@router.delete("/api/shopping-list/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shopping_item(
    item_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    user, membership = auth
    item = db.scalar(select(ShoppingListItem).where(ShoppingListItem.id == item_id, ShoppingListItem.family_id == membership.family_id))
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping item not found")
    item_title = item.title
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="ShoppingListItem",
        entity_id=item.id,
        summary=f"删除购物清单 {item_title}",
    )
    db.delete(item)
    commit_session(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
