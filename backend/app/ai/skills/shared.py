from __future__ import annotations

import json
import re
from typing import Any

from app.ai.skills.base import SkillContext


def conversation_artifacts(context: SkillContext, artifact_type: str | None = None) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for message in context.conversation:
        for artifact in message.get("artifacts", []):
            if not isinstance(artifact, dict):
                continue
            if artifact_type and artifact.get("type") != artifact_type:
                continue
            artifacts.append(artifact)
    for result in context.previous_results:
        for draft in result.drafts:
            draft_type = str(draft.get("draft_type") or "")
            if artifact_type and draft_type != artifact_type:
                continue
            artifacts.append(
                {
                    "id": f"in_run:{draft_type}",
                    "type": draft_type,
                    "version": 1,
                    "status": "in_run",
                    "payload": draft.get("payload") or {},
                }
            )
    return artifacts


def artifact_by_id(context: SkillContext, artifact_id: str, artifact_type: str) -> dict[str, Any] | None:
    return next(
        (
            artifact
            for artifact in conversation_artifacts(context, artifact_type)
            if str(artifact.get("id") or "") == artifact_id
        ),
        None,
    )


def legacy_subject(context: SkillContext) -> dict[str, Any]:
    artifacts = conversation_artifacts(context)
    if not artifacts:
        return {}
    latest = artifacts[-1]
    return {
        "currentDraft": latest.get("payload"),
        "currentDraftType": latest.get("type"),
        "currentDraftId": latest.get("id"),
    }


def json_object(text: str) -> dict[str, Any] | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


def meal_type_label(value: str) -> str:
    return {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}.get(value, value)


def normalize_meal_types(values: list[str] | None) -> list[str]:
    valid = {"breakfast", "lunch", "dinner", "snack"}
    meal_types = [item for item in (values or []) if item in valid]
    return meal_types or ["dinner"]


def norm_name(value: Any) -> str:
    return str(value or "").strip()


def model_name(context: SkillContext) -> str:
    return getattr(context.provider, "model_name", "") if context.provider else ""
