from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ShoppingListItemOut(BaseModel):
    id: str
    family_id: str
    title: str
    quantity: float
    unit: str
    reason: str
    done: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateShoppingListItemRequest(BaseModel):
    title: str
    quantity: float
    unit: str
    reason: str = ""


class UpdateShoppingListItemRequest(BaseModel):
    done: bool

