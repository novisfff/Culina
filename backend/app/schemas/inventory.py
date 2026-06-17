from __future__ import annotations

from datetime import date as date_type, datetime

from pydantic import BaseModel, Field

from app.core.enums import InventoryStatus


class InventoryItemOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str
    ingredient_name: str
    quantity: float
    consumed_quantity: float
    disposed_quantity: float
    remaining_quantity: float
    unit: str
    entered_quantity: float | None = None
    entered_unit: str | None = None
    status: InventoryStatus
    purchase_date: date_type
    expiry_date: date_type | None = None
    storage_location: str
    notes: str
    low_stock_threshold: float
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateInventoryItemRequest(BaseModel):
    ingredient_id: str
    quantity: float = Field(gt=0)
    unit: str = Field(min_length=1)
    status: InventoryStatus
    purchase_date: date_type
    expiry_date: date_type | None = None
    storage_location: str
    notes: str = ""
    low_stock_threshold: float = Field(default=0, ge=0)


class ConsumeInventoryRequest(BaseModel):
    ingredient_id: str
    quantity: float = Field(gt=0)
    unit: str = Field(min_length=1)


class ConsumeInventoryResponse(BaseModel):
    ingredient_id: str
    unit: str
    consumed_quantity: float
    affected_item_ids: list[str] = Field(default_factory=list)


class DisposeExpiredInventoryRequest(BaseModel):
    ingredient_id: str
    inventory_item_ids: list[str] = Field(default_factory=list, min_length=1)


class DisposeExpiredInventoryResponse(BaseModel):
    ingredient_id: str
    disposed_item_ids: list[str] = Field(default_factory=list)
    disposed_count: int


class DisposeInventoryRequest(BaseModel):
    inventory_item_id: str
    quantity: float | None = Field(default=None, gt=0)
    unit: str | None = Field(default=None, min_length=1)
    reason: str = Field(min_length=1, max_length=255)


class DisposeInventoryResponse(BaseModel):
    ingredient_id: str
    inventory_item_id: str
    unit: str
    disposed_quantity: float
    remaining_quantity: float
