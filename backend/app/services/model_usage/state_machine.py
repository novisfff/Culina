from __future__ import annotations

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageProviderOutcome,
    ModelUsageReservationStatus,
)
from app.services.model_usage.errors import ModelUsageStateError


ALLOWED_RESERVATION_TRANSITIONS = {
    ModelUsageReservationStatus.RESERVED: {
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.RELEASED,
    },
    ModelUsageReservationStatus.DISPATCHING: {
        ModelUsageReservationStatus.SETTLED,
        ModelUsageReservationStatus.RELEASED,
        ModelUsageReservationStatus.UNCERTAIN,
    },
    ModelUsageReservationStatus.UNCERTAIN: {
        ModelUsageReservationStatus.SETTLED,
        ModelUsageReservationStatus.RELEASED,
    },
}


VALID_EVENT_OUTCOMES = {
    ModelUsageProviderOutcome.SUCCEEDED: {
        ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
    },
    ModelUsageProviderOutcome.FAILED_BILLED: {
        ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
    },
    ModelUsageProviderOutcome.UNKNOWN: {
        ModelUsageExecutionCertainty.UNKNOWN,
    },
    ModelUsageProviderOutcome.NOT_BILLED: {
        ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
        ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
    },
}


def transition_reservation(
    current: ModelUsageReservationStatus,
    target: ModelUsageReservationStatus,
) -> ModelUsageReservationStatus:
    if target not in ALLOWED_RESERVATION_TRANSITIONS.get(current, set()):
        raise ModelUsageStateError("invalid_reservation_transition")
    return target


def validate_event_outcome(
    outcome: ModelUsageProviderOutcome,
    certainty: ModelUsageExecutionCertainty,
) -> None:
    if certainty not in VALID_EVENT_OUTCOMES.get(outcome, set()):
        raise ModelUsageStateError("invalid_provider_outcome_certainty")
