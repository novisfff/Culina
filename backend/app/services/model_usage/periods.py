from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


SHANGHAI = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True, slots=True)
class BillingPeriod:
    local_month: str
    start_at: datetime
    end_at: datetime


def require_aware_utc(at: datetime) -> datetime:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("billing period instant must be timezone-aware")
    return at.astimezone(timezone.utc)


def shanghai_billing_period(at: datetime) -> BillingPeriod:
    instant = require_aware_utc(at)
    local = instant.astimezone(SHANGHAI)
    local_start = datetime(local.year, local.month, 1, tzinfo=SHANGHAI)
    next_local_start = datetime(
        local.year + (1 if local.month == 12 else 0),
        1 if local.month == 12 else local.month + 1,
        1,
        tzinfo=SHANGHAI,
    )
    return BillingPeriod(
        local_month=local_start.strftime("%Y-%m"),
        start_at=local_start.astimezone(timezone.utc),
        end_at=next_local_start.astimezone(timezone.utc),
    )
