from __future__ import annotations

from decimal import Decimal, ROUND_DOWN


FOOD_STOCK_QUANTUM = Decimal("0.1")


def normalize_food_stock_quantity(value: Decimal) -> Decimal:
    return value.quantize(FOOD_STOCK_QUANTUM, rounding=ROUND_DOWN)


def validate_food_stock_quantity_precision(value: Decimal, field_label: str = "库存数量") -> None:
    if value != normalize_food_stock_quantity(value):
        raise ValueError(f"{field_label}最多保留 1 位小数")


def format_food_stock_quantity(value: Decimal | None, unit: str, fallback: str = "未记录") -> str:
    if value is None:
        return fallback
    normalized = normalize_food_stock_quantity(value)
    text = format(normalized.normalize(), "f")
    return f"{text}{unit or '份'}"
