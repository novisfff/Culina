"""Add AI auto-execution policy and revert persistence.

Revision ID: 7b8c9d0e1f2a
Revises: 6a7b8c9d0e1f
Create Date: 2026-08-25 10:00:00.000000
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from alembic import op
import sqlalchemy as sa


revision = "7b8c9d0e1f2a"
down_revision = "6a7b8c9d0e1f"
branch_labels = None
depends_on = None


def _canonical_payload_hash(payload: Any) -> str:
    if not isinstance(payload, dict):
        payload = json.loads(payload) if isinstance(payload, str) else {}
    normalized_payload = dict(payload)
    normalized_payload.pop("intentEvidence", None)
    canonical = json.dumps(
        normalized_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _backfill_draft_payload_hashes() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, payload FROM ai_task_drafts")).mappings()
    for row in rows:
        bind.execute(
            sa.text("UPDATE ai_task_drafts SET payload_hash = :payload_hash WHERE id = :id"),
            {"id": row["id"], "payload_hash": _canonical_payload_hash(row["payload"])},
        )


def _drop_approval_request_foreign_key() -> None:
    bind = op.get_bind()
    foreign_keys = sa.inspect(bind).get_foreign_keys("ai_operations")
    approval_foreign_keys = [
        foreign_key
        for foreign_key in foreign_keys
        if foreign_key["constrained_columns"] == ["approval_request_id"]
    ]
    if len(approval_foreign_keys) != 1 or not approval_foreign_keys[0]["name"]:
        raise RuntimeError("Could not identify ai_operations.approval_request_id foreign key")
    op.drop_constraint(
        approval_foreign_keys[0]["name"], "ai_operations", type_="foreignkey"
    )


def _create_approval_request_foreign_key(*, ondelete: str, constraint_name: str) -> None:
    op.create_foreign_key(
        constraint_name,
        "ai_operations",
        "ai_approval_requests",
        ["approval_request_id"],
        ["id"],
        ondelete=ondelete,
    )


def _create_preference_tables() -> None:
    op.create_table(
        "ai_auto_execution_preferences",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("action_key", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("consent_notice_version", sa.String(length=80), nullable=True),
        sa.Column("consented_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id", "user_id", "action_key", name="uq_ai_auto_execution_preference_actor_action"
        ),
    )
    op.create_index("ix_ai_auto_execution_preferences_family_id", "ai_auto_execution_preferences", ["family_id"])
    op.create_index("ix_ai_auto_execution_preferences_user_id", "ai_auto_execution_preferences", ["user_id"])
    op.create_index("ix_ai_auto_execution_preferences_action_key", "ai_auto_execution_preferences", ["action_key"])
    op.create_index(
        "ix_ai_auto_execution_preference_family_action",
        "ai_auto_execution_preferences",
        ["family_id", "action_key"],
    )

    op.create_table(
        "ai_family_auto_execution_policies",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("action_key", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("consent_notice_version", sa.String(length=80), nullable=True),
        sa.Column("consented_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consented_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["consented_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("family_id", "action_key", name="uq_ai_family_auto_execution_policy_action"),
    )
    op.create_index("ix_ai_family_auto_execution_policies_family_id", "ai_family_auto_execution_policies", ["family_id"])
    op.create_index("ix_ai_family_auto_execution_policies_action_key", "ai_family_auto_execution_policies", ["action_key"])
    op.create_index(
        "ix_ai_family_auto_execution_policy_family_action",
        "ai_family_auto_execution_policies",
        ["family_id", "action_key"],
    )


def _extend_task_drafts() -> None:
    op.add_column("ai_task_drafts", sa.Column("intent_clarity", sa.String(length=32), nullable=True))
    op.add_column("ai_task_drafts", sa.Column("intent_evidence_json", sa.JSON(), nullable=True))
    op.add_column("ai_task_drafts", sa.Column("payload_hash", sa.String(length=64), nullable=True))
    op.add_column(
        "ai_task_drafts",
        sa.Column(
            "execution_route",
            sa.String(length=32),
            nullable=False,
            server_default="manual_confirmation",
        ),
    )
    op.add_column("ai_task_drafts", sa.Column("policy_key", sa.String(length=80), nullable=True))
    op.add_column("ai_task_drafts", sa.Column("policy_version", sa.String(length=80), nullable=True))
    op.add_column("ai_task_drafts", sa.Column("policy_reason_codes", sa.JSON(), nullable=True))
    op.add_column("ai_task_drafts", sa.Column("policy_evaluated_at", sa.DateTime(timezone=True), nullable=True))
    _backfill_draft_payload_hashes()
    op.alter_column("ai_task_drafts", "payload_hash", existing_type=sa.String(length=64), nullable=False)
    op.execute("UPDATE ai_task_drafts SET status='executed' WHERE status='confirmed'")
    op.execute("UPDATE ai_task_drafts SET status='execution_failed' WHERE status='confirmation_failed'")
    op.execute("UPDATE ai_task_drafts SET status='pending_confirmation' WHERE status='pending'")
    op.execute("UPDATE ai_task_drafts SET execution_route='manual_confirmation'")
    op.create_index("ix_ai_task_drafts_execution_route", "ai_task_drafts", ["execution_route"])
    op.create_index("ix_ai_task_drafts_policy_key", "ai_task_drafts", ["policy_key"])


def _extend_operations() -> None:
    for column in (
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("actor_user_id", sa.String(length=64), nullable=True),
        sa.Column("execution_mode", sa.String(length=32), nullable=False, server_default="manual_approval"),
        sa.Column("authorization_source", sa.String(length=48), nullable=False, server_default="approval_request"),
        sa.Column("authorization_snapshot_json", sa.JSON(), nullable=True),
        sa.Column("policy_key", sa.String(length=80), nullable=True),
        sa.Column("policy_version", sa.String(length=80), nullable=True),
        sa.Column("policy_reason_codes", sa.JSON(), nullable=True),
        sa.Column("committed_payload_json", sa.JSON(), nullable=True),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("error_code", sa.String(length=120), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revert_adapter_key", sa.String(length=80), nullable=True),
        sa.Column("revert_context_json", sa.JSON(), nullable=True),
        sa.Column("revertible_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revert_request_id", sa.String(length=120), nullable=True),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reverted_by", sa.String(length=64), nullable=True),
        sa.Column("revert_result_json", sa.JSON(), nullable=True),
        sa.Column("revert_blocked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revert_blocked_code", sa.String(length=120), nullable=True),
    ):
        op.add_column("ai_operations", column)

    op.create_foreign_key(
        "fk_ai_operations_run_id_ai_agent_runs",
        "ai_operations",
        "ai_agent_runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_ai_operations_actor_user_id_users",
        "ai_operations",
        "users",
        ["actor_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_ai_operations_reverted_by_users",
        "ai_operations",
        "users",
        ["reverted_by"],
        ["id"],
        ondelete="SET NULL",
    )
    _drop_approval_request_foreign_key()
    op.alter_column(
        "ai_operations",
        "approval_request_id",
        existing_type=sa.String(length=64),
        nullable=True,
    )
    _create_approval_request_foreign_key(
        ondelete="SET NULL",
        constraint_name="fk_ai_operations_approval_request_id_ai_approval_requests",
    )
    op.execute("UPDATE ai_operations SET status='pending' WHERE status='running'")
    op.execute("UPDATE ai_operations SET status='completed' WHERE status='succeeded'")
    op.execute(
        "UPDATE ai_operations SET execution_mode='manual_approval', "
        "authorization_source='approval_request'"
    )
    op.execute(
        """
        UPDATE ai_operations AS operation_row
        SET actor_user_id = COALESCE(
            (
                SELECT approval.approved_by
                FROM ai_user_approvals AS approval
                WHERE approval.approval_request_id = operation_row.approval_request_id
                  AND approval.approved_by IS NOT NULL
                ORDER BY approval.approved_at DESC, approval.id DESC
                LIMIT 1
            ),
            (
                SELECT request_row.updated_by
                FROM ai_approval_requests AS request_row
                WHERE request_row.id = operation_row.approval_request_id
                  AND request_row.updated_by IS NOT NULL
            ),
            (
                SELECT draft_row.created_by
                FROM ai_task_drafts AS draft_row
                WHERE draft_row.id = operation_row.draft_id
                  AND draft_row.created_by IS NOT NULL
            )
        )
        """
    )
    op.create_index("ix_ai_operations_run_id", "ai_operations", ["run_id"])
    op.create_index("ix_ai_operations_actor_user_id", "ai_operations", ["actor_user_id"])
    op.create_index("ix_ai_operations_execution_mode", "ai_operations", ["execution_mode"])
    op.create_index("ix_ai_operations_policy_key", "ai_operations", ["policy_key"])
    op.create_index("ix_ai_operations_error_code", "ai_operations", ["error_code"])
    op.create_index("ix_ai_operations_revert_request_id", "ai_operations", ["revert_request_id"], unique=True)
    op.create_index(
        "ix_ai_operations_family_status_revertible",
        "ai_operations",
        ["family_id", "status", "revertible_until"],
    )


def _extend_runs_and_plan_items() -> None:
    op.add_column(
        "ai_agent_runs",
        sa.Column("auto_execution_attempted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("ai_agent_runs", sa.Column("auto_operation_id", sa.String(length=64), nullable=True))
    op.create_foreign_key(
        "fk_ai_agent_runs_auto_operation_id_ai_operations",
        "ai_agent_runs",
        "ai_operations",
        ["auto_operation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_ai_agent_runs_auto_operation_id", "ai_agent_runs", ["auto_operation_id"])
    op.add_column(
        "food_plan_items",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )


def upgrade() -> None:
    _create_preference_tables()
    _extend_task_drafts()
    _extend_operations()
    _extend_runs_and_plan_items()
    # InventoryOperationType is persisted as a non-native SQLAlchemy Enum, which is a
    # VARCHAR in the existing MySQL schema and has no database enum/check constraint.
    # Adding consume/dispose in the application enum therefore needs no DDL change.


def _drop_runs_and_plan_item_extensions() -> None:
    op.drop_constraint(
        "fk_ai_agent_runs_auto_operation_id_ai_operations",
        "ai_agent_runs",
        type_="foreignkey",
    )
    op.drop_index("ix_ai_agent_runs_auto_operation_id", table_name="ai_agent_runs")
    op.drop_column("ai_agent_runs", "auto_operation_id")
    op.drop_column("ai_agent_runs", "auto_execution_attempted")
    op.drop_column("food_plan_items", "row_version")


def _drop_operation_extensions() -> None:
    for constraint_name in (
        "fk_ai_operations_reverted_by_users",
        "fk_ai_operations_actor_user_id_users",
        "fk_ai_operations_run_id_ai_agent_runs",
    ):
        op.drop_constraint(constraint_name, "ai_operations", type_="foreignkey")
    op.drop_index("ix_ai_operations_family_status_revertible", table_name="ai_operations")
    op.drop_index("ix_ai_operations_revert_request_id", table_name="ai_operations")
    op.drop_index("ix_ai_operations_error_code", table_name="ai_operations")
    op.drop_index("ix_ai_operations_policy_key", table_name="ai_operations")
    op.drop_index("ix_ai_operations_execution_mode", table_name="ai_operations")
    op.drop_index("ix_ai_operations_actor_user_id", table_name="ai_operations")
    op.drop_index("ix_ai_operations_run_id", table_name="ai_operations")
    _drop_approval_request_foreign_key()
    # The pre-feature schema cannot represent policy-auto operations because it
    # requires an approval request.  Preserve every legacy/manual operation and
    # discard only post-feature rows that have no representable predecessor.
    op.execute("DELETE FROM ai_operations WHERE approval_request_id IS NULL")
    op.alter_column(
        "ai_operations",
        "approval_request_id",
        existing_type=sa.String(length=64),
        nullable=False,
    )
    _create_approval_request_foreign_key(
        ondelete="CASCADE",
        constraint_name="fk_ai_operations_approval_request_id_ai_approval_requests_legacy",
    )
    op.execute("UPDATE ai_operations SET status='running' WHERE status='pending'")
    op.execute("UPDATE ai_operations SET status='succeeded' WHERE status IN ('completed', 'reverted')")
    for column_name in (
        "revert_blocked_code",
        "revert_blocked_at",
        "revert_result_json",
        "reverted_by",
        "reverted_at",
        "revert_request_id",
        "revertible_until",
        "revert_context_json",
        "revert_adapter_key",
        "failed_at",
        "error_code",
        "result_json",
        "committed_payload_json",
        "policy_reason_codes",
        "policy_version",
        "policy_key",
        "authorization_snapshot_json",
        "authorization_source",
        "execution_mode",
        "actor_user_id",
        "run_id",
    ):
        op.drop_column("ai_operations", column_name)


def _drop_task_draft_extensions() -> None:
    op.drop_index("ix_ai_task_drafts_policy_key", table_name="ai_task_drafts")
    op.drop_index("ix_ai_task_drafts_execution_route", table_name="ai_task_drafts")
    op.execute("UPDATE ai_task_drafts SET status='pending' WHERE status='pending_confirmation'")
    op.execute("UPDATE ai_task_drafts SET status='confirmed' WHERE status IN ('executed', 'no_change', 'reverted')")
    op.execute("UPDATE ai_task_drafts SET status='confirmation_failed' WHERE status='execution_failed'")
    op.execute("UPDATE ai_task_drafts SET status='rejected' WHERE status='expired'")
    for column_name in (
        "policy_evaluated_at",
        "policy_reason_codes",
        "policy_version",
        "policy_key",
        "execution_route",
        "payload_hash",
        "intent_evidence_json",
        "intent_clarity",
    ):
        op.drop_column("ai_task_drafts", column_name)


def _drop_preference_tables() -> None:
    # Dropping a table removes its FK constraints and supporting indexes together.
    # MySQL rejects dropping an FK-supporting index while the FK still exists.
    op.drop_table("ai_family_auto_execution_policies")
    op.drop_table("ai_auto_execution_preferences")


def downgrade() -> None:
    _drop_runs_and_plan_item_extensions()
    _drop_operation_extensions()
    _drop_task_draft_extensions()
    _drop_preference_tables()
