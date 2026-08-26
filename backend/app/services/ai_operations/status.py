"""Canonical status handling for persisted AI operations and Drafts.

New writes and public projections use the canonical values declared by the AI
contract.  Readers also understand rows written by the pre-feature runtime so
an upgrade can be deployed without making an already-visible approval or
operation unusable.  Keep that compatibility in one small module instead of
letting individual runtime paths grow their own legacy checks.
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


# Draft statuses are deliberately separate from Approval statuses.  Both have
# a ``pending`` value in older code, but an Approval's pending state must not be
# accidentally written to or queried as a Draft state.
DRAFT_PENDING_CONFIRMATION = "pending_confirmation"
DRAFT_EXECUTED = "executed"
DRAFT_NO_CHANGE = "no_change"
DRAFT_REJECTED = "rejected"
DRAFT_EXPIRED = "expired"
DRAFT_EXECUTION_FAILED = "execution_failed"
DRAFT_PENDING_RETRY = "pending_retry"
DRAFT_REVERTED = "reverted"
DRAFT_CANCELLED = "cancelled"

LEGACY_DRAFT_STATUS_MAP = {
    "pending": DRAFT_PENDING_CONFIRMATION,
    "confirmed": DRAFT_EXECUTED,
    "confirmation_failed": DRAFT_EXECUTION_FAILED,
}
DRAFT_STATUS_VALUES = frozenset(
    {
        DRAFT_PENDING_CONFIRMATION,
        DRAFT_EXECUTED,
        DRAFT_NO_CHANGE,
        DRAFT_REJECTED,
        DRAFT_EXPIRED,
        DRAFT_EXECUTION_FAILED,
        DRAFT_PENDING_RETRY,
        DRAFT_REVERTED,
        DRAFT_CANCELLED,
    }
)
LEGACY_DRAFT_STATUS_VALUES = frozenset(LEGACY_DRAFT_STATUS_MAP)


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


def normalize_draft_status(value: object) -> str:
    """Return the canonical spelling for a persisted Draft status."""

    raw = str(value or "").strip().lower()
    return LEGACY_DRAFT_STATUS_MAP.get(raw, raw)


def draft_status_values(value: str) -> frozenset[str]:
    """Values to use when querying a canonical Draft status from mixed-era rows."""

    canonical = normalize_draft_status(value)
    legacy_values = frozenset(
        raw for raw, mapped in LEGACY_DRAFT_STATUS_MAP.items() if mapped == canonical
    )
    return frozenset({canonical, *legacy_values})


def is_draft_pending(value: object) -> bool:
    """Whether a Draft can still be acted on by an approval/cancellation path."""

    return normalize_draft_status(value) in {DRAFT_PENDING_CONFIRMATION, DRAFT_PENDING_RETRY}


def is_draft_terminal(value: object) -> bool:
    """Whether a Draft has a persisted outcome and should be replayed, not rerun."""

    return normalize_draft_status(value) in {
        DRAFT_EXECUTED,
        DRAFT_NO_CHANGE,
        DRAFT_REJECTED,
        DRAFT_EXPIRED,
        DRAFT_EXECUTION_FAILED,
        DRAFT_REVERTED,
        DRAFT_CANCELLED,
    }
