from __future__ import annotations

import logging
import inspect

from app.ai.errors import AIExecutionCancelled, ApprovalRequired, HumanInputRequired
from app.ai.observability.llm_exchange import LLMExchangeRecorder
from app.ai.runtime.provider import BaseChatProvider
from app.ai.skills.base import SkillContext, SkillResult
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.shared import model_name
from app.ai.workflows.orchestrator.completion import OrchestratorCompletionGuard
from app.ai.workflows.orchestrator.payloads import OrchestratorPromptPayloadBuilder
from app.ai.workflows.orchestrator.profiles import profile_state_value
from app.ai.workflows.orchestrator.results import OrchestratorResultAssembler
from app.ai.workflows.orchestrator.signatures import historical_tool_signatures
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.ai.workflows.orchestrator.streaming import emit_visible_delta
from app.ai.workflows.orchestrator.tools import (
    DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES,
    OrchestratorToolGateway,
    SkillInjectionBundle,
    SkillInjectionManager,
)
from app.core.utils import create_id

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES",
    "OrchestratorCompletionGuard",
    "OrchestratorPromptPayloadBuilder",
    "OrchestratorRunState",
    "OrchestratorResultAssembler",
    "OrchestratorToolGateway",
    "SkillInjectionBundle",
    "SkillInjectionManager",
    "WorkspaceOrchestratorAgent",
]


class WorkspaceOrchestratorAgent:
    def __init__(
        self,
        *,
        provider: BaseChatProvider,
        skill_registry: SkillRegistry,
        max_rounds: int = 12,
    ) -> None:
        self.provider = provider
        self.injection_manager = SkillInjectionManager(skill_registry)
        self.prompt_payload_builder = OrchestratorPromptPayloadBuilder(self.injection_manager)
        self.result_assembler = OrchestratorResultAssembler(self.injection_manager)
        self.max_rounds = max_rounds

    def run(
        self,
        context: SkillContext,
        *,
        injected_skill_keys: list[str] | None = None,
    ) -> SkillResult:
        context.ensure_active()
        root_tool_executor = context.tool_executor
        profile_state = self.prompt_payload_builder.profile_state(context)
        capability_policy = self.prompt_payload_builder.capability_policy(profile_state)
        base_budget_config = self.prompt_payload_builder.budget_config(profile_state, capability_policy)
        requested_initial_skill_keys = [
            key
            for key in injected_skill_keys or []
            if capability_policy.allows_skill(key)
        ]
        active_skill_keys, initial_bundles = self.injection_manager.inject([], requested_initial_skill_keys)
        budget_config = self.injection_manager.budget_config_for(active_skill_keys, base_budget_config, capability_policy)
        requires_terminal_output, terminal_text_allowed = self.injection_manager.completion_policy_for(
            active_skill_keys,
            capability_policy,
        )
        trace_round_index = context.trace_round_index or 0
        orchestrator_span = (
            context.tracer.start_span(
                "orchestrator_round",
                "orchestrator",
                parent_span_id=context.trace_parent_span_id,
                round_index=trace_round_index,
                input_summary={
                    "initialInjectedSkills": list(injected_skill_keys or []),
                    "historicalArtifactCount": len(context.current_run_artifacts),
                    "conversationMessageCount": len(context.conversation),
                },
            )
            if context.tracer is not None
            else None
        )
        context.trace_parent_span_id = orchestrator_span.span_id if orchestrator_span is not None else context.trace_parent_span_id
        context.trace_round_index = trace_round_index
        root_tool_executor.context.tracer = context.tracer
        root_tool_executor.context.trace_parent_span_id = context.trace_parent_span_id
        root_tool_executor.context.trace_round_index = trace_round_index
        stream_session_id = create_id("ai_stream")
        message_id = f"{context.run_id}:orchestrator:{stream_session_id}:text"
        part_id = f"{message_id}:text"
        state = OrchestratorRunState(
            active_skill_keys=active_skill_keys,
            profile_key=str(profile_state_value(profile_state, "key") or ""),
            response_style=str(profile_state_value(profile_state, "responseStyle", "response_style") or ""),
            capability_policy=capability_policy,
            budget_config=budget_config,
            injection_history=[
                {
                    "skillKey": bundle.key,
                    "displayName": bundle.display_name,
                    "source": "existing" if context.current_run_artifacts else "initial",
                }
                for bundle in initial_bundles
            ],
            trace_round_index=trace_round_index,
            message_id=message_id,
            part_id=part_id,
            historical_tool_signatures=historical_tool_signatures(context.current_run_artifacts),
            requires_terminal_output=requires_terminal_output,
            terminal_text_allowed=terminal_text_allowed,
        )
        gateway = OrchestratorToolGateway(
            context=context,
            injection_manager=self.injection_manager,
            state=state,
        )
        if initial_bundles and not context.current_run_artifacts:
            for bundle in initial_bundles:
                context.emit_progress("skill", f"{bundle.key}.start", f"调用「{bundle.display_name}」技能", status="completed")

        def finish_orchestrator_span(result: SkillResult) -> SkillResult:
            if orchestrator_span is not None:
                span_status = "waiting" if result.status in {"waiting_approval", "waiting_input"} else result.status
                orchestrator_span.finish(
                    status=span_status,
                    output_summary={
                        "status": result.status,
                        "model": result.model,
                        "draftCount": len(result.drafts),
                        "cardCount": len(result.cards),
                        "toolCallCount": len(result.tool_calls),
                        "injectedSkills": state.active_skill_keys,
                        "readTools": sorted(state.read_outputs.keys()),
                        "budget": state.budget_config.to_state(),
                    },
                    error_code=result.error if result.status == "failed" else None,
                    error_message=result.error if result.status == "failed" else None,
                )
            return result

        try:
            gateway.refresh_tools()

            def handle_message_delta(delta: str) -> None:
                if not delta:
                    return
                state.streamed_text.append(delta)
                emit_visible_delta(context, state, delta)

            provider_kwargs = {
                "system": self.prompt_payload_builder.system_prompt(context, state.active_skill_keys),
                "user": self.prompt_payload_builder.provider_user_input(
                    context,
                    state.active_skill_keys,
                    state.injection_history,
                    state.capability_policy,
                ),
                "tools": gateway.refresh_tools,
                "tool_handler": gateway.call_tool,
                "message_handler": handle_message_delta,
                "max_rounds": max(4, self.max_rounds),
            }
            if "tool_preview_handler" in inspect.signature(self.provider.generate_with_tools).parameters:
                provider_kwargs["tool_preview_handler"] = gateway.preview_tool_call
            if "trace_recorder" in inspect.signature(self.provider.generate_with_tools).parameters and context.tracer is not None:
                provider_kwargs["trace_recorder"] = LLMExchangeRecorder(
                    db=context.db,
                    family_id=context.family_id,
                    run_id=context.run_id,
                    conversation_id=context.conversation_id,
                    trace_id=context.tracer.trace_id,
                    user_id=context.user_id,
                    span_id=orchestrator_span.span_id if orchestrator_span is not None else context.trace_parent_span_id,
                )
            provider_result = self.provider.generate_with_tools(**provider_kwargs)
            if provider_result.status in {"failed", "fallback"}:
                return finish_orchestrator_span(
                    self.result_assembler.failed_result(
                        provider_result,
                        context,
                        "orchestrator provider unavailable",
                        state=state,
                    )
                )
            return finish_orchestrator_span(self.result_assembler.completed_result(provider_result, context, state))
        except ApprovalRequired:
            return finish_orchestrator_span(self.result_assembler.approval_result(context, state))
        except HumanInputRequired as exc:
            return finish_orchestrator_span(self.result_assembler.human_input_result(context, state, exc.request))
        except AIExecutionCancelled:
            raise
        except Exception as exc:
            logger.warning(
                "Workspace orchestrator failed run_id=%s conversation_id=%s family_id=%s error=%s",
                context.run_id,
                context.conversation_id,
                context.family_id,
                exc,
                exc_info=True,
            )
            return finish_orchestrator_span(
                SkillResult(
                    text="AI 工作台执行失败，请重试。",
                    status="failed",
                    model=model_name(context),
                    error=str(exc),
                    diagnostic=str(exc),
                )
            )
        finally:
            context.tool_executor = root_tool_executor
        return SkillResult(
            text="AI 工作台执行轮次过多，请调整请求后重试。",
            status="failed",
            model=model_name(context),
            error="orchestrator max rounds exceeded",
        )
