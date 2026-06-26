"""add ai task draft metadata

Revision ID: a2b3c4d5e6f8
Revises: d1e2f3a4b5c6
Create Date: 2026-06-24 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "a2b3c4d5e6f8"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_task_drafts",
        sa.Column("ai_metadata", sa.JSON(), nullable=True),
    )
    op.execute("UPDATE ai_task_drafts SET ai_metadata = JSON_OBJECT() WHERE ai_metadata IS NULL")
    op.alter_column(
        "ai_task_drafts",
        "ai_metadata",
        existing_type=sa.JSON(),
        nullable=False,
    )


def downgrade() -> None:
    op.drop_column("ai_task_drafts", "ai_metadata")
