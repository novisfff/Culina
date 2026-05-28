from __future__ import annotations

from sqlalchemy.orm import Session

from app.ai.kitchen.graph import build_kitchen_assistant_graph
from app.ai.runtime.provider import BaseChatProvider
from app.ai.runtime.runner import AgentRuntime
from app.ai.runtime.schemas import AgentRunRequest, AgentRunResult
from app.core.enums import AiMode
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation
from app.services.serializers import serialize_ai_conversation, serialize_ai_recommendation


class CulinaAgentService:
    def __init__(self, db: Session, *, provider: BaseChatProvider | None = None) -> None:
        self.db = db
        self.runtime = AgentRuntime(provider=provider)

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        execution = self.runtime.run(self.db, request, build_kitchen_assistant_graph)
        state = execution.state

        text = state.get("text", "")
        status = state.get("status", "fallback")
        error = state.get("error")
        model = state.get("model", getattr(self.runtime.provider, "model_name", ""))
        tool_calls = state.get("tool_calls", [])
        context = state.get("context")
        recipe_draft = state.get("recipe_draft")
        data = state.get("data") or {"recipeDraft": recipe_draft}
        recommendation_model = state.get("recommendation_model")
        if recommendation_model is not None:
            self.db.add(recommendation_model)

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
            output={"text": text, "data": data},
            tool_calls=[item.to_record() for item in tool_calls],
            error=error,
            duration_ms=execution.duration_ms,
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
            data=data,
            conversation=conversation,
            recommendation=serialize_ai_recommendation(recommendation_model) if recommendation_model else None,
            run_id=run.id,
            status=status,
            error=error,
        )


def run_ai_query(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    mode: AiMode,
    prompt: str,
    food_id: str | None = None,
    ingredient_ids: list[str] | None = None,
) -> tuple[dict, dict | None]:
    result = CulinaAgentService(db).run(
        AgentRunRequest(
            family_id=family_id,
            user_id=user_id,
            feature_key=mode.value,
            prompt=prompt,
            mode=mode,
            subject={"foodId": food_id, "ingredientIds": ingredient_ids or []},
            persist_conversation=True,
        )
    )
    if result.conversation is None:
        raise RuntimeError("AI query did not produce a conversation")
    return result.conversation, result.recommendation
