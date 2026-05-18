"""add inventory consumed quantity

Revision ID: d4f5a6b7c8d9
Revises: c3d4e5f6a7b8
Create Date: 2026-03-27 12:40:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "d4f5a6b7c8d9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "inventory_items",
        sa.Column("consumed_quantity", sa.Numeric(10, 2), nullable=False, server_default="0"),
    )
    op.alter_column("inventory_items", "consumed_quantity", server_default=None)


def downgrade() -> None:
    op.drop_column("inventory_items", "consumed_quantity")
