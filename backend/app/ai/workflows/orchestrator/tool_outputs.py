from __future__ import annotations

from typing import Any

from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.ai.workflows.orchestrator.tool_contracts import tool_completion_metadata


def capture_tool_contract_metadata(
    *,
    state: OrchestratorRunState,
    tool_name: str,
    side_effect: str,
    output: dict[str, Any],
    definition=None,
) -> None:
    state.tool_outputs_this_call.append(
        {
            "tool": tool_name,
            "sideEffect": side_effect,
            "outputKeys": sorted(output.keys()) if isinstance(output, dict) else [],
        }
    )
    metadata = tool_completion_metadata(output=output, definition=definition)
    if metadata.requires_followup:
        state.pending_followups.append(
            {
                "tool": tool_name,
                "sideEffect": side_effect,
                **({"hint": metadata.followup_hint} if metadata.followup_hint else {}),
            }
        )
    if metadata.terminal_output:
        state.terminal_tool_outputs.append(
            {
                "tool": tool_name,
                "sideEffect": side_effect,
                **({"hint": metadata.followup_hint} if metadata.followup_hint else {}),
            }
        )
