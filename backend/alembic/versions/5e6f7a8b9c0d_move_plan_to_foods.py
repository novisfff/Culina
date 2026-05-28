"""move menu plan to foods

Revision ID: 5e6f7a8b9c0d
Revises: 4d5e6f7a8b9c
Create Date: 2026-05-27 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "5e6f7a8b9c0d"
down_revision = "4d5e6f7a8b9c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("recipe_plan_items", "food_plan_items")
    op.add_column("food_plan_items", sa.Column("food_id", sa.String(length=64), nullable=True))
    op.create_index(op.f("ix_food_plan_items_food_id"), "food_plan_items", ["food_id"], unique=False)

    op.execute(
        """
        INSERT INTO foods (
            id, family_id, name, type, category, flavor_tags, scene_tags, suitable_meal_types,
            source_name, purchase_source, scene, notes, routine_note, favorite, recipe_id,
            created_at, updated_at, created_by, updated_by
        )
        SELECT
            CONCAT('food-', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 12)),
            r.family_id,
            r.title,
            'selfMade',
            '家常菜',
            JSON_ARRAY(),
            COALESCE(r.scene_tags, JSON_ARRAY()),
            JSON_ARRAY('dinner'),
            '家庭厨房',
            '家庭厨房',
            '日常',
            COALESCE(r.tips, ''),
            '',
            FALSE,
            r.id,
            NOW(),
            NOW(),
            r.created_by,
            r.updated_by
        FROM recipes r
        LEFT JOIN foods f ON f.recipe_id = r.id
        WHERE f.id IS NULL
          AND EXISTS (SELECT 1 FROM food_plan_items p WHERE p.recipe_id = r.id)
        """
    )
    op.execute(
        """
        UPDATE food_plan_items p
        JOIN foods f ON f.recipe_id = p.recipe_id
        SET p.food_id = f.id
        WHERE p.food_id IS NULL
        """
    )
    op.alter_column("food_plan_items", "food_id", existing_type=sa.String(length=64), nullable=False)
    op.alter_column("food_plan_items", "recipe_id", existing_type=sa.String(length=64), nullable=True)
    op.create_foreign_key(
        "fk_food_plan_items_food_id_foods",
        "food_plan_items",
        "foods",
        ["food_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(op.f("ix_food_plan_items_family_id"), "food_plan_items", ["family_id"], unique=False)
    op.create_index(op.f("ix_food_plan_items_plan_date"), "food_plan_items", ["plan_date"], unique=False)
    op.create_index(op.f("ix_food_plan_items_user_id"), "food_plan_items", ["user_id"], unique=False)
    op.create_index(op.f("ix_food_plan_items_meal_log_id"), "food_plan_items", ["meal_log_id"], unique=False)


def downgrade() -> None:
    op.drop_constraint("fk_food_plan_items_food_id_foods", "food_plan_items", type_="foreignkey")
    op.drop_index(op.f("ix_food_plan_items_meal_log_id"), table_name="food_plan_items")
    op.drop_index(op.f("ix_food_plan_items_user_id"), table_name="food_plan_items")
    op.drop_index(op.f("ix_food_plan_items_plan_date"), table_name="food_plan_items")
    op.drop_index(op.f("ix_food_plan_items_family_id"), table_name="food_plan_items")
    op.drop_index(op.f("ix_food_plan_items_food_id"), table_name="food_plan_items")
    op.alter_column("food_plan_items", "recipe_id", existing_type=sa.String(length=64), nullable=False)
    op.drop_column("food_plan_items", "food_id")
    op.rename_table("food_plan_items", "recipe_plan_items")
