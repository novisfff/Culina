from __future__ import annotations

from datetime import date as date_type
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import IngredientQuantityTrackingMode, InventoryStatus
from app.schemas.media import MediaAssetOut

InventoryOverviewScope = Literal["all", "ingredient", "food"]
InventoryOverviewSourceType = Literal["ingredient", "food"]
InventoryOverviewTone = Literal["stable", "warning", "danger", "empty"]
InventoryOverviewPrimaryAction = Literal[
    "restock",
    "consume",
    "dispose",
    "record_meal",
    "edit_food_stock",
]


class InventoryOverviewItemOut(BaseModel):
    id: str
    source_type: InventoryOverviewSourceType
    source_id: str
    inventory_item_id: str | None = None
    title: str
    category: str
    image: MediaAssetOut | None = None
    quantity: float | None = None
    unit: str
    quantity_label: str
    quantity_tracking_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    status: InventoryStatus | None = None
    tone: InventoryOverviewTone
    expiry_date: date_type | None = None
    days_until_expiry: int | None = None
    storage_location: str
    purchase_source: str | None = None
    updated_at: str
    primary_action: InventoryOverviewPrimaryAction
    search_text: str


class InventoryOverviewSummaryOut(BaseModel):
    total_count: int = Field(ge=0)
    ingredient_count: int = Field(ge=0)
    food_count: int = Field(ge=0)
    alert_count: int = Field(ge=0)
    expiring_count: int = Field(ge=0)
    empty_count: int = Field(ge=0)


class InventoryOverviewOut(BaseModel):
    scope: InventoryOverviewScope
    query: str
    summary: InventoryOverviewSummaryOut
    items: list[InventoryOverviewItemOut] = Field(default_factory=list)
