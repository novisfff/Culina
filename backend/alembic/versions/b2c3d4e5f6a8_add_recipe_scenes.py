"""add recipe scenes

Revision ID: b2c3d4e5f6a8
Revises: a1b2c3d4e5f7
Create Date: 2026-05-14 15:15:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "b2c3d4e5f6a8"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipe_scenes",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=255), nullable=False),
        sa.Column("image_prompt", sa.Text(), nullable=False),
        sa.Column("hidden", sa.Boolean(), nullable=False),
        sa.Column("custom", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("family_id", "name", name="uq_recipe_scenes_family_name"),
    )
    op.create_index(op.f("ix_recipe_scenes_family_id"), "recipe_scenes", ["family_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_recipe_scenes_family_id"), table_name="recipe_scenes")
    op.drop_table("recipe_scenes")
