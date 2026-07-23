from __future__ import annotations

from collections.abc import Callable, Iterator
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
from sqlalchemy.orm import Session

from app.ai.observability.tracer import AIRunTracer
from app.ai.skills import SkillResult, build_workspace_skill_registry
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.conversations import (
    require_conversation,
)
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.runner_support.assistant_result_persister import AssistantResultPersister
from app.ai.workflows.runner_support.approval_resume_handler import ApprovalResumeHandler
from app.ai.workflows.runner_support.approval_resume_preparer import ApprovalResumePreparer
from app.ai.workflows.runner_support.approval_resume import (
    approval_resume_draft_id,
    approval_resume_artifact,
    approval_resume_payload_from_metadata,
    continuation_artifact,
    continuation_from_metadata,
)
from app.ai.workflows.runner_support.approval_followup_streamer import ApprovalFollowupStreamer
from app.ai.workflows.runner_support.human_input_resume_handler import HumanInputResumeHandler
from app.ai.workflows.runner_support.human_input_resume_preparer import HumanInputResumePreparer
from app.ai.workflows.runner_support.graph_state_builder import GraphStateBuilder
from app.ai.workflows.runner_support.graph_run_initializer import GraphRunInitializer
from app.ai.workflows.runner_support.attachments import (
    normalize_chat_attachments,
)
from app.ai.workflows.runner_support.message_persistence import sync_message_parts_with_current_approval_state
from app.ai.workflows.runner_support.message_preparation import message_summary
from app.ai.workflows.runner_support.orchestrator_node import OrchestratorNode
from app.ai.workflows.runner_support.progressive_draft_publisher import ProgressiveDraftPublisher
from app.ai.workflows.runner_support.runtime_failure_persister import RuntimeFailurePersister
from app.ai.workflows.runner_support.runner_runtime_context import RunnerRuntimeContext
from app.ai.workflows.runner_support.stream_bridge import consume_stream_graph_worker, enqueue_stream_event
from app.ai.workflows.runner_support.user_message_preparer import UserMessagePreparer
from app.ai.workflows.orchestrator.profiles import (
    ORCHESTRATOR_PROFILE_REGISTRY,
    OrchestratorProfile,
    profile_with_skill_route_hints,
    validate_orchestrator_profile_registry,
)
from app.ai.workflows.runner_support.run_summary import (
    record_approval_outcome_summary,
)
from app.ai.workflows.runner_support.run_finalizer import RunFinalizer
from app.ai.workflows.runner_support.run_status import (
    CANCELLED,
    CANCELLING,
    COMPLETED,
    FAILED,
    PENDING,
    RUNNING,
    WAITING_APPROVAL,
    WAITING_INPUT,
)
from app.ai.workflows.orchestrator.signatures import tool_signature
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import create_id
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIRunEvent,
    AIRunTraceSpan,
    AITaskDraft,
)
from app.services.ai_operations.run_cancellation import is_run_cancellation_requested
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_run,
    serialize_ai_run_event,
    serialize_ai_task_draft,
)

if TYPE_CHECKING:
    from app.ai.workspace_service import AIApplicationService

logger = logging.getLogger(__name__)
MAX_AGENT_ROUNDS = 30
_STREAM_DONE = object()

# Transaction boundary:
# - Request-owned synchronous graph work keeps node helpers at flush-only; the
#   graph.invoke call returns after LangGraph/checkpointer and the request
#   session can commit together.
# - Stream graph work runs in a background worker with its own Session, so the
#   worker commits after graph completion and after final response assembly.
# - Preparation and runtime-exception recovery are durable boundary operations:
#   the prepared running run must exist before graph execution, and a failed
#   recovery must clear activeRunId even when the graph raised.


def _elapsed_ms(started_at: float) -> int:
    return int((perf_counter() - started_at) * 1000)

class WorkspaceGraphRunner:
    def __init__(self, service: AIApplicationService) -> None:
        self.service = service
        self.db = service.db
        self.provider = service.provider
        self.skill_registry = build_workspace_skill_registry()
        validate_orchestrator_profile_registry(ORCHESTRATOR_PROFILE_REGISTRY, self.skill_registry)
        self.checkpointer = SQLAlchemyCheckpointSaver(self.db)
        self.graph = self._build_graph()
        self.graph_state_builder = GraphStateBuilder()
        self.runtime_context = RunnerRuntimeContext(
            db=self.db,
            provider=self.provider,
            service=self.service,
            skill_registry=self.skill_registry,
            checkpointer=self.checkpointer,
            json_record=self._json_record,
            cancel_requested=self._cancel_requested,
            commit_stream_checkpoint=self._commit_stream_checkpoint,
            optional_stream_writer=self._optional_stream_writer,
            persistent_progress_writer=self._persistent_progress_writer,
            tracer_for_state=self._tracer_for_state,
        )
        self.graph_run_initializer = GraphRunInitializer(db=self.db)
        self.user_message_preparer = UserMessagePreparer(
            db=self.db,
            provider=self.provider,
            json_record=self._json_record,
        )
        self.runtime_failure_persister = RuntimeFailurePersister(
            db=self.db,
            json_record=self._json_record,
        )
        self.approval_resume_preparer = ApprovalResumePreparer(
            db=self.db,
            graph=self.graph,
            config_for_conversation=self._config,
            build_resume_payload=self.graph_state_builder.build_approval_resume_payload,
        )
        self.human_input_resume_preparer = HumanInputResumePreparer(
            db=self.db,
            graph=self.graph,
            config_for_conversation=self._config,
            build_resume_payload=self.graph_state_builder.build_human_input_resume_payload,
        )
        self.progressive_draft_publisher = ProgressiveDraftPublisher(
            db=self.db,
            service=self.service,
            cancel_requested=self._cancel_requested,
            commit_stream_checkpoint=self._commit_stream_checkpoint,
            optional_stream_writer=self._optional_stream_writer,
            persistent_progress_writer=self._persistent_progress_writer,
        )
        self.approval_followup_streamer = ApprovalFollowupStreamer(
            db=self.db,
            provider=self.provider,
            json_record=self._json_record,
            cancel_requested=self._cancel_requested,
            tracer_for_state=self._tracer_for_state,
            optional_stream_writer=self._optional_stream_writer,
            persistent_progress_writer=self._persistent_progress_writer,
        )
        self.assistant_result_persister = AssistantResultPersister(self)
        self.approval_resume_handler = ApprovalResumeHandler(self)
        self.human_input_resume_handler = HumanInputResumeHandler(self)
        self.orchestrator_node = OrchestratorNode(self)
        self.run_finalizer = RunFinalizer(self, max_agent_rounds=MAX_AGENT_ROUNDS)
        self._direct_stream_sink: Any = None

    def _orchestrator_profile_for_run(
        self,
        *,
        quick_task: str | None,
        subject: dict[str, Any],
    ) -> tuple[OrchestratorProfile, list[str]]:
        profile = ORCHESTRATOR_PROFILE_REGISTRY.resolve(
            quick_task=quick_task,
            subject=subject,
        )
        profile = profile_with_skill_route_hints(profile, self.skill_registry)
        return profile, profile.initial_skill_keys_for(
            quick_task=quick_task,
            subject=subject,
        )

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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> dict[str, Any]:
        prompt = message.strip()
        normalized_attachments = normalize_chat_attachments(attachments)
        if not prompt and not normalized_attachments:
            raise ValueError("消息不能为空")
        contracts = frozenset(generation_contracts or ())
        message_summary_text = message_summary(prompt, len(normalized_attachments))
        prepare_started_at = perf_counter()
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            message_summary=message_summary_text,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
            attachments=normalized_attachments,
        )
        logger.info(
            "AI graph prepare completed family_id=%s user_id=%s conversation_id=%s run_id=%s existing=%s attachment_count=%s prepare_ms=%s",
            family_id,
            user_id,
            prepared["conversation_id"],
            prepared["run_id"],
            prepared["existing"],
            len(prepared.get("attachments") or []),
            _elapsed_ms(prepare_started_at),
        )
        if prepared["existing"]:
            return self._chat_response(prepared["conversation_id"], prepared["run_id"])
        conversation_id = prepared["conversation_id"]
        config = self._config(conversation_id)
        orchestrator_profile, initial_skill_keys = self._orchestrator_profile_for_run(
            quick_task=quick_task,
            subject=prepared["subject"],
        )
        logger.info(
            "AI graph invoke started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation_id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        try:
            output = self.graph.invoke(
                self.graph_state_builder.build_initial_state(
                    family_id=family_id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    prompt=prompt,
                    attachments=prepared["attachments"],
                    client_message_id=client_message_id,
                    client_run_id=client_run_id,
                    quick_task=quick_task,
                    subject=prepared["subject"],
                    orchestrator_profile=orchestrator_profile,
                    initial_skill_keys=initial_skill_keys,
                    run_id=prepared["run_id"],
                    user_message_id=prepared["user_message_id"],
                    generation_contracts=contracts,
                ),
                config=config,
                durability="sync",
            )
        except Exception as exc:
            logger.exception(
                "AI graph invoke failed family_id=%s user_id=%s conversation_id=%s run_id=%s",
                family_id,
                user_id,
                conversation_id,
                prepared["run_id"],
            )
            self.runtime_failure_persister.mark_failed(
                run_id=prepared["run_id"],
                conversation_id=conversation_id,
                family_id=family_id,
                user_id=user_id,
                error=str(exc),
            )
            return self._chat_response(conversation_id, prepared["run_id"])
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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        prompt = message.strip()
        normalized_attachments = normalize_chat_attachments(attachments)
        if not prompt and not normalized_attachments:
            raise ValueError("消息不能为空")
        contracts = frozenset(generation_contracts or ())
        message_summary_text = message_summary(prompt, len(normalized_attachments))
        prepare_started_at = perf_counter()
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            message_summary=message_summary_text,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
            attachments=normalized_attachments,
        )
        logger.info(
            "AI graph prepare completed family_id=%s user_id=%s conversation_id=%s run_id=%s existing=%s attachment_count=%s prepare_ms=%s",
            family_id,
            user_id,
            prepared["conversation_id"],
            prepared["run_id"],
            prepared["existing"],
            len(prepared.get("attachments") or []),
            _elapsed_ms(prepare_started_at),
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
            generation_contracts=contracts,
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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        conversation_id = str(prepared["conversation_id"])
        config = self._config(conversation_id)
        run_id = str(prepared["run_id"])
        contracts = frozenset(generation_contracts or ())
        orchestrator_profile, initial_skill_keys = self._orchestrator_profile_for_run(
            quick_task=quick_task,
            subject=prepared["subject"],
        )
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
            def graph_stream(runner: WorkspaceGraphRunner) -> Iterator[Any]:
                return runner.graph.stream(
                    runner.graph_state_builder.build_initial_state(
                        family_id=family_id,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        prompt=prompt,
                        attachments=attachments,
                        client_message_id=client_message_id,
                        client_run_id=client_run_id,
                        quick_task=quick_task,
                        subject=prepared["subject"],
                        orchestrator_profile=orchestrator_profile,
                        initial_skill_keys=initial_skill_keys,
                        run_id=run_id,
                        user_message_id=prepared["user_message_id"],
                        generation_contracts=contracts,
                    ),
                    config=config,
                    stream_mode=["updates", "custom"],
                    durability="sync",
                )

            def log_completed(final_run_id: str) -> None:
                logger.info(
                    "AI graph stream completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
                    family_id,
                    user_id,
                    conversation_id,
                    final_run_id,
                )

            yield from self._stream_graph_with_response(
                graph_stream,
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                config=config,
                run_id=run_id,
                flow="user_message",
                seen_event_ids=seen_event_ids,
                on_completed=log_completed,
            )
        except GeneratorExit:
            raise
        except Exception:
            raise

    def _stream_graph_with_response(
        self,
        graph_stream: Callable[["WorkspaceGraphRunner"], Iterator[Any]],
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        config: dict[str, Any],
        run_id: str,
        flow: str,
        seen_event_ids: set[str],
        before_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        handle_update_extra: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        require_run_id: bool = False,
        on_completed: Callable[[str], None] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        current_run_id = run_id

        def handle_update(runner: WorkspaceGraphRunner, update: Any) -> Iterator[tuple[str, dict[str, Any]]]:
            nonlocal current_run_id
            if not current_run_id:
                current_run_id = runner._run_id_from_update(update) or current_run_id
            if handle_update_extra is not None:
                yield from handle_update_extra(runner)
            if current_run_id:
                yield from runner._new_progress_events(current_run_id, seen_event_ids)

        def after_graph(runner: WorkspaceGraphRunner) -> Iterator[tuple[str, dict[str, Any]]]:
            nonlocal current_run_id
            if not current_run_id:
                state = runner.graph.get_state(config)
                current_run_id = str(state.values.get("run_id") or "")
            if not current_run_id and require_run_id:
                raise RuntimeError("LangGraph 恢复后没有运行记录")
            if current_run_id:
                yield from runner._new_progress_events(current_run_id, seen_event_ids)
            if on_completed is not None:
                on_completed(current_run_id)
            yield ("response", runner._chat_response(conversation_id, current_run_id))

        def on_worker_exception(runner: WorkspaceGraphRunner, exc: BaseException) -> None:
            if current_run_id:
                runner.runtime_failure_persister.mark_failed(
                    run_id=current_run_id,
                    conversation_id=conversation_id,
                    family_id=family_id,
                    user_id=user_id,
                    error=str(exc),
                )

        yield from self._stream_graph_events(
            graph_stream,
            handle_update=handle_update,
            seen_event_ids=seen_event_ids,
            on_disconnect=lambda: self._keep_running_after_disconnect(current_run_id),
            before_graph=before_graph,
            after_graph=after_graph,
            on_worker_exception=on_worker_exception,
            perf_context={
                "flow": flow,
                "family_id": family_id,
                "user_id": user_id,
                "conversation_id": conversation_id,
                "run_id": current_run_id,
            },
        )

    @staticmethod
    def _resume_command(
        *,
        resume_payload: dict[str, Any],
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> Command:
        return Command(
            update={"generation_contracts": sorted(frozenset(generation_contracts or ()))},
            resume=resume_payload,
        )

    def _resume_graph_stream(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        config: dict[str, Any],
        resume_payload: dict[str, Any],
        run_id: str,
        flow: str,
        seen_event_ids: set[str],
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
        before_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        handle_update_extra: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        require_run_id: bool = False,
        on_completed: Callable[[str], None] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        contracts = frozenset(generation_contracts or ())

        def graph_stream(runner: WorkspaceGraphRunner) -> Iterator[Any]:
            return runner.graph.stream(
                runner._resume_command(resume_payload=resume_payload, generation_contracts=contracts),
                config=config,
                stream_mode=["updates", "custom"],
                durability="sync",
            )

        yield from self._stream_graph_with_response(
            graph_stream,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            config=config,
            run_id=run_id,
            flow=flow,
            seen_event_ids=seen_event_ids,
            before_graph=before_graph,
            handle_update_extra=handle_update_extra,
            require_run_id=require_run_id,
            on_completed=on_completed,
        )

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
        return self.user_message_preparer.prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            message_summary=message_summary,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
            attachments=attachments,
        ).to_dict()

    def _cancel_requested(self, run_id: str) -> bool:
        bind = self.db.get_bind()
        if bind.dialect.name == "sqlite":
            self.db.expire_all()
            run = self.db.scalar(
                select(AIAgentRun)
                .where(AIAgentRun.id == run_id)
                .execution_options(populate_existing=True)
            )
            if run is None:
                return False
            return run.status in {CANCELLING, CANCELLED} or is_run_cancellation_requested(
                self.db,
                family_id=run.family_id,
                run_id=run.id,
            )
        with Session(bind=bind) as db:
            run = db.get(AIAgentRun, run_id)
            if run is None:
                return False
            return run.status in {CANCELLING, CANCELLED} or is_run_cancellation_requested(
                db,
                family_id=run.family_id,
                run_id=run.id,
            )

    def _keep_running_after_disconnect(self, run_id: str | None) -> None:
        if not run_id:
            return
        logger.info("AI graph stream subscriber disconnected; keeping run active run_id=%s", run_id)

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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> dict[str, Any]:
        prepared = self.approval_resume_preparer.prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
            stream=False,
        )
        logger.info(
            "AI graph approval resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            bool(prepared.snapshot.values),
            list(prepared.snapshot.next or []),
        )

        output = self.graph.invoke(
            self._resume_command(
                resume_payload=prepared.resume_payload,
                generation_contracts=frozenset(generation_contracts or ()),
            ),
            config=prepared.config,
            durability="sync",
        )
        result = output.get("last_decision")
        if not isinstance(result, dict):
            state = self.graph.get_state(prepared.config)
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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> dict[str, Any]:
        require_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            capability="contribute",
        )
        # generation_contracts is request-scoped for resume continuations; the fast
        # decision path does not re-enter the graph, so the value is accepted for API
        # uniformity and reserved for resume/continuation callers.
        _ = frozenset(generation_contracts or ())
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
        next_status = COMPLETED
        if approval.get("status") == PENDING:
            next_status = WAITING_APPROVAL
        elif operation is not None and operation.get("status") != "succeeded":
            next_status = FAILED
        elif decision == "rejected" or self._approval_resume_payload_from_decision(serialized) is not None:
            next_status = RUNNING
        run_id = str(approval.get("run_id") or "")
        if run_id:
            run = self.db.get(AIAgentRun, run_id)
            if run is not None:
                run.status = next_status
                run.context_summary = record_approval_outcome_summary(
                    dict(run.context_summary or {}),
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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> dict[str, Any]:
        prepared = self.human_input_resume_preparer.prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            request_id=request_id,
            selected_option_ids=selected_option_ids,
            text=text,
            stream=False,
        )
        output = self.graph.invoke(
            self._resume_command(
                resume_payload=prepared.resume_payload,
                generation_contracts=frozenset(generation_contracts or ()),
            ),
            config=prepared.config,
            durability="sync",
        )
        run_id = str(output.get("run_id") or "")
        if not run_id:
            state = self.graph.get_state(prepared.config)
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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        prepared = self.human_input_resume_preparer.prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            request_id=request_id,
            selected_option_ids=selected_option_ids,
            text=text,
            stream=True,
        )
        run_id = prepared.run_id
        contracts = frozenset(generation_contracts or ())
        logger.info(
            "AI graph human input stream resume started family_id=%s user_id=%s conversation_id=%s request_id=%s run_id=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            request_id,
            run_id,
            bool(prepared.snapshot.values),
            list(prepared.snapshot.next or []),
        )

        seen_event_ids: set[str] = set()
        try:
            def log_completed(final_run_id: str) -> None:
                logger.info(
                    "AI graph human input stream resume completed family_id=%s user_id=%s conversation_id=%s request_id=%s run_id=%s",
                    family_id,
                    user_id,
                    conversation_id,
                    request_id,
                    final_run_id,
                )

            yield from self._resume_graph_stream(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                config=prepared.config,
                resume_payload=prepared.resume_payload,
                run_id=run_id,
                flow="human_input_resume",
                seen_event_ids=seen_event_ids,
                generation_contracts=contracts,
                require_run_id=True,
                on_completed=log_completed,
            )
        except GeneratorExit:
            raise
        except Exception:
            raise


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
        generation_contracts: frozenset[str] | set[str] | list[str] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        prepared = self.approval_resume_preparer.prepare(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
            stream=True,
        )
        run_id = prepared.run_id
        contracts = frozenset(generation_contracts or ())
        logger.info(
            "AI graph approval stream resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s run_id=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            run_id,
            bool(prepared.snapshot.values),
            list(prepared.snapshot.next or []),
        )

        seen_event_ids: set[str] = set()
        emitted_result_part_ids: set[str] = set()

        def emit_approval_result_parts(runner: WorkspaceGraphRunner) -> Iterator[tuple[str, dict[str, Any]]]:
            for data in runner._approval_decision_message_parts(
                family_id=family_id,
                conversation_id=conversation_id,
                approval_id=approval_id,
            ):
                part = data.get("part") if isinstance(data.get("part"), dict) else {}
                part_id = str(part.get("id") or "")
                if not part_id or part_id in emitted_result_part_ids:
                    continue
                emitted_result_part_ids.add(part_id)
                yield ("message_part", data)

        try:
            def before_graph(runner: WorkspaceGraphRunner) -> Iterator[tuple[str, dict[str, Any]]]:
                yield from emit_approval_result_parts(runner)

            def handle_update_extra(runner: WorkspaceGraphRunner) -> Iterator[tuple[str, dict[str, Any]]]:
                yield from emit_approval_result_parts(runner)

            def log_completed(final_run_id: str) -> None:
                logger.info(
                    "AI graph approval stream resume completed family_id=%s user_id=%s conversation_id=%s approval_id=%s run_id=%s",
                    family_id,
                    user_id,
                    conversation_id,
                    approval_id,
                    final_run_id,
                )

            yield from self._resume_graph_stream(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                config=prepared.config,
                resume_payload=prepared.resume_payload,
                run_id=run_id,
                flow="approval_resume",
                seen_event_ids=seen_event_ids,
                generation_contracts=contracts,
                before_graph=before_graph,
                handle_update_extra=handle_update_extra,
                on_completed=log_completed,
            )
        except GeneratorExit:
            raise
        except Exception:
            raise

    def _approval_decision_message_parts(
        self,
        *,
        family_id: str,
        conversation_id: str,
        approval_id: str,
    ) -> list[dict[str, Any]]:
        approval = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if approval is None or not approval.message_id:
            return []
        message = self.db.get(AIMessage, approval.message_id)
        if message is None:
            return []
        expected_card_id = f"operation-result:{approval.id}"
        events: list[dict[str, Any]] = []
        for part in message.parts or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "approval_request":
                part_approval = part.get("approval") if isinstance(part.get("approval"), dict) else {}
                if str(part_approval.get("id") or "") == approval.id and part_approval.get("status") != "pending":
                    events.append(
                        {
                            "message_id": message.id,
                            "conversation_id": conversation_id,
                            "run_id": approval.run_id,
                            "part": jsonable_encoder(part),
                        }
                    )
                continue
            if part.get("type") != "result_card":
                continue
            card = part.get("card") if isinstance(part.get("card"), dict) else {}
            data = card.get("data") if isinstance(card.get("data"), dict) else {}
            if str(card.get("id") or "") != expected_card_id and str(data.get("approvalId") or "") != approval.id:
                continue
            events.append(
                {
                    "message_id": message.id,
                    "conversation_id": conversation_id,
                    "run_id": approval.run_id,
                    "part": jsonable_encoder(part),
                }
            )
        return events

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
        return self.graph_run_initializer.initialize(state)

    def _orchestrator_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        return self.orchestrator_node.run(state)

    def _approval_interrupt_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        tracer = self._tracer_for_state(state)
        pending_approval_id = str(state.get("pending_approval_id") or "")
        pending = None
        if pending_approval_id:
            pending = self.db.scalar(
                select(AIApprovalRequest).where(
                    AIApprovalRequest.id == pending_approval_id,
                    AIApprovalRequest.family_id == state["family_id"],
                    AIApprovalRequest.conversation_id == state["conversation_id"],
                    AIApprovalRequest.run_id == state["run_id"],
                    AIApprovalRequest.status == PENDING,
                )
            )
        if pending is None:
            pending = self.db.scalar(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.family_id == state["family_id"],
                    AIApprovalRequest.conversation_id == state["conversation_id"],
                    AIApprovalRequest.run_id == state["run_id"],
                    AIApprovalRequest.status == PENDING,
                )
                .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
            )
        if pending is None:
            recorded_decision = self._pop_fast_approval_decision(state, pending_approval_id)
            if recorded_decision is not None:
                tracer.record_event(
                    "approval_resume",
                    "recorded_approval_decision",
                    payload={"pendingApprovalId": pending_approval_id, "decision": recorded_decision.get("decision")},
                )
                return self._resume_recorded_approval_decision(
                    state,
                    recorded_decision,
                    list(state.get("run_artifacts") or []),
                )
            raise LookupError("确认请求不存在")
        tracer.record_event(
            "approval_wait",
            pending.approval_type,
            status="waiting",
            payload={"approvalId": pending.id, "draftId": pending.draft_id, "approvalType": pending.approval_type},
        )
        resume = interrupt(self._approval_interrupt_payload(pending))
        tracer.record_event(
            "approval_resume",
            pending.approval_type,
            payload={"approvalId": pending.id, "resumeKeys": sorted(resume.keys()) if isinstance(resume, dict) else []},
        )
        return self._resume_pending_approval(state, pending, resume, list(state.get("run_artifacts") or []))

    def _human_input_interrupt_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        tracer = self._tracer_for_state(state)
        pending = state.get("pending_human_input") if isinstance(state.get("pending_human_input"), dict) else {}
        if not pending or not pending.get("id"):
            raise LookupError("用户补充信息请求不存在或已结束")
        tracer.record_event(
            "human_input_wait",
            str(pending.get("id") or "human_input"),
            status="waiting",
            payload={"requestId": pending.get("id"), "question": pending.get("question")},
        )
        resume = interrupt(self._human_input_interrupt_payload(state, pending))
        tracer.record_event(
            "human_input_resume",
            str(pending.get("id") or "human_input"),
            payload={"requestId": pending.get("id"), "resumeKeys": sorted(resume.keys()) if isinstance(resume, dict) else []},
        )
        return self._resume_pending_human_input(state, pending, resume, list(state.get("run_artifacts") or []))

    def _tracer_for_state(self, state: WorkspaceGraphState) -> AIRunTracer:
        trace_id = self.db.scalar(
            select(AIRunTraceSpan.trace_id)
            .where(AIRunTraceSpan.run_id == state["run_id"], AIRunTraceSpan.family_id == state["family_id"])
            .order_by(AIRunTraceSpan.started_at.asc(), AIRunTraceSpan.id.asc())
            .limit(1)
        )
        return AIRunTracer(
            db=self.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
            conversation_id=state.get("conversation_id"),
            user_id=state.get("user_id"),
            trace_id=trace_id,
        )

    def _resume_pending_human_input(
        self,
        state: WorkspaceGraphState,
        pending: dict[str, Any],
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self.human_input_resume_handler.resume(
            state=state,
            pending=pending,
            resume=resume,
            run_artifacts=run_artifacts,
        )

    def _resume_pending_approval(
        self,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self.approval_resume_handler.resume(
            state=state,
            pending=pending,
            resume=resume,
            run_artifacts=run_artifacts,
        )

    def _resume_recorded_approval_decision(
        self,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self.approval_resume_handler.resume_recorded_decision(
            state=state,
            serialized=serialized,
            run_artifacts=run_artifacts,
        )

    def _approval_resume_payload_from_decision(self, decision_result: dict[str, Any]) -> dict[str, Any] | None:
        draft_id = approval_resume_draft_id(decision_result)
        if not draft_id:
            return None
        draft = self.db.get(AITaskDraft, draft_id)
        if draft is None:
            return None
        metadata = draft.ai_metadata if isinstance(draft.ai_metadata, dict) else {}
        return approval_resume_payload_from_metadata(metadata)

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
        draft_id = approval_resume_draft_id(decision_result)
        draft = self.db.get(AITaskDraft, draft_id) if draft_id else None
        metadata = draft.ai_metadata if draft is not None and isinstance(draft.ai_metadata, dict) else {}
        continuation = continuation_from_metadata(metadata)
        approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
        if continuation is not None:
            operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
            entity_ids = operation.get("business_entity_ids")
            return continuation_artifact(
                run_id=state["run_id"],
                approval_id=str(approval.get("id") or ""),
                continuation=continuation,
                decision_status=str(approval.get("decision") or approval.get("status") or ""),
                business_entity_ids=(
                    [str(item) for item in entity_ids if str(item).strip()]
                    if isinstance(entity_ids, list)
                    else []
                ),
            )
        resume_payload = self._approval_resume_payload_from_decision(decision_result)
        if resume_payload is None:
            return None
        return approval_resume_artifact(
            run_id=state["run_id"],
            approval_id=str(approval.get("id") or ""),
            fallback_resume_id=create_id("resume"),
            resume_payload=resume_payload,
        )

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
                    "signature": tool_signature(name, tool_input),
                    "payload": {"input": tool_input},
                }
            )
        return artifacts

    @staticmethod
    def _json_record(value: Any) -> Any:
        return jsonable_encoder(value)

    def _stream_graph_events(
        self,
        graph_stream: Callable[["WorkspaceGraphRunner"], Iterator[Any]],
        *,
        handle_update: Callable[["WorkspaceGraphRunner", Any], Iterator[tuple[str, dict[str, Any]]]],
        seen_event_ids: set[str],
        on_disconnect: Callable[[], None],
        before_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        after_graph: Callable[["WorkspaceGraphRunner"], Iterator[tuple[str, dict[str, Any]]]] | None = None,
        on_worker_exception: Callable[["WorkspaceGraphRunner", BaseException], None] | None = None,
        runner_factory: Callable[[], "WorkspaceGraphRunner"] | None = None,
        perf_context: dict[str, Any] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        event_queue: Queue[Any] = Queue()
        disconnected = False
        db_bind = None if runner_factory is not None else self.db.get_bind()

        def is_disconnected() -> bool:
            return disconnected

        def enqueue(event: str, data: dict[str, Any]) -> None:
            enqueue_stream_event(
                event_queue,
                seen_event_ids=seen_event_ids,
                is_disconnected=is_disconnected,
                event=event,
                data=data,
            )

        worker = Thread(
            target=consume_stream_graph_worker,
            name="ai-workspace-stream",
            daemon=True,
            kwargs={
                "db_bind": db_bind,
                "provider": getattr(self, "provider", None),
                "event_queue": event_queue,
                "graph_stream": graph_stream,
                "handle_update": handle_update,
                "enqueue": enqueue,
                "is_disconnected": is_disconnected,
                "before_graph": before_graph,
                "after_graph": after_graph,
                "on_worker_exception": on_worker_exception,
                "runner_factory": runner_factory,
                "perf_context": perf_context,
                "stream_done_marker": _STREAM_DONE,
            },
        )
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
            # Client disconnect only detaches this SSE subscriber; the graph run
            # keeps executing so later polling/reconnect can observe final state.
            disconnected = True
            on_disconnect()
            raise
        finally:
            if not disconnected:
                worker.join(timeout=1)

    def _optional_stream_writer(self):
        try:
            return get_stream_writer()
        except Exception:
            return None

    def _finalize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        return self.run_finalizer.finalize(state)

    def _route_after_orchestrator(self, state: WorkspaceGraphState) -> str:
        if state.get("status") == RUNNING:
            if int(state.get("agent_rounds") or 0) >= MAX_AGENT_ROUNDS:
                return "finalize"
            return "orchestrator"
        if state.get("status") == WAITING_APPROVAL:
            return "approval_interrupt"
        if state.get("status") == WAITING_INPUT:
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
        message.parts = sync_message_parts_with_current_approval_state(message.parts, drafts=drafts, approvals=approvals)
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
