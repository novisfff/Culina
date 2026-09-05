from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import Response
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from ._support import AIAgentInfraTestCase

from app.core.enums import AiMode
from app.models.domain import AIMessage, Food
from app.models.domain import AIConversation, Base, Family
from app.services.ai_auto_execution.policy_types import (
    AIOperationResultProjection,
    DraftExecutionReceipt,
)
from app.services.serializers import serialize_ai_message


PUBLIC_RESULT_FIELDS = {
    "draft_id",
    "operation_id",
    "result_status",
    "execution_mode",
    "operation_status",
    "execution_explanation",
    "revert_availability",
    "revertible_until",
    "revert_blocked_code",
    "server_now",
    "entities",
    "cache_scopes",
}

NOW = datetime(2026, 8, 24, 10, 0, tzinfo=UTC)


def _result_projection_module():
    from app.services.ai_operations import result_projection

    return result_projection


def _draft(*, status: str = "completed", execution_route: str = "policy_auto") -> SimpleNamespace:
    return SimpleNamespace(
        id="draft-result-1",
        status=status,
        execution_route=execution_route,
        draft_type="meal_plan",
        intent_evidence_json={"private": "intent_evidence_json"},
    )


def _operation(
    *,
    status: str = "completed",
    execution_mode: str = "policy_auto",
    revert_adapter_key: str | None = "meal_plan.v1",
    revert_context_json: dict | None = None,
    revertible_until: datetime | None = None,
    revert_blocked_code: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id="operation-result-1",
        status=status,
        execution_mode=execution_mode,
        error_code=None,
        revert_adapter_key=revert_adapter_key,
        revert_context_json=(
            {"private": "revert_context_json"}
            if revert_context_json is None and revert_adapter_key
            else revert_context_json
        ),
        revertible_until=revertible_until or (NOW + timedelta(hours=1)),
        revert_blocked_code=revert_blocked_code,
        authorization_snapshot_json={"private": "authorization_snapshot_json"},
        committed_payload_json={"private": "committed_payload_json"},
    )


def _projection(*, status: str = "completed", server_now: datetime = NOW) -> AIOperationResultProjection:
    return AIOperationResultProjection(
        draft_id="draft-result-1",
        operation_id="operation-result-1" if status != "no_change" else None,
        result_status=status,  # type: ignore[arg-type]
        execution_mode="policy_no_change" if status == "no_change" else "policy_auto",
        operation_status=None if status == "no_change" else status,  # type: ignore[arg-type]
        execution_explanation="测试结果",
        revert_availability=(
            "reverted" if status == "reverted" else "unsupported" if status in {"failed", "no_change"} else "available"
        ),
        revertible_until=None if status in {"failed", "no_change"} else NOW + timedelta(hours=1),
        revert_blocked_code=None,
        server_now=server_now,
        entities=({"id": "entity-1", "label": "番茄炒蛋"},) if status == "completed" else (),
        cache_scopes=("ai_conversation",) if status == "no_change" else ("meal_plan", "ai_conversation"),
    )


class _MessageSession:
    def __init__(self, message: AIMessage) -> None:
        # Result projection now deliberately uses the canonical timeline
        # service, which must lock and validate the conversation before it can
        # write a result-card event.  Keep this focused unit fixture backed by
        # a real SQLite session instead of weakening production code with a
        # fake-session compatibility path.
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            future=True,
        )
        Base.metadata.create_all(self.engine)
        self.session = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )()
        family = Family(id=message.family_id, name="结果投影测试家庭", motto="", location="")
        conversation = AIConversation(
            id=message.conversation_id,
            family_id=message.family_id,
            owner_user_id=None,
            mode=AiMode.RECOMMENDATION,
            prompt="结果投影测试",
            response="",
            context={},
            title="结果投影测试",
            summary="",
            status="active",
            created_by=None,
        )
        self.session.add_all([family, conversation, message])
        self.session.commit()
        self.message = message

    def __getattr__(self, name: str):  # noqa: ANN001
        return getattr(self.session, name)


class AIOperationResultProjectionTest(unittest.TestCase):
    def test_no_change_projection_has_no_operation_or_business_invalidation(self) -> None:
        module = _result_projection_module()
        projection = module.project_ai_operation_result(
            draft=_draft(status="no_change", execution_route="policy_no_change"),
            operation=None,
            entities=(),
            cache_scopes=("meal_plan", "ai_conversation"),
            server_now=NOW,
        )

        self.assertEqual(projection.result_status, "no_change")
        self.assertEqual(projection.execution_mode, "policy_no_change")
        self.assertIsNone(projection.operation_id)
        self.assertIsNone(projection.operation_status)
        self.assertEqual(projection.execution_explanation, "相关内容已经是你要求的状态。")
        self.assertEqual(projection.revert_availability, "unsupported")
        self.assertEqual(projection.cache_scopes, ("ai_conversation",))

    def test_public_projection_never_leaks_private_audit_payloads(self) -> None:
        module = _result_projection_module()
        projection = module.project_ai_operation_result(
            draft=_draft(),
            operation=_operation(),
            entities=({"id": "entity-1", "label": "番茄炒蛋"},),
            cache_scopes=("meal_plan", "ai_conversation"),
            server_now=NOW,
        )

        record = module.serialize_ai_operation_result_projection(projection)

        self.assertEqual(set(record), PUBLIC_RESULT_FIELDS)
        encoded = json.dumps(record, ensure_ascii=False)
        for secret_key in (
            "authorization_snapshot_json",
            "intent_evidence_json",
            "committed_payload_json",
            "revert_context_json",
        ):
            self.assertNotIn(secret_key, encoded)

    def test_manual_projection_uses_server_owned_explanation(self) -> None:
        module = _result_projection_module()
        projection = module.project_ai_operation_result(
            draft=_draft(execution_route="manual_confirmation"),
            operation=_operation(execution_mode="manual_approval"),
            entities=(),
            cache_scopes=("ai_conversation",),
            server_now=NOW,
        )

        self.assertEqual(projection.execution_mode, "manual_approval")
        self.assertEqual(projection.execution_explanation, "已按你的确认执行。")

    def test_policy_auto_projection_does_not_include_canned_assistant_explanation(self) -> None:
        module = _result_projection_module()
        projection = module.project_ai_operation_result(
            draft=_draft(execution_route="policy_auto"),
            operation=_operation(execution_mode="policy_auto"),
            entities=(),
            cache_scopes=("ai_conversation",),
            server_now=NOW,
        )

        self.assertEqual(projection.execution_mode, "policy_auto")
        self.assertEqual(projection.execution_explanation, "")
        card = module.build_operation_result_card(
            projection,
            title="已收藏食物",
            workspace_label="食物库",
        )
        self.assertEqual(card["data"]["actionSummary"], "已收藏食物")

    def test_completed_revert_availability_requires_adapter_context_and_live_deadline(self) -> None:
        module = _result_projection_module()
        cases = (
            (_operation(), NOW, "available"),
            (_operation(revert_context_json={}), NOW, "unsupported"),
            (_operation(revert_adapter_key=None), NOW, "unsupported"),
            (_operation(), NOW + timedelta(hours=1, microseconds=1), "expired"),
            (_operation(revert_blocked_code="target_changed"), NOW, "blocked"),
        )

        for operation, response_now, expected in cases:
            with self.subTest(expected=expected):
                projection = module.project_ai_operation_result(
                    draft=_draft(),
                    operation=operation,
                    entities=(),
                    cache_scopes=("meal_plan",),
                    server_now=response_now,
                )
                self.assertEqual(projection.revert_availability, expected)

    def test_pending_failed_and_reverted_operations_have_safe_terminal_mapping(self) -> None:
        module = _result_projection_module()
        cases = (
            ("pending", "completed", "pending", "unsupported"),
            ("failed", "failed", "failed", "unsupported"),
            ("reverted", "reverted", "reverted", "reverted"),
        )

        for operation_status, result_status, public_status, availability in cases:
            with self.subTest(operation_status=operation_status):
                projection = module.project_ai_operation_result(
                    draft=_draft(),
                    operation=_operation(status=operation_status),
                    entities=(),
                    cache_scopes=("ai_conversation",),
                    server_now=NOW,
                )
                self.assertEqual(projection.result_status, result_status)
                self.assertEqual(projection.operation_status, public_status)
                self.assertEqual(projection.revert_availability, availability)

    def test_legacy_succeeded_operation_status_reads_as_canonical_completed(self) -> None:
        module = _result_projection_module()
        projection = module.project_ai_operation_result(
            draft=_draft(),
            operation=_operation(status="succeeded"),
            entities=(),
            cache_scopes=("ai_conversation",),
            server_now=NOW,
        )

        self.assertEqual(projection.result_status, "completed")
        self.assertEqual(projection.operation_status, "completed")

    def test_unknown_operation_status_fails_closed(self) -> None:
        module = _result_projection_module()

        with self.assertRaisesRegex(ValueError, "操作状态"):
            module.project_ai_operation_result(
                draft=_draft(),
                operation=_operation(status="mystery"),
                entities=(),
                cache_scopes=("ai_conversation",),
                server_now=NOW,
            )

    def test_all_routes_share_draft_keyed_card_and_artifact_identity(self) -> None:
        module = _result_projection_module()

        for status in ("completed", "no_change", "failed", "reverted"):
            with self.subTest(status=status):
                projection = _projection(status=status)
                card = module.build_operation_result_card(
                    projection,
                    title="操作结果",
                    workspace_label="菜单计划",
                )
                artifacts = module.operation_result_artifacts(projection, card=card)
                self.assertEqual(card["id"], "operation-result:draft-result-1")
                self.assertEqual(card["data"]["draft_id"], "draft-result-1")
                self.assertEqual(card["data"]["result_status"], status)
                self.assertEqual(artifacts[0]["id"], "ai_operation_result:draft-result-1")
                self.assertEqual(artifacts[0]["payload"], card)

    def test_result_part_is_replaced_in_place_on_terminal_state_change(self) -> None:
        module = _result_projection_module()
        message = AIMessage(
            id="message-result",
            family_id="family-1",
            conversation_id="conversation-1",
            role="assistant",
            content="",
            parts=[
                {"id": "approval-part", "type": "approval_request", "approval": {"id": "approval-1"}},
            ],
            message_metadata={"artifacts": []},
        )
        session = _MessageSession(message)

        first_projection = _projection(status="completed")
        first_card = module.build_operation_result_card(first_projection, title="已执行", workspace_label="菜单计划")
        first_artifacts = module.operation_result_artifacts(first_projection, card=first_card)
        first = module.upsert_message_operation_result(
            session,
            message_id=message.id,
            projection=first_projection,
            card=first_card,
            artifacts=first_artifacts,
            approval_id="approval-1",
        )
        second_projection = _projection(status="reverted")
        second_card = module.build_operation_result_card(second_projection, title="已撤销", workspace_label="菜单计划")
        second_artifacts = module.operation_result_artifacts(second_projection, card=second_card)
        second = module.upsert_message_operation_result(
            session,
            message_id=message.id,
            projection=second_projection,
            card=second_card,
            artifacts=second_artifacts,
            approval_id="approval-1",
        )

        matching = [
            part
            for part in message.parts
            if part.get("type") == "result_card"
            and part.get("card", {}).get("data", {}).get("draft_id") == "draft-result-1"
        ]
        result_artifacts = [
            item
            for item in message.message_metadata["artifacts"]
            if item.get("id") == "ai_operation_result:draft-result-1"
        ]
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(second["id"], "operation-result-part:draft-result-1")
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["card"]["data"]["result_status"], "reverted")
        self.assertEqual(len(result_artifacts), 1)
        self.assertEqual(result_artifacts[0]["status"], "reverted")

    def test_new_manual_result_appends_to_the_canonical_timeline(self) -> None:
        module = _result_projection_module()
        message = AIMessage(
            id="message-result-order",
            family_id="family-1",
            conversation_id="conversation-1",
            role="assistant",
            content="",
            parts=[
                {"id": "before", "type": "text", "text": "请确认"},
                {"id": "approval-part", "type": "approval_request", "approval": {"id": "approval-1"}},
                {"id": "after", "type": "text", "text": "稍后继续"},
            ],
            message_metadata={},
        )
        projection = _projection()
        card = module.build_operation_result_card(projection, title="已执行", workspace_label="菜单计划")

        module.upsert_message_operation_result(
            _MessageSession(message),
            message_id=message.id,
            projection=projection,
            card=card,
            artifacts=module.operation_result_artifacts(projection, card=card),
            approval_id="approval-1",
        )

        self.assertEqual([part["id"] for part in message.parts], [
            "before",
            "approval-part",
            "after",
            "operation-result-part:draft-result-1",
        ])

    def test_message_rehydration_uses_fresh_response_clock_without_mutating_storage(self) -> None:
        module = _result_projection_module()
        from app.services.serializers import serialize_ai_message

        persisted_projection = _projection(server_now=NOW)
        card = module.build_operation_result_card(
            persisted_projection,
            title="已执行",
            workspace_label="菜单计划",
        )
        persisted_part = {
            "id": "operation-result-part:draft-result-1",
            "type": "result_card",
            "card": card,
        }
        persisted_artifact = module.operation_result_artifacts(persisted_projection, card=card)[0]
        message = AIMessage(
            id="message-hydrate",
            family_id="family-1",
            conversation_id="conversation-1",
            role="assistant",
            content="",
            parts=[persisted_part],
            message_metadata={"artifacts": [persisted_artifact]},
        )
        stored_parts = copy.deepcopy(message.parts)
        stored_metadata = copy.deepcopy(message.message_metadata)
        response_now = NOW + timedelta(minutes=30)

        response = serialize_ai_message(message, response_now=response_now)

        expected_now = "2026-08-24T10:30:00+00:00"
        self.assertEqual(response["parts"][0]["card"]["data"]["server_now"], expected_now)
        self.assertEqual(
            response["metadata"]["artifacts"][0]["payload"]["data"]["server_now"],
            expected_now,
        )
        self.assertEqual(message.parts, stored_parts)
        self.assertEqual(message.message_metadata, stored_metadata)

    def test_legacy_operation_result_card_is_upgraded_to_public_projection(self) -> None:
        message = AIMessage(
            id="message-legacy-operation-result",
            family_id="family-1",
            conversation_id="conversation-1",
            role="assistant",
            content="",
            parts=[
                {
                    "id": "legacy-result",
                    "type": "result_card",
                    "card": {
                        "id": "operation-result:legacy-draft",
                        "type": "operation_result",
                        "title": "已创建食物",
                        "data": {
                            "actionSummary": "已创建食物",
                            "entityCount": 1,
                            "workspaceLabel": "食物",
                            "entities": [
                                {
                                    "id": "food-legacy",
                                    "label": "番茄炒蛋",
                                    "operation": "create",
                                    "operationLabel": "已创建",
                                    "updatedAt": "2026-08-24T10:00:00Z",
                                }
                            ],
                            "approvalId": "approval-legacy",
                            "operationId": "operation-legacy",
                            "draftId": "legacy-draft",
                        },
                    },
                }
            ],
            message_metadata={},
        )

        response = serialize_ai_message(message, response_now=NOW)
        data = response["parts"][0]["card"]["data"]
        self.assertEqual(data["draft_id"], "legacy-draft")
        self.assertEqual(data["operation_id"], "operation-legacy")
        self.assertEqual(data["result_status"], "completed")
        self.assertEqual(data["execution_mode"], "manual_approval")
        self.assertEqual(data["operation_status"], "completed")
        self.assertEqual(data["revert_availability"], "unsupported")
        self.assertEqual(data["entities"][0]["id"], "food-legacy")

    def test_delayed_hydration_expires_response_copy_without_mutating_storage(self) -> None:
        module = _result_projection_module()
        projection = _projection(server_now=NOW)
        card = module.build_operation_result_card(projection, title="已执行", workspace_label="菜单计划")
        part = {"id": "result", "type": "result_card", "card": card}

        hydrated = module.hydrate_operation_result_server_now(
            part,
            NOW + timedelta(hours=1, microseconds=1),
        )

        self.assertEqual(
            hydrated["card"]["data"]["server_now"],
            "2026-08-24T11:00:00.000001+00:00",
        )
        self.assertEqual(hydrated["card"]["data"]["revert_availability"], "expired")
        self.assertEqual(part["card"]["data"]["revert_availability"], "available")
        self.assertEqual(part["card"]["data"]["server_now"], "2026-08-24T10:00:00+00:00")

    def test_list_messages_captures_one_response_clock_for_the_whole_batch(self) -> None:
        from app.api import ai as ai_api

        captured: list[datetime | None] = []

        def serialize(item, *, response_now=None):  # noqa: ANN001
            captured.append(response_now)
            return {"id": item.id, "parts": [], "metadata": {}}

        class MessageSession:
            def scalar(self, statement):  # noqa: ANN001
                del statement
                return SimpleNamespace(id="conversation-1", timeline_version=0)

            def scalars(self, statement):  # noqa: ANN001
                del statement
                return [
                    SimpleNamespace(
                        id="message-1",
                        conversation_id="conversation-1",
                        role="assistant",
                        content="",
                        content_type="parts",
                        parts=[],
                        run_id=None,
                        status="completed",
                        message_metadata={},
                        client_message_id=None,
                        created_at=NOW,
                        timeline_position=1,
                        snapshot_sequence=1,
                    ),
                    SimpleNamespace(
                        id="message-2",
                        conversation_id="conversation-1",
                        role="assistant",
                        content="",
                        content_type="parts",
                        parts=[],
                        run_id=None,
                        status="completed",
                        message_metadata={},
                        client_message_id=None,
                        created_at=NOW,
                        timeline_position=2,
                        snapshot_sequence=2,
                    ),
                ]

        with (
            patch.object(ai_api, "require_ai_conversation_access"),
            patch.object(ai_api, "serialize_ai_message", side_effect=serialize),
            patch.object(ai_api, "project_ai_message", side_effect=lambda item, _capabilities: item),
            patch.object(ai_api, "rehydrate_media_access", side_effect=lambda _db, **kwargs: kwargs["payload"]),
            patch.object(ai_api, "set_ai_client_aware_headers"),
        ):
            ai_api.list_ai_messages(
                "conversation-1",
                Response(),
                auth=(SimpleNamespace(id="user-1"), SimpleNamespace(family_id="family-1")),
                db=MessageSession(),  # type: ignore[arg-type]
                capabilities=SimpleNamespace(),  # type: ignore[arg-type]
            )

        self.assertEqual(len(captured), 2)
        self.assertIsNotNone(captured[0])
        self.assertIs(captured[0], captured[1])

    def test_active_stream_message_part_is_response_hydrated_without_mutating_storage(self) -> None:
        from app.ai.workflows.runner_support.progressive_draft_publisher import ProgressiveDraftPublisher

        module = _result_projection_module()
        projection = _projection(server_now=NOW)
        card = module.build_operation_result_card(projection, title="已执行", workspace_label="菜单计划")
        stored_part = {
            "id": "operation-result-part:draft-result-1",
            "type": "result_card",
            "card": card,
        }
        original = copy.deepcopy(stored_part)
        events: list[dict] = []
        publisher = object.__new__(ProgressiveDraftPublisher)
        publisher.optional_stream_writer = lambda: object()
        publisher.persistent_progress_writer = lambda _writer, _state: events.append
        response_now = NOW + timedelta(minutes=30)

        with patch(
            "app.ai.workflows.runner_support.progressive_draft_publisher.utcnow",
            return_value=response_now,
            create=True,
        ):
            publisher._emit_parts(
                {"conversation_id": "conversation-1", "run_id": "run-1"},
                message_id="message-1",
                parts=(stored_part,),
            )

        self.assertEqual([event["event"] for event in events], ["message_part"])
        self.assertEqual(events[0]["data"]["message_id"], "message-1")
        self.assertEqual(events[0]["data"]["conversation_id"], "conversation-1")
        self.assertEqual(events[0]["data"]["run_id"], "run-1")
        self.assertEqual(
            events[0]["data"]["part"]["card"]["data"]["server_now"],
            "2026-08-24T10:30:00+00:00",
        )
        self.assertEqual(stored_part, original)

    def test_approval_response_schema_exposes_persisted_result_contract(self) -> None:
        from app.schemas.ai import AIApprovalDecisionResponse

        self.assertIn("operation_result", AIApprovalDecisionResponse.model_fields)
        self.assertIn("result_part", AIApprovalDecisionResponse.model_fields)
        self.assertIn("artifacts", AIApprovalDecisionResponse.model_fields)
        self.assertIn("cache_scopes", AIApprovalDecisionResponse.model_fields)

    def test_approval_post_returns_post_commit_hydrated_result_without_sse_enqueue(self) -> None:
        from app.api import ai as ai_api

        module = _result_projection_module()
        projection = _projection(server_now=NOW)
        card = module.build_operation_result_card(projection, title="已执行", workspace_label="菜单计划")
        part = {
            "id": "operation-result-part:draft-result-1",
            "type": "result_card",
            "card": card,
        }
        result = {
            "approval": {"id": "approval-1"},
            "draft": {"id": "draft-result-1"},
            "operation": {"id": "operation-result-1"},
            "business_entity": None,
            "operation_result": module.serialize_ai_operation_result_projection(projection),
            "result_part": part,
            "artifacts": list(module.operation_result_artifacts(projection, card=card)),
            "cache_scopes": ["meal_plan", "ai_conversation"],
        }
        call_order: list[str] = []
        response_now = NOW + timedelta(minutes=30)

        class Service:
            def __init__(self, _db) -> None:  # noqa: ANN001
                pass

            def decide_approval(self, **_kwargs):  # noqa: ANN003
                return result

        with (
            patch.object(ai_api, "AIApplicationService", Service),
            patch.object(ai_api, "commit_session", side_effect=lambda _db: call_order.append("commit")),
            patch.object(
                ai_api,
                "utcnow",
                side_effect=lambda: (call_order.append("clock"), response_now)[1],
            ),
            patch.object(ai_api, "project_ai_decision_response", side_effect=lambda item, _capabilities: item),
            patch.object(ai_api, "rehydrate_media_access", side_effect=lambda _db, **kwargs: kwargs["payload"]),
            patch.object(ai_api, "set_ai_client_aware_headers"),
        ):
            response = ai_api.decide_ai_approval(
                "conversation-1",
                "approval-1",
                SimpleNamespace(
                    decision="approved",
                    draft_version=1,
                    values={},
                    comment=None,
                ),
                Response(),
                auth=(SimpleNamespace(id="user-1"), SimpleNamespace(family_id="family-1")),
                db=object(),  # type: ignore[arg-type]
                capabilities=SimpleNamespace(values=frozenset()),  # type: ignore[arg-type]
            )

        self.assertEqual(call_order, ["commit", "clock"])
        self.assertEqual(
            response["operation_result"]["server_now"],
            "2026-08-24T10:30:00+00:00",
        )
        self.assertEqual(
            response["result_part"]["card"]["data"]["server_now"],
            "2026-08-24T10:30:00+00:00",
        )
        self.assertEqual(response["cache_scopes"], ["meal_plan", "ai_conversation"])


class AIOperationResultPublicBoundaryTest(AIAgentInfraTestCase):
    def _favorite_payload(self, db) -> dict:  # noqa: ANN001
        food = db.get(Food, "food-tomato")
        assert food is not None
        return {
            "draftType": "food_profile",
            "schemaVersion": "food_profile_operation.v1",
            "action": "set_favorite",
            "targetId": food.id,
            "baseUpdatedAt": food.updated_at.isoformat(),
            "before": {"favorite": bool(food.favorite)},
            "payload": {"favorite": not bool(food.favorite)},
        }

    def _assert_only_public_artifact(self, artifacts: list[dict], *, draft_id: str) -> None:
        self.assertEqual(len(artifacts), 1)
        artifact = artifacts[0]
        self.assertEqual(artifact["id"], f"ai_operation_result:{draft_id}")
        self.assertEqual(artifact["type"], "ai_operation_result")
        self.assertEqual(artifact["kind"], "operation_result")
        self.assertEqual(
            set(artifact),
            {
                "id",
                "type",
                "kind",
                "version",
                "status",
                "sourceDraftId",
                "sourceOperationId",
                "payload",
            },
        )

    def test_manual_success_exposes_only_public_result_artifact_but_keeps_internal_facts(self) -> None:
        sentinel = "PRIVATE-RECEIPT-NOTES-SENTINEL"
        with self.SessionLocal() as db:
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="task9-public-artifact-success",
            )
            food = db.get(Food, "food-tomato")
            assert food is not None
            receipt = DraftExecutionReceipt(
                business_entity={
                    "id": food.id,
                    "name": food.name,
                    "notes": sentinel,
                    "_operation": "update",
                },
                entity_ids=(food.id,),
                cache_scopes=("food", "ai_conversation"),
            )
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                return_value=receipt,
            ):
                result = self._approve_ai_approval_for_test(
                    service,
                    draft=draft,
                    approval=approval,
                )

            message = db.get(AIMessage, draft.message_id)
            assert message is not None
            response_artifacts = [item for item in result["artifacts"] if isinstance(item, dict)]
            metadata_artifacts = [
                item
                for item in (message.message_metadata or {}).get("artifacts") or []
                if isinstance(item, dict)
            ]
            serialized = serialize_ai_message(message, response_now=NOW)
            serialized_artifacts = [
                item
                for item in serialized["metadata"].get("artifacts") or []
                if isinstance(item, dict)
            ]

            self._assert_only_public_artifact(response_artifacts, draft_id=draft.id)
            self._assert_only_public_artifact(metadata_artifacts, draft_id=draft.id)
            self._assert_only_public_artifact(serialized_artifacts, draft_id=draft.id)
            public_surface = json.dumps(
                {
                    "http_artifacts": response_artifacts,
                    "message_metadata": metadata_artifacts,
                    "serialized_message": serialized,
                },
                ensure_ascii=False,
                default=str,
            )
            self.assertNotIn(sentinel, public_surface)
            for private_key in (
                "authorization_snapshot_json",
                "intent_evidence_json",
                "committed_payload_json",
                "revert_context_json",
            ):
                self.assertNotIn(private_key, public_surface)

            internal_artifacts = service._approval_decision_artifacts(result)
            self.assertTrue(any(item.get("type") == "approval_decision" for item in internal_artifacts))
            self.assertTrue(any(item.get("kind") == "business_entity" for item in internal_artifacts))
            self.assertIn(sentinel, json.dumps(internal_artifacts, ensure_ascii=False, default=str))

    def test_manual_failure_exposes_only_safe_result_artifact(self) -> None:
        sentinel = "PRIVATE-RAW-DOMAIN-FAILURE-SENTINEL"
        with self.SessionLocal() as db:
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="task9-public-artifact-failure",
            )
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=RuntimeError(sentinel),
            ):
                result = self._approve_ai_approval_for_test(
                    service,
                    draft=draft,
                    approval=approval,
                )

            message = db.get(AIMessage, draft.message_id)
            assert message is not None
            response_artifacts = [item for item in result["artifacts"] if isinstance(item, dict)]
            metadata_artifacts = [
                item
                for item in (message.message_metadata or {}).get("artifacts") or []
                if isinstance(item, dict)
            ]
            serialized = serialize_ai_message(message, response_now=NOW)
            serialized_artifacts = [
                item
                for item in serialized["metadata"].get("artifacts") or []
                if isinstance(item, dict)
            ]

            self._assert_only_public_artifact(response_artifacts, draft_id=draft.id)
            self._assert_only_public_artifact(metadata_artifacts, draft_id=draft.id)
            self._assert_only_public_artifact(serialized_artifacts, draft_id=draft.id)
            public_surface = json.dumps(
                {
                    "http_artifacts": response_artifacts,
                    "message_metadata": metadata_artifacts,
                    "serialized_message": serialized,
                },
                ensure_ascii=False,
                default=str,
            )
            self.assertNotIn(sentinel, public_surface)
            self.assertNotIn("RuntimeError", public_surface)


if __name__ == "__main__":
    unittest.main()
