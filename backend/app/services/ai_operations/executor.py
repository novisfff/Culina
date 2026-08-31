from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.services.ai_auto_execution.policy_types import ConcurrencyStrategy, DraftExecutionReceipt
from app.services.ai_operations.registry_types import DraftExecuteContext


AssertUpdatedAt = Callable[..., None]


def derive_child_operation_idempotency_key(parent_key: str, child_operation_id: str) -> str:
    digest = hashlib.sha256(f"{parent_key}\0{child_operation_id}".encode("utf-8")).hexdigest()
    return f"ai-child:{digest}"


def execute_ai_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    draft_type: str,
    payload: dict[str, Any],
    assert_updated_at_matches: AssertUpdatedAt,
    operation_idempotency_key: str,
    concurrency_strategy: ConcurrencyStrategy = "entity_version",
    conversation_id: str = "",
    committed_at: datetime | None = None,
    revertible_until: datetime | None = None,
) -> DraftExecutionReceipt:
    from app.services.ai_operations.registry import draft_operation_registry

    return draft_operation_registry.execute(
        DraftExecuteContext(
            db=db,
            family_id=family_id,
            user_id=user_id,
            draft_type=draft_type,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
            operation_idempotency_key=operation_idempotency_key,
            concurrency_strategy=concurrency_strategy,
            conversation_id=conversation_id,
            committed_at=committed_at,
            revertible_until=revertible_until,
        )
    )
