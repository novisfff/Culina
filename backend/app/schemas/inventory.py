from __future__ import annotations

from datetime import date as date_type, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import (
    IngredientQuantityTrackingMode,
    InventoryConfirmationSource,
    InventoryStatus,
)


class InventoryItemOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str
    ingredient_name: str
    quantity_tracking_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
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
    row_version: int
    expiry_alert_snoozed_until: date_type | None = None
    expiry_reviewed_at: datetime | None = None
    expiry_reviewed_by: str | None = None
    last_confirmed_at: datetime | None = None
    last_confirmed_by: str | None = None
    last_confirmation_source: InventoryConfirmationSource | None = None


class CreateInventoryItemRequest(BaseModel):
    ingredient_id: str
    quantity: float | None = Field(default=None, gt=0)
    unit: str | None = Field(default=None, min_length=1)
    status: InventoryStatus
    purchase_date: date_type
    expiry_date: date_type | None = None
    storage_location: str
    notes: str = ""
    low_stock_threshold: float = Field(default=0, ge=0)


class ConsumeInventoryRequest(BaseModel):
    ingredient_id: str
    quantity: float | None = Field(default=None, gt=0)
    unit: str | None = Field(default=None, min_length=1)


class ConsumeInventoryResponse(BaseModel):
    ingredient_id: str
    unit: str
    consumed_quantity: float
    affected_item_ids: list[str] = Field(default_factory=list)


class VersionedInventoryItemRef(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)


class DisposeExpiredInventoryRequest(BaseModel):
    ingredient_id: str
    items: list[VersionedInventoryItemRef] = Field(min_length=1)


class DisposeExpiredInventoryResponse(BaseModel):
    ingredient_id: str
    disposed_item_ids: list[str] = Field(default_factory=list)
    disposed_count: int


class SnoozeExpiryAlertsRequest(BaseModel):
    action: Literal["retain_expired", "snooze_upcoming"]
    ingredient_id: str
    items: list[VersionedInventoryItemRef] = Field(min_length=1)
    snoozed_until: date_type


class SnoozeExpiryAlertsResponse(BaseModel):
    ingredient_id: str
    snoozed_item_ids: list[str] = Field(default_factory=list)
    snoozed_count: int
    reviewed_expired_count: int
    snoozed_until: date_type


class CorrectInventoryExpiryDateRequest(BaseModel):
    expiry_date: date_type
    expected_row_version: int = Field(ge=1)


class DisposeInventoryRequest(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)
    quantity: float | None = Field(default=None, gt=0)
    unit: str | None = Field(default=None, min_length=1)
    reason: str = Field(min_length=1, max_length=255)


class DisposeInventoryResponse(BaseModel):
    ingredient_id: str
    inventory_item_id: str
    unit: str
    disposed_quantity: float
    remaining_quantity: float
