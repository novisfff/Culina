"""add AI message idempotency constraint

Revision ID: a0b1c2d3e4f5
Revises: 9f0a1b2c3d4e
"""

from alembic import op


revision = "a0b1c2d3e4f5"
down_revision = "9f0a1b2c3d4e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_ai_messages_family_client_message",
        "ai_messages",
        ["family_id", "client_message_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_ai_messages_family_client_message",
        "ai_messages",
        type_="unique",
    )
