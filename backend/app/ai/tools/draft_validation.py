from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import IngredientExpiryMode, InventoryStatus, MealType
from app.models.domain import AITaskDraft, Food, Ingredient, InventoryItem, Recipe
from app.schemas.foods import CreateFoodRequest
from app.schemas.recipes import CreateRecipeRequest
from app.schemas.shopping import CreateShoppingListItemRequest
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.clock import today_for_family
from app.services.ingredient_units import (
    UnitConversionError,
    convert_quantity_from_default_unit,
    convert_quantity_to_default_unit,
    normalize_unit_label,
)
from app.services.inventory_usage import expiry_sort_key, inventory_remaining_in_default
from app.services.serializers import serialize_media


def normalize_shopping_list_draft(db: Session, *, family_id: str, conversation_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("购物清单草稿格式不正确")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("购物清单草稿不能为空")
    source_draft_id = payload.get("sourceDraftId")
    if source_draft_id:
        source_draft_id = str(source_draft_id)
        if not source_draft_id.startswith("in_run:"):
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
        "items": [CreateShoppingListItemRequest.model_validate(item).model_dump(mode="json") for item in items],
        "sourceDraftId": source_draft_id or None,
    }


def normalize_meal_plan_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食计划草稿格式不正确")
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


def normalize_meal_log_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食记录草稿格式不正确")
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
        normalized_foods.append(
            {
                "foodId": food.id,
                "name": food.name,
                "servings": max(float(item.get("servings") or 1), 0.1),
                "note": str(item.get("note") or ""),
            }
        )

    return {
        "draftType": "meal_log",
        "schemaVersion": payload.get("schemaVersion") or "meal_log.v1",
        "date": date.fromisoformat(str(payload.get("date"))).isoformat(),
        "mealType": MealType(str(payload.get("mealType"))).value,
        "foods": normalized_foods,
        "notes": str(payload.get("notes") or ""),
    }


def normalize_recipe_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    recipe = CreateRecipeRequest.model_validate(payload).model_dump(mode="json")
    ingredient_ids = _string_ids(item.get("ingredient_id") for item in recipe["ingredient_items"])
    ingredients_by_id = _load_by_id(db, Ingredient, family_id=family_id, ids=ingredient_ids, label="食材")
    normalized_items = []
    for item in recipe["ingredient_items"]:
        ingredient_id = item.get("ingredient_id")
        if ingredient_id:
            ingredient = ingredients_by_id[str(ingredient_id)]
            item = {**item, "ingredient_id": ingredient.id, "ingredient_name": ingredient.name}
        normalized_items.append(item)
    return {**recipe, "ingredient_items": normalized_items}


def normalize_food_profile_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    food = CreateFoodRequest.model_validate(payload).model_dump(mode="json")
    recipe_id = food.get("recipe_id")
    if recipe_id:
        recipe = _load_by_id(db, Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")[str(recipe_id)]
        food["name"] = recipe.title
    return {"draftType": "food_profile", "schemaVersion": payload.get("schemaVersion") or "food_profile.v1", **food}


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

        if action == "restock":
            if quantity is None:
                raise ValueError("入库数量不能为空")
            try:
                convert_quantity_to_default_unit(quantity, ingredient.default_unit, ingredient.unit_conversions, unit)
            except UnitConversionError as exc:
                raise ValueError(str(exc)) from exc
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
            if quantity is None:
                raise ValueError("消耗数量不能为空")
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


def _serialize_draft_media(asset: Any) -> dict[str, Any]:
    media = serialize_media(asset)
    for key in ("created_at", "updated_at"):
        value = media.get(key)
        if hasattr(value, "isoformat"):
            media[key] = value.isoformat()
    return media


def _string_ids(values: Any) -> list[str]:
    return [str(value) for value in values if value]


def _string_list(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:80] for item in value[:max_items] if item]
