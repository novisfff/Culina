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
from app.schemas.inventory_states import IngredientInventoryStateOut


SNAPSHOT_SCHEMA_VERSION = 1

ReconciliationScope = Literal["all", "refrigerated", "frozen", "room_temperature", "suggested"]
ConfirmationStatus = Literal["never_confirmed", "current", "stale"]

SCOPE_CANONICAL_STORAGE: dict[str, str] = {
    "refrigerated": "冷藏",
    "frozen": "冷冻",
    "room_temperature": "常温",
}


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


# --- Reconciliation read models ---


class ReconciliationSummaryOut(BaseModel):
    total_groups: int
    never_confirmed: int
    stale: int
    expired_physical_batches: int


class ReconciliationBatchOut(BaseModel):
    inventory_item_id: str
    row_version: int
    remaining_quantity: Decimal
    unit: str
    status: InventoryStatus
    purchase_date: date
    expiry_date: date | None
    storage_location: str
    notes: str
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None


class ExactIngredientReconciliationGroupOut(BaseModel):
    kind: Literal["exact_ingredient"]
    ingredient_id: str
    ingredient_name: str
    ingredient_row_version: int
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None
    batches: list[ReconciliationBatchOut]
    pending_shopping_item_id: str | None


class PresenceIngredientReconciliationGroupOut(BaseModel):
    kind: Literal["presence_ingredient"]
    ingredient_id: str
    ingredient_name: str
    ingredient_row_version: int
    state: IngredientInventoryStateOut
    confirmation_status: ConfirmationStatus
    pending_shopping_item_id: str | None


class FoodReconciliationGroupOut(BaseModel):
    kind: Literal["food"]
    food_id: str
    food_name: str
    row_version: int
    stock_quantity: Decimal
    stock_unit: str
    expiry_date: date | None
    storage_location: str | None
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None


InventoryReconciliationGroupOut = Annotated[
    ExactIngredientReconciliationGroupOut
    | PresenceIngredientReconciliationGroupOut
    | FoodReconciliationGroupOut,
    Field(discriminator="kind"),
]


class InventoryReconciliationOut(BaseModel):
    business_date: date
    business_timezone: Literal["Asia/Shanghai"]
    generated_at: datetime
    summary: ReconciliationSummaryOut
    groups: list[InventoryReconciliationGroupOut]


# --- Reconciliation submit models ---


class VersionedObservedBatch(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)

    @field_validator("inventory_item_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned


class InventoryBatchUpdate(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)
    actual_remaining_quantity: Decimal = Field(ge=0)
    inventory_status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

    @field_validator("inventory_item_id", "storage_location")
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


class InventoryBatchCreate(BaseModel):
    client_line_id: str
    actual_remaining_quantity: Decimal = Field(gt=0)
    unit: str
    inventory_status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

    @field_validator("client_line_id", "unit", "storage_location")
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


class ExactIngredientReconciliationRequest(BaseModel):
    kind: Literal["exact_ingredient"]
    ingredient_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    action: Literal["confirm_all", "set_absent", "adjust_batches"]
    observed_batches: list[VersionedObservedBatch]
    updates: list[InventoryBatchUpdate] = Field(default_factory=list)
    creates: list[InventoryBatchCreate] = Field(default_factory=list)

    @field_validator("ingredient_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned

    @model_validator(mode="after")
    def _validate_exact_group(self) -> "ExactIngredientReconciliationRequest":
        observed_ids = [batch.inventory_item_id for batch in self.observed_batches]
        if len(observed_ids) != len(set(observed_ids)):
            raise ValueError("observed_batches 包含重复批次")
        observed_versions = {
            batch.inventory_item_id: batch.expected_row_version for batch in self.observed_batches
        }

        update_ids = [item.inventory_item_id for item in self.updates]
        if len(update_ids) != len(set(update_ids)):
            raise ValueError("updates 包含重复批次")
        for update in self.updates:
            if update.inventory_item_id not in observed_versions:
                raise ValueError("update 批次必须出现在 observed_batches 中")
            if update.expected_row_version != observed_versions[update.inventory_item_id]:
                raise ValueError("update 与 observed_batches 的版本必须一致")

        create_ids = [item.client_line_id for item in self.creates]
        if len(create_ids) != len(set(create_ids)):
            raise ValueError("creates 包含重复 client_line_id")

        if self.action in {"confirm_all", "set_absent"}:
            if self.updates or self.creates:
                raise ValueError(f"{self.action} 不能携带 updates 或 creates")
        elif self.action == "adjust_batches":
            if not self.updates and not self.creates:
                raise ValueError("adjust_batches 至少需要一个 update 或 create")
        return self


class PresenceIngredientReconciliationRequest(BaseModel):
    kind: Literal["presence_ingredient"]
    ingredient_id: str
    state_id: str | None = None
    expected_ingredient_row_version: int = Field(ge=1)
    expected_state_row_version: int | None = Field(default=None, ge=1)
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""

    @field_validator("ingredient_id")
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
    def _validate_presence_group(self) -> "PresenceIngredientReconciliationRequest":
        has_state_id = self.state_id is not None
        has_state_version = self.expected_state_row_version is not None
        if has_state_id != has_state_version:
            raise ValueError("更新库存状态时必须同时提供 state_id 与 expected_state_row_version")

        if self.storage_location is not None:
            self.storage_location = self.storage_location.strip() or None

        if self.availability_level is InventoryAvailabilityLevel.ABSENT:
            if (
                self.purchase_date is not None
                or self.expiry_date is not None
                or self.storage_location is not None
            ):
                raise ValueError("标记为没有时不能保留采购日、到期日或存放位置")
            return self

        if not self.storage_location:
            raise ValueError("在库状态必须提供存放位置")
        if (
            self.purchase_date is not None
            and self.expiry_date is not None
            and self.expiry_date < self.purchase_date
        ):
            raise ValueError("到期日不能早于采购日")
        return self


class FoodReconciliationRequest(BaseModel):
    kind: Literal["food"]
    food_id: str
    expected_row_version: int = Field(ge=1)
    action: Literal["confirm", "set_stock"]
    stock_quantity: Decimal | None = None
    stock_unit: str | None = None
    expiry_date: date | None = None
    storage_location: str | None = None

    @field_validator("food_id")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned

    @model_validator(mode="after")
    def _validate_food_group(self) -> "FoodReconciliationRequest":
        if self.action == "confirm":
            if (
                self.stock_quantity is not None
                or self.stock_unit is not None
                or self.expiry_date is not None
                or self.storage_location is not None
            ):
                raise ValueError("confirm 不能修改库存数量或位置")
            return self

        if self.stock_quantity is None:
            raise ValueError("set_stock 必须提供 stock_quantity")
        if self.stock_quantity < 0:
            raise ValueError("库存数量不能为负")
        if self.stock_quantity > 0:
            unit = (self.stock_unit or "").strip()
            location = (self.storage_location or "").strip()
            if not unit:
                raise ValueError("正库存必须提供单位")
            if not location:
                raise ValueError("正库存必须提供存放位置")
            self.stock_unit = unit
            self.storage_location = location
        else:
            self.stock_unit = (self.stock_unit or "").strip() or None
            self.storage_location = (self.storage_location or "").strip() or None
        return self


ReconciliationGroupRequest = Annotated[
    ExactIngredientReconciliationRequest
    | PresenceIngredientReconciliationRequest
    | FoodReconciliationRequest,
    Field(discriminator="kind"),
]


class InventoryReconciliationRequest(BaseModel):
    client_request_id: str
    scope: ReconciliationScope
    storage_location: str | None = None
    groups: list[ReconciliationGroupRequest] = Field(min_length=1)

    @field_validator("client_request_id")
    @classmethod
    def _normalize_client_request_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("client_request_id 不能为空")
        return cleaned

    @model_validator(mode="after")
    def _validate_scope_and_duplicates(self) -> "InventoryReconciliationRequest":
        if self.storage_location is not None:
            self.storage_location = self.storage_location.strip() or None

        if self.scope in {"all", "suggested"}:
            if self.storage_location is not None:
                raise ValueError("all/suggested 范围不能指定 storage_location")
        else:
            canonical = SCOPE_CANONICAL_STORAGE[self.scope]
            if self.storage_location is None:
                self.storage_location = canonical
            elif self.storage_location != canonical:
                raise ValueError(f"{self.scope} 范围的 storage_location 必须为 {canonical}")

        seen_exact: set[str] = set()
        seen_presence: set[str] = set()
        seen_food: set[str] = set()
        for group in self.groups:
            if isinstance(group, ExactIngredientReconciliationRequest):
                if group.ingredient_id in seen_exact:
                    raise ValueError("请求中包含重复的精确食材目标")
                seen_exact.add(group.ingredient_id)
            elif isinstance(group, PresenceIngredientReconciliationRequest):
                if group.ingredient_id in seen_presence:
                    raise ValueError("请求中包含重复的非精确食材目标")
                seen_presence.add(group.ingredient_id)
            elif isinstance(group, FoodReconciliationRequest):
                if group.food_id in seen_food:
                    raise ValueError("请求中包含重复的食物目标")
                seen_food.add(group.food_id)
        return self

