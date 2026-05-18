"""add ai generation metadata to media assets

Revision ID: 9e8f4a1b2c3d
Revises: 7897b69a5088
Create Date: 2026-03-24 15:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "9e8f4a1b2c3d"
down_revision = "7897b69a5088"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "media_assets",
        sa.Column(
            "generation_mode",
            sa.Enum("REFERENCE", "TEXT", name="imagegenerationmode", native_enum=False),
            nullable=True,
        ),
    )
    op.add_column("media_assets", sa.Column("reference_media_id", sa.String(length=64), nullable=True))
    op.add_column("media_assets", sa.Column("style_key", sa.String(length=120), nullable=True))
    op.add_column("media_assets", sa.Column("prompt_version", sa.String(length=32), nullable=True))
    op.create_index(op.f("ix_media_assets_reference_media_id"), "media_assets", ["reference_media_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_media_assets_reference_media_id"), table_name="media_assets")
    op.drop_column("media_assets", "prompt_version")
    op.drop_column("media_assets", "style_key")
    op.drop_column("media_assets", "reference_media_id")
    op.drop_column("media_assets", "generation_mode")
