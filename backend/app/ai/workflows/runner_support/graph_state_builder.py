from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.ai.workflows.runner_support.run_status import RUNNING

if TYPE_CHECKING:
    from app.ai.workflows.orchestrator.profiles import OrchestratorProfile


class GraphStateBuilder:
    def build_initial_state(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        prompt: str,
        attachments: list[dict[str, Any]],
        client_message_id: str | None,
        client_run_id: str | None,
        quick_task: str | None,
        subject: dict[str, Any],
        orchestrator_profile: OrchestratorProfile,
        initial_skill_keys: list[str],
        run_id: str,
        user_message_id: str,
    ) -> dict[str, Any]:
        return {
            "family_id": family_id,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "message": prompt,
            "current_message_attachments": attachments,
            "client_message_id": client_message_id,
            "client_run_id": client_run_id,
            "quick_task": quick_task,
            "subject": subject,
            "orchestrator_profile": orchestrator_profile.to_state(),
            "run_artifacts": [],
            "injected_skill_keys": initial_skill_keys,
            "injection_history": [],
            "agent_rounds": 0,
            "pending_human_input": {},
            "pending_approval_id": "",
            "last_human_input_result": {},
            "status": RUNNING,
            "error": None,
            "run_id": run_id,
            "user_message_id": user_message_id,
        }

    def build_human_input_resume_payload(
        self,
        *,
        request_id: str,
        selected_option_ids: list[str],
        text: str | None,
        user_id: str,
        family_id: str,
    ) -> dict[str, Any]:
        return {
            "requestId": request_id,
            "selectedOptionIds": selected_option_ids,
            "text": text or "",
            "userId": user_id,
            "familyId": family_id,
        }

    def build_approval_resume_payload(
        self,
        *,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None,
        user_id: str,
        family_id: str,
    ) -> dict[str, Any]:
        return {
            "approvalId": approval_id,
            "decision": decision,
            "draftVersion": draft_version,
            "values": values,
            "comment": comment,
            "userId": user_id,
            "familyId": family_id,
        }

