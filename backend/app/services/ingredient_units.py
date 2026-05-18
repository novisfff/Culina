from __future__ import annotations

from collections.abc import Iterable, Mapping
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


UNIT_QUANTITY_PRECISION = Decimal("0.01")


class UnitConversionError(ValueError):
    pass


def normalize_unit_label(value: str | None) -> str:
    return (value or "").strip()


def quantize_quantity(value: Decimal) -> Decimal:
    return value.quantize(UNIT_QUANTITY_PRECISION, rounding=ROUND_HALF_UP)


def _parse_decimal(value: Decimal | float | int | str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise UnitConversionError("换算值格式不正确") from exc


def serialize_unit_conversions(
    default_unit: str,
    unit_conversions: Iterable[Mapping[str, Any]] | None,
) -> list[dict[str, float | str]]:
    normalized_default_unit = normalize_unit_label(default_unit)
    seen_units = {normalized_default_unit} if normalized_default_unit else set()
    serialized: list[dict[str, float | str]] = []

    for raw_entry in unit_conversions or []:
        raw_unit = raw_entry.get("unit") if isinstance(raw_entry, Mapping) else None
        raw_ratio = raw_entry.get("ratio_to_default") if isinstance(raw_entry, Mapping) else None
        unit = normalize_unit_label(raw_unit if isinstance(raw_unit, str) else "")
        if not unit or unit in seen_units:
            continue
        try:
            ratio = _parse_decimal(raw_ratio)
        except UnitConversionError:
            continue
        if ratio <= 0:
            continue
        seen_units.add(unit)
        serialized.append(
            {
                "unit": unit,
                "ratio_to_default": float(ratio),
            }
        )

    return serialized


def validate_unit_conversions(
    default_unit: str,
    unit_conversions: Iterable[Mapping[str, Any]] | None,
) -> list[dict[str, float | str]]:
    normalized_default_unit = normalize_unit_label(default_unit)
    if not normalized_default_unit:
        raise UnitConversionError("主单位不能为空")

    normalized_entries: list[dict[str, float | str]] = []
    seen_units = {normalized_default_unit}

    for raw_entry in unit_conversions or []:
        raw_unit = raw_entry.get("unit") if isinstance(raw_entry, Mapping) else None
        raw_ratio = raw_entry.get("ratio_to_default") if isinstance(raw_entry, Mapping) else None
        unit = normalize_unit_label(raw_unit if isinstance(raw_unit, str) else "")
        if not unit:
            raise UnitConversionError("副单位不能为空")
        if unit in seen_units:
            raise UnitConversionError("单位不能重复，且不能与主单位相同")
        ratio = _parse_decimal(raw_ratio)
        if ratio <= 0:
            raise UnitConversionError("换算值必须大于 0")
        seen_units.add(unit)
        normalized_entries.append(
            {
                "unit": unit,
                "ratio_to_default": float(ratio),
            }
        )

    return normalized_entries


def get_supported_units(default_unit: str, unit_conversions: Iterable[Mapping[str, Any]] | None) -> list[str]:
    normalized_default_unit = normalize_unit_label(default_unit)
    units = [normalized_default_unit] if normalized_default_unit else []
    units.extend(entry["unit"] for entry in serialize_unit_conversions(default_unit, unit_conversions))
    return units


def resolve_ratio_to_default(
    default_unit: str,
    unit_conversions: Iterable[Mapping[str, Any]] | None,
    unit: str,
) -> Decimal:
    normalized_default_unit = normalize_unit_label(default_unit)
    normalized_unit = normalize_unit_label(unit)
    if not normalized_unit:
        raise UnitConversionError("单位不能为空")
    if normalized_unit == normalized_default_unit:
        return Decimal("1")

    for entry in serialize_unit_conversions(default_unit, unit_conversions):
        if entry["unit"] == normalized_unit:
            return Decimal(str(entry["ratio_to_default"]))

    raise UnitConversionError(f"不支持单位 {normalized_unit}")


def convert_quantity_to_default_unit(
    quantity: Decimal | float | int | str,
    default_unit: str,
    unit_conversions: Iterable[Mapping[str, Any]] | None,
    unit: str,
) -> Decimal:
    numeric_quantity = _parse_decimal(quantity)
    return quantize_quantity(numeric_quantity * resolve_ratio_to_default(default_unit, unit_conversions, unit))


def convert_quantity_from_default_unit(
    quantity: Decimal | float | int | str,
    default_unit: str,
    unit_conversions: Iterable[Mapping[str, Any]] | None,
    unit: str,
) -> Decimal:
    numeric_quantity = _parse_decimal(quantity)
    ratio = resolve_ratio_to_default(default_unit, unit_conversions, unit)
    return quantize_quantity(numeric_quantity / ratio)
