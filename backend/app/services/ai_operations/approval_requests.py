from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.utils import create_id
from app.models.domain import AIApprovalRequest, AITaskDraft
from app.services.ai_operations.approval_config import approval_config_for_payload


def create_ai_draft_approval(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str,
    message_id: str,
    run_id: str | None,
    draft_type: str,
    schema_version: str | None,
    payload: dict[str, Any],
    preview_summary: str,
    ai_metadata: dict[str, Any] | None = None,
) -> tuple[AITaskDraft, AIApprovalRequest]:
    config = approval_config_for_payload(draft_type, payload)
    draft = AITaskDraft(
        id=create_id("ai_draft"),
        family_id=family_id,
        conversation_id=conversation_id,
        source_run_id=run_id,
        message_id=message_id,
        draft_type=draft_type,
        payload=payload,
        preview_summary=preview_summary,
        status="pending",
        version=1,
        schema_version=schema_version or f"{draft_type}.v1",
        validation_errors=[],
        ai_metadata=ai_metadata or {},
        idempotency_key=f"{run_id}:{draft_type}:{create_id('idem')}",
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(draft)
    db.flush()
    approval = AIApprovalRequest(
        id=create_id("ai_approval"),
        family_id=family_id,
        conversation_id=conversation_id,
        message_id=message_id,
        run_id=run_id,
        draft_id=draft.id,
        draft_version=draft.version,
        draft_schema_version=draft.schema_version,
        approval_type=config["approval_type"],
        status="pending",
        request_payload={
            "title": config["title"],
            "instruction": config["instruction"],
            "approveLabel": config["approve_label"],
            "rejectLabel": config["reject_label"],
            "requireRejectComment": False,
        },
        field_schema=[
            {"name": config["value_key"], "label": "草稿内容", "type": "object", "widget": config["widget"], "required": True}
        ],
        initial_values={config["value_key"]: payload},
        submitted_values={},
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(approval)
    db.flush()
    return draft, approval


def create_retry_ai_approval(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str,
    message_id: str | None,
    run_id: str | None,
    draft: AITaskDraft,
    values: dict[str, Any],
    error_message: str,
    failure_summary: dict[str, Any] | None = None,
) -> AIApprovalRequest:
    retry_instruction = f"上次写入失败：{error_message}。你可以调整草稿后重试。"
    if failure_summary and failure_summary.get("failedOperationSummaries"):
        first = failure_summary["failedOperationSummaries"][0]
        retry_instruction = (
            f"上次写入失败：{error_message}。"
            f"失败项：{first.get('summary') or first.get('operationId') or '未识别操作'}。"
            "你可以调整草稿后重试。"
        )
    config = approval_config_for_payload(draft.draft_type, draft.payload)
    approval = AIApprovalRequest(
        id=create_id("ai_approval"),
        family_id=family_id,
        conversation_id=conversation_id,
        message_id=message_id,
        run_id=run_id,
        draft_id=draft.id,
        draft_version=draft.version,
        draft_schema_version=draft.schema_version,
        approval_type=f"{config['approval_type']}.retry",
        status="pending",
        request_payload={
            "title": f"重试{config['title'].replace('确认', '')}",
            "instruction": retry_instruction,
            "approveLabel": "重试写入",
            "rejectLabel": "放弃草稿",
            "requireRejectComment": False,
            "failureSummary": failure_summary or {"errorMessage": error_message},
        },
        field_schema=[
            {
                "name": config["value_key"],
                "label": "草稿内容",
                "type": "object",
                "widget": config["widget"],
                "required": True,
            }
        ],
        initial_values=values,
        submitted_values={},
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(approval)
    db.flush()
    return approval
