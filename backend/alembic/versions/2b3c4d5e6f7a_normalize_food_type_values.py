"""normalize food type values

Revision ID: 2b3c4d5e6f7a
Revises: 1a2b3c4d5e6f
Create Date: 2026-05-21 17:30:00.000000

"""
from __future__ import annotations

from alembic import op


revision = "2b3c4d5e6f7a"
down_revision = "1a2b3c4d5e6f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE foods SET type = 'selfMade' WHERE type = 'SELF_MADE'")
    op.execute("UPDATE foods SET type = 'takeout' WHERE type = 'TAKEOUT'")
    op.execute("UPDATE foods SET type = 'diningOut' WHERE type = 'DINING_OUT'")
    op.execute("UPDATE foods SET type = 'readyMade' WHERE type IN ('READY_MADE', 'PACKAGED', 'packaged')")
    op.execute("UPDATE foods SET type = 'instant' WHERE type = 'INSTANT'")


def downgrade() -> None:
    op.execute("UPDATE foods SET type = 'SELF_MADE' WHERE type = 'selfMade'")
    op.execute("UPDATE foods SET type = 'TAKEOUT' WHERE type = 'takeout'")
    op.execute("UPDATE foods SET type = 'DINING_OUT' WHERE type = 'diningOut'")
    op.execute("UPDATE foods SET type = 'PACKAGED' WHERE type = 'readyMade'")
    op.execute("UPDATE foods SET type = 'INSTANT' WHERE type = 'instant'")
