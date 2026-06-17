"""add inventory disposed quantity

Revision ID: c1d2e3f4a5b6
Revises: b1c2d3e4f5a6
Create Date: 2026-06-14 11:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "c1d2e3f4a5b6"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "inventory_items",
        sa.Column("disposed_quantity", sa.Numeric(10, 2), nullable=False, server_default="0"),
    )
    op.alter_column("inventory_items", "disposed_quantity", server_default=None)


def downgrade() -> None:
    op.drop_column("inventory_items", "disposed_quantity")
