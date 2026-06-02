"""add meal food ratings

Revision ID: 8b9c0d1e2f3a
Revises: f6a7b8c9d0e2
Create Date: 2026-06-02 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "8b9c0d1e2f3a"
down_revision = "7a8b9c0d1e2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("meal_log_foods", sa.Column("rating", sa.Numeric(2, 1), nullable=True))


def downgrade() -> None:
    op.drop_column("meal_log_foods", "rating")
