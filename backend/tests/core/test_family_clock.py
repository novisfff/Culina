from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.services.clock import family_timezone, now_for_family, today_for_family


def test_family_clock_uses_shanghai_date_at_utc_day_boundary() -> None:
    instant = datetime(2026, 7, 9, 16, 30, tzinfo=UTC)

    assert today_for_family("family-1", at=instant).isoformat() == "2026-07-10"
    assert now_for_family("family-1", at=instant).isoformat() == "2026-07-10T00:30:00+08:00"


def test_family_timezone_rejects_unknown_zone() -> None:
    with pytest.raises(ValueError, match="无效的家庭时区"):
        family_timezone("Mars/Olympus")
