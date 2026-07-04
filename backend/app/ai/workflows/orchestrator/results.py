from __future__ import annotations

import json
from typing import Any

from app.ai.runtime.provider import ChatProviderResult
from app.ai.skills.base import SkillContext, SkillResult
from app.ai.skills.shared import model_name
from app.ai.workflows.orchestrator.completion import ORCHESTRATOR_TERMINAL_OUTPUT_MISSING, OrchestratorCompletionGuard
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.ai.workflows.orchestrator.tools import SkillInjectionManager
from app.ai.workflows.result_cards import validate_result_cards


class OrchestratorResultAssembler:
    def __init__(
        self,
        injection_manager: SkillInjectionManager,
        completion_guard: OrchestratorCompletionGuard | None = None,
    ) -> None:
        self.injection_manager = injection_manager
        self.completion_guard = completion_guard or OrchestratorCompletionGuard()

    def completed_result(
        self,
        provider_result: ChatProviderResult,
        context: SkillContext,
        state: OrchestratorRunState,
    ) -> SkillResult:
        text = provider_result.text or "".join(state.streamed_text).strip()
        drafts = self.validated_drafts(state.draft_outputs, state.active_skill_keys)
        status = "waiting_approval" if drafts else "completed"
        cards = [] if drafts else self.validated_cards(state.result_card_outputs, state.active_skill_keys)
        completion = self.completion_guard.evaluate(text=text, cards=cards, drafts=drafts, state=state)
        if completion.should_fail:
            return self.terminal_guard_failed_result(
                provider_result,
                context,
                state,
                error=completion.error or ORCHESTRATOR_TERMINAL_OUTPUT_MISSING,
            )
        return SkillResult(
            text=text or "",
            cards=cards,
            drafts=drafts,
            context_summary=self.orchestrator_context_summary(state),
            status=status,
            model=provider_result.model or model_name(context),
            error=provider_result.error,
            tool_calls=context.tool_executor.records(),
        )

    def terminal_guard_failed_result(
        self,
        provider_result: ChatProviderResult,
        context: SkillContext,
        state: OrchestratorRunState,
        *,
        error: str,
    ) -> SkillResult:
        diagnostic = self.completion_guard.diagnostic(state=state, error=error)
        return SkillResult(
            text="AI 工作台还需要继续处理，但本轮没有产出可展示结果，请重试。",
            status="failed",
            model=provider_result.model or model_name(context),
            error=error,
            diagnostic=json.dumps(diagnostic, ensure_ascii=False, default=str),
            context_summary=self.orchestrator_context_summary(state),
            tool_calls=context.tool_executor.records(),
        )

    def approval_result(self, context: SkillContext, state: OrchestratorRunState) -> SkillResult:
        drafts = self.validated_drafts(state.draft_outputs, state.active_skill_keys)
        return SkillResult(
            text="".join(state.streamed_text).strip(),
            drafts=drafts,
            context_summary=self.orchestrator_context_summary(state),
            status="waiting_approval",
            model=model_name(context),
            tool_calls=context.tool_executor.records(),
        )

    def human_input_result(self, context: SkillContext, state: OrchestratorRunState, request: dict[str, Any]) -> SkillResult:
        return SkillResult(
            text=str(request.get("question") or "我需要你补充一点信息。"),
            status="waiting_input",
            model=model_name(context),
            context_summary={
                **self.orchestrator_context_summary(state),
                "pendingHumanInput": request,
            },
            state_patch={"pendingHumanInput": request},
        )

    def failed_result(
        self,
        provider_result: ChatProviderResult,
        context: SkillContext,
        error: str,
        *,
        state: OrchestratorRunState,
    ) -> SkillResult:
        return SkillResult(
            text="AI 工作台暂时无法完成这次请求，请稍后重试。",
            status="failed",
            model=provider_result.model or model_name(context),
            error=provider_result.error or error,
            diagnostic=provider_result.error or error,
            context_summary={
                "orchestrator": {
                    "profileKey": state.profile_key,
                    "responseStyle": state.response_style,
                    "capabilityPolicy": state.capability_policy.to_state(),
                    "injectedSkills": state.active_skill_keys,
                    "injectionHistory": state.injection_history,
                    "readTools": sorted(state.read_outputs.keys()),
                    "budget": state.budget_config.to_state(),
                    "budgetUsage": self.budget_usage(state),
                },
            },
        )

    def tool_budget_hard_stop_result(
        self,
        context: SkillContext,
        state: OrchestratorRunState,
    ) -> SkillResult:
        return SkillResult(
            text=(
                "这轮工具调用预算已经用完，我先停在这里，避免继续循环调用工具。"
                "我已经基于目前拿到的信息保留了上下文；你可以发送“继续”，我会从下一轮接着处理剩下的部分。"
            ),
            status="failed",
            model=model_name(context),
            error="tool_budget_hard_stop",
            diagnostic=json.dumps(
                {
                    "error": "tool_budget_hard_stop",
                    "lastOutput": state.tool_budget_last_output or {},
                    "budgetUsage": self.budget_usage(state),
                },
                ensure_ascii=False,
                default=str,
            ),
            context_summary=self.orchestrator_context_summary(state),
            tool_calls=context.tool_executor.records(),
        )

    def orchestrator_context_summary(self, state: OrchestratorRunState) -> dict[str, Any]:
        return {
            "orchestrator": {
                "profileKey": state.profile_key,
                "responseStyle": state.response_style,
                "capabilityPolicy": state.capability_policy.to_state(),
                "injectedSkills": state.active_skill_keys,
                "injectionHistory": state.injection_history,
                "readTools": sorted(state.read_outputs.keys()),
                "pendingFollowups": state.pending_followups,
                "terminalToolOutputs": state.terminal_tool_outputs,
                "requiresTerminalOutput": state.requires_terminal_output,
                "terminalTextAllowed": state.terminal_text_allowed,
                "budget": state.budget_config.to_state(),
                "budgetUsage": self.budget_usage(state),
            },
            **self.program_context_summary(state.read_outputs),
        }

    def budget_usage(self, state: OrchestratorRunState) -> dict[str, Any]:
        used_tool_calls = len(state.historical_tool_signatures) + len(state.tool_signatures_this_call)
        max_tool_calls = state.budget_config.max_total_tool_calls_per_run
        return {
            "usedToolCalls": used_tool_calls,
            "maxToolCalls": max_tool_calls,
            "remainingToolCalls": max(0, max_tool_calls - used_tool_calls),
            "exhausted": state.tool_budget_exhausted,
            "exhaustedToolCallAttempts": state.tool_budget_exhausted_attempts,
            "hardStopped": state.tool_budget_hard_stopped,
        }

    def program_context_summary(self, read_outputs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        inventory_summary = self.latest_tool_output(read_outputs, "inventory.read_summary")
        if inventory_summary:
            summary["inventoryItemCount"] = inventory_summary.get("availableCount", 0)
            summary["expiringItemCount"] = inventory_summary.get("expiringCount", 0)
            summary["lowStockItemCount"] = inventory_summary.get("lowStockCount", 0)
        available = self.latest_tool_output(read_outputs, "inventory.read_available_items")
        if available and "count" in available:
            summary.setdefault("inventoryItemCount", available.get("count", 0))
        expiring = self.latest_tool_output(read_outputs, "inventory.read_expiring_items")
        if expiring and "count" in expiring:
            summary["expiringItemCount"] = expiring.get("count", summary.get("expiringItemCount", 0))
        return summary

    def validated_drafts(self, drafts: list[dict[str, Any]], active_skill_keys: list[str]) -> list[dict[str, Any]]:
        allowed = self.injection_manager.allowed_draft_types(active_skill_keys)
        validated: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for draft in drafts:
            draft_type = str(draft.get("draft_type") or "")
            if draft_type not in allowed:
                raise ValueError(f"Orchestrator generated undeclared draft type: {draft_type}")
            payload = draft.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("Orchestrator generated invalid draft payload")
            key = (draft_type, json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str))
            if key in seen:
                continue
            seen.add(key)
            validated.append(
                {
                    "draft_type": draft_type,
                    "payload": payload,
                    "schema_version": str(draft.get("schema_version") or f"{draft_type}.v1"),
                    "tool": draft.get("tool"),
                    "after_approval": draft.get("after_approval") if isinstance(draft.get("after_approval"), dict) else {},
                    **(
                        {
                            "draft_id": draft["draft_id"],
                            "approval_id": draft["approval_id"],
                            "published_part_ids": draft.get("published_part_ids") or [],
                        }
                        if draft.get("draft_id") and draft.get("approval_id")
                        else {}
                    ),
                }
            )
        return validated

    def validated_cards(self, cards: list[dict[str, Any]], active_skill_keys: list[str]) -> list[dict[str, Any]]:
        allowed = self.injection_manager.allowed_output_types(active_skill_keys) | {"error_recovery"}
        for card in cards:
            card_type = str(card.get("type") or "")
            if not card_type:
                raise ValueError("Orchestrator returned card without type")
            if allowed and card_type not in allowed:
                raise ValueError(f"Orchestrator returned undeclared card type: {card_type}")
        return validate_result_cards(cards)

    def latest_tool_output(self, read_outputs: dict[str, list[dict[str, Any]]], tool_name: str) -> dict[str, Any]:
        outputs = read_outputs.get(tool_name, [])
        if not outputs:
            return {}
        latest = outputs[-1]
        return latest if isinstance(latest, dict) else {}
