from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.runner_registry import register_skill_runner
from app.ai.skills.shared import conversation_artifacts, json_object, model_name

logger = logging.getLogger(__name__)


TOOLCALL_SKILL_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "text": {"type": "string"},
        "cards": {"type": "array", "items": {"type": "object"}},
        "drafts": {"type": "array", "items": {"type": "object"}},
        "events": {"type": "array", "items": {"type": "object"}},
        "context_summary": {"type": "object"},
        "state_patch": {"type": "object"},
        "requires_clarification": {"type": "boolean"},
        "status": {"type": "string", "enum": ["completed", "failed"]},
        "error": {"type": ["string", "null"]},
        "operation": {"type": ["string", "null"]},
        "source_artifact_id": {"type": ["string", "null"]},
    },
    "required": ["text"],
}


DRAFT_TOOL_TYPES: dict[str, str] = {
    "recipe.create_draft": "recipe",
    "meal_plan.create_draft": "meal_plan",
    "shopping.create_draft": "shopping_list",
    "shopping_list.create_draft": "shopping_list",
    "meal_log.create_draft": "meal_log",
    "food_profile.create_draft": "food_profile",
}


class ToolCallingSkill(BaseSkill):
    def __init__(self, manifest: SkillManifest, skill_dir: Path) -> None:
        super().__init__(manifest, skill_dir)
        self.instructions = self._load_instructions(skill_dir)

    def run(self, context: SkillContext) -> SkillResult:
        if context.provider is None:
            logger.warning(
                "Tool-calling skill provider unavailable skill=%s run_id=%s conversation_id=%s family_id=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
            )
            return SkillResult(
                text=f"{self.manifest.name}暂时无法调用模型，请稍后重试。",
                status="failed",
                model=model_name(context),
                error="provider unavailable",
            )

        draft_outputs: list[dict[str, Any]] = []
        available_tools = [context.tool_executor.registry.get(name) for name in self.manifest.tools]
        logger.info(
            "Tool-calling skill invoking provider skill=%s run_id=%s conversation_id=%s family_id=%s model=%s tools=%s",
            self.manifest.key,
            context.run_id,
            context.conversation_id,
            context.family_id,
            model_name(context),
            [tool.name for tool in available_tools],
        )

        def call_tool(name: str, payload: dict[str, Any]) -> dict[str, Any]:
            output = context.tool_executor.call(name, payload)
            draft_type = DRAFT_TOOL_TYPES.get(name)
            if draft_type:
                draft = output.get("draft")
                if isinstance(draft, dict):
                    logger.info(
                        "Tool-calling skill captured draft output skill=%s run_id=%s conversation_id=%s tool=%s draft_type=%s payload_keys=%s",
                        self.manifest.key,
                        context.run_id,
                        context.conversation_id,
                        name,
                        draft_type,
                        sorted(draft.keys()),
                    )
                    draft_outputs.append(
                        {
                            "draft_type": draft_type,
                            "payload": draft,
                            "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
                            "tool": name,
                        }
                    )
            return output

        result = context.provider.generate_with_tools(
            system=self._system_prompt(available_tools),
            user=json.dumps(self._user_payload(context), ensure_ascii=False, default=str),
            tools=available_tools,
            tool_handler=call_tool,
            response_schema=TOOLCALL_SKILL_RESULT_SCHEMA,
            max_rounds=8,
        )
        if result.status == "failed":
            logger.warning(
                "Tool-calling skill provider failed skill=%s run_id=%s conversation_id=%s family_id=%s model=%s error=%s tool_calls=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                result.model,
                result.error,
                len(result.tool_calls),
            )
            return SkillResult(
                text=f"{self.manifest.name}执行失败。",
                status="failed",
                model=result.model or model_name(context),
                error=result.error or "tool call failed",
                diagnostic=result.error,
            )
        if result.status == "fallback":
            logger.warning(
                "Tool-calling skill provider fallback skill=%s run_id=%s conversation_id=%s family_id=%s model=%s error=%s tool_calls=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                result.model,
                result.error,
                len(result.tool_calls),
            )
        parsed = json_object(result.text or "")
        if not isinstance(parsed, dict):
            logger.warning(
                "Tool-calling skill invalid final JSON skill=%s run_id=%s conversation_id=%s family_id=%s model=%s status=%s raw_preview=%r",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                result.model,
                result.status,
                (result.text or "")[:500],
            )
            return SkillResult(
                text=f"{self.manifest.name}模型没有返回有效结果，请重试。",
                status="failed",
                model=result.model or model_name(context),
                error=result.error or "invalid toolcall skill model response",
            )

        drafts = self._validated_drafts(draft_outputs)
        model_drafts = self._as_list_of_dicts(parsed.get("drafts"))
        if model_drafts and not drafts:
            logger.warning(
                "Tool-calling skill model returned drafts without draft tool skill=%s run_id=%s conversation_id=%s family_id=%s model_drafts=%s tool_calls=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                len(model_drafts),
                len(result.tool_calls),
            )
            return SkillResult(
                text=f"{self.manifest.name}模型返回了草稿但没有调用草稿工具。",
                status="failed",
                model=result.model or model_name(context),
                error="drafts require draft tool call",
            )

        cards = self._validated_cards(self._as_list_of_dicts(parsed.get("cards")), context)
        skill_result = SkillResult(
            text=str(parsed.get("text") or ""),
            cards=cards,
            drafts=drafts,
            events=self._as_list_of_dicts(parsed.get("events")),
            context_summary=self._as_dict(parsed.get("context_summary")),
            state_patch=self._as_dict(parsed.get("state_patch")),
            status=str(parsed.get("status") or "completed"),
            model=result.model or model_name(context),
            error=self._optional_text(parsed.get("error")),
            operation=self._optional_text(parsed.get("operation")),
            source_artifact_id=self._optional_text(parsed.get("source_artifact_id")),
            requires_clarification=bool(parsed.get("requires_clarification")),
        )
        logger.info(
            "Tool-calling skill parsed final result skill=%s run_id=%s conversation_id=%s family_id=%s status=%s drafts=%s cards=%s events=%s tool_calls=%s requires_clarification=%s",
            self.manifest.key,
            context.run_id,
            context.conversation_id,
            context.family_id,
            skill_result.status,
            len(skill_result.drafts),
            len(skill_result.cards),
            len(skill_result.events),
            len(result.tool_calls),
            skill_result.requires_clarification,
        )
        return skill_result

    def _system_prompt(self, tools: list[Any]) -> str:
        tool_records = [
            {
                "name": tool.name,
                "description": tool.description,
                "side_effect": tool.side_effect,
                "requires_confirmation": tool.requires_confirmation,
                "input_schema": tool.input_schema,
            }
            for tool in tools
        ]
        return (
            "你是 Culina AI 工作台中的 Skill Runner。"
            "你必须严格遵守下面的 SKILL.md、workflow、HITL、manifest 能力边界和工具结果。"
            "你可以自主决定是否以及何时调用当前 Skill 允许的工具。"
            "不得调用未列出的工具，不得声称已经写入正式业务数据。"
            "审批型任务只能调用 draft 工具生成草稿，正式写入必须等待用户确认。"
            "如果需要生成草稿，必须先调用对应 draft 工具，不要只在最终 JSON 中编造 drafts。"
            "cards 是可选结果卡片；如果输出 cards，每个 cards[].type 必须严格使用 Manifest.outputs 中声明的类型。"
            "不要自造 preview、summary、detail 等未声明类型；草稿预览也必须使用已声明的 *_draft 类型。"
            "最终只输出符合 SkillResult JSON Schema 的裸 JSON 对象，禁止 Markdown 代码块、解释文字和额外字段。"
            "\n\nManifest:\n"
            f"{json.dumps(self.manifest.to_planner_record(), ensure_ascii=False, default=str)}"
            "\n\nAllowed card types:\n"
            f"{json.dumps(self.manifest.output_types, ensure_ascii=False, default=str)}"
            "\n\nAllowed tools:\n"
            f"{json.dumps(tool_records, ensure_ascii=False, default=str)}"
            "\n\nSkill instructions:\n"
            f"{self.instructions}"
        )

    def _user_payload(self, context: SkillContext) -> dict[str, Any]:
        return {
            "currentMessage": context.current_message,
            "conversation": context.conversation,
            "artifacts": conversation_artifacts(context),
            "previousResults": [self._result_record(item) for item in context.previous_results],
            "scriptHelpers": self.scripts.describe(),
        }

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

    def _validated_drafts(self, drafts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        allowed = set(self.manifest.draft_types)
        validated = []
        seen: set[tuple[str, str]] = set()
        for draft in drafts:
            draft_type = str(draft.get("draft_type") or "")
            if draft_type not in allowed:
                raise ValueError(f"Skill {self.manifest.key} generated undeclared draft type: {draft_type}")
            payload = draft.get("payload")
            if not isinstance(payload, dict):
                raise ValueError(f"Skill {self.manifest.key} generated invalid draft payload")
            key = (draft_type, json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str))
            if key in seen:
                continue
            seen.add(key)
            validated.append(
                {
                    "draft_type": draft_type,
                    "payload": payload,
                    "schema_version": str(draft.get("schema_version") or f"{draft_type}.v1"),
                }
            )
        return validated

    def _validated_cards(self, cards: list[dict[str, Any]], context: SkillContext) -> list[dict[str, Any]]:
        allowed = set(self.manifest.output_types) | {"error_recovery"}
        if not allowed:
            if cards:
                logger.warning(
                    "Tool-calling skill discarded cards because no card types are declared skill=%s run_id=%s conversation_id=%s family_id=%s card_types=%s",
                    self.manifest.key,
                    context.run_id,
                    context.conversation_id,
                    context.family_id,
                    [card.get("type") for card in cards],
                )
            return []

        validated: list[dict[str, Any]] = []
        for card in cards:
            card_type = str(card.get("type") or "")
            if card_type in allowed:
                validated.append(card)
                continue

            normalized_type = self._normalized_card_type(card_type, allowed)
            if normalized_type:
                normalized = {**card, "type": normalized_type}
                logger.warning(
                    "Tool-calling skill normalized undeclared card type skill=%s run_id=%s conversation_id=%s family_id=%s from_type=%s to_type=%s",
                    self.manifest.key,
                    context.run_id,
                    context.conversation_id,
                    context.family_id,
                    card_type,
                    normalized_type,
                )
                validated.append(normalized)
                continue

            logger.warning(
                "Tool-calling skill discarded undeclared card type skill=%s run_id=%s conversation_id=%s family_id=%s card_type=%s allowed_types=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                card_type,
                sorted(allowed),
            )
        return validated

    def _normalized_card_type(self, card_type: str, allowed: set[str]) -> str | None:
        if card_type.endswith("_preview"):
            candidate = f"{card_type[: -len('_preview')]}_draft"
            if candidate in allowed:
                return candidate
        return None

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


register_skill_runner("toolcall", ToolCallingSkill)
