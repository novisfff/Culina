from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, FoodType, IngredientQuantityTrackingMode
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Food, Ingredient, ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest, ShoppingListItemOut, UpdateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.food_stock_quantity import validate_food_stock_quantity_precision
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail, require_expected_version
from app.services.serializers import serialize_shopping_item

router = APIRouter(tags=["shopping-list"])

READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


def _commit_shopping_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


def _shopping_conflict_http(exc: InventoryConflictError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=conflict_detail(exc))


def _resolve_shopping_target(
    *,
    ingredient_id: str | None,
    food_id: str | None,
    family_id: str,
    db: Session,
) -> tuple[Ingredient | None, Food | None]:
    # At most one target: both non-null is invalid; both null is intentional free_text.
    if ingredient_id and food_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购项必须且只能选择一个采购对象")
    if not ingredient_id and not food_id:
        return None, None
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


def _validate_food_shopping_quantity(quantity: Decimal | float | None) -> None:
    if quantity is None:
        return
    try:
        validate_food_stock_quantity_precision(Decimal(str(quantity)), field_label="采购数量")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


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
    else:
        # Free-text defaults when omitted.
        payload.unit = payload.unit or "份"
        if payload.quantity is None:
            payload.quantity = 1
    if payload.quantity_mode.value == "not_track_quantity":
        payload.display_label = payload.display_label or "需要补充"
        payload.quantity = payload.quantity or 1
        payload.unit = payload.unit or "份"
    if payload.quantity is None or payload.quantity <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购数量必须大于 0")
    if not payload.unit:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购单位不能为空")
    if food is not None:
        _validate_food_shopping_quantity(payload.quantity)
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
    try:
        item = lock_inventory_targets(
            db,
            family_id=membership.family_id,
            shopping_item_ids=[item_id],
        ).shopping_items[item_id]
    except (InventoryTargetNotFoundError, KeyError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping item not found")
    try:
        require_expected_version(
            item,
            payload.expected_row_version,
            entity_type="shopping_list_item",
            entity_id=item.id,
        )
    except InventoryConflictError as exc:
        raise _shopping_conflict_http(exc) from exc

    content_fields = payload.model_fields_set - {"done", "expected_row_version"}
    has_target_field = "ingredient_id" in payload.model_fields_set or "food_id" in payload.model_fields_set
    ingredient = None
    food = None
    target_changed = False

    if content_fields:
        # Omitted target fields preserve the current binding.
        # Explicit nulls (including both null) intentionally unbind to free_text.
        if has_target_field:
            ingredient_id = payload.ingredient_id if "ingredient_id" in payload.model_fields_set else None
            food_id = payload.food_id if "food_id" in payload.model_fields_set else None
        else:
            ingredient_id = item.ingredient_id
            food_id = item.food_id
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

        if has_target_field:
            if ingredient is not None:
                item.ingredient_id = ingredient.id
                item.food_id = None
            elif food is not None:
                item.food_id = food.id
                item.ingredient_id = None
            else:
                # Explicit unbind to free_text.
                item.ingredient_id = None
                item.food_id = None

        if ingredient is not None:
            item.quantity_mode = ingredient.quantity_tracking_mode
            item.unit = payload.unit or (item.unit if not target_changed else None) or ingredient.default_unit
        elif food is not None:
            item.quantity_mode = IngredientQuantityTrackingMode.TRACK_QUANTITY
            item.unit = payload.unit or (item.unit if not target_changed else None) or food.stock_unit or "份"
            item.display_label = None
        elif "quantity_mode" in payload.model_fields_set and payload.quantity_mode is not None:
            item.quantity_mode = payload.quantity_mode
    elif "title" in payload.model_fields_set and payload.title is not None:
        item.title = payload.title

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
            if item.ingredient_id is None and item.food_id is None:
                item.unit = "份"
            else:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="采购单位不能为空")
        if item.ingredient_id is not None or item.food_id is not None:
            item.display_label = None

    if item.food_id is not None and ("quantity" in payload.model_fields_set or target_changed):
        _validate_food_shopping_quantity(item.quantity)

    item.updated_by = user.id
    mutation_fields = payload.model_fields_set - {"expected_row_version"}
    if mutation_fields == {"done"}:
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
    _commit_shopping_session(db)
    db.refresh(item)
    return serialize_shopping_item(item)


@router.delete("/api/shopping-list/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shopping_item(
    item_id: str,
    expected_row_version: int = Query(ge=1),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    user, membership = auth
    try:
        item = lock_inventory_targets(
            db,
            family_id=membership.family_id,
            shopping_item_ids=[item_id],
        ).shopping_items[item_id]
    except (InventoryTargetNotFoundError, KeyError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shopping item not found")
    try:
        require_expected_version(
            item,
            expected_row_version,
            entity_type="shopping_list_item",
            entity_id=item.id,
        )
    except InventoryConflictError as exc:
        raise _shopping_conflict_http(exc) from exc
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
    _commit_shopping_session(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
