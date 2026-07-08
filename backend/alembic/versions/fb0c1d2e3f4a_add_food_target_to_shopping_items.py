"""Add food target to shopping list items.

Revision ID: fb0c1d2e3f4a
Revises: fa0b1c2d3e4f
Create Date: 2026-07-08 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "fb0c1d2e3f4a"
down_revision = "fa0b1c2d3e4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("shopping_list_items", sa.Column("food_id", sa.String(length=64), nullable=True))
    op.create_index("ix_shopping_list_items_food_id", "shopping_list_items", ["food_id"], unique=False)
    op.create_foreign_key(
        "fk_shopping_list_items_food_id_foods",
        "shopping_list_items",
        "foods",
        ["food_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_shopping_list_items_food_id_foods", "shopping_list_items", type_="foreignkey")
    op.drop_index("ix_shopping_list_items_food_id", table_name="shopping_list_items")
    op.drop_column("shopping_list_items", "food_id")
