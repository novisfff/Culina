"""add ai workspace phase 1a

Revision ID: 6f7a8b9c0d1e
Revises: 5e6f7a8b9c0d
Create Date: 2026-05-30 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "6f7a8b9c0d1e"
down_revision = "5e6f7a8b9c0d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_conversations", sa.Column("title", sa.String(length=120), nullable=False, server_default=""))
    op.add_column("ai_conversations", sa.Column("summary", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("ai_conversations", sa.Column("status", sa.String(length=32), nullable=False, server_default="active"))
    op.add_column("ai_conversations", sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ai_conversations", sa.Column("last_run_status", sa.String(length=32), nullable=False, server_default=""))
    op.create_index(op.f("ix_ai_conversations_status"), "ai_conversations", ["status"], unique=False)

    op.add_column("ai_agent_runs", sa.Column("conversation_id", sa.String(length=64), nullable=True))
    op.add_column("ai_agent_runs", sa.Column("message_id", sa.String(length=64), nullable=True))
    op.add_column("ai_agent_runs", sa.Column("intent", sa.String(length=80), nullable=False, server_default=""))
    op.add_column("ai_agent_runs", sa.Column("input_summary", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("ai_agent_runs", sa.Column("context_summary", sa.JSON(), nullable=True))
    op.execute("UPDATE ai_agent_runs SET context_summary = '{}' WHERE context_summary IS NULL")
    op.add_column("ai_agent_runs", sa.Column("output_summary", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("ai_agent_runs", sa.Column("error_code", sa.String(length=80), nullable=True))
    op.create_index(op.f("ix_ai_agent_runs_conversation_id"), "ai_agent_runs", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_agent_runs_message_id"), "ai_agent_runs", ["message_id"], unique=False)
    op.create_index(op.f("ix_ai_agent_runs_intent"), "ai_agent_runs", ["intent"], unique=False)
    op.create_foreign_key(
        "fk_ai_agent_runs_conversation_id_ai_conversations",
        "ai_agent_runs",
        "ai_conversations",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "ai_messages",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_type", sa.String(length=32), nullable=False),
        sa.Column("parts", sa.JSON(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("client_message_id", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_messages_client_message_id"), "ai_messages", ["client_message_id"], unique=False)
    op.create_index(op.f("ix_ai_messages_conversation_id"), "ai_messages", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_messages_family_id"), "ai_messages", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_messages_role"), "ai_messages", ["role"], unique=False)
    op.create_index(op.f("ix_ai_messages_run_id"), "ai_messages", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_messages_status"), "ai_messages", ["status"], unique=False)

    op.create_table(
        "ai_run_events",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=True),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("internal_code", sa.String(length=120), nullable=False),
        sa.Column("user_message", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["ai_agent_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_run_events_conversation_id"), "ai_run_events", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_run_events_family_id"), "ai_run_events", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_run_events_run_id"), "ai_run_events", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_run_events_status"), "ai_run_events", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_run_events_status"), table_name="ai_run_events")
    op.drop_index(op.f("ix_ai_run_events_run_id"), table_name="ai_run_events")
    op.drop_index(op.f("ix_ai_run_events_family_id"), table_name="ai_run_events")
    op.drop_index(op.f("ix_ai_run_events_conversation_id"), table_name="ai_run_events")
    op.drop_table("ai_run_events")
    op.drop_index(op.f("ix_ai_messages_status"), table_name="ai_messages")
    op.drop_index(op.f("ix_ai_messages_run_id"), table_name="ai_messages")
    op.drop_index(op.f("ix_ai_messages_role"), table_name="ai_messages")
    op.drop_index(op.f("ix_ai_messages_family_id"), table_name="ai_messages")
    op.drop_index(op.f("ix_ai_messages_conversation_id"), table_name="ai_messages")
    op.drop_index(op.f("ix_ai_messages_client_message_id"), table_name="ai_messages")
    op.drop_table("ai_messages")

    op.drop_constraint("fk_ai_agent_runs_conversation_id_ai_conversations", "ai_agent_runs", type_="foreignkey")
    op.drop_index(op.f("ix_ai_agent_runs_intent"), table_name="ai_agent_runs")
    op.drop_index(op.f("ix_ai_agent_runs_message_id"), table_name="ai_agent_runs")
    op.drop_index(op.f("ix_ai_agent_runs_conversation_id"), table_name="ai_agent_runs")
    op.drop_column("ai_agent_runs", "error_code")
    op.drop_column("ai_agent_runs", "output_summary")
    op.drop_column("ai_agent_runs", "context_summary")
    op.drop_column("ai_agent_runs", "input_summary")
    op.drop_column("ai_agent_runs", "intent")
    op.drop_column("ai_agent_runs", "message_id")
    op.drop_column("ai_agent_runs", "conversation_id")

    op.drop_index(op.f("ix_ai_conversations_status"), table_name="ai_conversations")
    op.drop_column("ai_conversations", "last_run_status")
    op.drop_column("ai_conversations", "last_message_at")
    op.drop_column("ai_conversations", "status")
    op.drop_column("ai_conversations", "summary")
    op.drop_column("ai_conversations", "title")
