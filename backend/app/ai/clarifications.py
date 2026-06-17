from __future__ import annotations

from typing import Any

from app.core.utils import create_id, utcnow


PENDING_CLARIFICATION_KEY = "pendingClarification"
LAST_CLARIFICATION_RESOLUTION_KEY = "lastClarificationResolution"


def build_pending_clarification(
    *,
    source_skill: str,
    clarification: dict[str, Any],
) -> dict[str, Any]:
    question_type = str(clarification.get("questionType") or "other").strip() or "other"
    payload: dict[str, Any] = {
        "missingFields": clarification.get("missingFields") if isinstance(clarification.get("missingFields"), list) else [],
        "candidates": clarification.get("candidates") if isinstance(clarification.get("candidates"), list) else [],
        "allowFreeText": bool(clarification.get("allowFreeText", True)),
    }
    if isinstance(clarification.get("unitMismatch"), dict):
        payload["unitMismatch"] = clarification["unitMismatch"]

    return {
        "clarificationId": create_id("ai_clarification"),
        "sourceSkill": source_skill,
        "questionType": question_type,
        "question": str(clarification.get("question") or "").strip(),
        "payload": payload,
        "createdAt": utcnow().isoformat(),
    }
