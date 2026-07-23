from __future__ import annotations

from app.ai.workflows import conversations
from app.ai.workflows.runner_support import run_status
from app.models import domain
from app.models.domain import AIRunCancelRequest

from ._support import *


class AIRunCancellationTestCase(AIAgentInfraTestCase):
    def test_cancelling_is_an_active_run_status(self) -> None:
        cancelling = getattr(run_status, "CANCELLING", None)
        active_run_statuses = getattr(run_status, "ACTIVE_RUN_STATUSES", set())

        self.assertEqual(cancelling, "cancelling")
        self.assertIn(cancelling, active_run_statuses)
        self.assertIn(cancelling, conversations.ACTIVE_CONVERSATION_RUN_STATUSES)

    def test_cancel_request_model_supports_pre_run_idempotency(self) -> None:
        model = getattr(domain, "AIRunCancelRequest", None)

        self.assertIsNotNone(model)
        table = model.__table__
        self.assertNotIn("run_id", {column.name for foreign_key in table.foreign_key_constraints for column in foreign_key.columns})
        self.assertTrue(
            any(
                constraint.name == "uq_ai_run_cancel_requests_family_run"
                for constraint in table.constraints
            )
        )

    def test_cancel_before_run_exists_returns_202_and_replays_one_request(self) -> None:
        first = self.client.post("/api/ai/runs/agent_run-before-create/cancel")
        second = self.client.post("/api/ai/runs/agent_run-before-create/cancel")

        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(first.json()["request"]["run_id"], "agent_run-before-create")
        self.assertEqual(second.json()["request"]["requested_at"], first.json()["request"]["requested_at"])
        with self.SessionLocal() as db:
            count = db.scalar(
                select(func.count(AIRunCancelRequest.id)).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == "agent_run-before-create",
                )
            )
        self.assertEqual(count, 1)

    def test_cancel_completed_run_returns_structured_409(self) -> None:
        run = self._seed_visibility_run(
            "agent_run-completed-cancel-test",
            owner_user_id=self.user.id,
            visibility=AIConversationVisibility.PRIVATE,
        )

        response = self.client.post(f"/api/ai/runs/{run.id}/cancel")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "run_not_cancellable")
        self.assertEqual(response.json()["detail"]["run_status"], "completed")
        self.assertEqual(response.json()["detail"]["recovery_hint"], "refresh")

    def test_replaying_terminal_run_cancellation_preserves_resolution_time(self) -> None:
        run = self._seed_visibility_run(
            "agent_run-completed-cancel-replay-test",
            owner_user_id=self.user.id,
            visibility=AIConversationVisibility.PRIVATE,
        )

        first = self.client.post(f"/api/ai/runs/{run.id}/cancel")
        self.assertEqual(first.status_code, 409, first.text)
        with self.SessionLocal() as db:
            first_resolved_at = db.scalar(
                select(AIRunCancelRequest.resolved_at).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == run.id,
                )
            )

        second = self.client.post(f"/api/ai/runs/{run.id}/cancel")
        self.assertEqual(second.status_code, 409, second.text)
        with self.SessionLocal() as db:
            replayed = db.scalar(
                select(AIRunCancelRequest).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == run.id,
                )
            )

        self.assertIsNotNone(first_resolved_at)
        self.assertEqual(replayed.resolved_at, first_resolved_at)

    def test_get_cancellation_returns_persisted_pre_run_request(self) -> None:
        run_id = "agent_run-cancellation-status"
        created = self.client.post(f"/api/ai/runs/{run_id}/cancel")
        self.assertEqual(created.status_code, 202, created.text)

        response = self.client.get(f"/api/ai/runs/{run_id}/cancellation")

        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["outcome"], "cancel_requested")
        self.assertEqual(response.json()["request"]["run_id"], run_id)
        self.assertIsNone(response.json()["run"])

    def test_cross_family_run_cancel_returns_404_without_creating_request(self) -> None:
        with self.SessionLocal() as db:
            run = AIAgentRun(
                id="agent_run-other-family-cancel-test",
                family_id=self.other_family.id,
                conversation_id=None,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="其他家庭任务",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={},
                output={},
                tool_calls=[],
                created_by=self.user.id,
            )
            db.add(run)
            db.commit()

        response = self.client.post(f"/api/ai/runs/{run.id}/cancel")

        self.assertEqual(response.status_code, 404, response.text)
        with self.SessionLocal() as db:
            request_count = db.scalar(
                select(func.count(AIRunCancelRequest.id)).where(
                    AIRunCancelRequest.run_id == run.id,
                )
            )
        self.assertEqual(request_count, 0)

    def test_cancel_internal_failure_keeps_durable_request(self) -> None:
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(
            AIApplicationService,
            "apply_run_cancellation",
            side_effect=RuntimeError("cancel apply failed"),
        ):
            response = client.post("/api/ai/runs/agent_run-apply-failure/cancel")

        self.assertEqual(response.status_code, 500, response.text)
        with self.SessionLocal() as db:
            request = db.scalar(
                select(AIRunCancelRequest).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == "agent_run-apply-failure",
                )
            )
        self.assertIsNotNone(request)
        self.assertEqual(request.status, "requested")
