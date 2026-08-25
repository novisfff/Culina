"""Canonical status handling for persisted AI operations.

The 7b8c9d0e1f2a migration renamed the legacy ``succeeded`` value to
``completed``.  New writes and public projections must use the canonical
value, while readers still need to understand rows written before (or during)
the upgrade.  Keep that compatibility in one small module so individual
runtime paths cannot accidentally drift back to the legacy spelling.
"""

from __future__ import annotations

from collections.abc import Iterable


OPERATION_PENDING = "pending"
OPERATION_COMPLETED = "completed"
OPERATION_FAILED = "failed"
OPERATION_REVERTED = "reverted"

LEGACY_OPERATION_STATUS_MAP = {
    "succeeded": OPERATION_COMPLETED,
}

CANONICAL_OPERATION_STATUSES = frozenset(
    {
        OPERATION_PENDING,
        OPERATION_COMPLETED,
        OPERATION_FAILED,
        OPERATION_REVERTED,
    }
)
LEGACY_OPERATION_STATUS_VALUES = frozenset(LEGACY_OPERATION_STATUS_MAP)


def normalize_operation_status(value: object) -> str:
    """Return the canonical spelling for a persisted Operation status.

    Unknown values are returned unchanged so callers can fail closed instead
    of accidentally treating a new/invalid status as successful.
    """

    raw = str(value or "").strip().lower()
    return LEGACY_OPERATION_STATUS_MAP.get(raw, raw)


def is_operation_completed(value: object) -> bool:
    return normalize_operation_status(value) == OPERATION_COMPLETED


def operation_status_values(value: str) -> frozenset[str]:
    """Values to use when querying a canonical status from mixed-era rows."""

    canonical = normalize_operation_status(value)
    if canonical == OPERATION_COMPLETED:
        return frozenset({OPERATION_COMPLETED, *LEGACY_OPERATION_STATUS_VALUES})
    return frozenset({canonical})


def normalize_operation_statuses(values: Iterable[object]) -> frozenset[str]:
    """Normalize a collection for in-memory comparisons."""

    return frozenset(normalize_operation_status(value) for value in values)
