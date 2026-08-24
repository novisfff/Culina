from __future__ import annotations

from collections.abc import Iterator

import pytest

from app.core.enums import InventoryOperationType
from app.models.domain import AIAgentRun, AIOperation, AITaskDraft, FoodPlanItem
from tests.model_usage.test_migration_mysql import (
    MySqlAlembicDatabase,
    require_model_usage_mysql_url,
)


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


def seed_legacy_ai_rows(
    database: MySqlAlembicDatabase,
    *,
    draft_status: str,
    operation_status: str,
) -> None:
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
        ) VALUES (
            'legacy-user', 'legacy-migration-user', '迁移成员', '', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()
        )
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_conversations (
            id, family_id, owner_user_id, visibility, mode, prompt, response, context,
            title, summary, status, last_run_status, created_at, created_by
        ) VALUES (
            'legacy-conversation', 'legacy-family', 'legacy-user', 'PRIVATE', 'FOOD_QA', '', '', JSON_OBJECT(),
            '', '', 'active', '', UTC_TIMESTAMP(), 'legacy-user'
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
        ) VALUES (
            'legacy-draft', 'legacy-family', 'legacy-conversation', 'food',
            JSON_OBJECT('action', 'set_favorite', 'foodId', 'legacy-food', 'intentEvidence', JSON_OBJECT('quote', '收藏')), '',
            :draft_status, 1, 'food.v1', JSON_ARRAY(), JSON_OBJECT(), 'legacy-draft-key',
            UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-user'
        )
        """,
        {"draft_status": draft_status},
    )
    database.execute(
        """
        INSERT INTO ai_approval_requests (
            id, family_id, conversation_id, draft_id, draft_version, draft_schema_version,
            approval_type, status, request_payload, field_schema, initial_values, submitted_values,
            created_at, updated_at, updated_by
        ) VALUES (
            'legacy-approval-request', 'legacy-family', 'legacy-conversation', 'legacy-draft', 1, 'food.v1',
            'food', 'approved', JSON_OBJECT(), JSON_ARRAY(), JSON_OBJECT(), JSON_OBJECT(),
            UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'legacy-user'
        )
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_user_approvals (
            id, family_id, approval_request_id, draft_id, approved_by, approved_at, decision,
            approval_payload, operation_summary
        ) VALUES (
            'legacy-user-approval', 'legacy-family', 'legacy-approval-request', 'legacy-draft',
            'legacy-user', UTC_TIMESTAMP(), 'approved', JSON_OBJECT(), JSON_OBJECT()
        )
        """,
        {},
    )
    database.execute(
        """
        INSERT INTO ai_operations (
            id, family_id, approval_request_id, draft_id, operation_type, status,
            business_entity_type, business_entity_ids, idempotency_key, created_at, updated_at
        ) VALUES (
            'legacy-operation', 'legacy-family', 'legacy-approval-request', 'legacy-draft', 'food',
            :operation_status, '', JSON_ARRAY(), 'legacy-operation-key', UTC_TIMESTAMP(), UTC_TIMESTAMP()
        )
        """,
        {"operation_status": operation_status},
    )


def test_ai_auto_execution_migration_backfills_and_round_trips(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("6a7b8c9d0e1f")
    seed_legacy_ai_rows(database, draft_status="confirmed", operation_status="succeeded")

    database.upgrade("7b8c9d0e1f2a")

    assert database.rows("SELECT status, execution_route FROM ai_task_drafts") == [
        ("executed", "manual_confirmation")
    ]
    assert len(database.scalar("SELECT payload_hash FROM ai_task_drafts LIMIT 1")) == 64
    assert database.rows(
        "SELECT status, execution_mode, authorization_source FROM ai_operations"
    ) == [("completed", "manual_approval", "approval_request")]
    assert database.scalar("SELECT COUNT(*) FROM ai_auto_execution_preferences") == 0
    assert database.scalar("SELECT COUNT(*) FROM ai_family_auto_execution_policies") == 0

    database.downgrade("6a7b8c9d0e1f")
    database.upgrade("7b8c9d0e1f2a")
    assert database.current_revision() == "7b8c9d0e1f2a"
