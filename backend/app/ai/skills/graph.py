from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import StateGraph

from app.ai.skills.base import BaseSkill, SkillContext, SkillResult


class GraphSkillState(TypedDict, total=False):
    context: SkillContext
    tool_outputs: dict[str, dict[str, Any]]
    decision: dict[str, Any]
    attempt: int
    error: str | None
    status: str
    result: SkillResult
    data: dict[str, Any]


class GraphBackedSkill(BaseSkill):
    _active_context: SkillContext | None = None

    def run(self, context: SkillContext) -> SkillResult:
        self._active_context = context
        try:
            output: GraphSkillState = {}
            for update in self.build_graph().compile().stream({"attempt": 0, "data": {}}, stream_mode="updates"):
                if not isinstance(update, dict):
                    continue
                for node_name, patch in update.items():
                    if isinstance(patch, dict):
                        output.update(patch)
            result = output.get("result")
            if not isinstance(result, SkillResult):
                return SkillResult(
                    text=f"{self.manifest.name}执行失败。",
                    status="failed",
                    model=getattr(context.provider, "model_name", "") if context.provider else "rules",
                    error=f"{self.manifest.name}没有生成结果",
                )
            return result
        finally:
            self._active_context = None

    @property
    def skill_context(self) -> SkillContext:
        if self._active_context is None:
            raise RuntimeError("Graph-backed skill is not running")
        return self._active_context

    def build_graph(self) -> StateGraph:
        raise NotImplementedError
