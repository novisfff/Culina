from __future__ import annotations

from decimal import Decimal, InvalidOperation


ALIASES = {
    "西红柿": "番茄",
    "土豆": "马铃薯",
    "小葱": "葱",
    "香葱": "葱",
    "洋芋": "马铃薯",
    "鸡脯肉": "鸡胸肉",
    "牛肉片": "牛肉",
    "猪肉末": "猪肉糜",
    "肉末": "猪肉糜",
}

UNIT_ALIASES = {
    "g": "克",
    "G": "克",
    "克重": "克",
    "kg": "千克",
    "KG": "千克",
    "公斤": "千克",
    "斤": "斤",
    "pcs": "个",
    "piece": "个",
    "pieces": "个",
    "只": "个",
    "颗": "个",
}


def suggest_items_from_sources(
    meal_plan_items: list[dict],
    inventory_items: list[dict],
    pending_items: list[dict],
) -> dict:
    """Build shopping candidates from meal-plan shortages, inventory, and pending shopping items."""
    candidates: dict[tuple[str, str], dict] = {}
    for plan in meal_plan_items:
        for missing in _missing_items(plan):
            title = _normalize_title(missing.get("name") or missing.get("title") or missing.get("ingredientName"))
            if not title:
                continue
            unit = _unit(missing.get("unit"))
            quantity = _quantity(missing.get("quantity"), default=1)
            key = (title, unit)
            record = candidates.setdefault(
                key,
                {
                    "title": title,
                    "quantity": Decimal("0"),
                    "unit": unit,
                    "reasons": [],
                    "sourceMealTitles": [],
                    "alreadyPending": False,
                    "availableQuantity": Decimal("0"),
                    "pendingQuantity": Decimal("0"),
                },
            )
            record["quantity"] += quantity
            meal_title = str(plan.get("title") or plan.get("mealTitle") or "").strip()
            if meal_title and meal_title not in record["sourceMealTitles"]:
                record["sourceMealTitles"].append(meal_title)
            reason = _source_reason(plan, title)
            if reason and reason not in record["reasons"]:
                record["reasons"].append(reason)

    inventory_by_key = _quantity_by_key(inventory_items, title_fields=("name", "title"))
    pending_by_key = _quantity_by_key(
        [item for item in pending_items if not bool(item.get("done"))],
        title_fields=("title", "name"),
    )
    for key, record in candidates.items():
        available_quantity = inventory_by_key.get(key, Decimal("0"))
        pending_quantity = pending_by_key.get(key, Decimal("0"))
        record["availableQuantity"] = available_quantity
        record["pendingQuantity"] = pending_quantity
        if pending_quantity > 0:
            record["alreadyPending"] = True

    items = []
    skipped = []
    for key in sorted(candidates):
        record = candidates[key]
        remaining = record["quantity"] - record["availableQuantity"] - record["pendingQuantity"]
        output = {
            "title": record["title"],
            "quantity": float(remaining) if remaining > 0 else 0,
            "unit": record["unit"],
            "neededQuantity": float(record["quantity"]),
            "availableQuantity": float(record["availableQuantity"]),
            "pendingQuantity": float(record["pendingQuantity"]),
            "alreadyPending": bool(record["alreadyPending"]),
            "reasons": record["reasons"],
            "sourceMealTitles": record["sourceMealTitles"],
        }
        if remaining > 0:
            items.append(output)
        else:
            skipped.append({**output, "skipReason": "已有库存或待买项覆盖"})

    return {"items": items, "skipped": skipped, "itemCount": len(items)}


def _missing_items(plan: dict) -> list[dict]:
    structured = plan.get("missingIngredientItems")
    if isinstance(structured, list) and structured:
        return [item for item in structured if isinstance(item, dict)]
    names = plan.get("missingIngredients")
    if isinstance(names, list):
        return [{"name": name, "quantity": 1, "unit": "份"} for name in names]
    return []


def _source_reason(plan: dict, title: str) -> str:
    date = str(plan.get("date") or plan.get("planDate") or "").strip()
    meal_type = str(plan.get("mealType") or "").strip()
    meal_title = str(plan.get("title") or plan.get("mealTitle") or "").strip()
    source = " ".join(part for part in [date, meal_type, meal_title] if part)
    return f"{source} 缺少{title}" if source else f"计划缺少{title}"


def _quantity_by_key(items: list[dict], *, title_fields: tuple[str, ...]) -> dict[tuple[str, str], Decimal]:
    result: dict[tuple[str, str], Decimal] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        title = ""
        for field in title_fields:
            title = _normalize_title(item.get(field))
            if title:
                break
        if not title:
            continue
        unit = _unit(item.get("unit"))
        result[(title, unit)] = result.get((title, unit), Decimal("0")) + _quantity(
            item.get("quantity") or item.get("amount"),
            default=0,
        )
    return result


def _normalize_title(value) -> str:
    text = str(value or "").strip()
    return ALIASES.get(text, text)


def _unit(value) -> str:
    text = str(value or "份").strip() or "份"
    return UNIT_ALIASES.get(text, text)


def _quantity(value, *, default: int) -> Decimal:
    try:
        quantity = Decimal(str(value if value is not None else default))
    except (InvalidOperation, ValueError):
        return Decimal(str(default))
    return quantity if quantity > 0 else Decimal(str(default))
