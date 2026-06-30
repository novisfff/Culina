from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.models.domain import AIApprovalRequest, AITaskDraft


WORKSPACE_READ_ARTIFACT_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "kind": {"type": ["string", "null"], "enum": ["draft", "approval", None]},
    },
}
WORKSPACE_READ_ARTIFACT_OUTPUT = {
    "type": "object",
    "additionalProperties": True,
    "required": ["artifact"],
    "properties": {
        "artifact": {"type": "object", "additionalProperties": True},
    },
}


def workspace_read_artifact(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    artifact_id = str(payload.get("id") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    if not artifact_id:
        raise ValueError("artifact id 不能为空")
    if kind not in {"", "draft", "approval"}:
        raise ValueError("artifact kind 只能是 draft 或 approval")

    if kind in {"", "draft"}:
        draft = context.db.scalar(
            select(AITaskDraft).where(
                AITaskDraft.family_id == context.family_id,
                AITaskDraft.conversation_id == context.conversation_id,
                AITaskDraft.id == artifact_id,
            )
        )
        if draft is not None:
            return {"artifact": _serialize_draft_artifact(draft)}
        if kind == "draft":
            raise ValueError("草稿不存在或不属于当前会话")

    approval = context.db.scalar(
        select(AIApprovalRequest).where(
            AIApprovalRequest.family_id == context.family_id,
            AIApprovalRequest.conversation_id == context.conversation_id,
            AIApprovalRequest.id == artifact_id,
        )
    )
    if approval is not None:
        return {"artifact": _serialize_approval_artifact(approval)}
    raise ValueError("artifact 不存在或不属于当前会话")


def _serialize_draft_artifact(draft: AITaskDraft) -> dict[str, Any]:
    return {
        "kind": "draft",
        "id": draft.id,
        "conversationId": draft.conversation_id,
        "messageId": draft.message_id,
        "runId": draft.source_run_id,
        "draftType": draft.draft_type,
        "payload": draft.payload,
        "previewSummary": draft.preview_summary,
        "status": draft.status,
        "version": draft.version,
        "schemaVersion": draft.schema_version,
        "validationErrors": draft.validation_errors,
        "metadata": draft.ai_metadata,
        "createdAt": draft.created_at.isoformat() if draft.created_at is not None else None,
        "updatedAt": draft.updated_at.isoformat() if draft.updated_at is not None else None,
    }


def _serialize_approval_artifact(approval: AIApprovalRequest) -> dict[str, Any]:
    request_payload = approval.request_payload or {}
    return {
        "kind": "approval",
        "id": approval.id,
        "conversationId": approval.conversation_id,
        "messageId": approval.message_id,
        "runId": approval.run_id,
        "draftId": approval.draft_id,
        "draftVersion": approval.draft_version,
        "draftSchemaVersion": approval.draft_schema_version,
        "approvalType": approval.approval_type,
        "status": approval.status,
        "title": request_payload.get("title", ""),
        "instruction": request_payload.get("instruction", ""),
        "fieldSchema": approval.field_schema,
        "initialValues": approval.initial_values,
        "submittedValues": approval.submitted_values,
        "decision": approval.decision,
        "comment": approval.comment,
        "resolvedAt": approval.resolved_at.isoformat() if approval.resolved_at is not None else None,
        "createdAt": approval.created_at.isoformat() if approval.created_at is not None else None,
        "updatedAt": approval.updated_at.isoformat() if approval.updated_at is not None else None,
    }


def register_workspace_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="workspace.read_artifact",
        display_name="工作台上下文详情",
        description=(
            "按 ID 读取当前家庭、当前会话中的完整 AI 草稿或审批详情。"
            "默认上下文只提供摘要索引；需要复用历史草稿明细时调用该工具。"
        ),
        side_effect="read",
        handler=workspace_read_artifact,
        input_schema=WORKSPACE_READ_ARTIFACT_INPUT,
        output_schema=WORKSPACE_READ_ARTIFACT_OUTPUT,
        requires_followup=True,
        followup_hint="读取历史 artifact 后必须说明可复用内容、请求补充信息，或继续生成/调整草稿。",
    )
