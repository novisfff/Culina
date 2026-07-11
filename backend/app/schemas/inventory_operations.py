from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import (
    InventoryAvailabilityLevel,
    InventoryOperationStatus,
    InventoryOperationType,
    InventoryStatus,
)


SNAPSHOT_SCHEMA_VERSION = 1


class InventoryOperationDisplaySummary(BaseModel):
    title: str
    description: str
    confirmed_count: int = 0
    adjusted_count: int = 0
    completed_count: int = 0
    partial_count: int = 0


class InventoryOperationResult(BaseModel):
    operation_id: str
    operation_type: InventoryOperationType
    status: InventoryOperationStatus
    applied_at: datetime
    revertible_until: datetime
    can_revert: bool
    summary: InventoryOperationDisplaySummary


class ExactIngredientShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["exact_ingredient"]
    target_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    actual_quantity: Decimal = Field(gt=0)
    unit: str
    inventory_status: InventoryStatus
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

    @field_validator("unit", "storage_location", "target_id", "shopping_item_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned

    @field_validator("notes")
    @classmethod
    def _normalize_notes(cls, value: str) -> str:
        return (value or "").strip()


class PresenceIngredientShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["presence_ingredient"]
    target_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    state_id: str | None = None
    expected_state_row_version: int | None = Field(default=None, ge=1)
    resulting_availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

    @field_validator("target_id", "shopping_item_id", "storage_location")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned

    @field_validator("notes")
    @classmethod
    def _normalize_notes(cls, value: str) -> str:
        return (value or "").strip()

    @model_validator(mode="after")
    def _validate_presence_request(self) -> "PresenceIngredientShoppingIntakeItemRequest":
        has_state_id = self.state_id is not None
        has_state_version = self.expected_state_row_version is not None
        if has_state_id != has_state_version:
            raise ValueError("更新库存状态时必须同时提供 state_id 与 expected_state_row_version")
        if self.resulting_availability_level is InventoryAvailabilityLevel.ABSENT:
            raise ValueError("采购入库不能将食材标记为没有")
        return self


class FoodShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["food"]
    target_id: str
    expected_food_row_version: int = Field(ge=1)
    actual_quantity: Decimal = Field(gt=0)
    unit: str
    expiry_date: date | None = None
    storage_location: str

    @field_validator("unit", "storage_location", "target_id", "shopping_item_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned


class CompleteWithoutInventoryItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["complete_without_inventory"]
    target_kind: Literal["none"]
    target_id: None = None

    @field_validator("shopping_item_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned


ShoppingIntakeItemRequest = Annotated[
    ExactIngredientShoppingIntakeItemRequest
    | PresenceIngredientShoppingIntakeItemRequest
    | FoodShoppingIntakeItemRequest
    | CompleteWithoutInventoryItemRequest,
    Field(discriminator="target_kind"),
]


class ShoppingIntakeRequest(BaseModel):
    client_request_id: str = Field(min_length=1)
    purchase_date: date
    items: list[ShoppingIntakeItemRequest] = Field(min_length=1)

    @field_validator("client_request_id")
    @classmethod
    def _normalize_client_request_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("client_request_id 不能为空")
        return cleaned

    @model_validator(mode="after")
    def _reject_duplicate_shopping_items(self) -> "ShoppingIntakeRequest":
        seen: set[str] = set()
        for item in self.items:
            if item.shopping_item_id in seen:
                raise ValueError("请求中包含重复的采购项")
            seen.add(item.shopping_item_id)
        return self


class ShoppingIntakeItemResult(BaseModel):
    shopping_item_id: str
    result: Literal["completed", "partial", "stocked", "completed_without_inventory"]
    remaining_planned_quantity: Decimal | None = None
    inventory_item_id: str | None = None
    state_id: str | None = None
    food_id: str | None = None


class ShoppingIntakeResult(InventoryOperationResult):
    items: list[ShoppingIntakeItemResult]


class InventoryOperationDetailError(BaseModel):
    code: str
    message: str
    conflicts: list[dict] = Field(default_factory=list)
    field_errors: list[dict] = Field(default_factory=list)
