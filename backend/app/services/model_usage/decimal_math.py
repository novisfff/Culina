from __future__ import annotations

from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP, localcontext


CNY_QUANTUM = Decimal("0.000000000001")
QUANTITY_QUANTUM = Decimal("0.000001")


def _require_decimal(value: Decimal, *, name: str) -> Decimal:
    if not isinstance(value, Decimal):
        raise TypeError(f"{name} must be a Decimal")
    if not value.is_finite():
        raise ValueError(f"{name} must be finite")
    return value


def _require_non_negative(value: Decimal, *, name: str) -> Decimal:
    checked = _require_decimal(value, name=name)
    if checked < 0:
        raise ValueError(f"{name} cannot be negative")
    return checked


def quantize_quantity(quantity: Decimal) -> Decimal:
    checked = _require_non_negative(quantity, name="quantity")
    return checked.quantize(QUANTITY_QUANTUM, rounding=ROUND_HALF_UP)


def _line_cost(
    quantity: Decimal,
    unit_price: Decimal,
    unit_quantity: Decimal,
    *,
    rounding: str,
) -> Decimal:
    checked_quantity = _require_non_negative(quantity, name="quantity")
    checked_unit_price = _require_non_negative(unit_price, name="unit_price")
    checked_unit_quantity = _require_decimal(unit_quantity, name="unit_quantity")
    if checked_unit_quantity <= 0:
        raise ValueError("unit_quantity must be greater than zero")

    with localcontext() as context:
        context.prec = 80
        raw = checked_quantity * checked_unit_price / checked_unit_quantity
        return raw.quantize(CNY_QUANTUM, rounding=rounding)


def exact_line_cost(
    quantity: Decimal,
    unit_price: Decimal,
    unit_quantity: Decimal,
) -> Decimal:
    return _line_cost(
        quantity,
        unit_price,
        unit_quantity,
        rounding=ROUND_HALF_UP,
    )


def reservation_line_cost(
    quantity: Decimal,
    unit_price: Decimal,
    unit_quantity: Decimal,
) -> Decimal:
    return _line_cost(
        quantity,
        unit_price,
        unit_quantity,
        rounding=ROUND_CEILING,
    )


def would_exceed_limit(
    current_value: Decimal,
    increment: Decimal,
    limit: Decimal,
) -> bool:
    checked_current = _require_non_negative(current_value, name="current_value")
    checked_increment = _require_non_negative(increment, name="increment")
    checked_limit = _require_non_negative(limit, name="limit")
    return checked_current + checked_increment > checked_limit
