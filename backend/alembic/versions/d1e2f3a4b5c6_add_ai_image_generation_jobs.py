"""add ai image generation jobs

Revision ID: d1e2f3a4b5c6
Revises: c1d2e3f4a5b6
Create Date: 2026-06-17 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "d1e2f3a4b5c6"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_image_generation_jobs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("request_payload", sa.JSON(), nullable=False),
        sa.Column("reference_media_id", sa.String(length=64), nullable=True),
        sa.Column("target_entity_type", sa.String(length=64), nullable=True),
        sa.Column("target_entity_id", sa.String(length=64), nullable=True),
        sa.Column("replace_anchor_media_id", sa.String(length=64), nullable=True),
        sa.Column("generated_media_id", sa.String(length=64), nullable=True),
        sa.Column("bind_status", sa.String(length=32), nullable=True),
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
    op.create_index(op.f("ix_ai_image_generation_jobs_bind_status"), "ai_image_generation_jobs", ["bind_status"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_completed_at"), "ai_image_generation_jobs", ["completed_at"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_created_at"), "ai_image_generation_jobs", ["created_at"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_family_id"), "ai_image_generation_jobs", ["family_id"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_generated_media_id"), "ai_image_generation_jobs", ["generated_media_id"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_locked_at"), "ai_image_generation_jobs", ["locked_at"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_reference_media_id"), "ai_image_generation_jobs", ["reference_media_id"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_status"), "ai_image_generation_jobs", ["status"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_target_entity_id"), "ai_image_generation_jobs", ["target_entity_id"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_target_entity_type"), "ai_image_generation_jobs", ["target_entity_type"], unique=False)
    op.create_index(op.f("ix_ai_image_generation_jobs_user_id"), "ai_image_generation_jobs", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_image_generation_jobs_user_id"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_target_entity_type"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_target_entity_id"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_status"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_reference_media_id"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_locked_at"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_generated_media_id"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_family_id"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_created_at"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_completed_at"), table_name="ai_image_generation_jobs")
    op.drop_index(op.f("ix_ai_image_generation_jobs_bind_status"), table_name="ai_image_generation_jobs")
    op.drop_table("ai_image_generation_jobs")
