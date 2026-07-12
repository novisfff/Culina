from __future__ import annotations

from datetime import datetime, timedelta


FOOD_STALE_AFTER_DAYS = 7
REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS = 14
FROZEN_INGREDIENT_STALE_AFTER_DAYS = 30
ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS = 30
PRESENCE_INGREDIENT_STALE_AFTER_DAYS = 30

ConfirmationStatus = str  # "never_confirmed" | "current" | "stale"


def confirmation_status(
    last_confirmed_at: datetime | None,
    *,
    generated_at: datetime,
    stale_after_days: int,
) -> str:
    """Return never_confirmed / current / stale from last_confirmed_at only."""
    if last_confirmed_at is None:
        return "never_confirmed"
    confirmed = last_confirmed_at
    if confirmed.tzinfo is None and generated_at.tzinfo is not None:
        confirmed = confirmed.replace(tzinfo=generated_at.tzinfo)
    elif confirmed.tzinfo is not None and generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=confirmed.tzinfo)
    return "stale" if confirmed < generated_at - timedelta(days=stale_after_days) else "current"


def stale_after_days_for_storage_location(storage_location: str | None) -> int:
    label = (storage_location or "").strip()
    if label == "冷藏":
        return REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS
    if label == "冷冻":
        return FROZEN_INGREDIENT_STALE_AFTER_DAYS
    if label == "常温":
        return ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS
    # Unknown labels fall back to the longest precise interval.
    return ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS


def aggregate_confirmation_status(statuses: list[str]) -> str:
    if not statuses:
        return "never_confirmed"
    if any(status == "never_confirmed" for status in statuses):
        return "never_confirmed"
    if any(status == "stale" for status in statuses):
        return "stale"
    return "current"


def earliest_confirmation(values: list[datetime | None]) -> datetime | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return min(present)
