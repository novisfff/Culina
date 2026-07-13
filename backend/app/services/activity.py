from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind
from app.core.utils import create_id, utcnow
from app.models.domain import ActivityLog


@dataclass(frozen=True, slots=True)
class ActivityHighlight:
    kind: ActivityHighlightKind
    summary: str


def _normalize_highlight(highlight: ActivityHighlight | None) -> tuple[ActivityHighlightKind | None, str | None]:
    if highlight is None:
        return None, None
    normalized_summary = highlight.summary.strip()
    if not normalized_summary:
        raise ValueError("家庭高亮摘要不能为空")
    if len(normalized_summary) > 255:
        raise ValueError("家庭高亮摘要不能超过 255 个字符")
    return highlight.kind, normalized_summary


def log_activity(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    action: ActivityAction,
    entity_type: str,
    entity_id: str,
    summary: str,
    highlight: ActivityHighlight | None = None,
) -> ActivityLog:
    highlight_kind, highlight_summary = _normalize_highlight(highlight)
    activity = ActivityLog(
        id=create_id("activity"),
        family_id=family_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        highlight_kind=highlight_kind,
        highlight_summary=highlight_summary,
        created_at=utcnow(),
    )
    db.add(activity)
    return activity
