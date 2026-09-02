"""Add the canonical append-only AI conversation timeline.

Revision ID: a3b4c5d6e7f8
Revises: 9d0e1f2a3b4c
Create Date: 2026-09-03 10:00:00.000000
"""

from __future__ import annotations

import hashlib

from alembic import op
import sqlalchemy as sa


revision = "a3b4c5d6e7f8"
down_revision = "9d0e1f2a3b4c"
branch_labels = None
depends_on = None


def _make_legacy_event_id(message_id: str) -> str:
    # Message ids are user-controlled only indirectly and may already consume
    # the full 64-character column.  A fixed digest keeps the migration within
    # the event-id limit without relying on truncation collisions.
    digest = hashlib.sha256(message_id.encode("utf-8")).hexdigest()[:48]
    return f"legacy-event-{digest}"


def _set_not_null(table_name: str, column_name: str, column_type: sa.types.TypeEngine) -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        # SQLite cannot alter nullability in place.  Alembic's batch mode
        # recreates the table while preserving existing rows and indexes.
        with op.batch_alter_table(table_name, recreate="always") as batch:
            batch.alter_column(column_name, existing_type=column_type, nullable=False)
        return
    op.alter_column(
        table_name,
        column_name,
        existing_type=column_type,
        nullable=False,
    )


def _backfill_message_positions_and_events() -> None:
    bind = op.get_bind()
    conversations = sa.table(
        "ai_conversations",
        sa.column("id", sa.String(64)),
        sa.column("timeline_version", sa.BigInteger()),
    )
    messages = sa.table(
        "ai_messages",
        sa.column("id", sa.String(64)),
        sa.column("family_id", sa.String(64)),
        sa.column("conversation_id", sa.String(64)),
        sa.column("role", sa.String(32)),
        sa.column("content", sa.Text()),
        sa.column("content_type", sa.String(32)),
        sa.column("parts", sa.JSON()),
        sa.column("run_id", sa.String(64)),
        sa.column("status", sa.String(32)),
        sa.column("metadata", sa.JSON()),
        sa.column("client_message_id", sa.String(120)),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("created_by", sa.String(64)),
    )
    events = sa.table(
        "ai_conversation_events",
        sa.column("id", sa.String(64)),
        sa.column("family_id", sa.String(64)),
        sa.column("conversation_id", sa.String(64)),
        sa.column("run_id", sa.String(64)),
        sa.column("message_id", sa.String(64)),
        sa.column("sequence", sa.BigInteger()),
        sa.column("event_type", sa.String(64)),
        sa.column("operation", sa.String(32)),
        sa.column("part_id", sa.String(128)),
        sa.column("payload", sa.JSON()),
        sa.column("is_terminal", sa.Boolean()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("created_by", sa.String(64)),
    )

    rows = bind.execute(
        sa.select(messages).order_by(
            messages.c.conversation_id,
            messages.c.created_at,
            messages.c.id,
        )
    ).mappings().all()
    next_sequence_by_conversation: dict[str, int] = {}
    max_sequence_by_conversation: dict[str, int] = {}
    for row in rows:
        conversation_id = str(row["conversation_id"])
        sequence = next_sequence_by_conversation.get(conversation_id, 0) + 1
        next_sequence_by_conversation[conversation_id] = sequence
        max_sequence_by_conversation[conversation_id] = sequence
        bind.execute(
            sa.text(
                "UPDATE ai_messages SET timeline_position = :position, "
                "snapshot_sequence = :snapshot_sequence WHERE id = :message_id"
            ),
            {
                "position": sequence,
                "snapshot_sequence": sequence,
                "message_id": row["id"],
            },
        )
        payload = {
            "message": {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "role": row["role"],
                "content": row["content"],
                "content_type": row["content_type"],
                "parts": row["parts"] or [],
                "run_id": row["run_id"],
                "status": row["status"],
                "metadata": row["metadata"] or {},
                "client_message_id": row["client_message_id"],
                "created_at": row["created_at"].isoformat() if row["created_at"] is not None else None,
                "timeline_position": sequence,
                "snapshot_sequence": sequence,
            }
        }
        bind.execute(
            events.insert().values(
                id=_make_legacy_event_id(str(row["id"])),
                family_id=row["family_id"],
                conversation_id=conversation_id,
                run_id=row["run_id"],
                message_id=row["id"],
                sequence=sequence,
                event_type="message.created",
                operation="append",
                part_id=None,
                payload=payload,
                is_terminal=False,
                created_at=row["created_at"],
                created_by=row["created_by"],
            )
        )

    for conversation_id, sequence in max_sequence_by_conversation.items():
        bind.execute(
            sa.text(
                "UPDATE ai_conversations SET timeline_version = :timeline_version "
                "WHERE id = :conversation_id"
            ),
            {"timeline_version": sequence, "conversation_id": conversation_id},
        )


def upgrade() -> None:
    op.add_column(
        "ai_conversations",
        sa.Column("timeline_version", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column("ai_messages", sa.Column("timeline_position", sa.BigInteger(), nullable=True))
    op.add_column("ai_messages", sa.Column("snapshot_sequence", sa.BigInteger(), server_default=sa.text("0"), nullable=True))
    op.add_column("ai_run_events", sa.Column("timeline_event_id", sa.String(length=64), nullable=True))
    op.add_column("ai_run_events", sa.Column("timeline_sequence", sa.BigInteger(), nullable=True))
    op.create_index("ix_ai_messages_timeline_position", "ai_messages", ["timeline_position"], unique=False)
    op.create_index("ix_ai_run_events_timeline_event_id", "ai_run_events", ["timeline_event_id"], unique=False)
    op.create_index("ix_ai_run_events_timeline_sequence", "ai_run_events", ["timeline_sequence"], unique=False)

    op.create_table(
        "ai_conversation_events",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("message_id", sa.String(length=64), nullable=True),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=32), nullable=False),
        sa.Column("part_id", sa.String(length=128), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("is_terminal", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["ai_agent_runs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["message_id"], ["ai_messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "conversation_id",
            "sequence",
            name="uq_ai_conversation_events_conversation_sequence",
        ),
    )
    op.create_index(
        "ix_ai_conversation_events_family_id",
        "ai_conversation_events",
        ["family_id"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_conversation_id",
        "ai_conversation_events",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_run_id",
        "ai_conversation_events",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_message_id",
        "ai_conversation_events",
        ["message_id"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_conversation_sequence",
        "ai_conversation_events",
        ["conversation_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_run_sequence",
        "ai_conversation_events",
        ["run_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_ai_conversation_events_message_sequence",
        "ai_conversation_events",
        ["message_id", "sequence"],
        unique=False,
    )

    _backfill_message_positions_and_events()
    _set_not_null("ai_messages", "timeline_position", sa.BigInteger())
    _set_not_null("ai_messages", "snapshot_sequence", sa.BigInteger())


def downgrade() -> None:
    op.drop_index("ix_ai_conversation_events_message_sequence", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_run_sequence", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_conversation_sequence", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_message_id", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_run_id", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_conversation_id", table_name="ai_conversation_events")
    op.drop_index("ix_ai_conversation_events_family_id", table_name="ai_conversation_events")
    op.drop_table("ai_conversation_events")

    op.drop_index("ix_ai_run_events_timeline_sequence", table_name="ai_run_events")
    op.drop_index("ix_ai_run_events_timeline_event_id", table_name="ai_run_events")
    op.drop_column("ai_run_events", "timeline_sequence")
    op.drop_column("ai_run_events", "timeline_event_id")
    op.drop_index("ix_ai_messages_timeline_position", table_name="ai_messages")
    op.drop_column("ai_messages", "snapshot_sequence")
    op.drop_column("ai_messages", "timeline_position")
    op.drop_column("ai_conversations", "timeline_version")
