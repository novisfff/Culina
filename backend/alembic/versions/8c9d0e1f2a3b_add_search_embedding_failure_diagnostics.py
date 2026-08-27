"""add safe search embedding failure diagnostics

Revision ID: 8c9d0e1f2a3b
Revises: 7b8c9d0e1f2a
Create Date: 2026-08-27 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "8c9d0e1f2a3b"
down_revision = "7b8c9d0e1f2a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "search_index_jobs",
        sa.Column("provider_http_status", sa.Integer(), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("provider_error_code", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("provider_error_message", sa.Text(), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("request_sent", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("execution_certainty", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("search_index_jobs", "execution_certainty")
    op.drop_column("search_index_jobs", "request_sent")
    op.drop_column("search_index_jobs", "provider_error_message")
    op.drop_column("search_index_jobs", "provider_error_code")
    op.drop_column("search_index_jobs", "provider_http_status")
