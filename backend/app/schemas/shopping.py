from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.core.enums import IngredientQuantityTrackingMode


class ShoppingListItemOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str | None = None
    food_id: str | None = None
    target_type: str = "ingredient"
    title: str
    quantity: float
    unit: str
    quantity_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    display_label: str | None = None
    reason: str
    done: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None
    row_version: int = 1


class CreateShoppingListItemRequest(BaseModel):
    title: str
    quantity: float | None = None
    unit: str | None = None
    ingredient_id: str | None = None
    food_id: str | None = None
    quantity_mode: IngredientQuantityTrackingMode = IngredientQuantityTrackingMode.TRACK_QUANTITY
    display_label: str | None = None
    reason: str = ""

    @model_validator(mode="after")
    def validate_quantity_contract(self) -> "CreateShoppingListItemRequest":
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("购物项名称不能为空")
        self.unit = self.unit.strip() if self.unit else None
        if self.display_label is not None:
            self.display_label = self.display_label.strip() or None
        if self.quantity_mode == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY:
            self.quantity = self.quantity if self.quantity is not None else 1
            self.unit = self.unit or "份"
            self.display_label = self.display_label or "需要补充"
            return self
        if self.quantity is None or self.quantity <= 0:
            raise ValueError("采购数量必须大于 0")
        if not self.unit and not (self.ingredient_id or self.food_id):
            raise ValueError("采购单位不能为空")
        self.display_label = self.display_label or None
        return self


class UpdateShoppingListItemRequest(BaseModel):
    title: str | None = None
    quantity: float | None = None
    unit: str | None = None
    ingredient_id: str | None = None
    food_id: str | None = None
    quantity_mode: IngredientQuantityTrackingMode | None = None
    display_label: str | None = None
    reason: str | None = None
    done: bool | None = None
    expected_row_version: int = Field(ge=1)

    @model_validator(mode="after")
    def normalize_update_fields(self) -> "UpdateShoppingListItemRequest":
        if "title" in self.model_fields_set and self.title is not None:
            self.title = self.title.strip()
            if not self.title:
                raise ValueError("购物项名称不能为空")
        if "unit" in self.model_fields_set and self.unit is not None:
            self.unit = self.unit.strip() or None
        if "display_label" in self.model_fields_set and self.display_label is not None:
            self.display_label = self.display_label.strip() or None
        if "reason" in self.model_fields_set and self.reason is not None:
            self.reason = self.reason.strip()
        if "quantity" in self.model_fields_set and self.quantity is not None and self.quantity <= 0:
            raise ValueError("采购数量必须大于 0")
        return self
