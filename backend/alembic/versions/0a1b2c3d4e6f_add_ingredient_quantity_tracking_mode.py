"""add ingredient quantity tracking mode

Revision ID: 0a1b2c3d4e6f
Revises: f9b0c1d2e3f4
Create Date: 2026-06-26 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0a1b2c3d4e6f"
down_revision = "f9b0c1d2e3f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ingredients",
        sa.Column(
            "quantity_tracking_mode",
            sa.Enum(
                "TRACK_QUANTITY",
                "NOT_TRACK_QUANTITY",
                name="ingredientquantitytrackingmode",
                native_enum=False,
            ),
            nullable=False,
            server_default="TRACK_QUANTITY",
        ),
    )
    op.alter_column("ingredients", "quantity_tracking_mode", server_default=None)


def downgrade() -> None:
    op.drop_column("ingredients", "quantity_tracking_mode")
