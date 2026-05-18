"""add recipe step cooking details

Revision ID: a7b8c9d0e1f2
Revises: e6f7a8b9c0d1
Create Date: 2026-05-16 17:58:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "a7b8c9d0e1f2"
down_revision = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("recipe_steps", sa.Column("icon", sa.String(length=32), nullable=False, server_default="pan"))
    op.add_column("recipe_steps", sa.Column("summary", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("recipe_steps", sa.Column("estimated_minutes", sa.Integer(), nullable=True))
    op.add_column("recipe_steps", sa.Column("tip", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("recipe_steps", sa.Column("key_points", sa.JSON(), nullable=True))
    op.execute("UPDATE recipe_steps SET key_points = '[]' WHERE key_points IS NULL")
    op.alter_column("recipe_steps", "icon", server_default=None)
    op.alter_column("recipe_steps", "summary", server_default=None)
    op.alter_column("recipe_steps", "tip", server_default=None)
    op.alter_column("recipe_steps", "key_points", nullable=False)


def downgrade() -> None:
    op.drop_column("recipe_steps", "key_points")
    op.drop_column("recipe_steps", "tip")
    op.drop_column("recipe_steps", "estimated_minutes")
    op.drop_column("recipe_steps", "summary")
    op.drop_column("recipe_steps", "icon")
