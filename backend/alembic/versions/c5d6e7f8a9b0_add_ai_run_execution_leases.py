"""Add durable chat execution leases (stop old workers before rollout).

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
"""
from alembic import op
import sqlalchemy as sa

revision = "c5d6e7f8a9b0"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_run_execution_leases",
        sa.Column("run_id", sa.String(64), sa.ForeignKey("ai_agent_runs.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("family_id", sa.String(64), sa.ForeignKey("families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("worker_id", sa.String(64), nullable=True),
        sa.Column("fencing_token", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_started", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_ai_run_execution_leases_expiry", "ai_run_execution_leases", ["lease_until"])
    op.create_index("ix_ai_run_execution_leases_family_id", "ai_run_execution_leases", ["family_id"])


def downgrade() -> None:
    op.drop_table("ai_run_execution_leases")
