"""add food storage location

Revision ID: fa0b1c2d3e4f
Revises: 0a1b2c3d4e5f
Create Date: 2026-07-08 10:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "fa0b1c2d3e4f"
down_revision = "0a1b2c3d4e5f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("foods", sa.Column("storage_location", sa.String(length=120), nullable=False, server_default=""))
    op.execute(
        sa.text(
            """
            UPDATE foods
            SET storage_location = '常温'
            WHERE type IN ('readyMade', 'instant', 'packaged')
              AND stock_quantity IS NOT NULL
              AND stock_quantity > 0
              AND (storage_location IS NULL OR storage_location = '')
            """
        )
    )
    op.alter_column("foods", "storage_location", server_default=None)


def downgrade() -> None:
    op.drop_column("foods", "storage_location")
