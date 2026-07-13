from ._support import *

from typing import Any

from app.ai.errors import ApprovalRequired, HumanInputRequired, ToolExecutionError
from app.ai.runtime.provider import OpenAIResponsesChatProvider, ProviderImageInput, get_chat_provider
from app.ai.tools import ToolRegistry
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.runner_support.graph_state_builder import GraphStateBuilder
from app.ai.workflows.runner_support.approval_resume import (
    approval_failed_state_patch,
    approval_resolved_state_patch,
    approval_resume_artifact,
    approval_resume_payload_from_metadata,
    approval_waiting_state_patch,
)
from app.ai.workflows.runner_support.message_parts import (
    aggregate_text_from_parts,
    append_progressive_draft_metadata,
    human_input_request_message_part,
    result_card_message_part,
    result_cards_from_parts,
    terminal_message_text,
    text_message_part,
)
from app.ai.workflows.runner_support.run_summary import (
    record_approval_outcome_summary,
    record_continuation_completed,
    record_continuation_rejected,
    record_continuation_started,
    record_draft_validation,
    result_context_summary,
)
from app.ai.runtime.tool_loop import max_rounds_finalization_round
from app.ai.workflows.runner import MAX_AGENT_ROUNDS
from app.ai.workflows.orchestrator.tool_contracts import tool_completion_metadata
from app.ai.workflows.orchestrator.profiles import (
    MAIN_WORKSPACE_ALLOWED_SKILL_KEYS,
    MAIN_WORKSPACE_PROFILE,
    OrchestratorBudgetConfig,
)
from app.ai.workflows.orchestrator import tools as orchestrator_tools
from app.schemas.ai import AIResultCardDTO


def _tool_names(tools) -> list[str]:
    current_tools = tools()
    return sorted(tool.name for tool in current_tools)


def _openai_stream_chunk_from_test_chunk(chunk: Any) -> dict[str, Any]:
    delta: dict[str, Any] = {}
    content = getattr(chunk, "content", None)
    if not content:
        content = getattr(chunk, "final_content", None)
    if isinstance(content, str) and content:
        delta["content"] = content
    raw_tool_calls = list(getattr(chunk, "tool_calls", None) or [])
    raw_tool_call_chunks = list(getattr(chunk, "tool_call_chunks", None) or [])
    if raw_tool_calls:
        delta["tool_calls"] = [
            {
                "id": str(call.get("id") or ""),
                "index": call.get("index") if call.get("index") is not None else index,
                "function": {
                    "name": str(call.get("name") or ""),
                    "arguments": json.dumps(call.get("args") or {}, ensure_ascii=False, default=str),
                },
            }
            for index, call in enumerate(raw_tool_calls)
            if isinstance(call, dict)
        ]
    elif raw_tool_call_chunks:
        delta["tool_calls"] = [
            {
                "id": str(call.get("id") or ""),
                "index": call.get("index") if call.get("index") is not None else index,
                "function": {
                    "name": str(call.get("name") or ""),
                    "arguments": str(call.get("args") or ""),
                },
            }
            for index, call in enumerate(raw_tool_call_chunks)
            if isinstance(call, dict)
        ]
    return {"choices": [{"delta": delta}]}


def _attach_openai_stream(provider: Any, stream_client: Any) -> None:
    class FakeCompletions:
        def create(self, **request):
            chunks = stream_client.stream(request["messages"])
            return [_openai_stream_chunk_from_test_chunk(chunk) for chunk in chunks]

    provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))


def _contract_tool_registries(
    tool_output: dict[str, Any],
    *,
    tool_budget: dict[str, int] | None = None,
    completion_policy: SkillCompletionPolicy | None = None,
    requires_followup: bool = False,
    terminal_output: bool = False,
    followup_hint: str = "",
) -> tuple[Any, Any]:
    tool_registry = build_workspace_tool_registry()

    def handler(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
        del context, payload
        return dict(tool_output)

    tool_registry.register(
        ToolDefinition(
            name="test.contract_read",
            display_name="测试契约读取",
            description="用于测试 Orchestrator terminal output guard 的读取工具。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            output_schema={"type": "object"},
            permission="ai:test",
            side_effect="read",
            handler=handler,
            requires_followup=requires_followup,
            terminal_output=terminal_output,
            followup_hint=followup_hint,
        )
    )
    skill_registry = build_workspace_skill_registry()
    skill_registry.register(
        CatalogSkill(
            SkillManifest(
                key="contract_test",
                name="契约测试",
                description="测试 Orchestrator completion contract。",
                tools=["test.contract_read"],
                tool_budget=tool_budget or {},
                completion_policy=completion_policy or SkillCompletionPolicy(),
            ),
            instructions="调用 test.contract_read 获取测试数据，然后给出最终回复。",
        )
    )
    return tool_registry, skill_registry


def _contract_test_profile_state() -> dict[str, Any]:
    profile_state = MAIN_WORKSPACE_PROFILE.to_state()
    profile_state["capabilityPolicy"] = {
        **profile_state["capabilityPolicy"],
        "allowedSkillKeys": ["contract_test"],
    }
    return profile_state


def _recipe_cook_policy_tool_registry() -> ToolRegistry:
    registry = ToolRegistry()

    def read_handler(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
        del context, payload
        return {"items": []}

    def preview_handler(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
        del context, payload
        return {
            "recipe": {
                "id": "recipe-test",
                "title": "番茄炒蛋",
                "servings": 2,
                "updatedAt": "2026-06-30T00:00:00+00:00",
            },
            "preview": {
                "recipe_id": "recipe-test",
                "preview_items": [],
                "shortages": [],
            },
            "planItem": None,
        }

    def draft_handler(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
        del context, payload
        return {"draft": {"draftType": "recipe_cook", "schemaVersion": "recipe_cook_operation.v1"}}

    def register_fake_tool(
        name: str,
        *,
        side_effect: str,
        handler,
        requires_confirmation: bool = False,
        draft_types: list[str] | None = None,
    ) -> None:
        registry.register(
            ToolDefinition(
                name=name,
                display_name=name,
                description=f"测试工具 {name}",
                input_schema={"type": "object", "properties": {}, "additionalProperties": True},
                output_schema={"type": "object"},
                permission="family:draft" if side_effect == "draft" else "family:read",
                side_effect=side_effect,  # type: ignore[arg-type]
                handler=handler,
                requires_confirmation=requires_confirmation,
                draft_types=draft_types or [],
            )
        )

    register_fake_tool("skill.inject", side_effect="control", handler=read_handler)
    register_fake_tool("human.request_input", side_effect="control", handler=read_handler)
    register_fake_tool("workspace.read_artifact", side_effect="read", handler=read_handler)
    register_fake_tool("family.read_context", side_effect="read", handler=read_handler)
    register_fake_tool("recipe.search", side_effect="read", handler=read_handler)
    register_fake_tool("recipe.read_by_id", side_effect="read", handler=read_handler)
    register_fake_tool("recipe.preview_cook", side_effect="read", handler=preview_handler)
    register_fake_tool(
        "recipe.create_cook_draft",
        side_effect="draft",
        handler=draft_handler,
        requires_confirmation=True,
        draft_types=["recipe_cook"],
    )
    register_fake_tool("inventory.read_available_items", side_effect="read", handler=read_handler)
    register_fake_tool("meal_plan.read_existing", side_effect="read", handler=read_handler)
    return registry


class AIFoundationTestCase(AIAgentInfraTestCase):
        def test_graph_state_builder_keeps_initial_state_contract(self) -> None:
            class FakeProfile:
                def to_state(self) -> dict[str, Any]:
                    return {"key": "main", "toolBudget": {"total": 3}}

            builder = GraphStateBuilder()
            state = builder.build_initial_state(
                family_id="family-1",
                user_id="user-1",
                conversation_id="conversation-1",
                prompt="今晚吃什么？",
                attachments=[{"type": "image", "mediaId": "media-1"}],
                client_message_id="client-message-1",
                client_run_id="client-run-1",
                quick_task="today_recommendation",
                subject={"type": "meal"},
                orchestrator_profile=FakeProfile(),
                initial_skill_keys=["meal_plan"],
                run_id="run-1",
                user_message_id="message-1",
            )

            self.assertEqual(
                state,
                {
                    "family_id": "family-1",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                    "message": "今晚吃什么？",
                    "current_message_attachments": [{"type": "image", "mediaId": "media-1"}],
                    "client_message_id": "client-message-1",
                    "client_run_id": "client-run-1",
                    "quick_task": "today_recommendation",
                    "subject": {"type": "meal"},
                    "orchestrator_profile": {"key": "main", "toolBudget": {"total": 3}},
                    "run_artifacts": [],
                    "injected_skill_keys": ["meal_plan"],
                    "injection_history": [],
                    "generation_contracts": [],
                    "agent_rounds": 0,
                    "pending_human_input": {},
                    "pending_approval_id": "",
                    "last_human_input_result": {},
                    "status": "running",
                    "error": None,
                    "run_id": "run-1",
                    "user_message_id": "message-1",
                },
            )
            self.assertEqual(
                builder.build_human_input_resume_payload(
                    request_id="request-1",
                    selected_option_ids=["option-1"],
                    text=None,
                    user_id="user-1",
                    family_id="family-1",
                ),
                {
                    "requestId": "request-1",
                    "selectedOptionIds": ["option-1"],
                    "text": "",
                    "userId": "user-1",
                    "familyId": "family-1",
                },
            )
            self.assertEqual(
                builder.build_approval_resume_payload(
                    approval_id="approval-1",
                    decision="approved",
                    draft_version=2,
                    values={"title": "番茄炒蛋"},
                    comment=None,
                    user_id="user-1",
                    family_id="family-1",
                ),
                {
                    "approvalId": "approval-1",
                    "decision": "approved",
                    "draftVersion": 2,
                    "values": {"title": "番茄炒蛋"},
                    "comment": None,
                    "userId": "user-1",
                    "familyId": "family-1",
                },
            )

        def test_orchestrator_run_summary_helpers_update_metrics_and_routing(self) -> None:
            result = SkillResult(
                text="需要你确认一下",
                status="completed",
                operation="plan",
                source_artifact_id="artifact-1",
                diagnostic="ok",
                requires_clarification=True,
                tool_calls=[{"name": "meal_plan.read_existing"}, {"name": "human.request_input"}],
                context_summary={
                    "orchestrator": {"injectedSkills": ["meal_plan"]},
                    "pendingHumanInput": {
                        "id": "human-1",
                        "questionType": "meal_scope",
                        "resumeHint": {"questionType": "meal_scope"},
                    },
                },
            )

            context_summary, injected_skill_keys = result_context_summary(
                existing_context_summary={"runMetrics": {"toolCallCount": 1}},
                result=result,
                skill_key=None,
                draft_count=1,
                approval_count=1,
                conversation_context={"taskState": {"lastHumanInputResult": {"summary": "三天"}}},
            )

            self.assertEqual(injected_skill_keys, ["meal_plan"])
            self.assertEqual(context_summary["routing"], {"skills": ["meal_plan"]})
            self.assertEqual(context_summary["runMetrics"]["skillExecutionCount"], 1)
            self.assertEqual(context_summary["runMetrics"]["completedSkillExecutionCount"], 1)
            self.assertEqual(context_summary["runMetrics"]["toolCallCount"], 3)
            self.assertEqual(context_summary["runMetrics"]["draftCount"], 1)
            self.assertEqual(context_summary["runMetrics"]["approvalRequestCount"], 1)
            self.assertEqual(context_summary["runMetrics"]["clarificationCount"], 1)
            self.assertEqual(context_summary["clarificationStats"]["reasons"], {"meal_scope": 1})
            self.assertEqual(context_summary["clarificationStats"]["bySkill"], {"meal_plan": 1})
            self.assertEqual(context_summary["lastHumanInputResult"], {"summary": "三天"})
            self.assertEqual(
                context_summary["skillExecutions"],
                [
                    {
                        "skillKey": "meal_plan",
                        "operation": "plan",
                        "sourceArtifactId": "artifact-1",
                        "status": "completed",
                        "diagnostic": "ok",
                        "requiresClarification": True,
                        "clarificationQuestionTypes": ["meal_scope"],
                        "draftCount": 1,
                    }
                ],
            )

            explicit_summary, explicit_skills = result_context_summary(
                existing_context_summary={},
                result=result,
                skill_key="shopping_list",
                draft_count=0,
                approval_count=0,
                conversation_context=None,
            )
            self.assertEqual(explicit_skills, ["meal_plan"])
            self.assertEqual(explicit_summary["skillExecutions"][0]["skillKey"], "shopping_list")
            self.assertEqual(explicit_summary["clarificationStats"]["bySkill"], {"shopping_list": 1})

        def test_approval_outcome_summary_helper_records_counts_by_draft_type(self) -> None:
            summary = record_approval_outcome_summary(
                {},
                approval_status="approved",
                draft_type="meal_plan",
            )
            summary = record_approval_outcome_summary(
                summary,
                approval_status="rejected",
                draft_type="meal_plan",
            )
            summary = record_approval_outcome_summary(
                summary,
                approval_status="approved",
                draft_type="recipe",
            )

            self.assertEqual(summary["runMetrics"]["approvalApprovedCount"], 2)
            self.assertEqual(summary["runMetrics"]["approvalRejectedCount"], 1)
            self.assertEqual(summary["approvalStats"]["byDraftType"]["meal_plan"], {"approved": 1, "rejected": 1})
            self.assertEqual(summary["approvalStats"]["byDraftType"]["recipe"], {"approved": 1})
            self.assertEqual(summary["approvalStats"]["lastDecision"], {"status": "approved", "draftType": "recipe"})

        def test_quality_counters_record_first_pass_and_continuation_idempotently(self) -> None:
            summary: dict[str, Any] = {}
            record_draft_validation(summary, candidate_key="tool-call-1", succeeded=True, attempt=1)
            record_continuation_started(summary, workflow_id="flow-1")
            record_continuation_started(summary, workflow_id="flow-1")
            record_continuation_completed(summary, workflow_id="flow-1")
            self.assertEqual(
                summary["runMetrics"],
                {
                    "draftValidationCandidateCount": 1,
                    "draftValidationAttemptCount": 1,
                    "draftFirstPassSuccessCount": 1,
                    "continuationStartedCount": 1,
                    "continuationCompletedCount": 1,
                },
            )

        def test_draft_quality_counter_treats_repair_as_same_candidate(self) -> None:
            summary: dict[str, Any] = {}
            record_draft_validation(summary, candidate_key="run-1:recipe.create_draft", succeeded=False, attempt=1)
            record_draft_validation(summary, candidate_key="run-1:recipe.create_draft", succeeded=True, attempt=2)
            self.assertEqual(summary["runMetrics"]["draftValidationCandidateCount"], 1)
            self.assertEqual(summary["runMetrics"]["draftValidationAttemptCount"], 2)
            self.assertEqual(summary["runMetrics"].get("draftFirstPassSuccessCount", 0), 0)

        def test_result_summary_completes_ready_continuation_once_for_receiving_skill_terminal_output(self) -> None:
            artifact = {
                "type": "workflow.continuation",
                "status": "ready",
                "payload": {
                    "workflowId": "flow-ready",
                    "resumeSkillKey": "meal_plan",
                    "status": "ready",
                },
            }
            result = SkillResult(
                text="已生成后续计划。",
                status="completed",
                context_summary={"orchestrator": {"injectedSkills": ["meal_plan"]}},
            )

            summary, _ = result_context_summary(
                existing_context_summary={},
                result=result,
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context={},
                current_run_artifacts=[artifact],
            )
            summary, _ = result_context_summary(
                existing_context_summary=summary,
                result=result,
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context={},
                current_run_artifacts=[artifact],
            )

            self.assertEqual(summary["runMetrics"]["continuationCompletedCount"], 1)
            self.assertEqual(summary["runMetrics"]["continuationStartedCount"], 1)

        def test_result_summary_does_not_complete_continuation_for_wrong_skill_or_missing_output(self) -> None:
            artifact = {
                "type": "workflow.continuation",
                "status": "ready",
                "payload": {
                    "workflowId": "flow-not-complete",
                    "resumeSkillKey": "meal_plan",
                    "status": "ready",
                },
            }
            wrong_skill, _ = result_context_summary(
                existing_context_summary={},
                result=SkillResult(
                    text="处理完成。",
                    status="completed",
                    context_summary={"orchestrator": {"injectedSkills": ["shopping_list"]}},
                ),
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context={},
                current_run_artifacts=[artifact],
            )
            missing_output, _ = result_context_summary(
                existing_context_summary={},
                result=SkillResult(
                    text="",
                    status="completed",
                    context_summary={"orchestrator": {"injectedSkills": ["meal_plan"]}},
                ),
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context={},
                current_run_artifacts=[artifact],
            )

            self.assertEqual(wrong_skill.get("runMetrics", {}).get("continuationCompletedCount", 0), 0)
            self.assertEqual(missing_output.get("runMetrics", {}).get("continuationCompletedCount", 0), 0)

        def test_result_summary_deduplicates_checkpointed_quality_counters(self) -> None:
            result_summary: dict[str, Any] = {}
            record_draft_validation(result_summary, candidate_key="call-checkpoint", succeeded=True, attempt=1)
            result = SkillResult(text="完成。", status="completed", context_summary=result_summary)

            persisted, _ = result_context_summary(
                existing_context_summary={},
                result=result,
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context=None,
            )
            replayed, _ = result_context_summary(
                existing_context_summary=persisted,
                result=result,
                skill_key=None,
                draft_count=0,
                approval_count=0,
                conversation_context=None,
            )

            self.assertEqual(replayed["runMetrics"]["draftValidationCandidateCount"], 1)
            self.assertEqual(replayed["runMetrics"]["draftValidationAttemptCount"], 1)
            self.assertEqual(replayed["runMetrics"]["draftFirstPassSuccessCount"], 1)

        def test_draft_candidate_metrics_use_provider_tool_call_identity(self) -> None:
            class RepairingDraftProvider(BaseChatProvider):
                model_name = "draft-candidate-identity"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(self, *, system, user, tools, tool_handler, **kwargs):
                    del system, user, kwargs
                    tool_handler("skill.inject", {"skills": ["ingredient_profile"], "reason": "评估草稿修复"})
                    tools()
                    try:
                        tool_handler("ingredient_profile.create_draft", {}, None, "call-draft-repair")
                    except ValueError:
                        pass
                    tool_handler(
                        "ingredient_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "ingredient_profile",
                                "schemaVersion": "ingredient_profile.v1",
                                "action": "create",
                                "payload": {
                                    "name": "评估青菜",
                                    "category": "蔬菜",
                                    "default_unit": "棵",
                                    "default_storage": "冷藏",
                                    "default_expiry_mode": "none",
                                },
                            }
                        },
                        None,
                        "call-draft-repair",
                    )
                    raise AssertionError("successful draft call must pause for approval")

            with patch("app.ai.workspace_service.get_chat_provider", return_value=RepairingDraftProvider()):
                response = self.client.post("/api/ai/chat", json={"message": "新增评估青菜"})
            self.assertEqual(response.status_code, 200, response.text)
            run_id = response.json()["run"]["id"]
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, run_id)
                assert run is not None
                metrics = run.context_summary["runMetrics"]
            self.assertEqual(metrics["draftValidationCandidateCount"], 1)
            self.assertEqual(metrics["draftValidationAttemptCount"], 2)
            self.assertEqual(metrics.get("draftFirstPassSuccessCount", 0), 0)

        def test_draft_candidate_metrics_count_new_call_ids_and_deduplicate_replayed_id(self) -> None:
            class ReplayedDraftProvider(BaseChatProvider):
                model_name = "draft-candidate-replay"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(self, *, system, user, tools, tool_handler, **kwargs):
                    del system, user, kwargs
                    tool_handler("skill.inject", {"skills": ["ingredient_profile"], "reason": "评估草稿候选"})
                    tools()
                    for call_id in ("call-draft-a", "call-draft-b", "call-draft-a"):
                        try:
                            tool_handler("ingredient_profile.create_draft", {}, None, call_id)
                        except ValueError:
                            pass
                    return ChatProviderResult(text="草稿输入需要修复。", status="completed", model=self.model_name)

            with patch("app.ai.workspace_service.get_chat_provider", return_value=ReplayedDraftProvider()):
                response = self.client.post("/api/ai/chat", json={"message": "新增食材"})
            self.assertEqual(response.status_code, 200, response.text)
            run_id = response.json()["run"]["id"]
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, run_id)
                assert run is not None
                metrics = run.context_summary["runMetrics"]
            self.assertEqual(metrics["draftValidationCandidateCount"], 2)
            self.assertEqual(metrics["draftValidationAttemptCount"], 3)

        def test_invalid_continuation_attempts_are_counted_per_tool_call_and_replays_are_idempotent(self) -> None:
            class InvalidContinuationProvider(BaseChatProvider):
                model_name = "invalid-continuation-lifecycle"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(self, *, system, user, tools, tool_handler, **kwargs):
                    del system, user, kwargs
                    tool_handler("skill.inject", {"skills": ["food_profile"], "reason": "评估 continuation"})
                    tools()
                    invalid_values = [
                        ("call-continuation-object", []),
                        ("call-continuation-missing-id", {"reasonCode": "plan_after_create"}),
                        (
                            "call-continuation-state",
                            {
                                "workflowId": "flow-invalid-state",
                                "stepKey": "create-food",
                                "reasonCode": "plan_after_create",
                                "nextSkillKey": "meal_plan",
                                "resumeSkillKey": "meal_plan",
                                "requiredDraftType": "meal_plan",
                                "stateSchema": "food_to_meal_plan.v1",
                                "state": {},
                            },
                        ),
                    ]
                    for call_id, continuation in [*invalid_values, invalid_values[0]]:
                        try:
                            tool_handler(
                                "food_profile.create_draft",
                                {
                                    "draft": {
                                        "draftType": "food_profile",
                                        "schemaVersion": "food_profile.v1",
                                        "name": "评估饮品",
                                        "type": "readyMade",
                                        "category": "饮品",
                                    },
                                    "continuation": continuation,
                                },
                                None,
                                call_id,
                            )
                        except ValueError:
                            pass
                    return ChatProviderResult(text="continuation 输入已拒绝。", status="completed", model=self.model_name)

            with patch("app.ai.workspace_service.get_chat_provider", return_value=InvalidContinuationProvider()):
                response = self.client.post("/api/ai/chat", json={"message": "新增饮品后安排晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            run_id = response.json()["run"]["id"]
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, run_id)
                assert run is not None
                metrics = run.context_summary["runMetrics"]
            self.assertEqual(metrics["continuationRejectedCount"], 3)

        def test_orchestrator_message_part_helpers_build_stable_payloads(self) -> None:
            self.assertEqual(
                result_card_message_part(
                    part_id="part-card",
                    card={"id": "card-1", "type": "inventory_summary", "data": {"availableCount": 1}},
                ),
                {
                    "id": "part-card",
                    "type": "result_card",
                    "card": {"id": "card-1", "type": "inventory_summary", "data": {"availableCount": 1}},
                },
            )
            self.assertEqual(
                human_input_request_message_part(
                    part_id="part-human",
                    request={"id": "human-1", "question": "要处理哪个？"},
                ),
                {
                    "id": "part-human",
                    "type": "human_input_request",
                    "request": {"id": "human-1", "question": "要处理哪个？"},
                },
            )
            self.assertEqual(
                text_message_part(part_id="part-text", text="已完成。"),
                {"id": "part-text", "type": "text", "text": "已完成。"},
            )
            self.assertEqual(
                append_progressive_draft_metadata(
                    {
                        "progressiveDraftIds": ["draft-old", ""],
                        "progressiveApprovalIds": ["approval-old"],
                        "intent": "workspace_orchestrator",
                    },
                    draft_id="draft-new",
                    approval_id="approval-new",
                ),
                {
                    "progressiveDraftIds": ["draft-old", "draft-new"],
                    "progressiveApprovalIds": ["approval-old", "approval-new"],
                    "intent": "workspace_orchestrator",
                },
            )
            parts = [
                {"id": "text-1", "type": "text", "text": " 第一段 "},
                {"id": "ignored-empty", "type": "text", "text": " "},
                {"id": "card-part", "type": "result_card", "card": {"id": "card-1", "type": "today_recommendation"}},
                {"id": "text-2", "type": "text", "text": "第二段"},
                {"id": "ignored-card", "type": "result_card", "card": None},
            ]
            self.assertEqual(aggregate_text_from_parts(parts), "第一段\n\n第二段")
            self.assertEqual(result_cards_from_parts(parts), [{"id": "card-1", "type": "today_recommendation"}])
            self.assertEqual(
                terminal_message_text(content="", parts=parts, status="completed"),
                "第一段\n\n第二段",
            )
            self.assertEqual(
                terminal_message_text(content="", parts=[], status="failed"),
                "AI 工作台暂时失败，请重试。",
            )
            self.assertEqual(
                terminal_message_text(content="", parts=[], status="cancelled"),
                "已中止这次处理。",
            )

        def test_approval_resume_helpers_build_stable_state_patches(self) -> None:
            self.assertEqual(
                approval_resume_payload_from_metadata(
                    {
                        "afterApproval": {
                            "continue": True,
                            "instruction": "继续生成购物清单。",
                            "source": {"draftType": "meal_plan"},
                        }
                    }
                ),
                {
                    "instruction": "继续生成购物清单。",
                    "source": {"draftType": "meal_plan"},
                },
            )
            self.assertEqual(
                approval_resume_payload_from_metadata({"afterApproval": {"continue": True}}),
                {"instruction": "根据这次确认结果继续对话；如果当前任务已经完成，给出简短总结。"},
            )
            self.assertEqual(
                approval_resume_payload_from_metadata({}),
                {"instruction": "根据这次确认结果继续对话；如果当前任务已经完成，给出简短总结。"},
            )

            artifact = approval_resume_artifact(
                run_id="run-1",
                approval_id="approval-1",
                fallback_resume_id="resume-fallback",
                resume_payload={"instruction": "继续"},
            )
            self.assertEqual(artifact["id"], "draft_after_approval:run-1:approval-1")
            self.assertEqual(artifact["type"], "draft_after_approval")
            self.assertEqual(artifact["kind"], "task_resume")
            self.assertEqual(artifact["payload"], {"instruction": "继续"})
            self.assertEqual(
                approval_resume_artifact(
                    run_id="run-1",
                    approval_id="",
                    fallback_resume_id="resume-fallback",
                    resume_payload={"instruction": "继续"},
                )["id"],
                "draft_after_approval:run-1:resume-fallback",
            )

            state = {
                "injected_skill_keys": ["meal_plan"],
                "injection_history": [{"skillKey": "meal_plan", "source": "initial"}],
            }
            serialized = {"approval": {"id": "approval-1"}}
            run_artifacts = [{"id": "existing"}]
            approval_artifacts = [{"id": "approval-artifact"}]
            self.assertEqual(
                approval_waiting_state_patch(
                    approval_id="approval-retry",
                    serialized=serialized,
                    run_artifacts=run_artifacts,
                    approval_artifacts=approval_artifacts,
                ),
                {
                    "status": "waiting_approval",
                    "pending_approval_id": "approval-retry",
                    "last_decision": serialized,
                    "run_artifacts": [*run_artifacts, *approval_artifacts],
                },
            )
            self.assertEqual(
                approval_failed_state_patch(
                    serialized=serialized,
                    run_artifacts=run_artifacts,
                    approval_artifacts=approval_artifacts,
                ),
                {
                    "status": "failed",
                    "last_decision": serialized,
                    "error": "草稿写入失败",
                    "run_artifacts": [*run_artifacts, *approval_artifacts],
                },
            )
            resolved = approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status="running",
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                resume_artifact=artifact,
            )
            self.assertEqual(resolved["status"], "running")
            self.assertEqual(resolved["pending_approval_id"], "")
            self.assertEqual(resolved["pending_human_input"], {})
            self.assertEqual(resolved["last_decision"], serialized)
            self.assertEqual(resolved["run_artifacts"], [*run_artifacts, *approval_artifacts, artifact])
            self.assertEqual(resolved["injected_skill_keys"], ["meal_plan"])
            self.assertEqual(resolved["injection_history"], [{"skillKey": "meal_plan", "source": "initial"}])

        def test_tool_completion_metadata_merges_definition_and_output_contracts(self) -> None:
            definition = ToolDefinition(
                name="test.read",
                display_name="测试读取",
                description="测试 completion metadata。",
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                permission="ai:test",
                side_effect="read",
                handler=lambda context, payload: {},
                requires_followup=True,
                terminal_output=False,
                followup_hint="默认需要继续。",
            )

            metadata = tool_completion_metadata(output={}, definition=definition)

            self.assertTrue(metadata.requires_followup)
            self.assertFalse(metadata.terminal_output)
            self.assertEqual(metadata.followup_hint, "默认需要继续。")

            metadata = tool_completion_metadata(
                output={
                    "requiresFollowup": False,
                    "terminalOutput": True,
                    "followupHint": "顶层声明为终态。",
                },
                definition=definition,
            )

            self.assertFalse(metadata.requires_followup)
            self.assertTrue(metadata.terminal_output)
            self.assertEqual(metadata.followup_hint, "顶层声明为终态。")

            metadata = tool_completion_metadata(
                output={
                    "metadata": {
                        "requires_followup": True,
                        "terminal_output": False,
                        "followup_hint": "嵌套声明需要继续。",
                    }
                },
                definition=None,
            )

            self.assertTrue(metadata.requires_followup)
            self.assertFalse(metadata.terminal_output)
            self.assertEqual(metadata.followup_hint, "嵌套声明需要继续。")

        def test_result_card_dto_rejects_removed_clarification_card_type(self) -> None:
            with self.assertRaises(ValueError):
                AIResultCardDTO.model_validate(
                    {
                        "id": "card-old-clarification",
                        "type": "clarification_request",
                        "title": "还需要你确认一下",
                        "data": {
                            "question": "要处理哪个食材？",
                            "questionType": "entity_disambiguation",
                        },
                    }
                )

        def test_disabled_provider_returns_fallback_without_network(self) -> None:
            result = DisabledChatProvider(model_name="test-model").generate(system="s", user="u")
            self.assertIsNone(result.text)
            self.assertEqual(result.status, "fallback")
            self.assertEqual(result.model, "test-model")

        def test_sqlalchemy_checkpointer_roundtrip_writes_thread_isolation_and_delete(self) -> None:
            with self.SessionLocal() as db:
                saver = SQLAlchemyCheckpointSaver(db)
                checkpoint = empty_checkpoint()
                checkpoint["id"] = "checkpoint-1"
                checkpoint["channel_values"] = {"state": {"step": 1}}
                config = {"configurable": {"thread_id": "conversation-1"}}
                saved_config = saver.put(
                    config,
                    checkpoint,
                    {"source": "input", "step": 1, "parents": {}},
                    {},
                )
                saver.put_writes(saved_config, [("custom", {"pending": True})], "task-1", "skill_step")

                stored = saver.get_tuple(config)
                self.assertIsNotNone(stored)
                assert stored is not None
                self.assertEqual(stored.checkpoint["channel_values"]["state"], {"step": 1})
                self.assertEqual(stored.pending_writes, [("task-1", "custom", {"pending": True})])
                self.assertIsNone(saver.get_tuple({"configurable": {"thread_id": "conversation-2"}}))
                self.assertEqual(len(list(saver.list(config))), 1)

                saver.delete_thread("conversation-1")
                self.assertIsNone(saver.get_tuple(config))
                self.assertEqual(db.query(AIGraphCheckpoint).count(), 0)
                self.assertEqual(db.query(AIGraphWrite).count(), 0)

        def test_ai_workspace_disabled_provider_returns_orchestrator_failure_without_business_fallback(self) -> None:
            with patch(
                "app.ai.workspace_service.get_chat_provider",
                return_value=DisabledChatProvider(model_name="disabled-model"),
            ):
                response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["status"], "failed")
            self.assertEqual(data["included"]["drafts"], [])
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.tool_calls, [])
                self.assertEqual(run.error, "provider unavailable")
                self.assertIn("orchestrator", run.context_summary)

        def test_provider_failure_preserves_quality_metrics_recorded_before_failure(self) -> None:
            class FailedAfterInjectionProvider(BaseChatProvider):
                model_name = "failed-after-injection"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(self, *, system, user, tools, tool_handler, **kwargs):
                    del system, user, kwargs
                    tool_handler("skill.inject", {"skills": ["inventory_analysis"], "reason": "测试失败计数"})
                    tools()
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error="provider failed after routing",
                    )

            with patch(
                "app.ai.workspace_service.get_chat_provider",
                return_value=FailedAfterInjectionProvider(),
            ):
                response = self.client.post("/api/ai/chat", json={"message": "查库存后失败"})
            self.assertEqual(response.status_code, 200, response.text)
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, response.json()["run"]["id"])
                assert run is not None
                metrics = run.context_summary["runMetrics"]
            self.assertEqual(metrics["routeSelectionCount"], 1)

        def test_identity_rejection_metrics_require_a_stable_error_code(self) -> None:
            self.assertFalse(
                orchestrator_tools.is_identity_rejection_error(
                    ValueError("食材不存在或不属于当前家庭")
                )
            )
            self.assertTrue(
                orchestrator_tools.is_identity_rejection_error(
                    ToolExecutionError("食材不存在或不属于当前家庭", code="family_scope_violation")
                )
            )

        def test_context_tools_are_family_scoped(self) -> None:
            with self.SessionLocal() as db:
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call("inventory.read_available_items", {"limit": 50})
            output_text = str(output)
            self.assertIn("番茄", output_text)
            self.assertNotIn("其他家庭牛排", output_text)

        def test_openai_compatible_provider_generate_uses_openai_sdk_plain_text_mode(self) -> None:
            class FakeCompletions:
                def __init__(self) -> None:
                    self.request: dict[str, Any] | None = None

                def create(self, **request):
                    self.request = request
                    return SimpleNamespace(
                        choices=[SimpleNamespace(message=SimpleNamespace(content="普通回复"))],
                        usage=None,
                    )

            fake_completions = FakeCompletions()
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            provider.supports_vision = False
            provider.prompt_cache_enabled = True
            provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=fake_completions))

            result = provider.generate(
                system="直接回复",
                user=ProviderUserInput(text="安排晚餐", prefix_messages=["稳定上下文"]),
            )

            self.assertEqual(result.text, "普通回复")
            assert fake_completions.request is not None
            self.assertEqual(fake_completions.request["model"], "compatible-model")
            self.assertNotIn("stream", fake_completions.request)
            self.assertEqual(
                [message["role"] for message in fake_completions.request["messages"]],
                ["system", "user", "user"],
            )
            self.assertTrue(fake_completions.request["prompt_cache_key"].startswith("culina:"))

        def test_openai_compatible_provider_does_not_expose_removed_legacy_helpers(self) -> None:
            removed_helpers = [
                "_generate_with_tools_blocking",
                "_message_tool_calls",
                "_emit_tool_call_previews",
                "_emit_unstreamed_message_text",
                "_message_to_openai",
            ]

            for helper in removed_helpers:
                self.assertFalse(hasattr(OpenAICompatibleChatProvider, helper), helper)

        def test_openai_compatible_provider_propagates_human_input_interrupt(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-human-input",
                        "name": "human_request_input",
                        "args": {
                            "question": "要关联哪一条计划？",
                            "inputMode": "choice",
                        },
                    }
                ]

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.return_value = [ToolCallChunk()]
            tool = build_workspace_tool_registry().get("human.request_input")

            with self.assertRaises(HumanInputRequired):
                provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: (_ for _ in ()).throw(
                    HumanInputRequired({"id": "human_input-test", **payload})
                ),
                )

        def test_openai_compatible_provider_returns_tool_error_to_model(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": {"limit": -1},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("我已根据错误调整处理。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: (_ for _ in ()).throw(ValueError("limit must be positive")),
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我已根据错误调整处理。")
            self.assertEqual(stream_client.stream.call_count, 2)
            second_messages = stream_client.stream.call_args_list[1].args[0]
            tool_message = next(message for message in second_messages if isinstance(message, dict) and message.get("role") == "tool")
            self.assertIn("tool_execution_failed", str(tool_message["content"]))
            self.assertIn("limit must be positive", str(tool_message["content"]))

        def test_provider_tool_loop_finalization_round_requires_prior_tool_call_and_last_round(self) -> None:
            self.assertFalse(
                max_rounds_finalization_round(
                    round_index=1,
                    max_rounds=2,
                    requested_tool_call_count=0,
                )
            )
            self.assertFalse(
                max_rounds_finalization_round(
                    round_index=0,
                    max_rounds=2,
                    requested_tool_call_count=1,
                )
            )
            self.assertTrue(
                max_rounds_finalization_round(
                    round_index=1,
                    max_rounds=2,
                    requested_tool_call_count=1,
                )
            )

        def test_openai_compatible_provider_soft_finalizes_at_max_rounds(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-read",
                        "name": "inventory_read_available_items",
                        "args": {"limit": 5},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            class FakeCompletions:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(request)
                    if len(self.requests) == 1:
                        return [_openai_stream_chunk_from_test_chunk(ToolCallChunk())]
                    return [_openai_stream_chunk_from_test_chunk(TextChunk("我先基于已有结果总结。"))]

            fake_completions = FakeCompletions()
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            provider.supports_vision = False
            provider.prompt_cache_enabled = True
            provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=fake_completions))
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: {"items": []},
                max_rounds=2,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我先基于已有结果总结。")
            self.assertEqual(len(fake_completions.requests), 2)
            self.assertIn("tools", fake_completions.requests[0])
            self.assertNotIn("tools", fake_completions.requests[1])
            final_messages = fake_completions.requests[1]["messages"]
            self.assertIn("工具调用轮次已经达到上限", final_messages[-1]["content"])

        def test_openai_compatible_provider_retries_empty_tool_response_before_completion(self) -> None:
            class EmptyChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [[EmptyChunk()], [TextChunk("重试后有结果。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: self.fail("tool handler should not run"),
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "重试后有结果。")
            self.assertEqual(result.error, None)
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_fails_after_empty_tool_response_retries(self) -> None:
            class EmptyChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.return_value = [EmptyChunk()]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: self.fail("tool handler should not run"),
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.text, None)
            self.assertEqual(result.error, "empty model response")
            self.assertEqual(stream_client.stream.call_count, 4)

        def test_openai_compatible_provider_does_not_duplicate_failed_preview_after_progress_handoff(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_call_chunks = [
                    {
                        "index": 0,
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": "",
                    }
                ]
                tool_calls = [
                    {
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": {"limit": -1},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("我已换一种方式处理。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []
            handler_event_ids: list[str | None] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            def tool_handler(_name: str, _payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                handler_event_ids.append(progress_event_id)
                raise ValueError("limit must be positive")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我已换一种方式处理。")
            self.assertEqual(previews, [("inventory.read_available_items", "0", "running")])
            self.assertEqual(handler_event_ids, ["event-0"])
            second_messages = stream_client.stream.call_args_list[1].args[0]
            tool_message = next(message for message in second_messages if isinstance(message, dict) and message.get("role") == "tool")
            self.assertIn("tool_execution_failed", str(tool_message["content"]))

        def test_openai_compatible_provider_ignores_tool_stop_marker_output(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-read",
                        "name": "inventory_read_available_items",
                        "args": {"limit": 10},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("读取完成。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: {"__tool_loop_stop__": {"status": "waiting_approval"}},
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "读取完成。")
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_propagates_approval_interrupt(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-draft",
                        "name": "recipe_create_draft",
                        "args": {"draft": {"title": "番茄炒蛋"}},
                    }
                ]

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.return_value = [ToolCallChunk()]
            tool = build_workspace_tool_registry().get("recipe.create_draft")

            with self.assertRaises(ApprovalRequired):
                provider.generate_with_tools(
                    system="s",
                    user="u",
                    tools=lambda: [tool],
                    tool_handler=lambda name, payload: (_ for _ in ()).throw(ApprovalRequired("approval required")),
                )

        def test_openai_compatible_provider_retries_stream_failure_before_output(self) -> None:
            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [RuntimeError("incomplete chunked read"), [TextChunk("继续处理完成")]]

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [],
                tool_handler=lambda _name, _payload: {},
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "继续处理完成")
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_previews_tool_name_before_args_complete(self) -> None:
            class StreamChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, chunks: list[dict[str, Any]]) -> None:
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    return StreamChunk([*self.tool_call_chunks, *getattr(other, "tool_call_chunks", [])])

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [
                [
                    StreamChunk([{"index": 0, "id": "call-read-items", "name": "inventory_read_available_items", "args": ""}]),
                    StreamChunk([{"index": 0, "args": "{\"limit\": 50}"}]),
                ],
                [TextChunk("读取完成")],
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []
            handler_event_ids: list[str | None] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            def tool_handler(name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                handler_event_ids.append(progress_event_id)
                self.assertEqual(name, "inventory.read_available_items")
                self.assertEqual(payload, {"limit": 50})
                return {"items": []}

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(previews, [("inventory.read_available_items", "0", "running")])
            self.assertEqual(handler_event_ids, ["event-0"])

        def test_openai_compatible_provider_marks_preview_failed_without_final_tool_call(self) -> None:
            class PreviewChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, chunks: list[dict[str, Any]]) -> None:
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    return FinalTextMessage(getattr(other, "content", ""))

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return FinalTextMessage(f"{self.content}{getattr(other, 'content', '')}")

            class FinalTextMessage:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return FinalTextMessage(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [
                [
                    PreviewChunk(
                        [
                            {
                                "index": 0,
                                "id": "call-read-items",
                                "name": "inventory_read_available_items",
                                "args": "{\"limit\": 50}",
                            }
                        ]
                    )
                ],
                [TextChunk("我会先查看库存。")],
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []
            handled: list[tuple[str, dict[str, Any]]] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: handled.append((name, payload)) or {"items": []},
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我会先查看库存。")
            self.assertEqual(handled, [("inventory.read_available_items", {"limit": 50})])
            self.assertEqual(previews, [("inventory.read_available_items", "0", "running")])

        def test_openai_compatible_provider_flushes_final_text_before_tool_execution(self) -> None:
            class AggregateChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, final_content: str = "", chunks: list[dict[str, Any]] | None = None) -> None:
                    self.final_content = final_content
                    self.tool_call_chunks = chunks or []

                def __add__(self, other):
                    current_content = getattr(self, "content", "") or getattr(self, "final_content", "")
                    next_content = getattr(other, "content", "") or getattr(other, "final_content", "")
                    return AggregateMessage(
                        content=f"{current_content}{next_content}",
                        chunks=[*getattr(self, "tool_call_chunks", []), *getattr(other, "tool_call_chunks", [])],
                    )

            class AggregateMessage:
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, *, content: str, chunks: list[dict[str, Any]]) -> None:
                    self.content = content
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    next_content = getattr(other, "content", "") or getattr(other, "final_content", "")
                    return AggregateMessage(
                        content=f"{self.content}{next_content}",
                        chunks=[*self.tool_call_chunks, *getattr(other, "tool_call_chunks", [])],
                    )

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [
                [
                    AggregateChunk(final_content="我先看一下库存，再继续整理建议。"),
                    AggregateChunk(chunks=[{"index": 0, "id": "call-read-items", "name": "inventory_read_available_items", "args": "{\"limit\": 50}"}]),
                ],
                [TextChunk("整理完成。")],
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            order: list[str] = []

            def message_handler(delta: str) -> None:
                order.append(f"text:{delta}")

            def tool_handler(name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                del progress_event_id
                order.append(f"tool:{name}")
                self.assertEqual(payload, {"limit": 50})
                return {"items": []}

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                message_handler=message_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(
                order,
                [
                    "text:我先看一下库存，再继续整理建议。",
                    "tool:inventory.read_available_items",
                    "text:整理完成。",
                ],
            )
            self.assertEqual(result.text, "我先看一下库存，再继续整理建议。整理完成。")

        def test_openai_compatible_provider_fails_after_stream_retries_when_tool_already_ran(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-read-items",
                        "name": "inventory_read_available_items",
                        "args": {"limit": 50},
                    }
                ]
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [
                [ToolCallChunk()],
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda _name, _payload: {"items": []},
            )

            self.assertEqual(result.status, "failed")
            self.assertIn("incomplete chunked read", result.error or "")
            self.assertEqual(result.tool_calls, [{"id": "call-read-items", "name": "inventory.read_available_items", "args": {"limit": 50}}])
            self.assertEqual(stream_client.stream.call_count, 5)

        def test_openai_compatible_provider_continues_after_card_tool_output_for_summary(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-ui-actions",
                        "name": "ui_propose_actions",
                        "args": {
                            "surface": "recipe_cook_page",
                            "recipeId": "recipe-1",
                            "cookSessionId": "cook-session-1",
                            "sessionRevision": 1,
                            "actions": [{"type": "set_timer", "seconds": 180, "name": "倒计时"}],
                        },
                    }
                ]
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            class TextChunk:
                content = "好了，3 分钟倒计时开始了。"
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk()]]
            tool = build_workspace_tool_registry().get("ui.propose_actions")

            def tool_handler(name: str, payload: dict[str, Any]) -> dict[str, Any]:
                self.assertEqual(name, "ui.propose_actions")
                self.assertEqual(payload["actions"][0]["seconds"], 180)
                return {
                    "card": {
                        "id": "ai-card-ui-actions",
                        "type": "ui_actions",
                        "title": "页面操作建议",
                        "data": {
                            "surface": "recipe_cook_page",
                            "recipeId": "recipe-1",
                            "cookSessionId": "cook-session-1",
                            "sessionRevision": 1,
                            "actions": payload["actions"],
                            "requiresConfirmation": False,
                        },
                    }
                }

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertIsNone(result.error)
            self.assertEqual(result.text, "好了，3 分钟倒计时开始了。")
            self.assertEqual(result.tool_calls, [{"id": "call-ui-actions", "name": "ui.propose_actions", "args": ToolCallChunk.tool_calls[0]["args"]}])
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_places_prefix_messages_before_runtime_user_message(self) -> None:
            class TextChunk:
                content = "收到。"
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            _attach_openai_stream(provider, stream_client)
            stream_client.stream.return_value = [TextChunk()]

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(
                    text="runtime turn",
                    prefix_messages=["stable primer"],
                ),
                tools=lambda: [],
                tool_handler=lambda _name, _payload: {},
            )

            self.assertEqual(result.status, "completed")
            request_messages = stream_client.stream.call_args_list[0].args[0]
            self.assertEqual([message["role"] for message in request_messages[:3]], ["system", "user", "user"])
            self.assertEqual(request_messages[1]["content"], "stable primer")
            self.assertEqual(request_messages[2]["content"], [{"type": "text", "text": "runtime turn"}])

        def test_openai_sdk_request_keeps_images_on_runtime_user_message(self) -> None:
            class FakeCompletions:
                def __init__(self) -> None:
                    self.request: dict[str, Any] | None = None

                def create(self, **request):
                    self.request = request
                    return [{"choices": [{"delta": {"content": "收到。"}}]}]

            fake_completions = FakeCompletions()
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            provider.supports_vision = True
            provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=fake_completions))

            chunks = list(
                provider.stream_generate(
                    system="system prompt",
                    user=ProviderUserInput(
                        text="runtime turn",
                        images=[ProviderImageInput(media_id="media-prefix-test", payload=b"hello", content_type="image/png")],
                        prefix_messages=["stable primer"],
                    ),
                )
            )

            self.assertEqual(chunks, ["收到。"])
            assert fake_completions.request is not None
            request_messages = fake_completions.request["messages"]
            self.assertEqual([message["role"] for message in request_messages], ["system", "user", "user"])
            self.assertEqual(request_messages[1]["content"], "stable primer")
            self.assertEqual(request_messages[2]["content"][0], {"type": "text", "text": "runtime turn"})
            self.assertEqual(request_messages[2]["content"][1]["type"], "image_url")
            self.assertNotIn("image_url", str(request_messages[1]["content"]))

        def test_openai_compatible_provider_enables_prompt_cache_for_custom_api_base(self) -> None:
            settings = SimpleNamespace(
                ai_provider="openai-compatible",
                ai_model="compatible-model",
                ai_api_key="test-key",
                ai_api_base="https://llm.example.test/compatible-mode/v1",
                ai_timeout_seconds=15,
                ai_supports_vision=False,
                ai_prompt_cache_enabled=True,
            )

            with patch("app.ai.runtime.provider.get_settings", return_value=settings):
                provider = get_chat_provider()

            self.assertIsInstance(provider, OpenAICompatibleChatProvider)
            self.assertTrue(provider.prompt_cache_enabled)

        def test_openai_compatible_provider_can_disable_prompt_cache_from_settings(self) -> None:
            settings = SimpleNamespace(
                ai_provider="openai-compatible",
                ai_model="compatible-model",
                ai_api_key="test-key",
                ai_api_base="https://llm.example.test/compatible-mode/v1",
                ai_timeout_seconds=15,
                ai_supports_vision=False,
                ai_prompt_cache_enabled=False,
            )

            with patch("app.ai.runtime.provider.get_settings", return_value=settings):
                provider = get_chat_provider()

            self.assertIsInstance(provider, OpenAICompatibleChatProvider)
            self.assertFalse(provider.prompt_cache_enabled)
            options = provider._chat_completions_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime turn", prefix_messages=["stable primer"]),
                [],
            )
            self.assertEqual(options["providerProtocol"], "chat_completions")
            self.assertNotIn("promptCacheKey", options)

        def test_openai_compatible_prompt_cache_key_excludes_runtime_user_text(self) -> None:
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            provider.prompt_cache_enabled = True
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            model_tools = [provider._tool_definition_to_model_tool(tool)]

            first = provider._chat_completions_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 1", prefix_messages=["stable primer"]),
                model_tools,
            )
            second = provider._chat_completions_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 2", prefix_messages=["stable primer"]),
                model_tools,
            )
            changed_prefix = provider._chat_completions_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 2", prefix_messages=["changed primer"]),
                model_tools,
            )

            self.assertEqual(first["providerProtocol"], "chat_completions")
            self.assertEqual(first["promptCacheKey"], second["promptCacheKey"])
            self.assertEqual(first["requestPrefixHash"], second["requestPrefixHash"])
            self.assertNotEqual(first["promptCacheKey"], changed_prefix["promptCacheKey"])
            self.assertEqual(first["runtimePayloadChars"], len("runtime question 1"))

        def test_openai_sdk_chat_completions_request_includes_prompt_cache_key(self) -> None:
            class FakeCompletions:
                def __init__(self) -> None:
                    self.request: dict[str, Any] | None = None

                def create(self, **request):
                    self.request = request
                    return [{"choices": [{"delta": {"content": "收到。"}}]}]

            fake_completions = FakeCompletions()
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            provider.supports_vision = False
            provider.prompt_cache_enabled = True
            provider.openai_client = SimpleNamespace(chat=SimpleNamespace(completions=fake_completions))

            chunks = list(
                provider.stream_generate(
                    system="system prompt",
                    user=ProviderUserInput(text="runtime turn", prefix_messages=["stable primer"]),
                )
            )

            self.assertEqual(chunks, ["收到。"])
            assert fake_completions.request is not None
            self.assertTrue(fake_completions.request["prompt_cache_key"].startswith("culina:"))
            self.assertEqual(fake_completions.request["prompt_cache_retention"], "24h")

        def test_openai_responses_provider_factory_uses_responses_protocol(self) -> None:
            for provider_name in ("openai-response", "openai-responses", "responses"):
                settings = SimpleNamespace(
                    ai_provider=provider_name,
                    ai_model="gpt-5-mini",
                    ai_api_key="test-key",
                    ai_api_base="https://api.openai.com/v1",
                    ai_timeout_seconds=15,
                    ai_supports_vision=True,
                )

                with patch("app.ai.runtime.provider.get_settings", return_value=settings):
                    provider = get_chat_provider()

                self.assertIsInstance(provider, OpenAIResponsesChatProvider)
                self.assertEqual(provider.model_name, "gpt-5-mini")

        def test_openai_responses_provider_streams_runtime_after_prefix_and_keeps_images_runtime_only(self) -> None:
            class FakeResponses:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(request)
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="收"),
                            SimpleNamespace(type="response.output_text.delta", delta="到。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            fake_responses = FakeResponses()
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = True
            provider.client = SimpleNamespace(responses=fake_responses)
            deltas: list[str] = []
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(
                    text="runtime turn",
                    images=[ProviderImageInput(media_id="media-responses-test", payload=b"hello", content_type="image/png")],
                    prefix_messages=["stable primer"],
                ),
                tools=lambda: [tool],
                tool_handler=lambda _name, _payload: {},
                message_handler=deltas.append,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "收到。")
            self.assertEqual(deltas, ["收", "到。"])
            request = fake_responses.requests[0]
            self.assertNotIn("instructions", request)
            self.assertEqual(request["store"], False)
            self.assertEqual(request["prompt_cache_retention"], "24h")
            self.assertTrue(request["prompt_cache_key"].startswith("culina:"))
            self.assertEqual([item["role"] for item in request["input"][:3]], ["system", "user", "user"])
            self.assertEqual(request["input"][0]["content"], [{"type": "input_text", "text": "system prompt"}])
            self.assertEqual(request["input"][1]["content"], [{"type": "input_text", "text": "stable primer"}])
            self.assertEqual(request["input"][2]["content"][0], {"type": "input_text", "text": "runtime turn"})
            self.assertEqual(request["input"][2]["content"][1]["type"], "input_image")
            self.assertNotIn("input_image", str(request["input"][1]["content"]))
            self.assertEqual(request["tools"][0]["type"], "function")
            self.assertEqual(request["tools"][0]["name"], "inventory_read_available_items")
            self.assertFalse(request["tools"][0]["strict"])

        def test_openai_responses_prompt_cache_key_excludes_runtime_user_text(self) -> None:
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            model_tools = [provider._tool_definition_to_model_tool(tool)]

            first = provider._responses_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 1", prefix_messages=["stable primer"]),
                model_tools,
            )
            second = provider._responses_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 2", prefix_messages=["stable primer"]),
                model_tools,
            )
            changed_prefix = provider._responses_cache_request_options(
                "system prompt",
                ProviderUserInput(text="runtime question 2", prefix_messages=["changed primer"]),
                model_tools,
            )

            self.assertEqual(first["promptCacheKey"], second["promptCacheKey"])
            self.assertEqual(first["requestPrefixHash"], second["requestPrefixHash"])
            self.assertNotEqual(first["promptCacheKey"], changed_prefix["promptCacheKey"])
            self.assertEqual(first["runtimePayloadChars"], len("runtime question 1"))

        def test_openai_responses_provider_appends_function_call_output_for_next_round(self) -> None:
            function_call = {
                "type": "function_call",
                "call_id": "call-read-items",
                "name": "inventory_read_available_items",
                "arguments": "{\"limit\": 5}",
                "status": "completed",
            }

            class FakeResponses:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(request)
                    if len(self.requests) == 1:
                        return iter(
                            [
                                SimpleNamespace(type="response.output_item.done", item=function_call),
                                SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[function_call], usage=None)),
                            ]
                        )
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="库存读取完成。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            fake_responses = FakeResponses()
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            provider.client = SimpleNamespace(responses=fake_responses)
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            handled: list[tuple[str, dict[str, Any]]] = []

            def tool_handler(name: str, payload: dict[str, Any]) -> dict[str, Any]:
                handled.append((name, payload))
                return {"items": []}

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(text="runtime turn", prefix_messages=["stable primer"]),
                tools=lambda: [tool],
                tool_handler=tool_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "库存读取完成。")
            self.assertEqual(handled, [("inventory.read_available_items", {"limit": 5})])
            self.assertEqual(len(fake_responses.requests), 2)
            second_input = fake_responses.requests[1]["input"]
            self.assertIn(function_call, second_input)
            output_item = next(item for item in second_input if item.get("type") == "function_call_output")
            self.assertEqual(output_item["call_id"], "call-read-items")
            self.assertIn("\"items\": []", output_item["output"])

        def test_openai_responses_provider_soft_finalizes_at_max_rounds(self) -> None:
            function_call = {
                "type": "function_call",
                "call_id": "call-read-items",
                "name": "inventory_read_available_items",
                "arguments": "{\"limit\": 5}",
                "status": "completed",
            }

            class FakeResponses:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(request)
                    if len(self.requests) == 1:
                        return iter(
                            [
                                SimpleNamespace(type="response.output_item.done", item=function_call),
                                SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[function_call], usage=None)),
                            ]
                        )
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="我先基于已有结果总结。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            fake_responses = FakeResponses()
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            provider.client = SimpleNamespace(responses=fake_responses)
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(text="runtime turn"),
                tools=lambda: [tool],
                tool_handler=lambda name, payload: {"items": []},
                max_rounds=2,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我先基于已有结果总结。")
            self.assertEqual(len(fake_responses.requests), 2)
            self.assertIn("tools", fake_responses.requests[0])
            self.assertNotIn("tools", fake_responses.requests[1])
            self.assertIn("工具调用轮次已经达到上限", str(fake_responses.requests[1]["input"]))

        def test_openai_responses_provider_preserves_same_name_tool_calls_without_ids(self) -> None:
            first_call = {
                "type": "function_call",
                "name": "inventory_read_available_items",
                "arguments": "{\"limit\": 1}",
                "status": "completed",
            }
            second_call = {
                "type": "function_call",
                "name": "inventory_read_available_items",
                "arguments": "{\"limit\": 2}",
                "status": "completed",
            }

            class FakeResponses:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(request)
                    if len(self.requests) == 1:
                        return iter(
                            [
                                SimpleNamespace(type="response.output_item.done", item=first_call),
                                SimpleNamespace(type="response.output_item.done", item=second_call),
                                SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                            ]
                        )
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="两次读取完成。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            fake_responses = FakeResponses()
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            provider.client = SimpleNamespace(responses=fake_responses)
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            handled: list[tuple[str, dict[str, Any]]] = []

            def tool_handler(name: str, payload: dict[str, Any]) -> dict[str, Any]:
                handled.append((name, payload))
                return {"limit": payload["limit"]}

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(text="runtime turn"),
                tools=lambda: [tool],
                tool_handler=tool_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "两次读取完成。")
            self.assertEqual(
                handled,
                [
                    ("inventory.read_available_items", {"limit": 1}),
                    ("inventory.read_available_items", {"limit": 2}),
                ],
            )
            second_input = fake_responses.requests[1]["input"]
            outputs = [item for item in second_input if item.get("type") == "function_call_output"]
            self.assertEqual([item["call_id"] for item in outputs], ["call_1", "call_2"])

        def test_openai_responses_provider_retries_without_unsupported_cache_and_stream_options(self) -> None:
            class FakeResponses:
                def __init__(self) -> None:
                    self.requests: list[dict[str, Any]] = []

                def create(self, **request):
                    self.requests.append(dict(request))
                    if len(self.requests) == 1:
                        raise TypeError("unexpected keyword argument 'prompt_cache_key'")
                    if len(self.requests) == 2:
                        raise TypeError("unexpected keyword argument 'stream_options'")
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="已降级。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            fake_responses = FakeResponses()
            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            provider.client = SimpleNamespace(responses=fake_responses)

            result = provider.generate_with_tools(
                system="system prompt",
                user=ProviderUserInput(text="runtime turn", prefix_messages=["stable primer"]),
                tools=lambda: [],
                tool_handler=lambda _name, _payload: {},
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "已降级。")
            self.assertIn("prompt_cache_key", fake_responses.requests[0])
            self.assertNotIn("prompt_cache_key", fake_responses.requests[1])
            self.assertIn("stream_options", fake_responses.requests[1])
            self.assertNotIn("stream_options", fake_responses.requests[2])

        def test_openai_responses_generate_preserves_trace_request_options(self) -> None:
            class FakeResponses:
                def create(self, **request):
                    del request
                    return iter(
                        [
                            SimpleNamespace(type="response.output_text.delta", delta="直接回复。"),
                            SimpleNamespace(type="response.completed", response=SimpleNamespace(output=[], usage=None)),
                        ]
                    )

            class FakeExchange:
                def finish(self, **_kwargs) -> None:
                    return None

                def fail(self, **_kwargs) -> None:
                    return None

            class FakeRecorder:
                def __init__(self) -> None:
                    self.request_options: dict[str, Any] | None = None

                def start_exchange(self, **kwargs):
                    self.request_options = kwargs["request_options"]
                    return FakeExchange()

                def stream_chunks_payload(self, chunks: list[str]) -> list[dict[str, Any]]:
                    return [{"text": chunk} for chunk in chunks]

                def extract_token_usage(self, _message) -> dict[str, Any] | None:
                    return None

            provider = OpenAIResponsesChatProvider.__new__(OpenAIResponsesChatProvider)
            provider.model_name = "gpt-5-mini"
            provider.supports_vision = False
            provider.client = SimpleNamespace(responses=FakeResponses())
            recorder = FakeRecorder()

            result = provider.generate(
                system="system prompt",
                user="runtime turn",
                trace_recorder=recorder,
                trace_request_options={
                    "fallbackFromMode": "stream_generate",
                    "fallbackOfExchangeId": "exchange-1",
                },
            )

            self.assertEqual(result.status, "completed")
            assert recorder.request_options is not None
            self.assertEqual(recorder.request_options["fallbackFromMode"], "stream_generate")
            self.assertEqual(recorder.request_options["fallbackOfExchangeId"], "exchange-1")

        def test_orchestrator_injects_multiple_skills_and_exposes_union_tools(self) -> None:
            class InjectingProvider(BaseChatProvider):
                model_name = "orchestrator-test-model"

                def __init__(self) -> None:
                    self.tool_names_by_call: list[list[str]] = []
                    self.skill_inject_enums_by_call: list[list[str]] = []
                    self.skill_inject_max_items_by_call: list[int] = []
                    self.systems: list[str] = []
                    self.inject_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del user, max_rounds
                    self.systems.append(system)
                    initial_tools = tools()
                    self.tool_names_by_call.append(sorted(tool.name for tool in initial_tools))
                    skill_inject_tool = next(tool for tool in initial_tools if tool.name == "skill.inject")
                    self.skill_inject_enums_by_call.append(
                        skill_inject_tool.input_schema["properties"]["skills"]["items"]["enum"]
                    )
                    self.skill_inject_max_items_by_call.append(
                        skill_inject_tool.input_schema["properties"]["skills"]["maxItems"]
                    )
                    self.inject_result = tool_handler("skill.inject", {"skills": ["meal_plan", "shopping_list"], "reason": "需要同时安排餐食和购物清单"})
                    next_tools = tools()
                    self.tool_names_by_call.append(sorted(tool.name for tool in next_tools))
                    skill_inject_tool = next(tool for tool in next_tools if tool.name == "skill.inject")
                    self.skill_inject_enums_by_call.append(
                        skill_inject_tool.input_schema["properties"]["skills"]["items"]["enum"]
                    )
                    self.skill_inject_max_items_by_call.append(
                        skill_inject_tool.input_schema["properties"]["skills"]["maxItems"]
                    )
                    text = "已准备好餐食计划和购物清单能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = InjectingProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator",
                run_id="run-orchestrator",
                conversation=[{"id": "message-1", "role": "user", "content": "安排三天晚餐并生成购物清单", "artifacts": []}],
                current_message="安排三天晚餐并生成购物清单",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator",
                        run_id="run-orchestrator",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_names_by_call[0], ["human.request_input", "skill.inject"])
            self.assertEqual(provider.skill_inject_enums_by_call[0], sorted(MAIN_WORKSPACE_ALLOWED_SKILL_KEYS))
            self.assertIn("inventory_analysis", provider.skill_inject_enums_by_call[0])
            self.assertNotIn("cooking_assistant", provider.skill_inject_enums_by_call[0])
            self.assertNotIn("inventory-analysis", provider.skill_inject_enums_by_call[0])
            self.assertEqual(provider.skill_inject_max_items_by_call, [4, 2])
            self.assertIn("meal_plan.create_draft", provider.tool_names_by_call[1])
            self.assertIn("shopping.create_draft", provider.tool_names_by_call[1])
            self.assertIn("script.validate_meal_plan", provider.tool_names_by_call[1])
            self.assertNotIn("script.suggest_items_from_sources", provider.tool_names_by_call[1])
            self.assertEqual(result.context_summary["orchestrator"]["profileKey"], "main_workspace")
            self.assertEqual(result.context_summary["orchestrator"]["responseStyle"], "markdown_friendly")
            self.assertEqual(
                result.context_summary["orchestrator"]["capabilityPolicy"]["skillInjection"],
                "dynamic",
            )
            self.assertEqual(
                result.context_summary["orchestrator"]["capabilityPolicy"]["artifactContext"],
                "all",
            )
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["meal_plan", "shopping_list"])
            injected_instructions = "\n".join(
                str(item.get("instructions") or "")
                for item in provider.inject_result.get("injectedSkills", [])
                if isinstance(item, dict)
            )
            self.assertIn("餐食", injected_instructions)
            self.assertIn("购物", injected_instructions)

        def test_orchestrator_returns_structured_error_for_unknown_skill_injection(self) -> None:
            class UnknownSkillProvider(BaseChatProvider):
                model_name = "orchestrator-unknown-skill-model"

                def __init__(self) -> None:
                    self.inject_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.inject_result = tool_handler("skill.inject", {"skills": ["inventory-analysis"], "reason": "错误使用 slug"})
                    text = "我会改用正确的技能 key。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = UnknownSkillProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator-unknown-skill",
                run_id="run-orchestrator-unknown-skill",
                conversation=[{"id": "message-1", "role": "user", "content": "看一下库存", "artifacts": []}],
                current_message="看一下库存",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator-unknown-skill",
                        run_id="run-orchestrator-unknown-skill",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.inject_result["code"], "unknown_skill")
            self.assertEqual(provider.inject_result["unknownSkills"], ["inventory-analysis"])
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], [])

        def test_orchestrator_returns_structured_error_for_malformed_skill_injection_payload(self) -> None:
            class MalformedSkillPayloadProvider(BaseChatProvider):
                model_name = "orchestrator-malformed-skill-payload-model"

                def __init__(self) -> None:
                    self.inject_results: list[dict[str, Any]] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.inject_results.append(tool_handler("skill.inject", {"skills": "meal_plan"}))
                    self.inject_results.append(tool_handler("skill.inject", {"skills": []}))
                    self.inject_results.append(tool_handler("skill.inject", {"skills": ["meal_plan", 123]}))
                    self.inject_results.append(tool_handler("skill.inject", {"skills": ["   "]}))
                    text = "我会重新按正确格式调用技能。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = MalformedSkillPayloadProvider()

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-malformed-skill-payload",
                    run_id="run-malformed-skill-payload",
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
                    current_message="安排晚餐",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-malformed-skill-payload",
                            run_id="run-malformed-skill-payload",
                        ),
                    ),
                )
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(
                [item["code"] for item in provider.inject_results],
                ["invalid_skill_inject_payload"] * 4,
            )
            self.assertTrue(all(item["injectedSkills"] == [] for item in provider.inject_results))
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], [])

        def test_orchestrator_uses_profile_skill_budget_for_dynamic_injection(self) -> None:
            class SkillBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-skill-budget-model"

                def __init__(self) -> None:
                    self.inject_result: dict[str, Any] = {}
                    self.tool_names: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    self.tool_names = _tool_names(tools)
                    self.inject_result = tool_handler("skill.inject", {"skills": ["shopping_list"], "reason": "尝试超过预算继续注入"})
                    text = "当前能力预算已经用完。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            profile_state = MAIN_WORKSPACE_PROFILE.to_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_business_skills_per_run=1).to_state()
            provider = SkillBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-skill-budget",
                    run_id="run-skill-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐后生成购物清单", "artifacts": []}],
                    current_message="安排晚餐后生成购物清单",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-skill-budget",
                            run_id="run-skill-budget",
                        ),
                    ),
                ),
                injected_skill_keys=["meal_plan"],
            )

            self.assertEqual(result.status, "completed")
            self.assertNotIn("skill.inject", provider.tool_names)
            self.assertIn("human.request_input", provider.tool_names)
            self.assertEqual(provider.inject_result["code"], "skill_budget_exhausted")
            self.assertEqual(provider.inject_result["alreadyInjected"], [])
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxBusinessSkillsPerRun"], 1)
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["meal_plan"])

        def test_skill_inject_result_hides_skill_inject_when_budget_is_filled(self) -> None:
            class FilledBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-filled-skill-budget-model"

                def __init__(self) -> None:
                    self.inject_result: dict[str, Any] = {}
                    self.tool_names_by_call: list[list[str]] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    self.tool_names_by_call.append(_tool_names(tools))
                    self.inject_result = tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "安排晚餐"})
                    self.tool_names_by_call.append(_tool_names(tools))
                    text = "已准备好餐食安排能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            profile_state = MAIN_WORKSPACE_PROFILE.to_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_business_skills_per_run=1).to_state()
            provider = FilledBudgetProvider()

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-filled-skill-budget",
                    run_id="run-filled-skill-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
                    current_message="安排晚餐",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-filled-skill-budget",
                            run_id="run-filled-skill-budget",
                        ),
                    ),
                )
            )

            self.assertEqual(result.status, "completed")
            self.assertIn("skill.inject", provider.tool_names_by_call[0])
            self.assertNotIn("skill.inject", provider.inject_result["availableTools"])
            self.assertNotIn("skill.inject", provider.tool_names_by_call[1])
            self.assertIn("meal_plan.create_draft", provider.inject_result["availableTools"])

        def test_orchestrator_uses_profile_total_tool_budget(self) -> None:
            class TotalToolBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-total-tool-budget-model"

                def __init__(self) -> None:
                    self.tool_result: dict[str, Any] = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.tool_result = tool_handler("test.contract_read", {})
                    text = "工具预算不足，先停在这里。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries({"items": [{"name": "番茄"}]})
            profile_state = _contract_test_profile_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_total_tool_calls_per_run=0).to_state()
            provider = TotalToolBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-total-tool-budget",
                    run_id="run-total-tool-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取测试数据", "artifacts": []}],
                    current_message="读取测试数据",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-total-tool-budget",
                            run_id="run-total-tool-budget",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_result["code"], "tool_budget_exhausted")
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxTotalToolCallsPerRun"], 0)
            self.assertEqual(result.tool_calls, [])

        def test_orchestrator_applies_initial_skill_tool_budget(self) -> None:
            class SkillToolBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-skill-tool-budget-model"

                def __init__(self) -> None:
                    self.tool_result: dict[str, Any] = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.tool_result = tool_handler("test.contract_read", {})
                    text = "Skill 工具预算不足。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                tool_budget={"max_tool_calls": 0},
            )
            provider = SkillToolBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-initial-skill-tool-budget",
                    run_id="run-initial-skill-tool-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取测试数据", "artifacts": []}],
                    current_message="读取测试数据",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-initial-skill-tool-budget",
                            run_id="run-initial-skill-tool-budget",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_result["code"], "tool_budget_exhausted")
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxTotalToolCallsPerRun"], 0)
            self.assertEqual(result.tool_calls, [])

        def test_orchestrator_adds_multi_skill_tool_budgets_under_global_cap(self) -> None:
            manager = SkillInjectionManager(build_workspace_skill_registry())

            budget = manager.budget_config_for(
                ["meal_plan", "shopping_list", "recipe_draft", "inventory_analysis"],
                OrchestratorBudgetConfig(),
                MAIN_WORKSPACE_PROFILE.capability_policy,
            )

            self.assertEqual(budget.max_total_tool_calls_per_run, 48)
            self.assertEqual(budget.max_same_read_tool_calls_per_run, 2)

        def test_orchestrator_recomputes_dynamic_multi_skill_budget_from_global_cap(self) -> None:
            class DynamicMultiSkillBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-dynamic-multi-skill-budget-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "安排晚餐"})
                    tool_handler("skill.inject", {"skills": ["shopping_list"], "reason": "生成购物清单"})
                    text = "已准备餐食安排和购物清单能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            profile_state = MAIN_WORKSPACE_PROFILE.to_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_total_tool_calls_per_run=48).to_state()
            provider = DynamicMultiSkillBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-dynamic-multi-skill-budget",
                    run_id="run-dynamic-multi-skill-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐后生成购物清单", "artifacts": []}],
                    current_message="安排晚餐后生成购物清单",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-dynamic-multi-skill-budget",
                            run_id="run-dynamic-multi-skill-budget",
                        ),
                    ),
                )
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["meal_plan", "shopping_list"])
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxTotalToolCallsPerRun"], 48)

        def test_orchestrator_hard_stops_when_model_keeps_calling_after_tool_budget_exhausted(self) -> None:
            class ToolBudgetHardStopProvider(BaseChatProvider):
                model_name = "orchestrator-tool-budget-hard-stop-model"

                def __init__(self) -> None:
                    self.first_result: dict[str, Any] = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    self.first_result = tool_handler("test.contract_read", {})
                    tool_handler("test.contract_read", {})
                    raise AssertionError("second budget-exhausted tool call should hard stop")

            tool_registry, skill_registry = _contract_tool_registries({"items": [{"name": "番茄"}]})
            profile_state = _contract_test_profile_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_total_tool_calls_per_run=0).to_state()
            provider = ToolBudgetHardStopProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-tool-budget-hard-stop",
                    run_id="run-tool-budget-hard-stop",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取测试数据", "artifacts": []}],
                    current_message="读取测试数据",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-tool-budget-hard-stop",
                            run_id="run-tool-budget-hard-stop",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(provider.first_result["code"], "tool_budget_exhausted")
            self.assertEqual(provider.first_result["status"], "summarize_current_run")
            self.assertIn("基于已有结果", provider.first_result["messageForAssistant"])
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "tool_budget_hard_stop")
            self.assertIn("工具调用预算已经用完", result.text)
            self.assertEqual(result.context_summary["orchestrator"]["budgetUsage"]["exhaustedToolCallAttempts"], 2)
            self.assertTrue(result.context_summary["orchestrator"]["budgetUsage"]["hardStopped"])
            self.assertEqual(result.tool_calls, [])

        def test_orchestrator_applies_dynamic_skill_same_read_budget_after_injection(self) -> None:
            class DynamicSkillToolBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-dynamic-skill-tool-budget-model"

                def __init__(self) -> None:
                    self.first_result: dict[str, Any] = {}
                    self.second_result: dict[str, Any] = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["contract_test"], "reason": "需要读取测试数据"})
                    tools()
                    self.first_result = tool_handler("test.contract_read", {})
                    self.second_result = tool_handler("test.contract_read", {})
                    text = "动态 Skill 的重复读取预算已经生效。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                tool_budget={"max_same_read_calls": 1},
            )
            provider = DynamicSkillToolBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-dynamic-skill-tool-budget",
                    run_id="run-dynamic-skill-tool-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "重复读取测试数据", "artifacts": []}],
                    current_message="重复读取测试数据",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-dynamic-skill-tool-budget",
                            run_id="run-dynamic-skill-tool-budget",
                        ),
                    ),
                ),
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.first_result["items"], [{"name": "番茄"}])
            self.assertEqual(provider.second_result["code"], "tool_loop_detected")
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxSameReadToolCallsPerRun"], 1)
            self.assertEqual(len(result.tool_calls), 1)

        def test_orchestrator_uses_profile_same_read_budget(self) -> None:
            class SameReadBudgetProvider(BaseChatProvider):
                model_name = "orchestrator-same-read-budget-model"

                def __init__(self) -> None:
                    self.first_result: dict[str, Any] = {}
                    self.second_result: dict[str, Any] = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.first_result = tool_handler("test.contract_read", {})
                    self.second_result = tool_handler("test.contract_read", {})
                    text = "重复读取已经被预算拦住。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries({"items": [{"name": "番茄"}]})
            profile_state = _contract_test_profile_state()
            profile_state["budgetConfig"] = OrchestratorBudgetConfig(max_same_read_tool_calls_per_run=1).to_state()
            provider = SameReadBudgetProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-same-read-budget",
                    run_id="run-same-read-budget",
                    conversation=[{"id": "message-1", "role": "user", "content": "重复读取测试数据", "artifacts": []}],
                    current_message="重复读取测试数据",
                    orchestrator_profile=profile_state,
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-same-read-budget",
                            run_id="run-same-read-budget",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.first_result["items"], [{"name": "番茄"}])
            self.assertEqual(provider.second_result["code"], "tool_loop_detected")
            self.assertEqual(result.context_summary["orchestrator"]["budget"]["maxSameReadToolCallsPerRun"], 1)
            self.assertEqual(len(result.tool_calls), 1)

        def test_orchestrator_tool_preview_skips_skill_inject_and_does_not_reuse_next_call_id(self) -> None:
            outer = self

            class PreviewProvider(BaseChatProvider):
                model_name = "orchestrator-preview-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    tool_preview_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds, message_handler
                    assert tool_preview_handler is not None
                    outer.assertIsNone(tool_preview_handler("skill.inject", "0", "running"))
                    tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要整理菜谱"})
                    _tool_names(tools)
                    first_id = tool_preview_handler("recipe.create_draft", "0", "running")
                    second_id = tool_preview_handler("recipe.create_draft", "0", "running")
                    outer.assertIsNotNone(first_id)
                    outer.assertIsNotNone(second_id)
                    outer.assertNotEqual(first_id, second_id)
                    return ChatProviderResult(text="继续整理。", status="completed", model=self.model_name)

            progress_events: list[dict[str, Any]] = []
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator-preview",
                run_id="run-orchestrator-preview",
                conversation=[{"id": "message-1", "role": "user", "content": "整理菜谱", "artifacts": []}],
                current_message="整理菜谱",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator-preview",
                        run_id="run-orchestrator-preview",
                    ),
                ),
                stream_writer=lambda update: progress_events.append(update["data"]) if update.get("event") == "progress" else None,
            )

            result = WorkspaceOrchestratorAgent(
                provider=PreviewProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertNotIn("skill.inject", [event["internal_code"] for event in progress_events])
            recipe_events = [event for event in progress_events if event["internal_code"] == "recipe.create_draft"]
            self.assertEqual(len(recipe_events), 2)
            self.assertEqual(len({event["id"] for event in recipe_events}), 2)

        def test_skill_injection_manager_keeps_repeated_injection_as_noop(self) -> None:
            manager = SkillInjectionManager(build_workspace_skill_registry())

            keys, added = manager.inject([], ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual([bundle.key for bundle in added], ["meal_plan", "shopping_list"])

            keys, added = manager.inject(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(added, [])

        def test_skill_injection_manager_resolves_draft_type_from_tool_scope(self) -> None:
            manager = SkillInjectionManager(build_workspace_skill_registry())

            self.assertEqual(
                manager.draft_type_from_tool_output("recipe.create_draft", {}, ["recipe_draft"]),
                "recipe",
            )
            self.assertEqual(
                manager.draft_type_from_tool_output(
                    "recipe.create_draft",
                    {"draftType": "recipe"},
                    ["recipe_draft"],
                ),
                "recipe",
            )

        def test_orchestrator_catalog_prompt_uses_skill_keys_not_slugs(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-prompt",
                run_id="run-prompt",
                conversation=[],
                current_message="",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-prompt",
                        run_id="run-prompt",
                    ),
                ),
            )

            prompt = agent.prompt_payload_builder.system_prompt(context, [])

            self.assertIn("skill.yaml:key", prompt)
            self.assertIn("必须写 inventory_analysis", prompt)
            self.assertIn('"key": "inventory_analysis"', prompt)
            self.assertIn('"displayName": "库存查看与处理"', prompt)
            self.assertNotIn('"slug"', prompt)
            self.assertNotIn('"name": "inventory-analysis"', prompt)

        def test_orchestrator_prompt_prefers_lightweight_markdown_text(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-markdown-prompt",
                run_id="run-markdown-prompt",
                conversation=[],
                current_message="",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-markdown-prompt",
                        run_id="run-markdown-prompt",
                    ),
                ),
            )

            prompt = agent.prompt_payload_builder.system_prompt(context, [])

            self.assertIn("适合 Markdown 渲染的轻量结构", prompt)
            self.assertIn("短段落、空行、- 列表、编号步骤和 **关键词**", prompt)
            self.assertIn("简单确认、简短追问或一句话回答时，可以只用自然短句", prompt)
            self.assertIn("不要硬凑 Markdown", prompt)

        def test_orchestrator_provider_payload_compacts_historical_drafts_and_approvals(self) -> None:
            recipe_payload = {
                "draftType": "recipe",
                "schemaVersion": "recipe.v1",
                "title": "番茄鸡蛋面",
                "servings": 2,
                "prep_minutes": 20,
                "difficulty": "easy",
                "ingredient_items": [
                    {
                        "ingredient_id": "ingredient-tomato",
                        "ingredient_name": "番茄",
                        "quantity": 2,
                        "unit": "个",
                        "note": "SECRET_INGREDIENT_NOTE",
                    }
                ],
                "steps": [
                    {
                        "title": "炒汤底",
                        "text": "SECRET_STEP_TEXT",
                        "summary": "炒出汤底",
                    }
                ],
            }
            approval_artifact = {
                "id": "human_in_loop:approval-compact",
                "type": "approval_decision",
                "kind": "human_in_loop_tool_result",
                "version": 1,
                "status": "approved",
                "payload": {
                    "approval": {
                        "id": "approval-compact",
                        "status": "approved",
                        "approval_type": "recipe.create",
                        "field_schema": [{"name": "draft", "widget": "recipe_draft_editor"}],
                        "initial_values": {"draft": recipe_payload},
                    },
                    "draft": {
                        "id": "draft-compact",
                        "draft_type": "recipe",
                        "payload": recipe_payload,
                        "schema_version": "recipe.v1",
                    },
                    "operation": {
                        "id": "operation-compact",
                        "status": "succeeded",
                        "action_summary": "已创建番茄鸡蛋面",
                    },
                    "business_entity": {"title": "番茄鸡蛋面", "steps": [{"text": "SECRET_BUSINESS_ENTITY_STEP"}]},
                },
                "sourceDraftId": "draft-compact",
                "sourceApprovalId": "approval-compact",
            }
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-compact",
                run_id="run-compact",
                conversation=[
                    {
                        "id": "message-compact",
                        "role": "assistant",
                        "content": "已生成草稿",
                        "metadata": {"artifacts": [approval_artifact]},
                        "artifacts": [
                            {
                                "id": "draft-compact",
                                "type": "recipe",
                                "version": 1,
                                "status": "pending",
                                "payload": recipe_payload,
                            },
                            approval_artifact,
                        ],
                    }
                ],
                current_message="继续处理",
                current_run_artifacts=[approval_artifact],
                previous_results=[
                    SkillResult(
                        text="上一轮结果",
                        status="waiting_approval",
                        drafts=[
                            {
                                "draft_type": "recipe",
                                "payload": recipe_payload,
                                "schema_version": "recipe.v1",
                                "draft_id": "draft-compact",
                                "approval_id": "approval-compact",
                            }
                        ],
                    )
                ],
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-compact",
                        run_id="run-compact",
                    ),
                ),
            )
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )

            payload = agent.prompt_payload_builder.user_payload(context, ["recipe_draft"], [])
            serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)

            self.assertIn("draft-compact", serialized)
            self.assertIn("approval-compact", serialized)
            self.assertIn("ingredientCount", serialized)
            self.assertIn("stepCount", serialized)
            self.assertNotIn("SECRET_STEP_TEXT", serialized)
            self.assertNotIn("SECRET_INGREDIENT_NOTE", serialized)
            self.assertNotIn("SECRET_BUSINESS_ENTITY_STEP", serialized)
            self.assertNotIn("ingredient_items", serialized)
            self.assertNotIn('"steps"', serialized)
            self.assertNotIn("field_schema", serialized)
            self.assertNotIn("initial_values", serialized)
            self.assertNotIn("business_entity", serialized)

        def test_orchestrator_rejects_ambiguous_draft_tool_without_type(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )

            with self.assertRaisesRegex(ValueError, "Draft tool custom.create_draft did not identify draft type"):
                agent.injection_manager.draft_type_from_tool_output(
                    "custom.create_draft",
                    {},
                    ["meal_plan", "shopping_list"],
                )

        def test_orchestrator_treats_model_card_json_as_plain_text(self) -> None:
            class MissingCardFieldsProvider(BaseChatProvider):
                model_name = "missing-card-fields-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, max_rounds
                    text = '{"cards":[{"type":"inventory_summary"}]}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            result = WorkspaceOrchestratorAgent(
                provider=MissingCardFieldsProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-missing-card-fields",
                    run_id="run-missing-card-fields",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-missing-card-fields",
                            run_id="run-missing-card-fields",
                        ),
                    ),
                ),
                injected_skill_keys=["inventory_analysis"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.cards, [])
            self.assertEqual(result.text, '{"cards":[{"type":"inventory_summary"}]}')

        def test_orchestrator_does_not_create_result_cards_from_model_text(self) -> None:
            class IncompleteCardDataProvider(BaseChatProvider):
                model_name = "incomplete-card-data-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, max_rounds
                    text = '{"id":"card-1","type":"inventory_summary","title":"库存概览","data":{}}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            result = WorkspaceOrchestratorAgent(
                provider=IncompleteCardDataProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-incomplete-card-data",
                    run_id="run-incomplete-card-data",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-incomplete-card-data",
                            run_id="run-incomplete-card-data",
                        ),
                    ),
                ),
                injected_skill_keys=["inventory_analysis"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.cards, [])
            self.assertEqual(result.error, None)

        def test_orchestrator_payload_exposes_draft_contract_only_after_draft_skill_is_active(self) -> None:
            class SchemaCapturingProvider(BaseChatProvider):
                model_name = "orchestrator-schema-model"

                def __init__(self) -> None:
                    self.payloads: list[dict] = []
                    self.systems: list[str] = []
                    self.tool_names_by_round: list[list[str]] = []
                    self.inject_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del max_rounds
                    self.payloads.append(json.loads(user))
                    self.systems.append(system)
                    self.tool_names_by_round.append(_tool_names(tools))
                    self.inject_result = tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
                    self.tool_names_by_round.append(_tool_names(tools))
                    text = "我会生成菜谱草稿，确认后再写入。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = SchemaCapturingProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator-schema",
                run_id="run-orchestrator-schema",
                conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄鸡蛋菜谱", "artifacts": []}],
                current_message="生成一个番茄鸡蛋菜谱",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator-schema",
                        run_id="run-orchestrator-schema",
                    ),
                ),
            )

            agent = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            )
            result = agent.run(context)

            self.assertEqual(result.status, "completed")
            self.assertNotIn("allowedDraftTypes", provider.payloads[0])
            self.assertNotIn("allowedCardTypes", provider.payloads[0])
            self.assertIn("recipe.create_draft", provider.tool_names_by_round[1])
            self.assertIn("instructions", provider.inject_result["injectedSkills"][0])
            self.assertIn("菜谱", provider.inject_result["injectedSkills"][0]["instructions"])
            self.assertEqual(provider.inject_result["injectedSkills"][0]["approvalPolicy"], "draft_then_confirm")
            self.assertEqual(
                provider.inject_result["injectedSkills"][0]["toolBudget"],
                {"max_tool_calls": 28, "max_same_read_calls": 2},
            )
            self.assertEqual(
                provider.inject_result["injectedSkills"][0]["draftContract"],
                {
                    "recipe": {
                        "schemaVersion": "recipe.v1",
                        "approvalConfigKey": "recipe",
                        "commitHandlerKey": "recipe",
                    }
                },
            )
            injected_completion_policy = provider.inject_result["injectedSkills"][0]["completionPolicy"]
            self.assertFalse(injected_completion_policy["requiresTerminalOutput"])
            self.assertTrue(injected_completion_policy["terminalTextAllowed"])
            self.assertEqual(injected_completion_policy["terminalTools"], {})
            self.assertEqual(
                injected_completion_policy["followupRequiredTools"]["script.lint_recipe_draft"],
                "菜谱草稿 lint 后必须继续修正草稿、请求补充信息，或调用 recipe.create_draft。",
            )
            self.assertIn("ingredient.search", injected_completion_policy["followupRequiredTools"])
            initial_metadata = prompt_contract_metadata(provider.systems[0])
            self.assertEqual(initial_metadata["profileKey"], "main_workspace")
            self.assertTrue(initial_metadata["includeCatalogRecords"])
            self.assertTrue(initial_metadata["includeDynamicInjectionContract"])
            self.assertFalse(initial_metadata["includeDraftContract"])
            self.assertFalse(initial_metadata["includeAllowedDraftTypes"])
            self.assertEqual(initial_metadata["artifactContextPolicy"], "all")
            self.assertTrue(initial_metadata["includeArtifactContextContract"])
            self.assertIn("workspace.read_artifact", provider.systems[0])
            self.assertEqual(initial_metadata["allowedDraftTypes"], [])

            active_payload = agent.prompt_payload_builder.user_payload(context, ["recipe_draft"], [])
            active_prompt = agent.prompt_payload_builder.system_prompt(context, ["recipe_draft"])
            self.assertEqual(active_payload["allowedDraftTypes"], ["recipe"])
            active_metadata = prompt_contract_metadata(active_prompt)
            self.assertTrue(active_metadata["includeDraftContract"])
            self.assertTrue(active_metadata["includeAllowedDraftTypes"])
            self.assertEqual(active_metadata["artifactContextPolicy"], "all")
            self.assertEqual(active_metadata["allowedDraftTypes"], ["recipe"])

        def test_orchestrator_creates_draft_only_from_draft_tool(self) -> None:
            class DraftCardProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-model"

                def __init__(self) -> None:
                    self.tool_calls: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
                    _tool_names(tools)
                    text = "我先生成番茄菜谱草稿。"
                    if message_handler is not None:
                        message_handler(text)
                    self.tool_calls.append("recipe.create_draft")
                    tool_handler(
                        "recipe.create_draft",
                        {
                            "draft": {
                                "draftType": "recipe",
                                "schemaVersion": "recipe.v1",
                                "title": "番茄菜",
                                "servings": 2,
                                "prep_minutes": 15,
                                "difficulty": "easy",
                                "ingredient_items": [
                                    {
                                        "ingredient_id": "ingredient-tomato",
                                        "ingredient_name": "番茄",
                                        "quantity": 1,
                                        "unit": "个",
                                        "note": "",
                                    }
                                ],
                                "steps": [
                                    {
                                        "title": "处理食材",
                                        "text": "番茄切块。",
                                        "icon": "tomato",
                                        "summary": "切番茄",
                                        "estimated_minutes": 3,
                                        "tip": "",
                                        "key_points": ["切块"],
                                    },
                                    {
                                        "title": "下锅翻炒",
                                        "text": "热锅后放入番茄翻炒出汁。",
                                        "icon": "pan",
                                        "summary": "炒出汤汁",
                                        "estimated_minutes": 6,
                                        "tip": "",
                                        "key_points": ["中火"],
                                    },
                                    {
                                        "title": "调味装盘",
                                        "text": "加盐调味后装盘。",
                                        "icon": "plate",
                                        "summary": "完成装盘",
                                        "estimated_minutes": 3,
                                        "tip": "",
                                        "key_points": ["调味"],
                                    },
                                ],
                                "tips": "",
                                "scene_tags": [],
                            }
                        },
                    )
                    return ChatProviderResult(
                        text=text,
                        status="waiting_approval",
                        model=self.model_name,
                    )

            provider = DraftCardProvider()
            with self.SessionLocal() as db:
                context = SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-orchestrator-draft-card",
                    run_id="run-orchestrator-draft-card",
                    conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄菜谱", "artifacts": []}],
                    current_message="生成一个番茄菜谱",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-orchestrator-draft-card",
                            run_id="run-orchestrator-draft-card",
                        ),
                    ),
                )

                result = WorkspaceOrchestratorAgent(
                    provider=provider,
                    skill_registry=build_workspace_skill_registry(),
                ).run(context)

            self.assertEqual(result.status, "waiting_approval")
            self.assertEqual([draft["draft_type"] for draft in result.drafts], ["recipe"])
            self.assertEqual(result.cards, [])
            self.assertEqual(provider.tool_calls, ["recipe.create_draft"])

        def test_orchestrator_does_not_create_draft_from_model_text(self) -> None:
            class DraftCardWithoutToolProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-without-tool-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, max_rounds
                    self.calls += 1
                    text = '{"cards":[{"type":"draft","title":"菜谱草稿","data":{}}]}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            result = WorkspaceOrchestratorAgent(
                provider=DraftCardWithoutToolProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-orchestrator-draft-card-without-tool",
                    run_id="run-orchestrator-draft-card-without-tool",
                    conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄菜谱", "artifacts": []}],
                    current_message="生成一个番茄菜谱",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-orchestrator-draft-card-without-tool",
                            run_id="run-orchestrator-draft-card-without-tool",
                        ),
                    ),
                ),
                injected_skill_keys=["recipe_draft"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts, [])
            self.assertEqual(result.cards, [])
            self.assertEqual(result.error, None)

        def test_orchestrator_allows_skill_completion_without_business_output(self) -> None:
            class IncompleteRecipeCookProvider(BaseChatProvider):
                model_name = "incomplete-recipe-cook-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, max_rounds
                    text = "我会先查找番茄炒蛋的已有菜谱，并按 2 人份预览库存扣减。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            result = WorkspaceOrchestratorAgent(
                provider=IncompleteRecipeCookProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-incomplete-recipe-cook",
                    run_id="run-incomplete-recipe-cook",
                    conversation=[{"id": "message-1", "role": "user", "content": "开始做番茄炒蛋，按 2 人份，做完后记录到今晚晚餐。", "artifacts": []}],
                    current_message="开始做番茄炒蛋，按 2 人份，做完后记录到今晚晚餐。",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-incomplete-recipe-cook",
                            run_id="run-incomplete-recipe-cook",
                        ),
                    ),
                ),
                injected_skill_keys=["recipe_cook"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts, [])
            self.assertEqual(result.error, None)
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["recipe_cook"])

        def test_recipe_cook_preview_requires_followup_from_skill_yaml_policy(self) -> None:
            outer = self

            class RecipeCookPreviewOnlyProvider(BaseChatProvider):
                model_name = "recipe-cook-preview-policy-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, message_handler, max_rounds
                    outer.assertIn("recipe.preview_cook", _tool_names(tools))
                    tool_handler("recipe.preview_cook", {"recipeId": "recipe-test", "servings": 2})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            result = WorkspaceOrchestratorAgent(
                provider=RecipeCookPreviewOnlyProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-recipe-cook-preview-policy",
                    run_id="run-recipe-cook-preview-policy",
                    conversation=[{"id": "message-1", "role": "user", "content": "预览一下番茄炒蛋够不够", "artifacts": []}],
                    current_message="预览一下番茄炒蛋够不够",
                    tool_executor=ToolExecutor(
                        _recipe_cook_policy_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-recipe-cook-preview-policy",
                            run_id="run-recipe-cook-preview-policy",
                        ),
                    ),
                ),
                injected_skill_keys=["recipe_cook"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_followup_required")
            self.assertEqual(
                result.context_summary["orchestrator"]["pendingFollowups"],
                [
                    {
                        "tool": "recipe.preview_cook",
                        "sideEffect": "read",
                        "hint": "预览后必须继续说明缺料、请求补充信息，或在库存充足时生成 recipe_cook 草稿。",
                    }
                ],
            )

        def test_orchestrator_fails_when_followup_tool_has_no_terminal_output(self) -> None:
            class FollowupWithoutTerminalProvider(BaseChatProvider):
                model_name = "followup-without-terminal-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, message_handler, max_rounds
                    assert "test.contract_read" in _tool_names(tools)
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {
                    "items": [{"name": "番茄"}],
                    "requires_followup": True,
                    "followup_hint": "需要基于读取结果输出总结、追问、卡片或草稿。",
                }
            )
            result = WorkspaceOrchestratorAgent(
                provider=FollowupWithoutTerminalProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-followup-without-terminal",
                    run_id="run-followup-without-terminal",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取后继续", "artifacts": []}],
                    current_message="读取后继续",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-followup-without-terminal",
                            run_id="run-followup-without-terminal",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_followup_required")
            self.assertEqual(result.context_summary["orchestrator"]["pendingFollowups"][0]["tool"], "test.contract_read")

        def test_orchestrator_allows_terminal_text_after_followup_tool(self) -> None:
            class FollowupWithTextProvider(BaseChatProvider):
                model_name = "followup-with-text-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    tool_handler("test.contract_read", {})
                    text = "已根据读取结果整理：目前有 1 个候选项。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {
                    "items": [{"name": "番茄"}],
                    "metadata": {
                        "requiresFollowup": True,
                        "followupHint": "需要输出总结。",
                    },
                }
            )
            result = WorkspaceOrchestratorAgent(
                provider=FollowupWithTextProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-followup-with-text",
                    run_id="run-followup-with-text",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取后总结", "artifacts": []}],
                    current_message="读取后总结",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-followup-with-text",
                            run_id="run-followup-with-text",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.error, None)
            self.assertIn("1 个候选项", result.text)

        def test_orchestrator_allows_tool_terminal_output_without_text(self) -> None:
            class TerminalToolOutputProvider(BaseChatProvider):
                model_name = "terminal-tool-output-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {
                    "status": "ok",
                    "orchestrator": {
                        "terminal_output": True,
                        "followup_hint": "工具输出已经是终态。",
                    },
                }
            )
            result = WorkspaceOrchestratorAgent(
                provider=TerminalToolOutputProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-terminal-tool-output",
                    run_id="run-terminal-tool-output",
                    conversation=[{"id": "message-1", "role": "user", "content": "直接返回工具终态", "artifacts": []}],
                    current_message="直接返回工具终态",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-terminal-tool-output",
                            run_id="run-terminal-tool-output",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.error, None)
            self.assertEqual(result.text, "")
            self.assertEqual(result.context_summary["orchestrator"]["terminalToolOutputs"][0]["tool"], "test.contract_read")

        def test_orchestrator_uses_tool_definition_followup_metadata(self) -> None:
            class DefinitionFollowupProvider(BaseChatProvider):
                model_name = "definition-followup-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                requires_followup=True,
                followup_hint="ToolDefinition 要求模型继续输出总结。",
            )
            result = WorkspaceOrchestratorAgent(
                provider=DefinitionFollowupProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-definition-followup",
                    run_id="run-definition-followup",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取后继续", "artifacts": []}],
                    current_message="读取后继续",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-definition-followup",
                            run_id="run-definition-followup",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_followup_required")
            self.assertEqual(
                result.context_summary["orchestrator"]["pendingFollowups"],
                [
                    {
                        "tool": "test.contract_read",
                        "sideEffect": "read",
                        "hint": "ToolDefinition 要求模型继续输出总结。",
                    }
                ],
            )

        def test_orchestrator_uses_tool_definition_terminal_output_metadata(self) -> None:
            class DefinitionTerminalProvider(BaseChatProvider):
                model_name = "definition-terminal-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"status": "ok"},
                terminal_output=True,
                followup_hint="ToolDefinition 声明工具输出可作为终态。",
            )
            result = WorkspaceOrchestratorAgent(
                provider=DefinitionTerminalProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-definition-terminal",
                    run_id="run-definition-terminal",
                    conversation=[{"id": "message-1", "role": "user", "content": "直接返回工具终态", "artifacts": []}],
                    current_message="直接返回工具终态",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-definition-terminal",
                            run_id="run-definition-terminal",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.error, None)
            self.assertEqual(
                result.context_summary["orchestrator"]["terminalToolOutputs"],
                [
                    {
                        "tool": "test.contract_read",
                        "sideEffect": "read",
                        "hint": "ToolDefinition 声明工具输出可作为终态。",
                    }
                ],
            )

        def test_tool_output_metadata_overrides_tool_definition_defaults(self) -> None:
            class OutputOverrideProvider(BaseChatProvider):
                model_name = "output-override-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {
                    "status": "ok",
                    "metadata": {
                        "requires_followup": False,
                    },
                },
                requires_followup=True,
                followup_hint="默认需要继续处理。",
            )
            result = WorkspaceOrchestratorAgent(
                provider=OutputOverrideProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-output-override",
                    run_id="run-output-override",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取后输出覆盖默认值", "artifacts": []}],
                    current_message="读取后输出覆盖默认值",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-output-override",
                            run_id="run-output-override",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_terminal_output_missing")
            self.assertEqual(result.context_summary["orchestrator"]["pendingFollowups"], [])

        def test_skill_completion_policy_can_require_tool_followup(self) -> None:
            class SkillPolicyFollowupProvider(BaseChatProvider):
                model_name = "skill-policy-followup-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                completion_policy=SkillCompletionPolicy(
                    followup_required_tools={
                        "test.contract_read": "skill.yaml 要求基于读取结果继续输出。",
                    }
                ),
            )
            result = WorkspaceOrchestratorAgent(
                provider=SkillPolicyFollowupProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-skill-policy-followup",
                    run_id="run-skill-policy-followup",
                    conversation=[{"id": "message-1", "role": "user", "content": "读取后继续", "artifacts": []}],
                    current_message="读取后继续",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-skill-policy-followup",
                            run_id="run-skill-policy-followup",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_followup_required")
            self.assertEqual(
                result.context_summary["orchestrator"]["pendingFollowups"],
                [
                    {
                        "tool": "test.contract_read",
                        "sideEffect": "read",
                        "hint": "skill.yaml 要求基于读取结果继续输出。",
                    }
                ],
            )

        def test_skill_completion_policy_applies_to_script_tools(self) -> None:
            class ScriptPolicyProvider(BaseChatProvider):
                model_name = "skill-script-policy-model"

                def __init__(self) -> None:
                    self.script_definition: ToolDefinition | None = None

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要整理菜谱草稿"})
                    current_tools = {definition.name: definition for definition in tools()}
                    self.script_definition = current_tools["script.lint_recipe_draft"]
                    text = "已准备好检查菜谱草稿。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = ScriptPolicyProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-script-policy",
                    run_id="run-script-policy",
                    conversation=[{"id": "message-1", "role": "user", "content": "整理菜谱草稿", "artifacts": []}],
                    current_message="整理菜谱草稿",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-script-policy",
                            run_id="run-script-policy",
                        ),
                    ),
                ),
            )

            self.assertEqual(result.status, "completed")
            self.assertIsNotNone(provider.script_definition)
            assert provider.script_definition is not None
            self.assertTrue(provider.script_definition.requires_followup)
            self.assertFalse(provider.script_definition.terminal_output)
            self.assertEqual(
                provider.script_definition.followup_hint,
                "菜谱草稿 lint 后必须继续修正草稿、请求补充信息，或调用 recipe.create_draft。",
            )

        def test_catalog_completion_policy_applies_to_real_tool_definitions(self) -> None:
            class CatalogPolicyProvider(BaseChatProvider):
                model_name = "catalog-policy-model"

                def __init__(self) -> None:
                    self.summary_definition: ToolDefinition | None = None
                    self.available_definition: ToolDefinition | None = None
                    self.ingredient_search_definition: ToolDefinition | None = None
                    self.artifact_definition: ToolDefinition | None = None

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["inventory_analysis"], "reason": "需要查看库存"})
                    current_tools = {definition.name: definition for definition in tools()}
                    self.summary_definition = current_tools["inventory.read_summary"]
                    self.available_definition = current_tools["inventory.read_available_items"]
                    self.ingredient_search_definition = current_tools["ingredient.search"]
                    self.artifact_definition = current_tools["workspace.read_artifact"]
                    text = "已准备好库存能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = CatalogPolicyProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-catalog-policy",
                    run_id="run-catalog-policy",
                    conversation=[{"id": "message-1", "role": "user", "content": "库存怎么样", "artifacts": []}],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-catalog-policy",
                            run_id="run-catalog-policy",
                        ),
                    ),
                ),
            )

            self.assertEqual(result.status, "completed")
            self.assertIsNotNone(provider.summary_definition)
            self.assertIsNotNone(provider.available_definition)
            self.assertIsNotNone(provider.ingredient_search_definition)
            self.assertIsNotNone(provider.artifact_definition)
            assert provider.summary_definition is not None
            assert provider.available_definition is not None
            assert provider.ingredient_search_definition is not None
            assert provider.artifact_definition is not None
            self.assertTrue(provider.summary_definition.terminal_output)
            self.assertEqual(provider.summary_definition.followup_hint, "库存概览卡可作为库存查询的终态输出。")
            self.assertFalse(provider.available_definition.requires_followup)
            self.assertTrue(provider.available_definition.terminal_output)
            self.assertEqual(
                provider.available_definition.followup_hint,
                "可用库存卡可作为库存查询的终态输出。",
            )
            self.assertTrue(provider.ingredient_search_definition.requires_followup)
            self.assertFalse(provider.ingredient_search_definition.terminal_output)
            self.assertEqual(
                provider.ingredient_search_definition.followup_hint,
                "食材检索后必须说明候选库存处理对象、请求用户选择，或继续读取食材/库存并生成库存处理草稿。",
            )
            self.assertTrue(provider.artifact_definition.requires_followup)
            self.assertEqual(
                provider.artifact_definition.followup_hint,
                "读取历史 artifact 后必须说明可复用内容、请求补充信息，或继续生成/调整库存处理草稿。",
            )

        def test_shared_inventory_tool_policy_is_order_independent_and_hides_intermediate_card(self) -> None:
            class MultiSkillInventoryProvider(BaseChatProvider):
                model_name = "multi-skill-inventory-policy-model"

                def __init__(self, skill_order: list[str]) -> None:
                    self.skill_order = skill_order
                    self.available_definition: ToolDefinition | None = None

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler(
                        "skill.inject",
                        {"skills": self.skill_order, "reason": "先读库存再安排餐食"},
                    )
                    current_tools = {definition.name: definition for definition in tools()}
                    self.available_definition = current_tools["inventory.read_available_items"]
                    tool_handler("inventory.read_available_items", {"limit": 20})
                    text = "我已经读取库存，接下来可以继续安排餐食。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            for index, skill_order in enumerate(
                (["meal_plan", "inventory_analysis"], ["inventory_analysis", "meal_plan"])
            ):
                with self.subTest(skill_order=skill_order), self.SessionLocal() as db:
                    provider = MultiSkillInventoryProvider(skill_order)
                    result = WorkspaceOrchestratorAgent(
                        provider=provider,
                        skill_registry=build_workspace_skill_registry(),
                    ).run(
                        SkillContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id=f"conversation-multi-skill-inventory-{index}",
                            run_id=f"run-multi-skill-inventory-{index}",
                            conversation=[],
                            current_message="根据库存安排一餐",
                            tool_executor=ToolExecutor(
                                build_workspace_tool_registry(),
                                ToolContext(
                                    db=db,
                                    family_id=self.family.id,
                                    user_id=self.user.id,
                                    conversation_id=f"conversation-multi-skill-inventory-{index}",
                                    run_id=f"run-multi-skill-inventory-{index}",
                                ),
                            ),
                        )
                    )

                    self.assertEqual(result.status, "completed")
                    self.assertEqual(result.cards, [])
                    self.assertIsNotNone(provider.available_definition)
                    assert provider.available_definition is not None
                    self.assertTrue(provider.available_definition.requires_followup)
                    self.assertFalse(provider.available_definition.terminal_output)
                    self.assertEqual(
                        provider.available_definition.followup_hint,
                        "可用库存读取后必须说明可安排方向、请求补充信息，或生成推荐/计划草稿。",
                    )

        def test_catalog_completion_policy_applies_to_business_read_tools(self) -> None:
            class BusinessReadPolicyProvider(BaseChatProvider):
                model_name = "business-read-policy-model"

                def __init__(self) -> None:
                    self.recipe_definition: ToolDefinition | None = None
                    self.plan_definition: ToolDefinition | None = None

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["recipe_cook"], "reason": "需要按菜谱做菜"})
                    current_tools = {definition.name: definition for definition in tools()}
                    self.recipe_definition = current_tools["recipe.read_by_id"]
                    self.plan_definition = current_tools["meal_plan.read_existing"]
                    text = "已准备好做菜能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            provider = BusinessReadPolicyProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-business-read-policy",
                    run_id="run-business-read-policy",
                    conversation=[{"id": "message-1", "role": "user", "content": "按菜谱做菜", "artifacts": []}],
                    current_message="按菜谱做菜",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-business-read-policy",
                            run_id="run-business-read-policy",
                        ),
                    ),
                ),
            )

            self.assertEqual(result.status, "completed")
            self.assertIsNotNone(provider.recipe_definition)
            self.assertIsNotNone(provider.plan_definition)
            assert provider.recipe_definition is not None
            assert provider.plan_definition is not None
            self.assertTrue(provider.recipe_definition.requires_followup)
            self.assertFalse(provider.recipe_definition.terminal_output)
            self.assertEqual(
                provider.recipe_definition.followup_hint,
                "读取菜谱后必须说明可做性、请求补充信息，或调用 recipe.preview_cook。",
            )
            self.assertTrue(provider.plan_definition.requires_followup)
            self.assertEqual(
                provider.plan_definition.followup_hint,
                "读取已有计划后必须说明匹配的计划项、请求补充信息，或继续预览/生成 recipe_cook 草稿。",
            )

        def test_skill_completion_policy_can_require_terminal_output_without_tool_calls(self) -> None:
            class EmptySkillProvider(BaseChatProvider):
                model_name = "empty-skill-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, message_handler, max_rounds
                    return ChatProviderResult(text="", status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                completion_policy=SkillCompletionPolicy(requires_terminal_output=True),
            )
            result = WorkspaceOrchestratorAgent(
                provider=EmptySkillProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-skill-policy-requires-terminal",
                    run_id="run-skill-policy-requires-terminal",
                    conversation=[{"id": "message-1", "role": "user", "content": "必须有终态输出", "artifacts": []}],
                    current_message="必须有终态输出",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-skill-policy-requires-terminal",
                            run_id="run-skill-policy-requires-terminal",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_terminal_output_missing")
            diagnostic = json.loads(result.diagnostic or "{}")
            self.assertTrue(diagnostic["requiresTerminalOutput"])
            self.assertTrue(diagnostic["terminalTextAllowed"])

        def test_dynamic_skill_completion_policy_can_disallow_text_only_terminal_output(self) -> None:
            class DynamicTextOnlyProvider(BaseChatProvider):
                model_name = "dynamic-text-only-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    tool_handler("skill.inject", {"skills": ["contract_test"]})
                    text = "我用文字结束。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"items": [{"name": "番茄"}]},
                completion_policy=SkillCompletionPolicy(
                    requires_terminal_output=True,
                    terminal_text_allowed=False,
                ),
            )
            result = WorkspaceOrchestratorAgent(
                provider=DynamicTextOnlyProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-dynamic-text-disallowed",
                    run_id="run-dynamic-text-disallowed",
                    conversation=[{"id": "message-1", "role": "user", "content": "动态注入后不能只用文本结束", "artifacts": []}],
                    current_message="动态注入后不能只用文本结束",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-dynamic-text-disallowed",
                            run_id="run-dynamic-text-disallowed",
                        ),
                    ),
                ),
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "orchestrator_terminal_output_missing")
            diagnostic = json.loads(result.diagnostic or "{}")
            self.assertTrue(diagnostic["requiresTerminalOutput"])
            self.assertFalse(diagnostic["terminalTextAllowed"])

        def test_skill_completion_policy_can_mark_tool_as_terminal_output(self) -> None:
            class SkillPolicyTerminalProvider(BaseChatProvider):
                model_name = "skill-policy-terminal-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, message_handler, max_rounds
                    tool_handler("test.contract_read", {})
                    return ChatProviderResult(text=None, status="completed", model=self.model_name)

            tool_registry, skill_registry = _contract_tool_registries(
                {"status": "ok"},
                completion_policy=SkillCompletionPolicy(
                    terminal_tools={
                        "test.contract_read": "skill.yaml 声明读取结果可作为终态。",
                    }
                ),
            )
            result = WorkspaceOrchestratorAgent(
                provider=SkillPolicyTerminalProvider(),
                skill_registry=skill_registry,
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-skill-policy-terminal",
                    run_id="run-skill-policy-terminal",
                    conversation=[{"id": "message-1", "role": "user", "content": "直接返回工具终态", "artifacts": []}],
                    current_message="直接返回工具终态",
                    orchestrator_profile=_contract_test_profile_state(),
                    tool_executor=ToolExecutor(
                        tool_registry,
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-skill-policy-terminal",
                            run_id="run-skill-policy-terminal",
                        ),
                    ),
                ),
                injected_skill_keys=["contract_test"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.error, None)
            self.assertEqual(
                result.context_summary["orchestrator"]["terminalToolOutputs"],
                [
                    {
                        "tool": "test.contract_read",
                        "sideEffect": "read",
                        "hint": "skill.yaml 声明读取结果可作为终态。",
                    }
                ],
            )

        def test_orchestrator_rejects_tool_call_before_skill_injection(self) -> None:
            class PrematureToolProvider(BaseChatProvider):
                model_name = "premature-tool-model"

                def __init__(self) -> None:
                    self.tool_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.tool_result = tool_handler("meal_plan.create_draft", {})
                    text = "我还不能直接创建餐食计划草稿。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator",
                run_id="run-orchestrator",
                conversation=[],
                current_message="安排晚餐",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator",
                        run_id="run-orchestrator",
                    ),
                ),
            )

            provider = PrematureToolProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_result.get("code"), "unavailable_tool")
            self.assertEqual(result.drafts, [])

        def test_workspace_graph_can_run_orchestrator_as_langgraph_node(self) -> None:
            class DirectOrchestratorProvider(BaseChatProvider):
                model_name = "direct-orchestrator-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, max_rounds
                    text = "可以，今天先吃清淡一点。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=DirectOrchestratorProvider())
                response = WorkspaceGraphRunner(service).invoke_user_message(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="今天简单吃点什么？",
                )
                run = db.get(AIAgentRun, response["run"]["id"])

            self.assertEqual(response["run"]["status"], "completed")
            self.assertEqual(response["message"]["content"], "可以，今天先吃清淡一点。")
            self.assertIsNotNone(run)
            assert run is not None
            self.assertIn("orchestrator", run.context_summary)
            self.assertEqual(run.agent_key, "workspace_orchestrator")

        def test_sync_invoke_runtime_exception_marks_run_failed(self) -> None:
            with self.SessionLocal() as db:
                runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
                with patch.object(runner.graph, "invoke", side_effect=RuntimeError("graph exploded")):
                    response = runner.invoke_user_message(
                        family_id=self.family.id,
                        user_id=self.user.id,
                        message="今天吃什么？",
                        client_run_id="agent_run-sync-runtime-failure",
                    )
                run = db.get(AIAgentRun, "agent_run-sync-runtime-failure")
                assert run is not None
                conversation = db.get(AIConversation, run.conversation_id)
                message = db.get(AIMessage, response["message"]["id"])
                event = db.scalar(select(AIRunEvent).where(AIRunEvent.run_id == "agent_run-sync-runtime-failure"))

            self.assertEqual(response["run"]["status"], "failed")
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "failed")
            self.assertIn("graph exploded", run.error or "")
            self.assertIsNotNone(message)
            assert message is not None
            self.assertEqual(message.status, "failed")
            self.assertIsNotNone(conversation)
            assert conversation is not None
            self.assertEqual(conversation.last_run_status, "failed")
            self.assertNotIn("activeRunId", conversation.context or {})
            self.assertIsNotNone(event)
            assert event is not None
            self.assertEqual(event.type, "error")
            self.assertEqual(event.payload.get("error"), "graph exploded")

        def test_agent_round_limit_finalizes_running_state_as_failed(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-round-limit",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.RECOMMENDATION,
                    prompt="继续运行",
                    response="",
                    title="轮次上限",
                    status="running",
                    context={"activeRunId": "agent_run-round-limit"},
                    created_by=self.user.id,
                )
                user_message = AIMessage(
                    id="ai_message-round-limit-user",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="user",
                    content="继续运行",
                    content_type="text",
                    status="completed",
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent_run-round-limit",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=user_message.id,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="",
                    input_summary="继续运行",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="round-limit-model",
                    created_by=self.user.id,
                )
                db.add_all([conversation, user_message, run])
                db.commit()

                runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
                next_node = runner._route_after_orchestrator(
                    {
                        "status": "running",
                        "agent_rounds": MAX_AGENT_ROUNDS,
                    }
                )
                result = runner._finalize(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "status": "running",
                        "agent_rounds": MAX_AGENT_ROUNDS,
                        "error": None,
                    }
                )
                db.commit()
                db.refresh(run)
                db.refresh(conversation)
                assistant_message = db.scalar(
                    select(AIMessage).where(AIMessage.run_id == run.id, AIMessage.role == "assistant")
                )

            self.assertEqual(next_node, "finalize")
            self.assertEqual(result["status"], "failed")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.error, "agent round limit exceeded")
            self.assertEqual(conversation.last_run_status, "failed")
            self.assertNotIn("activeRunId", conversation.context or {})
            self.assertIsNotNone(assistant_message)
            assert assistant_message is not None
            self.assertEqual(assistant_message.status, "failed")

        def test_workspace_orchestrator_human_input_interrupt_resumes_same_run(self) -> None:
            class HumanInputProvider(BaseChatProvider):
                model_name = "human-input-orchestrator-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排餐食计划"})
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "你想安排几天晚餐？",
                                "inputMode": "choice_or_text",
                                "options": [{"id": "three-days", "label": "三天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    payload = json.loads(user)
                    self.resume_injected_skills = payload.get("injectedSkills") or []
                    self.resume_artifacts = [*(payload.get("artifacts") or []), *(payload.get("currentRunArtifacts") or [])]
                    text = "好的，我按三天继续整理。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = HumanInputProvider()
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=provider)
                response = WorkspaceGraphRunner(service).invoke_user_message(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="帮我安排晚餐",
                )
                self.assertEqual(response["run"]["status"], "waiting_input")
                request_parts = [
                    part
                    for part in response["message"]["parts"]
                    if isinstance(part, dict) and part.get("type") == "human_input_request"
                ]
                self.assertEqual(len(request_parts), 1)
                request_id = request_parts[0]["request"]["id"]

                other_user, other_membership = self.create_family_member()
                conversation = db.get(AIConversation, response["conversation_id"])
                assert conversation is not None
                conversation.visibility = AIConversationVisibility.FAMILY
                db.commit()

                resumed = service.respond_human_input(
                    family_id=self.family.id,
                    user_id=other_user.id,
                    conversation_id=response["conversation_id"],
                    request_id=request_id,
                    selected_option_ids=["three-days"],
                    text="三天",
                )
                db.expire_all()
                run = db.get(AIAgentRun, response["run"]["id"])
                message = db.get(AIMessage, response["message"]["id"])

            self.assertEqual(resumed["run"]["status"], "completed")
            self.assertEqual(resumed["message"]["content"], "你想安排几天晚餐？\n\n好的，我按三天继续整理。")
            self.assertEqual(provider.calls, 2)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            assert run is not None
            assert message is not None
            self.assertEqual(run.status, "completed")
            self.assertEqual(run.context_summary["lastHumanInputResult"]["selectedOptionIds"], ["three-days"])
            self.assertEqual(run.context_summary["lastHumanInputResult"]["summary"], "三天")
            self.assertEqual(run.context_summary["orchestrator"]["injectedSkills"], ["meal_plan"])
            self.assertEqual(provider.resume_injected_skills, ["meal_plan"])
            self.assertIn("meal_plan", provider.resume_artifacts[-1].get("payload", {}).get("request", {}).get("sourceSkills", []))
            self.assertTrue(
                any(
                    item.get("type") == "human.input_result"
                    for item in (message.message_metadata or {}).get("artifacts", [])
                    if isinstance(item, dict)
                )
            )
            human_input_parts = [
                part
                for part in (message.parts or [])
                if isinstance(part, dict) and part.get("type") == "human_input_request"
            ]
            self.assertEqual(human_input_parts[0].get("status"), "completed")
            self.assertIsNotNone(human_input_parts[0].get("responded_at"))
            self.assertEqual(human_input_parts[0].get("response", {}).get("selectedOptionIds"), ["three-days"])
            self.assertEqual(human_input_parts[0].get("response", {}).get("text"), "三天")
            self.assertEqual(human_input_parts[0].get("response", {}).get("summary"), "三天")
            self.assertEqual(human_input_parts[0].get("response", {}).get("actor"), other_user.id)

        def test_human_input_response_api_accepts_path_request_id_only(self) -> None:
            class HumanInputApiProvider(BaseChatProvider):
                model_name = "human-input-api-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排晚餐"})
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "要安排几天？",
                                "inputMode": "choice",
                                "options": [{"id": "one-day", "label": "一天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    text = "已按一天继续。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = HumanInputApiProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                first_response = self.client.post("/api/ai/chat", json={"message": "帮我安排晚餐"})
                self.assertEqual(first_response.status_code, 200, first_response.text)
                first_data = first_response.json()
                request_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "human_input_request"
                )
                request_id = request_part["request"]["id"]

                conflict_response = self.client.post(
                    "/api/ai/chat",
                    json={"conversation_id": first_data["conversation_id"], "message": "再安排两天"},
                )
                self.assertEqual(conflict_response.status_code, 409, conflict_response.text)
                self.assertIn("当前会话已有 AI 任务正在处理中", conflict_response.json()["detail"])

                response = self.client.post(
                    f"/api/ai/conversations/{first_data['conversation_id']}/human-input/{request_id}/response",
                    json={"selected_option_ids": ["one-day"], "text": "一天"},
                )

            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["status"], "completed")
            self.assertEqual(provider.calls, 2)
            response_request_part = next(
                part
                for part in data["message"]["parts"]
                if part.get("type") == "human_input_request"
            )
            self.assertEqual(response_request_part.get("status"), "completed")
            self.assertEqual(response_request_part.get("response", {}).get("selectedOptionIds"), ["one-day"])
            self.assertEqual(response_request_part.get("response", {}).get("text"), "一天")
            self.assertEqual(response_request_part.get("response", {}).get("summary"), "一天")

        def test_human_input_response_stream_returns_message_deltas(self) -> None:
            class HumanInputStreamProvider(BaseChatProvider):
                model_name = "human-input-stream-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排晚餐"})
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "要安排几天？",
                                "inputMode": "choice",
                                "options": [{"id": "three-days", "label": "三天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    text = "已按三天继续安排。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = HumanInputStreamProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                first_response = self.client.post("/api/ai/chat", json={"message": "帮我安排晚餐"})
                self.assertEqual(first_response.status_code, 200, first_response.text)
                first_data = first_response.json()
                request_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "human_input_request"
                )
                first_text_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "text"
                )
                request_id = request_part["request"]["id"]

                with self.client.stream(
                    "POST",
                    f"/api/ai/conversations/{first_data['conversation_id']}/human-input/{request_id}/response/stream",
                    json={"selected_option_ids": ["three-days"], "text": "三天"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertIn("event: message_delta", body)
            self.assertIn("已按三天继续安排。", body)
            self.assertIn("event: response", body)
            self.assertEqual(provider.calls, 2)
            events: list[tuple[str, dict]] = []
            for block in body.split("\n\n"):
                if not block.strip():
                    continue
                event_name = ""
                data_lines: list[str] = []
                for line in block.splitlines():
                    if line.startswith("event:"):
                        event_name = line.removeprefix("event:").strip()
                    elif line.startswith("data:"):
                        data_lines.append(line.removeprefix("data:").strip())
                if event_name and data_lines:
                    events.append((event_name, json.loads("\n".join(data_lines))))
            delta_event = next(data for event_name, data in events if event_name == "message_delta")
            self.assertNotEqual(delta_event["part_id"], first_text_part["id"])
            response_event = next(data for event_name, data in events if event_name == "response")
            parts = response_event["message"]["parts"]
            human_input_index = next(index for index, part in enumerate(parts) if part.get("type") == "human_input_request")
            resumed_text_index = next(index for index, part in enumerate(parts) if part.get("type") == "text" and "已按三天继续安排。" in str(part.get("text") or ""))
            self.assertLess(human_input_index, resumed_text_index)
