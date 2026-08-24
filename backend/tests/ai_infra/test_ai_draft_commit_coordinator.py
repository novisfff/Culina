from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
import tempfile
import threading
import time
from unittest.mock import patch

from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from ._support import AIAgentInfraTestCase, FakeChatProvider

from app.ai.errors import AIConflictError
from app.ai.workspace_service import AIApplicationService
from app.core.enums import AiMode, FoodType, MembershipStatus, UserRole
from app.core.utils import utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIAutoExecutionPreference,
    AIMessage,
    AIOperation,
    AIRunCancelRequest,
    AITaskDraft,
    AIUserApproval,
    Base,
    Family,
    Food,
    Membership,
    User,
    AIConversation,
)
from app.services.ai_auto_execution.policy_types import (
    DraftCommitRequest,
    DraftExecutionReceipt,
)
from app.services.ai_auto_execution.settings import resolve_effective_authorization
from app.services.ai_operations.commit_coordinator import (
    DraftCommitCoordinator,
    derive_draft_operation_idempotency_key,
    derive_draft_payload_hash,
)


class AIDraftCommitCoordinatorTestCase(AIAgentInfraTestCase):
    def _favorite_payload(self, db, *, favorite: bool = True) -> dict:
        food = db.get(Food, "food-tomato")
        assert food is not None
        return {
            "draftType": "food_profile",
            "schemaVersion": "food_profile_operation.v1",
            "action": "set_favorite",
            "targetId": food.id,
            "baseUpdatedAt": food.updated_at.isoformat(),
            "before": {"favorite": bool(food.favorite)},
            "payload": {"favorite": favorite},
        }

    def _seed_policy_draft(self, db, *, suffix: str) -> tuple[AIAgentRun, AITaskDraft, DraftCommitRequest]:
        now = utcnow()
        preference = db.scalar(
            select(AIAutoExecutionPreference).where(
                AIAutoExecutionPreference.family_id == self.family.id,
                AIAutoExecutionPreference.user_id == self.user.id,
                AIAutoExecutionPreference.action_key == "food.set_favorite",
            )
        )
        if preference is None:
            preference = AIAutoExecutionPreference(
                id=f"auto-pref-{suffix}",
                family_id=self.family.id,
                user_id=self.user.id,
                action_key="food.set_favorite",
                enabled=True,
                consent_notice_version="auto-execution-consent.v1",
                consented_at=now,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(preference)
            db.flush()
        service = AIApplicationService(db, provider=FakeChatProvider())
        conversation = service._get_or_create_conversation(
            family_id=self.family.id,
            user_id=self.user.id,
            conversation_id=None,
            prompt=f"自动收藏 {suffix}",
            quick_task=None,
        )
        message = AIMessage(
            id=f"ai-message-commit-{suffix}",
            family_id=self.family.id,
            conversation_id=conversation.id,
            role="assistant",
            content="",
            parts=[],
            status="running",
            created_by=self.user.id,
        )
        run = AIAgentRun(
            id=f"agent-run-commit-{suffix}",
            family_id=self.family.id,
            conversation_id=conversation.id,
            message_id=message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="food_profile",
            input_summary="自动收藏",
            context_summary={"runMetrics": {}},
            output_summary="",
            status="running",
            model="fake-model",
            input={},
            output={},
            tool_calls=[],
            auto_execution_attempted=True,
            created_by=self.user.id,
        )
        message.run_id = run.id
        payload = self._favorite_payload(db)
        draft = AITaskDraft(
            id=f"ai-draft-commit-{suffix}",
            family_id=self.family.id,
            conversation_id=conversation.id,
            source_run_id=run.id,
            message_id=message.id,
            draft_type="food_profile",
            payload=payload,
            preview_summary="收藏食物",
            status="pending",
            version=3,
            schema_version="food_profile_operation.v1",
            validation_errors=[],
            ai_metadata={},
            intent_clarity="explicit_complete",
            intent_evidence_json={
                "normalized_evidence": {},
                "verified_fields": ["action", "targetId", "payload.favorite"],
                "verified_values": {
                    "action": "set_favorite:true",
                    "targetId": payload["targetId"],
                    "payload.favorite": True,
                },
                "reason_codes": [],
            },
            payload_hash=derive_draft_payload_hash(payload),
            execution_route="policy_auto",
            policy_key="food.set_favorite",
            policy_version="food.set_favorite.v1",
            policy_reason_codes=[],
            policy_evaluated_at=now,
            idempotency_key=f"draft-capture-{suffix}",
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add_all((message, run, draft))
        db.flush()
        authorization = resolve_effective_authorization(
            db,
            family_id=self.family.id,
            actor_user_id=self.user.id,
            action_key="food.set_favorite",
            policy_version="food.set_favorite.v1",
            for_update=True,
        )
        request = DraftCommitRequest(
            family_id=self.family.id,
            actor_user_id=self.user.id,
            conversation_id=conversation.id,
            run_id=run.id,
            draft_id=draft.id,
            draft_version=draft.version,
            committed_payload=payload,
            execution_mode="policy_auto",
            authorization_source="member_preference",
            authorization_snapshot=dict(authorization.snapshot),
            approval_request_id=None,
            policy_key="food.set_favorite",
            policy_version="food.set_favorite.v1",
            policy_reason_codes=(),
            committed_at=now,
        )
        db.commit()
        return run, draft, request

    def _fake_receipt(self, *, entity_id: str = "food-tomato") -> DraftExecutionReceipt:
        return DraftExecutionReceipt(
            business_entity={"id": entity_id, "name": "番茄小炒", "favorite": True},
            entity_ids=(entity_id,),
            cache_scopes=("food", "ai_conversation"),
            revert_adapter_key="food.favorite.v1",
            revert_context={"foodId": entity_id, "before": {"favorite": False}},
        )

    def _seed_transient_retry(self, db, *, suffix: str):
        run, draft, request = self._seed_policy_draft(db, suffix=suffix)
        run = db.get(AIAgentRun, run.id)
        draft = db.get(AITaskDraft, draft.id)
        assert run is not None and draft is not None
        transient = OperationalError("UPDATE foods", {}, Exception(2006, "server has gone away"))
        with patch(
            "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
            side_effect=transient,
        ):
            DraftCommitCoordinator.commit_locked(
                db,
                request=request,
                locked_run=run,
                locked_draft=draft,
            )
        db.commit()
        run = db.get(AIAgentRun, run.id)
        draft = db.get(AITaskDraft, draft.id)
        assert run is not None and draft is not None
        return run, draft, request

    def test_hash_and_operation_key_are_canonical_and_versioned(self) -> None:
        self.assertEqual(
            derive_draft_payload_hash({"b": 2, "a": "番茄"}),
            derive_draft_payload_hash({"a": "番茄", "b": 2}),
        )
        self.assertEqual(
            derive_draft_operation_idempotency_key("draft-1", 3),
            derive_draft_operation_idempotency_key("draft-1", 3),
        )
        self.assertNotEqual(
            derive_draft_operation_idempotency_key("draft-1", 3),
            derive_draft_operation_idempotency_key("draft-1", 4),
        )

    def test_locked_draft_identity_is_rejected_before_any_operation_write(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="locked-identity")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
            ) as execute:
                with self.assertRaisesRegex(AIConflictError, "锁定草稿"):
                    DraftCommitCoordinator.commit_locked(
                        db,
                        request=replace(request, draft_id="different-draft"),
                        locked_run=run,
                        locked_draft=draft,
                    )
                execute.assert_not_called()
            self.assertEqual(db.scalar(select(func.count()).select_from(AIOperation)), 0)

    def test_missing_actor_is_rejected_before_any_operation_write(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="missing-actor")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
            ) as execute:
                with self.assertRaisesRegex(AIConflictError, "执行人"):
                    DraftCommitCoordinator.commit_locked(
                        db,
                        request=replace(request, actor_user_id=""),
                        locked_run=run,
                        locked_draft=draft,
                    )
                execute.assert_not_called()
            self.assertEqual(db.scalar(select(func.count()).select_from(AIOperation)), 0)

    def test_manual_approval_delegates_to_shared_coordinator(self) -> None:
        with self.SessionLocal() as db:
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="commit-manual",
            )
            with patch.object(
                DraftCommitCoordinator,
                "commit_locked",
                wraps=DraftCommitCoordinator.commit_locked,
            ) as commit:
                result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            self.assertEqual(commit.call_count, 1)
            request = commit.call_args.kwargs["request"]
            self.assertEqual(request.execution_mode, "manual_approval")
            self.assertEqual(request.authorization_source, "approval_request")
            self.assertEqual(request.actor_user_id, self.user.id)
            self.assertEqual(result["approval"]["status"], "approved")
            operation = db.get(AIOperation, result["operation"]["id"])
            assert operation is not None
            self.assertEqual(operation.actor_user_id, self.user.id)
            self.assertEqual(
                operation.idempotency_key,
                derive_draft_operation_idempotency_key(draft.id, draft.version),
            )

    def test_manual_domain_failure_keeps_immutable_approval_and_one_retry(self) -> None:
        with self.SessionLocal() as db:
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="commit-manual-failure",
            )
            original_approval_id = approval.id
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=RuntimeError("domain failed"),
            ):
                result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            original = db.get(AIApprovalRequest, original_approval_id)
            assert original is not None
            self.assertEqual(original.status, "approved")
            self.assertEqual(original.decision, "approved")
            self.assertEqual(result["approval"]["status"], "pending")
            self.assertTrue(result["approval"]["approval_type"].endswith(".retry"))
            self.assertEqual(result["draft"]["status"], "pending_retry")
            self.assertEqual(result["operation"]["status"], "failed")
            self.assertNotIn("调整草稿", result["approval"]["instruction"])
            self.assertEqual(
                db.scalar(
                    select(func.count()).select_from(AIUserApproval).where(
                        AIUserApproval.approval_request_id == original_approval_id
                    )
                ),
                1,
            )

    def test_non_retryable_operational_error_is_not_persisted_as_pending_retry(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="non-retryable-db")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            non_retryable = OperationalError(
                "SELECT missing_column FROM foods",
                {},
                Exception(1054, "Unknown column 'missing_column'"),
            )
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=non_retryable,
            ):
                with self.assertRaises(OperationalError):
                    DraftCommitCoordinator.commit_locked(
                        db,
                        request=request,
                        locked_run=run,
                        locked_draft=draft,
                    )
            self.assertEqual(draft.status, "pending")
            self.assertEqual(db.scalar(select(func.count()).select_from(AIOperation)), 0)

    def test_full_rollback_relock_does_not_overwrite_a_resolved_approval(self) -> None:
        with self.SessionLocal() as db:
            _service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="resolved-during-relock",
            )
            approval.status = "rejected"
            approval.decision = "rejected"
            db.commit()
            request = DraftCommitRequest(
                family_id=self.family.id,
                actor_user_id=self.user.id,
                conversation_id=draft.conversation_id,
                run_id=approval.run_id,
                draft_id=draft.id,
                draft_version=draft.version,
                committed_payload=dict(draft.payload),
                execution_mode="manual_approval",
                authorization_source="approval_request",
                authorization_snapshot={"approval_request_id": approval.id},
                approval_request_id=approval.id,
                policy_key=None,
                policy_version=None,
                policy_reason_codes=(),
                committed_at=utcnow(),
            )
            with self.assertRaisesRegex(AIConflictError, "已处理"):
                DraftCommitCoordinator._relock_after_full_rollback(db, request=request)

    def test_manual_post_execute_failure_keeps_approval_and_rolls_back_domain_write(self) -> None:
        with self.SessionLocal() as db:
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="food_profile",
                payload=self._favorite_payload(db),
                suffix="commit-manual-post-execute-failure",
            )
            original_approval_id = approval.id
            with patch(
                "app.services.ai_operations.commit_coordinator.classify_approval_highlight",
                side_effect=RuntimeError("revert preparation failed"),
            ):
                result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            original = db.get(AIApprovalRequest, original_approval_id)
            food = db.get(Food, "food-tomato")
            assert original is not None and food is not None
            self.assertEqual(original.status, "approved")
            self.assertFalse(food.favorite)
            self.assertEqual(result["draft"]["status"], "pending_retry")
            self.assertEqual(result["operation"]["error_code"], "draft_commit_domain_failed")
            self.assertEqual(
                db.scalar(
                    select(func.count()).select_from(AIApprovalRequest).where(
                        AIApprovalRequest.draft_id == draft.id,
                        AIApprovalRequest.approval_type.like("%.retry"),
                    )
                ),
                1,
            )

    def test_same_draft_version_is_committed_once_and_replays_result(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="same-version")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                return_value=self._fake_receipt(),
            ) as execute:
                first = DraftCommitCoordinator.commit_locked(
                    db,
                    request=request,
                    locked_run=run,
                    locked_draft=draft,
                )
                second = DraftCommitCoordinator.commit_locked(
                    db,
                    request=request,
                    locked_run=run,
                    locked_draft=draft,
                )

            self.assertEqual(second.operation_id, first.operation_id)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(
                db.scalar(select(func.count()).select_from(AIOperation).where(AIOperation.draft_id == draft.id)),
                1,
            )
            operation = db.get(AIOperation, first.operation_id)
            assert operation is not None
            self.assertEqual(operation.status, "succeeded")
            self.assertEqual(operation.committed_payload_json, request.committed_payload)
            self.assertEqual(operation.revert_adapter_key, "food.favorite.v1")
            self.assertEqual(
                operation.revertible_until.replace(tzinfo=request.committed_at.tzinfo),
                request.committed_at + timedelta(hours=1),
            )
            message = db.get(AIMessage, draft.message_id)
            assert message is not None
            self.assertEqual(sum(part.get("type") == "result_card" for part in message.parts), 1)

    def test_policy_transient_failure_retries_same_operation_once(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="transient")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            transient = OperationalError(
                "UPDATE foods",
                {},
                Exception(1213, "Deadlock found when trying to get lock"),
            )
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=transient,
            ):
                failed = DraftCommitCoordinator.commit_locked(
                    db,
                    request=request,
                    locked_run=run,
                    locked_draft=draft,
                )
            failed_operation = db.get(AIOperation, failed.operation_id)
            assert failed_operation is not None
            self.assertEqual(failed_operation.error_code, "draft_commit_transient_database_error")
            self.assertEqual(draft.status, "pending_retry")
            db.commit()

            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                return_value=self._fake_receipt(),
            ) as execute:
                recovered = DraftCommitCoordinator.retry_pending_locked(
                    db,
                    family_id=self.family.id,
                    actor_user_id=self.user.id,
                    locked_run=run,
                    locked_draft=draft,
                    expected_payload_hash=request.committed_payload
                    and derive_draft_payload_hash(request.committed_payload),
                    now=utcnow(),
                )

            self.assertEqual(recovered.operation_id, failed.operation_id)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(db.get(AIOperation, recovered.operation_id).status, "succeeded")
            self.assertEqual(draft.status, "executed")
            self.assertEqual(
                db.scalar(select(func.count()).select_from(AIApprovalRequest).where(AIApprovalRequest.draft_id == draft.id)),
                0,
            )

    def test_policy_retry_rejects_changed_payload_and_version_before_executor(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="retry-mismatch")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            transient = OperationalError("UPDATE foods", {}, Exception(2006, "server has gone away"))
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=transient,
            ):
                DraftCommitCoordinator.commit_locked(
                    db,
                    request=request,
                    locked_run=run,
                    locked_draft=draft,
                )
            db.commit()

            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
            ) as execute:
                with self.assertRaisesRegex(AIConflictError, "载荷"):
                    DraftCommitCoordinator.retry_pending_locked(
                        db,
                        family_id=self.family.id,
                        actor_user_id=self.user.id,
                        locked_run=run,
                        locked_draft=draft,
                        expected_payload_hash=derive_draft_payload_hash({"changed": True}),
                        now=utcnow(),
                    )
                execute.assert_not_called()

                draft.version += 1
                with self.assertRaisesRegex(AIConflictError, "版本"):
                    DraftCommitCoordinator.retry_pending_locked(
                        db,
                        family_id=self.family.id,
                        actor_user_id=self.user.id,
                        locked_run=run,
                        locked_draft=draft,
                        expected_payload_hash=request.committed_payload
                        and derive_draft_payload_hash(request.committed_payload),
                        now=utcnow(),
                    )
                execute.assert_not_called()

    def test_policy_domain_conflict_is_terminal_and_never_creates_approval(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_policy_draft(db, suffix="domain-conflict")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=AIConflictError("target stale"),
            ):
                result = DraftCommitCoordinator.commit_locked(
                    db,
                    request=request,
                    locked_run=run,
                    locked_draft=draft,
                )

            operation = db.get(AIOperation, result.operation_id)
            assert operation is not None
            self.assertEqual(operation.error_code, "draft_commit_domain_conflict")
            self.assertEqual(operation.status, "failed")
            self.assertEqual(draft.status, "execution_failed")
            self.assertEqual(db.scalar(select(func.count()).select_from(AIApprovalRequest)), 0)

    def test_policy_retry_rechecks_original_actor_membership_authorization_target_and_attempt(self) -> None:
        scenarios = ("actor", "membership", "authorization", "target", "attempt")
        for scenario in scenarios:
            with self.subTest(scenario=scenario), self.SessionLocal() as db:
                run, draft, request = self._seed_transient_retry(db, suffix=f"gate-{scenario}")
                actor_user_id = self.user.id
                if scenario == "actor":
                    actor_user_id = "different-user"
                elif scenario == "membership":
                    membership = db.get(Membership, self.membership.id)
                    assert membership is not None
                    membership.status = MembershipStatus.INVITED
                    db.flush()
                elif scenario == "authorization":
                    preference = db.scalar(
                        select(AIAutoExecutionPreference).where(
                            AIAutoExecutionPreference.family_id == self.family.id,
                            AIAutoExecutionPreference.user_id == self.user.id,
                            AIAutoExecutionPreference.action_key == "food.set_favorite",
                        )
                    )
                    assert preference is not None
                    preference.enabled = False
                    db.flush()
                elif scenario == "target":
                    food = db.get(Food, "food-tomato")
                    assert food is not None
                    food.updated_at = utcnow() + timedelta(seconds=1)
                    db.flush()
                elif scenario == "attempt":
                    run.auto_execution_attempted = False
                    db.flush()
                with patch(
                    "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
                ) as execute:
                    with self.assertRaises(AIConflictError):
                        DraftCommitCoordinator.retry_pending_locked(
                            db,
                            family_id=self.family.id,
                            actor_user_id=actor_user_id,
                            locked_run=run,
                            locked_draft=draft,
                            expected_payload_hash=request.committed_payload
                            and derive_draft_payload_hash(request.committed_payload),
                            now=utcnow(),
                        )
                    execute.assert_not_called()

    def test_policy_retry_rechecks_cancellation_before_executor(self) -> None:
        with self.SessionLocal() as db:
            run, draft, request = self._seed_transient_retry(db, suffix="gate-cancel")
            db.add(
                AIRunCancelRequest(
                    id="cancel-request-commit-retry",
                    family_id=self.family.id,
                    run_id=run.id,
                    requested_by=self.user.id,
                    status="requested",
                    outcome_code="cancel_requested",
                    requested_at=utcnow(),
                )
            )
            db.flush()
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
            ) as execute:
                with self.assertRaisesRegex(AIConflictError, "取消"):
                    DraftCommitCoordinator.retry_pending_locked(
                        db,
                        family_id=self.family.id,
                        actor_user_id=self.user.id,
                        locked_run=run,
                        locked_draft=draft,
                        expected_payload_hash=request.committed_payload
                        and derive_draft_payload_hash(request.committed_payload),
                        now=utcnow(),
                    )
                execute.assert_not_called()

    def test_manual_pending_retry_is_not_owned_by_policy_retry(self) -> None:
        with self.SessionLocal() as db:
            run, draft, _request = self._seed_policy_draft(db, suffix="manual-retry-rejected")
            run = db.get(AIAgentRun, run.id)
            draft = db.get(AITaskDraft, draft.id)
            assert run is not None and draft is not None
            draft.execution_route = "manual_confirmation"
            draft.status = "pending_retry"
            db.flush()
            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft"
            ) as execute:
                with self.assertRaisesRegex(AIConflictError, "人工"):
                    DraftCommitCoordinator.retry_pending_locked(
                        db,
                        family_id=self.family.id,
                        actor_user_id=self.user.id,
                        locked_run=run,
                        locked_draft=draft,
                        expected_payload_hash=draft.payload_hash,
                        now=utcnow(),
                    )
                execute.assert_not_called()

    def test_concurrent_policy_recovery_executes_once_and_replays_one_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "commit-coordinator.sqlite3"
            engine = create_engine(
                f"sqlite+pysqlite:///{database_path}",
                connect_args={"check_same_thread": False, "timeout": 10},
                future=True,
            )
            Base.metadata.create_all(engine)
            sessions = sessionmaker(bind=engine, expire_on_commit=False, future=True, class_=Session)
            now = utcnow()
            with sessions() as db:
                family = Family(id="family-concurrent-retry", name="并发恢复家庭", motto="", location="")
                actor = User(
                    id="user-concurrent-retry",
                    username="concurrent-retry",
                    display_name="并发恢复用户",
                    avatar_seed="",
                    is_active=True,
                )
                membership = Membership(
                    id="membership-concurrent-retry",
                    family_id=family.id,
                    user_id=actor.id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                )
                conversation = AIConversation(
                    id="conversation-concurrent-retry",
                    family_id=family.id,
                    owner_user_id=actor.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="收藏并发恢复食物",
                    response="",
                    context={"workspace": True},
                    title="并发恢复",
                    summary="",
                    status="active",
                    created_by=actor.id,
                )
                message = AIMessage(
                    id="message-concurrent-retry",
                    family_id=family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    parts=[],
                    run_id="run-concurrent-retry",
                    status="running",
                    created_by=actor.id,
                )
                run = AIAgentRun(
                    id="run-concurrent-retry",
                    family_id=family.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="food_profile",
                    input_summary="收藏并发恢复食物",
                    context_summary={"runMetrics": {}},
                    output_summary="",
                    status="running",
                    model="fake-model",
                    input={},
                    output={},
                    tool_calls=[],
                    auto_execution_attempted=True,
                    created_by=actor.id,
                )
                food = Food(
                    id="food-concurrent-retry",
                    family_id=family.id,
                    name="并发恢复食物",
                    type=FoodType.READY_MADE,
                    category="测试",
                    favorite=False,
                    created_by=actor.id,
                    updated_by=actor.id,
                )
                preference = AIAutoExecutionPreference(
                    id="preference-concurrent-retry",
                    family_id=family.id,
                    user_id=actor.id,
                    action_key="food.set_favorite",
                    enabled=True,
                    consent_notice_version="auto-execution-consent.v1",
                    consented_at=now,
                    created_by=actor.id,
                    updated_by=actor.id,
                )
                db.add_all((family, actor, membership, conversation, message, run, food, preference))
                db.flush()
                payload = {
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile_operation.v1",
                    "action": "set_favorite",
                    "targetId": food.id,
                    "baseUpdatedAt": food.updated_at.isoformat(),
                    "before": {"favorite": False},
                    "payload": {"favorite": True},
                }
                draft = AITaskDraft(
                    id="draft-concurrent-retry",
                    family_id=family.id,
                    conversation_id=conversation.id,
                    source_run_id=run.id,
                    message_id=message.id,
                    draft_type="food_profile",
                    payload=payload,
                    preview_summary="收藏食物",
                    status="pending_retry",
                    version=3,
                    schema_version="food_profile_operation.v1",
                    validation_errors=[],
                    ai_metadata={},
                    intent_clarity="explicit_complete",
                    intent_evidence_json={
                        "normalized_evidence": {},
                        "verified_fields": ["action", "targetId", "payload.favorite"],
                        "verified_values": {
                            "action": "set_favorite:true",
                            "targetId": food.id,
                            "payload.favorite": True,
                        },
                        "reason_codes": [],
                    },
                    payload_hash=derive_draft_payload_hash(payload),
                    execution_route="policy_auto",
                    policy_key="food.set_favorite",
                    policy_version="food.set_favorite.v1",
                    policy_reason_codes=[],
                    policy_evaluated_at=now,
                    idempotency_key="draft-capture-concurrent-retry",
                    created_by=actor.id,
                    updated_by=actor.id,
                )
                db.add(draft)
                db.flush()
                authorization = resolve_effective_authorization(
                    db,
                    family_id=family.id,
                    actor_user_id=actor.id,
                    action_key="food.set_favorite",
                    policy_version="food.set_favorite.v1",
                )
                operation = AIOperation(
                    id="operation-concurrent-retry",
                    family_id=family.id,
                    draft_id=draft.id,
                    run_id=run.id,
                    actor_user_id=actor.id,
                    operation_type="food.favorite",
                    status="failed",
                    execution_mode="policy_auto",
                    authorization_source="member_preference",
                    authorization_snapshot_json=dict(authorization.snapshot),
                    policy_key="food.set_favorite",
                    policy_version="food.set_favorite.v1",
                    policy_reason_codes=[],
                    committed_payload_json=payload,
                    business_entity_type="Food",
                    business_entity_ids=[],
                    idempotency_key=derive_draft_operation_idempotency_key(draft.id, draft.version),
                    error_code="draft_commit_transient_database_error",
                    error_message="temporary",
                    failed_at=now,
                )
                db.add(operation)
                run.auto_operation_id = operation.id
                db.commit()

            calls = 0
            calls_lock = threading.Lock()
            start = threading.Barrier(2)

            def execute_once(*_args, **_kwargs):
                nonlocal calls
                with calls_lock:
                    calls += 1
                time.sleep(0.15)
                return DraftExecutionReceipt(
                    business_entity={"id": "food-concurrent-retry", "name": "并发恢复食物"},
                    entity_ids=("food-concurrent-retry",),
                    cache_scopes=("food", "ai_conversation"),
                    revert_adapter_key="food.favorite.v1",
                    revert_context={"foodId": "food-concurrent-retry", "before": {"favorite": False}},
                )

            def recover() -> str:
                with sessions() as db:
                    run = db.get(AIAgentRun, "run-concurrent-retry")
                    draft = db.get(AITaskDraft, "draft-concurrent-retry")
                    assert run is not None and draft is not None
                    start.wait(timeout=5)
                    result = DraftCommitCoordinator.retry_pending_locked(
                        db,
                        family_id="family-concurrent-retry",
                        actor_user_id="user-concurrent-retry",
                        locked_run=run,
                        locked_draft=draft,
                        expected_payload_hash=draft.payload_hash,
                        now=utcnow(),
                    )
                    db.commit()
                    return result.operation_id

            with patch(
                "app.services.ai_operations.commit_coordinator.execute_ai_operation_draft",
                side_effect=execute_once,
            ):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    operation_ids = list(pool.map(lambda _index: recover(), range(2)))

            self.assertEqual(operation_ids, ["operation-concurrent-retry", "operation-concurrent-retry"])
            self.assertEqual(calls, 1)
            with sessions() as db:
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(AIOperation).where(
                        AIOperation.draft_id == "draft-concurrent-retry"
                    )),
                    1,
                )
                self.assertEqual(db.get(AIOperation, "operation-concurrent-retry").status, "succeeded")
            engine.dispose()
