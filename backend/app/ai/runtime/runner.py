from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter
from typing import Any

from sqlalchemy.orm import Session

from app.ai.runtime.provider import BaseChatProvider, get_chat_provider
from app.ai.runtime.schemas import AgentRunRequest, AgentState

GraphBuilder = Callable[[Session, BaseChatProvider], Any]


@dataclass(slots=True)
class AgentExecution:
    state: AgentState
    duration_ms: int


class AgentRuntime:
    def __init__(self, *, provider: BaseChatProvider | None = None) -> None:
        self.provider = provider or get_chat_provider()

    def run(self, db: Session, request: AgentRunRequest, graph_builder: GraphBuilder) -> AgentExecution:
        started = perf_counter()
        graph = graph_builder(db, self.provider)
        state = graph.invoke({"request": request})
        duration_ms = int((perf_counter() - started) * 1000)
        return AgentExecution(state=state, duration_ms=duration_ms)
