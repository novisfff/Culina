from __future__ import annotations

import json
import re
from typing import Any

from app.ai.skills.base import SkillContext, SkillResult


def result_artifacts(skill_key: str, result: SkillResult) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for index, draft in enumerate(result.drafts):
        if not isinstance(draft, dict):
            continue
        draft_type = str(draft.get("draft_type") or "")
        if not draft_type:
            continue
        artifacts.append(
            {
                "id": f"in_run:{skill_key}:{draft_type}:{index + 1}",
                "type": draft_type,
                "kind": "draft",
                "version": 1,
                "status": "proposed",
                "payload": draft.get("payload") or {},
                "schemaVersion": draft.get("schema_version"),
                "sourceSkill": skill_key,
                **({"sourceDraftId": draft["draft_id"]} if draft.get("draft_id") else {}),
                **({"sourceApprovalId": draft["approval_id"]} if draft.get("approval_id") else {}),
            }
        )
    for index, card in enumerate(result.cards):
        if not isinstance(card, dict):
            continue
        card_type = str(card.get("type") or "")
        if not card_type:
            continue
        artifacts.append(
            {
                "id": f"in_run:{skill_key}:card:{index + 1}",
                "type": card_type,
                "kind": "result_card",
                "version": 1,
                "status": "proposed",
                "payload": card.get("data") or {},
                "sourceSkill": skill_key,
            }
        )
    return artifacts


def conversation_artifacts(context: SkillContext, artifact_type: str | None = None) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for message in context.conversation:
        for artifact in message.get("artifacts", []):
            if not isinstance(artifact, dict):
                continue
            if artifact_type and artifact.get("type") != artifact_type:
                continue
            artifacts.append(artifact)
    for artifact in context.current_run_artifacts:
        if not isinstance(artifact, dict):
            continue
        if artifact_type and artifact.get("type") != artifact_type:
            continue
        artifacts.append(artifact)
    for result in context.previous_results:
        for artifact in result_artifacts("previous", result):
            if artifact_type and artifact.get("type") != artifact_type:
                continue
            artifacts.append(artifact)
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
