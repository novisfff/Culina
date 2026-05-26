"""clear recipe food sync notes

Revision ID: 3c4d5e6f7a8b
Revises: 2b3c4d5e6f7a
Create Date: 2026-05-21 18:00:00.000000

"""
from __future__ import annotations

from alembic import op


revision = "3c4d5e6f7a8b"
down_revision = "2b3c4d5e6f7a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE foods SET routine_note = '' WHERE routine_note = '由菜谱自动同步'")


def downgrade() -> None:
    pass
