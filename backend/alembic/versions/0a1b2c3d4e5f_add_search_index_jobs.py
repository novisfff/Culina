"""add search index jobs

Revision ID: 0a1b2c3d4e5f
Revises: 3d4e5f6a7b9d
Create Date: 2026-06-28 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "0a1b2c3d4e5f"
down_revision = "3d4e5f6a7b9d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE search_documents SET vector_attempt_count = 0 WHERE vector_attempt_count IS NULL")
    op.create_table(
        "search_index_jobs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("target_name", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("vector_status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_search_index_jobs_completed_at"), "search_index_jobs", ["completed_at"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_created_at"), "search_index_jobs", ["created_at"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_entity_id"), "search_index_jobs", ["entity_id"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_entity_type"), "search_index_jobs", ["entity_type"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_family_id"), "search_index_jobs", ["family_id"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_locked_at"), "search_index_jobs", ["locked_at"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_status"), "search_index_jobs", ["status"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_user_id"), "search_index_jobs", ["user_id"], unique=False)
    op.create_index(op.f("ix_search_index_jobs_vector_status"), "search_index_jobs", ["vector_status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_search_index_jobs_vector_status"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_user_id"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_status"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_locked_at"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_family_id"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_entity_type"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_entity_id"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_created_at"), table_name="search_index_jobs")
    op.drop_index(op.f("ix_search_index_jobs_completed_at"), table_name="search_index_jobs")
    op.drop_table("search_index_jobs")
