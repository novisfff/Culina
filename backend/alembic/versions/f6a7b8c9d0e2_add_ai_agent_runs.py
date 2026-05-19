"""add ai agent runs

Revision ID: f6a7b8c9d0e2
Revises: a7b8c9d0e1f2
Create Date: 2026-05-19 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "f6a7b8c9d0e2"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_agent_runs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("agent_key", sa.String(length=80), nullable=False),
        sa.Column("feature_key", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("input", sa.JSON(), nullable=False),
        sa.Column("output", sa.JSON(), nullable=False),
        sa.Column("tool_calls", sa.JSON(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_agent_runs_agent_key"), "ai_agent_runs", ["agent_key"], unique=False)
    op.create_index(op.f("ix_ai_agent_runs_family_id"), "ai_agent_runs", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_agent_runs_feature_key"), "ai_agent_runs", ["feature_key"], unique=False)
    op.create_index(op.f("ix_ai_agent_runs_status"), "ai_agent_runs", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_agent_runs_status"), table_name="ai_agent_runs")
    op.drop_index(op.f("ix_ai_agent_runs_feature_key"), table_name="ai_agent_runs")
    op.drop_index(op.f("ix_ai_agent_runs_family_id"), table_name="ai_agent_runs")
    op.drop_index(op.f("ix_ai_agent_runs_agent_key"), table_name="ai_agent_runs")
    op.drop_table("ai_agent_runs")
