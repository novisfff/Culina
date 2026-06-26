"""drop ai observability foreign keys

Revision ID: f9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-06-26 09:55:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "f9b0c1d2e3f4"
down_revision = "f8a9b0c1d2e3"
branch_labels = None
depends_on = None


OBSERVABILITY_FOREIGN_KEYS = {
    "ai_run_trace_spans": {
        ("family_id",),
        ("run_id",),
        ("conversation_id",),
    },
    "ai_run_llm_exchanges": {
        ("family_id",),
        ("run_id",),
        ("conversation_id",),
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table_name, constrained_columns in OBSERVABILITY_FOREIGN_KEYS.items():
        existing_tables = set(inspector.get_table_names())
        if table_name not in existing_tables:
            continue
        for foreign_key in inspector.get_foreign_keys(table_name):
            name = foreign_key.get("name")
            columns = tuple(foreign_key.get("constrained_columns") or [])
            if not name or columns not in constrained_columns:
                continue
            op.drop_constraint(name, table_name, type_="foreignkey")


def downgrade() -> None:
    op.create_foreign_key(
        "fk_ai_run_trace_spans_family_id_families",
        "ai_run_trace_spans",
        "families",
        ["family_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_ai_run_trace_spans_run_id_ai_agent_runs",
        "ai_run_trace_spans",
        "ai_agent_runs",
        ["run_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_ai_run_trace_spans_conversation_id_ai_conversations",
        "ai_run_trace_spans",
        "ai_conversations",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_ai_run_llm_exchanges_family_id_families",
        "ai_run_llm_exchanges",
        "families",
        ["family_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_ai_run_llm_exchanges_run_id_ai_agent_runs",
        "ai_run_llm_exchanges",
        "ai_agent_runs",
        ["run_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_ai_run_llm_exchanges_conversation_id_ai_conversations",
        "ai_run_llm_exchanges",
        "ai_conversations",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )
