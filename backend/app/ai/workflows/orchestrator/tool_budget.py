from __future__ import annotations

from dataclasses import dataclass

from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.signatures import tool_signature
from app.ai.workflows.orchestrator.state import OrchestratorRunState


@dataclass(frozen=True, slots=True)
class ToolBudgetDecision:
    allowed: bool
    signature: str
    output: dict[str, object] | None = None


def evaluate_tool_budget(
    *,
    state: OrchestratorRunState,
    historical_record_count: int,
    tool_name: str,
    tool_payload: dict,
    execution_definition: ToolDefinition,
) -> ToolBudgetDecision:
    current_tool_signature = tool_signature(tool_name, tool_payload)
    total_tool_count = len(state.historical_tool_signatures) + historical_record_count
    if total_tool_count >= state.budget_config.max_total_tool_calls_per_run:
        return ToolBudgetDecision(
            allowed=False,
            signature=current_tool_signature,
            output={
                "error": "本次任务的工具调用次数已经达到上限。请基于已有结果总结，或让用户缩小任务范围。",
                "code": "tool_budget_exhausted",
                "status": "stop_current_run",
            },
        )
    if (
        execution_definition.side_effect == "read"
        and (state.historical_tool_signatures + state.tool_signatures_this_call).count(current_tool_signature)
        >= state.budget_config.max_same_read_tool_calls_per_run
    ):
        return ToolBudgetDecision(
            allowed=False,
            signature=current_tool_signature,
            output={
                "error": "已经读取过相同数据多次。请基于已有工具结果继续，不要重复调用同一个读取工具。",
                "code": "tool_loop_detected",
                "status": "use_existing_result",
            },
        )
    return ToolBudgetDecision(allowed=True, signature=current_tool_signature)
