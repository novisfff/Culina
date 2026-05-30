from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import RECIPE_DRAFT_JSON_SCHEMA, build_recipe_draft_messages, normalize_recipe_draft
from app.ai.runtime.provider import BaseChatProvider
from app.ai.runtime.registry import AgentDefinition, AgentRegistry
from app.ai.runtime.schemas import AgentRunRequest
from app.core.enums import AiMode
from app.models.domain import Food, InventoryItem, MealLog, Recipe


@dataclass(slots=True)
class WorkspaceAgentInput:
    family_id: str
    user_id: str
    prompt: str
    intent: str
    slots: dict[str, Any] = field(default_factory=dict)
    subject: dict[str, Any] = field(default_factory=dict)
    tool_registry: Any = None
    provider: BaseChatProvider | None = None


@dataclass(slots=True)
class WorkspaceAgentOutput:
    text: str
    cards: list[dict[str, Any]] = field(default_factory=list)
    drafts: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    context_summary: dict[str, Any] = field(default_factory=dict)
    status: str = "completed"
    model: str = "rules"
    error: str | None = None


def _remaining_quantity(item: InventoryItem) -> Decimal:
    return max(Decimal(item.quantity or 0) - Decimal(item.consumed_quantity or 0), Decimal("0"))


def today_recommendation_agent(db: Session, request: WorkspaceAgentInput) -> WorkspaceAgentOutput:
    today = date.today()
    inventory_items = list(
        db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(InventoryItem.family_id == request.family_id)
            .limit(50)
        )
    )
    available_items = [item for item in inventory_items if _remaining_quantity(item) > 0]
    expiring_items = sorted(
        [item for item in available_items if item.expiry_date is not None],
        key=lambda item: item.expiry_date or today,
    )[:5]
    foods = list(db.scalars(select(Food).where(Food.family_id == request.family_id).limit(12)))
    recipes = list(db.scalars(select(Recipe).where(Recipe.family_id == request.family_id).limit(12)))
    recent_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == request.family_id)
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
            .limit(5)
        )
    )

    evidence = [
        {
            "type": "inventory_item",
            "id": item.id,
            "label": item.ingredient.name if item.ingredient else item.ingredient_id,
            "status": "expiring" if item.expiry_date and (item.expiry_date - today).days <= 7 else "available",
            "detail": f"{float(_remaining_quantity(item)):g}{item.unit}",
        }
        for item in (expiring_items or available_items[:3])
    ]
    ingredient_names = [item["label"] for item in evidence]
    candidates = [food.name for food in foods[:3]] or [recipe.title for recipe in recipes[:3]]
    if not candidates and ingredient_names:
        candidates = [f"{ingredient_names[0]}快手菜"]
    if not candidates:
        candidates = ["清爽家常菜"]

    recommendations = []
    for index, title in enumerate(candidates[:3]):
        reason_bits = []
        if ingredient_names:
            reason_bits.append(f"可优先使用 {', '.join(ingredient_names[:2])}")
        if recent_logs:
            reason_bits.append("参考了最近餐食，尽量避免重复")
        reason = "，".join(reason_bits) or "适合作为今天的一餐，准备成本低。"
        recommendations.append(
            {
                "title": title,
                "reason": reason,
                "evidence": evidence[:2] if index == 0 else evidence[:1],
            }
        )

    text = "我按当前库存和最近餐食整理了今天的建议。"
    if expiring_items:
        text += " 其中临期食材优先级最高。"
    card = {
        "id": "today-recommendation",
        "type": "today_recommendation",
        "title": "今日吃什么",
        "data": {
            "recommendations": recommendations,
            "contextSummary": {
                "inventoryCount": len(available_items),
                "expiringCount": len(expiring_items),
                "recentMealCount": len(recent_logs),
                "recipeCount": len(recipes),
            },
        },
    }
    return WorkspaceAgentOutput(
        text=text,
        cards=[card],
        tool_calls=[
            {"name": "inventory.read_summary", "status": "completed", "output": {"availableCount": len(available_items)}},
            {"name": "inventory.read_expiring_items", "status": "completed", "output": {"count": len(expiring_items)}},
            {"name": "meal_log.read_recent", "status": "completed", "output": {"count": len(recent_logs)}},
            {"name": "recipe.search_available", "status": "completed", "output": {"count": len(recipes)}},
        ],
        context_summary={
            "inventoryItemCount": len(available_items),
            "expiringItemCount": len(expiring_items),
            "recentMealCount": len(recent_logs),
            "recipeCount": len(recipes),
        },
    )


def fallback_chat_agent(db: Session, request: WorkspaceAgentInput) -> WorkspaceAgentOutput:
    del db
    provider = request.provider
    if provider is not None:
        result = provider.generate(
            system="你是 Culina 的厨房助手。只能基于用户当前家庭厨房上下文给出简短、可执行的建议；不能承诺写入系统数据。",
            user=request.prompt,
        )
        if result.text:
            return WorkspaceAgentOutput(text=result.text, model=result.model, status="completed")

    return WorkspaceAgentOutput(
        text="我可以先帮你做轻量分析。当前 1A 阶段已经支持“今日吃什么”这类结构化建议；涉及创建菜谱、购物清单或餐食计划的写入，会在下一阶段通过草稿确认来完成。",
        model=getattr(provider, "model_name", "rules") if provider else "rules",
    )


def recipe_draft_agent(db: Session, request: WorkspaceAgentInput) -> WorkspaceAgentOutput:
    provider = request.provider
    subject = dict(request.subject or {})
    if "title" not in subject:
        subject["title"] = _infer_recipe_title(request.prompt)
    if "servings" not in subject:
        subject["servings"] = request.slots.get("servings") or 2

    agent_request = AgentRunRequest(
        family_id=request.family_id,
        user_id=request.user_id,
        feature_key="ai_workspace_recipe_draft",
        prompt=request.prompt,
        mode=AiMode.RECIPE_DRAFT,
        subject=subject,
        response_format="recipe_draft",
        persist_conversation=False,
    )
    context = load_agent_context(
        db,
        family_id=request.family_id,
        mode=AiMode.RECIPE_DRAFT,
        subject=subject,
        include_inventory=False,
        include_meal_logs=False,
    )
    if provider is None:
        return WorkspaceAgentOutput(
            text="现在还不能生成菜谱草稿：AI provider 未配置。",
            status="failed",
            model="rules",
            error="AI provider 未配置",
            context_summary=context.to_record(),
        )

    system, user = build_recipe_draft_messages(context, agent_request)
    result = provider.generate(system=system, user=user, response_schema=RECIPE_DRAFT_JSON_SCHEMA)
    if not result.text:
        return WorkspaceAgentOutput(
            text="这次没有生成可用的菜谱草稿。",
            status="failed",
            model=result.model,
            error=result.error or "provider returned no structured recipe draft",
            context_summary=context.to_record(),
            tool_calls=[{"name": "recipe.create_draft", "status": "failed", "error": result.error}],
        )

    draft = normalize_recipe_draft(result.text, context, agent_request)
    if draft is None:
        return WorkspaceAgentOutput(
            text="模型返回的菜谱结构不完整，我没有把它保存成草稿。",
            status="failed",
            model=result.model,
            error="invalid recipe draft json",
            context_summary=context.to_record(),
            tool_calls=[{"name": "recipe.create_draft", "status": "failed", "error": "invalid recipe draft json"}],
        )

    title = draft.get("title", "菜谱草稿")
    ingredient_count = len(draft.get("ingredient_items", []))
    step_count = len(draft.get("steps", []))
    return WorkspaceAgentOutput(
        text=f"我生成了《{title}》的菜谱草稿，包含 {ingredient_count} 个食材项和 {step_count} 个步骤。你可以先编辑，再确认创建菜谱。",
        drafts=[{"draft_type": "recipe", "payload": draft, "schema_version": "recipe.v1"}],
        tool_calls=[{"name": "recipe.create_draft", "status": "completed", "output": {"title": title}}],
        context_summary=context.to_record(),
        status="completed",
        model=result.model,
    )


def _infer_recipe_title(prompt: str) -> str:
    text = prompt.strip()
    for prefix in ["帮我生成一份", "帮我生成", "生成一份", "生成", "做一份", "做"]:
        if text.startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    for suffix in ["的菜谱", "菜谱", "，", ",", "。"]:
        if suffix in text:
            text = text.split(suffix, 1)[0].strip()
    return text[:40]


def build_agent_registry() -> AgentRegistry:
    registry = AgentRegistry()
    registry.register(
        AgentDefinition(
            key="today_recommendation_agent",
            name="今日推荐智能体",
            description="根据库存、临期食材、最近餐食和菜谱生成今日推荐卡片。",
            supported_intents=["today_recommendation"],
            output_schema={"cards": ["today_recommendation"]},
            handler=today_recommendation_agent,
            requires_confirmation=False,
        )
    )
    registry.register(
        AgentDefinition(
            key="recipe_draft_agent",
            name="菜谱草稿智能体",
            description="生成可编辑、可确认的结构化菜谱草稿。",
            supported_intents=["recipe_draft"],
            output_schema={"cards": ["recipe_draft"], "drafts": ["recipe"]},
            handler=recipe_draft_agent,
            requires_confirmation=True,
        )
    )
    registry.register(
        AgentDefinition(
            key="fallback_chat_agent",
            name="兜底聊天智能体",
            description="处理暂不支持或无法识别的问题，并返回可恢复说明。",
            supported_intents=["fallback_chat"],
            output_schema={"cards": ["error_recovery"]},
            handler=fallback_chat_agent,
            requires_confirmation=False,
        )
    )
    return registry
