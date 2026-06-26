"""add shopping quantity mode

Revision ID: 1b2c3d4e5f70
Revises: 0a1b2c3d4e6f
Create Date: 2026-06-26 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "1b2c3d4e5f70"
down_revision = "0a1b2c3d4e6f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("shopping_list_items", sa.Column("ingredient_id", sa.String(length=64), nullable=True))
    op.add_column(
        "shopping_list_items",
        sa.Column(
            "quantity_mode",
            sa.Enum(
                "TRACK_QUANTITY",
                "NOT_TRACK_QUANTITY",
                name="shoppingquantitymode",
                native_enum=False,
            ),
            nullable=False,
            server_default="TRACK_QUANTITY",
        ),
    )
    op.add_column("shopping_list_items", sa.Column("display_label", sa.String(length=80), nullable=True))
    op.create_index("ix_shopping_list_items_ingredient_id", "shopping_list_items", ["ingredient_id"])
    op.create_foreign_key(
        "fk_shopping_list_items_ingredient_id_ingredients",
        "shopping_list_items",
        "ingredients",
        ["ingredient_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.alter_column("shopping_list_items", "quantity_mode", server_default=None)


def downgrade() -> None:
    op.drop_constraint("fk_shopping_list_items_ingredient_id_ingredients", "shopping_list_items", type_="foreignkey")
    op.drop_index("ix_shopping_list_items_ingredient_id", table_name="shopping_list_items")
    op.drop_column("shopping_list_items", "display_label")
    op.drop_column("shopping_list_items", "quantity_mode")
    op.drop_column("shopping_list_items", "ingredient_id")
