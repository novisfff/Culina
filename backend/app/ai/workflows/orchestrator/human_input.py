from __future__ import annotations

from typing import Any

from app.ai.errors import HumanInputRequired
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.core.utils import create_id


def repeated_human_input_output() -> dict[str, Any]:
    return {
        "error": "本轮已经请求过用户补充信息。请结束当前动作，等待用户回复。",
        "code": "human_input_budget_exhausted",
        "status": "waiting_input",
    }


def raise_human_input_request(*, state: OrchestratorRunState, output: dict[str, Any]) -> None:
    state.human_input_requested_this_call = True
    request = {
        "id": create_id("human_input"),
        **output,
    }
    raise HumanInputRequired(request)
