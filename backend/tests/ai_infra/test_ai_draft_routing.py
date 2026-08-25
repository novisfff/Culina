from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
import json
from unittest.mock import patch

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from ._support import AIAgentInfraTestCase, FakeChatProvider

from app.ai.errors import AIConflictError, AIExecutionCancelled
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult
from app.ai.skills import SkillResult
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workflows.runner_support.progressive_draft_publisher import ProgressiveDraftPublisher
from app.ai.workspace_service import AIApplicationService
from app.core.utils import utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIAutoExecutionPreference,
    AIConversation,
    AIMessage,
    AIOperation,
    AIRunCancelRequest,
    AITaskDraft,
    AIUserApproval,
    Food,
)
from app.services.ai_auto_execution.catalog import CONSENT_NOTICE_VERSION
from app.services.ai_auto_execution.policy_registry import auto_execution_policy_registry
from app.services.ai_auto_execution.policy_types import (
    EffectiveAuthorization,
    TrustedResolutionSource,
)
from app.services.ai_operations.routing import DraftRouteRequest, route_draft
from app.services.ai_operations.approval_requests import create_retry_ai_approval
from app.services.ai_operations.executor import execute_ai_operation_draft
from app.services.serializers import serialize_ai_operation


REGISTERED_ADAPTERS = frozenset({"food.favorite.v1"})


class PolicyFavoriteProvider(BaseChatProvider):
    model_name = "policy-favorite-model"

    def __init__(self, *, base_updated_at: str) -> None:
        self.base_updated_at = base_updated_at

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace route must use tool calling")

    def generate_with_tools(
        self,
        *,
        system,
        user,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds=8,
        **kwargs,
    ) -> ChatProviderResult:
        del system, user, max_rounds, kwargs
        tool_handler("skill.inject", {"skills": ["food_profile"], "reason": "收藏食物"})
        self.assert_tool_available(tools, "food_profile.create_draft")
        if message_handler is not None:
            message_handler("我来收藏这个食物。")
        tool_handler(
            "food_profile.create_draft",
            {
                "draft": {
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile_operation.v1",
                    "action": "set_favorite",
                    "targetId": "food-tomato",
                    "baseUpdatedAt": self.base_updated_at,
                    "payload": {"favorite": True},
                    "intentEvidence": {
                        "intentClarity": "explicit_context_resolved",
                        "sourceQuotes": [
                            {
                                "fields": ["action", "payload.favorite"],
                                "text": "收藏这个",
                            }
                        ],
                        "resolutionSources": [
                            {
                                "fields": ["targetId"],
                                "kind": "current_ui_context",
                                "referenceId": "current-ui-context",
                                "entityId": "food-tomato",
                            }
                        ],
                        "ambiguityCodes": [],
                        "defaultedFields": [],
                    },
                }
            },
        )
        raise AssertionError("routed draft must stop the provider loop")

    @staticmethod
    def assert_tool_available(tools, name: str) -> None:
        names = {definition.name for definition in tools()}
        if name not in names:
            raise AssertionError(f"missing tool: {name}")


class AIDraftRoutingTestCase(AIAgentInfraTestCase):
    def _seed_route(self, *, suffix: str, favorite: bool = True) -> tuple[DraftRouteRequest, str]:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            conversation = AIApplicationService(db, provider=FakeChatProvider())._get_or_create_conversation(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=None,
                prompt="收藏这个",
                quick_task=None,
            )
            message = AIMessage(
                id=f"route-message-{suffix}",
                family_id=self.family.id,
                conversation_id=conversation.id,
                role="assistant",
                content="",
                content_type="parts",
                parts=[],
                status="running",
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id=f"route-run-{suffix}",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=message.id,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="food_profile",
                input_summary="收藏这个",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={"prompt": "收藏这个"},
                output={},
                tool_calls=[],
                created_by=self.user.id,
            )
            message.run_id = run.id
            db.add_all(
                [
                    message,
                    run,
                    AIAutoExecutionPreference(
                        id=f"route-pref-{suffix}",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        action_key="food.set_favorite",
                        enabled=True,
                        consent_notice_version=CONSENT_NOTICE_VERSION,
                        consented_at=utcnow(),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.flush()
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {
                    "id": food.id,
                    "favorite": bool(food.favorite),
                },
                "payload": {"favorite": favorite},
            }
            evidence = {
                "intentClarity": "explicit_complete",
                "sourceQuotes": [{"fields": ["action"], "text": "收藏这个"}],
                "resolutionSources": [
                    {
                        "fields": ["targetId", "payload.favorite"],
                        "kind": "conversation_artifact",
                        "referenceId": f"route-source-{suffix}",
                        "entityId": food.id,
                        "rowVersion": 1,
                    }
                ],
                "ambiguityCodes": [],
                "defaultedFields": [],
            }
            request = DraftRouteRequest(
                family_id=self.family.id,
                actor_user_id=self.user.id,
                conversation_id=conversation.id,
                message_id=message.id,
                run_id=run.id,
                draft_type="food_profile",
                payload=payload,
                intent_evidence_input=evidence,
                schema_version="food_profile_operation.v1",
                tool_name="food.create_draft",
                skill_approval_policy="draft_then_policy",
                current_message="收藏这个",
                trusted_resolution_sources={
                    f"route-source-{suffix}": TrustedResolutionSource(
                        kind="conversation_artifact",
                        reference_id=f"route-source-{suffix}",
                        family_id=self.family.id,
                        entity_versions={food.id: 1},
                        entity_values={
                            food.id: {
                                "targetId": food.id,
                                "payload.favorite": favorite,
                            }
                        },
                    )
                },
                continuation={},
            )
            db.commit()
            return request, run.id

    def _route(self, request: DraftRouteRequest, **kwargs):
        with self.SessionLocal() as db:
            outcome = route_draft(
                db,
                request,
                registered_revert_adapters=REGISTERED_ADAPTERS,
                **kwargs,
            )
            db.commit()
            return outcome

    def test_manual_policy_creates_exactly_one_approval(self) -> None:
        request, _run_id = self._seed_route(suffix="manual")
        request = replace(request, skill_approval_policy="draft_then_confirm")

        first = self._route(request)
        second = self._route(request)

        self.assertEqual(first.status, "waiting_approval")
        self.assertEqual(second.approval_id, first.approval_id)
        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIUserApproval.id))), 0)

    def test_auto_route_creates_no_approval_and_commits_once(self) -> None:
        request, run_id = self._seed_route(suffix="auto")

        first = self._route(request)
        replay = self._route(request)

        self.assertEqual(first.status, "auto_executed")
        self.assertEqual(replay.operation_id, first.operation_id)
        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIUserApproval.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 1)
            run = db.get(AIAgentRun, run_id)
            food = db.get(Food, "food-tomato")
            assert run is not None and food is not None
            self.assertTrue(run.auto_execution_attempted)
            self.assertEqual(run.auto_operation_id, first.operation_id)
            self.assertTrue(food.favorite)

    def test_terminal_route_replay_skips_policy_evaluation(self) -> None:
        request, _run_id = self._seed_route(suffix="replay-policy")
        first = self._route(request)

        with (
            patch.object(
                auto_execution_policy_registry,
                "resolve_policy",
                side_effect=AssertionError("policy resolved during replay"),
            ),
            patch.object(
                auto_execution_policy_registry,
                "evaluate_draft",
                side_effect=AssertionError("policy evaluated during replay"),
            ),
        ):
            replay = self._route(request)

        self.assertEqual(replay.status, "auto_executed")
        self.assertEqual(replay.operation_id, first.operation_id)

    def test_no_change_persists_result_and_consumes_attempt_slot(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            food.favorite = True
            db.commit()
        request, run_id = self._seed_route(suffix="no-change")

        outcome = self._route(request)

        self.assertEqual(outcome.status, "no_change")
        self.assertIsNone(outcome.operation_id)
        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            message = db.get(AIMessage, request.message_id)
            assert run is not None and draft is not None and message is not None
            self.assertTrue(run.auto_execution_attempted)
            self.assertEqual(draft.status, "no_change")
            self.assertTrue(any(part.get("type") == "result_card" for part in message.parts))

    def test_no_change_target_change_under_final_lock_downgrades_without_consuming_attempt(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            food.favorite = True
            db.commit()
        request, run_id = self._seed_route(suffix="no-change-target-race")

        class MutatingPolicyRegistry:
            def __init__(self) -> None:
                self.evaluation_count = 0

            def resolve_policy(self, **kwargs):
                return auto_execution_policy_registry.resolve_policy(**kwargs)

            def evaluate_draft(self, **kwargs):
                self.evaluation_count += 1
                result = auto_execution_policy_registry.evaluate_draft(**kwargs)
                if self.evaluation_count == 2:
                    food = kwargs["db"].get(Food, request.payload["targetId"])
                    assert food is not None
                    food.favorite = False
                    food.updated_at = food.updated_at + timedelta(seconds=1)
                    kwargs["db"].flush()
                return result

        outcome = self._route(request, policy_registry=MutatingPolicyRegistry())

        self.assertEqual(outcome.status, "waiting_approval")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            assert run is not None and draft is not None
            self.assertFalse(run.auto_execution_attempted)
            self.assertEqual(draft.execution_route, "manual_confirmation")
            self.assertIn("target_changed_before_no_change", draft.policy_reason_codes)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 1)

    def test_final_authorization_failure_downgrades_before_business_write(self) -> None:
        request, _run_id = self._seed_route(suffix="downgrade")
        calls = 0

        def authorization_resolver(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return EffectiveAuthorization(
                    enabled=True,
                    source="member_preference",
                    snapshot={"member_preference_version": 1},
                    reason_codes=(),
                )
            return EffectiveAuthorization(
                enabled=False,
                source=None,
                snapshot={"member_preference_version": 2},
                reason_codes=("member_authorization_missing",),
            )

        outcome = self._route(request, authorization_resolver=authorization_resolver)

        self.assertEqual(outcome.status, "waiting_approval")
        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 1)
            self.assertFalse(db.get(Food, "food-tomato").favorite)

    def test_second_auto_attempt_routes_to_manual(self) -> None:
        request, run_id = self._seed_route(suffix="second")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.auto_execution_attempted = True
            db.commit()

        outcome = self._route(request)

        self.assertEqual(outcome.status, "waiting_approval")
        with self.SessionLocal() as db:
            draft = db.get(AITaskDraft, outcome.draft_id)
            assert draft is not None
            self.assertIn("auto_execution_already_attempted", draft.policy_reason_codes)

    def test_domain_conflict_is_persisted_as_execution_failed_without_approval(self) -> None:
        request, run_id = self._seed_route(suffix="conflict")

        with patch(
            "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
            side_effect=ValueError("forced domain conflict"),
        ):
            outcome = self._route(request)

        self.assertEqual(outcome.status, "execution_failed")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            assert run is not None and draft is not None
            self.assertTrue(run.auto_execution_attempted)
            self.assertEqual(draft.status, "execution_failed")
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)

    def test_failed_route_is_checkpointed_and_published_once_without_raw_exception(self) -> None:
        request, _run_id = self._seed_route(suffix="failure-checkpoint")
        sentinel = "PRIVATE-DOMAIN-FAILURE-failure-checkpoint"
        checkpointed = False
        emitted_events: list[tuple[bool, dict]] = []

        with self.SessionLocal() as db:
            service = AIApplicationService(db, provider=FakeChatProvider())

            def commit_stream_checkpoint(_state, *, run_status):
                nonlocal checkpointed
                self.assertEqual(run_status, "execution_failed")
                db.flush()
                message = db.get(AIMessage, request.message_id)
                assert message is not None
                failure_parts = [
                    part
                    for part in message.parts
                    if part.get("type") == "result_card"
                    and part.get("card", {}).get("data", {}).get("errorCode")
                ]
                self.assertEqual(len(failure_parts), 1)
                db.commit()
                checkpointed = True
                return True

            def progress_writer(event: dict) -> None:
                emitted_events.append((checkpointed, event))

            publisher = ProgressiveDraftPublisher(
                db=db,
                service=service,
                cancel_requested=lambda _run_id: False,
                commit_stream_checkpoint=commit_stream_checkpoint,
                optional_stream_writer=lambda: object(),
                persistent_progress_writer=lambda _writer, _state: progress_writer,
                registered_revert_adapters=REGISTERED_ADAPTERS,
            )
            publish = publisher.create_publisher(
                {
                    "family_id": request.family_id,
                    "user_id": request.actor_user_id,
                    "conversation_id": request.conversation_id,
                    "run_id": request.run_id,
                    "message": request.current_message,
                }
            )
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=RuntimeError(sentinel),
            ):
                published = publish(
                    {
                        "draft_type": request.draft_type,
                        "payload": request.payload,
                        "schema_version": request.schema_version,
                        "tool": request.tool_name,
                        "skill_approval_policy": request.skill_approval_policy,
                        "intent_evidence_input": request.intent_evidence_input,
                        "trusted_resolution_sources": request.trusted_resolution_sources,
                        "continuation": request.continuation,
                    }
                )

            self.assertEqual(published["route_status"], "execution_failed")
            self.assertEqual(len(emitted_events), 1)
            self.assertTrue(emitted_events[0][0])
            self.assertEqual(emitted_events[0][1]["event"], "message_part")
            message = db.get(AIMessage, request.message_id)
            operation = db.get(AIOperation, published["operation_id"])
            assert message is not None and operation is not None
            failure_parts = [
                part
                for part in message.parts
                if part.get("type") == "result_card"
                and part.get("card", {}).get("data", {}).get("errorCode")
            ]
            failure_artifacts = [
                artifact
                for artifact in (message.message_metadata or {}).get("artifacts") or []
                if artifact.get("type") == "draft_route_result" and artifact.get("status") == "failed"
            ]
            self.assertEqual(len(failure_parts), 1)
            self.assertEqual(len(failure_artifacts), 1)
            self.assertEqual(failure_parts[0]["card"]["data"]["errorCode"], "draft_commit_domain_failed")
            self.assertTrue(failure_parts[0]["card"]["data"]["recoveryHint"])
            public_and_persisted_surface = json.dumps(
                {
                    "operation": serialize_ai_operation(operation),
                    "message_content": message.content,
                    "message_parts": message.parts,
                    "message_artifacts": (message.message_metadata or {}).get("artifacts"),
                    "route_outcome": published["route_outcome"],
                },
                ensure_ascii=False,
                default=str,
            )
            self.assertNotIn(sentinel, public_and_persisted_surface)
            self.assertEqual(operation.error_message, "操作未能完成，请稍后重新生成草稿")

    def test_cancellation_wins_before_draft_or_business_write(self) -> None:
        request, run_id = self._seed_route(suffix="cancel")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.status = "cancelling"
            db.add(
                AIRunCancelRequest(
                    family_id=self.family.id,
                    run_id=run.id,
                    requested_by=self.user.id,
                    status="requested",
                    outcome_code="cancel_requested",
                )
            )
            db.commit()

        with self.assertRaises(AIExecutionCancelled):
            self._route(request)

        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)

    def test_continuation_is_always_manual_and_does_not_consume_attempt(self) -> None:
        request, run_id = self._seed_route(suffix="continuation")
        request = replace(request, continuation={"workflowId": "wf", "stepKey": "one"})

        outcome = self._route(request)

        self.assertEqual(outcome.status, "waiting_approval")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            assert run is not None and draft is not None
            self.assertFalse(run.auto_execution_attempted)
            self.assertIn("continuation_not_allowed", draft.policy_reason_codes)

    def test_route_rejects_intent_evidence_inside_committed_payload(self) -> None:
        request, _run_id = self._seed_route(suffix="embedded-evidence")
        request = replace(
            request,
            payload={**request.payload, "intentEvidence": request.intent_evidence_input},
        )

        with self.assertRaisesRegex(AIConflictError, "意图证据"):
            self._route(request)

        with self.SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)

    def test_malformed_draft_without_route_or_approval_keeps_guard(self) -> None:
        request, _run_id = self._seed_route(suffix="malformed")
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            result = SkillResult(
                text="",
                drafts=[
                    {
                        "draft_type": request.draft_type,
                        "payload": request.payload,
                        "schema_version": request.schema_version,
                        "draft_id": "missing-routed-draft",
                        "route_status": "auto_executed",
                    }
                ],
                status="completed",
            )

            with self.assertRaisesRegex(RuntimeError, "没有创建确认请求"):
                runner.orchestrator_node.next_state_resolver.resolve(
                    {
                        "family_id": request.family_id,
                        "user_id": request.actor_user_id,
                        "conversation_id": request.conversation_id,
                        "run_id": request.run_id,
                        "message": request.current_message,
                    },
                    result=result,
                    finish_graph_span=lambda *_args, **_kwargs: None,
                )

    def test_final_persister_never_recreates_approval_for_auto_draft(self) -> None:
        request, _run_id = self._seed_route(suffix="persister")
        outcome = self._route(request)
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            persisted = runner.assistant_result_persister.persist(
                {
                    "family_id": request.family_id,
                    "user_id": request.actor_user_id,
                    "conversation_id": request.conversation_id,
                    "run_id": request.run_id,
                    "message": request.current_message,
                },
                SkillResult(
                    text="已收藏。",
                    drafts=[
                        {
                            "draft_type": request.draft_type,
                            "payload": request.payload,
                            "schema_version": request.schema_version,
                            "draft_id": outcome.draft_id,
                            "operation_id": outcome.operation_id,
                        }
                    ],
                    status="completed",
                ),
                skill_key=None,
            )
            db.commit()
            self.assertEqual(persisted.status, "completed")
            self.assertEqual(persisted.approval_ids, [])
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)

    def test_final_persister_never_recreates_approval_for_no_change_draft(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            food.favorite = True
            db.commit()
        request, _run_id = self._seed_route(suffix="persister-no-change")
        outcome = self._route(request)

        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            persisted = runner.assistant_result_persister.persist(
                {
                    "family_id": request.family_id,
                    "user_id": request.actor_user_id,
                    "conversation_id": request.conversation_id,
                    "run_id": request.run_id,
                    "message": request.current_message,
                },
                SkillResult(
                    text="当前已经收藏。",
                    drafts=[
                        {
                            "draft_type": request.draft_type,
                            "payload": request.payload,
                            "schema_version": request.schema_version,
                            "draft_id": outcome.draft_id,
                        }
                    ],
                    status="completed",
                ),
                skill_key=None,
            )
            db.commit()

            self.assertEqual(persisted.status, "completed")
            self.assertEqual(persisted.approval_ids, [])
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)
            message = db.get(AIMessage, request.message_id)
            assert message is not None
            self.assertEqual(sum(part.get("type") == "result_card" for part in message.parts), 1)

    def test_full_runner_auto_route_finishes_without_pending_card(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            db.add(
                AIAutoExecutionPreference(
                    id="route-pref-full-runner",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    action_key="food.set_favorite",
                    enabled=True,
                    consent_notice_version=CONSENT_NOTICE_VERSION,
                    consented_at=utcnow(),
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.commit()
            provider = PolicyFavoriteProvider(base_updated_at=food.updated_at.isoformat())
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=provider))
            runner.skill_registry.get("food_profile").manifest.approval_policy = "draft_then_policy"
            runner.progressive_draft_publisher.registered_revert_adapters = REGISTERED_ADAPTERS

            response = runner.invoke_user_message(
                family_id=self.family.id,
                user_id=self.user.id,
                message="收藏这个",
                subject={"source": "food_page", "food_id": food.id},
            )
            db.commit()

            self.assertEqual(response["run"]["status"], "completed")
            self.assertEqual(response["included"]["approvals"], [])
            self.assertTrue(db.get(Food, food.id).favorite)
            self.assertFalse(
                any(part.get("type") in {"draft", "approval_request"} for part in response["message"]["parts"])
            )
            self.assertTrue(
                any(part.get("type") == "result_card" for part in response["message"]["parts"])
            )

    def test_policy_pending_retry_recovers_same_run_without_prompt_replay(self) -> None:
        request, run_id = self._seed_route(suffix="retry-auto")
        transient = OperationalError("UPDATE foods", {}, Exception(2006, "server has gone away"))
        with patch(
            "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
            side_effect=transient,
        ):
            outcome = self._route(request)
        self.assertEqual(outcome.status, "execution_failed")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            assert run is not None and draft is not None
            run.status = "failed"
            expected_hash = draft.payload_hash
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )
            db.commit()
            self.assertEqual(response["run"]["id"], run_id)
            self.assertEqual(db.get(AITaskDraft, draft.id).payload_hash, expected_hash)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)

    def test_policy_non_retryable_database_failure_is_terminal_and_never_replays_prompt(self) -> None:
        request, run_id = self._seed_route(suffix="non-retryable-terminal")
        sentinel = "PRIVATE-NON-RETRYABLE-SQL"
        non_retryable = OperationalError(
            f"SELECT {sentinel} FROM foods",
            {},
            Exception(1054, sentinel),
        )
        with patch(
            "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
            side_effect=non_retryable,
        ):
            try:
                outcome = self._route(request)
            except OperationalError as exc:
                self.fail(f"non-retryable OperationalError escaped auto routing: {exc.__class__.__name__}")

        self.assertEqual(outcome.status, "execution_failed")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            operation = db.get(AIOperation, outcome.operation_id)
            message = db.get(AIMessage, request.message_id)
            assert run is not None and draft is not None and operation is not None and message is not None
            self.assertEqual(draft.status, "execution_failed")
            self.assertEqual(operation.status, "failed")
            self.assertEqual(operation.error_code, "draft_commit_database_error")
            self.assertEqual(operation.error_message, "数据库写入失败，请稍后重试")
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)
            persisted_surface = json.dumps(
                {
                    "operation": serialize_ai_operation(operation),
                    "message_parts": message.parts,
                    "message_artifacts": (message.message_metadata or {}).get("artifacts"),
                    "projection": outcome.projection,
                },
                ensure_ascii=False,
                default=str,
            )
            self.assertNotIn(sentinel, persisted_surface)

            run.status = "failed"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )

            self.assertEqual(response["run"]["id"], run_id)
            self.assertEqual(response["message"]["id"], request.message_id)
            self.assertEqual(db.scalar(select(func.count(AIAgentRun.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)

    def test_duplicate_policy_retry_executes_domain_write_once(self) -> None:
        request, run_id = self._seed_route(suffix="retry-duplicate")
        transient = OperationalError("UPDATE foods", {}, Exception(2006, "server has gone away"))
        with patch(
            "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
            side_effect=transient,
        ):
            outcome = self._route(request)
        self.assertEqual(outcome.status, "execution_failed")

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.status = "failed"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with (
                patch.object(service, "chat", side_effect=AssertionError("provider replayed")),
                patch(
                    "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                    wraps=execute_ai_operation_draft,
                ) as execute,
            ):
                first = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )
                db.commit()
                second = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )
                db.commit()

            self.assertEqual(first["run"]["id"], run_id)
            self.assertEqual(second["run"]["id"], run_id)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)

    def test_retry_completed_operation_replays_persisted_result(self) -> None:
        request, run_id = self._seed_route(suffix="retry-completed")
        outcome = self._route(request)
        self.assertEqual(outcome.status, "auto_executed")

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.status = "completed"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )

            self.assertEqual(response["run"]["id"], run_id)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)

    def test_retry_reverted_operation_replays_persisted_result(self) -> None:
        request, run_id = self._seed_route(suffix="retry-reverted")
        outcome = self._route(request)
        self.assertEqual(outcome.status, "auto_executed")

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            operation = db.get(AIOperation, outcome.operation_id)
            assert run is not None and draft is not None and operation is not None
            run.status = "completed"
            draft.status = "reverted"
            operation.status = "reverted"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )

            self.assertEqual(response["run"]["id"], run_id)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 1)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)

    def test_retry_no_change_replays_persisted_result(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            food.favorite = True
            db.commit()
        request, run_id = self._seed_route(suffix="retry-no-change")
        outcome = self._route(request)
        self.assertEqual(outcome.status, "no_change")

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.status = "completed"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )

            self.assertEqual(response["run"]["id"], run_id)
            self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)
            self.assertEqual(db.scalar(select(func.count(AITaskDraft.id))), 1)

    def test_manual_pending_retry_retains_retry_approval_without_prompt_replay(self) -> None:
        request, run_id = self._seed_route(suffix="retry-manual")
        request = replace(request, skill_approval_policy="draft_then_confirm")
        outcome = self._route(request)
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            draft = db.get(AITaskDraft, outcome.draft_id)
            original = db.get(AIApprovalRequest, outcome.approval_id)
            assert run is not None and draft is not None and original is not None
            run.status = "failed"
            draft.status = "pending_retry"
            original.status = "approved"
            original.decision = "approved"
            retry = create_retry_ai_approval(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=request.conversation_id,
                message_id=request.message_id,
                run_id=run_id,
                draft=draft,
                values=original.initial_values,
                error_message="临时失败",
            )
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch.object(service, "chat", side_effect=AssertionError("provider replayed")):
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )
            self.assertEqual(response["run"]["id"], run_id)
            self.assertIn(retry.id, [item["id"] for item in response["included"]["approvals"]])

    def test_retry_without_draft_keeps_original_prompt_replay(self) -> None:
        request, run_id = self._seed_route(suffix="retry-prompt")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            run.status = "failed"
            db.commit()
            service = AIApplicationService(db, provider=FakeChatProvider())
            expected = {"run": {"id": "new-run"}}
            with patch.object(service, "chat", return_value=expected) as replay:
                response = service.retry_run(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    run_id=run_id,
                )
            self.assertEqual(response, expected)
            replay.assert_called_once()
