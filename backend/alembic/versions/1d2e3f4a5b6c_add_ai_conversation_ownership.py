"""Add AI conversation ownership and visibility."""

from alembic import op
import sqlalchemy as sa

revision = "1d2e3f4a5b6c"
down_revision = "0c1d2e3f4a5b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_conversations", sa.Column("owner_user_id", sa.String(length=64), nullable=True))
    op.add_column(
        "ai_conversations",
        sa.Column(
            "visibility",
            sa.Enum("PRIVATE", "FAMILY", name="aiconversationvisibility", native_enum=False),
            nullable=False,
            server_default="PRIVATE",
        ),
    )
    op.execute(
        sa.text(
            "UPDATE ai_conversations AS c "
            "INNER JOIN users AS u ON u.id = c.created_by "
            "SET c.owner_user_id = c.created_by"
        )
    )
    op.create_foreign_key(
        "fk_ai_conversations_owner_user_id_users",
        "ai_conversations",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_ai_conversations_owner_user_id", "ai_conversations", ["owner_user_id"])
    op.create_index(
        "ix_ai_conversations_family_owner_recent",
        "ai_conversations",
        ["family_id", "owner_user_id", "last_message_at", "created_at"],
    )
    op.create_index(
        "ix_ai_conversations_family_visibility_recent",
        "ai_conversations",
        ["family_id", "visibility", "last_message_at", "created_at"],
    )
    op.alter_column("ai_conversations", "visibility", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_ai_conversations_family_visibility_recent", table_name="ai_conversations")
    op.drop_index("ix_ai_conversations_family_owner_recent", table_name="ai_conversations")
    op.drop_index("ix_ai_conversations_owner_user_id", table_name="ai_conversations")
    op.drop_constraint("fk_ai_conversations_owner_user_id_users", "ai_conversations", type_="foreignkey")
    op.drop_column("ai_conversations", "visibility")
    op.drop_column("ai_conversations", "owner_user_id")
