from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_FAMILY_TIMEZONE = "Asia/Shanghai"


def family_timezone(timezone_name: str = DEFAULT_FAMILY_TIMEZONE) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"无效的家庭时区：{timezone_name}") from exc


def now_utc() -> datetime:
    return datetime.now(UTC)


def now_for_family(
    family_id: str | None = None,
    *,
    at: datetime | None = None,
    timezone_name: str = DEFAULT_FAMILY_TIMEZONE,
) -> datetime:
    del family_id
    instant = at or now_utc()
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    return instant.astimezone(family_timezone(timezone_name))


def today_for_family(
    family_id: str | None = None,
    *,
    at: datetime | None = None,
    timezone_name: str = DEFAULT_FAMILY_TIMEZONE,
) -> date:
    return now_for_family(family_id, at=at, timezone_name=timezone_name).date()
