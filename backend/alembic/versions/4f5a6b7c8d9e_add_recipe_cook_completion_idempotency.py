"""add recipe cook completion idempotency

Revision ID: 4f5a6b7c8d9e
Revises: 4a5b6c7d8e9f
"""

from alembic import op
import sqlalchemy as sa


revision = "4f5a6b7c8d9e"
down_revision = "4a5b6c7d8e9f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "recipe_cook_logs",
        sa.Column("completion_request_id", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "recipe_cook_logs",
        sa.Column("completion_request_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "recipe_cook_logs",
        sa.Column("completion_result_json", sa.JSON(), nullable=True),
    )
    op.create_unique_constraint(
        "uq_recipe_cook_logs_family_completion_request",
        "recipe_cook_logs",
        ["family_id", "completion_request_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_recipe_cook_logs_family_completion_request",
        "recipe_cook_logs",
        type_="unique",
    )
    op.drop_column("recipe_cook_logs", "completion_result_json")
    op.drop_column("recipe_cook_logs", "completion_request_hash")
    op.drop_column("recipe_cook_logs", "completion_request_id")
