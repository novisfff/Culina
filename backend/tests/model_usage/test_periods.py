from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services.model_usage.periods import shanghai_billing_period


def test_shanghai_period_uses_utc_storage_boundaries() -> None:
    period = shanghai_billing_period(
        datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc)
    )

    assert period.local_month == "2026-08"
    assert period.start_at == datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc)
    assert period.end_at == datetime(2026, 8, 31, 16, 0, tzinfo=timezone.utc)


def test_shanghai_period_handles_year_boundary() -> None:
    period = shanghai_billing_period(
        datetime(2026, 12, 15, 8, 0, tzinfo=timezone.utc)
    )

    assert period.local_month == "2026-12"
    assert period.start_at == datetime(2026, 11, 30, 16, 0, tzinfo=timezone.utc)
    assert period.end_at == datetime(2026, 12, 31, 16, 0, tzinfo=timezone.utc)


def test_shanghai_period_normalizes_an_aware_non_utc_instant() -> None:
    utc_plus_two = timezone(timedelta(hours=2))
    instant = datetime(2026, 7, 31, 18, 0, tzinfo=utc_plus_two)

    period = shanghai_billing_period(instant)

    assert period.local_month == "2026-08"
    assert period.start_at == datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc)


def test_shanghai_period_rejects_naive_datetime() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        shanghai_billing_period(datetime(2026, 8, 1))
