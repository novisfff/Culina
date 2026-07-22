from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select

from app.core.enums import (
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.core.utils import create_id
from app.models.domain import Food, Ingredient, IngredientInventoryState, Membership, ShoppingListItem
from app.schemas.inventory_intake import InventoryIntakeItemRequest, InventoryIntakeRequest
from app.services.ai_operations.registry_types import DraftExecuteContext, DraftNormalizeContext
from app.services.inventory_intake import apply_inventory_intake
from app.services.inventory_overview import is_ready_like_food


READY_LIKE_FOOD_TYPES = {
    FoodType.READY_MADE.value,
    FoodType.INSTANT.value,
    FoodType.PACKAGED.value,
}

SOURCE_TYPES = {
    "manual_text",
    "receipt_image",
    "receipt_text",
    "inventory_photo",
    "gift",
    "reconciliation",
    "initial_inventory",
    "historical_entry",
}

INTAKE_DATE_SOURCES = {
    "user_explicit",
    "receipt",
    "family_today",
    "historical",
}

VALID_ACTIONS_BY_SOURCE = {
    "shopping_item": {"stock_and_fulfill", "fulfill_without_stock", "skip"},
    "direct": {"stock_only", "skip"},
}

TOP_LEVEL_IMMUTABLE_FIELDS = (
    "clientRequestId",
    "sourceType",
    "sourceReference",
    "intakeDateSource",
    "ignoredItems",
)

ITEM_IMMUTABLE_FIELDS = (
    "lineId",
    "sourceLineId",
    "sourceText",
    "sourceKind",
    "shoppingItemId",
    "expectedShoppingItemRowVersion",
    "targetKind",
    "targetId",
    "expectedIngredientRowVersion",
    "expectedFoodRowVersion",
    "stateId",
    "expectedStateRowVersion",
    "plannedQuantity",
    "plannedUnit",
    "before",
)

BLOCKER_ITEM_KEYS = {
    "matchLevel",
    "matchReason",
    "unmatchedCandidates",
    "candidateIds",
    "blocker",
    "unresolved",
}


def _decimal(value: Any, *, label: str, required: bool = False) -> Decimal | None:
    if value is None or str(value).strip() == "":
        if required:
            raise ValueError(f"{label}不能为空")
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label}格式不正确") from exc
    if parsed <= 0:
        raise ValueError(f"{label}必须大于 0")
    return parsed


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value.normalize(), "f")


def _require_text(value: Any, *, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label}不能为空")
    return text


def _load_scoped(db, model, *, family_id: str, object_id: str, label: str):
    target = db.scalar(select(model).where(model.family_id == family_id, model.id == object_id))
    if target is None:
        raise ValueError(f"{label}不存在或不属于当前家庭")
    return target


def _canonical_actual(
    item: dict[str, Any],
    *,
    require_complete: bool,
) -> tuple[str | None, str | None, dict[str, Any] | None]:
    entered_quantity = _decimal(
        item.get("enteredQuantity"),
        label="实际入库数量",
        required=require_complete,
    )
    entered_unit = str(item.get("enteredUnit") or "").strip() or None
    conversion = item.get("packageConversion")
    normalized_conversion: dict[str, Any] | None = None
    actual_quantity = entered_quantity
    actual_unit = entered_unit
    if conversion is not None:
        if not isinstance(conversion, dict):
            raise ValueError("包装换算格式不正确")
        ratio = _decimal(conversion.get("ratio"), label="包装换算倍率", required=require_complete)
        target_unit = str(conversion.get("targetUnit") or "").strip() or None
        evidence = str(conversion.get("evidence") or "").strip() or None
        if require_complete and (not target_unit or not evidence):
            raise ValueError("包装换算必须提供目标单位和小票或用户证据")
        if entered_quantity is not None and ratio is not None:
            actual_quantity = entered_quantity * ratio
        actual_unit = target_unit
        normalized_conversion = {
            "ratio": _decimal_text(ratio),
            "targetUnit": target_unit,
            "evidence": evidence,
        }
    if require_complete and not actual_unit:
        raise ValueError("实际入库单位不能为空")
    return _decimal_text(actual_quantity), actual_unit, normalized_conversion


def _normalize_ignored_items(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("已忽略项格式不正确")
    normalized: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("已忽略项格式不正确")
        for blocked in BLOCKER_ITEM_KEYS:
            if blocked in raw:
                raise ValueError("已忽略项不能包含未解决候选或阻断标记")
        normalized.append(
            {
                "sourceLineId": _require_text(raw.get("sourceLineId"), label="已忽略项来源行")[:64],
                "sourceText": _require_text(raw.get("sourceText"), label="已忽略项原文")[:255],
                "displayName": _require_text(raw.get("displayName"), label="已忽略项名称")[:120],
                "reasonCode": _require_text(raw.get("reasonCode"), label="已忽略原因码")[:64],
                "reason": _require_text(raw.get("reason"), label="已忽略原因")[:255],
            }
        )
    return normalized


def _reject_blocker_markers(payload: dict[str, Any], item: dict[str, Any]) -> None:
    if "unmatchedCandidates" in payload:
        raise ValueError("入库草稿不能包含未解决候选；请先通过 human.request_input 处理歧义项")
    for key in BLOCKER_ITEM_KEYS:
        if key in item:
            raise ValueError("入库草稿不能包含歧义或未解决行；请先完成候选确认")
    match_level = str(item.get("matchLevel") or "").strip()
    if match_level in {"ambiguous", "unresolved", "missing", "candidate"}:
        raise ValueError("入库草稿不能包含歧义或未解决行；请先完成候选确认")


def _shopping_before(shopping: ShoppingListItem) -> dict[str, Any]:
    return {
        "id": shopping.id,
        "title": shopping.title,
        "quantity": _decimal_text(Decimal(str(shopping.quantity))),
        "unit": shopping.unit,
        "done": bool(shopping.done),
        "ingredientId": shopping.ingredient_id,
        "foodId": shopping.food_id,
        "rowVersion": shopping.row_version,
    }


def _ingredient_before(ingredient: Ingredient) -> dict[str, Any]:
    mode = ingredient.default_expiry_mode
    mode_value = mode.value if hasattr(mode, "value") else str(mode or "")
    return {
        "id": ingredient.id,
        "name": ingredient.name,
        "defaultUnit": ingredient.default_unit,
        "defaultStorage": ingredient.default_storage,
        "defaultExpiryMode": mode_value or None,
        "defaultExpiryDays": ingredient.default_expiry_days,
        "rowVersion": ingredient.row_version,
        "quantityTrackingMode": (
            ingredient.quantity_tracking_mode.value
            if hasattr(ingredient.quantity_tracking_mode, "value")
            else str(ingredient.quantity_tracking_mode)
        ),
    }


def _food_before(food: Food) -> dict[str, Any]:
    food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
    return {
        "id": food.id,
        "name": food.name,
        "type": food_type,
        "stockQuantity": _decimal_text(Decimal(str(food.stock_quantity))) if food.stock_quantity is not None else None,
        "stockUnit": food.stock_unit,
        "storageLocation": food.storage_location,
        "rowVersion": food.row_version,
    }


def _state_before(state: IngredientInventoryState | None) -> dict[str, Any] | None:
    if state is None:
        return None
    availability = (
        state.availability_level.value
        if hasattr(state.availability_level, "value")
        else str(state.availability_level)
    )
    return {
        "id": state.id,
        "ingredientId": state.ingredient_id,
        "availabilityLevel": availability,
        "rowVersion": state.row_version,
    }


def _item_impact(*, action: str, source_kind: str, target_kind: str) -> dict[str, Any]:
    return {
        "sourceKind": source_kind,
        "action": action,
        "targetKind": target_kind,
        "stocksInventory": action in {"stock_and_fulfill", "stock_only"},
        "fulfillsShopping": action in {"stock_and_fulfill", "fulfill_without_stock"},
        "skips": action == "skip",
    }


def _parse_optional_date(value: Any, *, label: str) -> date | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError(f"{label}格式不正确") from exc


def _default_expiry_for_ingredient(
    ingredient: Ingredient,
    *,
    intake_date: date,
    explicit_expiry: date | None,
) -> date | None:
    if explicit_expiry is not None:
        return explicit_expiry
    mode = ingredient.default_expiry_mode
    mode_value = mode.value if hasattr(mode, "value") else str(mode)
    if mode is IngredientExpiryMode.DAYS or mode_value == IngredientExpiryMode.DAYS.value:
        days = ingredient.default_expiry_days
        if days:
            return intake_date + timedelta(days=int(days))
    return None


def _map_executable_service_item(item: dict[str, Any]) -> dict[str, Any]:
    """Map a normalized draft row to InventoryIntakeRequest item fields.

    Approval display may keep original target identity immutables when the user
    switches to fulfill_without_stock; the service call must still use target_kind=none
    and omit inventory target/quantity fields.
    """
    action = str(item.get("action") or "")
    if action == "fulfill_without_stock":
        mapped: dict[str, Any] = {
            "line_id": item["lineId"],
            "source_kind": item["sourceKind"],
            "action": action,
            "shopping_item_id": item.get("shoppingItemId"),
            "expected_shopping_item_row_version": item.get("expectedShoppingItemRowVersion"),
            "target_kind": "none",
            "notes": item.get("notes") or "",
        }
        return {key: value for key, value in mapped.items() if value is not None or key == "notes"}

    mapped = {
        "line_id": item["lineId"],
        "source_kind": item["sourceKind"],
        "action": action,
        "shopping_item_id": item.get("shoppingItemId"),
        "expected_shopping_item_row_version": item.get("expectedShoppingItemRowVersion"),
        "target_kind": item["targetKind"],
        "target_id": item.get("targetId"),
        "expected_ingredient_row_version": item.get("expectedIngredientRowVersion"),
        "expected_food_row_version": item.get("expectedFoodRowVersion"),
        "state_id": item.get("stateId"),
        "expected_state_row_version": item.get("expectedStateRowVersion"),
        "actual_quantity": item.get("actualQuantity"),
        "unit": item.get("actualUnit"),
        "resulting_availability_level": item.get("resultingAvailabilityLevel"),
        "inventory_status": item.get("inventoryStatus"),
        "expiry_date": item.get("expiryDate"),
        "storage_location": item.get("storageLocation"),
        "notes": item.get("notes") or "",
    }
    cleaned = {key: value for key, value in mapped.items() if value is not None}
    if "notes" not in cleaned:
        cleaned["notes"] = ""
    return cleaned


def _build_summary(items: list[dict[str, Any]], ignored_items: list[dict[str, Any]]) -> dict[str, Any]:
    skip_count = sum(1 for item in items if item.get("action") == "skip")
    executable_count = len(items) - skip_count
    shopping_count = sum(1 for item in items if item.get("sourceKind") == "shopping_item" and item.get("action") != "skip")
    direct_count = sum(1 for item in items if item.get("sourceKind") == "direct" and item.get("action") != "skip")
    return {
        "itemCount": len(items),
        "ignoredCount": len(ignored_items),
        "executableCount": executable_count,
        "skipCount": skip_count,
        "shoppingLinkedCount": shopping_count,
        "directCount": direct_count,
    }


def normalize_inventory_intake_draft(context: DraftNormalizeContext) -> dict[str, Any]:
    payload = context.payload
    if not isinstance(payload, dict):
        raise ValueError("入库草稿格式不正确")
    if str(payload.get("draftType") or "") != "inventory_intake":
        raise ValueError("入库草稿类型不正确")
    if str(payload.get("schemaVersion") or "") != "inventory_intake.v1":
        raise ValueError("入库草稿版本不正确")

    source_type = str(payload.get("sourceType") or "").strip()
    if source_type not in SOURCE_TYPES:
        raise ValueError("入库来源类型不正确")
    intake_date_source = str(payload.get("intakeDateSource") or "").strip()
    if intake_date_source not in INTAKE_DATE_SOURCES:
        raise ValueError("入库日期来源不正确")
    try:
        intake_date = date.fromisoformat(str(payload.get("intakeDate") or ""))
    except ValueError as exc:
        raise ValueError("入库日期格式不正确") from exc

    source_reference = payload.get("sourceReference")
    if source_reference is not None and not isinstance(source_reference, dict):
        raise ValueError("入库来源引用格式不正确")

    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError("入库草稿项目格式不正确")
    ignored_items = _normalize_ignored_items(payload.get("ignoredItems"))
    if not items and not ignored_items:
        raise ValueError("入库草稿至少需要一个项目或已忽略项")
    if len(items) + len(ignored_items) > 30:
        raise ValueError("入库草稿原始行不能超过 30 项")

    source_line_ids: list[str] = []
    line_ids: list[str] = []
    shopping_ids: list[str] = []
    for raw_item in items:
        if not isinstance(raw_item, dict):
            raise ValueError("入库草稿项目格式不正确")
        _reject_blocker_markers(payload, raw_item)
        line_id = _require_text(raw_item.get("lineId"), label="入库行标识")[:64]
        source_line_id = _require_text(raw_item.get("sourceLineId"), label="来源行标识")[:64]
        line_ids.append(line_id)
        source_line_ids.append(source_line_id)
        shopping_item_id = str(raw_item.get("shoppingItemId") or "").strip()
        if shopping_item_id:
            shopping_ids.append(shopping_item_id)

    for ignored in ignored_items:
        source_line_ids.append(ignored["sourceLineId"])

    if len(line_ids) != len(set(line_ids)):
        raise ValueError("入库草稿包含重复 lineId")
    if len(source_line_ids) != len(set(source_line_ids)):
        raise ValueError("入库草稿每个 sourceLineId 只能出现一次")
    if len(shopping_ids) != len(set(shopping_ids)):
        raise ValueError("入库草稿包含重复采购项")

    shopping_by_id: dict[str, ShoppingListItem] = {}
    if shopping_ids:
        shopping_rows = list(
            context.db.scalars(
                select(ShoppingListItem).where(
                    ShoppingListItem.family_id == context.family_id,
                    ShoppingListItem.id.in_(shopping_ids),
                )
            )
        )
        shopping_by_id = {item.id: item for item in shopping_rows}
        if len(shopping_by_id) != len(set(shopping_ids)):
            raise ValueError("采购项不存在或不属于当前家庭")

    require_complete = context.phase == "approval"
    is_approval = context.phase == "approval"
    normalized_items: list[dict[str, Any]] = []

    for raw_item in items:
        assert isinstance(raw_item, dict)
        line_id = _require_text(raw_item.get("lineId"), label="入库行标识")[:64]
        source_line_id = _require_text(raw_item.get("sourceLineId"), label="来源行标识")[:64]
        source_text = _require_text(raw_item.get("sourceText"), label="来源原文")[:255]
        source_kind = str(raw_item.get("sourceKind") or "").strip()
        action = str(raw_item.get("action") or "").strip()
        if source_kind not in VALID_ACTIONS_BY_SOURCE:
            raise ValueError("入库来源种类不正确")
        if action not in VALID_ACTIONS_BY_SOURCE[source_kind]:
            raise ValueError(f"不支持的 sourceKind/action 组合: {source_kind}/{action}")

        shopping_item_id = str(raw_item.get("shoppingItemId") or "").strip() or None
        shopping: ShoppingListItem | None = None
        if source_kind == "shopping_item":
            if not shopping_item_id:
                raise ValueError("采购关联行必须提供 shoppingItemId")
            shopping = shopping_by_id[shopping_item_id]
            if shopping.done:
                raise ValueError(f"采购项 {shopping.title} 已完成，不能重复入库")
        elif shopping_item_id:
            raise ValueError("直接入库行不能提供 shoppingItemId")

        target_kind = str(raw_item.get("targetKind") or "").strip()
        if action == "skip":
            # Display may keep a resolved target identity; approval restores immutables.
            target_kind = target_kind or "none"
        elif action == "fulfill_without_stock":
            # Service mapping forces target_kind=none; display immutables may preserve original target.
            target_kind = target_kind or "none"
        elif target_kind not in {"exact_ingredient", "presence_ingredient", "food"}:
            raise ValueError("入库目标类型不正确")

        record: dict[str, Any] = {
            "lineId": line_id,
            "sourceLineId": source_line_id,
            "sourceText": source_text,
            "sourceKind": source_kind,
            "action": action,
            "shoppingItemId": shopping.id if shopping is not None else None,
            "title": shopping.title if shopping is not None else str(raw_item.get("title") or "").strip() or None,
            "expectedShoppingItemRowVersion": shopping.row_version if shopping is not None else None,
            "targetKind": target_kind,
            "targetId": None,
            "expectedIngredientRowVersion": None,
            "expectedFoodRowVersion": None,
            "stateId": None,
            "expectedStateRowVersion": None,
            "plannedQuantity": (
                _decimal_text(Decimal(str(shopping.quantity))) if shopping is not None else None
            ),
            "plannedUnit": shopping.unit if shopping is not None else None,
            "enteredQuantity": _decimal_text(_decimal(raw_item.get("enteredQuantity"), label="实际入库数量")),
            "enteredUnit": str(raw_item.get("enteredUnit") or "").strip() or None,
            "packageConversion": None,
            "actualQuantity": None,
            "actualUnit": None,
            "inventoryStatus": None,
            "resultingAvailabilityLevel": None,
            "expiryDate": None,
            "storageLocation": None,
            "notes": str(raw_item.get("notes") or "").strip(),
            "before": {},
            "impact": _item_impact(action=action, source_kind=source_kind, target_kind=target_kind),
        }

        if shopping is not None:
            record["before"]["shoppingItem"] = _shopping_before(shopping)

        if action == "skip":
            if is_approval:
                for field in ITEM_IMMUTABLE_FIELDS:
                    if field in raw_item:
                        record[field] = raw_item.get(field)
                record["action"] = "skip"
                record["notes"] = str(raw_item.get("notes") or "").strip()
                record["impact"] = _item_impact(
                    action="skip",
                    source_kind=str(record["sourceKind"]),
                    target_kind=str(record.get("targetKind") or "none"),
                )
            normalized_items.append(record)
            continue

        if action == "fulfill_without_stock":
            # Keep original target identity for approval display when present; executor maps to none.
            if is_approval:
                for field in ITEM_IMMUTABLE_FIELDS:
                    if field in raw_item:
                        record[field] = raw_item.get(field)
                record["action"] = action
                record["notes"] = str(raw_item.get("notes") or "").strip()
                # Clear stock-only editable fields for a clean approval value.
                record["enteredQuantity"] = None
                record["enteredUnit"] = None
                record["packageConversion"] = None
                record["actualQuantity"] = None
                record["actualUnit"] = None
                record["inventoryStatus"] = None
                record["resultingAvailabilityLevel"] = None
                record["expiryDate"] = None
                record["storageLocation"] = None
            else:
                record["targetKind"] = "none"
                record["targetId"] = None
            record["impact"] = _item_impact(
                action=action,
                source_kind=str(record["sourceKind"]),
                target_kind=str(record.get("targetKind") or "none"),
            )
            normalized_items.append(record)
            continue

        target_id = _require_text(raw_item.get("targetId"), label="入库目标")
        actual_quantity, actual_unit, conversion = _canonical_actual(
            raw_item,
            require_complete=require_complete and target_kind == "exact_ingredient",
        )
        # food also needs quantity when complete; presence does not
        if target_kind == "food":
            actual_quantity, actual_unit, conversion = _canonical_actual(
                raw_item,
                require_complete=require_complete,
            )
        explicit_expiry = _parse_optional_date(raw_item.get("expiryDate"), label="保质期")
        record.update(
            {
                "targetId": target_id,
                "packageConversion": conversion,
                "actualQuantity": actual_quantity,
                "actualUnit": actual_unit,
                "inventoryStatus": str(raw_item.get("inventoryStatus") or InventoryStatus.FRESH.value),
                "expiryDate": explicit_expiry.isoformat() if explicit_expiry else None,
                "storageLocation": str(raw_item.get("storageLocation") or "").strip() or None,
            }
        )
        if require_complete and target_kind in {"exact_ingredient", "presence_ingredient"} and not record["storageLocation"]:
            raise ValueError("存放位置不能为空")
        if require_complete and target_kind == "food" and not record["storageLocation"]:
            # food may use existing storage; still require for approval clarity when missing
            pass

        ingredient: Ingredient | None = None
        if target_kind in {"exact_ingredient", "presence_ingredient"}:
            ingredient = _load_scoped(
                context.db,
                Ingredient,
                family_id=context.family_id,
                object_id=target_id,
                label="食材",
            )
            if shopping is not None and shopping.ingredient_id and shopping.ingredient_id != ingredient.id:
                raise ValueError("采购项与入库食材不一致")
            is_exact = ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
            if (target_kind == "exact_ingredient") != is_exact:
                raise ValueError("食材数量追踪方式与入库类型不一致")
            if not record.get("title"):
                record["title"] = ingredient.name
            record["expectedIngredientRowVersion"] = ingredient.row_version
            record["before"]["ingredient"] = _ingredient_before(ingredient)
            resolved_expiry = _default_expiry_for_ingredient(
                ingredient,
                intake_date=intake_date,
                explicit_expiry=explicit_expiry,
            )
            record["expiryDate"] = resolved_expiry.isoformat() if resolved_expiry else None
            if target_kind == "presence_ingredient":
                state = context.db.scalar(
                    select(IngredientInventoryState).where(
                        IngredientInventoryState.family_id == context.family_id,
                        IngredientInventoryState.ingredient_id == ingredient.id,
                    )
                )
                record["actualQuantity"] = None
                record["actualUnit"] = None
                record["enteredQuantity"] = None
                record["enteredUnit"] = None
                record["packageConversion"] = None
                record["stateId"] = state.id if state is not None else None
                record["expectedStateRowVersion"] = state.row_version if state is not None else None
                record["before"]["state"] = _state_before(state)
                availability = str(
                    raw_item.get("resultingAvailabilityLevel")
                    or InventoryAvailabilityLevel.SUFFICIENT.value
                )
                if availability not in {
                    InventoryAvailabilityLevel.PRESENT_UNKNOWN.value,
                    InventoryAvailabilityLevel.LOW.value,
                    InventoryAvailabilityLevel.SUFFICIENT.value,
                }:
                    raise ValueError("入库后的可用状态不正确")
                record["resultingAvailabilityLevel"] = availability
                if require_complete and not record["storageLocation"]:
                    raise ValueError(f"食材 {ingredient.name} 的存放位置不能为空")
            else:
                if require_complete and not record["storageLocation"]:
                    raise ValueError(f"食材 {ingredient.name} 的存放位置不能为空")
                if require_complete and record["inventoryStatus"] not in {
                    InventoryStatus.FRESH.value,
                    InventoryStatus.OPENED.value,
                    InventoryStatus.FROZEN.value,
                    InventoryStatus.EXPIRING.value,
                }:
                    raise ValueError("库存状态不正确")
        elif target_kind == "food":
            food = _load_scoped(
                context.db,
                Food,
                family_id=context.family_id,
                object_id=target_id,
                label="食物",
            )
            food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
            if food_type not in READY_LIKE_FOOD_TYPES or not is_ready_like_food(food):
                raise ValueError("只能对可入库的成品食物执行入库")
            if shopping is not None and shopping.food_id and shopping.food_id != food.id:
                raise ValueError("采购项与可入库的成品食物不一致")
            if not record.get("title"):
                record["title"] = food.name
            record["expectedFoodRowVersion"] = food.row_version
            record["before"]["food"] = _food_before(food)
            # food inventory_status is not used by service
            record["inventoryStatus"] = None
            if not record.get("storageLocation"):
                record["storageLocation"] = food.storage_location
        else:
            raise ValueError("入库目标类型不正确")

        if record.get("expiryDate"):
            expiry = date.fromisoformat(str(record["expiryDate"]))
            if expiry < intake_date:
                raise ValueError("保质期不能早于入库日期")

        record["impact"] = _item_impact(action=action, source_kind=source_kind, target_kind=target_kind)

        if is_approval:
            for field in ITEM_IMMUTABLE_FIELDS:
                if field in raw_item:
                    record[field] = raw_item.get(field)
            # re-apply editable values after restoring immutables
            record["action"] = action
            record["enteredQuantity"] = _decimal_text(
                _decimal(raw_item.get("enteredQuantity"), label="实际入库数量")
            )
            record["enteredUnit"] = str(raw_item.get("enteredUnit") or "").strip() or None
            if target_kind == "presence_ingredient":
                record["actualQuantity"] = None
                record["actualUnit"] = None
                record["enteredQuantity"] = None
                record["enteredUnit"] = None
                record["packageConversion"] = None
                record["resultingAvailabilityLevel"] = str(
                    raw_item.get("resultingAvailabilityLevel")
                    or record.get("resultingAvailabilityLevel")
                    or InventoryAvailabilityLevel.SUFFICIENT.value
                )
            else:
                actual_quantity, actual_unit, conversion = _canonical_actual(
                    raw_item,
                    require_complete=True,
                )
                record["packageConversion"] = conversion
                record["actualQuantity"] = actual_quantity
                record["actualUnit"] = actual_unit
            record["inventoryStatus"] = (
                None
                if target_kind == "food"
                else str(raw_item.get("inventoryStatus") or InventoryStatus.FRESH.value)
            )
            approval_explicit_expiry = _parse_optional_date(raw_item.get("expiryDate"), label="保质期")
            if target_kind in {"exact_ingredient", "presence_ingredient"}:
                # Prefer already-loaded ingredient; fall back to immutable target identity.
                approval_ingredient = ingredient
                if approval_ingredient is None:
                    approval_target_id = str(record.get("targetId") or target_id)
                    approval_ingredient = _load_scoped(
                        context.db,
                        Ingredient,
                        family_id=context.family_id,
                        object_id=approval_target_id,
                        label="食材",
                    )
                resolved_expiry = _default_expiry_for_ingredient(
                    approval_ingredient,
                    intake_date=intake_date,
                    explicit_expiry=approval_explicit_expiry,
                )
                record["expiryDate"] = resolved_expiry.isoformat() if resolved_expiry else None
            else:
                record["expiryDate"] = (
                    approval_explicit_expiry.isoformat() if approval_explicit_expiry else None
                )
            if record.get("expiryDate") and date.fromisoformat(str(record["expiryDate"])) < intake_date:
                raise ValueError("保质期不能早于入库日期")
            record["storageLocation"] = str(raw_item.get("storageLocation") or "").strip() or None
            if target_kind in {"exact_ingredient", "presence_ingredient"} and not record["storageLocation"]:
                raise ValueError("存放位置不能为空")
            record["notes"] = str(raw_item.get("notes") or "").strip()
            record["impact"] = _item_impact(
                action=action,
                source_kind=str(record["sourceKind"]),
                target_kind=str(record["targetKind"]),
            )

        normalized_items.append(record)

    client_request_id = str(payload.get("clientRequestId") or "").strip()
    if not is_approval or not client_request_id.startswith("ai-inventory-intake-"):
        client_request_id = create_id("ai-inventory-intake")

    if is_approval:
        # preserve top-level immutables from submitted payload (already validated)
        source_type = str(payload.get("sourceType") or source_type)
        intake_date_source = str(payload.get("intakeDateSource") or intake_date_source)
        source_reference = payload.get("sourceReference")
        ignored_items = payload.get("ignoredItems") if isinstance(payload.get("ignoredItems"), list) else ignored_items
        client_request_id = str(payload.get("clientRequestId") or client_request_id)

    return jsonable_encoder(
        {
            "draftType": "inventory_intake",
            "schemaVersion": "inventory_intake.v1",
            "clientRequestId": client_request_id,
            "sourceType": source_type,
            "sourceReference": source_reference,
            "intakeDate": intake_date.isoformat(),
            "intakeDateSource": intake_date_source,
            "items": normalized_items,
            "ignoredItems": ignored_items,
            "summary": _build_summary(normalized_items, ignored_items if isinstance(ignored_items, list) else []),
        }
    )


def validate_inventory_intake_approval_value(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("入库草稿格式不正确")

    for field in TOP_LEVEL_IMMUTABLE_FIELDS:
        if original.get(field) != submitted.get(field):
            if field == "ignoredItems":
                raise ValueError("确认阶段不能修改已忽略项，忽略项只读")
            raise ValueError("确认阶段不能修改来源身份或幂等标识")

    original_items = original.get("items")
    submitted_items = submitted.get("items")
    if not isinstance(original_items, list) or not isinstance(submitted_items, list):
        raise ValueError("入库草稿格式不正确")
    if len(submitted_items) != len(original_items):
        raise ValueError("确认阶段不能添加或删除入库行")

    original_by_line = {
        str(item.get("lineId") or ""): item for item in original_items if isinstance(item, dict)
    }
    if len(original_by_line) != len(original_items):
        raise ValueError("入库草稿行标识不正确")

    for item in submitted_items:
        if not isinstance(item, dict):
            raise ValueError("入库草稿项目格式不正确")
        line_id = str(item.get("lineId") or "")
        original_item = original_by_line.get(line_id)
        if original_item is None:
            raise ValueError("确认阶段不能添加或删除入库行")
        for field in ITEM_IMMUTABLE_FIELDS:
            if item.get(field) != original_item.get(field):
                raise ValueError("确认阶段不能修改来源身份、目标或版本边界")

        action = str(item.get("action") or "")
        source_kind = str(original_item.get("sourceKind") or "")
        if source_kind not in VALID_ACTIONS_BY_SOURCE or action not in VALID_ACTIONS_BY_SOURCE[source_kind]:
            raise ValueError("确认阶段的入库动作不正确")


def execute_inventory_intake_draft(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    payload = context.payload
    if not isinstance(payload, dict):
        raise ValueError("入库草稿格式不正确")

    executable_items: list[dict[str, Any]] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict):
            raise ValueError("入库草稿项目格式不正确")
        if str(item.get("action") or "") == "skip":
            continue
        executable_items.append(item)

    if not executable_items:
        raise ValueError("全部项目均为 skip，没有可执行的入库行；请拒绝或取消本次确认")

    request_items = [_map_executable_service_item(item) for item in executable_items]

    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": payload.get("clientRequestId"),
            "intake_date": payload.get("intakeDate"),
            "items": request_items,
        }
    )

    membership = context.db.scalar(
        select(Membership).where(
            Membership.family_id == context.family_id,
            Membership.user_id == context.user_id,
            Membership.status == MembershipStatus.ACTIVE,
        )
    )
    user_role = membership.role if membership is not None else UserRole.MEMBER
    result = apply_inventory_intake(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        user_role=user_role,
        request=request,
        business_date=date.fromisoformat(str(payload["intakeDate"])),
    )
    business_entity = result.model_dump(mode="json")
    entity_ids = [result.operation_id]
    for item in result.items:
        if item.shopping_item_id:
            entity_ids.append(item.shopping_item_id)
        if item.inventory_item_id:
            entity_ids.append(item.inventory_item_id)
        if item.food_id:
            entity_ids.append(item.food_id)
        if item.state_id:
            entity_ids.append(item.state_id)
    return business_entity, list(dict.fromkeys(entity_ids))
