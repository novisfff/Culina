from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.core.enums import InventoryOperationStatus, InventoryOperationType
from app.schemas.inventory_intake import (
    InventoryIntakeRequest,
    InventoryIntakeResult,
    inventory_result_to_shopping_result,
    shopping_request_to_inventory_request,
)
from app.schemas.inventory_operations import (
    InventoryOperationDisplaySummary,
    ShoppingIntakeRequest,
)


def test_inventory_intake_accepts_shopping_and_direct_rows() -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "mixed-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": "shopping-eggs",
                    "expected_shopping_item_row_version": 2,
                    "target_kind": "exact_ingredient",
                    "target_id": "ingredient-eggs",
                    "expected_ingredient_row_version": 3,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": "food-milk",
                    "expected_food_row_version": 4,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    assert [item.source_kind for item in request.items] == ["shopping_item", "direct"]


@pytest.mark.parametrize(
    "source_kind,action",
    [
        ("direct", "stock_and_fulfill"),
        ("shopping_item", "stock_only"),
    ],
)
def test_inventory_intake_rejects_invalid_source_action(source_kind: str, action: str) -> None:
    row = {
        "line_id": "line-1",
        "source_kind": source_kind,
        "action": action,
        "target_kind": "food",
        "target_id": "food-milk",
        "expected_food_row_version": 1,
        "actual_quantity": "1",
        "unit": "袋",
        "storage_location": "冷藏",
    }
    if source_kind == "shopping_item":
        row.update(
            {
                "shopping_item_id": "shopping-milk",
                "expected_shopping_item_row_version": 1,
            }
        )
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "invalid-combination",
                "intake_date": "2026-07-21",
                "items": [row],
            }
        )


def test_inventory_intake_rejects_duplicate_line_ids() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "dup-line",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "same-line",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    },
                    {
                        "line_id": "same-line",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "袋",
                        "storage_location": "冷藏",
                    },
                ],
            }
        )


def test_inventory_intake_rejects_duplicate_shopping_item_ids() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "dup-shopping",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "line-1",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    },
                    {
                        "line_id": "line-2",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "none",
                    },
                ],
            }
        )


def test_direct_source_rejects_shopping_identity() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "direct-shopping-id",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "shopping_item_id": "shopping-milk",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "袋",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_direct_source_rejects_fulfill_action() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "direct-fulfill",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "fulfill_without_stock",
                        "target_kind": "none",
                    }
                ],
            }
        )


def test_shopping_source_rejects_stock_only() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "shopping-stock-only",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "stock_only",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_fulfill_without_stock_rejects_inventory_target() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "fulfill-target",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_presence_target_requires_paired_state_identity_and_version() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "presence-unpaired",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "salt",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-salt",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "presence_ingredient",
                        "target_id": "ingredient-salt",
                        "expected_ingredient_row_version": 1,
                        "state_id": "state-salt",
                        "resulting_availability_level": "sufficient",
                        "inventory_status": "fresh",
                        "storage_location": "常温",
                    }
                ],
            }
        )


def test_exact_and_food_targets_require_positive_quantity_and_unit() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "zero-qty",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "0",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )

    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "missing-unit",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_inventory_intake_rejects_invalid_calendar_date() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "bad-date",
                "intake_date": "2026-02-30",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "none",
                    }
                ],
            }
        )


def test_shopping_request_adapter_preserves_every_business_field() -> None:
    shopping_request = ShoppingIntakeRequest.model_validate(
        {
            "client_request_id": "shopping-adapter-1",
            "purchase_date": "2026-07-21",
            "items": [
                {
                    "shopping_item_id": "shopping-eggs",
                    "expected_shopping_item_row_version": 2,
                    "action": "stock_and_fulfill",
                    "target_kind": "exact_ingredient",
                    "target_id": "ingredient-eggs",
                    "expected_ingredient_row_version": 3,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "expiry_date": "2026-07-28",
                    "storage_location": "冷藏",
                    "notes": "盒装",
                },
                {
                    "shopping_item_id": "shopping-salt",
                    "expected_shopping_item_row_version": 4,
                    "action": "stock_and_fulfill",
                    "target_kind": "presence_ingredient",
                    "target_id": "ingredient-salt",
                    "expected_ingredient_row_version": 5,
                    "state_id": "state-salt",
                    "expected_state_row_version": 6,
                    "resulting_availability_level": "sufficient",
                    "inventory_status": "opened",
                    "storage_location": "常温",
                    "notes": "厨房",
                },
                {
                    "shopping_item_id": "shopping-milk",
                    "expected_shopping_item_row_version": 7,
                    "action": "stock_and_fulfill",
                    "target_kind": "food",
                    "target_id": "food-milk",
                    "expected_food_row_version": 8,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "expiry_date": "2026-07-25",
                    "storage_location": "冷藏",
                },
                {
                    "shopping_item_id": "shopping-bag",
                    "expected_shopping_item_row_version": 9,
                    "action": "complete_without_inventory",
                    "target_kind": "none",
                    "target_id": None,
                },
            ],
        }
    )

    inventory_request = shopping_request_to_inventory_request(shopping_request)

    assert inventory_request.client_request_id == "shopping-adapter-1"
    assert inventory_request.intake_date == date(2026, 7, 21)
    assert len(inventory_request.items) == 4

    exact, presence, food, fulfill = inventory_request.items

    assert exact.line_id == "shopping:shopping-eggs"
    assert exact.source_kind == "shopping_item"
    assert exact.action == "stock_and_fulfill"
    assert exact.shopping_item_id == "shopping-eggs"
    assert exact.expected_shopping_item_row_version == 2
    assert exact.target_kind == "exact_ingredient"
    assert exact.target_id == "ingredient-eggs"
    assert exact.expected_ingredient_row_version == 3
    assert exact.actual_quantity == Decimal("2")
    assert exact.unit == "个"
    assert exact.inventory_status is not None
    assert exact.inventory_status.value == "fresh"
    assert exact.expiry_date == date(2026, 7, 28)
    assert exact.storage_location == "冷藏"
    assert exact.notes == "盒装"

    assert presence.line_id == "shopping:shopping-salt"
    assert presence.source_kind == "shopping_item"
    assert presence.action == "stock_and_fulfill"
    assert presence.shopping_item_id == "shopping-salt"
    assert presence.expected_shopping_item_row_version == 4
    assert presence.target_kind == "presence_ingredient"
    assert presence.target_id == "ingredient-salt"
    assert presence.expected_ingredient_row_version == 5
    assert presence.state_id == "state-salt"
    assert presence.expected_state_row_version == 6
    assert presence.resulting_availability_level is not None
    assert presence.resulting_availability_level.value == "sufficient"
    assert presence.inventory_status is not None
    assert presence.inventory_status.value == "opened"
    assert presence.storage_location == "常温"
    assert presence.notes == "厨房"

    assert food.line_id == "shopping:shopping-milk"
    assert food.source_kind == "shopping_item"
    assert food.action == "stock_and_fulfill"
    assert food.shopping_item_id == "shopping-milk"
    assert food.expected_shopping_item_row_version == 7
    assert food.target_kind == "food"
    assert food.target_id == "food-milk"
    assert food.expected_food_row_version == 8
    assert food.actual_quantity == Decimal("1")
    assert food.unit == "袋"
    assert food.expiry_date == date(2026, 7, 25)
    assert food.storage_location == "冷藏"

    assert fulfill.line_id == "shopping:shopping-bag"
    assert fulfill.source_kind == "shopping_item"
    assert fulfill.action == "fulfill_without_stock"
    assert fulfill.shopping_item_id == "shopping-bag"
    assert fulfill.expected_shopping_item_row_version == 9
    assert fulfill.target_kind == "none"
    assert fulfill.target_id is None


def test_inventory_result_adapter_rejects_direct_rows() -> None:
    applied_at = datetime(2026, 7, 21, 12, 0, tzinfo=timezone.utc)
    inventory_result = InventoryIntakeResult.model_validate(
        {
            "operation_id": "op-1",
            "operation_type": InventoryOperationType.SHOPPING_INTAKE,
            "status": InventoryOperationStatus.APPLIED,
            "applied_at": applied_at,
            "revertible_until": applied_at,
            "can_revert": True,
            "summary": InventoryOperationDisplaySummary(
                title="登记本次购买",
                description="完成 1 项",
                completed_count=1,
                confirmed_count=1,
            ),
            "items": [
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "shopping_item_id": None,
                    "result": "direct_stocked",
                    "inventory_item_id": None,
                    "state_id": None,
                    "food_id": "food-milk",
                }
            ],
        }
    )

    with pytest.raises(ValueError):
        inventory_result_to_shopping_result(inventory_result)
