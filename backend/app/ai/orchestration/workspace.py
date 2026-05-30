from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.ai.agents.workspace import WorkspaceAgentInput, WorkspaceAgentOutput
from app.ai.runtime.provider import BaseChatProvider
from app.ai.runtime.registry import AgentRegistry, ToolRegistry


INTENT_CONFIG = {
    "today_recommendation": {
        "agent_key": "today_recommendation_agent",
        "required_context": ["inventory", "meal_logs", "recipes"],
        "output_type": "recommendation",
        "requires_confirmation": False,
    },
    "fallback_chat": {
        "agent_key": "fallback_chat_agent",
        "required_context": [],
        "output_type": "answer",
        "requires_confirmation": False,
    },
    "recipe_draft": {
        "agent_key": "recipe_draft_agent",
        "required_context": ["ingredients", "recipes"],
        "output_type": "draft",
        "requires_confirmation": True,
    },
}


@dataclass(slots=True)
class OrchestratorRequest:
    family_id: str
    user_id: str
    prompt: str
    quick_task: str | None = None
    subject: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class OrchestratorResult:
    intent: str
    agent_key: str
    output: WorkspaceAgentOutput


class WorkspaceOrchestrator:
    def __init__(
        self,
        db: Session,
        *,
        agent_registry: AgentRegistry,
        tool_registry: ToolRegistry,
        provider: BaseChatProvider | None = None,
    ) -> None:
        self.db = db
        self.agent_registry = agent_registry
        self.tool_registry = tool_registry
        self.provider = provider

    def run(self, request: OrchestratorRequest) -> OrchestratorResult:
        intent = self._detect_intent(request)
        config = INTENT_CONFIG[intent]
        definition = self.agent_registry.get(config["agent_key"])
        output = definition.handler(
            self.db,
            WorkspaceAgentInput(
                family_id=request.family_id,
                user_id=request.user_id,
                prompt=request.prompt,
                intent=intent,
                subject=request.subject,
                tool_registry=self.tool_registry,
                provider=self.provider,
            ),
        )
        return OrchestratorResult(intent=intent, agent_key=definition.key, output=output)

    def _detect_intent(self, request: OrchestratorRequest) -> str:
        quick_task = (request.quick_task or "").strip()
        prompt = request.prompt.strip().lower()
        if quick_task == "today_recommendation":
            return "today_recommendation"
        if quick_task == "recipe_draft":
            return "recipe_draft"
        recipe_keywords = [
            "生成菜谱",
            "菜谱草稿",
            "一份菜谱",
            "做法",
            "怎么做",
            "教我做",
            "帮我做",
            "帮我生成",
            "补全菜谱",
        ]
        if any(keyword in prompt for keyword in recipe_keywords):
            return "recipe_draft"
        today_keywords = ["今日吃什么", "今天吃什么", "今晚吃什么", "推荐", "吃点什么", "做点什么"]
        if any(keyword in prompt for keyword in today_keywords):
            return "today_recommendation"
        return "fallback_chat"
