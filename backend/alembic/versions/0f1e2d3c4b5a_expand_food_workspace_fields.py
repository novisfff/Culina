"""expand food workspace fields

Revision ID: 0f1e2d3c4b5a
Revises: f6a7b8c9d0e2
Create Date: 2026-05-21 16:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0f1e2d3c4b5a"
down_revision = "f6a7b8c9d0e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("foods", sa.Column("suitable_meal_types", sa.JSON(), nullable=True))
    op.add_column("foods", sa.Column("purchase_source", sa.String(length=120), nullable=False, server_default=""))
    op.add_column("foods", sa.Column("routine_note", sa.Text(), nullable=True))
    op.add_column("foods", sa.Column("price", sa.Numeric(10, 2), nullable=True))
    op.add_column("foods", sa.Column("rating", sa.Integer(), nullable=True))
    op.add_column("foods", sa.Column("repurchase", sa.Boolean(), nullable=True))
    op.add_column("foods", sa.Column("expiry_date", sa.Date(), nullable=True))
    op.add_column("foods", sa.Column("stock_quantity", sa.Numeric(10, 2), nullable=True))
    op.add_column("foods", sa.Column("stock_unit", sa.String(length=32), nullable=False, server_default=""))
    op.execute("UPDATE foods SET suitable_meal_types = JSON_ARRAY() WHERE suitable_meal_types IS NULL")
    op.execute("UPDATE foods SET routine_note = '' WHERE routine_note IS NULL")
    op.execute("UPDATE foods SET type = 'readyMade' WHERE type = 'packaged'")
    op.alter_column("foods", "suitable_meal_types", existing_type=sa.JSON(), nullable=False)
    op.alter_column("foods", "purchase_source", server_default=None)
    op.alter_column("foods", "routine_note", existing_type=sa.Text(), nullable=False)
    op.alter_column("foods", "stock_unit", server_default=None)


def downgrade() -> None:
    op.execute("UPDATE foods SET type = 'packaged' WHERE type = 'readyMade'")
    op.drop_column("foods", "stock_unit")
    op.drop_column("foods", "stock_quantity")
    op.drop_column("foods", "expiry_date")
    op.drop_column("foods", "repurchase")
    op.drop_column("foods", "rating")
    op.drop_column("foods", "price")
    op.drop_column("foods", "routine_note")
    op.drop_column("foods", "purchase_source")
    op.drop_column("foods", "suitable_meal_types")
