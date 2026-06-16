from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from app.ai.errors import AIConflictError


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


def assert_updated_at_matches(*, actual: datetime | None, expected: str, label: str) -> None:
    if actual is None:
        raise AIConflictError(f"{label} 缺少更新时间，无法确认是否被修改")
    normalized_expected = expected
    if normalized_expected.endswith("Z"):
        normalized_expected = f"{normalized_expected[:-1]}+00:00"
    try:
        expected_dt = datetime.fromisoformat(normalized_expected)
    except ValueError as exc:
        raise ValueError("baseUpdatedAt 格式不正确") from exc
    actual_dt = actual if actual.tzinfo is not None else actual.replace(tzinfo=UTC)
    if expected_dt.tzinfo is None:
        expected_dt = expected_dt.replace(tzinfo=UTC)
    if actual_dt.astimezone(UTC) != expected_dt.astimezone(UTC):
        raise AIConflictError(f"{label} 已被其他修改更新，请刷新后重试")
