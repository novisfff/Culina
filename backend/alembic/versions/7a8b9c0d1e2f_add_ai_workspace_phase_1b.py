"""add ai workspace phase 1b

Revision ID: 7a8b9c0d1e2f
Revises: 6f7a8b9c0d1e
Create Date: 2026-05-30 13:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "7a8b9c0d1e2f"
down_revision = "6f7a8b9c0d1e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_task_drafts",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=False),
        sa.Column("source_run_id", sa.String(length=64), nullable=True),
        sa.Column("message_id", sa.String(length=64), nullable=True),
        sa.Column("draft_type", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("preview_summary", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("schema_version", sa.String(length=32), nullable=False, server_default="recipe.v1"),
        sa.Column("validation_errors", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["ai_messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["source_run_id"], ["ai_agent_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_index(op.f("ix_ai_task_drafts_conversation_id"), "ai_task_drafts", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_task_drafts_draft_type"), "ai_task_drafts", ["draft_type"], unique=False)
    op.create_index(op.f("ix_ai_task_drafts_family_id"), "ai_task_drafts", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_task_drafts_idempotency_key"), "ai_task_drafts", ["idempotency_key"], unique=True)
    op.create_index(op.f("ix_ai_task_drafts_message_id"), "ai_task_drafts", ["message_id"], unique=False)
    op.create_index(op.f("ix_ai_task_drafts_source_run_id"), "ai_task_drafts", ["source_run_id"], unique=False)
    op.create_index(op.f("ix_ai_task_drafts_status"), "ai_task_drafts", ["status"], unique=False)

    op.create_table(
        "ai_approval_requests",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=False),
        sa.Column("message_id", sa.String(length=64), nullable=True),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("draft_id", sa.String(length=64), nullable=False),
        sa.Column("draft_version", sa.Integer(), nullable=False),
        sa.Column("draft_schema_version", sa.String(length=32), nullable=False),
        sa.Column("approval_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("request_payload", sa.JSON(), nullable=False),
        sa.Column("field_schema", sa.JSON(), nullable=False),
        sa.Column("initial_values", sa.JSON(), nullable=False),
        sa.Column("submitted_values", sa.JSON(), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["draft_id"], ["ai_task_drafts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["ai_messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run_id"], ["ai_agent_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_approval_requests_approval_type"), "ai_approval_requests", ["approval_type"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_conversation_id"), "ai_approval_requests", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_draft_id"), "ai_approval_requests", ["draft_id"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_family_id"), "ai_approval_requests", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_message_id"), "ai_approval_requests", ["message_id"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_run_id"), "ai_approval_requests", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_approval_requests_status"), "ai_approval_requests", ["status"], unique=False)

    op.create_table(
        "ai_user_approvals",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("approval_request_id", sa.String(length=64), nullable=False),
        sa.Column("draft_id", sa.String(length=64), nullable=False),
        sa.Column("approved_by", sa.String(length=64), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("approval_payload", sa.JSON(), nullable=False),
        sa.Column("operation_summary", sa.JSON(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["approval_request_id"], ["ai_approval_requests.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["draft_id"], ["ai_task_drafts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_user_approvals_approval_request_id"), "ai_user_approvals", ["approval_request_id"], unique=False)
    op.create_index(op.f("ix_ai_user_approvals_approved_by"), "ai_user_approvals", ["approved_by"], unique=False)
    op.create_index(op.f("ix_ai_user_approvals_draft_id"), "ai_user_approvals", ["draft_id"], unique=False)
    op.create_index(op.f("ix_ai_user_approvals_family_id"), "ai_user_approvals", ["family_id"], unique=False)

    op.create_table(
        "ai_operations",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("approval_request_id", sa.String(length=64), nullable=False),
        sa.Column("draft_id", sa.String(length=64), nullable=False),
        sa.Column("operation_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("business_entity_type", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("business_entity_ids", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["approval_request_id"], ["ai_approval_requests.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["draft_id"], ["ai_task_drafts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_index(op.f("ix_ai_operations_approval_request_id"), "ai_operations", ["approval_request_id"], unique=False)
    op.create_index(op.f("ix_ai_operations_draft_id"), "ai_operations", ["draft_id"], unique=False)
    op.create_index(op.f("ix_ai_operations_family_id"), "ai_operations", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_operations_idempotency_key"), "ai_operations", ["idempotency_key"], unique=True)
    op.create_index(op.f("ix_ai_operations_operation_type"), "ai_operations", ["operation_type"], unique=False)
    op.create_index(op.f("ix_ai_operations_status"), "ai_operations", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_operations_status"), table_name="ai_operations")
    op.drop_index(op.f("ix_ai_operations_operation_type"), table_name="ai_operations")
    op.drop_index(op.f("ix_ai_operations_idempotency_key"), table_name="ai_operations")
    op.drop_index(op.f("ix_ai_operations_family_id"), table_name="ai_operations")
    op.drop_index(op.f("ix_ai_operations_draft_id"), table_name="ai_operations")
    op.drop_index(op.f("ix_ai_operations_approval_request_id"), table_name="ai_operations")
    op.drop_table("ai_operations")
    op.drop_index(op.f("ix_ai_user_approvals_family_id"), table_name="ai_user_approvals")
    op.drop_index(op.f("ix_ai_user_approvals_draft_id"), table_name="ai_user_approvals")
    op.drop_index(op.f("ix_ai_user_approvals_approved_by"), table_name="ai_user_approvals")
    op.drop_index(op.f("ix_ai_user_approvals_approval_request_id"), table_name="ai_user_approvals")
    op.drop_table("ai_user_approvals")
    op.drop_index(op.f("ix_ai_approval_requests_status"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_run_id"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_message_id"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_family_id"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_draft_id"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_conversation_id"), table_name="ai_approval_requests")
    op.drop_index(op.f("ix_ai_approval_requests_approval_type"), table_name="ai_approval_requests")
    op.drop_table("ai_approval_requests")
    op.drop_index(op.f("ix_ai_task_drafts_status"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_source_run_id"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_message_id"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_idempotency_key"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_family_id"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_draft_type"), table_name="ai_task_drafts")
    op.drop_index(op.f("ix_ai_task_drafts_conversation_id"), table_name="ai_task_drafts")
    op.drop_table("ai_task_drafts")
