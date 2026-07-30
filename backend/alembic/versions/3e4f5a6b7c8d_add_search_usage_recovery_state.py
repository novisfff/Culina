"""add search usage recovery state

Revision ID: 3e4f5a6b7c8d
Revises: 2d3e4f5a6b7c
Create Date: 2026-07-30 12:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "3e4f5a6b7c8d"
down_revision = "2d3e4f5a6b7c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "search_documents",
        sa.Column("pending_vector", sa.JSON(none_as_null=True), nullable=True),
    )
    op.add_column(
        "search_documents",
        sa.Column("pending_vector_content_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "search_documents",
        sa.Column("pending_vector_model", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "search_documents",
        sa.Column("pending_vector_dimensions", sa.Integer(), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("usage_attempt_key", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("usage_event_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("budget_blocked_period_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("budget_blocked_policy_version_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("error_code", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("search_index_jobs", "error_code")
    op.drop_column("search_index_jobs", "budget_blocked_policy_version_id")
    op.drop_column("search_index_jobs", "budget_blocked_period_start")
    op.drop_column("search_index_jobs", "usage_event_id")
    op.drop_column("search_index_jobs", "usage_attempt_key")
    op.drop_column("search_documents", "pending_vector_dimensions")
    op.drop_column("search_documents", "pending_vector_model")
    op.drop_column("search_documents", "pending_vector_content_hash")
    op.drop_column("search_documents", "pending_vector")
