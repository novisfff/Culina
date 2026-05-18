"""add ingredient unit conversions and inventory input snapshot

Revision ID: f1a2b3c4d5e6
Revises: d4f5a6b7c8d9
Create Date: 2026-03-27 16:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "f1a2b3c4d5e6"
down_revision = "d4f5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    ingredient_columns = {column["name"] for column in inspector.get_columns("ingredients")}
    if "unit_conversions" not in ingredient_columns:
        op.add_column("ingredients", sa.Column("unit_conversions", sa.JSON(), nullable=True))
    op.execute("UPDATE ingredients SET unit_conversions = '[]' WHERE unit_conversions IS NULL")
    op.alter_column("ingredients", "unit_conversions", existing_type=sa.JSON(), nullable=False)

    inventory_columns = {column["name"] for column in inspector.get_columns("inventory_items")}
    if "entered_quantity" not in inventory_columns:
        op.add_column("inventory_items", sa.Column("entered_quantity", sa.Numeric(10, 2), nullable=True))
    if "entered_unit" not in inventory_columns:
        op.add_column("inventory_items", sa.Column("entered_unit", sa.String(length=32), nullable=True))
    op.execute(
        """
        UPDATE inventory_items
        SET entered_quantity = quantity,
            entered_unit = unit
        WHERE entered_quantity IS NULL
           OR entered_unit IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("inventory_items", "entered_unit")
    op.drop_column("inventory_items", "entered_quantity")
    op.drop_column("ingredients", "unit_conversions")
