"""add recipe step titles

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-05-15 15:58:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "e6f7a8b9c0d1"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("recipe_steps", sa.Column("title", sa.String(length=80), nullable=True))


def downgrade() -> None:
    op.drop_column("recipe_steps", "title")
