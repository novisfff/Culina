from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import (
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryStatus,
)
from app.schemas.media import MediaAssetOut


class IngredientUnitConversion(BaseModel):
    unit: str
    ratio_to_default: float

    @field_validator("unit")
    @classmethod
    def validate_unit(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("单位不能为空")
        return normalized

    @field_validator("ratio_to_default")
    @classmethod
    def validate_ratio_to_default(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("换算值必须大于 0")
        return value


class IngredientOut(BaseModel):
    id: str
    family_id: str
    name: str
    category: str
    default_unit: str
    unit_conversions: list[IngredientUnitConversion] = Field(default_factory=list)
    quantity_tracking_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    default_storage: str
    default_expiry_mode: IngredientExpiryMode
    default_expiry_days: int | None = None
    default_low_stock_threshold: float | None = None
    notes: str
    image: MediaAssetOut | None = None
    row_version: int = 1
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class _IngredientRequestBase(BaseModel):
    name: str
    category: str
    default_unit: str
    unit_conversions: list[IngredientUnitConversion] = Field(default_factory=list)
    quantity_tracking_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    default_storage: str
    default_expiry_mode: IngredientExpiryMode = IngredientExpiryMode.NONE
    default_expiry_days: int | None = None
    default_low_stock_threshold: float | None = None
    notes: str = ""
    media_ids: list[str] = Field(default_factory=list)
    pending_image_job_id: str | None = None

    @field_validator("default_unit")
    @classmethod
    def validate_default_unit(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("主单位不能为空")
        return normalized

    @model_validator(mode="after")
    def validate_unit_conversions(self) -> "_IngredientRequestBase":
        seen_units = {self.default_unit}
        for entry in self.unit_conversions:
            if entry.unit in seen_units:
                raise ValueError("副单位不能重复，也不能与主单位相同")
            seen_units.add(entry.unit)
        if self.default_low_stock_threshold is not None and self.default_low_stock_threshold <= 0:
            raise ValueError("默认低库存提醒值必须大于 0")
        if self.quantity_tracking_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
            self.default_low_stock_threshold = None
        return self


class CreateIngredientRequest(_IngredientRequestBase):
    pass


class UpdateIngredientRequest(_IngredientRequestBase):
    pass


class VersionedInventoryItemRef(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)


class PresenceTransitionResolution(BaseModel):
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""
    mark_inventory_confirmed: bool = False

    @model_validator(mode="after")
    def validate_presence_resolution(self) -> "PresenceTransitionResolution":
        if self.storage_location is not None:
            self.storage_location = self.storage_location.strip() or None
        self.notes = (self.notes or "").strip()

        if self.availability_level is InventoryAvailabilityLevel.ABSENT:
            if self.purchase_date is not None or self.expiry_date is not None or self.storage_location is not None:
                raise ValueError("标记为没有时不能保留采购日、到期日或存放位置")
            return self

        if not self.storage_location:
            raise ValueError("有库存时必须填写存放位置")
        if self.purchase_date is not None and self.expiry_date is not None and self.expiry_date < self.purchase_date:
            raise ValueError("到期日不能早于采购日")
        return self


class ExactTransitionResolution(BaseModel):
    confirm_absent: bool
    quantity: Decimal | None = None
    unit: str | None = None
    inventory_status: InventoryStatus | None = None
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""

    @model_validator(mode="after")
    def validate_exact_resolution(self) -> "ExactTransitionResolution":
        if self.unit is not None:
            self.unit = self.unit.strip() or None
        if self.storage_location is not None:
            self.storage_location = self.storage_location.strip() or None
        self.notes = (self.notes or "").strip()

        if self.confirm_absent:
            if any(
                value is not None
                for value in (
                    self.quantity,
                    self.unit,
                    self.inventory_status,
                    self.purchase_date,
                    self.expiry_date,
                    self.storage_location,
                )
            ):
                raise ValueError("确认没有库存时不能填写数量、单位、状态、日期或位置")
            return self

        if self.quantity is None or self.quantity <= 0:
            raise ValueError("初始库存数量必须大于 0")
        if not self.unit:
            raise ValueError("初始库存单位不能为空")
        if self.inventory_status is None:
            raise ValueError("初始库存状态不能为空")
        if self.purchase_date is None:
            raise ValueError("初始库存采购日不能为空")
        if not self.storage_location:
            raise ValueError("初始库存存放位置不能为空")
        if self.expiry_date is not None and self.expiry_date < self.purchase_date:
            raise ValueError("到期日不能早于采购日")
        return self


class IngredientTrackingModeTransitionRequest(BaseModel):
    expected_ingredient_row_version: int = Field(ge=1)
    target_mode: IngredientQuantityTrackingMode
    expected_state_row_version: int | None = Field(default=None, ge=1)
    observed_batches: list[VersionedInventoryItemRef] = Field(default_factory=list)
    presence_resolution: PresenceTransitionResolution | None = None
    exact_resolution: ExactTransitionResolution | None = None

    @model_validator(mode="after")
    def validate_transition_payload(self) -> "IngredientTrackingModeTransitionRequest":
        batch_ids = [item.inventory_item_id for item in self.observed_batches]
        if len(batch_ids) != len(set(batch_ids)):
            raise ValueError("observed_batches 中的库存批次不能重复")

        if self.target_mode is IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
            if self.presence_resolution is None:
                raise ValueError("切换到只记录有无时必须提供 presence_resolution")
            if self.exact_resolution is not None:
                raise ValueError("切换到只记录有无时不能提供 exact_resolution")
            return self

        if self.target_mode is IngredientQuantityTrackingMode.TRACK_QUANTITY:
            if self.exact_resolution is None:
                raise ValueError("切换到记录数量时必须提供 exact_resolution")
            if self.presence_resolution is not None:
                raise ValueError("切换到记录数量时不能提供 presence_resolution")
            if self.observed_batches:
                raise ValueError("切换到记录数量时 observed_batches 必须为空")
            return self

        raise ValueError("不支持的跟踪模式")
