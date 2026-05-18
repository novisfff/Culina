"""add recipe cook logs

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-05-14 15:35:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "d5e6f7a8b9c0"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipe_cook_logs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("recipe_id", sa.String(length=64), nullable=False),
        sa.Column("meal_log_id", sa.String(length=64), nullable=True),
        sa.Column("cook_date", sa.Date(), nullable=False),
        sa.Column("meal_type", sa.Enum("BREAKFAST", "LUNCH", "DINNER", "SNACK", name="mealtype", native_enum=False), nullable=False),
        sa.Column("servings", sa.Numeric(10, 2), nullable=False),
        sa.Column("result_note", sa.Text(), nullable=False),
        sa.Column("adjustments", sa.Text(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["meal_log_id"], ["meal_logs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_recipe_cook_logs_family_id"), "recipe_cook_logs", ["family_id"], unique=False)
    op.create_index(op.f("ix_recipe_cook_logs_recipe_id"), "recipe_cook_logs", ["recipe_id"], unique=False)
    op.create_index(op.f("ix_recipe_cook_logs_meal_log_id"), "recipe_cook_logs", ["meal_log_id"], unique=False)
    op.create_index(op.f("ix_recipe_cook_logs_cook_date"), "recipe_cook_logs", ["cook_date"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_recipe_cook_logs_cook_date"), table_name="recipe_cook_logs")
    op.drop_index(op.f("ix_recipe_cook_logs_meal_log_id"), table_name="recipe_cook_logs")
    op.drop_index(op.f("ix_recipe_cook_logs_recipe_id"), table_name="recipe_cook_logs")
    op.drop_index(op.f("ix_recipe_cook_logs_family_id"), table_name="recipe_cook_logs")
    op.drop_table("recipe_cook_logs")
