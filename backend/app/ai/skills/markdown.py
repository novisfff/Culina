from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.context_policy import read_skill_context
from app.ai.skills.runner_registry import register_skill_runner
from app.ai.skills.shared import conversation_artifacts, json_object, model_name


MARKDOWN_SKILL_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {"type": "string"},
        "cards": {"type": "array", "items": {"type": "object"}},
        "events": {"type": "array", "items": {"type": "object"}},
        "context_summary": {"type": "object"},
        "state_patch": {"type": "object"},
        "requires_clarification": {"type": "boolean"},
        "status": {"type": "string", "enum": ["completed", "failed"]},
        "error": {"type": ["string", "null"]},
    },
    "required": ["text"],
}


class MarkdownInstructionSkill(BaseSkill):
    def __init__(self, manifest: SkillManifest, skill_dir: Path) -> None:
        super().__init__(manifest, skill_dir)
        self.instructions = self._load_instructions(skill_dir)

    def run(self, context: SkillContext) -> SkillResult:
        if context.provider is None:
            return SkillResult(
                text=f"{self.manifest.name}暂时无法调用模型，请稍后重试。",
                status="failed",
                model=model_name(context),
                error="provider unavailable",
            )

        tool_outputs = self._read_allowed_tool_outputs(context)
        context.emit_progress("model", f"{self.manifest.key}.model_generate", f"正在生成{self.manifest.name}结果")
        result = context.provider.generate(
            system=self._system_prompt(),
            user=json.dumps(
                {
                    "manifest": self.manifest.to_planner_record(),
                    "currentMessage": context.current_message,
                    "conversation": context.conversation,
                    "artifacts": conversation_artifacts(context),
                    "previousResults": [self._result_record(item) for item in context.previous_results],
                    "toolOutputs": tool_outputs,
                    "scriptHelpers": self.scripts.describe(),
                },
                ensure_ascii=False,
                default=str,
            ),
            response_schema=MARKDOWN_SKILL_RESULT_SCHEMA,
        )
        parsed = json_object(result.text or "")
        if not isinstance(parsed, dict):
            return SkillResult(
                text=f"{self.manifest.name}模型没有返回有效结果，请重试。",
                status="failed",
                model=result.model or model_name(context),
                error=result.error or "invalid markdown skill model response",
            )

        return SkillResult(
            text=str(parsed.get("text") or ""),
            cards=self._as_list_of_dicts(parsed.get("cards")),
            events=self._as_list_of_dicts(parsed.get("events")),
            context_summary=self._as_dict(parsed.get("context_summary")),
            state_patch=self._as_dict(parsed.get("state_patch")),
            status=str(parsed.get("status") or "completed"),
            model=result.model or model_name(context),
            error=self._optional_text(parsed.get("error")),
            requires_clarification=bool(parsed.get("requires_clarification")),
        )

    def _system_prompt(self) -> str:
        return (
            "你是 Culina AI 工作台中的一个 Markdown Skill Runner。"
            "你必须严格遵守下面的 SKILL.md 行为说明、manifest 能力边界和工具结果。"
            "只允许基于已提供的上下文和只读工具结果回答。"
            "不要声称已经写入业务数据，不要创建草稿，不要调用未提供的工具。"
            "如果信息不足，可以设置 requires_clarification=true 并追问。"
            "只输出符合 JSON Schema 的裸 JSON 对象，禁止 Markdown 代码块、解释文字和额外字段。"
            "\n\nSKILL.md:\n"
            f"{self.instructions}"
        )

    def _read_allowed_tool_outputs(self, context: SkillContext) -> dict[str, dict[str, Any]]:
        outputs = read_skill_context(context, self.manifest)
        for tool_name in self.manifest.tools:
            if tool_name in outputs:
                continue
            definition = context.tool_executor.registry.get(tool_name)
            if definition.side_effect != "read":
                continue
            outputs[tool_name] = context.tool_executor.call(tool_name, {})
        return outputs

    def _load_instructions(self, skill_dir: Path) -> str:
        chunks = [self._file_section(skill_dir / "SKILL.md", "SKILL.md")]
        for file_name in [*self.manifest.workflow_files, *self.manifest.hitl_files, *self.manifest.example_files]:
            chunks.append(self._file_section(skill_dir / file_name, file_name))
        for file_name in self.manifest.script_files:
            chunks.append(
                "## Script reference\n"
                "Scripts are deterministic helper references only; do not claim they write data.\n\n"
                f"{self._file_section(skill_dir / file_name, file_name)}"
            )
        return "\n\n---\n\n".join(chunk for chunk in chunks if chunk.strip())

    def _file_section(self, path: Path, label: str) -> str:
        return f"# {label}\n\n{path.read_text(encoding='utf-8').strip()}"

    def _result_record(self, result: SkillResult) -> dict[str, Any]:
        return {
            "text": result.text,
            "cards": result.cards,
            "drafts": result.drafts,
            "events": result.events,
            "status": result.status,
            "operation": result.operation,
            "sourceArtifactId": result.source_artifact_id,
        }

    def _as_dict(self, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    def _as_list_of_dicts(self, value: Any) -> list[dict[str, Any]]:
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    def _optional_text(self, value: Any) -> str | None:
        if value is None:
            return None
        text = str(value)
        return text or None


register_skill_runner("markdown", MarkdownInstructionSkill)
