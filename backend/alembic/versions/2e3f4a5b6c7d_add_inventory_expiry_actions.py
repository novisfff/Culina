"""add inventory expiry actions

Revision ID: 2e3f4a5b6c7d
Revises: 1d2e3f4a5b6c
Create Date: 2026-07-11 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "2e3f4a5b6c7d"
down_revision = "1d2e3f4a5b6c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "inventory_items",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "inventory_items",
        sa.Column("expiry_alert_snoozed_until", sa.Date(), nullable=True),
    )
    op.add_column(
        "inventory_items",
        sa.Column("expiry_reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "inventory_items",
        sa.Column("expiry_reviewed_by", sa.String(length=64), nullable=True),
    )
    op.create_foreign_key(
        "fk_inventory_items_expiry_reviewed_by_users",
        "inventory_items",
        "users",
        ["expiry_reviewed_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_inventory_items_expiry_reviewed_by_users",
        "inventory_items",
        type_="foreignkey",
    )
    op.drop_column("inventory_items", "expiry_reviewed_by")
    op.drop_column("inventory_items", "expiry_reviewed_at")
    op.drop_column("inventory_items", "expiry_alert_snoozed_until")
    op.drop_column("inventory_items", "row_version")
