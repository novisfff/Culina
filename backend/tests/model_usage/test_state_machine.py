import pytest

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageProviderOutcome,
    ModelUsageReservationStatus,
)
from app.services.model_usage.errors import ModelUsageStateError
from app.services.model_usage.state_machine import (
    transition_reservation,
    validate_event_outcome,
)


@pytest.mark.parametrize(
    ("outcome", "certainty"),
    [
        ("succeeded", "confirmed_executed"),
        ("failed_billed", "confirmed_executed"),
        ("unknown", "unknown"),
        ("not_billed", "confirmed_not_executed"),
        ("not_billed", "confirmed_executed"),
    ],
)
def test_valid_event_outcome_pairs(outcome: str, certainty: str) -> None:
    validate_event_outcome(
        ModelUsageProviderOutcome(outcome),
        ModelUsageExecutionCertainty(certainty),
    )


def test_succeeded_cannot_be_unknown() -> None:
    with pytest.raises(ModelUsageStateError):
        validate_event_outcome(
            ModelUsageProviderOutcome.SUCCEEDED,
            ModelUsageExecutionCertainty.UNKNOWN,
        )


@pytest.mark.parametrize(
    ("current", "target"),
    [
        ("reserved", "dispatching"),
        ("reserved", "released"),
        ("dispatching", "settled"),
        ("dispatching", "released"),
        ("dispatching", "uncertain"),
        ("uncertain", "settled"),
        ("uncertain", "released"),
    ],
)
def test_legal_reservation_transitions(current: str, target: str) -> None:
    assert transition_reservation(
        ModelUsageReservationStatus(current),
        ModelUsageReservationStatus(target),
    ) is ModelUsageReservationStatus(target)


def test_terminal_reservation_cannot_transition() -> None:
    with pytest.raises(ModelUsageStateError):
        transition_reservation(
            ModelUsageReservationStatus.SETTLED,
            ModelUsageReservationStatus.RELEASED,
        )
