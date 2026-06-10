from __future__ import annotations

from typing import Any, TypedDict


class WorkspaceGraphState(TypedDict, total=False):
    family_id: str
    user_id: str
    conversation_id: str
    message: str
    client_message_id: str | None
    client_run_id: str | None
    quick_task: str | None
    subject: dict[str, Any]
    preplanned_plan: dict[str, Any]
    general_text: str
    run_id: str
    user_message_id: str
    plan: dict[str, Any]
    run_artifacts: list[dict[str, Any]]
    skill_index: int
    status: str
    error: str | None
    last_decision: dict[str, Any]
