"""add recipe favorites and plan

Revision ID: a1b2c3d4e5f7
Revises: f1a2b3c4d5e6
Create Date: 2026-05-13 17:50:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "a1b2c3d4e5f7"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipe_favorites",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("recipe_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "recipe_id", name="uq_recipe_favorites_user_recipe"),
    )
    op.create_index(op.f("ix_recipe_favorites_family_id"), "recipe_favorites", ["family_id"], unique=False)
    op.create_index(op.f("ix_recipe_favorites_recipe_id"), "recipe_favorites", ["recipe_id"], unique=False)
    op.create_index(op.f("ix_recipe_favorites_user_id"), "recipe_favorites", ["user_id"], unique=False)

    op.create_table(
        "recipe_plan_items",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("recipe_id", sa.String(length=64), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("meal_type", sa.Enum("BREAKFAST", "LUNCH", "DINNER", "SNACK", name="mealtype", native_enum=False), nullable=False),
        sa.Column("note", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_recipe_plan_items_family_id"), "recipe_plan_items", ["family_id"], unique=False)
    op.create_index(op.f("ix_recipe_plan_items_plan_date"), "recipe_plan_items", ["plan_date"], unique=False)
    op.create_index(op.f("ix_recipe_plan_items_recipe_id"), "recipe_plan_items", ["recipe_id"], unique=False)
    op.create_index(op.f("ix_recipe_plan_items_user_id"), "recipe_plan_items", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_recipe_plan_items_user_id"), table_name="recipe_plan_items")
    op.drop_index(op.f("ix_recipe_plan_items_recipe_id"), table_name="recipe_plan_items")
    op.drop_index(op.f("ix_recipe_plan_items_plan_date"), table_name="recipe_plan_items")
    op.drop_index(op.f("ix_recipe_plan_items_family_id"), table_name="recipe_plan_items")
    op.drop_table("recipe_plan_items")
    op.drop_index(op.f("ix_recipe_favorites_user_id"), table_name="recipe_favorites")
    op.drop_index(op.f("ix_recipe_favorites_recipe_id"), table_name="recipe_favorites")
    op.drop_index(op.f("ix_recipe_favorites_family_id"), table_name="recipe_favorites")
    op.drop_table("recipe_favorites")
