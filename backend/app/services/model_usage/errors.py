from __future__ import annotations

from typing import ClassVar


class ModelUsageError(Exception):
    """Base error carrying a stable, client-safe model-usage code."""

    default_code: ClassVar[str | None] = None

    def __init__(self, code: str | None = None, *, message: str | None = None) -> None:
        resolved_code = code or self.default_code
        if not resolved_code:
            raise ValueError("model usage errors require a stable code")
        self.code = resolved_code
        super().__init__(message or resolved_code)


class ModelUsageContractError(ModelUsageError):
    default_code = "model_usage_contract_error"


class ModelUsageBlocked(ModelUsageError):
    default_code = "model_usage_blocked"


class ModelUsageAttemptConflict(ModelUsageError):
    default_code = "model_usage_attempt_conflict"


class ModelUsageAttemptAlreadyAccounted(ModelUsageError):
    default_code = "model_usage_attempt_already_accounted"


class ModelUsageDispatchRecoveryRequired(ModelUsageError):
    default_code = "model_usage_dispatch_recovery_required"


class ModelUsageLedgerUnavailable(ModelUsageError):
    default_code = "model_usage_ledger_unavailable"


class ModelUsageSettlementPending(ModelUsageError):
    default_code = "model_usage_settlement_pending"


class ModelUsageStateError(ModelUsageError):
    default_code = "model_usage_state_error"


class ModelUsageProofConsumed(ModelUsageError):
    default_code = "model_usage_proof_consumed"


class ModelUsageReceiptIntegrityError(ModelUsageError):
    default_code = "model_usage_receipt_integrity_error"


class ModelUsagePolicyConflict(ModelUsageError):
    default_code = "model_usage_policy_conflict"

    def __init__(self, current_policy: object) -> None:
        self.current_policy = current_policy
        super().__init__()


class ModelUsagePolicyValidationError(ModelUsageError):
    default_code = "model_usage_policy_validation_error"


class ModelUsageAdjustmentConflict(ModelUsageError):
    default_code = "model_usage_adjustment_conflict"


class ModelUsageAdjustmentValidationError(ModelUsageError):
    default_code = "model_usage_adjustment_validation_error"


class ModelUsageAdjustmentWindowClosed(ModelUsageError):
    default_code = "model_usage_adjustment_window_closed"


class ModelUsageCounterAuditError(ModelUsageError):
    default_code = "model_usage_counter_audit_error"


class ModelUsagePreflightError(ModelUsageError):
    default_code = "model_usage_preflight_error"
