from __future__ import annotations

import json

from langgraph.graph import END, START, StateGraph
from sqlalchemy.orm import Session

from app.ai.context import load_agent_context
from app.ai.provider import BaseChatProvider
from app.ai.recipe_drafts import (
    build_fallback_recipe_draft,
    build_recipe_draft_messages,
    build_recipe_image_render_payload,
    normalize_recipe_draft,
)
from app.ai.schemas import AgentState
from app.ai.tools import run_readonly_tools
from app.core.enums import AiMode
from app.services import ai as legacy_ai


def _format_tool_outputs(state: AgentState) -> str:
    records = [item.to_record() for item in state.get("tool_calls", [])]
    return json.dumps(records, ensure_ascii=False, default=str)


def _build_messages(state: AgentState) -> tuple[str, str]:
    request = state["request"]
    context = state["context"]
    if request.response_format == "recipe_draft":
        return build_recipe_draft_messages(context, request)
    messages = legacy_ai._build_provider_messages(
        family=context.family,
        mode=request.mode or AiMode.INVENTORY_QA,
        prompt=request.prompt,
        inventory_items=context.inventory_items,
        meal_logs=context.meal_logs,
        food=context.food,
        ingredients=context.ingredients,
        recommendation=state.get("recommendation_model"),
        recommendation_foods=context.recommendation_foods if request.mode == AiMode.RECOMMENDATION else None,
    )
    system = messages[0]["content"]
    user = messages[1]["content"] + "\n\n只读工具结果：\n" + _format_tool_outputs(state)
    return system, user


def _fallback_text(state: AgentState) -> str:
    request = state["request"]
    context = state["context"]
    if request.response_format == "recipe_draft":
        return "已生成可编辑的菜谱草稿。"
    if request.mode == AiMode.FOOD_QA:
        return legacy_ai._build_food_answer(context.food, request.prompt)
    if request.mode == AiMode.INVENTORY_QA:
        return legacy_ai._build_inventory_answer(context.inventory_items)
    if request.mode == AiMode.RECOMMENDATION:
        recommendation = state.get("recommendation_model")
        return (
            f"{recommendation.title}。{recommendation.detail}"
            if recommendation
            else "先补齐常用食材后，系统会给出更准确的推荐。"
        )
    if request.mode == AiMode.RECIPE_DRAFT:
        return legacy_ai._format_recipe_draft_response(state.get("recipe_draft"), request.prompt)
    return "当前 AI 模式尚未配置。"


def build_kitchen_assistant_graph(db: Session, provider: BaseChatProvider):
    def load_context_node(state: AgentState) -> AgentState:
        request = state["request"]
        context = load_agent_context(db, family_id=request.family_id, mode=request.mode, subject=request.subject)
        recommendation_model = None
        if request.mode == AiMode.RECOMMENDATION:
            recommendation_model = legacy_ai._pick_recommendation(
                request.family_id,
                context.recommendation_foods,
                context.inventory_items,
                context.meal_logs,
            )
            db.add(recommendation_model)
        recipe_draft = (
            legacy_ai._build_recipe_draft_payload(context.ingredients, request.prompt)
            if request.mode == AiMode.RECIPE_DRAFT
            else None
        )
        return {"context": context, "recommendation_model": recommendation_model, "recipe_draft": recipe_draft}

    def tool_node(state: AgentState) -> AgentState:
        return {"tool_calls": run_readonly_tools(state["context"], state["request"])}

    def agent_node(state: AgentState) -> AgentState:
        system, user = _build_messages(state)
        result = provider.generate(system=system, user=user)
        return {
            "text": result.text or "",
            "status": result.status,
            "error": result.error,
            "model": result.model,
        }

    def finalize_node(state: AgentState) -> AgentState:
        request = state["request"]
        text = (state.get("text") or "").strip()
        status = state.get("status") or "fallback"
        error = state.get("error")
        if request.response_format == "recipe_draft":
            if text and status == "completed":
                recipe_draft = normalize_recipe_draft(text, state["context"], request)
                if recipe_draft is None:
                    recipe_draft = build_fallback_recipe_draft(state["context"], request)
                    status = "failed"
                    error = error or "model returned invalid recipe draft JSON"
                    image_render_payload = None
                else:
                    image_render_payload = build_recipe_image_render_payload(recipe_draft)
            else:
                recipe_draft = build_fallback_recipe_draft(state["context"], request)
                status = "failed"
                error = error or "AI recipe draft provider is unavailable"
                image_render_payload = None
            return {
                "text": "AI 菜谱生成失败，请稍后重试。" if status == "failed" else "已生成可编辑的菜谱草稿。",
                "status": status,
                "error": error,
                "recipe_draft": recipe_draft,
                "data": {
                    "recipeDraft": recipe_draft,
                    "imageRenderPayload": image_render_payload,
                },
            }
        if not text:
            text = _fallback_text(state)
            status = "fallback"
        recommendation = state.get("recommendation_model")
        if request.mode == AiMode.RECOMMENDATION and recommendation is not None and status == "completed":
            provider_detail = text.strip()
            if provider_detail.startswith(recommendation.title):
                provider_detail = provider_detail[len(recommendation.title) :].lstrip("：:，。 ")
            recommendation.detail = provider_detail or recommendation.detail
            text = f"{recommendation.title}。{recommendation.detail}"
        return {"text": text, "status": status}

    workflow = StateGraph(AgentState)
    workflow.add_node("load_context", load_context_node)
    workflow.add_node("tools", tool_node)
    workflow.add_node("agent", agent_node)
    workflow.add_node("finalize", finalize_node)
    workflow.add_edge(START, "load_context")
    workflow.add_edge("load_context", "tools")
    workflow.add_edge("tools", "agent")
    workflow.add_edge("agent", "finalize")
    workflow.add_edge("finalize", END)
    return workflow.compile()
