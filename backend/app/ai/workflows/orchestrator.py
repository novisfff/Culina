from __future__ import annotations

from copy import deepcopy
import json
import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.ai.errors import AIExecutionCancelled, HumanInputRequired
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult
from app.ai.skills.base import SkillContext, SkillResult
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.scripts import SkillScriptExecutor
from app.ai.skills.shared import conversation_artifacts, json_object, model_name
from app.ai.skills.toolcall import (
    STRUCTURED_RESULT_CLOSE,
    STRUCTURED_RESULT_OPEN,
    VISIBLE_TEXT_CLOSE,
    VISIBLE_TEXT_OPEN,
    VisibleTextStream,
)
from app.ai.tools.base import ToolDefinition
from app.ai.tools.validation import validate_json_value
from app.ai.workflows.result_cards import validate_result_cards
from app.core.utils import create_id

logger = logging.getLogger(__name__)
ORCHESTRATOR_BASE_TOOL_NAMES = {"human.request_input"}


ORCHESTRATOR_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": ["continue", "finalize"]},
        "injectSkills": {
            "type": "array",
            "items": {"type": "string"},
            "uniqueItems": True,
        },
        "text": {"type": "string"},
        "cards": {"type": "array", "items": {"type": "object"}},
        "events": {"type": "array", "items": {"type": "object"}},
        "context_summary": {"type": "object"},
        "state_patch": {"type": "object"},
        "requires_clarification": {"type": "boolean"},
        "status": {"type": "string", "enum": ["completed", "failed", "running"]},
        "error": {"type": ["string", "null"]},
        "operation": {"type": ["string", "null"]},
        "source_artifact_id": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "required": ["action"],
}


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
        allowed_side_effects = {"read"}
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
        read_outputs: dict[str, list[dict[str, Any]]] = {}
        validation_error = ""

        def emit_visible_delta(message_id: str, part_id: str, delta: str) -> None:
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

        try:
            for round_index in range(1, self.max_rounds + 1):
                context.ensure_active()
                scoped_executor = self.injection_manager.scoped_tool_executor(context, active_skill_keys)
                context.tool_executor = scoped_executor
                tools, script_executors = self.injection_manager.tool_definitions(active_skill_keys, context)

                def call_tool(name: str, payload: dict[str, Any]) -> dict[str, Any]:
                    context.ensure_active()
                    if name in script_executors:
                        return script_executors[name].call(name, payload)
                    definition = scoped_executor.registry.get(name)
                    output = scoped_executor.call(name, payload)
                    context.ensure_active()
                    if definition.side_effect == "read":
                        if name not in read_outputs:
                            read_outputs[name] = []
                        read_outputs[name].append(output)
                    if name == "human.request_input":
                        request = {
                            "id": create_id("human_input"),
                            **output,
                        }
                        raise HumanInputRequired(request)
                    if definition.side_effect == "draft":
                        draft = output.get("draft")
                        if isinstance(draft, dict):
                            draft_type = self._draft_type_from_tool_output(name, draft, active_skill_keys)
                            draft_outputs.append(
                                {
                                    "draft_type": draft_type,
                                    "payload": draft,
                                    "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
                                    "tool": name,
                                }
                            )
                    return output

                message_id = f"{context.run_id}:orchestrator:{round_index}"
                part_id = f"{message_id}:text"
                visible_stream = VisibleTextStream(lambda delta: emit_visible_delta(message_id, part_id, delta))
                provider_result = self.provider.generate_with_tools(
                    system=self._system_prompt(active_skill_keys),
                    user=json.dumps(
                        self._user_payload(
                            context,
                            active_skill_keys,
                            injection_history,
                            validation_error=validation_error,
                        ),
                        ensure_ascii=False,
                        default=str,
                    ),
                    tools=tools,
                    tool_handler=call_tool,
                    response_schema=self._response_schema(active_skill_keys),
                    max_rounds=max(4, min(18, len(tools) + 4)),
                    visible_text_handler=visible_stream.feed,
                )
                visible_stream.flush()
                if provider_result.status in {"failed", "fallback"} and not provider_result.text:
                    return self._failed_result(
                        provider_result,
                        context,
                        "orchestrator provider unavailable",
                        active_skill_keys=active_skill_keys,
                        injection_history=injection_history,
                    )
                parsed = self._parse_result(provider_result.text or "")
                if parsed is None:
                    validation_error = "structured_result 必须是裸 JSON 对象，不能是 Markdown、普通文本或数组。"
                    logger.warning(
                        "Workspace orchestrator invalid structured JSON run_id=%s conversation_id=%s family_id=%s round=%s raw_preview=%r",
                        context.run_id,
                        context.conversation_id,
                        context.family_id,
                        round_index,
                        (provider_result.text or "")[:500],
                    )
                    if round_index < self.max_rounds:
                        continue
                    return self._failed_result(
                        provider_result,
                        context,
                        "invalid orchestrator model response",
                        active_skill_keys=active_skill_keys,
                        injection_history=injection_history,
                    )
                schema_error = self._structured_result_schema_error(parsed, active_skill_keys)
                if schema_error:
                    validation_error = schema_error
                    logger.warning(
                        "Workspace orchestrator structured result schema failed run_id=%s conversation_id=%s family_id=%s round=%s error=%s parsed_keys=%s",
                        context.run_id,
                        context.conversation_id,
                        context.family_id,
                        round_index,
                        schema_error,
                        sorted(parsed.keys()),
                    )
                    if round_index < self.max_rounds:
                        continue
                    return self._failed_result(
                        provider_result,
                        context,
                        "invalid orchestrator structured result schema",
                        active_skill_keys=active_skill_keys,
                        injection_history=injection_history,
                    )
                validation_error = ""

                requested_skills = self._as_list(parsed.get("injectSkills"))
                active_skill_keys, added = self.injection_manager.inject(active_skill_keys, requested_skills)
                if added:
                    injection_history.extend(
                        {"skillKey": bundle.key, "displayName": bundle.display_name, "source": "model"}
                        for bundle in added
                    )
                    for bundle in added:
                        context.emit_progress("skill", f"{bundle.key}.start", f"调用「{bundle.display_name}」技能")
                    continue
                if str(parsed.get("action") or "") == "continue":
                    continue
                result = self._skill_result_from_parsed(
                    parsed,
                    provider_result,
                    context,
                    visible_stream.text,
                    active_skill_keys,
                    injection_history,
                    draft_outputs,
                    read_outputs,
                )
                for key in active_skill_keys:
                    bundle = self.injection_manager.bundle_for(key)
                    if result.status == "failed":
                        context.emit_progress("skill", f"{key}.failed", f"{bundle.display_name}执行失败", "failed")
                    elif result.status == "waiting_input":
                        context.emit_progress("skill", f"{key}.waiting_input", f"{bundle.display_name}等待补充信息", "waiting")
                    else:
                        context.emit_progress("skill", f"{key}.completed", f"{bundle.display_name}执行完成", "completed")
                return result
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
        allowed_card_types = sorted(self.injection_manager.allowed_output_types(active_skill_keys) | {"error_recovery"})
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        return (
            "你是 Culina AI 工作台的主 Orchestrator。"
            "你负责直接回答、按需注入 Skill、调用已注入 Skill 的工具，并组织最终用户回复。"
            "Skill 是能力和上下文注入包，不是独立子 agent；注入后本 run 内持续可见。"
            "初始只能根据 catalog record 判断需要哪些能力；只有注入后才能使用该 Skill 的完整 instructions 和 tools。"
            "你不能调用未注入 Skill 的业务工具。如果需要新能力，先在 structured_result.injectSkills 中声明。"
            "正式写入必须通过 draft tool 生成草稿并等待 approval；不要声称已经完成正式写入。"
            f"本轮 structured_result.cards[].type 只能使用这些 result card 类型：{json.dumps(allowed_card_types, ensure_ascii=False)}。"
            f"这些是 draft_types，不是 card type，不能放进 cards[].type：{json.dumps(allowed_draft_types, ensure_ascii=False)}。"
            "需要创建或修改正式数据时必须调用对应 draft tool，并让 cards 保持空数组，等待审批结果卡片由系统生成。"
            f"最终回复必须包含 {VISIBLE_TEXT_OPEN}用户可见回复{VISIBLE_TEXT_CLOSE}，随后输出 "
            f"{STRUCTURED_RESULT_OPEN}Orchestrator JSON{STRUCTURED_RESULT_CLOSE}。"
            "structured_result 只放裸 JSON，不放 Markdown 代码块或解释文字。"
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
        *,
        validation_error: str = "",
    ) -> dict[str, Any]:
        allowed_card_types = sorted(self.injection_manager.allowed_output_types(active_skill_keys) | {"error_recovery"})
        allowed_draft_types = sorted(self.injection_manager.allowed_draft_types(active_skill_keys))
        return {
            "currentMessage": context.current_message,
            "quickTask": context.quick_task,
            "subject": context.subject,
            "conversation": context.conversation,
            "artifacts": conversation_artifacts(context),
            "previousResults": [self._result_record(item) for item in context.previous_results],
            "currentRunArtifacts": context.current_run_artifacts,
            "injectedSkills": active_skill_keys,
            "injectionHistory": injection_history,
            "allowedCardTypes": allowed_card_types,
            "allowedDraftTypes": allowed_draft_types,
            **(
                {
                    "previousStructuredResultError": validation_error,
                    "instruction": "上一次 structured_result 不符合契约。请修正后只输出 visible_text 和 structured_result。",
                }
                if validation_error
                else {}
            ),
        }

    def _response_schema(self, active_skill_keys: list[str]) -> dict[str, Any]:
        schema = deepcopy(ORCHESTRATOR_RESULT_SCHEMA)
        allowed_card_types = sorted(self.injection_manager.allowed_output_types(active_skill_keys) | {"error_recovery"})
        schema["properties"]["cards"] = {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string", "minLength": 1},
                    "type": {"type": "string", "enum": allowed_card_types},
                    "title": {"type": "string", "minLength": 1},
                    "data": {"type": "object"},
                },
                "required": ["id", "type", "title", "data"],
            },
        }
        return schema

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

    def _skill_result_from_parsed(
        self,
        parsed: dict[str, Any],
        provider_result: ChatProviderResult,
        context: SkillContext,
        visible_text: str,
        active_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        draft_outputs: list[dict[str, Any]],
        read_outputs: dict[str, list[dict[str, Any]]],
    ) -> SkillResult:
        drafts = self._validated_drafts(draft_outputs, active_skill_keys)
        model_drafts = self._as_list_of_dicts(parsed.get("drafts"))
        if model_drafts and not drafts:
            return SkillResult(
                text="模型返回了草稿但没有调用草稿工具。",
                status="failed",
                model=provider_result.model or model_name(context),
                error="drafts require draft tool call",
            )
        model_cards = self._as_list_of_dicts(parsed.get("cards"))
        cards = self._validated_cards(
            self._cards_from_read_outputs(model_cards, read_outputs),
            active_skill_keys,
        )
        result_text = (visible_text or str(parsed.get("text") or "")).strip()
        state_patch = self._as_dict(parsed.get("state_patch"))
        context_summary = self._as_dict(parsed.get("context_summary"))
        context_summary["orchestrator"] = {
            "injectedSkills": active_skill_keys,
            "injectionHistory": injection_history,
            "readTools": sorted(read_outputs.keys()),
        }
        return SkillResult(
            text=result_text,
            cards=cards,
            drafts=drafts,
            events=self._as_list_of_dicts(parsed.get("events")),
            context_summary=context_summary,
            state_patch=state_patch,
            status=str(parsed.get("status") or "completed"),
            model=provider_result.model or model_name(context),
            error=self._optional_text(parsed.get("error")),
            operation=self._optional_text(parsed.get("operation")),
            source_artifact_id=self._optional_text(parsed.get("source_artifact_id")),
            requires_clarification=bool(parsed.get("requires_clarification")),
            tool_calls=context.tool_executor.records(),
        )

    def _parse_result(self, text: str) -> dict[str, Any] | None:
        structured_text = text
        start = text.find(STRUCTURED_RESULT_OPEN)
        end = text.find(STRUCTURED_RESULT_CLOSE)
        if start >= 0 and end > start:
            structured_text = text[start + len(STRUCTURED_RESULT_OPEN) : end]
        parsed = json_object(structured_text or text)
        return parsed if isinstance(parsed, dict) else None

    def _structured_result_schema_error(self, parsed: dict[str, Any], active_skill_keys: list[str]) -> str:
        try:
            validate_json_value(parsed, self._response_schema(active_skill_keys), location="orchestrator structured_result")
        except Exception as exc:
            return str(exc)[:1000]
        return ""

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
        outputs = read_outputs.get(tool_name, [])
        if not outputs:
            return []
        return self._as_list_of_dicts(outputs[-1].get("items"))

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
