from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta, timezone

from app.services.serializers import _utc_datetime


class SerializerDateTimeTestCase(unittest.TestCase):
    def test_naive_datetimes_read_from_mysql_are_treated_as_utc(self) -> None:
        value = _utc_datetime(datetime(2026, 6, 12, 4, 30, 0))

        self.assertEqual(value, datetime(2026, 6, 12, 4, 30, 0, tzinfo=UTC))
        self.assertEqual(value.isoformat(), "2026-06-12T04:30:00+00:00")

    def test_aware_datetimes_are_normalized_to_utc(self) -> None:
        china_time = datetime(2026, 6, 12, 12, 30, 0, tzinfo=timezone(timedelta(hours=8)))

        value = _utc_datetime(china_time)

        self.assertEqual(value, datetime(2026, 6, 12, 4, 30, 0, tzinfo=UTC))


if __name__ == "__main__":
    unittest.main()
