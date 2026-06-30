from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.ai.workflows.orchestrator.state import OrchestratorRunState


ORCHESTRATOR_FOLLOWUP_REQUIRED = "orchestrator_followup_required"
ORCHESTRATOR_TERMINAL_OUTPUT_MISSING = "orchestrator_terminal_output_missing"


@dataclass(frozen=True, slots=True)
class OrchestratorCompletionDecision:
    terminal_output_present: bool
    error: str | None = None

    @property
    def should_fail(self) -> bool:
        return self.error is not None


class OrchestratorCompletionGuard:
    def evaluate(
        self,
        *,
        text: str,
        cards: list[dict[str, Any]],
        drafts: list[dict[str, Any]],
        state: OrchestratorRunState,
    ) -> OrchestratorCompletionDecision:
        text_is_terminal = bool(text.strip()) and state.terminal_text_allowed
        terminal_output_present = bool(text_is_terminal or cards or drafts or state.terminal_tool_outputs)
        if (state.tool_outputs_this_call or state.requires_terminal_output) and not terminal_output_present:
            error = ORCHESTRATOR_FOLLOWUP_REQUIRED if state.pending_followups else ORCHESTRATOR_TERMINAL_OUTPUT_MISSING
            return OrchestratorCompletionDecision(terminal_output_present=False, error=error)
        return OrchestratorCompletionDecision(terminal_output_present=terminal_output_present)

    def diagnostic(self, *, state: OrchestratorRunState, error: str) -> dict[str, Any]:
        return {
            "error": error,
            "pendingFollowups": state.pending_followups,
            "terminalToolOutputs": state.terminal_tool_outputs,
            "toolOutputsThisCall": state.tool_outputs_this_call,
            "requiresTerminalOutput": state.requires_terminal_output,
            "terminalTextAllowed": state.terminal_text_allowed,
        }
