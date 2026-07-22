from __future__ import annotations

from decimal import Decimal
from typing import Any


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
