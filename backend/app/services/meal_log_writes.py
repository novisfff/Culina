from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import MealType
from app.core.utils import create_id
from app.models.domain import MealLog, MealLogFood


@dataclass(frozen=True, slots=True)
class MealEntryWrite:
    food_id: str
    servings: Decimal
    note: str = ""
    rating: Decimal | None = None


def create_meal_log_with_entries(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    date: date,
    meal_type: MealType,
    entries: Sequence[MealEntryWrite],
    participant_user_ids: Sequence[str],
    notes: str = "",
    mood: str = "",
    meal_log_id: str | None = None,
) -> tuple[MealLog, list[MealLogFood]]:
    """Create a MealLog and its MealLogFood rows without commit/activity/inventory side effects."""
    meal_log = MealLog(
        id=meal_log_id or create_id("meal"),
        family_id=family_id,
        date=date,
        meal_type=meal_type,
        participant_user_ids=list(participant_user_ids),
        notes=notes,
        mood=mood,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(meal_log)
    db.flush()
    food_entries = append_meal_log_entries(db, meal_log=meal_log, entries=entries)
    return meal_log, food_entries


def append_meal_log_entries(
    db: Session,
    *,
    meal_log: MealLog,
    entries: Sequence[MealEntryWrite],
) -> list[MealLogFood]:
    """Create MealLogFood rows only.

    Callers own commit, activity logging, inventory mutation, participant changes,
    and exactly one parent version bump for the surrounding write.
    """
    created: list[MealLogFood] = []
    for item in entries:
        entry = MealLogFood(
            id=create_id("meal-food"),
            meal_log_id=meal_log.id,
            food_id=item.food_id,
            servings=item.servings,
            note=item.note,
            rating=item.rating,
        )
        db.add(entry)
        created.append(entry)
    if created:
        db.flush()
    return created
