from __future__ import annotations

from datetime import UTC, date, datetime


def now_utc() -> datetime:
    return datetime.now(UTC)


def today_for_family(family_id: str | None = None, *, at: datetime | None = None) -> date:
    _ = family_id
    return (at or now_utc()).date()


def now_for_family(family_id: str | None = None) -> datetime:
    _ = family_id
    return now_utc()

