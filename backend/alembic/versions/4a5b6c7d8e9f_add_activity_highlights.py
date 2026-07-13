"""add activity highlights

Revision ID: 4a5b6c7d8e9f
Revises: 3f4a5b6c7d8e
"""

from alembic import op
import sqlalchemy as sa

revision = "4a5b6c7d8e9f"
down_revision = "3f4a5b6c7d8e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "activity_logs",
        sa.Column(
            "highlight_kind",
            sa.Enum(
                "SHOPPING",
                "INVENTORY",
                "MEAL_PLAN",
                "MEAL",
                "FAMILY",
                name="activityhighlightkind",
                native_enum=False,
            ),
            nullable=True,
        ),
    )
    op.add_column("activity_logs", sa.Column("highlight_summary", sa.String(length=255), nullable=True))
    op.create_check_constraint(
        "ck_activity_logs_highlight_pair",
        "activity_logs",
        "(highlight_kind IS NULL AND highlight_summary IS NULL) OR "
        "(highlight_kind IS NOT NULL AND highlight_summary IS NOT NULL)",
    )
    op.create_index(
        "ix_activity_logs_family_created_highlight",
        "activity_logs",
        ["family_id", "created_at", "highlight_kind"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_activity_logs_family_created_highlight", table_name="activity_logs")
    op.drop_constraint("ck_activity_logs_highlight_pair", "activity_logs", type_="check")
    op.drop_column("activity_logs", "highlight_summary")
    op.drop_column("activity_logs", "highlight_kind")
