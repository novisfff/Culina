from __future__ import annotations

from typing import Any

from app.core.utils import create_id


RESULT_CARD_DEFAULT_TITLES = {
    "today_recommendation": "今日吃什么",
    "recipe_draft": "菜谱草稿",
    "approval_request": "确认请求",
    "error_recovery": "这次没有生成成功",
    "inventory_summary": "库存概览",
    "clarification_request": "还需要你确认一下",
    "meal_plan_draft": "餐食计划草稿",
    "shopping_list_draft": "购物清单草稿",
    "meal_log_draft": "餐食记录草稿",
    "food_profile_draft": "食物资料草稿",
}


def normalize_result_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        next_card = dict(card)
        card_type = str(next_card.get("type") or "inventory_summary")
        if not isinstance(next_card.get("id"), str) or not next_card["id"].strip():
            next_card["id"] = create_id("ai_card")
        if not isinstance(next_card.get("title"), str) or not next_card["title"].strip():
            next_card["title"] = RESULT_CARD_DEFAULT_TITLES.get(card_type, "AI 结果")
        if not isinstance(next_card.get("data"), dict):
            next_card["data"] = {}
        normalized.append(next_card)
    return normalized
