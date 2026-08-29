from __future__ import annotations

from queue import Queue

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select

from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workflows.runner_support.runtime_failure_persister import RuntimeFailurePersister
from app.ai.workflows.runner_support.stream_bridge import handle_stream_worker_exception
from app.models.domain import AIAgentRun, AIConversation, AIMessage, AIRunEvent

from ._support import *


class RuntimeFailurePersisterTestCase(AIAgentInfraTestCase):
    def _seed_message_with_operation_result(
        self,
        *,
        suffix: str,
        operation_status: str,
    ) -> tuple[str, str, str]:
        conversation_id = f"conversation-runtime-failure-{suffix}"
        run_id = f"run-runtime-failure-{suffix}"
        message_id = f"message-runtime-failure-{suffix}"
        now = utcnow().isoformat()
        card = {
            "id": f"operation-result:draft-runtime-failure-{suffix}",
            "type": "operation_result",
            "title": "已更新收藏状态",
            "data": {
                "draft_id": f"draft-runtime-failure-{suffix}",
                "operation_id": f"operation-runtime-failure-{suffix}",
                "result_status": "completed",
                "execution_mode": "manual_approval",
                "operation_status": operation_status,
                "execution_explanation": "已按你的确认执行。",
                "revert_availability": "unsupported",
                "revertible_until": None,
                "revert_blocked_code": None,
                "server_now": now,
                "entities": [{"id": "food-tomato", "label": "番茄小炒", "operation": "set_favorite"}],
                "cache_scopes": ["food", "ai_conversation"],
                "approvalId": f"approval-runtime-failure-{suffix}",
                "actionSummary": "已按你的确认执行。",
                "entityCount": 1,
                "entityCountLabel": "1 项内容",
                "workspaceLabel": "食物库",
                "workspaceHint": "可前往食物库查看",
            },
        }
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id=conversation_id,
                family_id=self.family.id,
                owner_user_id=self.user.id,
                visibility=AIConversationVisibility.PRIVATE,
                mode=AiMode.RECOMMENDATION,
                prompt="收藏番茄小炒",
                response="",
                context={"activeRunId": run_id, "workspace": True},
                last_run_status="running",
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id=run_id,
                family_id=self.family.id,
                conversation_id=conversation_id,
                message_id=message_id,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="food_profile",
                input_summary="收藏番茄小炒",
                context_summary={},
                output_summary="",
                status="running",
                model="test-model",
                input={"prompt": "收藏番茄小炒"},
                output={},
                tool_calls=[],
                error=None,
                created_by=self.user.id,
            )
            message = AIMessage(
                id=message_id,
                family_id=self.family.id,
                conversation_id=conversation_id,
                role="assistant",
                content="已按你的确认执行。",
                content_type="parts",
                parts=[{"id": f"result-part-{suffix}", "type": "result_card", "card": card}],
                run_id=run_id,
                status="running",
                message_metadata={"liveStreaming": True, "livePartIds": [f"result-part-{suffix}"]},
                created_by=self.user.id,
            )
            db.add_all([conversation, run, message])
            db.commit()
        return conversation_id, run_id, message_id

    def test_worker_exception_after_committed_operation_result_returns_success_response(self) -> None:
        conversation_id, run_id, message_id = self._seed_message_with_operation_result(
            suffix="success",
            operation_status="completed",
        )
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            emitted: list[tuple[str, dict]] = []
            handle_stream_worker_exception(
                runner,
                RuntimeError("provider disconnected after the write committed"),
                event_queue=Queue(),
                is_disconnected=lambda: False,
                on_worker_exception=lambda _runner, error: RuntimeFailurePersister(
                    db=db,
                    json_record=jsonable_encoder,
                ).mark_failed(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    error=error,
                ),
                perf_context={"conversation_id": conversation_id, "run_id": run_id},
                enqueue=lambda event, data: emitted.append((event, data)),
            )

            self.assertEqual([event for event, _data in emitted], ["response"])
            self.assertEqual(emitted[0][1]["run"]["status"], "completed")
            self.assertEqual(emitted[0][1]["message"]["status"], "completed")
            self.assertEqual(
                len(
                    [
                        part
                        for part in emitted[0][1]["message"]["parts"]
                        if part.get("type") == "result_card"
                    ]
                ),
                1,
            )

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            message = db.get(AIMessage, message_id)
            conversation = db.get(AIConversation, conversation_id)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            self.assertIsNotNone(conversation)
            assert run is not None and message is not None and conversation is not None
            self.assertEqual(run.status, "completed")
            self.assertIsNone(run.error)
            self.assertEqual(message.status, "completed")
            self.assertNotIn("liveStreaming", message.message_metadata or {})
            self.assertNotIn("livePartIds", message.message_metadata or {})
            self.assertEqual(conversation.last_run_status, "completed")
            self.assertNotIn("activeRunId", conversation.context or {})
            self.assertEqual(
                db.scalar(
                    select(AIRunEvent.id).where(
                        AIRunEvent.run_id == run_id,
                        AIRunEvent.type == "error",
                    )
                ),
                None,
            )

    def test_pending_operation_result_does_not_absorb_runtime_failure(self) -> None:
        conversation_id, run_id, _message_id = self._seed_message_with_operation_result(
            suffix="pending",
            operation_status="pending",
        )
        with self.SessionLocal() as db:
            persister = RuntimeFailurePersister(db=db, json_record=jsonable_encoder)
            self.assertFalse(
                persister.mark_failed(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    error=RuntimeError("provider disconnected before the write completed"),
                )
            )

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            message = db.scalar(
                select(AIMessage).where(AIMessage.run_id == run_id, AIMessage.role == "assistant")
            )
            conversation = db.get(AIConversation, conversation_id)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            self.assertIsNotNone(conversation)
            assert run is not None and message is not None and conversation is not None
            self.assertEqual(run.status, "failed")
            self.assertIn("provider disconnected", run.error or "")
            self.assertEqual(message.status, "failed")
            self.assertEqual(conversation.last_run_status, "failed")

    def test_provider_failed_result_after_approval_keeps_committed_operation_result(self) -> None:
        conversation_id, run_id, message_id = self._seed_message_with_operation_result(
            suffix="provider-result",
            operation_status="completed",
        )
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            persisted = runner.assistant_result_persister.persist(
                {
                    "family_id": self.family.id,
                    "user_id": self.user.id,
                    "conversation_id": conversation_id,
                    "run_id": run_id,
                    "message": "收藏番茄小炒",
                    "last_decision": {
                        "approval": {"id": "approval-runtime-failure-provider-result"},
                        "draft": {"id": "draft-runtime-failure-provider-result"},
                        "operation": {"id": "operation-runtime-failure-provider-result"},
                    },
                },
                SkillResult(
                    text="AI 工作台暂时无法完成这次请求，请稍后重试。",
                    status="failed",
                    error="provider unavailable",
                ),
                skill_key=None,
            )
            db.commit()

            self.assertEqual(persisted.status, "completed")
            self.assertEqual(persisted.card_count, 1)
            message = db.get(AIMessage, message_id)
            run = db.get(AIAgentRun, run_id)
            conversation = db.get(AIConversation, conversation_id)
            assert message is not None and run is not None and conversation is not None
            self.assertEqual(message.status, "completed")
            self.assertNotIn("AI 工作台暂时无法完成这次请求", message.content)
            self.assertEqual(run.status, "completed")
            self.assertIsNone(run.error)
            self.assertEqual(conversation.last_run_status, "completed")

    def test_provider_failed_result_with_unrelated_success_card_stays_failed(self) -> None:
        conversation_id, run_id, message_id = self._seed_message_with_operation_result(
            suffix="provider-result-mismatch",
            operation_status="completed",
        )
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            persisted = runner.assistant_result_persister.persist(
                {
                    "family_id": self.family.id,
                    "user_id": self.user.id,
                    "conversation_id": conversation_id,
                    "run_id": run_id,
                    "message": "删除另一条记录",
                    "last_decision": {
                        "approval": {"id": "approval-for-another-operation"},
                        "draft": {"id": "draft-for-another-operation"},
                        "operation": {"id": "operation-for-another-operation"},
                    },
                },
                SkillResult(
                    text="AI 工作台暂时无法完成这次请求，请稍后重试。",
                    status="failed",
                    error="provider unavailable",
                ),
                skill_key=None,
            )
            db.commit()

            self.assertEqual(persisted.status, "failed")
            message = db.get(AIMessage, message_id)
            run = db.get(AIAgentRun, run_id)
            assert message is not None and run is not None
            self.assertEqual(message.status, "failed")
            self.assertIn("AI 工作台暂时无法完成这次请求", message.content)
            self.assertEqual(run.status, "failed")
