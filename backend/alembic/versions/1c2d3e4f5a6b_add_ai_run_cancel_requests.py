"""add AI run cancel requests

Revision ID: 1c2d3e4f5a6b
Revises: 0b1c2d3e4f5a
"""

from alembic import op
import sqlalchemy as sa


revision = "1c2d3e4f5a6b"
down_revision = "0b1c2d3e4f5a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_run_cancel_requests",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("requested_by", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("outcome_code", sa.String(length=64), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("family_id", "run_id", name="uq_ai_run_cancel_requests_family_run"),
    )
    op.create_index(
        "ix_ai_run_cancel_requests_run_id",
        "ai_run_cancel_requests",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_cancel_requests_family_status",
        "ai_run_cancel_requests",
        ["family_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_run_cancel_requests_family_status", table_name="ai_run_cancel_requests")
    op.drop_index("ix_ai_run_cancel_requests_run_id", table_name="ai_run_cancel_requests")
    op.drop_table("ai_run_cancel_requests")
