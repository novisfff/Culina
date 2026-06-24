from __future__ import annotations

from collections.abc import Iterator
import json
import logging
from queue import Queue
from threading import Thread
from time import perf_counter
from typing import TYPE_CHECKING, Any

from fastapi.encoders import jsonable_encoder
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError, AIExecutionCancelled
from app.ai.runtime.provider import ProviderImageInput
from app.ai.skills import SkillContext, SkillResult, build_workspace_skill_registry
from app.ai.skills.shared import result_artifacts
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.conversations import (
    find_active_conversation_run,
    find_idempotent_run,
    get_or_create_conversation,
    normalize_workspace_subject,
    require_conversation,
)
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.result_cards import validate_result_cards
from app.ai.workflows.orchestrator import WorkspaceOrchestratorAgent
from app.ai.workflows.state import WorkspaceGraphState
from app.ai.workflows.timeline import build_planner_conversation
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIRunEvent,
    AITaskDraft,
    MediaAsset,
)
from app.services.media import read_media_object_for_ai
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_run,
    serialize_ai_run_event,
    serialize_ai_task_draft,
    serialize_media,
)

if TYPE_CHECKING:
    from app.ai.workspace_service import AIApplicationService

logger = logging.getLogger(__name__)
_STREAM_DONE = object()

class WorkspaceGraphRunner:
    def __init__(self, service: AIApplicationService) -> None:
        self.service = service
        self.db = service.db
        self.provider = service.provider
        self.skill_registry = build_workspace_skill_registry()
        self.checkpointer = SQLAlchemyCheckpointSaver(self.db)
        self.graph = self._build_graph()
        self._direct_stream_sink: Any = None

    def invoke_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
        client_message_id: str | None = None,
        client_run_id: str | None = None,
        quick_task: str | None = None,
        subject: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        prompt = message.strip()
        normalized_attachments = self._normalize_chat_attachments(attachments)
        if not prompt and not normalized_attachments:
            raise ValueError("消息不能为空")
        message_summary = self._message_summary(prompt, len(normalized_attachments))
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            message_summary=message_summary,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
            attachments=normalized_attachments,
        )
        if prepared["existing"]:
            return self._chat_response(prepared["conversation_id"], prepared["run_id"])
        conversation_id = prepared["conversation_id"]
        config = self._config(conversation_id)
        logger.info(
            "AI graph invoke started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation_id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        output = self.graph.invoke(
            {
                "family_id": family_id,
                "user_id": user_id,
                "conversation_id": conversation_id,
                "message": prompt,
                "current_message_attachments": prepared["attachments"],
                "client_message_id": client_message_id,
                "client_run_id": client_run_id,
                "quick_task": quick_task,
                "subject": prepared["subject"],
                "run_artifacts": [],
                "injected_skill_keys": [],
                "injection_history": [],
                "agent_rounds": 0,
                "pending_human_input": {},
                "pending_approval_id": "",
                "last_human_input_result": {},
                "status": "running",
                "error": None,
                "run_id": prepared["run_id"],
                "user_message_id": prepared["user_message_id"],
            },
            config=config,
            durability="sync",
        )
        run_id = str(output.get("run_id") or "")
        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        logger.info(
            "AI graph invoke completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            run_id,
        )
        return self._chat_response(conversation_id, run_id)

    def stream_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
        client_message_id: str | None = None,
        client_run_id: str | None = None,
        quick_task: str | None = None,
        subject: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        prompt = message.strip()
        normalized_attachments = self._normalize_chat_attachments(attachments)
        if not prompt and not normalized_attachments:
            raise ValueError("消息不能为空")
        message_summary = self._message_summary(prompt, len(normalized_attachments))
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            message_summary=message_summary,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
            attachments=normalized_attachments,
        )
        if prepared["existing"]:
            return iter(
                [
                    (
                        "response",
                        self._chat_response(prepared["conversation_id"], prepared["run_id"]),
                    )
                ]
            )
        return self._stream_prepared_user_message(
            family_id=family_id,
            user_id=user_id,
            prompt=prompt,
            attachments=prepared["attachments"],
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            prepared=prepared,
        )

    def _stream_prepared_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        prompt: str,
        attachments: list[dict[str, Any]],
        client_message_id: str | None,
        client_run_id: str | None,
        quick_task: str | None,
        prepared: dict[str, Any],
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        conversation_id = str(prepared["conversation_id"])
        config = self._config(conversation_id)
        run_id = str(prepared["run_id"])
        seen_event_ids: set[str] = set()
        logger.info(
            "AI graph stream started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation_id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        try:
            def graph_stream() -> Iterator[Any]:
                return self.graph.stream(
                    {
                        "family_id": family_id,
                        "user_id": user_id,
                        "conversation_id": conversation_id,
                        "message": prompt,
                        "current_message_attachments": attachments,
                        "client_message_id": client_message_id,
                        "client_run_id": client_run_id,
                        "quick_task": quick_task,
                        "subject": prepared["subject"],
                        "run_artifacts": [],
                        "injected_skill_keys": [],
                        "injection_history": [],
                        "agent_rounds": 0,
                        "pending_human_input": {},
                        "pending_approval_id": "",
                        "last_human_input_result": {},
                        "status": "running",
                        "error": None,
                        "run_id": run_id,
                        "user_message_id": prepared["user_message_id"],
                    },
                    config=config,
                    stream_mode=["updates", "custom"],
                    durability="sync",
                )

            def handle_update(_update: Any) -> Iterator[tuple[str, dict[str, Any]]]:
                if run_id:
                    yield from self._new_progress_events(run_id, seen_event_ids)

            yield from self._stream_graph_events(
                graph_stream,
                handle_update=handle_update,
                seen_event_ids=seen_event_ids,
                on_disconnect=lambda: self._cancel_after_disconnect(run_id),
            )
        except GeneratorExit:
            self._cancel_after_disconnect(run_id)
            raise
        except Exception as exc:
            self._mark_stream_run_failed(
                run_id=run_id,
                conversation_id=conversation_id,
                family_id=family_id,
                user_id=user_id,
                error=str(exc),
            )
            raise

        if run_id:
            yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph stream completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            run_id,
        )
        yield ("response", self._chat_response(conversation_id, run_id))

    def _prepare_user_message(
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
    ) -> dict[str, Any]:
        normalized_subject = normalize_workspace_subject(self.db, family_id=family_id, subject=subject)
        existing = find_idempotent_run(
            self.db,
            family_id=family_id,
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
        attachment_assets = self._load_ai_message_attachment_assets(family_id=family_id, attachments=attachments or [])
        attachment_summaries = self._attachment_summaries(attachment_assets)
        user_message_parts = self._build_user_message_parts(prompt, attachment_assets)
        user_message = AIMessage(
            id=create_id("ai_message"),
            family_id=family_id,
            conversation_id=conversation.id,
            role="user",
            content=message_summary,
            content_type="parts" if attachment_assets else "text",
            parts=self._json_record(user_message_parts),
            status="completed",
            client_message_id=client_message_id,
            created_by=user_id,
        )
        self.db.add(user_message)
        self.db.flush()
        for asset in attachment_assets:
            asset.entity_type = "ai_message"
            asset.entity_id = user_message.id
        if attachment_assets:
            self.db.flush()
        timeline = build_planner_conversation(
            self.db,
            family_id=family_id,
            conversation_id=conversation.id,
            quick_task=quick_task,
        )
        run = AIAgentRun(
            id=client_run_id or create_id("agent_run"),
            family_id=family_id,
            conversation_id=conversation.id,
            message_id=user_message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=message_summary[:255],
            context_summary={"graph": {"runtime": "langgraph", "threadId": conversation.id}},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={
                "prompt": prompt,
                "attachments": attachment_summaries,
                "quickTask": quick_task,
                "subject": normalized_subject,
                "conversation": timeline,
            },
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=user_id,
        )
        self.db.add(run)
        conversation.prompt = message_summary
        conversation.last_message_at = utcnow()
        conversation.last_run_status = "running"
        conversation.context = self._json_record({
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
        return {
            "existing": False,
            "conversation_id": conversation.id,
            "run_id": run.id,
            "user_message_id": user_message.id,
            "subject": normalized_subject,
            "attachments": attachment_summaries,
        }

    def _prepared_existing_run(self, run: AIAgentRun, subject: dict[str, Any]) -> dict[str, Any]:
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
        return {
            "existing": True,
            "conversation_id": run.conversation_id,
            "run_id": run.id,
            "user_message_id": run.message_id,
            "subject": subject,
        }

    @staticmethod
    def _normalize_chat_attachments(attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        seen_media_ids: set[str] = set()
        for attachment in attachments or []:
            if not isinstance(attachment, dict):
                raise ValueError("附件格式不正确")
            attachment_type = str(attachment.get("type") or "image")
            if attachment_type != "image":
                raise ValueError("当前仅支持图片附件")
            media_id = str(attachment.get("media_id") or attachment.get("mediaId") or "").strip()
            if not media_id:
                raise ValueError("图片附件缺少 media_id")
            if media_id in seen_media_ids:
                continue
            seen_media_ids.add(media_id)
            normalized.append(
                {
                    "type": "image",
                    "media_id": media_id,
                    "client_attachment_id": str(
                        attachment.get("client_attachment_id") or attachment.get("clientAttachmentId") or ""
                    ).strip()
                    or None,
                }
            )
        if len(normalized) > 6:
            raise ValueError("单次最多上传 6 张图片")
        return normalized

    @staticmethod
    def _message_summary(prompt: str, attachment_count: int) -> str:
        if prompt.strip():
            return prompt.strip()
        return f"上传了 {attachment_count} 张图片"

    def _load_ai_message_attachment_assets(
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

    def _attachment_summaries(self, assets: list[MediaAsset]) -> list[dict[str, Any]]:
        return [
            {
                "type": "image",
                "mediaId": asset.id,
                "name": asset.name,
                "alt": asset.alt,
                "source": "current_message",
            }
            for asset in assets
        ]

    def _build_user_message_parts(self, prompt: str, attachment_assets: list[MediaAsset]) -> list[dict[str, Any]]:
        parts: list[dict[str, Any]] = []
        if prompt.strip():
            parts.append({"id": create_id("ai_part"), "type": "text", "text": prompt.strip()})
        for asset in attachment_assets:
            parts.append(
                {
                    "id": create_id("ai_part"),
                    "type": "image",
                    "image": {
                        "media_id": asset.id,
                        "asset": serialize_media(asset),
                        "alt": asset.alt or asset.name,
                    },
                }
            )
        return parts

    def _provider_images_for_attachments(
        self,
        *,
        family_id: str,
        attachments: list[dict[str, Any]],
    ) -> list[ProviderImageInput]:
        if not attachments:
            return []
        if not getattr(self.provider, "supports_vision", False):
            raise ValueError("当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。")

        media_ids = [str(item.get("mediaId") or item.get("media_id") or "").strip() for item in attachments]
        assets = list(
            self.db.scalars(
                select(MediaAsset).where(
                    MediaAsset.family_id == family_id,
                    MediaAsset.id.in_(media_ids),
                )
            )
        )
        assets_by_id = {asset.id: asset for asset in assets}
        images: list[ProviderImageInput] = []
        for media_id in media_ids:
            asset = assets_by_id.get(media_id)
            if asset is None:
                raise LookupError("图片附件不存在或不属于当前家庭")
            payload, content_type = read_media_object_for_ai(asset)
            images.append(
                ProviderImageInput(
                    media_id=asset.id,
                    content_type=content_type,
                    payload=payload,
                    filename=asset.name,
                )
            )
        return images

    def _cancel_requested(self, run_id: str) -> bool:
        bind = self.db.get_bind()
        if bind.dialect.name == "sqlite":
            self.db.expire_all()
            status = self.db.scalar(
                select(AIAgentRun.status)
                .where(AIAgentRun.id == run_id)
                .execution_options(populate_existing=True)
            )
            return status == "cancelled"
        with Session(bind=bind) as db:
            status = db.scalar(select(AIAgentRun.status).where(AIAgentRun.id == run_id))
            return status == "cancelled"

    def _cancel_after_disconnect(self, run_id: str) -> None:
        self.db.rollback()
        run = self.db.get(AIAgentRun, run_id)
        if run is None or run.status not in {"pending", "running"}:
            return
        self.service.cancel_run(
            family_id=run.family_id,
            user_id=run.created_by or "",
            run_id=run.id,
        )
        self.db.commit()
        live_ai_stream_cache.clear_run(run_id)

    def _mark_stream_run_failed(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        user_id: str,
        error: str,
    ) -> None:
        try:
            self.db.rollback()
            run = self.db.get(AIAgentRun, run_id)
            if run is None or run.status in {"completed", "failed", "cancelled", "waiting_approval"}:
                live_ai_stream_cache.clear_run(run_id)
                return
            text = "AI 服务暂时不可用，请稍后重试。"
            message = self.db.scalar(
                select(AIMessage)
                .where(AIMessage.run_id == run_id, AIMessage.role == "assistant")
                .order_by(AIMessage.created_at.desc())
            )
            if message is None:
                message = AIMessage(
                    id=create_id("ai_message"),
                    family_id=family_id,
                    conversation_id=conversation_id,
                    role="assistant",
                    content=text,
                    content_type="parts",
                    parts=[{"id": create_id("ai_part"), "type": "text", "text": text}],
                    run_id=run_id,
                    status="failed",
                    message_metadata={"intent": run.intent or "runtime_failed", "agentKey": run.agent_key or "workspace_orchestrator"},
                    created_by=user_id,
                )
                self.db.add(message)
            else:
                message.status = "failed"
                if not message.content:
                    message.content = text
                if not message.parts:
                    message.parts = [{"id": create_id("ai_part"), "type": "text", "text": message.content or text}]
                metadata = dict(message.message_metadata or {})
                metadata.pop("liveStreaming", None)
                metadata.pop("liveTextPartIds", None)
                metadata.pop("livePartIds", None)
                message.message_metadata = metadata

            event = AIRunEvent(
                id=create_id("ai_run_event"),
                family_id=family_id,
                conversation_id=conversation_id,
                run_id=run_id,
                type="error",
                internal_code="runtime_exception",
                user_message=text,
                status="failed",
                payload={"error": error[:1000]},
            )
            self.db.add(event)
            run.status = "failed"
            run.error = error or text
            run.output_summary = text
            run.output = self._json_record({"text": text, "cards": [], "routing": (run.context_summary or {}).get("routing", {})})
            conversation = self.db.get(AIConversation, conversation_id)
            if conversation is not None:
                conversation.last_run_status = "failed"
                conversation.last_message_at = utcnow()
                context = dict(conversation.context or {})
                context.pop("activeRunId", None)
                conversation.context = self._json_record(context)
                if not conversation.response:
                    conversation.response = text
                    conversation.summary = text[:255]
            self.db.commit()
            live_ai_stream_cache.clear_run(run_id)
        except Exception:
            self.db.rollback()
            logger.exception(
                "AI graph failed to persist stream error run_id=%s conversation_id=%s family_id=%s",
                run_id,
                conversation_id,
                family_id,
            )

    def resume_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None = None,
    ) -> dict[str, Any]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        logger.info(
            "AI graph approval resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            bool(snapshot.values),
            list(snapshot.next or []),
        )
        pending = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if pending is None:
            logger.warning(
                "AI graph approval resume missing approval family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise LookupError("确认请求不存在")

        if not snapshot.values or not snapshot.next:
            logger.warning(
                "AI graph approval resume missing checkpoint family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise AIConflictError("确认请求缺少可恢复的运行状态，请重新生成草稿")

        output = self.graph.invoke(
            Command(
                resume={
                    "approvalId": approval_id,
                    "decision": decision,
                    "draftVersion": draft_version,
                    "values": values,
                    "comment": comment,
                    "userId": user_id,
                    "familyId": family_id,
                }
            ),
            config=config,
            durability="sync",
        )
        result = output.get("last_decision")
        if not isinstance(result, dict):
            state = self.graph.get_state(config)
            result = state.values.get("last_decision")
        if not isinstance(result, dict):
            logger.error(
                "AI graph approval resume missing result family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise RuntimeError("LangGraph 恢复后没有生成确认结果")
        logger.info(
            "AI graph approval resume completed family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s operation_status=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            (result.get("operation") or {}).get("status") if isinstance(result.get("operation"), dict) else None,
        )
        return result

    def apply_approval_decision_fast(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None = None,
    ) -> dict[str, Any]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        result = self.service._apply_approval_decision(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
        )
        serialized = jsonable_encoder(result)
        approval = serialized.get("approval") if isinstance(serialized.get("approval"), dict) else {}
        draft = serialized.get("draft") if isinstance(serialized.get("draft"), dict) else {}
        operation = serialized.get("operation") if isinstance(serialized.get("operation"), dict) else None
        next_status = "completed"
        if approval.get("status") == "pending":
            next_status = "waiting_approval"
        elif operation is not None and operation.get("status") != "succeeded":
            next_status = "failed"
        elif decision == "rejected" or self._decision_after_approval(serialized) is not None:
            next_status = "running"
        run_id = str(approval.get("run_id") or "")
        if run_id:
            run = self.db.get(AIAgentRun, run_id)
            if run is not None:
                run.status = next_status
                self._record_approval_outcome(
                    run,
                    approval_status=str(approval.get("status") or decision),
                    draft_type=str(draft.get("draft_type") or ""),
                )
        conversation = self.db.get(AIConversation, conversation_id)
        if conversation is not None:
            conversation.last_run_status = next_status
            context = dict(conversation.context or {})
            fast_decisions = context.get("fastApprovalDecisions") if isinstance(context.get("fastApprovalDecisions"), dict) else {}
            context["fastApprovalDecisions"] = {**fast_decisions, approval_id: serialized}
            conversation.context = self._json_record(context)
        message_id = str(approval.get("message_id") or "")
        message = self.db.get(AIMessage, message_id) if message_id else None
        if message is not None:
            message.status = next_status
        self.db.flush()
        return serialized

    def resume_human_input(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        request_id: str,
        selected_option_ids: list[str],
        text: str | None,
    ) -> dict[str, Any]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        if not snapshot.values or not snapshot.next:
            raise LookupError("用户补充信息请求不存在或已结束")
        output = self.graph.invoke(
            Command(
                resume={
                    "requestId": request_id,
                    "selectedOptionIds": selected_option_ids,
                    "text": text or "",
                    "userId": user_id,
                    "familyId": family_id,
                }
            ),
            config=config,
            durability="sync",
        )
        run_id = str(output.get("run_id") or "")
        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        if not run_id:
            raise RuntimeError("LangGraph 恢复后没有运行记录")
        return self._chat_response(conversation_id, run_id)


    def stream_resume_human_input(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        request_id: str,
        selected_option_ids: list[str],
        text: str | None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        if not snapshot.values or not snapshot.next:
            raise LookupError("用户补充信息请求不存在或已结束")
        run_id = str((snapshot.values or {}).get("run_id") or "")
        logger.info(
            "AI graph human input stream resume started family_id=%s user_id=%s conversation_id=%s request_id=%s run_id=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            request_id,
            run_id,
            bool(snapshot.values),
            list(snapshot.next or []),
        )

        seen_event_ids: set[str] = set()
        try:
            def graph_stream() -> Iterator[Any]:
                return self.graph.stream(
                    Command(
                        resume={
                            "requestId": request_id,
                            "selectedOptionIds": selected_option_ids,
                            "text": text or "",
                            "userId": user_id,
                            "familyId": family_id,
                        }
                    ),
                    config=config,
                    stream_mode=["updates", "custom"],
                    durability="sync",
                )

            def handle_update(update: Any) -> Iterator[tuple[str, dict[str, Any]]]:
                nonlocal run_id
                if not run_id:
                    run_id = self._run_id_from_update(update) or run_id
                if run_id:
                    yield from self._new_progress_events(run_id, seen_event_ids)

            yield from self._stream_graph_events(
                graph_stream,
                handle_update=handle_update,
                seen_event_ids=seen_event_ids,
                on_disconnect=lambda: self._cancel_after_disconnect(run_id) if run_id else None,
            )
        except GeneratorExit:
            if run_id:
                self._cancel_after_disconnect(run_id)
            raise
        except Exception as exc:
            if run_id:
                self._mark_stream_run_failed(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=family_id,
                    user_id=user_id,
                    error=str(exc),
                )
            raise

        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        if not run_id:
            raise RuntimeError("LangGraph 恢复后没有运行记录")
        yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph human input stream resume completed family_id=%s user_id=%s conversation_id=%s request_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            request_id,
            run_id,
        )
        yield ("response", self._chat_response(conversation_id, run_id))


    def stream_resume_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        pending = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if pending is None:
            raise LookupError("确认请求不存在")
        run_id = pending.run_id or str((snapshot.values or {}).get("run_id") or "")
        logger.info(
            "AI graph approval stream resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s run_id=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            run_id,
            bool(snapshot.values),
            list(snapshot.next or []),
        )

        if not snapshot.values or not snapshot.next:
            logger.warning(
                "AI graph approval stream resume missing checkpoint family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise AIConflictError("确认请求缺少可恢复的运行状态，请重新生成草稿")

        seen_event_ids: set[str] = set()
        emitted_result_part_id = f"rejected:{approval_id}" if decision == "rejected" else ""

        def emit_approval_result_part() -> Iterator[tuple[str, dict[str, Any]]]:
            nonlocal emitted_result_part_id
            if emitted_result_part_id:
                return
            data = self._approval_result_message_part(
                family_id=family_id,
                conversation_id=conversation_id,
                approval_id=approval_id,
            )
            if not data:
                return
            part = data.get("part") if isinstance(data.get("part"), dict) else {}
            part_id = str(part.get("id") or "")
            if not part_id or part_id == emitted_result_part_id:
                return
            emitted_result_part_id = part_id
            yield ("message_part", data)

        yield from emit_approval_result_part()
        try:
            def graph_stream() -> Iterator[Any]:
                return self.graph.stream(
                    Command(
                        resume={
                            "approvalId": approval_id,
                            "decision": decision,
                            "draftVersion": draft_version,
                            "values": values,
                            "comment": comment,
                            "userId": user_id,
                            "familyId": family_id,
                        }
                    ),
                    config=config,
                    stream_mode=["updates", "custom"],
                    durability="sync",
                )

            def handle_update(update: Any) -> Iterator[tuple[str, dict[str, Any]]]:
                nonlocal run_id
                if not run_id:
                    run_id = self._run_id_from_update(update) or run_id
                yield from emit_approval_result_part()
                if run_id:
                    yield from self._new_progress_events(run_id, seen_event_ids)

            yield from self._stream_graph_events(
                graph_stream,
                handle_update=handle_update,
                seen_event_ids=seen_event_ids,
                on_disconnect=lambda: self._cancel_after_disconnect(run_id) if run_id else None,
            )
        except GeneratorExit:
            if run_id:
                self._cancel_after_disconnect(run_id)
            raise
        except Exception as exc:
            if run_id:
                self._mark_stream_run_failed(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=family_id,
                    user_id=user_id,
                    error=str(exc),
                )
            raise

        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        if run_id:
            yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph approval stream resume completed family_id=%s user_id=%s conversation_id=%s approval_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            run_id,
        )
        yield ("response", self._chat_response(conversation_id, run_id))

    def _approval_result_message_part(
        self,
        *,
        family_id: str,
        conversation_id: str,
        approval_id: str,
    ) -> dict[str, Any] | None:
        approval = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if approval is None or not approval.message_id:
            return None
        message = self.db.get(AIMessage, approval.message_id)
        if message is None:
            return None
        expected_card_id = f"operation-result:{approval.id}"
        for part in message.parts or []:
            if not isinstance(part, dict) or part.get("type") != "result_card":
                continue
            card = part.get("card") if isinstance(part.get("card"), dict) else {}
            data = card.get("data") if isinstance(card.get("data"), dict) else {}
            if str(card.get("id") or "") != expected_card_id and str(data.get("approvalId") or "") != approval.id:
                continue
            return {
                "message_id": message.id,
                "conversation_id": conversation_id,
                "run_id": approval.run_id,
                "part": jsonable_encoder(part),
            }
        return None

    def delete_thread(self, conversation_id: str) -> None:
        self.checkpointer.delete_thread(conversation_id)

    def _build_graph(self):
        graph = StateGraph(WorkspaceGraphState)
        graph.add_node("initialize", self._initialize)
        graph.add_node("orchestrator", self._orchestrator_step)
        graph.add_node("approval_interrupt", self._approval_interrupt_step)
        graph.add_node("human_input_interrupt", self._human_input_interrupt_step)
        graph.add_node("finalize", self._finalize)
        graph.add_edge(START, "initialize")
        graph.add_edge("initialize", "orchestrator")
        graph.add_conditional_edges(
            "orchestrator",
            self._route_after_orchestrator,
            {
                "orchestrator": "orchestrator",
                "approval_interrupt": "approval_interrupt",
                "human_input_interrupt": "human_input_interrupt",
                "finalize": "finalize",
            },
        )
        graph.add_conditional_edges(
            "approval_interrupt",
            self._route_after_orchestrator,
            {
                "orchestrator": "orchestrator",
                "approval_interrupt": "approval_interrupt",
                "human_input_interrupt": "human_input_interrupt",
                "finalize": "finalize",
            },
        )
        graph.add_conditional_edges(
            "human_input_interrupt",
            self._route_after_orchestrator,
            {
                "orchestrator": "orchestrator",
                "approval_interrupt": "approval_interrupt",
                "human_input_interrupt": "human_input_interrupt",
                "finalize": "finalize",
            },
        )
        graph.add_edge("finalize", END)
        return graph.compile(checkpointer=self.checkpointer)

    def _initialize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        if state.get("run_id") and state.get("user_message_id"):
            run = self.db.get(AIAgentRun, state["run_id"])
            user_message = self.db.get(AIMessage, state["user_message_id"])
            if run is None or user_message is None:
                raise RuntimeError("预创建的 AI 运行状态不存在")
            return {
                "run_id": run.id,
                "user_message_id": user_message.id,
                "status": "cancelled" if run.status == "cancelled" else "running",
            }
        conversation = require_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
        )
        user_message = AIMessage(
            id=create_id("ai_message"),
            family_id=state["family_id"],
            conversation_id=conversation.id,
            role="user",
            content=state["message"],
            content_type="text",
            parts=[{"id": create_id("ai_part"), "type": "text", "text": state["message"]}],
            status="completed",
            client_message_id=state.get("client_message_id"),
            created_by=state["user_id"],
        )
        self.db.add(user_message)
        self.db.flush()
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=conversation.id,
            quick_task=state.get("quick_task"),
        )
        run = AIAgentRun(
            id=state.get("client_run_id") or create_id("agent_run"),
            family_id=state["family_id"],
            conversation_id=conversation.id,
            message_id=user_message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=state["message"][:255],
            context_summary={"graph": {"runtime": "langgraph", "threadId": conversation.id}},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={
                "prompt": state["message"],
                "quickTask": state.get("quick_task"),
                "subject": state.get("subject") or {},
                "conversation": timeline,
            },
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=state["user_id"],
        )
        self.db.add(run)
        self.db.flush()
        self.db.flush()
        logger.info(
            "AI graph initialized run_id=%s conversation_id=%s family_id=%s user_id=%s client_run_id=%s",
            run.id,
            conversation.id,
            state["family_id"],
            state["user_id"],
            state.get("client_run_id"),
        )
        return {"run_id": run.id, "user_message_id": user_message.id, "status": "running"}

    def _orchestrator_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        if self._cancel_requested(state["run_id"]):
            return {"status": "cancelled"}
        pending = self.db.scalar(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.family_id == state["family_id"],
                AIApprovalRequest.conversation_id == state["conversation_id"],
                AIApprovalRequest.run_id == state["run_id"],
                AIApprovalRequest.status == "pending",
            )
            .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
        )
        if pending is not None:
            self._mark_waiting_approval_state(state)
            return {
                "status": "waiting_approval",
                "pending_approval_id": pending.id,
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
                "run_artifacts": list(state.get("run_artifacts") or []),
            }

        conversation = self.db.get(AIConversation, state["conversation_id"])
        conversation_context = dict(conversation.context or {}) if conversation is not None else {}
        task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
        pending_human_input = task_state.get("pendingHumanInput") if isinstance(task_state, dict) else None
        if isinstance(pending_human_input, dict) and pending_human_input.get("id"):
            return {
                "status": "waiting_input",
                "pending_human_input": pending_human_input,
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
                "run_artifacts": list(state.get("run_artifacts") or []),
            }

        stream_writer = self._persistent_progress_writer(get_stream_writer(), state)
        root_tools = ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=self.db,
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                run_id=state["run_id"],
                stream_writer=stream_writer,
                cancel_check=lambda: self._cancel_requested(state["run_id"]),
            ),
        )
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        current_run_artifacts = list(state.get("run_artifacts") or [])
        last_human_input_result = (
            state.get("last_human_input_result")
            if isinstance(state.get("last_human_input_result"), dict) and state.get("last_human_input_result")
            else None
        )
        if last_human_input_result is None:
            last_human_input_result = next(
                (
                    item
                    for item in reversed(current_run_artifacts)
                    if isinstance(item, dict) and item.get("type") == "human.input_result"
                ),
                None,
            )
        if last_human_input_result is None and isinstance(task_state, dict) and isinstance(task_state.get("lastHumanInputResult"), dict):
            last_human_input_result = {
                "id": f"human_input:{task_state['lastHumanInputResult'].get('request', {}).get('id') or create_id('human_input')}",
                "type": "human.input_result",
                "kind": "human_input",
                "version": 1,
                "status": "completed",
                "payload": task_state["lastHumanInputResult"],
            }
        if last_human_input_result is not None and not any(
            item.get("id") == last_human_input_result.get("id")
            for item in current_run_artifacts
            if isinstance(item, dict)
        ):
            current_run_artifacts.append(last_human_input_result)
        current_message_attachments = list(state.get("current_message_attachments") or [])
        current_message_images = self._provider_images_for_attachments(
            family_id=state["family_id"],
            attachments=current_message_attachments,
        )
        started_at = perf_counter()
        try:
            result = WorkspaceOrchestratorAgent(
                provider=self.provider,
                skill_registry=self.skill_registry,
            ).run(
                SkillContext(
                    db=self.db,
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    run_id=state["run_id"],
                    conversation=timeline,
                    current_message=state["message"],
                    subject=state.get("subject") or {},
                    current_message_attachments=current_message_attachments,
                    current_message_images=current_message_images,
                    quick_task=state.get("quick_task"),
                    tool_executor=root_tools,
                    provider=self.provider,
                    current_run_artifacts=current_run_artifacts,
                    stream_writer=stream_writer,
                    progressive_draft_publisher=self._progressive_draft_publisher(state),
                    cancel_check=lambda: self._cancel_requested(state["run_id"]),
                ),
                injected_skill_keys=list(state.get("injected_skill_keys") or []),
            )
        except AIExecutionCancelled:
            result = SkillResult(
                text="已取消这次任务。",
                status="cancelled",
                model=getattr(self.provider, "model_name", ""),
            )
        if last_human_input_result is not None:
            result.context_summary = {
                **(result.context_summary or {}),
                "lastHumanInputResult": last_human_input_result.get("payload", last_human_input_result),
            }
        self._persist_assistant_result(state, result, skill_key=None, duration_ms=int((perf_counter() - started_at) * 1000))
        orchestrator_summary = result.context_summary.get("orchestrator") if isinstance(result.context_summary, dict) else {}
        injected_skill_keys = (
            list(orchestrator_summary.get("injectedSkills") or [])
            if isinstance(orchestrator_summary, dict)
            else list(state.get("injected_skill_keys") or [])
        )
        injection_history = (
            list(orchestrator_summary.get("injectionHistory") or [])
            if isinstance(orchestrator_summary, dict)
            else list(state.get("injection_history") or [])
        )
        run_artifacts = [
            *(state.get("run_artifacts") or []),
            *result_artifacts("orchestrator", result),
            *self._tool_call_artifacts(result),
        ]
        if result.status == "waiting_input":
            pending_human_input = (
                result.context_summary.get("pendingHumanInput")
                if isinstance(result.context_summary, dict) and isinstance(result.context_summary.get("pendingHumanInput"), dict)
                else {}
            )
            return {
                "run_artifacts": run_artifacts,
                "injected_skill_keys": injected_skill_keys,
                "injection_history": injection_history,
                "pending_approval_id": "",
                "pending_human_input": pending_human_input,
                "status": "waiting_input",
            }
        pending_after_result = self.db.scalar(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.run_id == state["run_id"],
                AIApprovalRequest.status == "pending",
            )
            .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
        )
        next_agent_rounds = int(state.get("agent_rounds") or 0) + 1
        if result.drafts and pending_after_result is None:
            fast_approval_id = str(result.drafts[0].get("approval_id") or "") if result.drafts else ""
            if fast_approval_id and self._has_fast_approval_decision(state, fast_approval_id):
                return {
                    "run_artifacts": run_artifacts,
                    "injected_skill_keys": injected_skill_keys,
                    "injection_history": injection_history,
                    "pending_approval_id": fast_approval_id,
                    "pending_human_input": {},
                    "agent_rounds": next_agent_rounds,
                    "status": "waiting_approval",
                }
            raise RuntimeError("草稿已生成，但没有创建确认请求")
        if pending_after_result is not None:
            self._mark_waiting_approval_state(state)
            return {
                "run_artifacts": run_artifacts,
                "injected_skill_keys": injected_skill_keys,
                "injection_history": injection_history,
                "pending_approval_id": pending_after_result.id,
                "pending_human_input": {},
                "agent_rounds": next_agent_rounds,
                "status": "waiting_approval",
            }
        return {
            "run_artifacts": run_artifacts,
            "injected_skill_keys": injected_skill_keys,
            "injection_history": injection_history,
            "pending_approval_id": "",
            "pending_human_input": {},
            "agent_rounds": next_agent_rounds,
            "status": result.status,
            "error": result.error,
        }

    def _approval_interrupt_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        pending_approval_id = str(state.get("pending_approval_id") or "")
        pending = None
        if pending_approval_id:
            pending = self.db.scalar(
                select(AIApprovalRequest).where(
                    AIApprovalRequest.id == pending_approval_id,
                    AIApprovalRequest.family_id == state["family_id"],
                    AIApprovalRequest.conversation_id == state["conversation_id"],
                    AIApprovalRequest.run_id == state["run_id"],
                    AIApprovalRequest.status == "pending",
                )
            )
        if pending is None:
            pending = self.db.scalar(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.family_id == state["family_id"],
                    AIApprovalRequest.conversation_id == state["conversation_id"],
                    AIApprovalRequest.run_id == state["run_id"],
                    AIApprovalRequest.status == "pending",
                )
                .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
            )
        if pending is None:
            recorded_decision = self._pop_fast_approval_decision(state, pending_approval_id)
            if recorded_decision is not None:
                return self._resume_recorded_approval_decision(
                    state,
                    recorded_decision,
                    list(state.get("run_artifacts") or []),
                )
            raise LookupError("确认请求不存在")
        resume = interrupt(self._approval_interrupt_payload(pending))
        return self._resume_pending_approval(state, pending, resume, list(state.get("run_artifacts") or []))

    def _human_input_interrupt_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        pending = state.get("pending_human_input") if isinstance(state.get("pending_human_input"), dict) else {}
        if not pending or not pending.get("id"):
            raise LookupError("用户补充信息请求不存在或已结束")
        resume = interrupt(self._human_input_interrupt_payload(state, pending))
        return self._resume_pending_human_input(state, pending, resume, list(state.get("run_artifacts") or []))

    def _resume_pending_human_input(
        self,
        state: WorkspaceGraphState,
        pending: dict[str, Any],
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not isinstance(pending, dict) or not pending.get("id"):
            raise ValueError("没有可恢复的用户补充信息请求")
        if not isinstance(resume, dict):
            raise ValueError("用户补充信息恢复参数格式不正确")
        if str(resume.get("requestId") or "") != str(pending.get("id") or ""):
            raise ValueError("用户补充信息请求与当前暂停任务不匹配")
        if str(resume.get("familyId") or "") != state["family_id"]:
            raise LookupError("用户补充信息请求不存在")

        selected_option_ids = [
            str(item)
            for item in (resume.get("selectedOptionIds") if isinstance(resume.get("selectedOptionIds"), list) else [])
            if str(item).strip()
        ]
        text = str(resume.get("text") or "").strip()
        answer_summary = self._human_input_answer_summary(pending, selected_option_ids, text)
        response_payload = {
            "selectedOptionIds": selected_option_ids,
            "text": text,
            "summary": answer_summary,
        }
        result_artifact = {
            "id": f"human_input:{pending['id']}",
            "type": "human.input_result",
            "kind": "human_input",
            "version": 1,
            "status": "completed",
            "payload": {
                "request": pending,
                **response_payload,
            },
        }
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is not None:
            metadata = dict(message.message_metadata or {})
            artifacts = [item for item in metadata.get("artifacts") or [] if isinstance(item, dict)]
            if not any(item.get("id") == result_artifact["id"] for item in artifacts):
                artifacts.append(result_artifact)
            responded_at = utcnow().isoformat()
            next_parts: list[dict[str, Any]] = []
            for part in message.parts or []:
                if not isinstance(part, dict):
                    continue
                request = part.get("request") if isinstance(part.get("request"), dict) else {}
                if part.get("type") == "human_input_request" and str(request.get("id") or "") == str(pending["id"]):
                    next_parts.append(
                        {
                            **part,
                            "status": "completed",
                            "responded_at": responded_at,
                            "response": response_payload,
                        }
                    )
                else:
                    next_parts.append(part)
            message.parts = next_parts
            message.message_metadata = {**metadata, "artifacts": artifacts}
        if run is not None:
            run.status = "running"
            context_summary = dict(run.context_summary or {})
            context_summary["lastHumanInputResult"] = result_artifact["payload"]
            run.context_summary = self._json_record(context_summary)
        if conversation is not None:
            conversation.last_run_status = "running"
            context = dict(conversation.context or {})
            task_state = dict(context.get("taskState") or {})
            task_state.pop("pendingHumanInput", None)
            task_state["lastHumanInputResult"] = result_artifact["payload"]
            context["taskState"] = task_state
            conversation.context = self._json_record(context)
        self.db.flush()
        return {
            "status": "running",
            "run_artifacts": [*run_artifacts, result_artifact],
            "pending_human_input": {},
            "pending_approval_id": "",
            "last_human_input_result": result_artifact,
            "injected_skill_keys": list(state.get("injected_skill_keys") or []),
            "injection_history": list(state.get("injection_history") or []),
        }

    @staticmethod
    def _human_input_answer_summary(
        pending: dict[str, Any],
        selected_option_ids: list[str],
        text: str,
    ) -> str:
        options = pending.get("options") if isinstance(pending.get("options"), list) else []
        labels_by_id = {
            str(option.get("id")): str(option.get("label") or "").strip()
            for option in options
            if isinstance(option, dict) and str(option.get("id") or "").strip()
        }
        selected_labels = [
            labels_by_id.get(option_id, option_id)
            for option_id in selected_option_ids
            if option_id
        ]
        values = list(dict.fromkeys(value for value in [*selected_labels, text.strip()] if value))
        return "；".join(values) or "已提交回答"

    def _resume_pending_approval(
        self,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        recorded_decision = self._pop_fast_approval_decision(state, pending.id)
        if recorded_decision is not None:
            return self._resume_recorded_approval_decision(
                state,
                recorded_decision,
                run_artifacts,
            )
        if not isinstance(resume, dict):
            logger.warning(
                "AI graph approval resume invalid payload run_id=%s conversation_id=%s family_id=%s approval_id=%s payload_type=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                type(resume).__name__,
            )
            raise ValueError("确认恢复参数格式不正确")
        if str(resume.get("approvalId") or "") != pending.id:
            logger.warning(
                "AI graph approval resume mismatched approval run_id=%s conversation_id=%s family_id=%s pending_approval_id=%s resume_approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                resume.get("approvalId"),
            )
            raise ValueError("确认请求与当前暂停任务不匹配")
        if str(resume.get("familyId") or "") != state["family_id"]:
            logger.warning(
                "AI graph approval resume mismatched family run_id=%s conversation_id=%s family_id=%s resume_family_id=%s approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                resume.get("familyId"),
                pending.id,
            )
            raise LookupError("确认请求不存在")
        result = self.service._apply_approval_decision(
            family_id=state["family_id"],
            user_id=str(resume.get("userId") or state["user_id"]),
            conversation_id=state["conversation_id"],
            approval_id=pending.id,
            decision=str(resume.get("decision") or ""),
            draft_version=int(resume.get("draftVersion") or 0),
            values=resume.get("values") if isinstance(resume.get("values"), dict) else {},
            comment=str(resume.get("comment") or "") or None,
        )
        serialized = jsonable_encoder(result)
        approval_artifacts = self.service._approval_decision_artifacts(serialized)
        operation = result.get("operation")
        next_approval = result.get("approval")
        decision_draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
        decision_draft_type = str(decision_draft.get("draft_type") or "")
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if isinstance(next_approval, dict) and next_approval.get("status") == "pending":
            logger.warning(
                "AI graph approval operation requires retry run_id=%s conversation_id=%s family_id=%s approval_id=%s next_approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                next_approval.get("id"),
            )
            if run is not None:
                run.status = "waiting_approval"
            if conversation is not None:
                conversation.last_run_status = "waiting_approval"
            self.db.flush()
            return {
                "status": "waiting_approval",
                "pending_approval_id": str(next_approval.get("id") or ""),
                "last_decision": serialized,
                "run_artifacts": [*run_artifacts, *approval_artifacts],
            }
        if str(resume.get("decision")) == "rejected":
            logger.info(
                "AI graph approval rejected run_id=%s conversation_id=%s family_id=%s approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
            )
            if run is not None:
                run.status = "running"
                self._record_approval_outcome(run, approval_status="rejected", draft_type=decision_draft_type)
            if conversation is not None:
                conversation.last_run_status = "running"
            self.db.flush()
            next_run_artifacts = [*run_artifacts, *approval_artifacts]
            resume_artifact = self._consume_resume_after_approval(state, serialized)
            if resume_artifact is not None:
                next_run_artifacts.append(resume_artifact)
            return {
                "run_artifacts": next_run_artifacts,
                "status": "running",
                "last_decision": serialized,
                "pending_approval_id": "",
                "pending_human_input": {},
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
            }
        if not isinstance(operation, dict) or operation.get("status") != "succeeded":
            logger.warning(
                "AI graph approval operation failed run_id=%s conversation_id=%s family_id=%s approval_id=%s operation=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                operation,
            )
            if run is not None:
                run.status = "failed"
            if conversation is not None:
                conversation.last_run_status = "failed"
            self.db.flush()
            return {"status": "failed", "last_decision": serialized, "error": "草稿写入失败", "run_artifacts": [*run_artifacts, *approval_artifacts]}
        if run is not None:
            run.status = "running"
            self._record_approval_outcome(
                run,
                approval_status="approved",
                draft_type=decision_draft_type,
            )
        if conversation is not None:
            conversation.last_run_status = "running"
        self.db.flush()
        next_run_artifacts = [*run_artifacts, *approval_artifacts]
        resume_artifact = self._consume_resume_after_approval(state, serialized)
        if resume_artifact is None:
            self._stream_approval_followup(state, serialized, terminal_status="completed")
            if run is not None:
                run.status = "completed"
            if conversation is not None:
                conversation.last_run_status = "completed"
            self.db.flush()
            return {
                "run_artifacts": next_run_artifacts,
                "status": "completed",
                "last_decision": serialized,
                "pending_approval_id": "",
                "pending_human_input": {},
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
            }
        next_run_artifacts.append(resume_artifact)
        return {
            "run_artifacts": next_run_artifacts,
            "status": "running",
            "last_decision": serialized,
            "pending_approval_id": "",
            "pending_human_input": {},
            "injected_skill_keys": list(state.get("injected_skill_keys") or []),
            "injection_history": list(state.get("injection_history") or []),
        }

    def _resume_recorded_approval_decision(
        self,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        approval_artifacts = self.service._approval_decision_artifacts(serialized)
        approval = serialized.get("approval") if isinstance(serialized.get("approval"), dict) else {}
        operation = serialized.get("operation") if isinstance(serialized.get("operation"), dict) else None
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if approval.get("status") == "pending":
            if run is not None:
                run.status = "waiting_approval"
            if conversation is not None:
                conversation.last_run_status = "waiting_approval"
            self.db.flush()
            return {
                "status": "waiting_approval",
                "pending_approval_id": str(approval.get("id") or ""),
                "last_decision": serialized,
                "run_artifacts": [*run_artifacts, *approval_artifacts],
            }
        if approval.get("decision") == "rejected":
            if run is not None:
                run.status = "running"
            if conversation is not None:
                conversation.last_run_status = "running"
            self.db.flush()
            next_run_artifacts = [*run_artifacts, *approval_artifacts]
            resume_artifact = self._consume_resume_after_approval(state, serialized)
            if resume_artifact is not None:
                next_run_artifacts.append(resume_artifact)
            return {
                "run_artifacts": next_run_artifacts,
                "status": "running",
                "last_decision": serialized,
                "pending_approval_id": "",
                "pending_human_input": {},
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
            }
        if operation is not None and operation.get("status") != "succeeded":
            if run is not None:
                run.status = "failed"
            if conversation is not None:
                conversation.last_run_status = "failed"
            self.db.flush()
            return {"status": "failed", "last_decision": serialized, "error": "草稿写入失败", "run_artifacts": [*run_artifacts, *approval_artifacts]}
        next_run_artifacts = [*run_artifacts, *approval_artifacts]
        resume_artifact = self._consume_resume_after_approval(state, serialized)
        if resume_artifact is None:
            self._stream_approval_followup(state, serialized, terminal_status="completed")
            if run is not None:
                run.status = "completed"
            if conversation is not None:
                conversation.last_run_status = "completed"
            self.db.flush()
            return {
                "run_artifacts": next_run_artifacts,
                "status": "completed",
                "last_decision": serialized,
                "pending_approval_id": "",
                "pending_human_input": {},
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
            }
        next_run_artifacts.append(resume_artifact)
        if run is not None:
            run.status = "running"
        if conversation is not None:
            conversation.last_run_status = "running"
        self.db.flush()
        return {
            "run_artifacts": next_run_artifacts,
            "status": "running",
            "last_decision": serialized,
            "pending_approval_id": "",
            "pending_human_input": {},
            "injected_skill_keys": list(state.get("injected_skill_keys") or []),
            "injection_history": list(state.get("injection_history") or []),
        }

    def _decision_after_approval(self, decision_result: dict[str, Any]) -> dict[str, Any] | None:
        draft_record = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
        draft_id = str(draft_record.get("id") or "")
        if not draft_id:
            return None
        draft = self.db.get(AITaskDraft, draft_id)
        if draft is None:
            return None
        metadata = draft.ai_metadata if isinstance(draft.ai_metadata, dict) else {}
        after_approval = metadata.get("afterApproval") if isinstance(metadata.get("afterApproval"), dict) else None
        if not after_approval or not after_approval.get("continue"):
            return None
        return dict(after_approval)

    def _pop_fast_approval_decision(self, state: WorkspaceGraphState, approval_id: str) -> dict[str, Any] | None:
        if not approval_id:
            return None
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if conversation is None:
            return None
        context = dict(conversation.context or {})
        fast_decisions = context.get("fastApprovalDecisions") if isinstance(context.get("fastApprovalDecisions"), dict) else {}
        recorded = fast_decisions.get(approval_id)
        if not isinstance(recorded, dict):
            return None
        next_fast_decisions = dict(fast_decisions)
        next_fast_decisions.pop(approval_id, None)
        if next_fast_decisions:
            context["fastApprovalDecisions"] = next_fast_decisions
        else:
            context.pop("fastApprovalDecisions", None)
        conversation.context = self._json_record(context)
        self.db.flush()
        return recorded

    def _has_fast_approval_decision(self, state: WorkspaceGraphState, approval_id: str) -> bool:
        if not approval_id:
            return False
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if conversation is None:
            return False
        context = dict(conversation.context or {})
        fast_decisions = context.get("fastApprovalDecisions") if isinstance(context.get("fastApprovalDecisions"), dict) else {}
        return isinstance(fast_decisions.get(approval_id), dict)

    def _consume_resume_after_approval(
        self,
        state: WorkspaceGraphState,
        decision_result: dict[str, Any],
    ) -> dict[str, Any] | None:
        resume_payload = self._decision_after_approval(decision_result)
        if resume_payload is None:
            return None
        approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
        return {
            "id": f"draft_after_approval:{state['run_id']}:{approval.get('id') or create_id('resume')}",
            "type": "draft_after_approval",
            "kind": "task_resume",
            "version": 1,
            "status": "pending",
            "payload": resume_payload,
        }

    def _tool_call_artifacts(self, result: SkillResult) -> list[dict[str, Any]]:
        artifacts: list[dict[str, Any]] = []
        for index, record in enumerate(result.tool_calls):
            if not isinstance(record, dict):
                continue
            name = str(record.get("name") or "").strip()
            if not name:
                continue
            tool_input = record.get("input") if isinstance(record.get("input"), dict) else {}
            artifacts.append(
                {
                    "id": f"tool_call:{name}:{len(artifacts) + 1}:{index + 1}",
                    "type": "tool_call",
                    "kind": "tool_call",
                    "version": 1,
                    "status": str(record.get("status") or ""),
                    "name": name,
                    "sideEffect": str(record.get("side_effect") or ""),
                    "signature": f"{name}:{json.dumps(tool_input, sort_keys=True, ensure_ascii=False, default=str)}",
                    "payload": {"input": tool_input},
                }
            )
        return artifacts

    def _mark_waiting_approval_state(self, state: WorkspaceGraphState) -> None:
        run = self.db.get(AIAgentRun, state["run_id"])
        if run is not None:
            run.status = "waiting_approval"
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.last_run_status = "waiting_approval"
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is not None:
            message.status = "waiting_approval"
        self.db.flush()

    def _progressive_draft_publisher(self, state: WorkspaceGraphState):
        def publish(draft_payload: dict[str, Any]) -> dict[str, Any]:
            if self._cancel_requested(state["run_id"]):
                raise AIExecutionCancelled("AI run was cancelled")
            message = self._ensure_progressive_assistant_message(state)
            draft, approval = self.service._create_draft_approval(
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                draft_payload=draft_payload,
            )
            self._mark_waiting_approval_state(state)
            draft_part = {
                "id": f"draft-part-{draft.id}",
                "type": "draft",
                "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
            }
            approval_part = {
                "id": f"approval-part-{approval.id}",
                "type": "approval_request",
                "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
            }
            metadata = dict(message.message_metadata or {})
            draft_id = draft.id
            approval_id = approval.id
            message_id = message.id
            message.message_metadata = {
                **metadata,
                "progressiveDraftIds": [
                    *[str(item) for item in metadata.get("progressiveDraftIds") or [] if str(item)],
                    draft_id,
                ],
                "progressiveApprovalIds": [
                    *[str(item) for item in metadata.get("progressiveApprovalIds") or [] if str(item)],
                    approval_id,
                ],
            }
            self.db.flush()
            if not self._commit_stream_checkpoint(state, run_status="waiting_approval"):
                raise RuntimeError("确认请求持久化失败，请稍后重试")
            for part in (draft_part, approval_part):
                writer = self._persistent_progress_writer(self._optional_stream_writer(), state)
                if writer is not None:
                    writer(
                        {
                            "event": "message_part",
                            "data": {
                                "message_id": message_id,
                                "conversation_id": state["conversation_id"],
                                "run_id": state["run_id"],
                                "part": part,
                            },
                        }
                    )
            return {
                "draft_id": draft_id,
                "approval_id": approval_id,
                "published_part_ids": [draft_part["id"], approval_part["id"]],
            }

        return publish

    def _ensure_progressive_assistant_message(self, state: WorkspaceGraphState) -> AIMessage:
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is not None:
            return message
        message = AIMessage(
            id=create_id("ai_message"),
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            role="assistant",
            content="",
            content_type="parts",
            parts=[],
            run_id=state["run_id"],
            status="running",
            message_metadata={
                "intent": "workspace_orchestrator",
                "agentKey": "workspace_orchestrator",
                "skillKey": None,
            },
            created_by=state["user_id"],
        )
        self.db.add(message)
        self.db.flush()
        return message

    def _persist_assistant_result(
        self,
        state: WorkspaceGraphState,
        result: SkillResult,
        *,
        skill_key: str | None,
        duration_ms: int = 0,
    ) -> AIMessage:
        if self._cancel_requested(state["run_id"]):
            result.status = "cancelled"
            result.cards = []
            result.drafts = []
            result.error = result.error or "用户取消了这次任务"
            if not result.text.strip():
                result.text = "已取消这次任务。"
        assistant_status = "waiting_approval" if result.drafts else result.status
        cards = [] if result.drafts else validate_result_cards(result.cards)
        next_parts = self._base_assistant_parts_from_live_stream(state, result.text, stop_after_first_draft=bool(result.drafts))
        for card in cards:
            next_parts.append({"id": create_id("ai_part"), "type": "result_card", "card": card})
        pending_human_input = (
            result.context_summary.get("pendingHumanInput")
            if isinstance(result.context_summary, dict) and isinstance(result.context_summary.get("pendingHumanInput"), dict)
            else None
        )
        if pending_human_input is not None:
            next_parts.append(
                {
                    "id": create_id("ai_part"),
                    "type": "human_input_request",
                    "request": pending_human_input,
                }
            )
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        metadata = dict(message.message_metadata or {}) if message is not None else {}
        if message is None:
            metadata_intent = "general_chat"
            metadata_agent_key = "general_chat_agent"
            if skill_key is None:
                metadata_intent = "workspace_orchestrator"
                metadata_agent_key = "workspace_orchestrator"
            elif skill_key:
                metadata_intent = self.skill_registry.get(skill_key).manifest.intent
                metadata_agent_key = self.skill_registry.get(skill_key).manifest.agent_key
            metadata = {
                "intent": metadata_intent,
                "agentKey": metadata_agent_key,
                "skillKey": skill_key,
            }
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                role="assistant",
                content=result.text,
                content_type="parts",
                parts=next_parts,
                run_id=state["run_id"],
                status=assistant_status,
                message_metadata=metadata,
                created_by=state["user_id"],
            )
            self.db.add(message)
        else:
            live_text_part_ids = {
                str(part_id)
                for part_id in metadata.get("liveTextPartIds", [])
                if isinstance(part_id, str) and part_id
            }
            existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
            if live_text_part_ids:
                existing_parts = [part for part in existing_parts if str(part.get("id") or "") not in live_text_part_ids]
                metadata.pop("liveStreaming", None)
                metadata.pop("liveTextPartIds", None)
                metadata.pop("livePartIds", None)
            message.parts = self._dedupe_message_parts([*existing_parts, *next_parts])
            if skill_key:
                skill_keys = list(metadata.get("skillKeys") or [])
                if not skill_keys and metadata.get("skillKey"):
                    skill_keys.append(str(metadata["skillKey"]))
                skill_keys.append(skill_key)
                metadata["skillKeys"] = list(dict.fromkeys(item for item in skill_keys if item))
                metadata["skillKey"] = skill_key
            message.message_metadata = metadata
        self.db.flush()
        drafts: list[AITaskDraft] = []
        approvals: list[AIApprovalRequest] = []
        for draft_payload in result.drafts:
            draft_id = str(draft_payload.get("draft_id") or "")
            approval_id = str(draft_payload.get("approval_id") or "")
            draft = self.db.get(AITaskDraft, draft_id) if draft_id else None
            approval = self.db.get(AIApprovalRequest, approval_id) if approval_id else None
            if draft is None or approval is None:
                draft, approval = self.service._create_draft_approval(
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    message_id=message.id,
                    run_id=state["run_id"],
                    draft_payload=draft_payload,
                )
            else:
                draft.message_id = message.id
                draft.source_run_id = state["run_id"]
                approval.message_id = message.id
                approval.run_id = state["run_id"]
                self.db.flush()
                self.db.refresh(draft)
                self.db.refresh(approval)
            drafts.append(draft)
            approvals.append(approval)
            existing_part_ids = {
                str(part.get("id") or "")
                for part in (message.parts or [])
                if isinstance(part, dict)
            }
            draft_part_id = f"draft-part-{draft.id}"
            approval_part_id = f"approval-part-{approval.id}"
            next_draft_parts: list[dict[str, Any]] = []
            if draft_part_id not in existing_part_ids:
                next_draft_parts.append(
                    {
                        "id": draft_part_id,
                        "type": "draft",
                        "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
                    }
                )
            if approval_part_id not in existing_part_ids:
                next_draft_parts.append(
                    {
                        "id": approval_part_id,
                        "type": "approval_request",
                        "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
                    }
                )
            if next_draft_parts:
                message.parts = self._dedupe_message_parts([*(message.parts or []), *next_draft_parts])
        if drafts:
            existing_draft_ids = list(metadata.get("draftIds") or [])
            existing_approval_ids = list(metadata.get("approvalIds") or [])
            message.message_metadata = {
                **metadata,
                "draftIds": [*existing_draft_ids, *[item.id for item in drafts]],
                "approvalIds": [*existing_approval_ids, *[item.id for item in approvals]],
            }
        self._sync_message_parts_with_current_approval_state(message, drafts=drafts, approvals=approvals)
        text_parts = [
            str(part.get("text") or "").strip()
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        ]
        aggregate_text = "\n\n".join(text_parts)
        message.content = aggregate_text
        message.status = assistant_status
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        all_cards = [
            part["card"]
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        if run is not None:
            context_summary = dict(run.context_summary or {})
            context_summary.update(result.context_summary)
            skill_executions = list(context_summary.get("skillExecutions") or [])
            if skill_key:
                skill_executions.append(
                    {
                        "skillKey": skill_key,
                        "operation": result.operation,
                        "sourceArtifactId": result.source_artifact_id,
                        "status": result.status,
                        "diagnostic": result.diagnostic,
                        "requiresClarification": result.requires_clarification,
                        "clarificationQuestionTypes": self._skill_result_clarification_question_types(result, cards),
                        "draftCount": len(drafts),
                    }
                )
            orchestrator_summary = context_summary.get("orchestrator") if isinstance(context_summary.get("orchestrator"), dict) else {}
            raw_injected_skill_keys = (
                orchestrator_summary.get("injectedSkills")
                if isinstance(orchestrator_summary, dict) and isinstance(orchestrator_summary.get("injectedSkills"), list)
                else []
            )
            injected_skill_keys = [
                str(item)
                for item in raw_injected_skill_keys
                if str(item)
            ]
            observation_skill_key = skill_key
            if observation_skill_key is None and len(injected_skill_keys) == 1:
                observation_skill_key = injected_skill_keys[0]
            self._record_skill_observation(
                context_summary,
                skill_key=observation_skill_key,
                result=result,
                cards=cards,
                draft_count=len(drafts),
                approval_count=len(approvals),
            )
            if injected_skill_keys:
                routing = dict(context_summary.get("routing") or {})
                routing["skills"] = injected_skill_keys
                context_summary["routing"] = routing
                if not skill_executions:
                    skill_executions.extend(
                        {
                            "skillKey": key,
                            "operation": result.operation,
                            "sourceArtifactId": result.source_artifact_id,
                            "status": result.status,
                            "diagnostic": result.diagnostic,
                            "requiresClarification": result.requires_clarification,
                            "clarificationQuestionTypes": self._skill_result_clarification_question_types(result, cards),
                            "draftCount": len(drafts),
                        }
                        for key in injected_skill_keys
                    )
            if "lastHumanInputResult" not in context_summary and conversation is not None:
                conversation_context = dict(conversation.context or {})
                task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
                last_human_input_result = task_state.get("lastHumanInputResult") if isinstance(task_state, dict) else None
                if isinstance(last_human_input_result, dict):
                    context_summary["lastHumanInputResult"] = last_human_input_result
            if skill_executions:
                context_summary["skillExecutions"] = skill_executions
            run.status = assistant_status
            if skill_key is None and injected_skill_keys:
                run.intent = (
                    "multi_skill"
                    if len(injected_skill_keys) > 1
                    else self.skill_registry.get(injected_skill_keys[0]).manifest.intent
                )
            elif skill_key is None:
                run.intent = "general_chat"
            run.model = result.model or run.model
            run.output_summary = aggregate_text[:255]
            run.output = self._json_record(
                {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            )
            run.tool_calls = self._json_record([*(run.tool_calls or []), *result.tool_calls])
            run.error = result.error
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
            run.context_summary = self._json_record(context_summary)
        if conversation is not None:
            conversation.prompt = state["message"]
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = assistant_status
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            if result.state_patch:
                task_state = dict(context.get("taskState") or {})
                for key, value in result.state_patch.items():
                    if value is None:
                        task_state.pop(key, None)
                    else:
                        task_state[key] = value
                context["taskState"] = task_state
            conversation.context = self._json_record(context)
        self.db.flush()
        return message

    @staticmethod
    def _json_record(value: Any) -> Any:
        return jsonable_encoder(value)

    @staticmethod
    def _human_input_question_types(result: SkillResult) -> list[str]:
        if not isinstance(result.context_summary, dict):
            return []
        pending = result.context_summary.get("pendingHumanInput")
        if not isinstance(pending, dict):
            return []
        resume_hint = pending.get("resumeHint") if isinstance(pending.get("resumeHint"), dict) else {}
        question_type = str(resume_hint.get("questionType") or pending.get("questionType") or "").strip()
        return [question_type or "human_input"]

    def _skill_result_clarification_question_types(
        self,
        result: SkillResult,
        cards: list[dict[str, Any]],
    ) -> list[str]:
        del cards
        return self._human_input_question_types(result)

    def _record_skill_observation(
        self,
        context_summary: dict[str, Any],
        *,
        skill_key: str | None,
        result: SkillResult,
        cards: list[dict[str, Any]],
        draft_count: int,
        approval_count: int,
    ) -> None:
        metrics = dict(context_summary.get("runMetrics") or {})
        if skill_key:
            metrics["skillExecutionCount"] = int(metrics.get("skillExecutionCount") or 0) + 1
        if result.status == "completed":
            metrics["completedSkillExecutionCount"] = int(metrics.get("completedSkillExecutionCount") or 0) + (1 if skill_key else 0)
        metrics["toolCallCount"] = int(metrics.get("toolCallCount") or 0) + len(result.tool_calls)
        metrics["draftCount"] = int(metrics.get("draftCount") or 0) + draft_count
        metrics["approvalRequestCount"] = int(metrics.get("approvalRequestCount") or 0) + approval_count

        clarification_types = self._skill_result_clarification_question_types(result, cards)
        if clarification_types:
            metrics["clarificationCount"] = int(metrics.get("clarificationCount") or 0) + len(clarification_types)
            clarification = dict(context_summary.get("clarificationStats") or {})
            reasons = dict(clarification.get("reasons") or {})
            for question_type in clarification_types:
                reasons[question_type] = int(reasons.get(question_type) or 0) + 1
            clarification["count"] = int(clarification.get("count") or 0) + len(clarification_types)
            clarification["reasons"] = reasons
            clarification["lastQuestionTypes"] = clarification_types
            if skill_key:
                by_skill = dict(clarification.get("bySkill") or {})
                by_skill[skill_key] = int(by_skill.get(skill_key) or 0) + len(clarification_types)
                clarification["bySkill"] = by_skill
            context_summary["clarificationStats"] = clarification

        context_summary["runMetrics"] = metrics

    @staticmethod
    def _record_approval_outcome(run: AIAgentRun, *, approval_status: str, draft_type: str) -> None:
        context_summary = dict(run.context_summary or {})
        metrics = dict(context_summary.get("runMetrics") or {})
        if approval_status == "approved":
            metrics["approvalApprovedCount"] = int(metrics.get("approvalApprovedCount") or 0) + 1
        elif approval_status == "rejected":
            metrics["approvalRejectedCount"] = int(metrics.get("approvalRejectedCount") or 0) + 1
        context_summary["runMetrics"] = metrics

        approvals = dict(context_summary.get("approvalStats") or {})
        by_draft_type = dict(approvals.get("byDraftType") or {})
        if draft_type:
            bucket = dict(by_draft_type.get(draft_type) or {})
            bucket[approval_status] = int(bucket.get(approval_status) or 0) + 1
            by_draft_type[draft_type] = bucket
        approvals["byDraftType"] = by_draft_type
        approvals["lastDecision"] = {"status": approval_status, "draftType": draft_type or None}
        context_summary["approvalStats"] = approvals
        run.context_summary = context_summary

    def _stream_graph_events(
        self,
        graph_stream: Any,
        *,
        handle_update: Any,
        seen_event_ids: set[str],
        on_disconnect: Any,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        event_queue: Queue[Any] = Queue()
        previous_sink = self._direct_stream_sink

        def enqueue(event: str, data: dict[str, Any]) -> None:
            if event == "progress" and isinstance(data.get("id"), str):
                seen_event_ids.add(data["id"])
            event_queue.put((event, data))

        def consume_graph() -> None:
            self._direct_stream_sink = enqueue
            try:
                for chunk in graph_stream():
                    mode, update = chunk if isinstance(chunk, tuple) else ("updates", chunk)
                    if mode == "custom":
                        event, data = self._custom_stream_event(update)
                        if event:
                            enqueue(event, data)
                        continue
                    if mode != "updates":
                        continue
                    for event, data in handle_update(update):
                        enqueue(event, data)
            except BaseException as exc:
                event_queue.put(exc)
            finally:
                self._direct_stream_sink = previous_sink
                event_queue.put(_STREAM_DONE)

        worker = Thread(target=consume_graph, name="ai-workspace-stream", daemon=True)
        worker.start()
        try:
            while True:
                item = event_queue.get()
                if item is _STREAM_DONE:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        except GeneratorExit:
            on_disconnect()
            raise
        finally:
            worker.join(timeout=1)


    def _stream_approval_followup(
        self,
        state: WorkspaceGraphState,
        decision_result: dict[str, Any],
        *,
        terminal_status: str,
    ) -> None:
        approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
        message_id = str(approval.get("message_id") or "")
        message = self.db.get(AIMessage, message_id) if message_id else None
        if message is None:
            message = self.db.scalar(
                select(AIMessage)
                .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
                .order_by(AIMessage.created_at.desc(), AIMessage.id.desc())
            )
        if message is None:
            logger.warning(
                "AI graph approval follow-up skipped because assistant message is missing run_id=%s conversation_id=%s family_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
            )
            return

        part_id = create_id("ai_part")
        chunks: list[str] = []
        writer = self._persistent_progress_writer(self._optional_stream_writer(), state)
        system = """
        你是 Culina 的厨房助手。你刚收到一个 HumanInLoop 工具的返回结果，这个工具表示用户对你前面生成的确认表单做出了批准或拒绝。

        请把这个工具结果当成普通工具调用结果继续对话：
        1. 用自然、简短、可执行的话接着前文回复。
        2. 如果用户批准并且操作成功，说明结果已按用户确认处理。
        3. 如果用户拒绝，尊重这个决定，说明不会按这个草稿写入，并提示可以继续调整或重新整理。
        4. 不要编造没有发生的写入、删除、修改；只依据输入里的 approval、draft、operation、business_entity。
        5. 不要输出 JSON，不要重复表单内容。
        """.strip()
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        payload = {
            "currentMessage": state.get("message") or "",
            "terminalStatus": terminal_status,
            "humanInLoopTool": {
                "name": "approval.decision",
                "result": decision_result,
            },
            "conversation": timeline,
            "subject": state.get("subject") or {},
        }
        try:
            for chunk in self.provider.stream_generate(
                system=system,
                user=json.dumps(payload, ensure_ascii=False, default=str),
            ):
                if self._cancel_requested(state["run_id"]):
                    raise AIExecutionCancelled("AI run was cancelled")
                if not chunk:
                    continue
                chunks.append(chunk)
                if writer is not None:
                    writer(
                        {
                            "event": "message_delta",
                            "data": {
                                "message_id": message.id,
                                "conversation_id": state["conversation_id"],
                                "run_id": state["run_id"],
                                "part_id": part_id,
                                "delta": chunk,
                            },
                        }
                    )
        except AIExecutionCancelled:
            raise
        except Exception as exc:
            logger.warning(
                "AI graph approval follow-up model failed run_id=%s conversation_id=%s family_id=%s error=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                exc,
            )
            return

        text = "".join(chunks).strip()
        if not text:
            return
        self._append_text_to_assistant_message(
            state,
            message,
            part_id=part_id,
            text=text,
            status=terminal_status,
        )

    def _optional_stream_writer(self):
        try:
            return get_stream_writer()
        except Exception:
            return None

    def _append_text_to_assistant_message(
        self,
        state: WorkspaceGraphState,
        message: AIMessage,
        *,
        part_id: str,
        text: str,
        status: str,
    ) -> None:
        existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        existing_parts = [part for part in existing_parts if str(part.get("id") or "") != part_id]
        message.parts = [*existing_parts, {"id": part_id, "type": "text", "text": text}]
        metadata = dict(message.message_metadata or {})
        live_text_part_ids = [
            str(item)
            for item in metadata.get("liveTextPartIds", [])
            if isinstance(item, str) and item != part_id
        ]
        if live_text_part_ids:
            metadata["liveTextPartIds"] = live_text_part_ids
        else:
            metadata.pop("liveTextPartIds", None)
            metadata.pop("livePartIds", None)
            metadata.pop("liveStreaming", None)
        message.message_metadata = metadata
        text_parts = [
            str(part.get("text") or "").strip()
            for part in message.parts
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        ]
        aggregate_text = "\n\n".join(text_parts)
        message.content = aggregate_text
        message.content_type = "parts"
        message.status = status

        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        all_cards = [
            part["card"]
            for part in message.parts
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        if run is not None:
            run.status = status
            run.model = getattr(self.provider, "model_name", "") or run.model
            run.output_summary = aggregate_text[:255]
            run.output = self._json_record(
                {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            )
            run.error = state.get("error")
        if conversation is not None:
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = status
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            conversation.context = self._json_record(context)
        self.db.flush()

    def _finalize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        status = str(state.get("status") or "completed")
        if self._cancel_requested(state["run_id"]):
            status = "cancelled"
        if status == "running":
            status = "completed"
        logger.info(
            "AI graph finalizing run_id=%s conversation_id=%s family_id=%s status=%s error=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            state.get("error"),
        )
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
        )
        if message is None:
            text = "AI 工作台暂时失败，请重试。" if status == "failed" else "任务已结束。"
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                role="assistant",
                content=text,
                content_type="parts",
                parts=[{"id": create_id("ai_part"), "type": "text", "text": text}],
                run_id=state["run_id"],
                status=status,
                message_metadata={"intent": run.intent if run is not None else "workspace_orchestrator", "agentKey": "workspace_orchestrator"},
                created_by=state["user_id"],
            )
            self.db.add(message)
        if run is not None and run.status != "waiting_approval":
            run.status = status
            run.error = state.get("error")
            if not run.output_summary:
                run.output_summary = message.content[:255]
                run.output = self._json_record({"text": message.content, "cards": [], "routing": (run.context_summary or {}).get("routing", {})})
        if conversation is not None and conversation.last_run_status != "waiting_approval":
            conversation.last_run_status = status
            conversation.last_message_at = utcnow()
            if not conversation.response:
                conversation.response = message.content
                conversation.summary = message.content[:255]
        self.db.flush()
        logger.info(
            "AI graph finalized run_id=%s conversation_id=%s family_id=%s status=%s run_status=%s conversation_status=%s message_id=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            run.status if run is not None else None,
            conversation.last_run_status if conversation is not None else None,
            message.id,
        )
        return {"status": status}

    def _route_after_orchestrator(self, state: WorkspaceGraphState) -> str:
        if state.get("status") == "running":
            return "orchestrator"
        if state.get("status") == "waiting_approval":
            return "approval_interrupt"
        if state.get("status") == "waiting_input":
            return "human_input_interrupt"
        return "finalize"

    def _approval_interrupt_payload(self, approval: AIApprovalRequest) -> dict[str, Any]:
        return {
            "type": "approval_required",
            "conversationId": approval.conversation_id,
            "runId": approval.run_id,
            "approvalId": approval.id,
            "draftId": approval.draft_id,
            "draftVersion": approval.draft_version,
            "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
        }

    def _human_input_interrupt_payload(self, state: WorkspaceGraphState, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "human_input_required",
            "conversationId": state["conversation_id"],
            "runId": state["run_id"],
            "requestId": request.get("id"),
            "request": jsonable_encoder(request),
        }

    def _chat_response(self, conversation_id: str, run_id: str) -> dict[str, Any]:
        run = self.db.get(AIAgentRun, run_id)
        if run is None:
            raise RuntimeError("LangGraph 没有创建运行记录")
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == run_id, AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
            .execution_options(populate_existing=True)
        )
        if message is None:
            raise RuntimeError("LangGraph 没有创建助手消息")
        events = list(
            self.db.scalars(
                select(AIRunEvent)
                .where(AIRunEvent.run_id == run_id)
                .order_by(AIRunEvent.created_at.asc())
                .execution_options(populate_existing=True)
            )
        )
        drafts = list(
            self.db.scalars(
                select(AITaskDraft)
                .where(AITaskDraft.source_run_id == run_id)
                .order_by(AITaskDraft.created_at.asc())
                .execution_options(populate_existing=True)
            )
        )
        approvals = list(
            self.db.scalars(
                select(AIApprovalRequest)
                .where(AIApprovalRequest.run_id == run_id)
                .order_by(AIApprovalRequest.created_at.asc())
                .execution_options(populate_existing=True)
            )
        )
        self._sync_message_parts_with_current_approval_state(message, drafts=drafts, approvals=approvals)
        self.db.flush()
        cards = [
            part["card"]
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        return {
            "conversation_id": conversation_id,
            "message": serialize_ai_message(message),
            "run": serialize_ai_run(run),
            "events": [serialize_ai_run_event(event) for event in events],
            "included": {
                "result_cards": cards,
                "drafts": [serialize_ai_task_draft(draft) for draft in drafts],
                "approvals": [serialize_ai_approval_request(approval) for approval in approvals],
            },
        }

    def _new_progress_events(self, run_id: str, seen_event_ids: set[str]) -> Iterator[tuple[str, dict[str, Any]]]:
        events = list(
            self.db.scalars(
                select(AIRunEvent)
                .where(AIRunEvent.run_id == run_id)
                .order_by(AIRunEvent.created_at.asc(), AIRunEvent.id.asc())
            )
        )
        for event in events:
            if event.id in seen_event_ids:
                continue
            seen_event_ids.add(event.id)
            yield ("progress", serialize_ai_run_event(event))

    def _persistent_progress_writer(self, writer: Any, state: WorkspaceGraphState) -> Any:
        def write(update: dict[str, Any]) -> None:
            event_name, data = self._custom_stream_event(update)
            direct_sink = self._direct_stream_sink

            def emit(event: str, payload: dict[str, Any]) -> None:
                if direct_sink is not None:
                    direct_sink(event, payload)
                    return
                if writer is not None:
                    writer({"event": event, "data": payload})

            if event_name == "message_delta":
                data = self._cache_live_message_delta(state, data)
                emit("message_delta", data)
                return
            if event_name == "message_part":
                data = self._cache_live_message_part(state, data)
                emit("message_part", data)
                return
            if event_name != "progress":
                if event_name:
                    emit(event_name, data)
                elif writer is not None:
                    writer(update)
                return

            event_id = str(data.get("id") or create_id("ai_run_event"))
            event = self.db.get(AIRunEvent, event_id)
            if event is None:
                event = AIRunEvent(
                    id=event_id,
                    family_id=state["family_id"],
                    conversation_id=state["conversation_id"],
                    run_id=str(data.get("run_id") or state["run_id"]),
                    type=str(data.get("type") or "event"),
                    internal_code=str(data.get("internal_code") or "progress"),
                    user_message=str(data.get("user_message") or ""),
                    status=str(data.get("status") or "running"),
                    payload={},
                )
                self.db.add(event)
                self.db.flush()
                self._commit_stream_checkpoint(state, run_status=str(data.get("status") or "running"))
            else:
                event.run_id = str(data.get("run_id") or event.run_id or state["run_id"])
                event.type = str(data.get("type") or event.type or "event")
                event.internal_code = str(data.get("internal_code") or event.internal_code or "progress")
                event.user_message = str(data.get("user_message") or event.user_message or "")
                event.status = str(data.get("status") or event.status or "running")
                self.db.flush()
                self._commit_stream_checkpoint(state, run_status=event.status)
            serialized_event = serialize_ai_run_event(event)
            message_id, part = self._cache_live_activity_part(state, serialized_event)
            emit(
                "message_part",
                {
                    "message_id": message_id,
                    "conversation_id": state["conversation_id"],
                    "run_id": event.run_id,
                    "part": part,
                },
            )
            emit("progress", serialized_event)

        return write

    def _cache_live_message_delta(self, state: WorkspaceGraphState, data: dict[str, Any]) -> dict[str, Any]:
        delta = str(data.get("delta") or "")
        if not delta:
            return data
        message_id = self._live_message_id(state, data)
        part_id = str(data.get("part_id") or "").strip() or create_id("ai_part")
        run_id = str(data.get("run_id") or state["run_id"])
        message_id, part_id = live_ai_stream_cache.append_delta(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            run_id=run_id,
            message_id=message_id,
            part_id=part_id,
            delta=delta,
            created_by=state.get("user_id"),
        )
        return {
            **data,
            "message_id": message_id,
            "conversation_id": state["conversation_id"],
            "run_id": run_id,
            "part_id": part_id,
        }

    def _cache_live_activity_part(self, state: WorkspaceGraphState, event: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        run_id = str(event.get("run_id") or state["run_id"])
        part = {
            "id": f"activity-{event.get('id') or create_id('ai_run_event')}",
            "type": "run_activity",
            "activity": event,
        }
        return live_ai_stream_cache.append_activity(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            run_id=run_id,
            message_id=self._live_message_id(state, {}),
            part=jsonable_encoder(part),
            created_by=state.get("user_id"),
        )

    def _cache_live_message_part(self, state: WorkspaceGraphState, data: dict[str, Any]) -> dict[str, Any]:
        part = data.get("part") if isinstance(data.get("part"), dict) else {}
        if not part:
            return data
        if not str(part.get("id") or "").strip():
            part = {**part, "id": create_id("ai_part")}
        run_id = str(data.get("run_id") or state["run_id"])
        message_id, cached_part = live_ai_stream_cache.append_part(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            run_id=run_id,
            message_id=self._live_message_id(state, data),
            part=jsonable_encoder(part),
            created_by=state.get("user_id"),
        )
        return {
            **data,
            "message_id": message_id,
            "conversation_id": state["conversation_id"],
            "run_id": run_id,
            "part": cached_part,
        }

    def _live_message_id(self, state: WorkspaceGraphState, data: dict[str, Any]) -> str:
        return str(data.get("message_id") or "").strip() or f"{state['run_id']}:assistant"

    @staticmethod
    def _dedupe_message_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for part in parts:
            if not isinstance(part, dict):
                continue
            part_id = str(part.get("id") or "").strip()
            if part_id:
                if part_id in seen_ids:
                    continue
                seen_ids.add(part_id)
            deduped.append(part)
        return deduped

    @staticmethod
    def _sync_message_parts_with_current_approval_state(
        message: AIMessage,
        *,
        drafts: list[AITaskDraft],
        approvals: list[AIApprovalRequest],
    ) -> None:
        if not message.parts:
            return
        drafts_by_id = {draft.id: jsonable_encoder(serialize_ai_task_draft(draft)) for draft in drafts}
        approvals_by_id = {approval.id: jsonable_encoder(serialize_ai_approval_request(approval)) for approval in approvals}
        next_parts: list[dict[str, Any]] = []
        changed = False
        for part in message.parts:
            if not isinstance(part, dict):
                next_parts.append(part)
                continue
            if part.get("type") == "draft":
                draft_id = str((part.get("draft") or {}).get("id") or "")
                current = drafts_by_id.get(draft_id)
                if current is not None and part.get("draft") != current:
                    next_parts.append({**part, "draft": current})
                    changed = True
                    continue
            if part.get("type") == "approval_request":
                approval_id = str((part.get("approval") or {}).get("id") or "")
                current = approvals_by_id.get(approval_id)
                if current is not None and part.get("approval") != current:
                    next_parts.append({**part, "approval": current})
                    changed = True
                    continue
            next_parts.append(part)
        if changed:
            message.parts = next_parts

    def _base_assistant_parts_from_live_stream(
        self,
        state: WorkspaceGraphState,
        result_text: str,
        *,
        stop_after_first_draft: bool = False,
    ) -> list[dict[str, Any]]:
        live_parts = live_ai_stream_cache.parts_for_run(state.get("run_id"))
        if not live_parts:
            return [{"id": create_id("ai_part"), "type": "text", "text": result_text}]
        parts = [dict(part) for part in live_parts if isinstance(part, dict)]
        first_draft_index: int | None = None
        if stop_after_first_draft:
            first_draft_index = next(
                (
                    index
                    for index, part in enumerate(parts)
                    if part.get("type") in {"draft", "approval_request"}
                ),
                None,
            )
            if first_draft_index is not None:
                parts = parts[:first_draft_index]
        live_text = "\n\n".join(
            str(part.get("text") or "").strip()
            for part in parts
            if part.get("type") == "text" and str(part.get("text") or "").strip()
        )
        final_text = (result_text or "").strip()
        if stop_after_first_draft:
            if final_text and not live_text and first_draft_index is None:
                parts.append({"id": create_id("ai_part"), "type": "text", "text": result_text})
            return parts
        if final_text and not live_text:
            parts.append({"id": create_id("ai_part"), "type": "text", "text": result_text})
        elif final_text and final_text.startswith(live_text) and final_text != live_text:
            tail = final_text[len(live_text):].strip()
            if tail:
                parts.append({"id": create_id("ai_part"), "type": "text", "text": tail})
        return parts

    def _commit_stream_checkpoint(self, state: WorkspaceGraphState, *, run_status: str) -> bool:
        try:
            self.db.commit()
            return True
        except Exception:
            self.db.rollback()
            logger.exception(
                "AI graph failed to persist stream checkpoint run_id=%s conversation_id=%s family_id=%s status=%s",
                state.get("run_id"),
                state.get("conversation_id"),
                state.get("family_id"),
                run_status,
            )
            return False


    def _run_id_from_update(self, update: Any) -> str:
        if not isinstance(update, dict):
            return ""
        direct = update.get("run_id")
        if isinstance(direct, str) and direct:
            return direct
        for value in update.values():
            if not isinstance(value, dict):
                continue
            candidate = value.get("run_id")
            if isinstance(candidate, str) and candidate:
                return candidate
        return ""

    def _custom_stream_event(self, update: Any) -> tuple[str, dict[str, Any]]:
        if not isinstance(update, dict):
            return "", {}
        event = update.get("event")
        data = update.get("data")
        if not isinstance(event, str) or not event:
            return "", {}
        if not isinstance(data, dict):
            return "", {}
        return event, data

    def _config(self, conversation_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": conversation_id}}
