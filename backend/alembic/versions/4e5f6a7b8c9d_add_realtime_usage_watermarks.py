"""add realtime usage watermarks

Revision ID: 4e5f6a7b8c9d
Revises: 3e4f5a6b7c8d
Create Date: 2026-07-30 13:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "4e5f6a7b8c9d"
down_revision = "3e4f5a6b7c8d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "model_usage_realtime_watermarks",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("session_key", sa.String(length=96), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column(
            "meter",
            sa.Enum(
                "input_tokens",
                "uncached_input_tokens",
                "cached_input_tokens",
                "output_tokens",
                "total_tokens",
                "embedding_tokens",
                "rerank_requests",
                "rerank_documents",
                "audio_input_seconds",
                "audio_output_seconds",
                "audio_input_tokens",
                "audio_output_tokens",
                "tts_characters",
                "tts_tokens",
                "generated_images",
                "request_units",
                name="modelusagemeter",
                native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("cumulative_quantity", sa.Numeric(precision=30, scale=6), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "family_id",
            "period_start",
            "session_key",
            "provider",
            "meter",
            name="uq_model_usage_realtime_watermark",
        ),
    )
    op.create_index(
        "ix_model_usage_realtime_watermark_family_period",
        "model_usage_realtime_watermarks",
        ["family_id", "period_start"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_model_usage_realtime_watermark_family_period",
        table_name="model_usage_realtime_watermarks",
    )
    op.drop_table("model_usage_realtime_watermarks")
