from __future__ import annotations


MAX_ROUNDS_FINALIZATION_PROMPT = (
    "工具调用轮次已经达到上限。请不要继续调用工具；请基于已有工具结果给用户自然总结，"
    "说明已经完成的部分、尚未继续处理的部分，并提示用户可以发送“继续”来开启下一轮。"
)


def max_rounds_finalization_round(
    *,
    round_index: int,
    max_rounds: int,
    requested_tool_call_count: int,
) -> bool:
    return bool(requested_tool_call_count and round_index == max(1, max_rounds) - 1)


def max_rounds_finalization_trace_options(finalization_round: bool) -> dict[str, bool]:
    return {
        "finalizationRound": finalization_round,
        "softFinalizedByMaxRounds": finalization_round,
    }
