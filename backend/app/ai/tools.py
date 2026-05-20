from __future__ import annotations

from typing import Callable

from app.ai.context import AgentContext
from app.ai.schemas import AgentRunRequest, AgentToolCall
from app.core.enums import AiMode
from app.services import ai as legacy_ai

ToolHandler = Callable[[AgentContext, AgentRunRequest], object]


def _inventory_snapshot(context: AgentContext, request: AgentRunRequest) -> object:
    return {
        "items": legacy_ai._inventory_snapshot(context.inventory_items),
        "alerts": legacy_ai._build_alerts(context.inventory_items),
    }


def _recent_meals(context: AgentContext, request: AgentRunRequest) -> object:
    return {"items": legacy_ai._build_recent_meal_snapshot(context.meal_logs)}


def _food_details(context: AgentContext, request: AgentRunRequest) -> object:
    return {"detail": legacy_ai._build_food_context(context.food)}


def _ingredient_details(context: AgentContext, request: AgentRunRequest) -> object:
    return {"detail": legacy_ai._build_ingredient_context(context.ingredients)}


def _recommendation_candidates(context: AgentContext, request: AgentRunRequest) -> object:
    return {
        "detail": legacy_ai._build_recommendation_context(
            context.recommendation_foods,
            context.inventory_items,
            context.meal_logs,
        )
    }


TOOLS: dict[str, ToolHandler] = {
    "inventory_snapshot": _inventory_snapshot,
    "recent_meals": _recent_meals,
    "food_details": _food_details,
    "ingredient_details": _ingredient_details,
    "recommendation_candidates": _recommendation_candidates,
}


def select_tool_names(request: AgentRunRequest) -> list[str]:
    if request.response_format == "recipe_draft":
        return ["ingredient_details"]
    if request.mode == AiMode.FOOD_QA:
        return ["inventory_snapshot", "recent_meals", "food_details"]
    if request.mode == AiMode.INVENTORY_QA:
        return ["inventory_snapshot", "recent_meals"]
    if request.mode == AiMode.RECOMMENDATION:
        return ["inventory_snapshot", "recent_meals", "recommendation_candidates"]
    if request.mode == AiMode.RECIPE_DRAFT:
        return ["ingredient_details"]
    return ["inventory_snapshot", "recent_meals"]


def run_readonly_tools(context: AgentContext, request: AgentRunRequest) -> list[AgentToolCall]:
    tool_calls: list[AgentToolCall] = []
    for name in select_tool_names(request):
        handler = TOOLS[name]
        try:
            tool_calls.append(AgentToolCall(name=name, input={"familyId": request.family_id}, output=handler(context, request)))
        except Exception as exc:
            tool_calls.append(
                AgentToolCall(name=name, input={"familyId": request.family_id}, status="failed", error=str(exc))
            )
    return tool_calls
