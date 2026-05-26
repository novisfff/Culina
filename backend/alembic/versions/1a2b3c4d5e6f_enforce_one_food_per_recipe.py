"""enforce one food per recipe

Revision ID: 1a2b3c4d5e6f
Revises: 0f1e2d3c4b5a
Create Date: 2026-05-21 17:00:00.000000

"""
from __future__ import annotations

from alembic import op


revision = "1a2b3c4d5e6f"
down_revision = "0f1e2d3c4b5a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_foods_recipe_id", "foods", ["recipe_id"])


def downgrade() -> None:
    op.drop_constraint("uq_foods_recipe_id", "foods", type_="unique")
