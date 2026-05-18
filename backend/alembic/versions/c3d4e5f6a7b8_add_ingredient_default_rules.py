"""add ingredient default expiry and low stock rules

Revision ID: c3d4e5f6a7b8
Revises: 9e8f4a1b2c3d
Create Date: 2026-03-26 17:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c3d4e5f6a7b8"
down_revision = "9e8f4a1b2c3d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ingredients",
        sa.Column(
            "default_expiry_mode",
            sa.Enum("DAYS", "MANUAL_DATE", "NONE", name="ingredientexpirymode", native_enum=False),
            nullable=False,
            server_default="NONE",
        ),
    )
    op.add_column("ingredients", sa.Column("default_expiry_days", sa.Integer(), nullable=True))
    op.add_column("ingredients", sa.Column("default_low_stock_threshold", sa.Numeric(10, 2), nullable=True))
    op.alter_column("ingredients", "default_expiry_mode", server_default=None)


def downgrade() -> None:
    op.drop_column("ingredients", "default_low_stock_threshold")
    op.drop_column("ingredients", "default_expiry_days")
    op.drop_column("ingredients", "default_expiry_mode")
