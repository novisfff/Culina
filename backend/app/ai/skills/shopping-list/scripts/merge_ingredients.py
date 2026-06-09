from __future__ import annotations

from decimal import Decimal


def merge_ingredients(items: list[dict]) -> list[dict]:
    merged: dict[tuple[str, str], dict] = {}
    for item in items:
        title = normalize_ingredient(item.get("title") or item.get("name") or "")
        unit = str(item.get("unit") or "份").strip()
        if not title:
            continue
        key = (title, unit)
        amount = Decimal(str(item.get("quantity") or item.get("amount") or 1))
        if key not in merged:
            merged[key] = {"title": title, "quantity": Decimal("0"), "unit": unit}
        merged[key]["quantity"] += amount
    return [{"title": value["title"], "quantity": float(value["quantity"]), "unit": value["unit"]} for value in merged.values()]


def normalize_ingredient(name: str) -> str:
    aliases = {"西红柿": "番茄", "土豆": "马铃薯", "小葱": "葱"}
    text = str(name).strip()
    return aliases.get(text, text)
