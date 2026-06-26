"""add ai llm exchange digest metadata

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-06-26 09:45:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "f8a9b0c1d2e3"
down_revision = "e7f8a9b0c1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_run_llm_exchanges",
        sa.Column("request_original_digest", sa.String(length=64), nullable=False, server_default=""),
    )
    op.add_column(
        "ai_run_llm_exchanges",
        sa.Column("request_original_bytes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "ai_run_llm_exchanges",
        sa.Column("response_original_digest", sa.String(length=64), nullable=False, server_default=""),
    )
    op.add_column(
        "ai_run_llm_exchanges",
        sa.Column("response_original_bytes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_ai_run_llm_exchanges_family_run_started",
        "ai_run_llm_exchanges",
        ["family_id", "run_id", "started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_run_llm_exchanges_family_run_started", table_name="ai_run_llm_exchanges")
    op.drop_column("ai_run_llm_exchanges", "response_original_bytes")
    op.drop_column("ai_run_llm_exchanges", "response_original_digest")
    op.drop_column("ai_run_llm_exchanges", "request_original_bytes")
    op.drop_column("ai_run_llm_exchanges", "request_original_digest")
