from __future__ import annotations

from typing import Any, TypedDict


class WorkspaceGraphState(TypedDict, total=False):
    family_id: str
    user_id: str
    conversation_id: str
    message: str
    current_message_attachments: list[dict[str, Any]]
    generation_contracts: list[str]
    client_message_id: str | None
    client_run_id: str | None
    quick_task: str | None
    subject: dict[str, Any]
    orchestrator_profile: dict[str, Any]
    run_id: str
    user_message_id: str
    run_artifacts: list[dict[str, Any]]
    injected_skill_keys: list[str]
    injection_history: list[dict[str, Any]]
    agent_rounds: int
    pending_human_input: dict[str, Any]
    pending_approval_id: str
    last_human_input_result: dict[str, Any]
    status: str
    error: str | None
    last_decision: dict[str, Any]
