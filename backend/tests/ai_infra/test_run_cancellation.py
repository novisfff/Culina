from __future__ import annotations

from app.ai.workflows import conversations
from app.ai.workflows.runner_support import run_status
from app.models import domain

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
