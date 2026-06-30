from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftNormalizeContext


def normalize_ai_draft_payload(
    db: Session,
    *,
    draft_type: str,
    family_id: str,
    user_id: str,
    conversation_id: str,
    payload: Any,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("草稿内容格式不正确")
    return draft_operation_registry.normalize(
        DraftNormalizeContext(
            db,
            draft_type=draft_type,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            payload=payload,
        )
    )


def draft_preview_summary(draft_type: str, payload: dict[str, Any]) -> str:
    try:
        return draft_operation_registry.preview_summary(draft_type, payload)
    except ValueError:
        return "AI 草稿"
