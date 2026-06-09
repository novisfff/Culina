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
                    self._emit_node_progress(context, str(node_name), patch)
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

    def _emit_node_progress(self, context: SkillContext, node_name: str, patch: Any) -> None:
        context.emit_progress(
            "skill_graph",
            f"{self.manifest.key}.{node_name}",
            self._node_message(node_name, patch),
            self._node_status(patch),
        )

    def _node_message(self, node_name: str, patch: Any) -> str:
        labels = {
            "load_context": "已读取上下文",
            "decide": "已完成模型决策",
            "normalize": "已整理模型结果",
            "normalize_merge": "已合并模型结果",
            "validate": "已校验结果",
            "validate_source": "已校验引用来源",
            "create_draft": "已准备草稿",
            "finalize": "已汇总结果",
        }
        return f"{self.manifest.name}：{labels.get(node_name, f'已完成 {node_name}')}"

    def _node_status(self, patch: Any) -> str:
        if not isinstance(patch, dict):
            return "completed"
        result = patch.get("result")
        if isinstance(result, SkillResult):
            return "failed" if result.status == "failed" else "completed"
        status = str(patch.get("status") or "")
        return "failed" if status == "failed" else "completed"
