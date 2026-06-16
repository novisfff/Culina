from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.models.domain import Ingredient
from app.services.ingredient_units import normalize_unit_label


def normalize_pending_unit_mismatch(value: dict[str, Any]) -> dict[str, Any]:
    draft = value.get("originalDraft") if isinstance(value.get("originalDraft"), dict) else {}
    operations = draft.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("单位换算澄清缺少原始库存操作")

    ingredient_id = str(value.get("ingredientId") or "").strip()
    ingredient_name = str(value.get("ingredientName") or "").strip()
    default_unit = normalize_unit_label(str(value.get("defaultUnit") or ""))
    unsupported_unit = normalize_unit_label(str(value.get("unsupportedUnit") or ""))
    if not ingredient_id or not ingredient_name or not default_unit or not unsupported_unit:
        raise ValueError("单位换算澄清缺少食材或单位信息")

    matched_operation: dict[str, Any] | None = None
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        unit = normalize_unit_label(str(operation.get("unit") or ""))
        operation_ingredient_id = str(operation.get("ingredientId") or operation.get("ingredient_id") or "").strip()
        if unit == unsupported_unit and operation_ingredient_id == ingredient_id:
            matched_operation = operation
            break
    if matched_operation is None:
        raise ValueError("单位换算澄清与原始库存操作不匹配")

    supported_units = [
        normalize_unit_label(str(unit))
        for unit in (value.get("supportedUnits") if isinstance(value.get("supportedUnits"), list) else [])
        if normalize_unit_label(str(unit))
    ]
    if default_unit not in supported_units:
        supported_units.insert(0, default_unit)

    return {
        "type": "inventory_unit_mismatch",
        "ingredientId": ingredient_id,
        "ingredientName": ingredient_name,
        "defaultUnit": default_unit,
        "unsupportedUnit": unsupported_unit,
        "supportedUnits": list(dict.fromkeys(supported_units)),
        "originalDraft": draft,
    }


def unit_mismatch_from_pending_clarification(value: dict[str, Any]) -> dict[str, Any]:
    if str(value.get("questionType") or "") != "unit_conversion":
        raise ValueError("补全信息不是单位换算类型")
    payload = value.get("payload") if isinstance(value.get("payload"), dict) else {}
    unit_mismatch = payload.get("unitMismatch") if isinstance(payload.get("unitMismatch"), dict) else None
    if unit_mismatch is None:
        raise ValueError("单位换算补全缺少原始单位信息")
    return unit_mismatch


def build_unit_conversion_candidate(
    *,
    pending: dict[str, Any],
    ratio_to_default: Decimal,
    source_message: str,
) -> dict[str, Any]:
    return {
        "type": "unit_conversion_candidate",
        "ingredientId": pending.get("ingredientId"),
        "ingredientName": pending.get("ingredientName"),
        "defaultUnit": pending.get("defaultUnit"),
        "unit": pending.get("unsupportedUnit"),
        "ratioToDefault": float(ratio_to_default),
        "sourceMessage": source_message,
    }


def build_unit_mismatch_inventory_payload(
    db: Session,
    *,
    family_id: str,
    pending: dict[str, Any],
    ratio_to_default: Decimal,
) -> dict[str, Any]:
    ingredient_id = str(pending.get("ingredientId") or "").strip()
    ingredient = db.get(Ingredient, ingredient_id) if ingredient_id else None
    if ingredient is None or ingredient.family_id != family_id:
        raise ValueError("食材不存在或已被删除")

    original_draft = pending.get("originalDraft") if isinstance(pending.get("originalDraft"), dict) else {}
    original_operations = original_draft.get("operations")
    if not isinstance(original_operations, list) or not original_operations:
        raise ValueError("缺少原始库存操作")

    unsupported_unit = normalize_unit_label(str(pending.get("unsupportedUnit") or ""))
    default_unit = normalize_unit_label(str(pending.get("defaultUnit") or ingredient.default_unit))
    converted_operations: list[dict[str, Any]] = []
    for operation in original_operations:
        if not isinstance(operation, dict):
            continue
        next_operation = dict(operation)
        if str(next_operation.get("ingredientId") or next_operation.get("ingredient_id") or "") == ingredient.id and normalize_unit_label(str(next_operation.get("unit") or "")) == unsupported_unit:
            source_quantity = Decimal(str(next_operation.get("quantity")))
            converted_quantity = source_quantity * ratio_to_default
            next_operation["quantity"] = float(converted_quantity)
            next_operation["unit"] = default_unit
            next_operation["sourceQuantity"] = float(source_quantity)
            next_operation["sourceUnit"] = unsupported_unit
            next_operation["conversionRatioToDefault"] = float(ratio_to_default)
            next_operation["conversionNote"] = (
                f"来自 {float(source_quantity):g} {unsupported_unit}，"
                f"按 1 {unsupported_unit} = {float(ratio_to_default):g} {default_unit}换算。"
            )
        converted_operations.append(next_operation)
    return {
        "draftType": "inventory_operation",
        "schemaVersion": "inventory_operation.v1",
        "operations": converted_operations,
        "source": {
            **(original_draft.get("source") if isinstance(original_draft.get("source"), dict) else {}),
            "unitMismatchRecovery": {
                "ingredientId": ingredient.id,
                "ingredientName": ingredient.name,
                "sourceUnit": unsupported_unit,
                "defaultUnit": default_unit,
                "ratioToDefault": float(ratio_to_default),
            },
        },
    }
