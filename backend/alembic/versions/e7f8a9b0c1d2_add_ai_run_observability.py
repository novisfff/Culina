"""add ai run observability

Revision ID: e7f8a9b0c1d2
Revises: a2b3c4d5e6f8
Create Date: 2026-06-25 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "e7f8a9b0c1d2"
down_revision = "a2b3c4d5e6f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_run_trace_spans",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=True),
        sa.Column("trace_id", sa.String(length=64), nullable=False),
        sa.Column("span_id", sa.String(length=64), nullable=False),
        sa.Column("parent_span_id", sa.String(length=64), nullable=True),
        sa.Column("span_type", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("round_index", sa.Integer(), nullable=True),
        sa.Column("attempt_index", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("input_summary", sa.JSON(), nullable=False),
        sa.Column("output_summary", sa.JSON(), nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("exception_type", sa.String(length=120), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_run_trace_spans_attempt_index"), "ai_run_trace_spans", ["attempt_index"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_conversation_id"), "ai_run_trace_spans", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_error_code"), "ai_run_trace_spans", ["error_code"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_family_id"), "ai_run_trace_spans", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_parent_span_id"), "ai_run_trace_spans", ["parent_span_id"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_round_index"), "ai_run_trace_spans", ["round_index"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_run_id"), "ai_run_trace_spans", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_span_id"), "ai_run_trace_spans", ["span_id"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_span_type"), "ai_run_trace_spans", ["span_type"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_status"), "ai_run_trace_spans", ["status"], unique=False)
    op.create_index(op.f("ix_ai_run_trace_spans_trace_id"), "ai_run_trace_spans", ["trace_id"], unique=False)
    op.create_index(
        "ix_ai_run_trace_spans_family_run_started",
        "ai_run_trace_spans",
        ["family_id", "run_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_trace_spans_trace_started",
        "ai_run_trace_spans",
        ["trace_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_trace_spans_run_type_started",
        "ai_run_trace_spans",
        ["run_id", "span_type", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_trace_spans_run_status_started",
        "ai_run_trace_spans",
        ["run_id", "status", "started_at"],
        unique=False,
    )

    op.create_table(
        "ai_run_llm_exchanges",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=True),
        sa.Column("trace_id", sa.String(length=64), nullable=False),
        sa.Column("span_id", sa.String(length=64), nullable=True),
        sa.Column("provider_round", sa.Integer(), nullable=False),
        sa.Column("attempt_index", sa.Integer(), nullable=False),
        sa.Column("mode", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("request_messages", sa.JSON(), nullable=False),
        sa.Column("request_tools", sa.JSON(), nullable=False),
        sa.Column("request_options", sa.JSON(), nullable=False),
        sa.Column("request_digest", sa.String(length=64), nullable=False),
        sa.Column("request_bytes", sa.Integer(), nullable=False),
        sa.Column("request_truncated", sa.Boolean(), nullable=False),
        sa.Column("response_message", sa.JSON(), nullable=False),
        sa.Column("response_text", sa.Text(), nullable=True),
        sa.Column("response_tool_calls", sa.JSON(), nullable=False),
        sa.Column("stream_chunks", sa.JSON(), nullable=False),
        sa.Column("response_digest", sa.String(length=64), nullable=False),
        sa.Column("response_bytes", sa.Integer(), nullable=False),
        sa.Column("response_truncated", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_ai_run_llm_exchanges_attempt_index"), "ai_run_llm_exchanges", ["attempt_index"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_conversation_id"), "ai_run_llm_exchanges", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_error_code"), "ai_run_llm_exchanges", ["error_code"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_family_id"), "ai_run_llm_exchanges", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_provider_round"), "ai_run_llm_exchanges", ["provider_round"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_run_id"), "ai_run_llm_exchanges", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_span_id"), "ai_run_llm_exchanges", ["span_id"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_status"), "ai_run_llm_exchanges", ["status"], unique=False)
    op.create_index(op.f("ix_ai_run_llm_exchanges_trace_id"), "ai_run_llm_exchanges", ["trace_id"], unique=False)
    op.create_index(
        "ix_ai_run_llm_exchanges_family_run_round_attempt",
        "ai_run_llm_exchanges",
        ["family_id", "run_id", "provider_round", "attempt_index"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_llm_exchanges_trace_round_attempt",
        "ai_run_llm_exchanges",
        ["trace_id", "provider_round", "attempt_index"],
        unique=False,
    )
    op.create_index(
        "ix_ai_run_llm_exchanges_run_status_started",
        "ai_run_llm_exchanges",
        ["run_id", "status", "started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_run_llm_exchanges_run_status_started", table_name="ai_run_llm_exchanges")
    op.drop_index("ix_ai_run_llm_exchanges_trace_round_attempt", table_name="ai_run_llm_exchanges")
    op.drop_index("ix_ai_run_llm_exchanges_family_run_round_attempt", table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_trace_id"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_status"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_span_id"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_run_id"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_provider_round"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_family_id"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_error_code"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_conversation_id"), table_name="ai_run_llm_exchanges")
    op.drop_index(op.f("ix_ai_run_llm_exchanges_attempt_index"), table_name="ai_run_llm_exchanges")
    op.drop_table("ai_run_llm_exchanges")

    op.drop_index("ix_ai_run_trace_spans_run_status_started", table_name="ai_run_trace_spans")
    op.drop_index("ix_ai_run_trace_spans_run_type_started", table_name="ai_run_trace_spans")
    op.drop_index("ix_ai_run_trace_spans_trace_started", table_name="ai_run_trace_spans")
    op.drop_index("ix_ai_run_trace_spans_family_run_started", table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_trace_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_status"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_span_type"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_span_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_run_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_round_index"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_parent_span_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_family_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_error_code"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_conversation_id"), table_name="ai_run_trace_spans")
    op.drop_index(op.f("ix_ai_run_trace_spans_attempt_index"), table_name="ai_run_trace_spans")
    op.drop_table("ai_run_trace_spans")
