"""Add family food preferences.

Revision ID: 0c1d2e3f4a5b
Revises: fb0c1d2e3f4a
Create Date: 2026-07-10 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0c1d2e3f4a5b"
down_revision = "fb0c1d2e3f4a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "families",
        sa.Column("food_preferences", sa.JSON(), nullable=False, server_default=sa.text("(JSON_ARRAY())")),
    )
    op.add_column(
        "families",
        sa.Column("food_avoidances", sa.JSON(), nullable=False, server_default=sa.text("(JSON_ARRAY())")),
    )
    op.alter_column("families", "food_preferences", existing_type=sa.JSON(), server_default=None)
    op.alter_column("families", "food_avoidances", existing_type=sa.JSON(), server_default=None)


def downgrade() -> None:
    op.drop_column("families", "food_avoidances")
    op.drop_column("families", "food_preferences")
