from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import MembershipStatus
from app.models.domain import Membership
from app.services.ai_auto_execution.policy_types import (
    ActionPolicyEvaluation,
    AutoExecutionPolicyContext,
    CriticalEvidenceRequirement,
)


def allowed(*, all_targets_satisfied: bool = False) -> ActionPolicyEvaluation:
    return ActionPolicyEvaluation(True, all_targets_satisfied, ())


def denied(reason: str = "domain_constraint_failed") -> ActionPolicyEvaluation:
    return ActionPolicyEvaluation(False, False, (reason,))


def active_actor(db: Session, *, family_id: str, actor_user_id: str) -> bool:
    return db.scalar(
        select(Membership.id).where(
            Membership.family_id == family_id,
            Membership.user_id == actor_user_id,
            Membership.status == MembershipStatus.ACTIVE,
        )
    ) is not None


def version_matches(actual: datetime | None, expected: Any) -> bool:
    if actual is None or not isinstance(expected, str) or not expected:
        return False
    normalized = f"{expected[:-1]}+00:00" if expected.endswith("Z") else expected
    try:
        expected_dt = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    actual_dt = actual if actual.tzinfo is not None else actual.replace(tzinfo=UTC)
    expected_dt = expected_dt if expected_dt.tzinfo is not None else expected_dt.replace(tzinfo=UTC)
    return actual_dt.astimezone(UTC) == expected_dt.astimezone(UTC)


def requirements_verified(
    context: AutoExecutionPolicyContext,
    requirements: tuple[CriticalEvidenceRequirement, ...],
) -> bool:
    return all(requirement.field in context.evidence.verified_fields for requirement in requirements)


def decimal_value(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def decimal_equal(left: Any, right: Any) -> bool:
    left_value = decimal_value(left)
    right_value = decimal_value(right)
    return left_value is not None and right_value is not None and left_value == right_value


def enum_value(value: Any) -> str:
    return str(value.value if hasattr(value, "value") else value)
