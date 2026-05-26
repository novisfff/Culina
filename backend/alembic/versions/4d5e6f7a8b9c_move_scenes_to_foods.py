"""move scene tags from recipes to foods

Revision ID: 4d5e6f7a8b9c
Revises: 3c4d5e6f7a8b
Create Date: 2026-05-25 00:00:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import text


revision = "4d5e6f7a8b9c"
down_revision = "3c4d5e6f7a8b"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False
    columns = sa.inspect(op.get_bind()).get_columns(table_name)
    return any(column["name"] == column_name for column in columns)


def _has_index(table_name: str, index_name: str) -> bool:
    if not _has_table(table_name):
        return False
    inspector = sa.inspect(op.get_bind())
    indexes = inspector.get_indexes(table_name)
    unique_constraints = inspector.get_unique_constraints(table_name)
    return any(index["name"] == index_name for index in indexes) or any(
        constraint["name"] == index_name for constraint in unique_constraints
    )


def _rename_index(table_name: str, old_name: str, new_name: str) -> None:
    if _has_index(table_name, new_name) or not _has_index(table_name, old_name):
        return

    dialect_name = op.get_bind().dialect.name
    if dialect_name == "mysql":
        op.execute(f"ALTER TABLE `{table_name}` RENAME INDEX `{old_name}` TO `{new_name}`")
    else:
        op.execute(f'ALTER INDEX IF EXISTS "{old_name}" RENAME TO "{new_name}"')


def _ensure_unique_constraint(table_name: str, constraint_name: str, columns: list[str]) -> None:
    if not _has_index(table_name, constraint_name):
        op.create_unique_constraint(constraint_name, table_name, columns)


def _drop_unique_constraint(table_name: str, constraint_name: str) -> None:
    if _has_index(table_name, constraint_name):
        op.drop_constraint(constraint_name, table_name, type_="unique")


def _loads(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        raw = value
    else:
        try:
            raw = json.loads(str(value))
        except json.JSONDecodeError:
            raw = []
    tags: list[str] = []
    for item in raw:
        tag = str(item).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _merge(*groups: list[str], single: str | None = None) -> list[str]:
    tags: list[str] = []
    for group in groups:
        for tag in group:
            if tag and tag not in tags:
                tags.append(tag)
    if single:
        for part in single.replace("/", "、").replace(",", "、").split("、"):
            tag = part.strip()
            if tag and tag not in tags:
                tags.append(tag)
    return tags


def upgrade() -> None:
    if not _has_column("foods", "scene_tags"):
        op.add_column("foods", sa.Column("scene_tags", sa.JSON(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(
        text(
            """
            SELECT foods.id, foods.scene, foods.flavor_tags, recipes.scene_tags AS recipe_scene_tags
            FROM foods
            LEFT JOIN recipes ON recipes.id = foods.recipe_id
            """
        )
    ).mappings()
    for row in rows:
        scene_tags = _merge(
            _loads(row["flavor_tags"]),
            _loads(row["recipe_scene_tags"]),
            single=row["scene"],
        )
        bind.execute(
            text("UPDATE foods SET scene_tags = :scene_tags WHERE id = :id"),
            {"id": row["id"], "scene_tags": json.dumps(scene_tags, ensure_ascii=False)},
        )

    op.alter_column("foods", "scene_tags", existing_type=sa.JSON(), nullable=False)

    if _has_table("recipe_scenes") and not _has_table("food_scenes"):
        op.rename_table("recipe_scenes", "food_scenes")

    _rename_index("food_scenes", "uq_recipe_scenes_family_name", "uq_food_scenes_family_name")
    _ensure_unique_constraint("food_scenes", "uq_food_scenes_family_name", ["family_id", "name"])
    _rename_index("food_scenes", "ix_recipe_scenes_family_id", "ix_food_scenes_family_id")
    op.execute("UPDATE media_assets SET entity_type = 'food_scene' WHERE entity_type = 'recipe_scene'")


def downgrade() -> None:
    op.execute("UPDATE media_assets SET entity_type = 'recipe_scene' WHERE entity_type = 'food_scene'")
    _rename_index("food_scenes", "ix_food_scenes_family_id", "ix_recipe_scenes_family_id")
    _rename_index("food_scenes", "uq_food_scenes_family_name", "uq_recipe_scenes_family_name")
    _drop_unique_constraint("food_scenes", "uq_food_scenes_family_name")
    _ensure_unique_constraint("food_scenes", "uq_recipe_scenes_family_name", ["family_id", "name"])
    if _has_table("food_scenes") and not _has_table("recipe_scenes"):
        op.rename_table("food_scenes", "recipe_scenes")
    if _has_column("foods", "scene_tags"):
        op.drop_column("foods", "scene_tags")
