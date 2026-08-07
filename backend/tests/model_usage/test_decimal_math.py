from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.model_usage.decimal_math import (
    exact_line_cost,
    quantize_quantity,
    reservation_line_cost,
    would_exceed_limit,
)


def test_exact_and_reservation_rounding_are_distinct() -> None:
    assert exact_line_cost(
        Decimal("1"),
        Decimal("0.0000000000005"),
        Decimal("1"),
    ) == Decimal("0.000000000001")
    assert reservation_line_cost(
        Decimal("1"),
        Decimal("0.0000000000001"),
        Decimal("1"),
    ) == Decimal("0.000000000001")


def test_budget_comparison_does_not_round_to_cents() -> None:
    assert would_exceed_limit(
        Decimal("0.009"),
        Decimal("0.002"),
        Decimal("0.010"),
    ) is True


def test_quantity_is_quantized_to_storage_precision() -> None:
    assert quantize_quantity(Decimal("1.2345675")) == Decimal("1.234568")


@pytest.mark.parametrize(
    ("quantity", "unit_price", "unit_quantity"),
    (
        (Decimal("-1"), Decimal("1"), Decimal("1")),
        (Decimal("1"), Decimal("-1"), Decimal("1")),
        (Decimal("1"), Decimal("1"), Decimal("0")),
        (Decimal("1"), Decimal("1"), Decimal("-1")),
    ),
)
def test_line_cost_rejects_invalid_values(
    quantity: Decimal,
    unit_price: Decimal,
    unit_quantity: Decimal,
) -> None:
    with pytest.raises(ValueError):
        exact_line_cost(quantity, unit_price, unit_quantity)


def test_decimal_helpers_reject_float_inputs() -> None:
    with pytest.raises(TypeError):
        exact_line_cost(1.0, Decimal("1"), Decimal("1"))  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        would_exceed_limit(Decimal("1"), 1.0, Decimal("2"))  # type: ignore[arg-type]


def test_decimal_helpers_reject_non_finite_values() -> None:
    with pytest.raises(ValueError):
        quantize_quantity(Decimal("NaN"))
