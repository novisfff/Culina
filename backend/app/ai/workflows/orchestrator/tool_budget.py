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
    hard_stop: bool = False


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
        output = {
            "error": "本次任务的工具调用预算已经用完。",
            "code": "tool_budget_exhausted",
            "status": "summarize_current_run",
            "messageForAssistant": (
                "本次任务的工具调用预算已经用完。不要继续调用工具；请基于已有结果给用户自然总结，"
                "说明已经完成的部分、尚未继续处理的部分，并提示用户可以发送“继续”来开启下一轮。"
            ),
            "budget": state.budget_config.to_state(),
            "usage": {
                "usedToolCalls": total_tool_count,
                "maxToolCalls": state.budget_config.max_total_tool_calls_per_run,
            },
            "requiresFollowup": True,
            "followupHint": "工具预算用完后必须基于已有结果自然收尾，不要继续调用工具。",
        }
        if state.tool_budget_exhausted:
            return ToolBudgetDecision(
                allowed=False,
                signature=current_tool_signature,
                output={
                    **output,
                    "status": "hard_stop_current_run",
                    "messageForAssistant": (
                        "工具调用预算已经用完，且模型仍继续请求工具。系统将硬结束本轮，"
                        "避免继续循环调用。"
                    ),
                },
                hard_stop=True,
            )
        return ToolBudgetDecision(
            allowed=False,
            signature=current_tool_signature,
            output=output,
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
