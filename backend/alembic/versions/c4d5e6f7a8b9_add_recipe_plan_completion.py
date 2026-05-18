"""add recipe plan completion

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a8
Create Date: 2026-05-14 15:25:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "c4d5e6f7a8b9"
down_revision = "b2c3d4e5f6a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("recipe_plan_items", sa.Column("status", sa.String(length=32), nullable=False, server_default="planned"))
    op.add_column("recipe_plan_items", sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("recipe_plan_items", sa.Column("meal_log_id", sa.String(length=64), nullable=True))
    op.create_index(op.f("ix_recipe_plan_items_meal_log_id"), "recipe_plan_items", ["meal_log_id"], unique=False)
    op.create_foreign_key(
        "fk_recipe_plan_items_meal_log_id_meal_logs",
        "recipe_plan_items",
        "meal_logs",
        ["meal_log_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.alter_column("recipe_plan_items", "status", server_default=None)


def downgrade() -> None:
    op.drop_constraint("fk_recipe_plan_items_meal_log_id_meal_logs", "recipe_plan_items", type_="foreignkey")
    op.drop_index(op.f("ix_recipe_plan_items_meal_log_id"), table_name="recipe_plan_items")
    op.drop_column("recipe_plan_items", "meal_log_id")
    op.drop_column("recipe_plan_items", "completed_at")
    op.drop_column("recipe_plan_items", "status")
