from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftExecuteContext


AssertUpdatedAt = Callable[..., None]


def execute_ai_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    draft_type: str,
    payload: dict[str, Any],
    assert_updated_at_matches: AssertUpdatedAt,
) -> tuple[dict[str, Any], list[str]]:
    return draft_operation_registry.execute(
        DraftExecuteContext(
            db=db,
            family_id=family_id,
            user_id=user_id,
            draft_type=draft_type,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    )
