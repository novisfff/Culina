from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import ShoppingListItem
from app.schemas.shopping import CreateShoppingListItemRequest, ShoppingListItemOut, UpdateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.serializers import serialize_shopping_item

router = APIRouter(tags=["shopping-list"])


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
    item = ShoppingListItem(
        id=create_id("shopping"),
        family_id=membership.family_id,
        title=payload.title,
        quantity=payload.quantity,
        unit=payload.unit,
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
    item.done = payload.done
    item.updated_by = user.id
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="ShoppingListItem",
        entity_id=item.id,
        summary=f"{item.title}已标记为{'完成' if item.done else '待办'}",
    )
    commit_session(db)
    db.refresh(item)
    return serialize_shopping_item(item)
