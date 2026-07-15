from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import MealType
from app.models.domain import MealLog, MealLogFood, MediaAsset
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import serialize_media


def list_meal_log_candidates(
    db: Session,
    *,
    family_id: str,
    meal_date: date,
    meal_type: MealType,
) -> list[MealLog]:
    return list(
        db.scalars(
            select(MealLog)
            .where(
                MealLog.family_id == family_id,
                MealLog.date == meal_date,
                MealLog.meal_type == meal_type,
            )
            .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food))
            .order_by(MealLog.created_at.desc(), MealLog.id.asc())
        )
    )


def _sorted_media(assets: list[MediaAsset]) -> list[MediaAsset]:
    return sorted(
        assets,
        key=lambda asset: (
            asset.created_at or datetime.min,
            asset.id,
        ),
    )


def serialize_meal_log_candidates(
    db: Session,
    *,
    family_id: str,
    meal_logs: list[MealLog],
) -> list[dict]:
    meal_log_ids = [meal_log.id for meal_log in meal_logs]
    food_ids: list[str] = []
    for meal_log in meal_logs:
        for entry in meal_log.food_entries:
            if entry.food_id and entry.food_id not in food_ids:
                food_ids.append(entry.food_id)

    meal_media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="meal_log",
            entity_ids=meal_log_ids,
        )
    )
    food_media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="food",
            entity_ids=food_ids,
        )
    )

    candidates: list[dict] = []
    for meal_log in meal_logs:
        meal_photos = _sorted_media(meal_media_map.get(("meal_log", meal_log.id), []))
        foods: list[dict] = []
        first_food_cover: dict | None = None
        for entry in meal_log.food_entries:
            food = entry.food
            food_photos = _sorted_media(food_media_map.get(("food", entry.food_id), []))
            cover = serialize_media(food_photos[0]) if food_photos else None
            if first_food_cover is None and cover is not None:
                first_food_cover = cover
            foods.append(
                {
                    "food_id": entry.food_id,
                    "name": food.name if food is not None else "",
                    "food_type": (
                        food.type.value
                        if food is not None and hasattr(food.type, "value")
                        else (food.type if food is not None else "")
                    ),
                    "cover": cover,
                }
            )

        preview_media = serialize_media(meal_photos[0]) if meal_photos else first_food_cover
        candidates.append(
            {
                "meal_log_id": meal_log.id,
                "row_version": int(meal_log.row_version),
                "date": meal_log.date,
                "meal_type": meal_log.meal_type,
                "created_at": meal_log.created_at,
                "foods": foods,
                "preview_media": preview_media,
                "photo_count": len(meal_photos),
            }
        )
    return candidates
