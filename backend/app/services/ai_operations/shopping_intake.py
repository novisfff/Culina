from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select

from app.core.enums import (
    FoodType,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.core.utils import create_id
from app.models.domain import Food, Ingredient, IngredientInventoryState, Membership, ShoppingListItem
from app.schemas.inventory_operations import ShoppingIntakeRequest
from app.services.ai_operations.registry_types import DraftExecuteContext, DraftNormalizeContext
from app.services.inventory_overview import is_ready_like_food
from app.services.shopping_intake import apply_shopping_intake


READY_LIKE_FOOD_TYPES = {
    FoodType.READY_MADE.value,
    FoodType.INSTANT.value,
    FoodType.PACKAGED.value,
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


def _normalize_unmatched_candidates(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("额外购买候选格式不正确")
    normalized: list[dict[str, Any]] = []
    for candidate in value[:100]:
        if not isinstance(candidate, dict):
            raise ValueError("额外购买候选格式不正确")
        recommendation_type = str(candidate.get("recommendationType") or "choose_target")
        if recommendation_type not in {"inventory_intake", "ingredient_profile", "food_profile", "choose_target"}:
            raise ValueError("额外购买候选建议类型不正确")
        normalized.append(
            {
                "clientKey": str(candidate.get("clientKey") or "")[:64] or None,
                "label": _require_text(candidate.get("label"), label="额外购买候选名称")[:120],
                "enteredQuantity": _decimal_text(
                    _decimal(candidate.get("enteredQuantity"), label="额外购买候选数量")
                ),
                "enteredUnit": str(candidate.get("enteredUnit") or "").strip()[:32] or None,
                "recommendationType": recommendation_type,
                "recommendation": _require_text(candidate.get("recommendation"), label="额外购买候选建议")[:255],
                "candidateIds": [
                    str(item).strip()[:64]
                    for item in candidate.get("candidateIds") or []
                    if str(item).strip()
                ][:20],
            }
        )
    return normalized


def _load_scoped(db, model, *, family_id: str, object_id: str, label: str):
    target = db.scalar(select(model).where(model.family_id == family_id, model.id == object_id))
    if target is None:
        raise ValueError(f"{label}不存在或不属于当前家庭")
    return target


def _canonical_actual(item: dict[str, Any], *, require_complete: bool) -> tuple[str | None, str | None, dict[str, Any] | None]:
    entered_quantity = _decimal(
        item.get("enteredQuantity"),
        label="实际购买数量",
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
        raise ValueError("实际购买单位不能为空")
    return _decimal_text(actual_quantity), actual_unit, normalized_conversion


def normalize_shopping_intake_draft(context: DraftNormalizeContext) -> dict[str, Any]:
    payload = context.payload
    if not isinstance(payload, dict):
        raise ValueError("购物完成与入库草稿格式不正确")
    if str(payload.get("draftType") or "") != "shopping_intake":
        raise ValueError("购物完成与入库草稿类型不正确")
    if str(payload.get("schemaVersion") or "") != "shopping_intake.v1":
        raise ValueError("购物完成与入库草稿版本不正确")
    try:
        purchase_date = date.fromisoformat(str(payload.get("purchaseDate") or ""))
    except ValueError as exc:
        raise ValueError("采购日期格式不正确") from exc
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("购物完成与入库草稿至少需要一个待买项")
    if len(items) > 100:
        raise ValueError("购物完成与入库一次不能超过 100 项")
    shopping_ids = [str(item.get("shoppingItemId") or "") for item in items if isinstance(item, dict)]
    if len(shopping_ids) != len(items) or any(not item_id for item_id in shopping_ids):
        raise ValueError("购物完成与入库项目必须引用真实待买项")
    if len(shopping_ids) != len(set(shopping_ids)):
        raise ValueError("购物完成与入库草稿包含重复待买项")

    shopping_rows = list(
        context.db.scalars(
            select(ShoppingListItem).where(
                ShoppingListItem.family_id == context.family_id,
                ShoppingListItem.id.in_(shopping_ids),
            )
        )
    )
    shopping_by_id = {item.id: item for item in shopping_rows}
    if len(shopping_by_id) != len(shopping_ids):
        raise ValueError("购物项不存在或不属于当前家庭")

    normalized_items: list[dict[str, Any]] = []
    require_complete = context.phase == "approval"
    for raw_item in items:
        if not isinstance(raw_item, dict):
            raise ValueError("购物完成与入库项目格式不正确")
        shopping = shopping_by_id[str(raw_item["shoppingItemId"])]
        if shopping.done:
            raise ValueError(f"购物项 {shopping.title} 已完成，不能重复入库")
        action = str(raw_item.get("action") or "")
        target_kind = str(raw_item.get("targetKind") or "")
        match_level = str(raw_item.get("matchLevel") or "")
        if match_level not in {"confirmed", "suggested", "ambiguous"}:
            raise ValueError("购物项匹配等级不正确")
        if require_complete and match_level == "ambiguous":
            raise ValueError(f"购物项 {shopping.title} 仍有多个候选，请先选择真实目标")
        if action not in {"stock_and_fulfill", "complete_without_inventory"}:
            raise ValueError("购物完成与入库动作不正确")

        record: dict[str, Any] = {
            "shoppingItemId": shopping.id,
            "title": shopping.title,
            "expectedShoppingItemRowVersion": shopping.row_version,
            "matchLevel": match_level,
            "matchReason": _require_text(raw_item.get("matchReason"), label="匹配依据")[:255],
            "action": action,
            "targetKind": target_kind,
            "targetId": None,
            "expectedIngredientRowVersion": None,
            "expectedFoodRowVersion": None,
            "stateId": None,
            "expectedStateRowVersion": None,
            "plannedQuantity": _decimal_text(Decimal(str(shopping.quantity))),
            "plannedUnit": shopping.unit,
            "enteredQuantity": _decimal_text(
                _decimal(raw_item.get("enteredQuantity"), label="实际购买数量")
            ),
            "enteredUnit": str(raw_item.get("enteredUnit") or "").strip() or None,
            "packageConversion": None,
            "actualQuantity": None,
            "actualUnit": None,
            "inventoryStatus": None,
            "resultingAvailabilityLevel": None,
            "expiryDate": None,
            "storageLocation": None,
            "notes": str(raw_item.get("notes") or "").strip(),
        }
        if action == "complete_without_inventory":
            record["targetKind"] = "none"
            if context.phase == "approval":
                record["title"] = raw_item.get("title")
                record["expectedShoppingItemRowVersion"] = raw_item.get("expectedShoppingItemRowVersion")
                record["plannedQuantity"] = raw_item.get("plannedQuantity")
                record["plannedUnit"] = raw_item.get("plannedUnit")
            normalized_items.append(record)
            continue

        target_id = _require_text(raw_item.get("targetId"), label="入库目标")
        actual_quantity, actual_unit, conversion = _canonical_actual(
            raw_item,
            require_complete=require_complete,
        )
        record.update(
            {
                "targetId": target_id,
                "packageConversion": conversion,
                "actualQuantity": actual_quantity,
                "actualUnit": actual_unit,
                "inventoryStatus": str(raw_item.get("inventoryStatus") or InventoryStatus.FRESH.value),
                "expiryDate": (
                    date.fromisoformat(str(raw_item["expiryDate"])).isoformat()
                    if raw_item.get("expiryDate")
                    else None
                ),
                "storageLocation": str(raw_item.get("storageLocation") or "").strip() or None,
            }
        )
        if require_complete and not record["storageLocation"]:
            raise ValueError(f"购物项 {shopping.title} 的存放位置不能为空")

        if target_kind in {"exact_ingredient", "presence_ingredient"}:
            ingredient = _load_scoped(
                context.db,
                Ingredient,
                family_id=context.family_id,
                object_id=target_id,
                label="食材",
            )
            if shopping.ingredient_id != ingredient.id:
                raise ValueError("购物项与入库食材不一致")
            is_exact = ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY
            if (target_kind == "exact_ingredient") != is_exact:
                raise ValueError("食材数量追踪方式与入库类型不一致")
            record["expectedIngredientRowVersion"] = ingredient.row_version
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
                availability = str(
                    raw_item.get("resultingAvailabilityLevel")
                    or InventoryAvailabilityLevel.SUFFICIENT.value
                )
                if availability not in {
                    InventoryAvailabilityLevel.PRESENT_UNKNOWN.value,
                    InventoryAvailabilityLevel.LOW.value,
                    InventoryAvailabilityLevel.SUFFICIENT.value,
                }:
                    raise ValueError("采购后的可用状态不正确")
                record["resultingAvailabilityLevel"] = availability
        elif target_kind == "food":
            food = _load_scoped(
                context.db,
                Food,
                family_id=context.family_id,
                object_id=target_id,
                label="食物",
            )
            food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
            if shopping.food_id != food.id or food_type not in READY_LIKE_FOOD_TYPES or not is_ready_like_food(food):
                raise ValueError("购物项与可入库的成品食物不一致")
            record["expectedFoodRowVersion"] = food.row_version
        else:
            raise ValueError("入库目标类型不正确")
        if context.phase == "approval":
            for field in (
                "title",
                "expectedShoppingItemRowVersion",
                "targetKind",
                "targetId",
                "expectedIngredientRowVersion",
                "expectedFoodRowVersion",
                "stateId",
                "expectedStateRowVersion",
                "plannedQuantity",
                "plannedUnit",
            ):
                record[field] = raw_item.get(field)
        normalized_items.append(record)

    client_request_id = str(payload.get("clientRequestId") or "").strip()
    if context.phase != "approval" or not client_request_id.startswith("ai-shopping-intake-"):
        client_request_id = create_id("ai-shopping-intake")
    return jsonable_encoder(
        {
            "draftType": "shopping_intake",
            "schemaVersion": "shopping_intake.v1",
            "clientRequestId": client_request_id,
            "purchaseDate": purchase_date.isoformat(),
            "items": normalized_items,
            "unmatchedCandidates": _normalize_unmatched_candidates(payload.get("unmatchedCandidates")),
        }
    )


def validate_shopping_intake_approval_value(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("购物完成与入库草稿格式不正确")
    if original.get("clientRequestId") != submitted.get("clientRequestId"):
        raise ValueError("确认阶段不能修改采购幂等标识")
    original_items = original.get("items")
    submitted_items = submitted.get("items")
    if not isinstance(original_items, list) or not isinstance(submitted_items, list):
        raise ValueError("购物完成与入库草稿格式不正确")
    original_by_id = {str(item.get("shoppingItemId") or ""): item for item in original_items if isinstance(item, dict)}
    if len(original_by_id) != len(original_items) or len(submitted_items) != len(original_items):
        raise ValueError("确认阶段不能添加或删除采购项")
    protected_fields = (
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
    )
    for item in submitted_items:
        if not isinstance(item, dict):
            raise ValueError("购物完成与入库项目格式不正确")
        original_item = original_by_id.get(str(item.get("shoppingItemId") or ""))
        if original_item is None or any(item.get(field) != original_item.get(field) for field in protected_fields):
            raise ValueError("确认阶段不能修改采购目标或版本边界")
    if submitted.get("unmatchedCandidates") != original.get("unmatchedCandidates"):
        raise ValueError("额外购买候选只读，不能随本次采购提交")


def execute_shopping_intake_draft(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    items: list[dict[str, Any]] = []
    for item in context.payload.get("items") or []:
        common = {
            "shopping_item_id": item["shoppingItemId"],
            "expected_shopping_item_row_version": item["expectedShoppingItemRowVersion"],
            "action": item["action"],
            "target_kind": item["targetKind"],
            "target_id": item.get("targetId"),
        }
        if item["action"] == "complete_without_inventory":
            items.append(common)
            continue
        common.update(
            {
                "inventory_status": item.get("inventoryStatus") or InventoryStatus.FRESH.value,
                "expiry_date": item.get("expiryDate"),
                "storage_location": item.get("storageLocation") or "",
                "notes": item.get("notes") or "",
            }
        )
        if item["targetKind"] == "exact_ingredient":
            common.update(
                {
                    "expected_ingredient_row_version": item["expectedIngredientRowVersion"],
                    "actual_quantity": item.get("actualQuantity"),
                    "unit": item.get("actualUnit"),
                }
            )
        elif item["targetKind"] == "presence_ingredient":
            common.update(
                {
                    "expected_ingredient_row_version": item["expectedIngredientRowVersion"],
                    "state_id": item.get("stateId"),
                    "expected_state_row_version": item.get("expectedStateRowVersion"),
                    "resulting_availability_level": item.get("resultingAvailabilityLevel"),
                }
            )
        elif item["targetKind"] == "food":
            common.pop("notes", None)
            common.update(
                {
                    "expected_food_row_version": item["expectedFoodRowVersion"],
                    "actual_quantity": item.get("actualQuantity"),
                    "unit": item.get("actualUnit"),
                }
            )
        items.append(common)

    request = ShoppingIntakeRequest.model_validate(
        {
            "client_request_id": context.payload.get("clientRequestId"),
            "purchase_date": context.payload.get("purchaseDate"),
            "items": items,
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
    result = apply_shopping_intake(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        user_role=user_role,
        request=request,
        business_date=date.fromisoformat(context.payload["purchaseDate"]),
    )
    business_entity = result.model_dump(mode="json")
    business_entity["unmatchedCandidates"] = context.payload.get("unmatchedCandidates") or []
    entity_ids = [result.operation_id, *(item.shopping_item_id for item in result.items)]
    return business_entity, list(dict.fromkeys(entity_ids))
