"""Add generation fences to profile documents and search jobs.

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
Create Date: 2026-09-04 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b4c5d6e7f8a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "family_search_profile_documents",
        sa.Column("generation", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "search_index_jobs",
        sa.Column("document_generation", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("search_index_jobs", "document_generation")
    op.drop_column("family_search_profile_documents", "generation")
