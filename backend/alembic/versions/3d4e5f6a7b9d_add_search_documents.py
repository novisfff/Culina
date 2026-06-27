"""add search documents

Revision ID: 3d4e5f6a7b9d
Revises: 2c3d4e5f6a7b
Create Date: 2026-06-27 00:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "3d4e5f6a7b9d"
down_revision = "2c3d4e5f6a7b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "search_documents",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("title_text", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("keyword_text", sa.Text(), nullable=False),
        sa.Column("detail_text", sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql"), nullable=False),
        sa.Column("semantic_text", sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql"), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("document_builder_version", sa.String(length=32), nullable=False),
        sa.Column("embedding_model", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("embedding_dimensions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("vector_status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("vector_error", sa.Text(), nullable=True),
        sa.Column("vector_attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_vector_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("family_id", "entity_type", "entity_id", name="uq_search_documents_entity"),
    )
    op.create_index("ix_search_documents_family_id", "search_documents", ["family_id"])
    op.create_index("ix_search_documents_family_scope", "search_documents", ["family_id", "entity_type", "updated_at"])
    op.create_index(
        "ix_search_documents_vector_status",
        "search_documents",
        ["vector_status", "last_vector_attempt_at", "updated_at"],
    )
    if op.get_bind().dialect.name == "mysql":
        op.execute("CREATE FULLTEXT INDEX ft_search_documents_title ON search_documents (title_text) WITH PARSER ngram")
        op.execute("CREATE FULLTEXT INDEX ft_search_documents_keyword ON search_documents (keyword_text) WITH PARSER ngram")
        op.execute("CREATE FULLTEXT INDEX ft_search_documents_detail ON search_documents (detail_text) WITH PARSER ngram")


def downgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.execute("DROP INDEX ft_search_documents_detail ON search_documents")
        op.execute("DROP INDEX ft_search_documents_keyword ON search_documents")
        op.execute("DROP INDEX ft_search_documents_title ON search_documents")
    op.drop_index("ix_search_documents_vector_status", table_name="search_documents")
    op.drop_index("ix_search_documents_family_scope", table_name="search_documents")
    op.drop_index("ix_search_documents_family_id", table_name="search_documents")
    op.drop_table("search_documents")
