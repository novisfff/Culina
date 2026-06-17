from __future__ import annotations


def lint_recipe_draft(draft: dict) -> dict:
    """Check recipe draft structure before calling the recipe draft tool."""
    errors: list[dict] = []
    warnings: list[dict] = []
    title = str(draft.get("title") or "").strip()
    if not title:
        errors.append({"field": "title", "message": "缺少菜谱标题"})

    servings = _positive_int(draft.get("servings"))
    if servings <= 0:
        errors.append({"field": "servings", "message": "份数必须大于 0"})

    prep_minutes = _positive_int(draft.get("prep_minutes") or draft.get("prepMinutes"))
    if prep_minutes <= 0:
        errors.append({"field": "prep_minutes", "message": "制作时间必须大于 0"})

    difficulty = str(draft.get("difficulty") or "").strip()
    if not difficulty:
        errors.append({"field": "difficulty", "message": "缺少难度"})

    ingredient_items = draft.get("ingredient_items") or draft.get("ingredientItems") or []
    ingredient_names: list[str] = []
    if not isinstance(ingredient_items, list) or not ingredient_items:
        errors.append({"field": "ingredient_items", "message": "至少需要一个食材"})
    else:
        for index, item in enumerate(ingredient_items):
            if not isinstance(item, dict):
                errors.append({"field": "ingredient_items", "index": index, "message": "食材项格式不正确"})
                continue
            name = str(item.get("ingredient_name") or item.get("name") or "").strip()
            if not name:
                errors.append({"field": "ingredient_items", "index": index, "message": "食材名称不能为空"})
            else:
                ingredient_names.append(name)
            if not item.get("quantity"):
                warnings.append({"field": "ingredient_items", "index": index, "message": "食材缺少数量"})
            if not str(item.get("unit") or "").strip():
                warnings.append({"field": "ingredient_items", "index": index, "message": "食材缺少单位"})

    steps = draft.get("steps") or []
    step_texts: list[str] = []
    if not isinstance(steps, list) or not steps:
        errors.append({"field": "steps", "message": "至少需要一个步骤"})
    else:
        for index, step in enumerate(steps):
            text = str(step.get("description") or step.get("text") or step.get("instruction") or "").strip() if isinstance(step, dict) else str(step).strip()
            step_texts.append(text)
            if len(text) < 4:
                errors.append({"field": "steps", "index": index, "message": "步骤描述过短"})
    combined_steps = " ".join(step_texts)
    for name in ingredient_names:
        if name and name not in combined_steps:
            warnings.append({"field": "steps", "message": f"步骤中未明确提到食材：{name}"})

    return {"valid": not errors, "errors": errors, "warnings": warnings}


def _positive_int(value) -> int:
    text = str(value or "").strip()
    if not text.isdigit():
        return 0
    return int(text)
