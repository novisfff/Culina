"""add image usage recovery state

Revision ID: 5f6a7b8c9d0e
Revises: 4e5f6a7b8c9d
Create Date: 2026-07-30 14:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "5f6a7b8c9d0e"
down_revision = "4e5f6a7b8c9d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column("usage_attempt_key", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column("usage_reservation_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column("usage_event_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column(
            "provider_execution_status",
            sa.String(length=32),
            nullable=False,
            server_default="not_started",
        ),
    )
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column("provider_completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ai_image_generation_jobs",
        sa.Column("error_code", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ai_image_generation_jobs", "error_code")
    op.drop_column("ai_image_generation_jobs", "provider_completed_at")
    op.drop_column("ai_image_generation_jobs", "provider_execution_status")
    op.drop_column("ai_image_generation_jobs", "usage_event_id")
    op.drop_column("ai_image_generation_jobs", "usage_reservation_id")
    op.drop_column("ai_image_generation_jobs", "usage_attempt_key")
