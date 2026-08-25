from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.utils import create_id
from app.models.domain import AIOperation
from app.services.ai_auto_execution.policy_types import DraftCommitRequest


def get_family_ai_operation_for_update(
    db: Session,
    *,
    family_id: str,
    operation_id: str,
) -> AIOperation | None:
    return db.scalar(
        select(AIOperation)
        .where(
            AIOperation.family_id == family_id,
            AIOperation.id == operation_id,
        )
        .with_for_update()
    )


def find_ai_operation_by_revert_request_id_for_update(
    db: Session,
    *,
    client_request_id: str,
) -> AIOperation | None:
    return db.scalar(
        select(AIOperation)
        .where(AIOperation.revert_request_id == client_request_id)
        .with_for_update()
    )


def operation_by_idempotency_key_for_update(
    db: Session,
    *,
    family_id: str,
    idempotency_key: str,
) -> AIOperation | None:
    return db.scalar(
        select(AIOperation)
        .where(
            AIOperation.family_id == family_id,
            AIOperation.idempotency_key == idempotency_key,
        )
        .with_for_update()
    )


def operation_for_draft_for_update(
    db: Session,
    *,
    family_id: str,
    draft_id: str,
    idempotency_key: str,
) -> AIOperation | None:
    return db.scalar(
        select(AIOperation)
        .where(
            AIOperation.family_id == family_id,
            AIOperation.draft_id == draft_id,
            AIOperation.idempotency_key == idempotency_key,
        )
        .with_for_update()
    )


def acquire_draft_operation(
    db: Session,
    *,
    request: DraftCommitRequest,
    idempotency_key: str,
    operation_type: str,
    business_entity_type: str,
) -> tuple[AIOperation, bool]:
    existing = operation_by_idempotency_key_for_update(
        db,
        family_id=request.family_id,
        idempotency_key=idempotency_key,
    )
    if existing is not None:
        return existing, False

    operation = AIOperation(
        id=create_id("ai_operation"),
        family_id=request.family_id,
        approval_request_id=request.approval_request_id,
        draft_id=request.draft_id,
        run_id=request.run_id,
        actor_user_id=request.actor_user_id,
        operation_type=operation_type,
        status="pending",
        execution_mode=request.execution_mode,
        authorization_source=request.authorization_source,
        authorization_snapshot_json=dict(request.authorization_snapshot),
        policy_key=request.policy_key,
        policy_version=request.policy_version,
        policy_reason_codes=list(request.policy_reason_codes),
        committed_payload_json=dict(request.committed_payload),
        result_json=None,
        business_entity_type=business_entity_type,
        business_entity_ids=[],
        idempotency_key=idempotency_key,
    )
    try:
        with db.begin_nested():
            db.add(operation)
            db.flush()
    except IntegrityError:
        existing = operation_by_idempotency_key_for_update(
            db,
            family_id=request.family_id,
            idempotency_key=idempotency_key,
        )
        if existing is None:
            raise
        return existing, False
    return operation, True


def claim_failed_operation_for_retry(
    db: Session,
    *,
    operation_id: str,
    expected_error_code: str | None,
) -> bool:
    conditions = [
        AIOperation.id == operation_id,
        AIOperation.status == "failed",
    ]
    if expected_error_code is not None:
        conditions.append(AIOperation.error_code == expected_error_code)
    result = db.execute(
        update(AIOperation)
        .where(*conditions)
        .values(
            status="pending",
            error_code=None,
            error_message=None,
            failed_at=None,
            completed_at=None,
        )
    )
    return result.rowcount == 1
