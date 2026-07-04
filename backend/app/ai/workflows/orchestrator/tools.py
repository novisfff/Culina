from __future__ import annotations

from typing import Any

from app.ai.errors import ToolBudgetHardStop
from app.ai.skills.base import SkillContext
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.draft_capture import (
    capture_draft_output,
    enforce_single_draft_per_call,
    prepare_tool_payload,
)
from app.ai.workflows.orchestrator.human_input import raise_human_input_request, repeated_human_input_output
from app.ai.workflows.orchestrator.progress import preview_tool_call_progress
from app.ai.workflows.orchestrator.skill_runtime import execute_skill_injection
from app.ai.workflows.orchestrator.skill_injection import (
    DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES,
    SkillInjectionBundle,
    SkillInjectionManager,
)
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.ai.workflows.orchestrator.tool_budget import evaluate_tool_budget
from app.ai.workflows.orchestrator.tool_outputs import capture_tool_contract_metadata
from app.ai.workflows.orchestrator.tool_schemas import provider_visible_tools


class OrchestratorToolGateway:
    def __init__(
        self,
        *,
        context: SkillContext,
        injection_manager: SkillInjectionManager,
        state: OrchestratorRunState,
    ) -> None:
        self.context = context
        self.injection_manager = injection_manager
        self.state = state

    def refresh_tools(self) -> list[ToolDefinition]:
        self.context.ensure_active()
        scoped_executor = self.injection_manager.scoped_tool_executor(
            self.context,
            self.state.active_skill_keys,
            self.state.capability_policy,
        )
        self.context.tool_executor = scoped_executor
        scoped_executor.context.tracer = self.context.tracer
        scoped_executor.context.trace_parent_span_id = self.context.trace_parent_span_id
        scoped_executor.context.trace_round_index = self.state.trace_round_index
        tools, script_executors = self.injection_manager.tool_definitions(
            self.state.active_skill_keys,
            self.context,
            self.state.capability_policy,
        )
        tools = provider_visible_tools(tools, injection_manager=self.injection_manager, state=self.state)
        self.state.current_scoped_executor = scoped_executor
        self.state.current_script_executors = script_executors
        self.state.current_tool_names = {definition.name for definition in tools}
        self.state.current_tool_definitions = {definition.name: definition for definition in tools}
        return tools

    def preview_tool_call(self, name: str, preview_key: str, status: str) -> str | None:
        return preview_tool_call_progress(
            context=self.context,
            state=self.state,
            tool_name=name,
            preview_key=preview_key,
            status=status,
        )

    def call_tool(self, name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
        self.context.ensure_active()
        if name == "skill.inject":
            if not self.state.capability_policy.allows_dynamic_skill_injection():
                output = {
                    "error": "当前入口不支持动态注入 Skill。",
                    "code": "skill_injection_disabled",
                    "status": "unavailable_tool",
                    "injectedSkills": [],
                    "alreadyInjected": [],
                    "availableTools": sorted(self.state.current_tool_names),
                }
                self._capture_tool_contract_metadata(name, "control", output)
                return output
            output = execute_skill_injection(
                payload=payload,
                context=self.context,
                injection_manager=self.injection_manager,
                state=self.state,
            )
            self._capture_tool_contract_metadata(name, "control", output)
            return output
        if name not in self.state.current_tool_names:
            output = {
                "error": f"当前 round 未暴露工具 {name}。如需业务能力，请先调用 skill.inject。",
                "code": "unavailable_tool",
                "status": "unavailable_tool",
            }
            self._capture_tool_contract_metadata(name, "control", output)
            return output
        if name in self.state.current_script_executors:
            definition = self.state.current_tool_definitions[name]
            output = self.state.current_script_executors[name].call(name, payload, progress_event_id=progress_event_id)
            self._capture_tool_contract_metadata(name, definition.side_effect, output, definition=definition)
            return output
        if self.state.current_scoped_executor is None:
            raise RuntimeError("orchestrator tool gateway has not been initialized")
        execution_definition = self.state.current_scoped_executor.registry.get(name)
        runtime_definition = self.state.current_tool_definitions.get(name, execution_definition)
        runtime_payload = self._with_contextual_tool_payload(name, payload)
        prepared_payload = prepare_tool_payload(payload=runtime_payload, execution_definition=execution_definition)
        budget_decision = evaluate_tool_budget(
            state=self.state,
            historical_record_count=len(self.context.tool_executor.records()),
            tool_name=name,
            tool_payload=prepared_payload.payload,
            execution_definition=execution_definition,
        )
        if not budget_decision.allowed:
            output = budget_decision.output or {}
            if output.get("code") == "tool_budget_exhausted":
                self.state.tool_budget_exhausted_attempts += 1
                self.state.tool_budget_last_output = dict(output)
                if budget_decision.hard_stop:
                    self.state.tool_budget_hard_stopped = True
                    raise ToolBudgetHardStop(output)
                self.state.tool_budget_exhausted = True
            self._capture_tool_contract_metadata(
                name,
                execution_definition.side_effect,
                output,
                definition=runtime_definition,
            )
            return output
        if execution_definition.side_effect == "draft":
            enforce_single_draft_per_call(
                state=self.state,
                injection_manager=self.injection_manager,
                tool_name=name,
                tool_payload=prepared_payload.payload,
            )
        if name == "human.request_input" and self.state.human_input_requested_this_call:
            output = repeated_human_input_output()
            self._capture_tool_contract_metadata(
                name,
                execution_definition.side_effect,
                output,
                definition=runtime_definition,
            )
            return output
        output = self.state.current_scoped_executor.call(
            name,
            prepared_payload.payload,
            progress_event_id=progress_event_id,
        )
        self.state.tool_signatures_this_call.append(budget_decision.signature)
        self.context.ensure_active()
        self._capture_tool_output(
            name,
            execution_definition.side_effect,
            prepared_payload.payload,
            output,
            prepared_payload.after_approval,
            definition=runtime_definition,
        )
        return output

    def _with_contextual_tool_payload(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        if name != "ui.propose_actions":
            return payload
        subject = self.context.subject if isinstance(self.context.subject, dict) else {}
        extra = subject.get("extra") if isinstance(subject.get("extra"), dict) else {}
        surface = str(payload.get("surface") or extra.get("surface") or "").strip()
        source = str(subject.get("source") or "").strip()
        if surface != "recipe_cook_page" and source != "recipe_cook_page":
            return payload
        next_payload = dict(payload)
        self._set_default(next_payload, "surface", surface or "recipe_cook_page")
        self._set_default(
            next_payload,
            "recipeId",
            subject.get("recipe_id")
            or subject.get("recipeId")
            or extra.get("recipeId")
            or extra.get("recipe_id"),
        )
        self._set_default(
            next_payload,
            "cookSessionId",
            extra.get("cookSessionId") or extra.get("cook_session_id"),
        )
        self._set_default(
            next_payload,
            "sessionRevision",
            extra.get("sessionRevision") if "sessionRevision" in extra else extra.get("session_revision"),
        )
        return next_payload

    @staticmethod
    def _set_default(payload: dict[str, Any], key: str, value: Any) -> None:
        if value is None:
            return
        existing = payload.get(key)
        if existing is None or existing == "":
            payload[key] = value

    def _capture_tool_output(
        self,
        name: str,
        side_effect: str,
        tool_payload: dict[str, Any],
        output: dict[str, Any],
        after_approval: dict[str, Any],
        *,
        definition: ToolDefinition | None = None,
    ) -> None:
        self._capture_tool_contract_metadata(name, side_effect, output, definition=definition)
        if side_effect == "read":
            self.state.read_outputs.setdefault(name, []).append(output)
        card = output.get("card") if isinstance(output.get("card"), dict) else None
        if card is not None:
            self.state.result_card_outputs.append(card)
        if name == "human.request_input":
            raise_human_input_request(state=self.state, output=output)
        if side_effect != "draft":
            return
        capture_draft_output(
            state=self.state,
            injection_manager=self.injection_manager,
            tool_name=name,
            tool_payload=tool_payload,
            output=output,
            after_approval=after_approval,
            progressive_draft_publisher=self.context.progressive_draft_publisher,
        )

    def _capture_tool_contract_metadata(
        self,
        name: str,
        side_effect: str,
        output: dict[str, Any],
        *,
        definition: ToolDefinition | None = None,
    ) -> None:
        capture_tool_contract_metadata(
            state=self.state,
            tool_name=name,
            side_effect=side_effect,
            output=output,
            definition=definition,
        )
