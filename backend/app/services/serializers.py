from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal

from app.models.domain import (
    ActivityLog,
    AIConversation,
    AIAgentRun,
    AIApprovalRequest,
    AIMessage,
    AIOperation,
    AIRecommendation,
    AIRunEvent,
    AITaskDraft,
    Family,
    Food,
    FoodPlanItem,
    Ingredient,
    IngredientInventoryState,
    InventoryDeductionSuggestion,
    InventoryItem,
    MealLog,
    MediaAsset,
    Membership,
    Recipe,
    RecipeCookLog,
    RecipeFavorite,
    FoodScene,
    ShoppingListItem,
    User,
)
from app.services.food_stock_quantity import normalize_food_stock_quantity
from app.services.ingredient_units import serialize_unit_conversions


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _to_optional_float(value: Decimal | float | int | None) -> float | None:
    if value is None:
        return None
    return float(value)


def _utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _remaining_quantity(
    quantity: Decimal | float | int | None,
    consumed_quantity: Decimal | float | int | None,
    disposed_quantity: Decimal | float | int | None = None,
) -> float:
    quantity_value = Decimal(str(quantity or 0))
    consumed_value = Decimal(str(consumed_quantity or 0))
    disposed_value = Decimal(str(disposed_quantity or 0))
    return float(max(quantity_value - consumed_value - disposed_value, Decimal("0")))


def serialize_media(asset: MediaAsset) -> dict:
    return {
        "id": asset.id,
        "name": asset.name,
        "url": asset.url,
        "source": asset.source,
        "alt": asset.alt,
        "generation_mode": asset.generation_mode,
        "reference_media_id": asset.reference_media_id,
        "style_key": asset.style_key,
        "prompt_version": asset.prompt_version,
        "variants": asset.variants,
        "created_at": _utc_datetime(asset.created_at),
        "created_by": asset.created_by,
    }


def group_media_by_entity(assets: list[MediaAsset]) -> dict[tuple[str, str], list[MediaAsset]]:
    grouped: dict[tuple[str, str], list[MediaAsset]] = defaultdict(list)
    for asset in assets:
        if asset.entity_type and asset.entity_id:
            grouped[(asset.entity_type, asset.entity_id)].append(asset)
    return grouped


def serialize_user(user: User, media_map: dict[tuple[str, str], list[MediaAsset]] | None = None) -> dict:
    media = (media_map or {}).get(("user", user.id), [])
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "email": user.email,
        "phone": user.phone,
        "avatar_seed": user.avatar_seed,
        "avatar_image": serialize_media(media[0]) if media else None,
    }


def serialize_membership(membership: Membership) -> dict:
    return {
        "id": membership.id,
        "family_id": membership.family_id,
        "user_id": membership.user_id,
        "role": membership.role,
        "status": membership.status.value if hasattr(membership.status, "value") else membership.status,
    }


def serialize_family(
    family: Family,
    recommendations: list[AIRecommendation] | None = None,
    media_map: dict[tuple[str, str], list[MediaAsset]] | None = None,
) -> dict:
    media = (media_map or {}).get(("family", family.id), [])
    return {
        "id": family.id,
        "name": family.name,
        "motto": family.motto,
        "location": family.location,
        "food_preferences": list(family.food_preferences or []),
        "food_avoidances": list(family.food_avoidances or []),
        "image": serialize_media(media[0]) if media else None,
        "created_at": _utc_datetime(family.created_at),
        "updated_at": _utc_datetime(family.updated_at),
        "ai_recommendations": [serialize_ai_recommendation(item) for item in (recommendations or [])],
    }


def serialize_member(user: User, membership: Membership, media_map: dict[tuple[str, str], list[MediaAsset]] | None = None) -> dict:
    return {
        **serialize_user(user, media_map),
        "role": membership.role,
        "status": membership.status.value if hasattr(membership.status, "value") else membership.status,
    }


def serialize_ingredient(ingredient: Ingredient, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    media = media_map.get(("ingredient", ingredient.id), [])
    return {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "name": ingredient.name,
        "category": ingredient.category,
        "default_unit": ingredient.default_unit,
        "unit_conversions": serialize_unit_conversions(ingredient.default_unit, ingredient.unit_conversions),
        "quantity_tracking_mode": ingredient.quantity_tracking_mode.value if hasattr(ingredient.quantity_tracking_mode, "value") else ingredient.quantity_tracking_mode,
        "default_storage": ingredient.default_storage,
        "default_expiry_mode": ingredient.default_expiry_mode,
        "default_expiry_days": ingredient.default_expiry_days,
        "default_low_stock_threshold": _to_optional_float(ingredient.default_low_stock_threshold),
        "notes": ingredient.notes,
        "image": serialize_media(media[0]) if media else None,
        "row_version": int(ingredient.row_version),
        "created_at": _utc_datetime(ingredient.created_at),
        "updated_at": _utc_datetime(ingredient.updated_at),
        "created_by": ingredient.created_by,
        "updated_by": ingredient.updated_by,
    }


def serialize_inventory_item(item: InventoryItem) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "ingredient_id": item.ingredient_id,
        "ingredient_name": item.ingredient.name if item.ingredient else "",
        "quantity_tracking_mode": (
            item.ingredient.quantity_tracking_mode.value
            if item.ingredient and hasattr(item.ingredient.quantity_tracking_mode, "value")
            else item.ingredient.quantity_tracking_mode
            if item.ingredient
            else "track_quantity"
        ),
        "quantity": _to_float(item.quantity),
        "consumed_quantity": _to_float(item.consumed_quantity),
        "disposed_quantity": _to_float(item.disposed_quantity),
        "remaining_quantity": _remaining_quantity(item.quantity, item.consumed_quantity, item.disposed_quantity),
        "unit": item.unit,
        "entered_quantity": _to_optional_float(item.entered_quantity),
        "entered_unit": item.entered_unit,
        "status": item.status,
        "purchase_date": item.purchase_date,
        "expiry_date": item.expiry_date,
        "storage_location": item.storage_location,
        "notes": item.notes,
        "low_stock_threshold": _to_float(item.low_stock_threshold),
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
        "created_by": item.created_by,
        "updated_by": item.updated_by,
        "row_version": item.row_version,
        "expiry_alert_snoozed_until": item.expiry_alert_snoozed_until,
        "expiry_reviewed_at": _utc_datetime(item.expiry_reviewed_at),
        "expiry_reviewed_by": item.expiry_reviewed_by,
        "last_confirmed_at": _utc_datetime(item.last_confirmed_at),
        "last_confirmed_by": item.last_confirmed_by,
        "last_confirmation_source": item.last_confirmation_source,
    }


def serialize_ingredient_inventory_state(state: IngredientInventoryState) -> dict:
    return {
        "id": state.id,
        "family_id": state.family_id,
        "ingredient_id": state.ingredient_id,
        "availability_level": state.availability_level,
        "inventory_status": state.inventory_status,
        "purchase_date": state.purchase_date,
        "expiry_date": state.expiry_date,
        "storage_location": state.storage_location,
        "notes": state.notes,
        "expiry_alert_snoozed_until": state.expiry_alert_snoozed_until,
        "expiry_reviewed_at": _utc_datetime(state.expiry_reviewed_at),
        "expiry_reviewed_by": state.expiry_reviewed_by,
        "last_confirmed_at": _utc_datetime(state.last_confirmed_at),
        "last_confirmed_by": state.last_confirmed_by,
        "last_confirmation_source": state.last_confirmation_source,
        "row_version": state.row_version,
        "created_at": _utc_datetime(state.created_at),
        "updated_at": _utc_datetime(state.updated_at),
    }


def serialize_shopping_item(item: ShoppingListItem) -> dict:
    if item.food_id:
        target_type = "food"
    elif item.ingredient_id:
        target_type = "ingredient"
    else:
        target_type = "free_text"
    return {
        "id": item.id,
        "family_id": item.family_id,
        "ingredient_id": item.ingredient_id,
        "food_id": item.food_id,
        "target_type": target_type,
        "title": item.title,
        "quantity": _to_float(item.quantity),
        "unit": item.unit,
        "quantity_mode": item.quantity_mode.value if hasattr(item.quantity_mode, "value") else item.quantity_mode,
        "display_label": item.display_label,
        "reason": item.reason,
        "done": item.done,
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
        "created_by": item.created_by,
        "updated_by": item.updated_by,
        "row_version": item.row_version,
    }


def serialize_recipe(recipe: Recipe, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": recipe.id,
        "family_id": recipe.family_id,
        "title": recipe.title,
        "servings": recipe.servings,
        "prep_minutes": recipe.prep_minutes,
        "difficulty": recipe.difficulty,
        "ingredient_items": [
            {
                "id": item.id,
                "ingredient_id": item.ingredient_id,
                "ingredient_name": item.ingredient_name,
                "quantity": _to_float(item.quantity),
                "unit": item.unit,
                "note": item.note,
            }
            for item in recipe.ingredient_items
        ],
        "steps": [
            {
                "id": step.id,
                "title": step.title or "",
                "text": step.text,
                "icon": step.icon or "pan",
                "summary": step.summary or "",
                "estimated_minutes": step.estimated_minutes,
                "tip": step.tip or "",
                "key_points": step.key_points or [],
            }
            for step in recipe.steps
        ],
        "tips": recipe.tips,
        "scene_tags": list(recipe.scene_tags or []),
        "images": [serialize_media(asset) for asset in media_map.get(("recipe", recipe.id), [])],
        "cook_logs": [serialize_recipe_cook_log(item) for item in list(recipe.cook_logs)[:5]],
        "created_at": _utc_datetime(recipe.created_at),
        "updated_at": _utc_datetime(recipe.updated_at),
        "created_by": recipe.created_by,
        "updated_by": recipe.updated_by,
    }


def serialize_recipe_cook_log(item: RecipeCookLog) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "recipe_id": item.recipe_id,
        "meal_log_id": item.meal_log_id,
        "cook_date": item.cook_date,
        "meal_type": item.meal_type,
        "servings": _to_float(item.servings),
        "result_note": item.result_note,
        "adjustments": item.adjustments,
        "rating": item.rating,
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_food_scene(item: FoodScene, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    images = media_map.get(("food_scene", item.id), [])
    return {
        "id": item.id,
        "family_id": item.family_id,
        "name": item.name,
        "description": item.description,
        "image_prompt": item.image_prompt,
        "image": serialize_media(images[0]) if images else None,
        "hidden": item.hidden,
        "custom": item.custom,
        "sort_order": item.sort_order,
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_recipe_favorite(item: RecipeFavorite) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "user_id": item.user_id,
        "recipe_id": item.recipe_id,
        "created_at": _utc_datetime(item.created_at),
    }


def serialize_food_plan_item(item: FoodPlanItem) -> dict:
    recipe = item.food.recipe if item.food else None
    return {
        "id": item.id,
        "family_id": item.family_id,
        "user_id": item.user_id,
        "food_id": item.food_id,
        "food_name": item.food.name if item.food else "",
        "food_type": item.food.type if item.food else "",
        "recipe_id": recipe.id if recipe else None,
        "recipe_title": recipe.title if recipe else "",
        "plan_date": item.plan_date,
        "meal_type": item.meal_type,
        "note": item.note,
        "status": item.status,
        "completed_at": _utc_datetime(item.completed_at),
        "meal_log_id": item.meal_log_id,
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


serialize_recipe_plan_item = serialize_food_plan_item


def serialize_food(food: Food, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": food.id,
        "family_id": food.family_id,
        "name": food.name,
        "type": food.type.value if hasattr(food.type, "value") else food.type,
        "category": food.category,
        "flavor_tags": list(food.flavor_tags or []),
        "scene_tags": list(food.scene_tags or []),
        "suitable_meal_types": list(food.suitable_meal_types or []),
        "source_name": food.source_name,
        "purchase_source": food.purchase_source,
        "scene": food.scene,
        "images": [serialize_media(asset) for asset in media_map.get(("food", food.id), [])],
        "notes": food.notes,
        "routine_note": food.routine_note,
        "price": float(food.price) if food.price is not None else None,
        "rating": food.rating,
        "repurchase": food.repurchase,
        "expiry_date": food.expiry_date,
        "stock_quantity": float(normalize_food_stock_quantity(food.stock_quantity)) if food.stock_quantity is not None else None,
        "stock_unit": food.stock_unit,
        "storage_location": food.storage_location,
        "favorite": food.favorite,
        "recipe_id": food.recipe_id,
        "created_at": _utc_datetime(food.created_at),
        "updated_at": _utc_datetime(food.updated_at),
        "created_by": food.created_by,
        "updated_by": food.updated_by,
        "row_version": food.row_version,
        "inventory_last_confirmed_at": _utc_datetime(food.inventory_last_confirmed_at),
        "inventory_last_confirmed_by": food.inventory_last_confirmed_by,
        "inventory_confirmation_source": food.inventory_confirmation_source,
    }


def serialize_deduction_suggestion(item: InventoryDeductionSuggestion) -> dict:
    return {
        "id": item.id,
        "ingredient_name": item.ingredient_name,
        "suggested_amount": _to_float(item.suggested_amount),
        "unit": item.unit,
        "based_on_food_name": item.based_on_food_name,
    }


def serialize_meal_log(meal_log: MealLog, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": meal_log.id,
        "family_id": meal_log.family_id,
        "date": meal_log.date,
        "meal_type": meal_log.meal_type,
        "food_entries": [
            {
                "id": entry.id,
                "food_id": entry.food_id,
                "food_name": entry.food.name if entry.food else "",
                "servings": _to_float(entry.servings),
                "note": entry.note,
                "rating": _to_optional_float(entry.rating),
            }
            for entry in meal_log.food_entries
        ],
        "participant_user_ids": list(meal_log.participant_user_ids or []),
        "notes": meal_log.notes,
        "mood": meal_log.mood,
        "photos": [serialize_media(asset) for asset in media_map.get(("meal_log", meal_log.id), [])],
        "deduction_suggestions": [serialize_deduction_suggestion(item) for item in meal_log.deduction_suggestions],
        "created_at": _utc_datetime(meal_log.created_at),
        "updated_at": _utc_datetime(meal_log.updated_at),
        "created_by": meal_log.created_by,
        "updated_by": meal_log.updated_by,
    }


def serialize_activity(log: ActivityLog, actor_name: str | None = None) -> dict:
    return {
        "id": log.id,
        "family_id": log.family_id,
        "actor_id": log.actor_id,
        "actor_name": actor_name,
        "action": log.action.value if hasattr(log.action, "value") else log.action,
        "entity_type": log.entity_type,
        "entity_id": log.entity_id,
        "summary": log.summary,
        "created_at": _utc_datetime(log.created_at),
    }


def serialize_ai_conversation(item: AIConversation, *, owner_display_name: str, current_user_id: str) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "owner_user_id": item.owner_user_id,
        "owner_display_name": owner_display_name,
        "visibility": item.visibility,
        "is_owner": item.owner_user_id == current_user_id,
        "mode": item.mode,
        "prompt": item.prompt,
        "response": item.response,
        "created_at": _utc_datetime(item.created_at),
        "created_by": item.created_by,
        "context": item.context,
        "title": item.title,
        "summary": item.summary,
        "status": item.status,
        "last_message_at": _utc_datetime(item.last_message_at),
        "last_run_status": item.last_run_status,
    }


def serialize_ai_recommendation(item: AIRecommendation) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "title": item.title,
        "detail": item.detail,
        "created_at": _utc_datetime(item.created_at),
    }


def _normalize_legacy_inventory_item(item: dict) -> dict:
    normalized = dict(item)
    source_type = str(normalized.get("sourceType") or "").strip()
    if source_type not in {"ingredient", "food"}:
        source_type = "food" if normalized.get("foodId") else "ingredient"
    normalized["sourceType"] = source_type
    normalized.setdefault("ingredientId", None)
    normalized.setdefault("foodId", None)
    if "inventoryItemId" not in normalized:
        item_id = str(normalized.get("id") or "").strip()
        normalized["inventoryItemId"] = (
            item_id
            if source_type == "ingredient" and item_id and not item_id.startswith("ingredient:")
            else None
        )
    if "quantityTrackingMode" not in normalized:
        normalized["quantityTrackingMode"] = (
            "not_track_quantity"
            if str(normalized.get("quantity") or "").strip() == "已有"
            else "track_quantity"
        )
    return normalized


def _normalize_legacy_inventory_card(card: dict) -> dict:
    if card.get("type") != "inventory_summary" or not isinstance(card.get("data"), dict):
        return dict(card)
    normalized = dict(card)
    data = dict(card["data"])
    items = [
        _normalize_legacy_inventory_item(item)
        for item in data.get("items") or []
        if isinstance(item, dict)
    ]
    data.setdefault("queryFocus", "overview")
    data.setdefault("availableCount", len(items))
    data.setdefault(
        "expiringCount",
        sum(item.get("displayStatus") == "expiring" for item in items),
    )
    data.setdefault(
        "expiredCount",
        sum(item.get("displayStatus") == "expired" for item in items),
    )
    data.setdefault(
        "lowStockCount",
        sum(item.get("displayStatus") == "low_stock" for item in items),
    )
    data.setdefault(
        "foodStockCount",
        sum(item.get("sourceType") == "food" for item in items),
    )
    data["items"] = items
    normalized["data"] = data
    return normalized


def _normalize_ai_message_parts(parts: list[dict] | None) -> list[dict]:
    normalized: list[dict] = []
    for part in parts or []:
        if not isinstance(part, dict):
            continue
        next_part = dict(part)
        if isinstance(part.get("card"), dict):
            next_part["card"] = _normalize_legacy_inventory_card(part["card"])
        normalized.append(next_part)
    return normalized


def serialize_ai_message(item: AIMessage) -> dict:
    return {
        "id": item.id,
        "conversation_id": item.conversation_id,
        "role": item.role,
        "content": item.content,
        "content_type": item.content_type,
        "parts": _normalize_ai_message_parts(item.parts),
        "run_id": item.run_id,
        "status": item.status,
        "metadata": item.message_metadata,
        "client_message_id": item.client_message_id,
        "created_at": _utc_datetime(item.created_at),
    }


def serialize_ai_run(item: AIAgentRun) -> dict:
    return {
        "id": item.id,
        "agent_key": item.agent_key,
        "intent": item.intent,
        "status": item.status,
        "model": item.model,
        "created_at": _utc_datetime(item.created_at),
    }


def serialize_ai_run_event(item: AIRunEvent) -> dict:
    return {
        "id": item.id,
        "run_id": item.run_id,
        "type": item.type,
        "internal_code": item.internal_code,
        "user_message": item.user_message,
        "status": item.status,
        "created_at": _utc_datetime(item.created_at),
    }


def serialize_ai_task_draft(item: AITaskDraft) -> dict:
    return {
        "id": item.id,
        "conversation_id": item.conversation_id,
        "message_id": item.message_id,
        "run_id": item.source_run_id,
        "draft_type": item.draft_type,
        "payload": item.payload,
        "preview_summary": item.preview_summary,
        "status": item.status,
        "version": item.version,
        "schema_version": item.schema_version,
        "validation_errors": item.validation_errors,
        "expires_at": _utc_datetime(item.expires_at),
        "created_at": _utc_datetime(item.created_at),
        "updated_at": _utc_datetime(item.updated_at),
    }


def serialize_ai_approval_request(item: AIApprovalRequest) -> dict:
    request_payload = item.request_payload or {}
    return {
        "id": item.id,
        "conversation_id": item.conversation_id,
        "message_id": item.message_id,
        "run_id": item.run_id,
        "draft_id": item.draft_id,
        "draft_version": item.draft_version,
        "draft_schema_version": item.draft_schema_version,
        "approval_type": item.approval_type,
        "status": item.status,
        "title": request_payload.get("title", ""),
        "instruction": request_payload.get("instruction", ""),
        "approve_label": request_payload.get("approveLabel", "确认"),
        "reject_label": request_payload.get("rejectLabel", "拒绝"),
        "require_reject_comment": bool(request_payload.get("requireRejectComment", False)),
        "failure_summary": request_payload.get("failureSummary"),
        "field_schema": item.field_schema,
        "initial_values": item.initial_values,
        "submitted_values": item.submitted_values,
        "decision": item.decision,
        "comment": item.comment,
        "resolved_at": _utc_datetime(item.resolved_at),
        "expires_at": _utc_datetime(item.expires_at),
        "created_at": _utc_datetime(item.created_at),
    }


def serialize_ai_operation(item: AIOperation) -> dict:
    return {
        "id": item.id,
        "approval_request_id": item.approval_request_id,
        "draft_id": item.draft_id,
        "operation_type": item.operation_type,
        "status": item.status,
        "business_entity_type": item.business_entity_type,
        "business_entity_ids": item.business_entity_ids,
        "error_message": item.error_message,
        "completed_at": _utc_datetime(item.completed_at),
        "created_at": _utc_datetime(item.created_at),
    }
