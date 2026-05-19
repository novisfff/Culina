from __future__ import annotations

from time import perf_counter

from sqlalchemy.orm import Session

from app.ai.graphs import build_kitchen_assistant_graph
from app.ai.provider import BaseChatProvider, get_chat_provider
from app.ai.schemas import AgentRunRequest, AgentRunResult
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation
from app.services.serializers import serialize_ai_conversation, serialize_ai_recommendation


class CulinaAgentService:
    def __init__(self, db: Session, *, provider: BaseChatProvider | None = None) -> None:
        self.db = db
        self.provider = provider or get_chat_provider()

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        started = perf_counter()
        graph = build_kitchen_assistant_graph(self.db, self.provider)
        state = graph.invoke({"request": request})
        duration_ms = int((perf_counter() - started) * 1000)

        text = state.get("text", "")
        status = state.get("status", "fallback")
        error = state.get("error")
        model = state.get("model", getattr(self.provider, "model_name", ""))
        tool_calls = state.get("tool_calls", [])
        context = state.get("context")
        recipe_draft = state.get("recipe_draft")
        recommendation_model = state.get("recommendation_model")

        run = AIAgentRun(
            id=create_id("agent_run"),
            family_id=request.family_id,
            agent_key=request.agent_key,
            feature_key=request.feature_key,
            status=status,
            model=model or "",
            input={
                "prompt": request.prompt,
                "mode": request.mode.value if request.mode else None,
                "subject": request.subject,
                "responseFormat": request.response_format,
                "context": context.to_record() if context else {},
            },
            output={"text": text, "data": {"recipeDraft": recipe_draft}},
            tool_calls=[item.to_record() for item in tool_calls],
            error=error,
            duration_ms=duration_ms,
            created_at=utcnow(),
            created_by=request.user_id,
        )
        self.db.add(run)

        conversation = None
        if request.persist_conversation and request.mode is not None:
            conversation_model = AIConversation(
                id=create_id("conversation"),
                family_id=request.family_id,
                mode=request.mode,
                prompt=request.prompt or request.mode.value,
                response=text,
                context={
                    **request.subject,
                    "recipeDraft": recipe_draft,
                    "agentRunId": run.id,
                    "agentKey": request.agent_key,
                    "status": status,
                },
                created_at=utcnow(),
                created_by=request.user_id,
            )
            self.db.add(conversation_model)
            self.db.flush()
            conversation = serialize_ai_conversation(conversation_model)
        else:
            self.db.flush()

        return AgentRunResult(
            text=text,
            data={"recipeDraft": recipe_draft},
            conversation=conversation,
            recommendation=serialize_ai_recommendation(recommendation_model) if recommendation_model else None,
            run_id=run.id,
            status=status,
            error=error,
        )
