from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import InventoryAvailabilityLevel, InventoryStatus
from app.schemas.inventory_operations import (
    CompleteWithoutInventoryItemRequest,
    ExactIngredientShoppingIntakeItemRequest,
    FoodShoppingIntakeItemRequest,
    InventoryOperationResult,
    PresenceIngredientShoppingIntakeItemRequest,
    ShoppingIntakeItemRequest,
    ShoppingIntakeItemResult,
    ShoppingIntakeRequest,
    ShoppingIntakeResult,
)


InventoryIntakeSourceKind = Literal["shopping_item", "direct"]
InventoryIntakeAction = Literal["stock_and_fulfill", "fulfill_without_stock", "stock_only"]
InventoryIntakeTargetKind = Literal["exact_ingredient", "presence_ingredient", "food", "none"]
InventoryIntakeItemResultKind = Literal[
    "completed",
    "partial",
    "stocked",
    "completed_without_inventory",
    "direct_stocked",
]


class InventoryIntakeItemRequest(BaseModel):
    line_id: str = Field(min_length=1, max_length=64)
    source_kind: InventoryIntakeSourceKind
    action: InventoryIntakeAction
    shopping_item_id: str | None = None
    expected_shopping_item_row_version: int | None = Field(default=None, ge=1)
    target_kind: InventoryIntakeTargetKind
    target_id: str | None = None
    expected_ingredient_row_version: int | None = Field(default=None, ge=1)
    expected_food_row_version: int | None = Field(default=None, ge=1)
    state_id: str | None = None
    expected_state_row_version: int | None = Field(default=None, ge=1)
    actual_quantity: Decimal | None = Field(default=None, gt=0)
    unit: str | None = None
    resulting_availability_level: InventoryAvailabilityLevel | None = None
    inventory_status: InventoryStatus | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = Field(default="", max_length=500)

    @field_validator(
        "line_id",
        "shopping_item_id",
        "target_id",
        "state_id",
        "unit",
        "storage_location",
        mode="before",
    )
    @classmethod
    def _strip_optional_text(cls, value: object) -> object:
        if value is None:
            return None
        if not isinstance(value, str):
            return value
        cleaned = value.strip()
        return cleaned or None

    @field_validator("notes", mode="before")
    @classmethod
    def _normalize_notes(cls, value: object) -> str:
        if value is None:
            return ""
        if not isinstance(value, str):
            return str(value)
        return value.strip()

    @field_validator("line_id")
    @classmethod
    def _require_line_id(cls, value: str | None) -> str:
        if not value:
            raise ValueError("line_id 不能为空")
        return value

    @model_validator(mode="after")
    def _validate_global_constraints(self) -> "InventoryIntakeItemRequest":
        source = self.source_kind
        action = self.action
        target_kind = self.target_kind

        valid_combinations = {
            ("shopping_item", "stock_and_fulfill"),
            ("shopping_item", "fulfill_without_stock"),
            ("direct", "stock_only"),
        }
        if (source, action) not in valid_combinations:
            raise ValueError(f"不支持的 source_kind/action 组合: {source}/{action}")

        has_shopping_id = self.shopping_item_id is not None
        has_shopping_version = self.expected_shopping_item_row_version is not None

        if source == "shopping_item":
            if not has_shopping_id or not has_shopping_version:
                raise ValueError("shopping_item 来源必须提供 shopping_item_id 与 expected_shopping_item_row_version")
        else:
            if has_shopping_id or has_shopping_version:
                raise ValueError("direct 来源不能提供购物项身份信息")

        if action == "fulfill_without_stock":
            if target_kind != "none":
                raise ValueError("fulfill_without_stock 必须使用 target_kind=none")
            self._reject_inventory_target_fields()
            return self

        # stock actions require a real inventory target
        if target_kind == "none":
            raise ValueError("入库动作必须提供真实库存目标")

        if target_kind == "exact_ingredient":
            self._require_exact_ingredient_target()
        elif target_kind == "presence_ingredient":
            self._require_presence_ingredient_target()
        elif target_kind == "food":
            self._require_food_target()
        else:
            raise ValueError(f"不支持的 target_kind: {target_kind}")

        return self

    def _reject_inventory_target_fields(self) -> None:
        forbidden = {
            "target_id": self.target_id,
            "expected_ingredient_row_version": self.expected_ingredient_row_version,
            "expected_food_row_version": self.expected_food_row_version,
            "state_id": self.state_id,
            "expected_state_row_version": self.expected_state_row_version,
            "actual_quantity": self.actual_quantity,
            "unit": self.unit,
            "resulting_availability_level": self.resulting_availability_level,
            "inventory_status": self.inventory_status,
            "expiry_date": self.expiry_date,
            "storage_location": self.storage_location,
        }
        present = [name for name, value in forbidden.items() if value is not None]
        if present:
            raise ValueError(f"fulfill_without_stock 不能包含库存目标字段: {', '.join(present)}")

    def _require_target_id(self) -> None:
        if not self.target_id:
            raise ValueError("入库动作必须提供 target_id")

    def _require_exact_ingredient_target(self) -> None:
        self._require_target_id()
        if self.expected_ingredient_row_version is None:
            raise ValueError("exact_ingredient 必须提供 expected_ingredient_row_version")
        if self.expected_food_row_version is not None:
            raise ValueError("exact_ingredient 不能提供 expected_food_row_version")
        if self.state_id is not None or self.expected_state_row_version is not None:
            raise ValueError("exact_ingredient 不能提供 presence state 身份")
        if self.resulting_availability_level is not None:
            raise ValueError("exact_ingredient 不能提供 resulting_availability_level")
        if self.actual_quantity is None:
            raise ValueError("exact_ingredient 必须提供 actual_quantity")
        if not self.unit:
            raise ValueError("exact_ingredient 必须提供 unit")
        if self.inventory_status is None:
            raise ValueError("exact_ingredient 必须提供 inventory_status")

    def _require_presence_ingredient_target(self) -> None:
        self._require_target_id()
        if self.expected_ingredient_row_version is None:
            raise ValueError("presence_ingredient 必须提供 expected_ingredient_row_version")
        if self.expected_food_row_version is not None:
            raise ValueError("presence_ingredient 不能提供 expected_food_row_version")
        if self.actual_quantity is not None or self.unit is not None:
            raise ValueError("presence_ingredient 不能提供 actual_quantity/unit")
        has_state_id = self.state_id is not None
        has_state_version = self.expected_state_row_version is not None
        if has_state_id != has_state_version:
            raise ValueError("更新库存状态时必须同时提供 state_id 与 expected_state_row_version")
        if self.resulting_availability_level is None:
            raise ValueError("presence_ingredient 必须提供 resulting_availability_level")
        if self.resulting_availability_level is InventoryAvailabilityLevel.ABSENT:
            raise ValueError("入库不能将食材标记为没有")
        if self.inventory_status is None:
            raise ValueError("presence_ingredient 必须提供 inventory_status")

    def _require_food_target(self) -> None:
        self._require_target_id()
        if self.expected_food_row_version is None:
            raise ValueError("food 必须提供 expected_food_row_version")
        if self.expected_ingredient_row_version is not None:
            raise ValueError("food 不能提供 expected_ingredient_row_version")
        if self.state_id is not None or self.expected_state_row_version is not None:
            raise ValueError("food 不能提供 presence state 身份")
        if self.resulting_availability_level is not None:
            raise ValueError("food 不能提供 resulting_availability_level")
        if self.inventory_status is not None:
            raise ValueError("food 不能提供 inventory_status")
        if self.actual_quantity is None:
            raise ValueError("food 必须提供 actual_quantity")
        if not self.unit:
            raise ValueError("food 必须提供 unit")


class InventoryIntakeRequest(BaseModel):
    client_request_id: str = Field(min_length=1, max_length=120)
    intake_date: date
    items: list[InventoryIntakeItemRequest] = Field(min_length=1, max_length=100)

    @field_validator("client_request_id")
    @classmethod
    def _normalize_client_request_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("client_request_id 不能为空")
        return cleaned

    @model_validator(mode="after")
    def _reject_duplicate_identities(self) -> "InventoryIntakeRequest":
        seen_line_ids: set[str] = set()
        seen_shopping_ids: set[str] = set()
        for item in self.items:
            if item.line_id in seen_line_ids:
                raise ValueError("请求中包含重复的 line_id")
            seen_line_ids.add(item.line_id)
            if item.shopping_item_id is not None:
                if item.shopping_item_id in seen_shopping_ids:
                    raise ValueError("请求中包含重复的采购项")
                seen_shopping_ids.add(item.shopping_item_id)
        return self


class InventoryIntakeItemResult(BaseModel):
    line_id: str
    source_kind: InventoryIntakeSourceKind
    shopping_item_id: str | None = None
    result: InventoryIntakeItemResultKind
    remaining_planned_quantity: Decimal | None = None
    inventory_item_id: str | None = None
    state_id: str | None = None
    food_id: str | None = None


class InventoryIntakeResult(InventoryOperationResult):
    items: list[InventoryIntakeItemResult]


def shopping_request_to_inventory_request(request: ShoppingIntakeRequest) -> InventoryIntakeRequest:
    """Pure one-to-one mapping from product shopping intake to generalized intake."""
    items: list[InventoryIntakeItemRequest] = []
    for item in request.items:
        items.append(_shopping_item_to_inventory_item(item))
    return InventoryIntakeRequest(
        client_request_id=request.client_request_id,
        intake_date=request.purchase_date,
        items=items,
    )


def _shopping_item_to_inventory_item(item: ShoppingIntakeItemRequest) -> InventoryIntakeItemRequest:
    line_id = f"shopping:{item.shopping_item_id}"
    if isinstance(item, CompleteWithoutInventoryItemRequest):
        return InventoryIntakeItemRequest(
            line_id=line_id,
            source_kind="shopping_item",
            action="fulfill_without_stock",
            shopping_item_id=item.shopping_item_id,
            expected_shopping_item_row_version=item.expected_shopping_item_row_version,
            target_kind="none",
            target_id=None,
        )
    if isinstance(item, ExactIngredientShoppingIntakeItemRequest):
        return InventoryIntakeItemRequest(
            line_id=line_id,
            source_kind="shopping_item",
            action="stock_and_fulfill",
            shopping_item_id=item.shopping_item_id,
            expected_shopping_item_row_version=item.expected_shopping_item_row_version,
            target_kind="exact_ingredient",
            target_id=item.target_id,
            expected_ingredient_row_version=item.expected_ingredient_row_version,
            actual_quantity=item.actual_quantity,
            unit=item.unit,
            inventory_status=item.inventory_status,
            expiry_date=item.expiry_date,
            storage_location=item.storage_location,
            notes=item.notes,
        )
    if isinstance(item, PresenceIngredientShoppingIntakeItemRequest):
        return InventoryIntakeItemRequest(
            line_id=line_id,
            source_kind="shopping_item",
            action="stock_and_fulfill",
            shopping_item_id=item.shopping_item_id,
            expected_shopping_item_row_version=item.expected_shopping_item_row_version,
            target_kind="presence_ingredient",
            target_id=item.target_id,
            expected_ingredient_row_version=item.expected_ingredient_row_version,
            state_id=item.state_id,
            expected_state_row_version=item.expected_state_row_version,
            resulting_availability_level=item.resulting_availability_level,
            inventory_status=item.inventory_status,
            expiry_date=item.expiry_date,
            storage_location=item.storage_location,
            notes=item.notes,
        )
    if isinstance(item, FoodShoppingIntakeItemRequest):
        return InventoryIntakeItemRequest(
            line_id=line_id,
            source_kind="shopping_item",
            action="stock_and_fulfill",
            shopping_item_id=item.shopping_item_id,
            expected_shopping_item_row_version=item.expected_shopping_item_row_version,
            target_kind="food",
            target_id=item.target_id,
            expected_food_row_version=item.expected_food_row_version,
            actual_quantity=item.actual_quantity,
            unit=item.unit,
            expiry_date=item.expiry_date,
            storage_location=item.storage_location,
        )
    raise TypeError(f"Unsupported shopping intake item type: {type(item)!r}")


def inventory_result_to_shopping_result(result: InventoryIntakeResult) -> ShoppingIntakeResult:
    """Map generalized intake results back to the product shopping intake response."""
    shopping_items: list[ShoppingIntakeItemResult] = []
    for item in result.items:
        if item.source_kind != "shopping_item":
            raise ValueError("shopping intake 结果不能包含 direct 行")
        if item.result == "direct_stocked":
            raise ValueError("shopping intake 结果不能包含 direct_stocked")
        if item.shopping_item_id is None:
            raise ValueError("shopping_item 结果必须包含 shopping_item_id")
        if item.result not in {
            "completed",
            "partial",
            "stocked",
            "completed_without_inventory",
        }:
            raise ValueError(f"不支持的 shopping intake result: {item.result}")
        shopping_items.append(
            ShoppingIntakeItemResult(
                shopping_item_id=item.shopping_item_id,
                result=item.result,  # pyright: ignore[reportArgumentType]
                remaining_planned_quantity=item.remaining_planned_quantity,
                inventory_item_id=item.inventory_item_id,
                state_id=item.state_id,
                food_id=item.food_id,
            )
        )
    return ShoppingIntakeResult(
        operation_id=result.operation_id,
        operation_type=result.operation_type,
        status=result.status,
        applied_at=result.applied_at,
        revertible_until=result.revertible_until,
        can_revert=result.can_revert,
        summary=result.summary,
        items=shopping_items,
    )
