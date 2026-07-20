"""Unify recipe favorites with linked food favorites.

Revision ID: 0b1c2d3e4f5a
Revises: fb0c1d2e3f4a
"""

from alembic import op
import sqlalchemy as sa

revision = "0b1c2d3e4f5a"
down_revision = ("fb0c1d2e3f4a", "5a6b7c8d9e0f")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE foods JOIN recipe_favorites ON recipe_favorites.family_id = foods.family_id AND recipe_favorites.recipe_id = foods.recipe_id SET foods.favorite = 1")
    op.execute(
        "UPDATE ai_approval_requests "
        "JOIN ai_task_drafts ON ai_task_drafts.id = ai_approval_requests.draft_id "
        "SET ai_approval_requests.status = 'cancelled', "
        "ai_approval_requests.decision = 'rejected', "
        "ai_approval_requests.comment = '菜谱收藏已迁移为食物收藏，请在对应食物中重新操作', "
        "ai_approval_requests.resolved_at = UTC_TIMESTAMP(), "
        "ai_task_drafts.status = 'rejected' "
        "WHERE ai_approval_requests.status = 'pending' "
        "AND ai_task_drafts.status IN ('pending', 'pending_retry') "
        "AND ai_task_drafts.draft_type = 'recipe' "
        "AND JSON_UNQUOTE(JSON_EXTRACT(ai_task_drafts.payload, '$.action')) = 'set_favorite'"
    )
    op.drop_index("ix_recipe_favorites_user_id", table_name="recipe_favorites")
    op.drop_index("ix_recipe_favorites_recipe_id", table_name="recipe_favorites")
    op.drop_index("ix_recipe_favorites_family_id", table_name="recipe_favorites")
    op.drop_table("recipe_favorites")


def downgrade() -> None:
    op.create_table(
        "recipe_favorites",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("recipe_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipe_id"], ["recipes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "recipe_id", name="uq_recipe_favorites_user_recipe"),
    )
    op.create_index("ix_recipe_favorites_family_id", "recipe_favorites", ["family_id"], unique=False)
    op.create_index("ix_recipe_favorites_recipe_id", "recipe_favorites", ["recipe_id"], unique=False)
    op.create_index("ix_recipe_favorites_user_id", "recipe_favorites", ["user_id"], unique=False)
