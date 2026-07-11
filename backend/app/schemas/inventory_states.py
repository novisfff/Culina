from __future__ import annotations

from datetime import date as date_type, datetime

from pydantic import BaseModel, Field, model_validator

from app.core.enums import InventoryAvailabilityLevel, InventoryConfirmationSource, InventoryStatus


class IngredientInventoryStateOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date_type | None
    expiry_date: date_type | None
    storage_location: str | None
    notes: str
    expiry_alert_snoozed_until: date_type | None
    expiry_reviewed_at: datetime | None
    expiry_reviewed_by: str | None
    last_confirmed_at: datetime | None
    last_confirmed_by: str | None
    last_confirmation_source: InventoryConfirmationSource | None
    row_version: int
    created_at: datetime
    updated_at: datetime


class UpsertIngredientInventoryStateRequest(BaseModel):
    expected_ingredient_row_version: int = Field(ge=1)
    state_id: str | None = None
    expected_state_row_version: int | None = Field(default=None, ge=1)
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date_type | None = None
    expiry_date: date_type | None = None
    storage_location: str | None = None
    notes: str = ""

    @model_validator(mode="after")
    def validate_state_identity_and_presence_metadata(self) -> "UpsertIngredientInventoryStateRequest":
        has_state_id = self.state_id is not None
        has_state_version = self.expected_state_row_version is not None
        if has_state_id != has_state_version:
            raise ValueError("更新库存状态时必须同时提供 state_id 与 expected_state_row_version")

        if self.storage_location is not None:
            self.storage_location = self.storage_location.strip() or None
        self.notes = (self.notes or "").strip()

        if self.availability_level is InventoryAvailabilityLevel.ABSENT:
            if self.purchase_date is not None or self.expiry_date is not None or self.storage_location is not None:
                raise ValueError("标记为没有时不能保留采购日、到期日或存放位置")
            return self

        if self.purchase_date is not None and self.expiry_date is not None and self.expiry_date < self.purchase_date:
            raise ValueError("到期日不能早于采购日")
        return self
