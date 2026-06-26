"""add ai trace token usage

Revision ID: 2c3d4e5f6a7b
Revises: 1b2c3d4e5f70
Create Date: 2026-06-27 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "2c3d4e5f6a7b"
down_revision = "1b2c3d4e5f70"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_run_llm_exchanges", sa.Column("input_tokens", sa.Integer(), nullable=True))
    op.add_column("ai_run_llm_exchanges", sa.Column("output_tokens", sa.Integer(), nullable=True))
    op.add_column("ai_run_llm_exchanges", sa.Column("total_tokens", sa.Integer(), nullable=True))
    op.add_column("ai_run_llm_exchanges", sa.Column("cached_tokens", sa.Integer(), nullable=True))
    op.add_column("ai_run_llm_exchanges", sa.Column("estimated_cost_usd", sa.Float(), nullable=True))
    op.add_column("ai_run_llm_exchanges", sa.Column("token_usage", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("ai_run_llm_exchanges", "token_usage")
    op.drop_column("ai_run_llm_exchanges", "estimated_cost_usd")
    op.drop_column("ai_run_llm_exchanges", "cached_tokens")
    op.drop_column("ai_run_llm_exchanges", "total_tokens")
    op.drop_column("ai_run_llm_exchanges", "output_tokens")
    op.drop_column("ai_run_llm_exchanges", "input_tokens")
