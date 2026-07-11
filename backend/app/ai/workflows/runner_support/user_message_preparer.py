from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.ai.workflows.conversations import (
    find_active_conversation_run,
    find_idempotent_run,
    get_or_create_conversation,
    normalize_workspace_subject,
)
from app.ai.workflows.runner_support.attachments import (
    attachment_summaries,
    build_user_message_parts,
)
from app.ai.workflows.timeline import build_planner_conversation
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIMessage, MediaAsset

logger = logging.getLogger("app.ai.workflows.runner")


@dataclass
class PreparedUserMessage:
    existing: bool
    conversation_id: str
    run_id: str
    user_message_id: str | None
    subject: dict[str, Any]
    attachments: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class UserMessagePreparer:
    def __init__(
        self,
        *,
        db: Session,
        provider: Any,
        json_record: Callable[[Any], Any],
    ) -> None:
        self.db = db
        self.provider = provider
        self.json_record = json_record

    def prepare(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str | None,
        prompt: str,
        message_summary: str,
        client_message_id: str | None,
        client_run_id: str | None,
        quick_task: str | None,
        subject: dict[str, Any] | None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> PreparedUserMessage:
        normalized_subject = normalize_workspace_subject(self.db, family_id=family_id, subject=subject)
        existing = find_idempotent_run(
            self.db,
            family_id=family_id,
            user_id=user_id,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
        )
        if existing is not None:
            return self._prepared_existing_run(existing, normalized_subject)

        conversation = get_or_create_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=message_summary,
            quick_task=quick_task,
        )
        active_run = find_active_conversation_run(
            self.db,
            family_id=family_id,
            conversation_id=conversation.id,
        )
        if active_run is not None:
            raise AIConflictError("当前会话已有 AI 任务正在处理中，请稍后再发送。")

        attachment_assets = self._load_attachment_assets(family_id=family_id, attachments=attachments or [])
        user_attachment_summaries = attachment_summaries(attachment_assets)
        user_message = self._create_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation.id,
            prompt=prompt,
            message_summary=message_summary,
            client_message_id=client_message_id,
            attachment_assets=attachment_assets,
        )
        self._bind_attachments_to_message(attachment_assets, user_message.id)
        run = self._create_agent_run(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            prompt=prompt,
            message_summary=message_summary,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=normalized_subject,
            attachments=user_attachment_summaries,
        )
        conversation.prompt = message_summary
        conversation.last_message_at = utcnow()
        conversation.last_run_status = "running"
        conversation.context = self.json_record({
            **(conversation.context or {}),
            "activeRunId": run.id,
        })
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = find_idempotent_run(
                self.db,
                family_id=family_id,
                user_id=user_id,
                client_message_id=client_message_id,
                client_run_id=client_run_id,
            )
            if existing is None:
                raise
            return self._prepared_existing_run(existing, normalized_subject)
        logger.info(
            "AI run prepared run_id=%s conversation_id=%s family_id=%s user_id=%s client_message_id=%s",
            run.id,
            conversation.id,
            family_id,
            user_id,
            client_message_id,
        )
        return PreparedUserMessage(
            existing=False,
            conversation_id=conversation.id,
            run_id=run.id,
            user_message_id=user_message.id,
            subject=normalized_subject,
            attachments=user_attachment_summaries,
        )

    def _prepared_existing_run(self, run: AIAgentRun, subject: dict[str, Any]) -> PreparedUserMessage:
        if run.status in {"pending", "running"}:
            raise AIConflictError("该消息正在处理中")
        if not run.conversation_id:
            raise AIConflictError("已有运行缺少会话，不能重复执行")
        assistant_message = self.db.scalar(
            select(AIMessage.id).where(
                AIMessage.family_id == run.family_id,
                AIMessage.run_id == run.id,
                AIMessage.role == "assistant",
            )
        )
        if assistant_message is None:
            raise AIConflictError("该消息已处理，但没有可复用的回复")
        return PreparedUserMessage(
            existing=True,
            conversation_id=run.conversation_id,
            run_id=run.id,
            user_message_id=run.message_id,
            subject=subject,
            attachments=[],
        )

    def _load_attachment_assets(
        self,
        *,
        family_id: str,
        attachments: list[dict[str, Any]],
    ) -> list[MediaAsset]:
        if not attachments:
            return []
        media_ids = [str(item["media_id"]) for item in attachments]
        assets = list(
            self.db.scalars(
                select(MediaAsset).where(
                    MediaAsset.family_id == family_id,
                    MediaAsset.id.in_(media_ids),
                )
            )
        )
        assets_by_id = {asset.id: asset for asset in assets}
        missing_ids = [media_id for media_id in media_ids if media_id not in assets_by_id]
        if missing_ids:
            raise LookupError("图片附件不存在或不属于当前家庭")

        ordered_assets = [assets_by_id[media_id] for media_id in media_ids]
        already_bound = [asset for asset in ordered_assets if asset.entity_type or asset.entity_id]
        if already_bound:
            raise ValueError("已绑定到业务对象的图片暂不能作为 AI 附件发送")
        return ordered_assets

    def _create_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        prompt: str,
        message_summary: str,
        client_message_id: str | None,
        attachment_assets: list[MediaAsset],
    ) -> AIMessage:
        user_message_parts = build_user_message_parts(prompt, attachment_assets)
        user_message = AIMessage(
            id=create_id("ai_message"),
            family_id=family_id,
            conversation_id=conversation_id,
            role="user",
            content=message_summary,
            content_type="parts" if attachment_assets else "text",
            parts=self.json_record(user_message_parts),
            status="completed",
            client_message_id=client_message_id,
            created_by=user_id,
        )
        self.db.add(user_message)
        self.db.flush()
        return user_message

    def _bind_attachments_to_message(self, attachment_assets: list[MediaAsset], message_id: str) -> None:
        for asset in attachment_assets:
            asset.entity_type = "ai_message"
            asset.entity_id = message_id
        if attachment_assets:
            self.db.flush()

    def _create_agent_run(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        user_message_id: str,
        prompt: str,
        message_summary: str,
        client_run_id: str | None,
        quick_task: str | None,
        subject: dict[str, Any],
        attachments: list[dict[str, Any]],
    ) -> AIAgentRun:
        timeline = build_planner_conversation(
            self.db,
            family_id=family_id,
            conversation_id=conversation_id,
            quick_task=quick_task,
        )
        run = AIAgentRun(
            id=client_run_id or create_id("agent_run"),
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=user_message_id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=message_summary[:255],
            context_summary={"graph": {"runtime": "langgraph", "threadId": conversation_id}},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={
                "prompt": prompt,
                "attachments": attachments,
                "quickTask": quick_task,
                "subject": subject,
                "conversation": timeline,
            },
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=user_id,
        )
        self.db.add(run)
        return run
