from __future__ import annotations

import json
import logging
import re
from datetime import date
from pathlib import Path
from inspect import Parameter, signature
from typing import Any

from app.ai.clarifications import (
    LAST_CLARIFICATION_RESOLUTION_KEY,
    PENDING_CLARIFICATION_KEY,
    build_pending_clarification,
)
from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.scripts import SkillScriptCatalog, SkillScriptExecutor
from app.ai.skills.shared import conversation_artifacts, json_object, model_name
from app.ai.errors import AIExecutionCancelled
from app.core.utils import create_id

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


VISIBLE_TEXT_OPEN = "<visible_text>"
VISIBLE_TEXT_CLOSE = "</visible_text>"
STRUCTURED_RESULT_OPEN = "<structured_result>"
STRUCTURED_RESULT_CLOSE = "</structured_result>"


class VisibleTextStream:
    def __init__(self, emit) -> None:
        self.emit = emit
        self.buffer = ""
        self.in_visible = False
        self.chunks: list[str] = []

    @property
    def text(self) -> str:
        return "".join(self.chunks)

    def feed(self, chunk: str) -> None:
        if not chunk:
            return
        self.buffer += chunk
        self._drain()

    def flush(self) -> None:
        if self.in_visible and self.buffer:
            self._emit(self.buffer)
        self.buffer = ""

    def _drain(self) -> None:
        while self.buffer:
            if self.in_visible:
                close_index = self.buffer.find(VISIBLE_TEXT_CLOSE)
                if close_index >= 0:
                    segment = self.buffer[:close_index]
                    if segment and not segment.endswith("\n"):
                        segment = f"{segment}\n"
                    self._emit(segment)
                    self.buffer = self.buffer[close_index + len(VISIBLE_TEXT_CLOSE) :]
                    self.in_visible = False
                    continue
                safe_length = max(0, len(self.buffer) - len(VISIBLE_TEXT_CLOSE) + 1)
                if safe_length <= 0:
                    return
                self._emit(self.buffer[:safe_length])
                self.buffer = self.buffer[safe_length:]
                return

            open_index = self.buffer.find(VISIBLE_TEXT_OPEN)
            if open_index >= 0:
                self.buffer = self.buffer[open_index + len(VISIBLE_TEXT_OPEN) :]
                self.in_visible = True
                continue
            keep_length = len(VISIBLE_TEXT_OPEN) - 1
            if len(self.buffer) <= keep_length:
                return
            self.buffer = self.buffer[-keep_length:]
            return

    def _emit(self, text: str) -> None:
        if not text:
            return
        self.chunks.append(text)
        self.emit(text)


class ToolCallingSkill(BaseSkill):
    def __init__(self, manifest: SkillManifest, skill_dir: Path, *, instructions: str | None = None) -> None:
        super().__init__(manifest, skill_dir)
        self.instructions = instructions if instructions is not None else self._load_instructions(skill_dir)
        self.script_catalog = SkillScriptCatalog(skill_dir, manifest.script_files)

    def run(self, context: SkillContext) -> SkillResult:
        context.ensure_active()
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
        draft_state_patch: dict[str, Any] = {}
        read_outputs: dict[str, list[dict[str, Any]]] = {}
        script_executor = SkillScriptExecutor(self.script_catalog, context)
        available_tools = [
            *(context.tool_executor.registry.get(name) for name in self.manifest.tools),
            *script_executor.tool_definitions(),
        ]
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
            context.ensure_active()
            if script_executor.has(name):
                output = script_executor.call(name, payload)
                context.ensure_active()
                return output
            context.ensure_active()
            definition = context.tool_executor.registry.get(name)
            output = context.tool_executor.call(name, payload)
            context.ensure_active()
            if definition.side_effect == "read":
                read_outputs.setdefault(name, []).append(output)
            if definition.side_effect == "draft":
                draft = output.get("draft")
                if isinstance(draft, dict):
                    draft_type = self._draft_type_from_tool_output(name, draft)
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
                if output.get("clearsPendingClarification") is True:
                    draft_state_patch[PENDING_CLARIFICATION_KEY] = None
                if isinstance(output.get("clarificationResolution"), dict):
                    draft_state_patch[LAST_CLARIFICATION_RESOLUTION_KEY] = output["clarificationResolution"]
            return output

        message_id = create_id("ai_message")
        part_id = create_id("ai_part")

        def emit_visible_delta(delta: str) -> None:
            context.ensure_active()
            if context.stream_writer is None or not delta:
                return
            context.stream_writer(
                {
                    "event": "message_delta",
                    "data": {
                        "message_id": message_id,
                        "conversation_id": context.conversation_id,
                        "run_id": context.run_id,
                        "part_id": part_id,
                        "delta": delta,
                    },
                }
            )

        visible_stream = VisibleTextStream(emit_visible_delta)

        result = self._generate_with_tools(
            context.provider,
            system=self._system_prompt(available_tools),
            user=json.dumps(self._user_payload(context), ensure_ascii=False, default=str),
            tools=available_tools,
            tool_handler=call_tool,
            response_schema=TOOLCALL_SKILL_RESULT_SCHEMA,
            max_rounds=self._tool_call_round_budget(available_tools),
            visible_text_handler=visible_stream.feed,
        )
        context.ensure_active()
        visible_stream.flush()
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
        visible_text, structured_text = self._split_dual_channel_text(result.text or "")
        parsed = json_object(structured_text or result.text or "")
        if not isinstance(parsed, dict):
            fallback_parsed = self._fallback_parsed_result_from_tool_outputs(draft_outputs)
            if fallback_parsed is not None:
                logger.warning(
                    "Tool-calling skill recovered final result from draft tool outputs skill=%s run_id=%s conversation_id=%s family_id=%s model=%s status=%s draft_count=%s raw_preview=%r",
                    self.manifest.key,
                    context.run_id,
                    context.conversation_id,
                    context.family_id,
                    result.model,
                    result.status,
                    len(draft_outputs),
                    (result.text or "")[:500],
                )
                parsed = fallback_parsed
            else:
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

        cards = self._cards_with_validated_drafts(
            self._cards_from_read_outputs(
                self._validated_cards(self._as_list_of_dicts(parsed.get("cards")), context),
                read_outputs,
            ),
            drafts,
        )
        cards = self._ensure_inventory_summary_card(cards, read_outputs, drafts)
        cards = self._ensure_today_recommendation_card(cards, read_outputs, drafts)
        cards = self._ensure_clarification_card(cards, read_outputs)
        emitted_text = visible_stream.text
        fallback_text = visible_text.strip() or str(parsed.get("text") or "")
        final_text = emitted_text
        if fallback_text:
            if not emitted_text:
                delta = self._line_delta(fallback_text)
                emit_visible_delta(delta)
                final_text = delta
            elif self._compact_text(fallback_text) != self._compact_text(emitted_text) and self._compact_text(fallback_text) not in self._compact_text(emitted_text):
                delta = self._line_delta(fallback_text)
                emit_visible_delta(delta)
                final_text = f"{emitted_text}{delta}"
        final_text = final_text.strip()
        state_patch = self._as_dict(parsed.get("state_patch"))
        state_patch.update(draft_state_patch)
        state_patch.update(self._state_patch_from_read_outputs(read_outputs))
        context_summary = self._as_dict(parsed.get("context_summary"))
        if PENDING_CLARIFICATION_KEY in state_patch and PENDING_CLARIFICATION_KEY not in context_summary:
            context_summary[PENDING_CLARIFICATION_KEY] = state_patch[PENDING_CLARIFICATION_KEY]
        skill_result = SkillResult(
            text=final_text,
            cards=cards,
            drafts=drafts,
            events=self._as_list_of_dicts(parsed.get("events")),
            context_summary=context_summary,
            state_patch=state_patch,
            status=str(parsed.get("status") or "completed"),
            model=result.model or model_name(context),
            error=self._optional_text(parsed.get("error")),
            operation=self._optional_text(parsed.get("operation")),
            source_artifact_id=self._optional_text(parsed.get("source_artifact_id")),
            requires_clarification=bool(parsed.get("requires_clarification")),
            tool_calls=script_executor.records(),
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
                "output_schema": tool.output_schema,
            }
            for tool in tools
        ]
        return (
            "你是 Culina AI 工作台中的 Skill Runner。"
            "你必须严格遵守下面的 Skill instructions、能力边界和工具结果。"
            "你可以自主决定是否以及何时调用当前 Skill 允许的工具。"
            "script.* 工具是 Skill 自带的确定性只读脚本，使用方式与普通工具相同；"
            "当 Skill instructions 要求校验、归一化或合并时必须调用对应脚本。"
            "不得调用未列出的工具，不得声称已经写入正式业务数据。"
            "审批型任务只能调用 draft 工具生成草稿，正式写入必须等待用户确认。"
            "如果需要生成草稿，必须先调用对应 draft 工具，不要只在最终 JSON 中编造 drafts。"
            "cards 是可选结果卡片；如果输出 cards，每个 cards[].type 必须严格使用 Manifest.outputs 中声明的类型。"
            "不要自造 preview、summary、detail 等未声明类型；草稿预览也必须使用已声明的 *_draft 类型。"
            "任何给用户看的正文都必须放在 <visible_text>...</visible_text> 标签内，包括调用工具前、工具调用之间和最终回复。"
            "不要输出推理过程、隐藏分析、工具参数细节或未确认的数据写入承诺。"
            "可编辑的偏好、备注、分类、理由等低风险字段，可以基于用户原话和工具结果合理补全，并在回复中说明用户确认前可修改。"
            "名称或目标已经唯一且工具结果明确时，不要为了形式化流程反复追问。"
            "多个真实候选会影响写入目标，或数量、单位、日期、餐别会影响库存、计划、记录时，必须澄清或让用户选择。"
            "删除、销毁、完成计划、扣减库存等不可逆或有副作用动作，必须生成审批草稿，不能用普通文本承诺已完成。"
            "用户要求的对象不存在时，不要编造业务 ID；可以说明需要先创建上游资料或请求补充信息。"
            "工具调用要有明确终点；完成必要读取、澄清或 draft 工具调用后，必须停止继续调用工具并输出最终 structured_result。"
            "最终回复必须包含 <visible_text>用户可见回复</visible_text>，随后输出 <structured_result>SkillResult JSON</structured_result>。"
            "structured_result 内只放符合 SkillResult JSON Schema 的裸 JSON 对象，禁止 Markdown 代码块、解释文字和额外字段。"
            "structured_result.text 必须重复本轮完整用户可见正文；cards/drafts/events/status 等结构化字段只放在 structured_result。"
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
            "subject": context.subject,
            "conversation": context.conversation,
            "artifacts": conversation_artifacts(context),
            "previousResults": [self._result_record(item) for item in context.previous_results],
            "quickTask": self._quick_task(context),
            "pendingClarification": context.pending_clarification,
        }

    def _tool_call_round_budget(self, tools: list[Any]) -> int:
        return max(8, min(18, len(tools) + 4))

    def _load_instructions(self, skill_dir: Path) -> str:
        skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        body = skill_text.split("---\n", 2)[2].strip() if skill_text.startswith("---\n") else skill_text.strip()
        chunks = [body]
        workflow_path = skill_dir / "workflows.md"
        if workflow_path.exists():
            chunks.append(self._file_section(workflow_path, "workflows.md"))
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

    def _fallback_parsed_result_from_tool_outputs(self, drafts: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not drafts:
            return None
        first = next((draft for draft in drafts if isinstance(draft.get("payload"), dict)), None)
        if first is None:
            return None
        draft_type = str(first.get("draft_type") or "")
        payload = first["payload"]
        operation = self._draft_operation(payload)
        text = self._fallback_draft_text(draft_type=draft_type, payload=payload, operation=operation)
        return {
            "text": text,
            "cards": [],
            "events": [{"type": "draft", "message": text}],
            "context_summary": {"draftType": draft_type},
            "state_patch": {"activeTask": draft_type, "activeDraftType": draft_type},
            "requires_clarification": False,
            "status": "completed",
            "error": None,
            "operation": operation,
            "source_artifact_id": None,
        }

    def _draft_operation(self, payload: dict[str, Any]) -> str:
        action = self._optional_text(payload.get("action"))
        if action:
            return action
        if isinstance(payload.get("operations"), list) and payload["operations"]:
            first_operation = payload["operations"][0]
            if isinstance(first_operation, dict):
                return self._optional_text(first_operation.get("action")) or "apply"
        return "create"

    def _fallback_draft_text(self, *, draft_type: str, payload: dict[str, Any], operation: str) -> str:
        if draft_type == "meal_log":
            if operation == "rate_food":
                return "我整理了餐食记录评分草稿，请确认后再写入。"
            if operation == "update_details":
                return "我整理了餐食记录补充草稿，请确认后再写入。"
            return "我整理了餐食记录草稿，请确认后再写入。"
        if draft_type == "shopping_list":
            return "我整理了购物清单变更草稿，请确认后再写入。"
        if draft_type == "meal_plan":
            return "我整理了餐食计划草稿，请确认后再写入。"
        if draft_type == "inventory_operation":
            return "我整理了库存处理草稿，请确认后再写入。"
        if draft_type == "recipe_cook":
            title = self._optional_text(payload.get("title"))
            return f"我整理了{f'「{title}」' if title else ''}做菜执行草稿，请确认后再写入。"
        if draft_type == "recipe":
            return "我整理了菜谱草稿，请确认后再写入。"
        if draft_type == "food_profile":
            return "我整理了食物资料草稿，请确认后再写入。"
        if draft_type == "ingredient_profile":
            return "我整理了食材档案草稿，请确认后再写入。"
        return f"我整理了{self.manifest.name}草稿，请确认后再写入。"

    def _draft_type_from_tool_output(self, tool_name: str, draft: dict[str, Any]) -> str:
        draft_type = str(draft.get("draftType") or draft.get("draft_type") or "").strip()
        if not draft_type and len(self.manifest.draft_types) == 1:
            draft_type = self.manifest.draft_types[0]
        if not draft_type:
            raise ValueError(f"Skill {self.manifest.key} cannot infer draft type from tool {tool_name}")
        if draft_type not in set(self.manifest.draft_types):
            raise ValueError(
                f"Skill {self.manifest.key} generated undeclared draft type from tool {tool_name}: {draft_type}"
            )
        return draft_type

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

            logger.warning(
                "Tool-calling skill rejected undeclared card type skill=%s run_id=%s conversation_id=%s family_id=%s card_type=%s allowed_types=%s",
                self.manifest.key,
                context.run_id,
                context.conversation_id,
                context.family_id,
                card_type,
                sorted(allowed),
            )
            raise ValueError(f"Skill {self.manifest.key} returned undeclared card type: {card_type}")
        return validated

    def _cards_with_validated_drafts(self, cards: list[dict[str, Any]], drafts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not cards or not drafts:
            return cards
        payload_by_card_type = {
            f"{draft['draft_type']}_draft": draft["payload"]
            for draft in drafts
            if isinstance(draft.get("payload"), dict)
        }
        normalized_cards: list[dict[str, Any]] = []
        for card in cards:
            payload = payload_by_card_type.get(str(card.get("type") or ""))
            data = card.get("data")
            if payload is None or not isinstance(data, dict):
                normalized_cards.append(card)
                continue
            next_data = {**data, "draft": payload}
            if isinstance(payload.get("items"), list):
                next_data["items"] = payload["items"]
                if card.get("type") == "meal_plan_draft":
                    next_data["preview"] = "\n".join(str(item.get("title") or "") for item in payload["items"][:7])
            if isinstance(payload.get("foods"), list):
                next_data["foods"] = payload["foods"]
            normalized_cards.append({**card, "data": next_data})
        return normalized_cards

    def _cards_from_read_outputs(
        self,
        cards: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for card in cards:
            card_type = str(card.get("type") or "")
            if card_type == "inventory_summary":
                normalized.append({**card, "data": self._inventory_card_data(read_outputs)})
                continue
            if card_type == "today_recommendation":
                normalized.append(self._normalize_recommendation_card(card, read_outputs))
                continue
            if card_type == "clarification_request":
                normalized.append(self._normalize_clarification_card(card, read_outputs))
                continue
            normalized.append(card)
        return normalized

    def _normalize_clarification_card(
        self,
        card: dict[str, Any],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> dict[str, Any]:
        data = self._as_dict(card.get("data"))
        return {
            **card,
            "data": {
                **data,
                "candidates": self._clarification_candidates(data, read_outputs),
            },
        }

    def _ensure_clarification_card(
        self,
        cards: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        if any(str(card.get("type") or "") == "clarification_request" for card in cards):
            return cards
        outputs = read_outputs.get("intent.request_clarification") or []
        if not outputs:
            return cards
        latest = outputs[-1]
        question = self._optional_text(latest.get("question"))
        if not question:
            return cards
        return [
            *cards,
            {
                "id": create_id("ai_card"),
                "type": "clarification_request",
                "title": "还需要你确认一下",
                "data": {
                    "question": question,
                    "questionType": self._optional_text(latest.get("questionType")) or "other",
                    "missingFields": latest.get("missingFields") if isinstance(latest.get("missingFields"), list) else [],
                    "candidates": self._clarification_candidates(latest, read_outputs),
                    "allowFreeText": bool(latest.get("allowFreeText", True)),
                    **({"unitMismatch": latest["unitMismatch"]} if isinstance(latest.get("unitMismatch"), dict) else {}),
                },
            },
        ]

    def _ensure_inventory_summary_card(
        self,
        cards: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
        drafts: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if "inventory_summary" not in set(self.manifest.output_types):
            return cards
        if drafts or any(str(card.get("type") or "") == "inventory_summary" for card in cards):
            return cards
        if read_outputs.get("intent.request_clarification"):
            return cards
        inventory_tool_names = {
            "inventory.read_summary",
            "inventory.read_available_items",
            "inventory.read_expiring_items",
            "inventory.read_expired_items",
            "inventory.read_low_stock_items",
        }
        if not any(read_outputs.get(tool_name) for tool_name in inventory_tool_names):
            return cards
        return [
            *cards,
            {
                "id": create_id("ai_card"),
                "type": "inventory_summary",
                "title": "库存概览",
                "data": self._inventory_card_data(read_outputs),
            },
        ]

    def _ensure_today_recommendation_card(
        self,
        cards: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
        drafts: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if "today_recommendation" not in set(self.manifest.output_types):
            return cards
        if drafts or any(str(card.get("type") or "") == "today_recommendation" for card in cards):
            return cards
        if read_outputs.get("intent.request_clarification"):
            return cards
        foods = self._latest_tool_items(read_outputs, "food.search")
        recipes = self._latest_tool_items(read_outputs, "recipe.search")
        if not foods and not recipes:
            return cards
        recommendation_items: list[dict[str, Any]] = []
        for food in foods[:3]:
            food_id = self._optional_text(food.get("id"))
            if food_id:
                recommendation_items.append({"foodId": food_id, "reason": "基于当前家庭食物资料。"})
        if not recommendation_items:
            for recipe in recipes[:3]:
                recipe_id = self._optional_text(recipe.get("id"))
                if recipe_id:
                    recommendation_items.append({"recipeId": recipe_id, "reason": "基于当前家庭菜谱。"})
        if not recommendation_items:
            return cards
        card = {
            "id": create_id("ai_card"),
            "type": "today_recommendation",
            "title": "今日吃什么",
            "data": {"recommendations": recommendation_items[:3]},
        }
        return [*cards, self._normalize_recommendation_card(card, read_outputs)]

    def _state_patch_from_read_outputs(self, read_outputs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        outputs = read_outputs.get("intent.request_clarification") or []
        if not outputs:
            return {}
        latest = outputs[-1]
        clarification = {
            **latest,
            "candidates": self._clarification_candidates(latest, read_outputs),
        }
        return {
            PENDING_CLARIFICATION_KEY: build_pending_clarification(
                source_skill=self.manifest.key,
                clarification=clarification,
            )
        }

    def _clarification_candidates(
        self,
        clarification: dict[str, Any],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        explicit = self._as_list_of_dicts(clarification.get("candidates"))
        if explicit:
            return explicit
        question_type = self._optional_text(clarification.get("questionType")) or "other"
        if question_type == "unit_conversion":
            return []
        question = self._optional_text(clarification.get("question")) or ""
        return self._candidate_options_from_read_outputs(read_outputs, question)

    def _candidate_options_from_read_outputs(
        self,
        read_outputs: dict[str, list[dict[str, Any]]],
        question: str,
    ) -> list[dict[str, Any]]:
        groups: list[tuple[int, int, list[dict[str, Any]]]] = []
        ordered_outputs = [
            (tool_name, output)
            for tool_name, outputs in read_outputs.items()
            if tool_name != "intent.request_clarification"
            for output in outputs
        ]
        for order, (tool_name, output) in enumerate(ordered_outputs):
            candidates = self._candidate_options_from_tool_output(tool_name, output)
            if not candidates:
                continue
            score = self._candidate_relevance_score(candidates, question)
            groups.append((score, order, candidates))
        if not groups:
            return []
        score, _order, candidates = max(groups, key=lambda group: (group[0], group[1]))
        if score == 0 and len(groups) > 1:
            candidates = max(groups, key=lambda group: group[1])[2]
        return candidates[:8]

    def _candidate_options_from_tool_output(self, tool_name: str, output: dict[str, Any]) -> list[dict[str, Any]]:
        raw_items = self._as_list_of_dicts(output.get("items"))
        if not raw_items and isinstance(output.get("item"), dict):
            raw_items = [self._as_dict(output.get("item"))]
        if not raw_items:
            return []
        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()
        entity_type = self._optional_text(tool_name.split(".", 1)[0]) or None
        for item in raw_items:
            item_id = self._candidate_text(item, "id", "entityId", "targetId", "foodId", "recipeId", "ingredientId")
            label = self._candidate_text(item, "label", "title", "name", "food_name", "ingredient_name")
            if item_id is None or label is None or item_id in seen:
                continue
            seen.add(item_id)
            candidate = {
                "id": item_id,
                "label": label,
                "summary": self._candidate_summary(item),
                "entityType": self._candidate_text(item, "entityType") or entity_type,
                "updatedAt": self._candidate_text(item, "updatedAt", "updated_at"),
            }
            candidates.append({key: value for key, value in candidate.items() if value is not None})
        return candidates

    @staticmethod
    def _candidate_text(item: dict[str, Any], *keys: str) -> str | None:
        for key in keys:
            value = item.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return None

    def _candidate_summary(self, item: dict[str, Any]) -> str | None:
        quantity = self._candidate_text(item, "quantity")
        unit = self._candidate_text(item, "unit")
        parts = [
            f"{quantity}{unit or ''}" if quantity else None,
            self._candidate_text(item, "reason", "note", "detail", "status"),
            self._candidate_text(item, "date", "mealDate", "meal_type", "mealType"),
        ]
        summary = " · ".join(part for part in parts if part)
        return summary[:240] if summary else None

    @staticmethod
    def _candidate_relevance_score(candidates: list[dict[str, Any]], question: str) -> int:
        if not question:
            return 0
        score = 0
        for candidate in candidates:
            label = str(candidate.get("label") or "").strip()
            if label and label in question:
                score += 3
                continue
            label_tokens = [token for token in re.split(r"[\s·,，。；;、/()（）]+", label) if len(token) >= 2]
            if any(token in question for token in label_tokens):
                score += 1
        return score

    def _inventory_card_data(self, read_outputs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        summaries = read_outputs.get("inventory.read_summary", [])
        focused_tools = [
            ("inventory.read_available_items", "available"),
            ("inventory.read_expiring_items", "expiring"),
            ("inventory.read_expired_items", "expired"),
            ("inventory.read_low_stock_items", "low_stock"),
        ]
        focused_outputs = [
            (tool_name, focus, outputs[-1])
            for tool_name, focus in focused_tools
            if (outputs := read_outputs.get(tool_name))
        ]
        if summaries:
            return summaries[-1]

        merged_items: dict[str, dict[str, Any]] = {}
        for _, _, output in focused_outputs:
            for item in self._as_list_of_dicts(output.get("items")):
                item_id = str(item.get("id") or "")
                if item_id:
                    merged_items[item_id] = item
        items = list(merged_items.values())[:6]
        focus = focused_outputs[0][1] if len(focused_outputs) == 1 else "overview"
        available = self._latest_tool_items(read_outputs, "inventory.read_available_items")
        expiring = self._latest_tool_items(read_outputs, "inventory.read_expiring_items")
        low_stock = self._latest_tool_items(read_outputs, "inventory.read_low_stock_items")
        return {
            "queryFocus": focus,
            "availableCount": len(available) or len(items),
            "expiringCount": len(expiring) or sum(
                1 for item in items if item.get("displayStatus") in {"expiring", "expired"}
            ),
            "lowStockCount": len(low_stock) or sum(
                1 for item in items if item.get("displayStatus") == "low_stock"
            ),
            "items": items,
        }

    def _normalize_recommendation_card(
        self,
        card: dict[str, Any],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> dict[str, Any]:
        foods = self._latest_tool_items(read_outputs, "food.search")
        recipes = self._latest_tool_items(read_outputs, "recipe.search")
        inventory = self._latest_tool_items(read_outputs, "inventory.read_available_items")
        expiring = self._latest_tool_items(read_outputs, "inventory.read_expiring_items")
        recent = self._latest_tool_items(read_outputs, "meal_log.read_recent")
        foods_by_id = {str(item.get("id")): item for item in foods if item.get("id")}
        recipes_by_id = {str(item.get("id")): item for item in recipes if item.get("id")}
        data = card.get("data") if isinstance(card.get("data"), dict) else {}
        target_date = self._iso_date_text(data.get("targetDate"))
        meal_type = self._meal_type_text(data.get("mealType"))
        raw_recommendations = data.get("recommendations")
        if not isinstance(raw_recommendations, list) or not raw_recommendations:
            raw_recommendations = card.get("items")
        recommendations: list[dict[str, Any]] = []
        for raw in self._as_list_of_dicts(raw_recommendations)[:3]:
            food_id = self._optional_text(raw.get("foodId"))
            recipe_id = self._optional_text(raw.get("recipeId"))
            food_entity = foods_by_id.get(food_id or "") if food_id else None
            recipe_entity = recipes_by_id.get(recipe_id or "") if recipe_id else None
            if recipe_entity and not food_entity:
                linked_food_ids = recipe_entity.get("foodIds") if isinstance(recipe_entity.get("foodIds"), list) else []
                linked_food_id = next((str(item) for item in linked_food_ids if str(item) in foods_by_id), None)
                if linked_food_id:
                    food_id = linked_food_id
            entity = food_entity or recipe_entity
            entity_type = "food" if food_entity else "recipe" if recipe_entity else ""
            if not entity:
                logger.warning(
                    "Tool-calling skill discarded recommendation without real entity skill=%s food_id=%s recipe_id=%s",
                    self.manifest.key,
                    food_id,
                    recipe_id,
                )
                continue
            evidence = []
            for raw_evidence in self._as_list_of_dicts(raw.get("evidence"))[:3]:
                label = raw_evidence.get("label") or raw_evidence.get("name")
                if not label:
                    continue
                quantity = raw_evidence.get("quantity")
                unit = raw_evidence.get("unit")
                expiry_date = raw_evidence.get("expiryDate")
                details = []
                if quantity is not None:
                    details.append(f"{quantity}{unit or ''}")
                if expiry_date:
                    details.append(f"保质期至 {expiry_date}")
                evidence.append(
                    {
                        "type": str(raw_evidence.get("type") or "inventory"),
                        "id": raw_evidence.get("id"),
                        "label": str(label),
                        "status": raw_evidence.get("displayStatus") or raw_evidence.get("status"),
                        "detail": " · ".join(details) or None,
                    }
                )
            recommendations.append(
                {
                    "entityType": entity_type,
                    "entityId": str(entity["id"]),
                    "foodId": food_id,
                    "recipeId": recipe_id,
                    "name": str(entity.get("name") or entity.get("title") or "推荐"),
                    "image": entity.get("image"),
                    "category": entity.get("category"),
                    "foodType": entity.get("type"),
                    "prepMinutes": entity.get("prepMinutes"),
                    "servings": entity.get("servings"),
                    "difficulty": entity.get("difficulty"),
                    "reason": str(raw.get("reason") or ""),
                    "evidence": evidence,
                }
            )
        return {
            "id": card.get("id"),
            "type": card.get("type"),
            "title": card.get("title"),
            "data": {
                "recommendations": recommendations,
                "targetDate": target_date,
                "mealType": meal_type,
                "contextSummary": {
                    "inventoryCount": len(inventory),
                    "expiringCount": len(expiring),
                    "recentMealCount": len(recent),
                    "recipeCount": len(recipes),
                },
            },
        }

    @staticmethod
    def _iso_date_text(value: Any) -> str | None:
        text = str(value or "").strip()
        try:
            return date.fromisoformat(text).isoformat()
        except ValueError:
            return None

    @staticmethod
    def _meal_type_text(value: Any) -> str | None:
        text = str(value or "").strip()
        return text if text in {"breakfast", "lunch", "dinner", "snack"} else None

    def _latest_tool_items(self, read_outputs: dict[str, list[dict[str, Any]]], tool_name: str) -> list[dict[str, Any]]:
        outputs = read_outputs.get(tool_name, [])
        if not outputs:
            return []
        return self._as_list_of_dicts(outputs[-1].get("items"))

    def _generate_with_tools(self, provider: Any, **kwargs: Any):
        try:
            parameters = signature(provider.generate_with_tools).parameters
        except (TypeError, ValueError):
            parameters = {}
        accepts_visible_handler = "visible_text_handler" in parameters or any(
            parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values()
        )
        if accepts_visible_handler:
            return provider.generate_with_tools(**kwargs)
        kwargs.pop("visible_text_handler", None)
        return provider.generate_with_tools(**kwargs)

    def _split_dual_channel_text(self, text: str) -> tuple[str, str]:
        visible_matches = re.findall(
            f"{re.escape(VISIBLE_TEXT_OPEN)}(.*?){re.escape(VISIBLE_TEXT_CLOSE)}",
            text,
            flags=re.DOTALL,
        )
        structured_match = re.search(
            f"{re.escape(STRUCTURED_RESULT_OPEN)}(.*?){re.escape(STRUCTURED_RESULT_CLOSE)}",
            text,
            flags=re.DOTALL,
        )
        visible_text = "".join(visible_matches)
        structured_text = structured_match.group(1).strip() if structured_match else text.strip()
        return visible_text, structured_text

    def _line_delta(self, text: str) -> str:
        return text if text.endswith("\n") else f"{text}\n"

    def _compact_text(self, text: str) -> str:
        return re.sub(r"\s+", "", text)

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

    def _quick_task(self, context: SkillContext) -> str | None:
        for item in reversed(context.conversation):
            if item.get("role") != "user":
                continue
            metadata = item.get("metadata")
            if isinstance(metadata, dict) and isinstance(metadata.get("quickTask"), str):
                return metadata["quickTask"]
        return None
