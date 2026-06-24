from __future__ import annotations

import json
import logging
import inspect
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.ai.errors import AIExecutionCancelled, HumanInputRequired
from app.ai.runtime.provider import ProviderUserInput
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult
from app.ai.skills.base import SkillContext, SkillResult
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.scripts import SkillScriptExecutor
from app.ai.skills.shared import conversation_artifacts, model_name
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.result_cards import validate_result_cards
from app.core.utils import create_id

logger = logging.getLogger(__name__)
ORCHESTRATOR_BASE_TOOL_NAMES = {"skill.inject", "human.request_input"}
MAX_BUSINESS_SKILLS_PER_RUN = 4
MAX_TOTAL_TOOL_CALLS_PER_RUN = 32
MAX_SAME_READ_TOOL_CALLS_PER_RUN = 3


@dataclass(slots=True)
class SkillInjectionBundle:
    key: str
    display_name: str
    instructions: str
    manifest_record: dict[str, Any]
    allowed_tools: list[str] = field(default_factory=list)
    output_types: list[str] = field(default_factory=list)
    draft_types: list[str] = field(default_factory=list)
    approval_policy: str = "none"


class SkillInjectionManager:
    def __init__(self, skill_registry: SkillRegistry) -> None:
        self.skill_registry = skill_registry

    def catalog_records(self) -> list[dict[str, Any]]:
        return [manifest.to_catalog_record() for manifest in self.skill_registry.list_manifests()]

    def inject(
        self,
        existing_keys: list[str],
        requested_keys: list[str],
    ) -> tuple[list[str], list[SkillInjectionBundle]]:
        next_keys = list(dict.fromkeys(existing_keys))
        added: list[SkillInjectionBundle] = []
        for key in requested_keys:
            normalized_key = str(key or "").strip()
            if not normalized_key:
                continue
            if normalized_key not in self.skill_registry.keys():
                raise ValueError(f"unknown skill injection: {normalized_key}")
            if normalized_key in next_keys:
                continue
            next_keys.append(normalized_key)
            added.append(self.bundle_for(normalized_key))
        return next_keys, added

    def bundle_for(self, skill_key: str) -> SkillInjectionBundle:
        skill = self.skill_registry.get(skill_key)
        manifest = skill.manifest
        return SkillInjectionBundle(
            key=manifest.key,
            display_name=manifest.name,
            instructions=str(getattr(skill, "instructions", "") or ""),
            manifest_record=manifest.to_catalog_record(),
            allowed_tools=list(manifest.tools),
            output_types=list(manifest.output_types),
            draft_types=list(manifest.draft_types),
            approval_policy=manifest.approval_policy,
        )

    def bundles_for(self, skill_keys: list[str]) -> list[SkillInjectionBundle]:
        return [self.bundle_for(key) for key in skill_keys]

    def allowed_tool_names(self, skill_keys: list[str]) -> set[str]:
        names: set[str] = set(ORCHESTRATOR_BASE_TOOL_NAMES)
        for key in skill_keys:
            names.update(self.skill_registry.get(key).manifest.tools)
        return names

    def allowed_output_types(self, skill_keys: list[str]) -> set[str]:
        values: set[str] = set()
        for key in skill_keys:
            values.update(self.skill_registry.get(key).manifest.output_types)
        return values

    def allowed_draft_types(self, skill_keys: list[str]) -> set[str]:
        values: set[str] = set()
        for key in skill_keys:
            values.update(self.skill_registry.get(key).manifest.draft_types)
        return values

    def tool_definitions(
        self,
        skill_keys: list[str],
        context: SkillContext,
    ) -> tuple[list[ToolDefinition], dict[str, SkillScriptExecutor]]:
        definitions: list[ToolDefinition] = []
        script_executors: dict[str, SkillScriptExecutor] = {}
        for name in sorted(self.allowed_tool_names(skill_keys)):
            definition = context.tool_executor.registry.get(name)
            if definition.side_effect == "write":
                raise ValueError(f"Injected skills must not expose write tool: {name}")
            definitions.append(definition)

        for key in skill_keys:
            skill = self.skill_registry.get(key)
            script_catalog = getattr(skill, "script_catalog", None)
            if script_catalog is None:
                continue
            executor = SkillScriptExecutor(script_catalog, context)
            for definition in executor.tool_definitions():
                if definition.name in script_executors:
                    raise ValueError(f"Duplicate injected script tool: {definition.name}")
                script_executors[definition.name] = executor
                definitions.append(definition)
        return definitions, script_executors

    def scoped_tool_executor(self, context: SkillContext, skill_keys: list[str]):
        allowed_side_effects = {"read", "control"}
        if any(self.skill_registry.get(key).manifest.approval_policy == "draft_then_confirm" for key in skill_keys):
            allowed_side_effects.add("draft")
        return context.tool_executor.scoped(
            allowed_tools=self.allowed_tool_names(skill_keys),
            allowed_side_effects=allowed_side_effects,
        )

    def skill_keys_for_tool(self, tool_name: str, skill_keys: list[str]) -> list[str]:
        if tool_name in ORCHESTRATOR_BASE_TOOL_NAMES:
            return []
        return [
            key
            for key in skill_keys
            if tool_name in self.skill_registry.get(key).manifest.tools
        ]


class WorkspaceOrchestratorAgent:
    def __init__(
        self,
        *,
        provider: BaseChatProvider,
        skill_registry: SkillRegistry,
        max_rounds: int = 12,
    ) -> None:
        self.provider = provider
        self.injection_manager = SkillInjectionManager(skill_registry)
        self.max_rounds = max_rounds

    def run(
        self,
        context: SkillContext,
        *,
        injected_skill_keys: list[str] | None = None,
    ) -> SkillResult:
        context.ensure_active()
        root_tool_executor = context.tool_executor
        active_skill_keys, initial_bundles = self.injection_manager.inject([], injected_skill_keys or [])
        injection_history = [
            {"skillKey": bundle.key, "displayName": bundle.display_name, "source": "initial"}
            for bundle in initial_bundles
        ]
        draft_outputs: list[dict[str, Any]] = []
        published_drafts_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        draft_input_keys_this_call: set[tuple[str, str]] = set()
        read_outputs: dict[str, list[dict[str, Any]]] = {}
        historical_tool_signatures = self._historical_tool_signatures(context)
        tool_signatures_this_call: list[str] = []
        draft_created_this_call = False
        human_input_requested_this_call = False

        def emit_visible_delta(message_id: str, part_id: str, delta: str) -> None:
            context.ensure_active()
            if context.stream_writer is None or not delta or draft_created_this_call:
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

        stream_session_id = create_id("ai_stream")
        message_id = f"{context.run_id}:orchestrator:{stream_session_id}:text"
        part_id = f"{message_id}:text"
        streamed_text: list[str] = []
        current_scoped_executor = self.injection_manager.scoped_tool_executor(context, active_skill_keys)
        current_script_executors: dict[str, SkillScriptExecutor] = {}
        current_tool_names: set[str] = set()
        current_tool_definitions: dict[str, ToolDefinition] = {}
        preview_event_ids_by_key: dict[str, str] = {}

        def refresh_tools() -> list[ToolDefinition]:
            nonlocal current_scoped_executor, current_script_executors, current_tool_names, current_tool_definitions
            context.ensure_active()
            current_scoped_executor = self.injection_manager.scoped_tool_executor(context, active_skill_keys)
            context.tool_executor = current_scoped_executor
            tools, current_script_executors = self.injection_manager.tool_definitions(active_skill_keys, context)
            current_tool_names = {definition.name for definition in tools}
            current_tool_definitions = {definition.name: definition for definition in tools}
            return tools

        def tool_progress_message(name: str, status: str) -> tuple[str, str]:
            definition = current_tool_definitions.get(name)
            display_name = definition.display_name if definition else name
            side_effect = definition.side_effect if definition else "read"
            if name == "human.request_input" and status != "failed":
                return "waiting", "等待用户补充信息"
            if status == "failed":
                return "failed", f"「{display_name}」调用失败"
            if side_effect == "draft":
                return status, f"生成「{display_name}」"
            return status, f"调用「{display_name}」"

        def preview_tool_call(name: str, preview_key: str, status: str) -> str | None:
            context.ensure_active()
            if name == "skill.inject":
                return None
            if name not in current_tool_names:
                return None
            event_id = create_id("ai_run_event") if status == "running" else preview_event_ids_by_key.get(preview_key) or create_id("ai_run_event")
            preview_event_ids_by_key[preview_key] = event_id
            event_type = "script" if name in current_script_executors else "tool"
            visible_status, user_message = tool_progress_message(name, status)
            context.emit_progress(event_type, name, user_message, status=visible_status, event_id=event_id)
            return event_id

        def inject_skills(payload: dict[str, Any]) -> dict[str, Any]:
            nonlocal active_skill_keys
            requested = self._as_list(payload.get("skills"))
            if not requested:
                return {"injectedSkills": [], "alreadyInjected": [], "availableTools": sorted(current_tool_names)}
            if len(active_skill_keys) >= MAX_BUSINESS_SKILLS_PER_RUN:
                return {
                    "error": f"本次任务最多注入 {MAX_BUSINESS_SKILLS_PER_RUN} 个业务 Skill。",
                    "code": "skill_budget_exhausted",
                    "injectedSkills": [],
                    "alreadyInjected": [key for key in requested if key in active_skill_keys],
                    "availableTools": sorted(current_tool_names),
                }
            available_slots = max(0, MAX_BUSINESS_SKILLS_PER_RUN - len(active_skill_keys))
            requested_existing = [key for key in requested if key in active_skill_keys]
            requested_new = [key for key in requested if key not in active_skill_keys][:available_slots]
            active_skill_keys, added = self.injection_manager.inject(active_skill_keys, requested_new)
            if added:
                injection_history.extend(
                    {"skillKey": bundle.key, "displayName": bundle.display_name, "source": "tool"}
                    for bundle in added
                )
                for bundle in added:
                    context.emit_progress("skill", f"{bundle.key}.start", f"调用「{bundle.display_name}」技能", status="completed")
            next_tools, _ = self.injection_manager.tool_definitions(active_skill_keys, context)
            return {
                "injectedSkills": [
                    {
                        "key": bundle.key,
                        "displayName": bundle.display_name,
                        "instructions": bundle.instructions,
                        "allowedTools": bundle.allowed_tools,
                        "draftTypes": bundle.draft_types,
                    }
                    for bundle in added
                ],
                "alreadyInjected": requested_existing,
                "availableTools": sorted(definition.name for definition in next_tools),
            }

        try:
            refresh_tools()

            def call_tool(name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                nonlocal draft_created_this_call, human_input_requested_this_call
                context.ensure_active()
                if name == "skill.inject":
                    return inject_skills(payload)
                if name not in current_tool_names:
                    return {
                        "error": f"当前 round 未暴露工具 {name}。如需业务能力，请先调用 skill.inject。",
                        "code": "unavailable_tool",
                        "status": "unavailable_tool",
                    }
                if name in current_script_executors:
                    return current_script_executors[name].call(name, payload, progress_event_id=progress_event_id)
                definition = current_scoped_executor.registry.get(name)
                tool_payload = payload
                after_approval = {}
                if definition.side_effect == "draft" and isinstance(payload.get("draft"), dict):
                    input_properties = definition.input_schema.get("properties") if isinstance(definition.input_schema, dict) else {}
                    tool_payload = {"draft": payload["draft"]} if isinstance(input_properties, dict) and "draft" in input_properties else payload["draft"]
                    after_approval = payload.get("afterApproval") if isinstance(payload.get("afterApproval"), dict) else {}
                tool_signature = self._tool_signature(name, tool_payload)
                total_tool_count = len(historical_tool_signatures) + len(context.tool_executor.records())
                if total_tool_count >= MAX_TOTAL_TOOL_CALLS_PER_RUN:
                    return {
                        "error": "本次任务的工具调用次数已经达到上限。请基于已有结果总结，或让用户缩小任务范围。",
                        "code": "tool_budget_exhausted",
                        "status": "stop_current_run",
                    }
                if (
                    definition.side_effect == "read"
                    and (historical_tool_signatures + tool_signatures_this_call).count(tool_signature) >= MAX_SAME_READ_TOOL_CALLS_PER_RUN
                ):
                    return {
                        "error": "已经读取过相同数据多次。请基于已有工具结果继续，不要重复调用同一个读取工具。",
                        "code": "tool_loop_detected",
                        "status": "use_existing_result",
                    }
                if definition.side_effect == "draft" and draft_created_this_call:
                    retry_draft = tool_payload.get("draft") if isinstance(tool_payload.get("draft"), dict) else {}
                    if retry_draft:
                        retry_draft_type = self._draft_type_from_tool_output(name, retry_draft, active_skill_keys)
                        retry_key = (
                            retry_draft_type,
                            json.dumps(retry_draft, sort_keys=True, ensure_ascii=False, default=str),
                        )
                        if retry_key in draft_input_keys_this_call:
                            return {
                                "draft": retry_draft,
                                "status": "already_published",
                                "code": "draft_already_published",
                                "__tool_loop_stop__": {"status": "waiting_approval"},
                            }
                    return {
                        "error": "本轮已经生成一个草稿。请结束当前动作，等待用户确认后再继续生成后续草稿。",
                        "code": "draft_budget_exhausted",
                        "status": "wait_for_approval",
                        "__tool_loop_stop__": {"status": "waiting_approval"},
                    }
                if name == "human.request_input" and human_input_requested_this_call:
                    return {
                        "error": "本轮已经请求过用户补充信息。请结束当前动作，等待用户回复。",
                        "code": "human_input_budget_exhausted",
                        "status": "waiting_input",
                    }
                output = current_scoped_executor.call(name, tool_payload, progress_event_id=progress_event_id)
                tool_signatures_this_call.append(tool_signature)
                context.ensure_active()
                if definition.side_effect == "read":
                    if name not in read_outputs:
                        read_outputs[name] = []
                    read_outputs[name].append(output)
                if name == "human.request_input":
                    human_input_requested_this_call = True
                    request = {
                        "id": create_id("human_input"),
                        **output,
                    }
                    raise HumanInputRequired(request)
                if definition.side_effect == "draft":
                    draft_created_this_call = True
                    input_draft = tool_payload.get("draft") if isinstance(tool_payload.get("draft"), dict) else {}
                    draft = output.get("draft")
                    if isinstance(draft, dict):
                        draft_type = self._draft_type_from_tool_output(name, draft, active_skill_keys)
                        if input_draft:
                            draft_input_keys_this_call.add(
                                (
                                    self._draft_type_from_tool_output(name, input_draft, active_skill_keys),
                                    json.dumps(input_draft, sort_keys=True, ensure_ascii=False, default=str),
                                )
                            )
                        draft_record = {
                            "draft_type": draft_type,
                            "payload": draft,
                            "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
                            "tool": name,
                            "after_approval": after_approval,
                        }
                        draft_key = (
                            draft_type,
                            json.dumps(draft, sort_keys=True, ensure_ascii=False, default=str),
                        )
                        published = published_drafts_by_key.get(draft_key)
                        if published is None and context.progressive_draft_publisher is not None:
                            published = context.progressive_draft_publisher(draft_record)
                            published_drafts_by_key[draft_key] = published
                        if published:
                            draft_record.update(published)
                        draft_outputs.append(draft_record)
                    return {**output, "__tool_loop_stop__": {"status": "waiting_approval"}}
                return output

            def handle_message_delta(delta: str) -> None:
                if not delta:
                    return
                streamed_text.append(delta)
                emit_visible_delta(message_id, part_id, delta)

            provider_kwargs = {
                "system": self._system_prompt(active_skill_keys),
                "user": self._provider_user_input(context, active_skill_keys, injection_history),
                "tools": refresh_tools,
                "tool_handler": call_tool,
                "message_handler": handle_message_delta,
                "max_rounds": max(4, self.max_rounds),
            }
            if "tool_preview_handler" in inspect.signature(self.provider.generate_with_tools).parameters:
                provider_kwargs["tool_preview_handler"] = preview_tool_call
            provider_result = self.provider.generate_with_tools(**provider_kwargs)
            if provider_result.status in {"failed", "fallback"}:
                return self._failed_result(
                    provider_result,
                    context,
                    "orchestrator provider unavailable",
                    active_skill_keys=active_skill_keys,
                    injection_history=injection_history,
                )
            text = provider_result.text or "".join(streamed_text).strip()
            drafts = self._validated_drafts(draft_outputs, active_skill_keys)
            status = "waiting_approval" if drafts else "completed"
            cards = [] if drafts else self._program_result_cards(context, read_outputs)
            context_summary = {
                "orchestrator": {
                    "injectedSkills": active_skill_keys,
                    "injectionHistory": injection_history,
                    "readTools": sorted(read_outputs.keys()),
                },
                **self._program_context_summary(read_outputs),
            }
            return SkillResult(
                text=text or "",
                cards=cards,
                drafts=drafts,
                context_summary=context_summary,
                status=status,
                model=provider_result.model or model_name(context),
                error=provider_result.error,
                tool_calls=context.tool_executor.records(),
            )
        except HumanInputRequired as exc:
            return SkillResult(
                text=str(exc.request.get("question") or "我需要你补充一点信息。"),
                status="waiting_input",
                model=model_name(context),
                context_summary={
                    "orchestrator": {
                        "injectedSkills": active_skill_keys,
                        "injectionHistory": injection_history,
                        "readTools": sorted(read_outputs.keys()),
                    },
                    "pendingHumanInput": exc.request,
                },
                state_patch={"pendingHumanInput": exc.request},
            )
        except AIExecutionCancelled:
            raise
        except Exception as exc:
            logger.warning(
                "Workspace orchestrator failed run_id=%s conversation_id=%s family_id=%s error=%s",
                context.run_id,
                context.conversation_id,
                context.family_id,
                exc,
                exc_info=True,
            )
            return SkillResult(
                text="AI 工作台执行失败，请重试。",
                status="failed",
                model=model_name(context),
                error=str(exc),
                diagnostic=str(exc),
            )
        finally:
            context.tool_executor = root_tool_executor
        return SkillResult(
            text="AI 工作台执行轮次过多，请调整请求后重试。",
            status="failed",
            model=model_name(context),
            error="orchestrator max rounds exceeded",
        )

    def _system_prompt(self, active_skill_keys: list[str]) -> str:
        bundles = self.injection_manager.bundles_for(active_skill_keys)
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        return (
            "你是 Culina AI 工作台的主 Orchestrator。"
            "你可以输出普通 assistant 文本，也可以调用工具；普通文本会直接展示给用户。"
            "你负责直接回答、按需调用 skill.inject 注入 Skill、调用已注入 Skill 的工具，并组织用户可见回复。"
            "本系统采用 agent run loop：每次只推进一个有边界的下一步动作，而不是一次性完成所有后续动作。"
            "Skill 是能力和上下文注入包，不是独立子 agent；注入后本 run 内持续可见。"
            "初始只能根据 catalog record 判断需要哪些能力；如果需要新能力，必须先调用 skill.inject。"
            "你不能调用未注入 Skill 的业务工具。"
            "正式写入必须通过 draft tool 生成草稿并等待 approval；不要声称已经完成正式写入。"
            "本轮最多生成一个 draft；生成 draft 后必须结束当前动作并等待 approval。"
            "准备调用 draft tool 前，必须先输出普通文本，说明接下来要生成什么草稿以及为什么。"
            "调用 draft tool 后，不要再输出任何用户可见文本；不要说“已生成”“请确认”“草稿准备好了”。"
            "如果 draft 确认后还需要继续推进，请在 draft tool 参数 afterApproval 中写入简短、可执行的后续任务说明。"
            "当 currentRunArtifacts 里出现 approval_decision 且 approval.status=rejected 时，把它当作 HumanInLoop 工具返回：先尊重拒绝结果，再判断是结束、调整重做，还是继续处理同一任务中的下一项。"
            "拒绝后不要默认停止，也不要盲目执行原草稿的 afterApproval；是否继续由你基于用户原始目标、拒绝结果和当前上下文决定。"
            "当 currentRunArtifacts 里出现 type=draft_after_approval 或 type=resume_after_approval，且最近 approval_decision 不是 rejected 时，优先执行其 payload.instruction 指定的确认后下一步。"
            "当 currentRunArtifacts 同时包含 approval_decision 和确认后继续 artifact 时，确认后的总结和下一步说明都由本 Orchestrator 输出；"
            "在调用下一个工具前，用普通文本简短说明已按确认完成了什么，以及接下来继续做什么，例如“已创建白切鸡。接下来我继续整理下一份菜谱草稿。”"
            "确认后如果马上需要生成下一个 draft，把这段自然语言作为下一个 draft 前置说明，而不是上一个 draft 的尾巴。"
            f"这些是当前已注入 Skill 允许的 draft_types：{json.dumps(allowed_draft_types, ensure_ascii=False)}。"
            "需要创建或修改正式数据时必须调用对应 draft tool，等待审批结果卡片由系统生成。"
            "不要输出 XML 标签、JSON 状态对象、Markdown 代码块或 structured_result。"
            "\n\nCatalog records:\n"
            f"{json.dumps(self.injection_manager.catalog_records(), ensure_ascii=False, default=str)}"
            "\n\nInjected skills:\n"
            f"{json.dumps([bundle.manifest_record for bundle in bundles], ensure_ascii=False, default=str)}"
            "\n\nInjected skill instructions:\n"
            + "\n\n---\n\n".join(
                f"# {bundle.display_name} ({bundle.key})\n\n{bundle.instructions}"
                for bundle in bundles
                if bundle.instructions
            )
        )

    def _user_payload(
        self,
        context: SkillContext,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
    ) -> dict[str, Any]:
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        return {
            "currentMessage": context.current_message,
            "currentAttachments": context.current_message_attachments,
            "quickTask": context.quick_task,
            "subject": context.subject,
            "conversation": context.conversation,
            "artifacts": conversation_artifacts(context),
            "previousResults": [self._result_record(item) for item in context.previous_results],
            "currentRunArtifacts": context.current_run_artifacts,
            "injectedSkills": active_skill_keys,
            "injectionHistory": injection_history,
            "allowedDraftTypes": allowed_draft_types,
        }

    def _provider_user_input(
        self,
        context: SkillContext,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
    ) -> str | ProviderUserInput:
        text = json.dumps(
            self._user_payload(
                context,
                active_skill_keys,
                injection_history,
            ),
            ensure_ascii=False,
            default=str,
        )
        if not context.current_message_images:
            return text
        return ProviderUserInput(text=text, images=context.current_message_images)

    def _cards_from_read_outputs(
        self,
        cards: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for card in cards:
            card_type = str(card.get("type") or "")
            if card_type == "today_recommendation":
                normalized.append(self._normalize_recommendation_card(card, read_outputs))
                continue
            normalized.append(card)
        return normalized

    def _program_result_cards(
        self,
        context: SkillContext,
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        message = str(context.current_message or "")
        inventory_summary = self._latest_tool_output(read_outputs, "inventory.read_summary")
        recommendation_mode = context.quick_task == "today_recommendation" or (
            any(term in message for term in ["今日吃什么", "今天吃什么", "今晚吃什么", "推荐一餐"])
            and not any(term in message for term in ["安排", "计划", "菜单", "制定", "修改", "第二天", "三天"])
        )
        if not recommendation_mode:
            if inventory_summary:
                return [
                    {
                        "id": create_id("ai_card"),
                        "type": "inventory_summary",
                        "title": "库存概览",
                        "data": inventory_summary,
                    }
                ]
            return []
        foods = self._latest_tool_items(read_outputs, "food.search")
        recipes = self._latest_tool_items(read_outputs, "recipe.search")
        candidates: list[dict[str, Any]] = [
            {"foodId": str(item["id"]), "reason": "优先使用当前家庭已有食物。"}
            for item in foods
            if item.get("id")
        ]
        if not candidates:
            candidates = [
                {"recipeId": str(item["id"]), "reason": "结合当前库存和菜谱库推荐。"}
                for item in recipes
                if item.get("id")
            ]
        if not candidates:
            return []
        return self._cards_from_read_outputs(
            [
                {
                    "id": create_id("ai_card"),
                    "type": "today_recommendation",
                    "title": "今日吃什么",
                    "data": {
                        "recommendations": candidates[:3],
                        "contextSummary": {},
                    },
                }
            ],
            read_outputs,
        )

    def _program_context_summary(self, read_outputs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        inventory_summary = self._latest_tool_output(read_outputs, "inventory.read_summary")
        if inventory_summary:
            summary["inventoryItemCount"] = inventory_summary.get("availableCount", 0)
            summary["expiringItemCount"] = inventory_summary.get("expiringCount", 0)
            summary["lowStockItemCount"] = inventory_summary.get("lowStockCount", 0)
        available = self._latest_tool_output(read_outputs, "inventory.read_available_items")
        if available and "count" in available:
            summary.setdefault("inventoryItemCount", available.get("count", 0))
        expiring = self._latest_tool_output(read_outputs, "inventory.read_expiring_items")
        if expiring and "count" in expiring:
            summary["expiringItemCount"] = expiring.get("count", summary.get("expiringItemCount", 0))
        return summary

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
                    food_entity = foods_by_id.get(food_id)
            entity = food_entity or recipe_entity
            entity_type = "food" if food_entity else "recipe" if recipe_entity else ""
            if not entity:
                logger.warning("Orchestrator discarded recommendation without real entity food_id=%s recipe_id=%s", food_id, recipe_id)
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
                "targetDate": self._iso_date_text(data.get("targetDate")),
                "mealType": self._meal_type_text(data.get("mealType")),
                "contextSummary": {
                    "inventoryCount": len(inventory),
                    "expiringCount": len(expiring),
                    "recentMealCount": len(recent),
                    "recipeCount": len(recipes),
                },
            },
        }

    def _historical_tool_signatures(self, context: SkillContext) -> list[str]:
        signatures: list[str] = []
        for artifact in context.current_run_artifacts:
            if not isinstance(artifact, dict) or artifact.get("type") != "tool_call":
                continue
            signature = str(artifact.get("signature") or "").strip()
            if signature:
                signatures.append(signature)
        return signatures

    def _tool_signature(self, name: str, payload: dict[str, Any] | None) -> str:
        return f"{name}:{json.dumps(payload or {}, sort_keys=True, ensure_ascii=False, default=str)}"

    def _draft_type_from_tool_output(self, tool_name: str, draft: dict[str, Any], active_skill_keys: list[str]) -> str:
        draft_type = str(draft.get("draftType") or draft.get("draft_type") or "").strip()
        if draft_type:
            return draft_type
        candidate_types: set[str] = set()
        for key in self.injection_manager.skill_keys_for_tool(tool_name, active_skill_keys):
            manifest = self.injection_manager.skill_registry.get(key).manifest
            if len(manifest.draft_types) == 1:
                candidate_types.add(manifest.draft_types[0])
        if len(candidate_types) == 1:
            return next(iter(candidate_types))
        allowed = self.injection_manager.allowed_draft_types(active_skill_keys)
        if len(allowed) == 1:
            return next(iter(allowed))
        raise ValueError(f"Draft tool {tool_name} did not identify draft type")

    def _draft_card_type_aliases(self, active_skill_keys: list[str]) -> set[str]:
        aliases = {"approval_request", "draft"}
        for draft_type in self.injection_manager.allowed_draft_types(active_skill_keys):
            if not draft_type:
                continue
            aliases.add(draft_type)
            aliases.add(f"{draft_type}_draft")
        return aliases

    def _validated_drafts(self, drafts: list[dict[str, Any]], active_skill_keys: list[str]) -> list[dict[str, Any]]:
        allowed = self.injection_manager.allowed_draft_types(active_skill_keys)
        validated: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for draft in drafts:
            draft_type = str(draft.get("draft_type") or "")
            if draft_type not in allowed:
                raise ValueError(f"Orchestrator generated undeclared draft type: {draft_type}")
            payload = draft.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("Orchestrator generated invalid draft payload")
            key = (draft_type, json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str))
            if key in seen:
                continue
            seen.add(key)
            validated.append(
                {
                    "draft_type": draft_type,
                    "payload": payload,
                    "schema_version": str(draft.get("schema_version") or f"{draft_type}.v1"),
                    "tool": draft.get("tool"),
                    "after_approval": draft.get("after_approval") if isinstance(draft.get("after_approval"), dict) else {},
                    **(
                        {
                            "draft_id": draft["draft_id"],
                            "approval_id": draft["approval_id"],
                            "published_part_ids": draft.get("published_part_ids") or [],
                        }
                        if draft.get("draft_id") and draft.get("approval_id")
                        else {}
                    ),
                }
            )
        return validated

    def _validated_cards(self, cards: list[dict[str, Any]], active_skill_keys: list[str]) -> list[dict[str, Any]]:
        allowed = self.injection_manager.allowed_output_types(active_skill_keys) | {"error_recovery"}
        for card in cards:
            card_type = str(card.get("type") or "")
            if not card_type:
                raise ValueError("Orchestrator returned card without type")
            if allowed and card_type not in allowed:
                raise ValueError(f"Orchestrator returned undeclared card type: {card_type}")
        return validate_result_cards(cards)

    def _failed_result(
        self,
        provider_result: ChatProviderResult,
        context: SkillContext,
        error: str,
        *,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
    ) -> SkillResult:
        return SkillResult(
            text="AI 工作台暂时无法完成这次请求，请稍后重试。",
            status="failed",
            model=provider_result.model or model_name(context),
            error=provider_result.error or error,
            diagnostic=provider_result.error or error,
            context_summary={
                "orchestrator": {
                    "injectedSkills": active_skill_keys,
                    "injectionHistory": injection_history,
                    "readTools": [],
                },
            },
        )

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

    def _as_list(self, value: Any) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        return []

    def _latest_tool_items(self, read_outputs: dict[str, list[dict[str, Any]]], tool_name: str) -> list[dict[str, Any]]:
        return self._as_list_of_dicts(self._latest_tool_output(read_outputs, tool_name).get("items"))

    def _latest_tool_output(self, read_outputs: dict[str, list[dict[str, Any]]], tool_name: str) -> dict[str, Any]:
        outputs = read_outputs.get(tool_name, [])
        if not outputs:
            return {}
        latest = outputs[-1]
        return latest if isinstance(latest, dict) else {}

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

    def _as_list_of_dicts(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    def _optional_text(self, value: Any) -> str | None:
        text = str(value).strip() if value is not None else ""
        return text or None
