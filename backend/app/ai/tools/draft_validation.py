from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import FoodType, IngredientExpiryMode, IngredientQuantityTrackingMode, InventoryStatus, MealType
from app.core.utils import create_id
from app.models.domain import AITaskDraft, Food, FoodPlanItem, Ingredient, InventoryItem, MealLog, MealLogFood, Recipe, RecipeFavorite, ShoppingListItem
from app.schemas.foods import CreateFoodRequest
from app.schemas.ingredients import CreateIngredientRequest, UpdateIngredientRequest
from app.schemas.meal_logs import CreateMealLogRequest, UpdateMealLogRequest
from app.schemas.recipes import CookRecipeRequest, CreateRecipeRequest, UpdateRecipeRequest
from app.schemas.shopping import CreateShoppingListItemRequest
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.clock import today_for_family
from app.services.food_stock_quantity import normalize_food_stock_quantity, validate_food_stock_quantity_precision
from app.services.ingredient_units import (
    UnitConversionError,
    convert_quantity_from_default_unit,
    convert_quantity_to_default_unit,
    normalize_unit_label,
)
from app.services.ingredient_inventory_state import PresenceStateRequiredError
from app.services.inventory_usage import build_cook_inventory_plan, expiry_sort_key, inventory_remaining_in_default, serialize_cook_preview_item, tracks_quantity

from app.services.recipe_ingredient_refs import normalize_recipe_ingredient_items
from app.services.serializers import serialize_food, serialize_food_plan_item, serialize_ingredient, serialize_meal_log, serialize_media, serialize_recipe, serialize_shopping_item


READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _bound_media_ids(db: Session, *, family_id: str, entity_type: str, entity_id: str) -> list[str]:
    return [
        asset.id
        for asset in get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type=entity_type,
            entity_ids=[entity_id],
        )
    ]


def normalize_shopping_list_draft(db: Session, *, family_id: str, conversation_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("购物清单草稿格式不正确")
    if isinstance(payload.get("operations"), list):
        return _normalize_shopping_list_operation_draft(db, family_id=family_id, payload=payload)
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("购物清单草稿不能为空")
    source_draft_id = payload.get("sourceDraftId")
    if source_draft_id:
        source_draft_id = str(source_draft_id)
        if not source_draft_id.startswith(("in_run:", "entity:", "human_in_loop:")):
            existing = db.scalar(
                select(AITaskDraft.id).where(
                    AITaskDraft.family_id == family_id,
                    AITaskDraft.conversation_id == conversation_id,
                    AITaskDraft.id == source_draft_id,
                    AITaskDraft.draft_type.in_(["meal_plan", "shopping_list"]),
                )
            )
            if existing is None:
                raise ValueError("购物清单草稿引用了不存在的来源草稿")
    return {
        "draftType": "shopping_list",
        "schemaVersion": payload.get("schemaVersion") or "shopping_list.v1",
        "items": [
            _normalize_shopping_item_payload(db, family_id=family_id, payload=item).model_dump(mode="json")
            for item in items
        ],
        "sourceDraftId": source_draft_id or None,
    }


def _normalize_shopping_item_payload(
    db: Session,
    *,
    family_id: str,
    payload: Any,
) -> CreateShoppingListItemRequest:
    if not isinstance(payload, dict):
        raise ValueError("购物清单项目格式不正确")
    normalized = dict(payload)
    ingredient_id = normalized.get("ingredient_id") or normalized.get("ingredientId")
    food_id = normalized.get("food_id") or normalized.get("foodId")
    has_ingredient = isinstance(ingredient_id, str) and bool(ingredient_id.strip())
    has_food = isinstance(food_id, str) and bool(food_id.strip())
    if has_ingredient == has_food:
        raise ValueError("购物清单项目必须引用真实食材或成品采购对象")
    if has_ingredient:
        ingredient = db.scalar(select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id == ingredient_id.strip()))
        if ingredient is None:
            raise ValueError("购物清单项目引用了不存在的食材")
        normalized["ingredient_id"] = ingredient.id
        normalized["food_id"] = None
        normalized["title"] = ingredient.name
        normalized["quantity_mode"] = ingredient.quantity_tracking_mode.value if hasattr(ingredient.quantity_tracking_mode, "value") else ingredient.quantity_tracking_mode
    else:
        food = db.scalar(select(Food).where(Food.family_id == family_id, Food.id == food_id.strip()))
        if food is None:
            raise ValueError("购物清单项目引用了不存在的食物")
        if food.type not in READY_LIKE_FOOD_TYPES:
            raise ValueError("只有成品、速食或包装食品可以加入采购清单")
        normalized["food_id"] = food.id
        normalized["ingredient_id"] = None
        normalized["title"] = food.name
        normalized["quantity_mode"] = IngredientQuantityTrackingMode.TRACK_QUANTITY.value
        normalized["unit"] = normalized.get("unit") or food.stock_unit or "份"
        normalized["display_label"] = None
    if normalized["quantity_mode"] == IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value:
        normalized.setdefault("quantity", 1)
        normalized.setdefault("unit", ingredient.default_unit or "份")
        normalized["display_label"] = normalized.get("display_label") or normalized.get("displayLabel") or "需要补充"
    else:
        normalized["display_label"] = normalized.get("display_label") or normalized.get("displayLabel")
    return CreateShoppingListItemRequest.model_validate(normalized)


def _normalize_shopping_list_operation_draft(db: Session, *, family_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("购物清单操作草稿不能为空")
    if len(operations) > 100:
        raise ValueError("购物清单操作一次不能超过 100 项")
    completed_count = sum(
        1
        for operation in operations
        if isinstance(operation, dict)
        and str(operation.get("action") or "") == "set_done"
        and isinstance(operation.get("payload"), dict)
        and operation["payload"].get("done") is True
    )
    if completed_count > 1:
        raise ValueError("一次只能完成一个需要入库的购物项，请按顺序逐项确认")
    target_ids = _string_ids(
        operation.get("targetId") or operation.get("target_id")
        for operation in operations
        if isinstance(operation, dict) and str(operation.get("action") or "") in {"update", "set_done", "delete"}
    )
    shopping_by_id = _load_by_id(db, ShoppingListItem, family_id=family_id, ids=target_ids, label="购物项")
    normalized_operations: list[dict[str, Any]] = []
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("购物清单操作项格式不正确")
        action = str(operation.get("action") or "")
        if action not in {"create", "update", "set_done", "delete"}:
            raise ValueError("购物清单操作类型不正确")
        if action == "create":
            normalized_operations.append(
                {
                    "operationId": _normalize_operation_id(operation.get("operationId") or operation.get("operation_id")),
                    "action": "create",
                    "payload": _normalize_shopping_item_payload(
                        db,
                        family_id=family_id,
                        payload=operation.get("payload") or {},
                    ).model_dump(mode="json"),
                }
            )
            continue
        target_id = str(operation.get("targetId") or operation.get("target_id") or "")
        target = shopping_by_id.get(target_id)
        if target is None:
            raise ValueError("购物清单操作必须引用真实购物项")
        normalized_record: dict[str, Any] = {
            "operationId": _normalize_operation_id(operation.get("operationId") or operation.get("operation_id")),
            "action": action,
            "targetId": target.id,
            "baseUpdatedAt": _normalize_base_updated_at(operation.get("baseUpdatedAt") or operation.get("base_updated_at")),
            "before": _serialize_shopping_before(target),
            "payload": {"reason": str((operation.get("payload") or {}).get("reason") or "")},
        }
        if action == "update":
            normalized_record["payload"] = _normalize_shopping_item_payload(
                db,
                family_id=family_id,
                payload=operation.get("payload") or {},
            ).model_dump(mode="json")
        elif action == "set_done":
            normalized_record["payload"] = {
                "done": bool((operation.get("payload") or {}).get("done")),
                "reason": str((operation.get("payload") or {}).get("reason") or ""),
            }
        normalized_operations.append(normalized_record)
    return {
        "draftType": "shopping_list",
        "schemaVersion": "shopping_list_operation.v1",
        "operations": normalized_operations,
        "sourceDraftId": payload.get("sourceDraftId") or None,
    }


def normalize_meal_plan_draft(db: Session, *, family_id: str, user_id: str | None = None, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食计划草稿格式不正确")
    if isinstance(payload.get("operations"), list):
        return _normalize_meal_plan_operation_draft(db, family_id=family_id, user_id=user_id, payload=payload)
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("餐食计划草稿不能为空")

    food_ids = _string_ids(item.get("foodId") or item.get("food_id") for item in items if isinstance(item, dict))
    if len(food_ids) != len(items):
        raise ValueError("餐食计划里的每个食物都必须从食物库选择，不能生成库外食物名称")
    foods_by_id = _load_by_id(db, Food, family_id=family_id, ids=food_ids, label="食物")

    recipe_ids = _string_ids(item.get("recipeId") or item.get("recipe_id") for item in items if isinstance(item, dict))
    recipes_by_id = _load_by_id(db, Recipe, family_id=family_id, ids=recipe_ids, label="菜谱")

    normalized_items: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("餐食计划草稿项格式不正确")
        plan_date = date.fromisoformat(str(item.get("date")))
        meal_type = MealType(str(item.get("mealType")))
        food_id = str(item.get("foodId") or item.get("food_id") or "")
        food = foods_by_id[food_id]
        recipe_id = item.get("recipeId") or item.get("recipe_id")
        recipe_id = str(recipe_id) if recipe_id else food.recipe_id
        if recipe_id and recipe_id not in recipes_by_id:
            _load_by_id(db, Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")
        if recipe_id and food.recipe_id != recipe_id:
            raise ValueError("餐食计划草稿中的食物和菜谱关联不一致")
        missing_ingredient_items = _normalize_meal_plan_ingredient_items(
            db,
            family_id=family_id,
            value=item.get("missingIngredientItems") or item.get("missing_ingredient_items") or item.get("missingIngredients"),
        )
        normalized_items.append(
            {
                "date": plan_date.isoformat(),
                "mealType": meal_type.value,
                "title": food.name,
                "foodId": food.id,
                "recipeId": recipe_id or None,
                "reason": str(item.get("reason") or item.get("note") or ""),
                "usedInventory": _string_list(item.get("usedInventory"), max_items=20),
                "missingIngredients": [entry["name"] for entry in missing_ingredient_items],
                "missingIngredientItems": missing_ingredient_items,
                "source": item.get("source") if isinstance(item.get("source"), dict) else {},
            }
        )

    return {
        "draftType": "meal_plan",
        "schemaVersion": payload.get("schemaVersion") or "meal_plan.v1",
        "items": normalized_items,
        "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
    }


def _normalize_meal_plan_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str | None,
    payload: dict[str, Any],
) -> dict[str, Any]:
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("餐食计划操作草稿不能为空")
    if len(operations) > 28:
        raise ValueError("餐食计划操作一次不能超过 28 项")
    target_ids = _string_ids(
        operation.get("targetId") or operation.get("target_id")
        for operation in operations
        if isinstance(operation, dict) and str(operation.get("action") or "") in {"update", "set_status", "delete"}
    )
    plan_items_by_id = _load_meal_plan_targets(db, family_id=family_id, user_id=user_id, ids=target_ids)
    normalized_operations: list[dict[str, Any]] = []
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("餐食计划操作项格式不正确")
        action = str(operation.get("action") or "")
        if action not in {"create", "update", "set_status", "delete"}:
            raise ValueError("餐食计划操作类型不正确")
        if action == "create":
            normalized_operations.append(
                {
                    "operationId": _normalize_operation_id(operation.get("operationId") or operation.get("operation_id")),
                    "action": "create",
                    "payload": _normalize_meal_plan_operation_payload(db, family_id=family_id, payload=operation.get("payload") or {}),
                }
            )
            continue
        target_id = str(operation.get("targetId") or operation.get("target_id") or "")
        target = plan_items_by_id.get(target_id)
        if target is None:
            raise ValueError("餐食计划操作必须引用当前用户真实计划项")
        normalized_record: dict[str, Any] = {
            "operationId": _normalize_operation_id(operation.get("operationId") or operation.get("operation_id")),
            "action": action,
            "targetId": target.id,
            "baseUpdatedAt": _normalize_base_updated_at(operation.get("baseUpdatedAt") or operation.get("base_updated_at")),
            "before": _serialize_meal_plan_before(target),
            "payload": {"reason": str((operation.get("payload") or {}).get("reason") or "")},
        }
        if action == "update":
            normalized_record["payload"] = _normalize_meal_plan_operation_payload(
                db,
                family_id=family_id,
                payload=operation.get("payload") or {},
            )
        elif action == "set_status":
            status = str((operation.get("payload") or {}).get("status") or "")
            if status not in {"planned", "cooked", "skipped"}:
                raise ValueError("餐食计划状态操作类型不正确")
            normalized_record["payload"] = {
                "status": status,
                "reason": str((operation.get("payload") or {}).get("reason") or ""),
            }
        normalized_operations.append(normalized_record)
    return {
        "draftType": "meal_plan",
        "schemaVersion": "meal_plan_operation.v1",
        "operations": normalized_operations,
        "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
    }


def _normalize_meal_plan_operation_payload(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    normalized = normalize_meal_plan_draft(
        db,
        family_id=family_id,
        payload={
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan.v1",
            "items": [payload],
        },
    )
    return normalized["items"][0]


def _normalize_meal_plan_ingredient_items(
    db: Session,
    *,
    family_id: str,
    value: Any,
) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("餐食计划缺失食材格式不正确")
    if len(value) > 20:
        raise ValueError("餐食计划缺失食材不能超过 20 项")

    requested_ids = _string_ids(
        entry.get("ingredientId") or entry.get("ingredient_id")
        for entry in value
        if isinstance(entry, dict)
    )
    ingredients_by_id = _load_by_id(db, Ingredient, family_id=family_id, ids=requested_ids, label="食材")
    names = []
    for entry in value:
        if isinstance(entry, str):
            names.append(entry.strip())
        elif isinstance(entry, dict):
            names.append(str(entry.get("name") or entry.get("ingredient_name") or "").strip())
        else:
            raise ValueError("餐食计划缺失食材项格式不正确")
    matched_by_name = {
        ingredient.name: ingredient
        for ingredient in db.scalars(
            select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.name.in_([name for name in names if name]))
        )
    }

    normalized: list[dict[str, Any]] = []
    for entry, fallback_name in zip(value, names, strict=True):
        record = entry if isinstance(entry, dict) else {}
        ingredient_id = str(record.get("ingredientId") or record.get("ingredient_id") or "")
        ingredient = ingredients_by_id.get(ingredient_id) if ingredient_id else matched_by_name.get(fallback_name)
        name = ingredient.name if ingredient is not None else fallback_name
        if not name:
            raise ValueError("餐食计划缺失食材名称不能为空")
        try:
            quantity = float(record.get("quantity") or 1)
        except (TypeError, ValueError) as exc:
            raise ValueError("餐食计划缺失食材数量格式不正确") from exc
        if quantity <= 0:
            raise ValueError("餐食计划缺失食材数量必须大于 0")
        unit = str(record.get("unit") or (ingredient.default_unit if ingredient is not None else "份")).strip()
        if not unit:
            raise ValueError("餐食计划缺失食材单位不能为空")
        normalized.append(
            {
                "ingredientId": ingredient.id if ingredient is not None else None,
                "name": name,
                "quantity": int(quantity) if quantity.is_integer() else quantity,
                "unit": unit,
            }
        )
    return normalized


def _normalize_operation_id(value: Any) -> str:
    text = str(value or "").strip()
    return text[:64] if text else create_id("ai_op_item")


def normalize_meal_log_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str | None = None,
    payload: Any,
    phase: str = "proposal",
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食记录草稿格式不正确")
    if payload.get("action"):
        return _normalize_meal_log_operation_draft(db, family_id=family_id, user_id=user_id, payload=payload)
    foods = payload.get("foods")
    if not isinstance(foods, list) or not foods:
        raise ValueError("餐食记录草稿不能为空")

    food_ids = _string_ids(item.get("foodId") or item.get("food_id") for item in foods if isinstance(item, dict))
    if len(food_ids) != len(foods):
        raise ValueError("餐食记录里的每个食物都必须从食物库选择，不能生成库外食物名称")
    foods_by_id = _load_by_id(db, Food, family_id=family_id, ids=food_ids, label="食物")

    normalized_foods: list[dict[str, Any]] = []
    for item in foods:
        if not isinstance(item, dict):
            raise ValueError("餐食记录食物项格式不正确")
        food_id = str(item.get("foodId") or item.get("food_id") or "")
        food = foods_by_id[food_id]
        food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
        current_quantity = normalize_food_stock_quantity(Decimal(str(food.stock_quantity or 0)))
        normalized_food = {
            "foodId": food.id,
            "name": food.name,
            "foodType": food_type,
            "servings": max(float(item.get("servings") or 1), 0.1),
            "note": str(item.get("note") or ""),
            "rating": item.get("rating"),
            "deductStock": False,
        }
        if food_type in READY_LIKE_FOOD_TYPES:
            normalized_food["stockCurrentQuantity"] = _decimal_text(current_quantity)
            if food.stock_unit:
                normalized_food["stockUnit"] = food.stock_unit
        if item.get("deductStock") is True:
            if food_type not in READY_LIKE_FOOD_TYPES:
                raise ValueError("只有成品、速食或包装食品支持随餐食记录扣减库存")
            stock_unit = str(item.get("stockUnit") or "").strip()
            if not food.stock_unit:
                raise ValueError(f"{food.name}尚未设置库存单位")
            if stock_unit != food.stock_unit:
                raise ValueError(f"{food.name}当前库存单位是 {food.stock_unit}，不能按 {stock_unit or '空单位'} 扣减")
            try:
                stock_quantity = Decimal(str(item.get("stockQuantity") or ""))
            except Exception as exc:
                raise ValueError(f"{food.name}扣减数量格式不正确") from exc
            if stock_quantity <= 0:
                raise ValueError(f"{food.name}扣减数量必须大于 0")
            validate_food_stock_quantity_precision(stock_quantity, field_label=f"{food.name}扣减数量")
            stock_quantity = normalize_food_stock_quantity(stock_quantity)
            if phase == "proposal" and stock_quantity > current_quantity:
                raise ValueError(f"{food.name}当前库存不足，最多可扣减 {_decimal_text(current_quantity)}{food.stock_unit}")
            normalized_food.update(
                {
                    "deductStock": True,
                    "stockQuantity": _decimal_text(stock_quantity),
                    "stockUnit": food.stock_unit,
                    "stockCurrentQuantity": _decimal_text(current_quantity),
                    "stockAfterQuantity": _decimal_text(current_quantity - stock_quantity),
                }
            )
        normalized_foods.append(normalized_food)

    plan_item_id = str(payload.get("planItemId") or payload.get("plan_item_id") or "") or None
    plan_item = None
    if plan_item_id:
        plan_item = _load_meal_plan_targets(db, family_id=family_id, user_id=user_id, ids=[plan_item_id])[plan_item_id]
    return jsonable_encoder({
        "draftType": "meal_log",
        "schemaVersion": payload.get("schemaVersion") or "meal_log.v1",
        "date": date.fromisoformat(str(payload.get("date"))).isoformat(),
        "mealType": MealType(str(payload.get("mealType"))).value,
        "participantUserIds": [str(item) for item in payload.get("participantUserIds") or payload.get("participant_user_ids") or [] if str(item).strip()],
        "foods": normalized_foods,
        "notes": str(payload.get("notes") or ""),
        "mood": str(payload.get("mood") or ""),
        "mediaIds": [str(item) for item in payload.get("mediaIds") or payload.get("media_ids") or [] if str(item).strip()],
        "planItemId": plan_item.id if plan_item is not None else None,
        "planItemBaseUpdatedAt": (
            _normalize_base_updated_at(payload.get("planItemBaseUpdatedAt") or payload.get("plan_item_base_updated_at") or plan_item.updated_at.isoformat())
            if plan_item is not None
            else None
        ),
    })


def _normalize_meal_log_operation_draft(db: Session, *, family_id: str, user_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "")
    if action not in {"create", "update_details", "rate_food"}:
        raise ValueError("餐食记录操作类型不正确")
    if action == "create":
        normalized = normalize_meal_log_draft(db, family_id=family_id, user_id=user_id, payload=payload.get("payload") or {})
        return {
            "draftType": "meal_log",
            "schemaVersion": "meal_log_operation.v1",
            "action": "create",
            "payload": normalized,
        }
    target_id = str(payload.get("targetId") or payload.get("target_id") or "")
    if not target_id:
        raise ValueError("餐食记录操作必须引用真实记录")
    meal_log = _load_meal_log_target(db, family_id=family_id, meal_log_id=target_id)
    base_updated_at = _normalize_base_updated_at(payload.get("baseUpdatedAt") or payload.get("base_updated_at"))
    before = _serialize_meal_log_before(meal_log)
    if action == "update_details":
        incoming_payload = payload.get("payload") or {}
        normalized = UpdateMealLogRequest.model_validate(
            {
                "participant_user_ids": payload.get("payload", {}).get("participantUserIds") or payload.get("payload", {}).get("participant_user_ids"),
                "notes": (payload.get("payload") or {}).get("notes"),
                "mood": (payload.get("payload") or {}).get("mood"),
                "media_ids": (payload.get("payload") or {}).get("mediaIds") or (payload.get("payload") or {}).get("media_ids"),
            }
        ).model_dump(mode="json", exclude_none=True)
        if "mediaIds" not in incoming_payload and "media_ids" not in incoming_payload:
            normalized["media_ids"] = _bound_media_ids(
                db,
                family_id=family_id,
                entity_type="meal_log",
                entity_id=meal_log.id,
            )
        return {
            "draftType": "meal_log",
            "schemaVersion": "meal_log_operation.v1",
            "action": "update_details",
            "targetId": meal_log.id,
            "baseUpdatedAt": base_updated_at,
            "before": before,
            "payload": {
                "participantUserIds": list(normalized.get("participant_user_ids") or []),
                "notes": normalized.get("notes") or "",
                "mood": normalized.get("mood") or "",
                "mediaIds": list(normalized.get("media_ids") or []),
            },
        }
    ratings = (payload.get("payload") or {}).get("foodEntryRatings") or (payload.get("payload") or {}).get("food_entry_ratings") or []
    if not isinstance(ratings, list) or not ratings:
        raise ValueError("更新评分时至少需要一个食物项")
    entry_ids = {entry.id for entry in meal_log.food_entries}
    normalized_ratings = []
    for item in ratings:
        record = UpdateMealLogRequest.model_validate({"food_entry_ratings": [item]}).model_dump(mode="json", exclude_none=True)["food_entry_ratings"][0]
        if record["id"] not in entry_ids:
            raise ValueError("评分草稿引用了不属于该餐食记录的食物项")
        normalized_ratings.append({"id": record["id"], "rating": record.get("rating")})
    return {
        "draftType": "meal_log",
        "schemaVersion": "meal_log_operation.v1",
        "action": "rate_food",
        "targetId": meal_log.id,
        "baseUpdatedAt": base_updated_at,
        "before": before,
        "payload": {"foodEntryRatings": normalized_ratings},
    }


def normalize_recipe_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and payload.get("action"):
        return _normalize_recipe_operation_draft(db, family_id=family_id, payload=payload)
    recipe = _strip_transport_fields(CreateRecipeRequest.model_validate(payload).model_dump(mode="json"))
    return {
        **recipe,
        "ingredient_items": normalize_recipe_ingredient_items(
            db,
            family_id=family_id,
            items=recipe["ingredient_items"],
        ),
    }


def normalize_recipe_cook_draft(db: Session, *, family_id: str, user_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("做菜草稿格式不正确")
    recipe_id = str(payload.get("recipeId") or payload.get("recipe_id") or "")
    if not recipe_id:
        raise ValueError("做菜草稿必须引用真实菜谱")
    recipe = _load_recipe_target(db, family_id=family_id, recipe_id=recipe_id)
    request = CookRecipeRequest.model_validate(
        {
            "servings": payload.get("servings"),
            "date": payload.get("date"),
            "meal_type": payload.get("mealType") or payload.get("meal_type"),
            "participant_user_ids": payload.get("participantUserIds") or payload.get("participant_user_ids") or [],
            "notes": payload.get("notes") or "",
            "create_meal_log": payload.get("createMealLog")
            if payload.get("createMealLog") is not None
            else payload.get("create_meal_log") or False,
            "food_plan_item_id": payload.get("planItemId") or payload.get("food_plan_item_id"),
            "recipe_plan_item_id": payload.get("planItemId") or payload.get("recipe_plan_item_id"),
            "result_note": payload.get("resultNote") or payload.get("result_note") or "",
            "adjustments": payload.get("adjustments") or "",
            "rating": payload.get("rating"),
        }
    )
    plan_item = _load_recipe_cook_plan_item(
        db,
        family_id=family_id,
        user_id=user_id,
        recipe_id=recipe.id,
        plan_item_id=request.food_plan_item_id or request.recipe_plan_item_id,
    )
    preview_items, shortages = _build_recipe_cook_preview(db, family_id=family_id, recipe=recipe, servings=request.servings)
    participant_user_ids = list(request.participant_user_ids or ([user_id] if request.create_meal_log else []))
    return jsonable_encoder({
        "draftType": "recipe_cook",
        "schemaVersion": payload.get("schemaVersion") or "recipe_cook_operation.v1",
        "recipeId": recipe.id,
        "title": recipe.title,
        "baseUpdatedAt": _normalize_base_updated_at(payload.get("baseUpdatedAt") or recipe.updated_at.isoformat()),
        "before": {
            "recipeId": recipe.id,
            "title": recipe.title,
            "defaultServings": recipe.servings,
            "updatedAt": _normalize_base_updated_at(recipe.updated_at.isoformat()),
            "linkedPlanItem": _serialize_meal_plan_before(plan_item) if plan_item is not None else None,
        },
        "servings": request.servings,
        "date": (request.date or today_for_family(family_id)).isoformat(),
        "mealType": (request.meal_type or MealType.DINNER).value,
        "participantUserIds": participant_user_ids,
        "notes": request.notes,
        "createMealLog": request.create_meal_log,
        "planItemId": plan_item.id if plan_item is not None else None,
        "planItemBaseUpdatedAt": _normalize_base_updated_at(plan_item.updated_at.isoformat()) if plan_item is not None else None,
        "resultNote": request.result_note,
        "adjustments": request.adjustments,
        "rating": request.rating,
        "previewItems": preview_items,
        "shortages": shortages,
    })


def _normalize_recipe_operation_draft(db: Session, *, family_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "")
    if action not in {"create", "update", "delete", "set_favorite"}:
        raise ValueError("菜谱操作类型不正确")
    if action == "create":
        normalized = normalize_recipe_draft_for_tools(db, family_id=family_id, payload=payload.get("payload") or {})
        return {
            "draftType": "recipe",
            "schemaVersion": "recipe_operation.v1",
            "action": "create",
            "payload": normalized,
        }

    target_id = str(payload.get("targetId") or payload.get("target_id") or "")
    if not target_id:
        raise ValueError("菜谱操作必须引用真实菜谱")
    recipe = _load_recipe_target(db, family_id=family_id, recipe_id=target_id)
    base_updated_at = _normalize_base_updated_at(payload.get("baseUpdatedAt") or payload.get("base_updated_at"))
    before = _serialize_recipe_before(db, family_id=family_id, recipe=recipe)
    if action == "set_favorite":
        favorite = bool((payload.get("payload") or {}).get("favorite"))
        return {
            "draftType": "recipe",
            "schemaVersion": "recipe_operation.v1",
            "action": "set_favorite",
            "targetId": recipe.id,
            "baseUpdatedAt": base_updated_at,
            "before": before,
            "payload": {"favorite": favorite},
        }
    if action == "delete":
        return {
            "draftType": "recipe",
            "schemaVersion": "recipe_operation.v1",
            "action": "delete",
            "targetId": recipe.id,
            "baseUpdatedAt": base_updated_at,
            "before": before,
            "payload": {"reason": str((payload.get("payload") or {}).get("reason") or "")},
        }
    incoming_payload = payload.get("payload") or {}
    normalized = _strip_transport_fields(UpdateRecipeRequest.model_validate(incoming_payload).model_dump(mode="json"))
    normalized = normalize_recipe_draft_for_tools(db, family_id=family_id, payload=normalized)
    if "media_ids" not in incoming_payload and "mediaIds" not in incoming_payload:
        normalized["media_ids"] = _bound_media_ids(
            db,
            family_id=family_id,
            entity_type="recipe",
            entity_id=recipe.id,
        )
    return {
        "draftType": "recipe",
        "schemaVersion": "recipe_operation.v1",
        "action": "update",
        "targetId": recipe.id,
        "baseUpdatedAt": base_updated_at,
        "before": before,
        "payload": normalized,
    }


def _build_recipe_cook_preview(db: Session, *, family_id: str, recipe: Recipe, servings: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    preview, shortages = build_cook_inventory_plan(
        db,
        family_id=family_id,
        recipe=recipe,
        servings=servings,
        today=today_for_family(family_id),
    )
    return jsonable_encoder([serialize_cook_preview_item(item) for item in preview]), jsonable_encoder(shortages)


def normalize_food_profile_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and payload.get("action"):
        return _normalize_food_profile_operation_draft(db, family_id=family_id, payload=payload)
    if not isinstance(payload, dict):
        raise ValueError("食物资料草稿格式不正确")
    food = _strip_transport_fields(CreateFoodRequest.model_validate(payload).model_dump(mode="json"))
    recipe_id = food.get("recipe_id")
    if recipe_id:
        recipe = _load_by_id(db, Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")[str(recipe_id)]
        food["name"] = recipe.title
    return {"draftType": "food_profile", "schemaVersion": payload.get("schemaVersion") or "food_profile.v1", **food}


def _normalize_food_profile_operation_draft(db: Session, *, family_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "")
    if action not in {"create", "update", "set_favorite"}:
        raise ValueError("食物资料操作类型不正确")
    if action == "create":
        normalized = normalize_food_profile_draft_for_tools(db, family_id=family_id, payload=payload.get("payload") or {})
        return {
            "draftType": "food_profile",
            "schemaVersion": "food_profile_operation.v1",
            "action": "create",
            "payload": {key: value for key, value in normalized.items() if key not in {"draftType", "schemaVersion"}},
        }
    target_id = str(payload.get("targetId") or payload.get("target_id") or "")
    if not target_id:
        raise ValueError("食物资料操作必须引用真实食物")
    food = _load_by_id(db, Food, family_id=family_id, ids=[target_id], label="食物")[target_id]
    base_updated_at = _normalize_base_updated_at(payload.get("baseUpdatedAt") or payload.get("base_updated_at"))
    if action == "set_favorite":
        favorite = bool((payload.get("payload") or {}).get("favorite"))
        return {
            "draftType": "food_profile",
            "schemaVersion": "food_profile_operation.v1",
            "action": "set_favorite",
            "targetId": food.id,
            "baseUpdatedAt": base_updated_at,
            "before": _serialize_food_before(food),
            "payload": {"favorite": favorite},
        }
    incoming_payload = payload.get("payload") or {}
    before = _serialize_food_before(food)
    normalized = normalize_food_profile_draft_for_tools(db, family_id=family_id, payload=incoming_payload)
    if "media_ids" not in incoming_payload and "mediaIds" not in incoming_payload:
        normalized["media_ids"] = _bound_media_ids(
            db,
            family_id=family_id,
            entity_type="food",
            entity_id=food.id,
        )
    if isinstance(incoming_payload, dict) and "storage_location" not in incoming_payload and "storageLocation" not in incoming_payload:
        normalized["storage_location"] = before.get("storage_location", "")
    return {
        "draftType": "food_profile",
        "schemaVersion": "food_profile_operation.v1",
        "action": "update",
        "targetId": food.id,
        "baseUpdatedAt": base_updated_at,
        "before": before,
        "payload": {key: value for key, value in normalized.items() if key not in {"draftType", "schemaVersion"}},
    }


def normalize_ingredient_profile_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("食材档案草稿格式不正确")
    operations = payload.get("operations")
    if isinstance(operations, list):
        if len(operations) < 2:
            raise ValueError("批量创建食材至少需要 2 项")
        if len(operations) > 5:
            raise ValueError("批量创建食材一次不能超过 5 项")
        normalized_operations: list[dict[str, Any]] = []
        seen_names: set[str] = set()
        for operation in operations:
            if not isinstance(operation, dict):
                raise ValueError("食材档案批量操作项格式不正确")
            action = str(operation.get("action") or "")
            if action != "create":
                raise ValueError("食材档案批量草稿只支持新增食材")
            ingredient_payload = _strip_transport_fields(
                CreateIngredientRequest.model_validate(operation.get("payload") or {}).model_dump(mode="json")
            )
            normalized_name = str(ingredient_payload.get("name") or "").strip().casefold()
            if normalized_name in seen_names:
                raise ValueError("批量创建食材中存在重复名称")
            seen_names.add(normalized_name)
            normalized_operations.append(
                {
                    "operationId": _normalize_operation_id(operation.get("operationId") or operation.get("operation_id")),
                    "action": "create",
                    "payload": ingredient_payload,
                }
            )
        return {
            "draftType": "ingredient_profile",
            "schemaVersion": "ingredient_profile_operation.v1",
            "operations": normalized_operations,
        }
    action = str(payload.get("action") or "")
    if action not in {"create", "update"}:
        raise ValueError("食材档案操作类型不正确")
    request_model = CreateIngredientRequest if action == "create" else UpdateIngredientRequest
    incoming_payload = payload.get("payload") or {}
    ingredient_payload = _strip_transport_fields(request_model.model_validate(incoming_payload).model_dump(mode="json"))
    if action == "create":
        return {
            "draftType": "ingredient_profile",
            "schemaVersion": payload.get("schemaVersion") or "ingredient_profile.v1",
            "action": "create",
            "payload": ingredient_payload,
        }
    target_id = str(payload.get("targetId") or payload.get("target_id") or "")
    if not target_id:
        raise ValueError("更新食材档案必须引用真实食材")
    ingredient = _load_by_id(db, Ingredient, family_id=family_id, ids=[target_id], label="食材")[target_id]
    if "media_ids" not in incoming_payload and "mediaIds" not in incoming_payload:
        ingredient_payload["media_ids"] = _bound_media_ids(
            db,
            family_id=family_id,
            entity_type="ingredient",
            entity_id=ingredient.id,
        )
    return {
        "draftType": "ingredient_profile",
        "schemaVersion": payload.get("schemaVersion") or "ingredient_profile.v1",
        "action": "update",
        "targetId": ingredient.id,
        "baseUpdatedAt": _normalize_base_updated_at(payload.get("baseUpdatedAt") or payload.get("base_updated_at")),
        "before": _serialize_ingredient_before(ingredient),
        "payload": ingredient_payload,
    }


def normalize_inventory_operation_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("库存操作草稿格式不正确")
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("库存操作草稿不能为空")
    if len(operations) > 50:
        raise ValueError("库存操作一次不能超过 50 项")

    ingredient_ids = _string_ids(
        operation.get("ingredientId") or operation.get("ingredient_id")
        for operation in operations
        if isinstance(operation, dict)
    )
    if len(ingredient_ids) != len(operations):
        raise ValueError("每个库存操作都必须引用食材库中的食材")
    ingredients = _load_by_id(db, Ingredient, family_id=family_id, ids=ingredient_ids, label="食材")
    inventory_ids = _string_ids(
        operation.get("inventoryItemId") or operation.get("inventory_item_id")
        for operation in operations
        if isinstance(operation, dict)
    )
    inventory_items = _load_by_id(db, InventoryItem, family_id=family_id, ids=inventory_ids, label="库存批次")
    media_map = build_media_map(get_media_assets_for_entities(
        db,
        family_id=family_id,
        entity_type="ingredient",
        entity_ids=ingredient_ids,
    ))
    today = today_for_family(family_id)
    normalized: list[dict[str, Any]] = []
    reserved_by_inventory_item: dict[str, Decimal] = {}

    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("库存操作项格式不正确")
        action = str(operation.get("action") or "")
        if action not in {"restock", "consume", "dispose"}:
            raise ValueError("库存操作类型不正确")
        ingredient_id = str(operation.get("ingredientId") or operation.get("ingredient_id") or "")
        ingredient = ingredients[ingredient_id]
        inventory_item_id = operation.get("inventoryItemId") or operation.get("inventory_item_id")
        inventory_item = inventory_items.get(str(inventory_item_id)) if inventory_item_id else None
        if inventory_item is not None and inventory_item.ingredient_id != ingredient.id:
            raise ValueError("库存批次不属于所选食材")
        unit = normalize_unit_label(str(operation.get("unit") or ingredient.default_unit))
        if not unit:
            raise ValueError("库存操作单位不能为空")
        raw_quantity = operation.get("quantity")
        quantity = Decimal(str(raw_quantity)) if raw_quantity is not None else None
        if quantity is not None and quantity <= 0:
            raise ValueError("库存操作数量必须大于 0")

        record: dict[str, Any] = {
            "action": action,
            "ingredientId": ingredient.id,
            "ingredientName": ingredient.name,
            "inventoryItemId": inventory_item.id if inventory_item is not None else None,
            "quantity": float(quantity) if quantity is not None else None,
            "unit": unit,
            "notes": str(operation.get("notes") or ""),
            "reason": str(operation.get("reason") or "").strip(),
            "image": _serialize_draft_media(media_map[("ingredient", ingredient.id)][0])
            if media_map.get(("ingredient", ingredient.id))
            else None,
            "remainingQuantity": None,
            "batchOptions": [],
        }
        if operation.get("sourceQuantity") is not None:
            record["sourceQuantity"] = float(Decimal(str(operation.get("sourceQuantity"))))
        if operation.get("sourceUnit") is not None:
            record["sourceUnit"] = normalize_unit_label(str(operation.get("sourceUnit") or ""))
        if operation.get("conversionRatioToDefault") is not None:
            record["conversionRatioToDefault"] = float(Decimal(str(operation.get("conversionRatioToDefault"))))
        if operation.get("conversionNote") is not None:
            record["conversionNote"] = str(operation.get("conversionNote") or "").strip()

        if action == "restock":
            if quantity is None and tracks_quantity(ingredient):
                raise ValueError("入库数量不能为空")
            if tracks_quantity(ingredient):
                try:
                    convert_quantity_to_default_unit(quantity, ingredient.default_unit, ingredient.unit_conversions, unit)
                except UnitConversionError as exc:
                    raise ValueError(str(exc)) from exc
            else:
                record["quantity"] = float(quantity) if quantity is not None else None
                record["unit"] = ingredient.default_unit
            purchase_date = date.fromisoformat(str(operation.get("purchaseDate") or today.isoformat()))
            expiry_value = operation.get("expiryDate")
            if expiry_value:
                expiry_date = date.fromisoformat(str(expiry_value))
            elif ingredient.default_expiry_mode == IngredientExpiryMode.DAYS and ingredient.default_expiry_days:
                expiry_date = purchase_date + timedelta(days=ingredient.default_expiry_days)
            else:
                expiry_date = None
            storage = str(operation.get("storageLocation") or ingredient.default_storage or "常温").strip()
            status_value = operation.get("status")
            if status_value:
                status = InventoryStatus(str(status_value))
            elif "冻" in storage:
                status = InventoryStatus.FROZEN
            else:
                status = InventoryStatus.FRESH
            threshold = operation.get("lowStockThreshold")
            record.update(
                {
                    "purchaseDate": purchase_date.isoformat(),
                    "expiryDate": expiry_date.isoformat() if expiry_date else None,
                    "storageLocation": storage,
                    "status": status.value,
                    "lowStockThreshold": float(threshold) if threshold is not None else None,
                }
            )
        elif action == "consume":
            if quantity is None and tracks_quantity(ingredient):
                raise ValueError("消耗数量不能为空")
            if not tracks_quantity(ingredient):
                # Presence consume is not a precise InventoryItem operation.
                # Leave draft empty of batch options; product presence updates use State.
                record["quantity"] = float(quantity) if quantity is not None else None
                record["unit"] = unit
                record["remainingQuantity"] = None
                record["batchOptions"] = []
                normalized.append(record)
                continue
            candidate_items = [inventory_item] if inventory_item is not None else list(
                db.scalars(
                    select(InventoryItem).where(
                        InventoryItem.family_id == family_id,
                        InventoryItem.ingredient_id == ingredient.id,
                    )
                )
            )
            try:
                requested = convert_quantity_to_default_unit(
                    quantity,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    unit,
                )
                available_items = [
                    item
                    for item in candidate_items
                    if item is not None and (item.expiry_date is None or item.expiry_date >= today)
                ]
                available_items.sort(
                    key=lambda item: (*expiry_sort_key(item.expiry_date), item.purchase_date, item.created_at)
                )
                available_by_item = {
                    item.id: max(
                        inventory_remaining_in_default(item, ingredient)
                        - reserved_by_inventory_item.get(item.id, Decimal("0")),
                        Decimal("0"),
                    )
                    for item in available_items
                }
                available = sum(available_by_item.values(), Decimal("0"))
                record["batchOptions"] = [
                    {
                        "id": item.id,
                        "label": " · ".join(
                            value
                            for value in [
                                f"到期 {item.expiry_date.isoformat()}" if item.expiry_date else "未记录到期日",
                                item.storage_location,
                            ]
                            if value
                        ),
                        "remainingQuantity": float(
                            convert_quantity_from_default_unit(
                                available_by_item[item.id],
                                ingredient.default_unit,
                                ingredient.unit_conversions,
                                unit,
                            )
                        ),
                        "unit": unit,
                        "expiryDate": item.expiry_date.isoformat() if item.expiry_date else None,
                    }
                    for item in available_items
                    if available_by_item[item.id] > 0
                ]
            except UnitConversionError as exc:
                raise ValueError(str(exc)) from exc
            if available < requested:
                available_in_unit = convert_quantity_from_default_unit(
                    available,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    unit,
                )
                raise ValueError(f"{ingredient.name} 当前最多只能消费 {float(available_in_unit):g}{unit}")
            remaining_to_reserve = requested
            for item in available_items:
                if remaining_to_reserve <= 0:
                    break
                reservation = min(available_by_item[item.id], remaining_to_reserve)
                reserved_by_inventory_item[item.id] = (
                    reserved_by_inventory_item.get(item.id, Decimal("0")) + reservation
                )
                remaining_to_reserve -= reservation
        else:
            if not tracks_quantity(ingredient):
                raise PresenceStateRequiredError(
                    f"{ingredient.name} 不记录数量，请通过库存状态接口标记缺货，不能按库存批次销毁"
                )
            if inventory_item is None:
                raise ValueError("销毁操作必须指定库存批次")
            available = max(
                inventory_remaining_in_default(inventory_item, ingredient)
                - reserved_by_inventory_item.get(inventory_item.id, Decimal("0")),
                Decimal("0"),
            )
            if available <= 0:
                raise ValueError(f"{ingredient.name} 的所选库存批次已无剩余数量")
            if quantity is None:
                quantity = convert_quantity_from_default_unit(
                    available,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    unit,
                )
                record["quantity"] = float(quantity)
            requested = convert_quantity_to_default_unit(
                quantity,
                ingredient.default_unit,
                ingredient.unit_conversions,
                unit,
            )
            if requested > available:
                available_in_unit = convert_quantity_from_default_unit(
                    available,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    unit,
                )
                raise ValueError(f"{ingredient.name} 当前最多只能销毁 {float(available_in_unit):g}{unit}")
            reserved_by_inventory_item[inventory_item.id] = (
                reserved_by_inventory_item.get(inventory_item.id, Decimal("0")) + requested
            )
            if not record["reason"]:
                raise ValueError("销毁库存必须填写原因")
            record["remainingQuantity"] = float(
                convert_quantity_from_default_unit(
                    available,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    unit,
                )
            )
            record["batchOptions"] = [
                {
                    "id": inventory_item.id,
                    "label": " · ".join(
                        value
                        for value in [
                            f"到期 {inventory_item.expiry_date.isoformat()}"
                            if inventory_item.expiry_date
                            else "未记录到期日",
                            inventory_item.storage_location,
                        ]
                        if value
                    ),
                    "remainingQuantity": record["remainingQuantity"],
                    "unit": unit,
                    "expiryDate": inventory_item.expiry_date.isoformat()
                    if inventory_item.expiry_date
                    else None,
                }
            ]
        normalized.append(record)

    return {
        "draftType": "inventory_operation",
        "schemaVersion": "inventory_operation.v1",
        "operations": normalized,
        "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
    }


def _load_by_id(db: Session, model: Any, *, family_id: str, ids: list[str], label: str) -> dict[str, Any]:
    unique_ids = list(dict.fromkeys(ids))
    if not unique_ids:
        return {}
    rows = list(db.scalars(select(model).where(model.family_id == family_id, model.id.in_(unique_ids))))
    by_id = {row.id: row for row in rows}
    missing = [item for item in unique_ids if item not in by_id]
    if missing:
        raise ValueError(f"草稿包含不属于当前家庭的{label}: {', '.join(missing)}")
    return by_id


def _load_meal_plan_targets(
    db: Session,
    *,
    family_id: str,
    user_id: str | None,
    ids: list[str],
) -> dict[str, FoodPlanItem]:
    unique_ids = list(dict.fromkeys(ids))
    if not unique_ids:
        return {}
    statement = (
        select(FoodPlanItem)
        .where(FoodPlanItem.family_id == family_id, FoodPlanItem.id.in_(unique_ids))
        .options(selectinload(FoodPlanItem.food))
    )
    if user_id:
        statement = statement.where(FoodPlanItem.user_id == user_id)
    rows = list(db.scalars(statement))
    by_id = {row.id: row for row in rows}
    missing = [item for item in unique_ids if item not in by_id]
    if missing:
        raise ValueError(f"草稿包含不属于当前用户的餐食计划: {', '.join(missing)}")
    return by_id


def _normalize_base_updated_at(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("修改或删除操作必须提供 baseUpdatedAt")
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("baseUpdatedAt 格式不正确") from exc
    return text


def _serialize_shopping_before(item: ShoppingListItem) -> dict[str, Any]:
    record = serialize_shopping_item(item)
    return {
        "id": record["id"],
        "ingredientId": record["ingredient_id"],
        "foodId": record.get("food_id"),
        "targetType": record.get("target_type"),
        "title": record["title"],
        "quantity": record["quantity"],
        "unit": record["unit"],
        "quantityMode": record["quantity_mode"],
        "displayLabel": record["display_label"],
        "reason": record["reason"],
        "done": record["done"],
        "updatedAt": record["updated_at"].isoformat() if hasattr(record.get("updated_at"), "isoformat") else record.get("updated_at"),
    }


def _serialize_meal_plan_before(item: FoodPlanItem) -> dict[str, Any]:
    record = serialize_food_plan_item(item)
    return {
        "id": record["id"],
        "date": record["plan_date"].isoformat() if hasattr(record.get("plan_date"), "isoformat") else record.get("plan_date"),
        "mealType": record["meal_type"].value if hasattr(record.get("meal_type"), "value") else record.get("meal_type"),
        "title": record.get("food_name") or "",
        "foodId": record["food_id"],
        "reason": record["note"],
        "status": record["status"],
        "updatedAt": record["updated_at"].isoformat() if hasattr(record.get("updated_at"), "isoformat") else record.get("updated_at"),
    }


def _serialize_ingredient_before(item: Ingredient) -> dict[str, Any]:
    record = serialize_ingredient(item, {})
    return {
        "id": record["id"],
        "name": record["name"],
        "category": record["category"],
        "default_unit": record["default_unit"],
        "default_storage": record["default_storage"],
        "default_expiry_mode": record["default_expiry_mode"],
        "default_expiry_days": record["default_expiry_days"],
        "default_low_stock_threshold": record["default_low_stock_threshold"],
        "notes": record["notes"],
        "updatedAt": record["updated_at"].isoformat() if hasattr(record.get("updated_at"), "isoformat") else record.get("updated_at"),
    }


def _load_meal_log_target(db: Session, *, family_id: str, meal_log_id: str) -> Any:
    meal_log = db.scalar(
        select(MealLog)
        .where(MealLog.family_id == family_id, MealLog.id == meal_log_id)
        .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
    )
    if meal_log is None:
        raise ValueError("餐食记录不存在或不属于当前家庭")
    return meal_log


def _serialize_meal_log_before(item: Any) -> dict[str, Any]:
    record = serialize_meal_log(item, {})
    return jsonable_encoder(
        {
            "id": record["id"],
            "date": record["date"],
            "mealType": record["meal_type"],
            "participantUserIds": record["participant_user_ids"],
            "notes": record["notes"],
            "mood": record["mood"],
            "photos": record["photos"],
            "foods": [
                {
                    "id": entry["id"],
                    "foodId": entry["food_id"],
                    "foodName": entry["food_name"],
                    "servings": entry["servings"],
                    "note": entry["note"],
                    "rating": entry["rating"],
                }
                for entry in record["food_entries"]
            ],
            "updatedAt": record["updated_at"],
        }
    )


def _serialize_food_before(item: Food) -> dict[str, Any]:
    record = serialize_food(item, {})
    return {
        "id": record["id"],
        "name": record["name"],
        "type": record["type"],
        "category": record["category"],
        "favorite": record["favorite"],
        "recipe_id": record["recipe_id"],
        "updatedAt": record["updated_at"].isoformat() if hasattr(record.get("updated_at"), "isoformat") else record.get("updated_at"),
    }


def _load_recipe_target(db: Session, *, family_id: str, recipe_id: str) -> Recipe:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == recipe_id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs), selectinload(Recipe.foods))
    )
    if recipe is None:
        raise ValueError("菜谱不存在或不属于当前家庭")
    return recipe


def _load_recipe_cook_plan_item(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    recipe_id: str,
    plan_item_id: str | None,
) -> FoodPlanItem | None:
    if not plan_item_id:
        return None
    plan_item = db.scalar(
        select(FoodPlanItem)
        .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
        .join(Food, FoodPlanItem.food_id == Food.id)
        .where(
            FoodPlanItem.family_id == family_id,
            FoodPlanItem.user_id == user_id,
            FoodPlanItem.id == plan_item_id,
            Food.recipe_id == recipe_id,
        )
    )
    if plan_item is None:
        raise ValueError("做菜草稿引用的计划项不存在或不匹配当前菜谱")
    return plan_item


def _serialize_recipe_before(db: Session, *, family_id: str, recipe: Recipe) -> dict[str, Any]:
    record = serialize_recipe(recipe, {})
    media_count = len(record.get("images") or [])
    favorite_count = db.scalar(
        select(func.count(RecipeFavorite.id)).where(
            RecipeFavorite.family_id == family_id,
            RecipeFavorite.recipe_id == recipe.id,
        )
    ) or 0
    plan_item_count = db.scalar(
        select(func.count(FoodPlanItem.id))
        .join(Food, FoodPlanItem.food_id == Food.id)
        .where(FoodPlanItem.family_id == family_id, Food.recipe_id == recipe.id)
    ) or 0
    return {
        "id": record["id"],
        "title": record["title"],
        "servings": record["servings"],
        "prep_minutes": record["prep_minutes"],
        "difficulty": record["difficulty"],
        "ingredient_items": record["ingredient_items"],
        "steps": record["steps"],
        "scene_tags": record["scene_tags"],
        "tips": record["tips"],
        "updatedAt": record["updated_at"].isoformat() if hasattr(record.get("updated_at"), "isoformat") else record.get("updated_at"),
        "linkedFoods": [{"id": food.id, "name": food.name, "recipe_id": food.recipe_id} for food in recipe.foods],
        "linkedFoodCount": len(recipe.foods),
        "planItemCount": plan_item_count,
        "cookLogCount": len(recipe.cook_logs),
        "mediaCount": media_count,
        "favoriteCount": favorite_count,
        "deleteImpact": {
            "linkedFoodCount": len(recipe.foods),
            "linkedFoodIds": [food.id for food in recipe.foods],
            "linkedFoodNames": [food.name for food in recipe.foods],
            "planItemCount": plan_item_count,
            "cookLogCount": len(recipe.cook_logs),
            "mediaCount": media_count,
            "willDeleteLinkedFoods": bool(recipe.foods),
            "willClearRecipeMedia": media_count > 0,
        },
    }


def _serialize_draft_media(asset: Any) -> dict[str, Any]:
    media = serialize_media(asset)
    for key in ("created_at", "updated_at"):
        value = media.get(key)
        if hasattr(value, "isoformat"):
            media[key] = value.isoformat()
    return media


def _string_ids(values: Any) -> list[str]:
    return [str(value) for value in values if value]


def _strip_transport_fields(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != "pending_image_job_id" or value}


def _string_list(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:80] for item in value[:max_items] if item]
