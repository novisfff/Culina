from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import IngredientExpiryMode, IngredientQuantityTrackingMode
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
