from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator

import pytest
from sqlalchemy.orm import Session

from app.ai.workflows.runner_support.approval_resume_handler import ApprovalOutcome, ApprovalResumeHandler
from app.core.enums import InventoryOperationType
from app.models.domain import AIAgentRun, AIOperation, AITaskDraft, FoodPlanItem
from app.services.ai_operations.commit_coordinator import DraftCommitCoordinator, derive_draft_payload_hash
from app.services.serializers import serialize_ai_operation
from tests.model_usage.test_migration_mysql import (
    MySqlAlembicDatabase,
    require_model_usage_mysql_url,
)


LEGACY_PAYLOAD_HASH = hashlib.sha256(
    b'{"action":"set_favorite","foodId":"legacy-food"}'
).hexdigest()


@pytest.fixture()
def mysql_alembic_database() -> Iterator[MySqlAlembicDatabase]:
    database = MySqlAlembicDatabase.from_test_url(require_model_usage_mysql_url())
    database.recreate()
    try:
        yield database
    finally:
        database.dispose()


def test_models_expose_auto_execution_and_revert_columns() -> None:
    assert "intent_clarity" in AITaskDraft.__table__.c
    assert "intent_evidence_json" in AITaskDraft.__table__.c
    assert "payload_hash" in AITaskDraft.__table__.c
    assert "auto_execution_attempted" in AIAgentRun.__table__.c
    assert AIOperation.__table__.c.approval_request_id.nullable
    assert "revertible_until" in AIOperation.__table__.c
    assert "row_version" in FoodPlanItem.__table__.c
    assert "consume" in {item.value for item in InventoryOperationType}
    assert "dispose" in {item.value for item in InventoryOperationType}


def seed_legacy_ai_rows(database: MySqlAlembicDatabase) -> None:
    database.execute(
        """
        INSERT INTO families (
            id, name, motto, location, food_preferences, food_avoidances, created_at, updated_at
        ) VALUES (
            'legacy-family', '迁移家庭', '', '', JSON_ARRAY(), JSON_ARRAY(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
        )
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO users (
            id, username, display_name, avatar_seed, is_active, created_at, updated_at
        ) VALUES
            ('legacy-latest-approver', 'legacy-latest-approver', '最新批准人', '', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
            ('legacy-old-approver', 'legacy-old-approver', '旧批准人', '', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
            ('legacy-approval-editor', 'legacy-approval-editor', '审批编辑人', '', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
            ('legacy-draft-creator', 'legacy-draft-creator', '草稿创建人', '', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_conversations (
            id, family_id, owner_user_id, visibility, mode, prompt, response, context,
            title, summary, status, last_run_status, created_at, created_by
        ) VALUES (
            'legacy-conversation', 'legacy-family', 'legacy-draft-creator', 'PRIVATE', 'FOOD_QA', '', '', JSON_OBJECT(),
            '', '', 'active', '', UTC_TIMESTAMP(), 'legacy-draft-creator'
        )
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_task_drafts (
            id, family_id, conversation_id, draft_type, payload, preview_summary, status,
            version, schema_version, validation_errors, ai_metadata, idempotency_key,
            created_at, updated_at, created_by
        ) VALUES
            ('legacy-draft-executed', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'confirmed', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-executed-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator'),
            ('legacy-draft-no-change', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'confirmed', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-no-change-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator'),
            ('legacy-draft-reverted', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'confirmed', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-reverted-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator'),
            ('legacy-draft-failed', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'confirmation_failed', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-failed-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator'),
            ('legacy-draft-pending', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'pending', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-pending-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator'),
            ('legacy-draft-expired', 'legacy-family', 'legacy-conversation', 'food',
             JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
             'rejected', 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-expired-key',
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-draft-creator')
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_approval_requests (
            id, family_id, conversation_id, draft_id, draft_version, draft_schema_version,
            approval_type, status, request_payload, field_schema, initial_values, submitted_values,
            created_at, updated_at, updated_by
        ) VALUES
            ('legacy-approval-primary', 'legacy-family', 'legacy-conversation', 'legacy-draft-executed', 1, 'food.v1',
             'food', 'approved', JSON_OBJECT(), JSON_ARRAY(), JSON_OBJECT(), JSON_OBJECT(),
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-approval-editor'),
            ('legacy-approval-fallback', 'legacy-family', 'legacy-conversation', 'legacy-draft-no-change', 1, 'food.v1',
             'food', 'approved', JSON_OBJECT(), JSON_ARRAY(), JSON_OBJECT(), JSON_OBJECT(),
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-approval-editor'),
            ('legacy-approval-draft', 'legacy-family', 'legacy-conversation', 'legacy-draft-reverted', 1, 'food.v1',
             'food', 'approved', JSON_OBJECT(), JSON_ARRAY(), JSON_OBJECT(), JSON_OBJECT(),
             UTC_TIMESTAMP(), UTC_TIMESTAMP(), NULL)
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_user_approvals (
            id, family_id, approval_request_id, draft_id, approved_by, approved_at, decision,
            approval_payload, operation_summary
        ) VALUES
            ('legacy-user-approval-old', 'legacy-family', 'legacy-approval-primary', 'legacy-draft-executed',
             'legacy-old-approver', UTC_TIMESTAMP(), 'approved', JSON_OBJECT(), JSON_OBJECT()),
            ('legacy-user-approval-latest', 'legacy-family', 'legacy-approval-primary', 'legacy-draft-executed',
             'legacy-latest-approver', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 SECOND), 'approved', JSON_OBJECT(), JSON_OBJECT())
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_operations (
            id, family_id, approval_request_id, draft_id, operation_type, status,
            business_entity_type, business_entity_ids, idempotency_key, created_at, updated_at
        ) VALUES
            ('legacy-operation-pending', 'legacy-family', 'legacy-approval-primary', 'legacy-draft-executed', 'food',
             'running', '', JSON_ARRAY(), 'legacy-operation-pending-key', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
            ('legacy-operation-completed', 'legacy-family', 'legacy-approval-fallback', 'legacy-draft-no-change', 'food',
             'succeeded', '', JSON_ARRAY(), 'legacy-operation-completed-key', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
            ('legacy-operation-reverted', 'legacy-family', 'legacy-approval-draft', 'legacy-draft-reverted', 'food',
             'succeeded', '', JSON_ARRAY(), 'legacy-operation-reverted-key', UTC_TIMESTAMP(), UTC_TIMESTAMP())
        """,
        {},
    )


def test_ai_auto_execution_migration_backfills_and_round_trips(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("6a7b8c9d0e1f")
    seed_legacy_ai_rows(database)

    database.upgrade("7b8c9d0e1f2a")

    assert database.rows(
        "SELECT id, status, execution_route, payload_hash FROM ai_task_drafts ORDER BY id"
    ) == [
        ("legacy-draft-executed", "executed", "manual_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-expired", "rejected", "manual_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-failed", "execution_failed", "manual_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-no-change", "executed", "manual_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-pending", "pending_confirmation", "manual_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-reverted", "executed", "manual_confirmation", LEGACY_PAYLOAD_HASH),
    ]
    assert database.rows(
        "SELECT id, status, execution_mode, authorization_source, actor_user_id "
        "FROM ai_operations ORDER BY id"
    ) == [
        ("legacy-operation-completed", "completed", "manual_approval", "approval_request", "legacy-approval-editor"),
        ("legacy-operation-pending", "pending", "manual_approval", "approval_request", "legacy-latest-approver"),
        ("legacy-operation-reverted", "completed", "manual_approval", "approval_request", "legacy-draft-creator"),
    ]
    assert database.scalar(
        "SELECT IS_NULLABLE FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_operations' "
        "AND COLUMN_NAME = 'approval_request_id'"
    ) == "YES"
    assert database.scalar(
        "SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS "
        "WHERE CONSTRAINT_SCHEMA = DATABASE() "
        "AND CONSTRAINT_NAME = 'fk_ai_operations_approval_request_id_ai_approval_requests'"
    ) == "SET NULL"
    assert database.scalar("SELECT COUNT(*) FROM ai_auto_execution_preferences") == 0
    assert database.scalar("SELECT COUNT(*) FROM ai_family_auto_execution_policies") == 0

    database.execute(
        "UPDATE ai_task_drafts SET status = 'no_change' WHERE id = 'legacy-draft-no-change'",
        {},
    )
    database.execute(
        "UPDATE ai_task_drafts SET status = 'reverted' WHERE id = 'legacy-draft-reverted'",
        {},
    )
    database.execute(
        "UPDATE ai_task_drafts SET status = 'expired' WHERE id = 'legacy-draft-expired'",
        {},
    )
    database.execute(
        "UPDATE ai_operations SET status = 'reverted' WHERE id = 'legacy-operation-reverted'",
        {},
    )

    database.downgrade("6a7b8c9d0e1f")
    assert database.rows("SELECT id, status FROM ai_task_drafts ORDER BY id") == [
        ("legacy-draft-executed", "confirmed"),
        ("legacy-draft-expired", "rejected"),
        ("legacy-draft-failed", "confirmation_failed"),
        ("legacy-draft-no-change", "confirmed"),
        ("legacy-draft-pending", "pending"),
        ("legacy-draft-reverted", "confirmed"),
    ]
    assert database.rows("SELECT id, status FROM ai_operations ORDER BY id") == [
        ("legacy-operation-completed", "succeeded"),
        ("legacy-operation-pending", "running"),
        ("legacy-operation-reverted", "succeeded"),
    ]

    database.upgrade("7b8c9d0e1f2a")
    assert database.current_revision() == "7b8c9d0e1f2a"
    assert database.rows(
        "SELECT id, status, payload_hash FROM ai_task_drafts ORDER BY id"
    ) == [
        ("legacy-draft-executed", "executed", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-expired", "rejected", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-failed", "execution_failed", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-no-change", "executed", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-pending", "pending_confirmation", LEGACY_PAYLOAD_HASH),
        ("legacy-draft-reverted", "executed", LEGACY_PAYLOAD_HASH),
    ]
    assert database.rows("SELECT id, status FROM ai_operations ORDER BY id") == [
        ("legacy-operation-completed", "completed"),
        ("legacy-operation-pending", "pending"),
        ("legacy-operation-reverted", "completed"),
    ]


def test_migrated_completed_operation_replays_and_resumes_as_approved(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    """An upgraded legacy row follows the completed/replay runtime path."""

    database = mysql_alembic_database
    database.upgrade("6a7b8c9d0e1f")
    seed_legacy_ai_rows(database)
    database.upgrade("7b8c9d0e1f2a")

    payload = {
        "draftType": "food_profile",
        "schemaVersion": "food_profile_operation.v1",
        "action": "set_favorite",
        "targetId": "legacy-food",
        "baseUpdatedAt": "2026-08-24T10:00:00+00:00",
        "before": {"favorite": False},
        "payload": {"favorite": True},
    }
    database.execute(
        """
        UPDATE ai_task_drafts
        SET draft_type='food_profile', schema_version='food_profile_operation.v1',
            status='executed', payload=:payload, payload_hash=:payload_hash
        WHERE id='legacy-draft-no-change'
        """,
        {
            "payload": json.dumps(payload, ensure_ascii=False),
            "payload_hash": derive_draft_payload_hash(payload),
        },
    )
    database.execute(
        """
        UPDATE ai_operations
        SET operation_type='food.favorite', execution_mode='manual_approval',
            authorization_source='approval_request', actor_user_id='legacy-approval-editor',
            committed_payload_json=:payload, result_json=:result_json,
            business_entity_type='Food', business_entity_ids=JSON_ARRAY('legacy-food'),
            completed_at=UTC_TIMESTAMP()
        WHERE id='legacy-operation-completed'
        """,
        {
            "payload": json.dumps(payload, ensure_ascii=False),
            "result_json": json.dumps(
                {
                    "business_entity": {"id": "legacy-food", "name": "迁移食物"},
                    "entity_ids": ["legacy-food"],
                    "cache_scopes": ["food", "ai_conversation"],
                    "revert_adapter_key": None,
                    "revert_context": None,
                },
                ensure_ascii=False,
            ),
        },
    )

    with Session(database.engine, expire_on_commit=False) as db:
        operation = db.get(AIOperation, "legacy-operation-completed")
        draft = db.get(AITaskDraft, "legacy-draft-no-change")
        assert operation is not None and draft is not None
        assert operation.status == "completed"

        serialized = serialize_ai_operation(operation)
        assert serialized["status"] == "completed"
        assert (
            ApprovalResumeHandler._outcome(
                payload={"decision": "approved"},
                next_approval=None,
                operation=serialized,
            )
            == ApprovalOutcome.APPROVED_AND_CONTINUE
        )

        replay = DraftCommitCoordinator._replay_result(db, operation=operation, draft=draft)
        assert replay.projection is not None
        assert replay.projection.result_status == "completed"
        assert replay.projection.operation_status == "completed"
        db.rollback()
