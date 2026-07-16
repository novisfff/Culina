"""add meal record operations

Revision ID: 5a6b7c8d9e0f
Revises: 4f5a6b7c8d9e
"""

from alembic import op
import sqlalchemy as sa


revision = "5a6b7c8d9e0f"
down_revision = "4f5a6b7c8d9e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "meal_logs",
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index(
        "ix_meal_logs_family_date_type_created",
        "meal_logs",
        ["family_id", "date", "meal_type", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_meal_log_foods_log_food",
        "meal_log_foods",
        ["meal_log_id", "food_id"],
        unique=False,
    )
    op.create_table(
        "meal_log_record_operations",
        sa.Column("id", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("client_request_id", sa.String(length=120), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("target_kind", sa.String(length=32), nullable=False),
        sa.Column("meal_log_id", sa.String(length=64), nullable=False),
        sa.Column("created_entry_ids_json", sa.JSON(), nullable=False),
        sa.Column("created_food_ids_json", sa.JSON(), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("revert_result_json", sa.JSON(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revertible_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reverted_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "family_id",
            "client_request_id",
            name="uq_meal_log_record_operations_family_request",
        ),
    )
    op.create_index(
        "ix_meal_log_record_operations_family_status_revertible",
        "meal_log_record_operations",
        ["family_id", "status", "revertible_until"],
        unique=False,
    )
    op.create_index(
        "ix_meal_log_record_operations_family_actor_applied",
        "meal_log_record_operations",
        ["family_id", "created_by", "applied_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_meal_log_record_operations_family_actor_applied",
        table_name="meal_log_record_operations",
    )
    op.drop_index(
        "ix_meal_log_record_operations_family_status_revertible",
        table_name="meal_log_record_operations",
    )
    op.drop_table("meal_log_record_operations")
    op.drop_index("ix_meal_log_foods_log_food", table_name="meal_log_foods")
    op.drop_index("ix_meal_logs_family_date_type_created", table_name="meal_logs")
    op.drop_column("meal_logs", "row_version")
