from __future__ import annotations

from app.ai.skills.base import SkillContext
from app.ai.workflows.orchestrator.state import OrchestratorRunState


def emit_visible_delta(context: SkillContext, state: OrchestratorRunState, delta: str) -> None:
    context.ensure_active()
    if context.stream_writer is None or not delta or state.draft_created_this_call:
        return
    context.stream_writer(
        {
            "event": "message_delta",
            "data": {
                "message_id": state.message_id,
                "conversation_id": context.conversation_id,
                "run_id": context.run_id,
                "part_id": state.part_id,
                "delta": delta,
            },
        }
    )
