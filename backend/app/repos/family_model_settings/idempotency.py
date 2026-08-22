from __future__ import annotations

import hmac
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import FamilyModelOperationStatus
from app.core.utils import create_id, utcnow
from app.models.family_model_settings import FamilyModelOperationReceipt
from app.services.family_model_settings.errors import (
    FamilyModelOperationIdempotencyConflict,
    FamilyModelOperationInProgress,
)


FingerprintForKeyId = Callable[[str], str]


@dataclass(frozen=True, slots=True)
class OperationClaim:
    receipt: FamilyModelOperationReceipt
    created_by_request: bool

    @property
    def completed(self) -> bool:
        return self.receipt.status is FamilyModelOperationStatus.COMPLETED


def get_operation_receipt(
    db: Session,
    *,
    family_id: str,
    operation: str,
    idempotency_key: str,
    for_update: bool = False,
) -> FamilyModelOperationReceipt | None:
    statement = select(FamilyModelOperationReceipt).where(
        FamilyModelOperationReceipt.family_id == family_id,
        FamilyModelOperationReceipt.operation == operation,
        FamilyModelOperationReceipt.idempotency_key == idempotency_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def _verify_fingerprint(
    receipt: FamilyModelOperationReceipt,
    *,
    fingerprint_for_key_id: FingerprintForKeyId,
) -> None:
    expected = fingerprint_for_key_id(receipt.request_fingerprint_key_id)
    if not hmac.compare_digest(receipt.request_fingerprint, expected):
        raise FamilyModelOperationIdempotencyConflict()


def _claim_existing(
    receipt: FamilyModelOperationReceipt,
    *,
    fingerprint_for_key_id: FingerprintForKeyId,
) -> OperationClaim:
    _verify_fingerprint(receipt, fingerprint_for_key_id=fingerprint_for_key_id)
    if receipt.status is FamilyModelOperationStatus.PENDING:
        raise FamilyModelOperationInProgress()
    return OperationClaim(receipt=receipt, created_by_request=False)


def claim_operation(
    db: Session,
    *,
    family_id: str,
    operation: str,
    idempotency_key: str,
    active_fingerprint_key_id: str,
    fingerprint_for_key_id: FingerprintForKeyId,
) -> OperationClaim:
    """Claim one family-scoped write, replaying only completed identical requests.

    The callback recomputes sensitive fingerprints only in memory.  For a
    replay it receives the receipt's original key id, not the currently active
    deployment key, so key rotation does not change idempotency semantics.
    """

    # Do not take a MySQL next-key lock for an absent receipt.  Concurrent
    # writes with different idempotency keys otherwise deadlock before either
    # can acquire the family settings lock.  A present receipt is re-read with
    # FOR UPDATE below; an absent receipt is safely arbitrated by the unique
    # constraint and the loser path.
    existing = get_operation_receipt(
        db,
        family_id=family_id,
        operation=operation,
        idempotency_key=idempotency_key,
        for_update=False,
    )
    if existing is not None:
        locked = get_operation_receipt(
            db,
            family_id=family_id,
            operation=operation,
            idempotency_key=idempotency_key,
            for_update=True,
        )
        if locked is None:
            # Receipts are never deleted during a user operation.  Treat a
            # surprising disappearance as a retryable in-progress state
            # rather than handing an unowned claim to the caller.
            raise FamilyModelOperationInProgress()
        return _claim_existing(locked, fingerprint_for_key_id=fingerprint_for_key_id)

    fingerprint = fingerprint_for_key_id(active_fingerprint_key_id)
    receipt = FamilyModelOperationReceipt(
        id=create_id("family-model-receipt"),
        family_id=family_id,
        operation=operation,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        request_fingerprint_key_id=active_fingerprint_key_id,
        status=FamilyModelOperationStatus.PENDING,
    )
    # A root SQLite transaction that has only performed reads may not have
    # issued a physical BEGIN yet.  Starting and releasing a SAVEPOINT for the
    # first INSERT can therefore commit that INSERT independently; a later
    # rollback of the caller's publish transaction would leave a stray pending
    # receipt.  Only use a savepoint when the caller is already inside one.
    # Otherwise keep the claim in the caller's root transaction so the receipt
    # and all business writes share the same rollback boundary.
    inside_savepoint = db.in_nested_transaction()
    try:
        if inside_savepoint:
            with db.begin_nested():
                db.add(receipt)
                db.flush()
        else:
            db.add(receipt)
            db.flush()
    except IntegrityError:
        if not inside_savepoint:
            # A failed root INSERT invalidates the Session transaction.  These
            # family-model claim sites run before business writes, so resetting
            # it is safe and lets the loser load the committed winner.
            db.rollback()
        winner = get_operation_receipt(
            db,
            family_id=family_id,
            operation=operation,
            idempotency_key=idempotency_key,
            for_update=True,
        )
        if winner is None:
            raise
        return _claim_existing(winner, fingerprint_for_key_id=fingerprint_for_key_id)
    return OperationClaim(receipt=receipt, created_by_request=True)


def complete_operation(
    claim: OperationClaim,
    *,
    result_id: str | None,
    response_json: Mapping[str, Any],
    completed_at: datetime | None = None,
) -> FamilyModelOperationReceipt:
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()
    try:
        json.dumps(response_json, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("family_model_operation_response_not_json") from exc
    receipt = claim.receipt
    receipt.result_id = result_id
    receipt.response_json = dict(response_json)
    receipt.status = FamilyModelOperationStatus.COMPLETED
    receipt.completed_at = completed_at or utcnow()
    return receipt
