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


def _has_column(table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column_name in {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    if not _has_column("recipe_steps", "icon"):
        op.add_column("recipe_steps", sa.Column("icon", sa.String(length=32), nullable=False, server_default="pan"))
    if not _has_column("recipe_steps", "summary"):
        op.add_column("recipe_steps", sa.Column("summary", sa.String(length=255), nullable=False, server_default=""))
    if not _has_column("recipe_steps", "estimated_minutes"):
        op.add_column("recipe_steps", sa.Column("estimated_minutes", sa.Integer(), nullable=True))
    if not _has_column("recipe_steps", "tip"):
        op.add_column("recipe_steps", sa.Column("tip", sa.String(length=255), nullable=False, server_default=""))
    if not _has_column("recipe_steps", "key_points"):
        op.add_column("recipe_steps", sa.Column("key_points", sa.JSON(), nullable=True))
    op.execute("UPDATE recipe_steps SET key_points = '[]' WHERE key_points IS NULL")
    op.alter_column(
        "recipe_steps",
        "icon",
        server_default=None,
        existing_type=sa.String(length=32),
        existing_nullable=False,
    )
    op.alter_column(
        "recipe_steps",
        "summary",
        server_default=None,
        existing_type=sa.String(length=255),
        existing_nullable=False,
    )
    op.alter_column(
        "recipe_steps",
        "tip",
        server_default=None,
        existing_type=sa.String(length=255),
        existing_nullable=False,
    )
    op.alter_column(
        "recipe_steps",
        "key_points",
        nullable=False,
        existing_type=sa.JSON(),
        existing_nullable=True,
    )


def downgrade() -> None:
    for column_name in ["key_points", "tip", "estimated_minutes", "summary", "icon"]:
        if _has_column("recipe_steps", column_name):
            op.drop_column("recipe_steps", column_name)
