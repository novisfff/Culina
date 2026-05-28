from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import FoodType, MealType, food_type_values
from app.core.utils import create_id
from app.models.domain import Food, MediaAsset, Recipe
from app.services.media import replace_media_assets


def ensure_food_for_recipe(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    recipe: Recipe,
    recipe_media_ids: list[str] | None = None,
    sync_media: bool = False,
) -> tuple[Food, bool]:
    food = db.scalar(
        select(Food).where(
            Food.family_id == family_id,
            Food.recipe_id == recipe.id,
            Food.type.in_(food_type_values(FoodType.SELF_MADE)),
        )
    )
    created = food is None
    if food is None:
        food = db.scalar(
            select(Food)
            .where(
                Food.family_id == family_id,
                Food.recipe_id.is_(None),
                Food.type.in_(food_type_values(FoodType.SELF_MADE)),
                Food.name == recipe.title,
            )
            .order_by(Food.updated_at.desc())
        )
        if food is None:
            food = Food(
                id=create_id("food"),
                family_id=family_id,
                type=FoodType.SELF_MADE.value,
                favorite=False,
                created_by=user_id,
                updated_by=user_id,
            )
            db.add(food)
        food.recipe_id = recipe.id

    food.name = recipe.title
    food.category = "家常菜"
    food.source_name = "家庭厨房"
    food.purchase_source = "家庭厨房"
    if created:
        food.flavor_tags = []
        food.scene_tags = []
        food.suitable_meal_types = [MealType.DINNER.value]
        food.scene = "日常"
        food.notes = recipe.tips
        food.routine_note = ""
        food.created_by = food.created_by or user_id
    food.updated_by = user_id

    if sync_media:
        replace_media_assets(db, family_id=family_id, media_ids=[], entity_type="food", entity_id=food.id)
        if recipe_media_ids:
            recipe_media = list(db.scalars(select(MediaAsset).where(MediaAsset.family_id == family_id, MediaAsset.id.in_(recipe_media_ids))))
            for asset in recipe_media:
                db.add(
                    MediaAsset(
                        id=create_id("photo"),
                        family_id=asset.family_id,
                        name=asset.name,
                        url=asset.url,
                        file_path=asset.file_path,
                        source=asset.source,
                        alt=asset.alt,
                        generation_mode=asset.generation_mode,
                        reference_media_id=asset.reference_media_id,
                        style_key=asset.style_key,
                        prompt_version=asset.prompt_version,
                        entity_type="food",
                        entity_id=food.id,
                        created_by=user_id,
                    )
                )

    db.flush()
    return food, created
