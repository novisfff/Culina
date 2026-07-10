from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import ShoppingListItem


class ContinuationBuildError(ValueError):
    pass


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise ContinuationBuildError(f"missing_{key}")
    return value


def build_recipe_shortage_state(
    *,
    recipe_id: str,
    shortages: list[dict[str, Any]],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for shortage in shortages:
        shortage_type = _required_text(shortage, "shortage_type")
        row: dict[str, Any] = {
            "ingredientId": _required_text(shortage, "ingredient_id"),
            "ingredientName": _required_text(shortage, "ingredient_name"),
            "shortageType": shortage_type,
        }
        if shortage_type == "quantity":
            row["quantity"] = _decimal_text(Decimal(str(shortage.get("missing_quantity"))))
            row["unit"] = _required_text(shortage, "unit")
        rows.append(row)
    if not rows:
        raise ContinuationBuildError("recipe_has_no_shortage")
    return {"recipeId": recipe_id, "shortages": rows}


def build_recipe_shortage_continuation(
    *,
    recipe_id: str,
    shortages: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "workflowId": f"recipe-shortage:{recipe_id}",
        "stepKey": "shopping-proposal",
        "reasonCode": "recipe_shortage",
        "nextSkillKey": "shopping_list",
        "resumeSkillKey": "shopping_list",
        "requiredDraftType": "shopping_list",
        "stateSchema": "recipe_shortage_to_shopping.v1",
        "state": build_recipe_shortage_state(recipe_id=recipe_id, shortages=shortages),
    }


def build_shopping_to_stock_continuation(
    db: Session,
    *,
    family_id: str,
    shopping_item_id: str,
) -> dict[str, Any]:
    item = db.scalar(
        select(ShoppingListItem).where(
            ShoppingListItem.id == shopping_item_id,
            ShoppingListItem.family_id == family_id,
        )
    )
    if item is None or not item.done:
        raise ContinuationBuildError("shopping_item_not_completed")
    if bool(item.ingredient_id) == bool(item.food_id):
        raise ContinuationBuildError("shopping_item_target_invalid")

    state: dict[str, Any] = {
        "shoppingItemId": item.id,
        "targetType": "ingredient" if item.ingredient_id else "food",
        "ingredientId": item.ingredient_id,
        "foodId": item.food_id,
        "quantity": _decimal_text(item.quantity),
        "unit": item.unit,
        "stockAction": "restock",
    }
    if item.ingredient_id:
        reason_code = "shopping_completed_ingredient"
        resume_skill = "inventory_analysis"
        required_draft_type = "inventory_operation"
    else:
        reason_code = "shopping_completed_food"
        resume_skill = "food_profile"
        required_draft_type = "food_profile"

    return {
        "workflowId": f"shopping-stock:{item.id}",
        "stepKey": "stock-intake",
        "reasonCode": reason_code,
        "nextSkillKey": resume_skill,
        "resumeSkillKey": resume_skill,
        "requiredDraftType": required_draft_type,
        "stateSchema": "shopping_to_stock.v1",
        "state": state,
    }


def build_shopping_to_stock_continuation_from_decision(
    db: Session,
    *,
    family_id: str,
    decision_result: dict[str, Any],
) -> dict[str, Any] | None:
    approval = decision_result.get("approval")
    draft = decision_result.get("draft")
    operation = decision_result.get("operation")
    if not isinstance(approval, dict) or approval.get("decision") != "approved":
        return None
    if not isinstance(draft, dict) or draft.get("draft_type") != "shopping_list":
        return None
    if not isinstance(operation, dict) or operation.get("status") != "succeeded":
        return None
    payload = draft.get("payload") if isinstance(draft.get("payload"), dict) else {}
    operations = payload.get("operations") if isinstance(payload.get("operations"), list) else []
    completed_ids = [
        str(item.get("targetId") or "").strip()
        for item in operations
        if isinstance(item, dict)
        and item.get("action") == "set_done"
        and isinstance(item.get("payload"), dict)
        and item["payload"].get("done") is True
    ]
    completed_ids = [item_id for item_id in completed_ids if item_id]
    business_ids = {
        str(item).strip()
        for item in operation.get("business_entity_ids") or []
        if str(item).strip()
    }
    if len(completed_ids) != 1 or completed_ids[0] not in business_ids:
        return None
    try:
        return build_shopping_to_stock_continuation(
            db,
            family_id=family_id,
            shopping_item_id=completed_ids[0],
        )
    except ContinuationBuildError:
        return None
