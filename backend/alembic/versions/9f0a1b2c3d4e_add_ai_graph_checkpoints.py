"""add ai graph checkpoints

Revision ID: 9f0a1b2c3d4e
Revises: 8b9c0d1e2f3a
Create Date: 2026-06-08 16:50:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "9f0a1b2c3d4e"
down_revision = "8b9c0d1e2f3a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_graph_checkpoints",
        sa.Column("id", sa.String(length=191), nullable=False),
        sa.Column("thread_id", sa.String(length=191), nullable=False),
        sa.Column("checkpoint_ns", sa.String(length=191), nullable=False, server_default=""),
        sa.Column("checkpoint_id", sa.String(length=191), nullable=False),
        sa.Column("parent_checkpoint_id", sa.String(length=191), nullable=True),
        sa.Column("checkpoint_type", sa.String(length=64), nullable=False),
        sa.Column("checkpoint_blob", sa.LargeBinary(length=(2**32) - 1), nullable=False),
        sa.Column("metadata_type", sa.String(length=64), nullable=False),
        sa.Column("metadata_blob", sa.LargeBinary(length=(2**32) - 1), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("thread_id", "checkpoint_ns", "checkpoint_id", name="uq_ai_graph_checkpoint"),
    )
    op.create_index(op.f("ix_ai_graph_checkpoints_thread_id"), "ai_graph_checkpoints", ["thread_id"], unique=False)
    op.create_index(op.f("ix_ai_graph_checkpoints_checkpoint_ns"), "ai_graph_checkpoints", ["checkpoint_ns"], unique=False)
    op.create_index(op.f("ix_ai_graph_checkpoints_checkpoint_id"), "ai_graph_checkpoints", ["checkpoint_id"], unique=False)

    op.create_table(
        "ai_graph_writes",
        sa.Column("id", sa.String(length=191), nullable=False),
        sa.Column("thread_id", sa.String(length=191), nullable=False),
        sa.Column("checkpoint_ns", sa.String(length=191), nullable=False, server_default=""),
        sa.Column("checkpoint_id", sa.String(length=191), nullable=False),
        sa.Column("task_id", sa.String(length=191), nullable=False),
        sa.Column("task_path", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("write_idx", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(length=191), nullable=False),
        sa.Column("value_type", sa.String(length=64), nullable=False),
        sa.Column("value_blob", sa.LargeBinary(length=(2**32) - 1), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "thread_id",
            "checkpoint_ns",
            "checkpoint_id",
            "task_id",
            "write_idx",
            name="uq_ai_graph_write",
        ),
    )
    op.create_index(op.f("ix_ai_graph_writes_thread_id"), "ai_graph_writes", ["thread_id"], unique=False)
    op.create_index(op.f("ix_ai_graph_writes_checkpoint_ns"), "ai_graph_writes", ["checkpoint_ns"], unique=False)
    op.create_index(op.f("ix_ai_graph_writes_checkpoint_id"), "ai_graph_writes", ["checkpoint_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_graph_writes_checkpoint_id"), table_name="ai_graph_writes")
    op.drop_index(op.f("ix_ai_graph_writes_checkpoint_ns"), table_name="ai_graph_writes")
    op.drop_index(op.f("ix_ai_graph_writes_thread_id"), table_name="ai_graph_writes")
    op.drop_table("ai_graph_writes")
    op.drop_index(op.f("ix_ai_graph_checkpoints_checkpoint_id"), table_name="ai_graph_checkpoints")
    op.drop_index(op.f("ix_ai_graph_checkpoints_checkpoint_ns"), table_name="ai_graph_checkpoints")
    op.drop_index(op.f("ix_ai_graph_checkpoints_thread_id"), table_name="ai_graph_checkpoints")
    op.drop_table("ai_graph_checkpoints")
