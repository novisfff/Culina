from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.models.domain import AIAgentRun


QUALITY_METRIC_KEYS = (
    "skillExecutionCount",
    "completedSkillExecutionCount",
    "toolCallCount",
    "draftCount",
    "approvalRequestCount",
    "clarificationCount",
    "approvalApprovedCount",
    "approvalRejectedCount",
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _add_counter(counter: Counter[str], values: dict[str, Any]) -> None:
    for key, count in values.items():
        label = str(key or "").strip()
        if not label:
            continue
        try:
            counter[label] += int(count or 0)
        except (TypeError, ValueError):
            continue


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: count for key, count in counter.most_common()}


def build_ai_quality_metrics(
    db: Session,
    *,
    family_id: str,
    limit: int = 50,
    days: int | None = None,
) -> dict[str, Any]:
    """Aggregate recent AI run diagnostics for a single family."""

    normalized_limit = max(1, min(int(limit or 50), 200))
    query = select(AIAgentRun).where(AIAgentRun.family_id == family_id)
    if days is not None and days > 0:
        query = query.where(AIAgentRun.created_at >= utcnow() - timedelta(days=days))
    runs = list(db.scalars(query.order_by(AIAgentRun.created_at.desc(), AIAgentRun.id.desc()).limit(normalized_limit)))

    status_counts: Counter[str] = Counter()
    intent_counts: Counter[str] = Counter()
    routing_skill_counts: Counter[str] = Counter()
    clarification_reasons: Counter[str] = Counter()
    clarification_by_skill: Counter[str] = Counter()
    approval_by_draft_type: dict[str, Counter[str]] = defaultdict(Counter)
    skill_diagnostics: Counter[str] = Counter()
    skill_status_counts: Counter[str] = Counter()
    totals = {key: 0 for key in QUALITY_METRIC_KEYS}
    total_duration_ms = 0
    recent_runs: list[dict[str, Any]] = []

    for run in runs:
        status = str(run.status or "unknown")
        intent = str(run.intent or "unknown")
        context = _as_dict(run.context_summary)
        run_metrics = _as_dict(context.get("runMetrics"))
        routing = _as_dict(context.get("routing"))
        clarification = _as_dict(context.get("clarificationStats"))
        approvals = _as_dict(context.get("approvalStats"))

        status_counts[status] += 1
        intent_counts[intent] += 1
        total_duration_ms += int(run.duration_ms or 0)
        for key in QUALITY_METRIC_KEYS:
            try:
                totals[key] += int(run_metrics.get(key) or 0)
            except (TypeError, ValueError):
                continue

        for skill in _as_list(routing.get("skills")):
            label = str(skill or "").strip()
            if label:
                routing_skill_counts[label] += 1

        _add_counter(clarification_reasons, _as_dict(clarification.get("reasons")))
        _add_counter(clarification_by_skill, _as_dict(clarification.get("bySkill")))
        for draft_type, counts in _as_dict(approvals.get("byDraftType")).items():
            label = str(draft_type or "").strip()
            if not label:
                continue
            _add_counter(approval_by_draft_type[label], _as_dict(counts))

        for execution in _as_list(context.get("skillExecutions")):
            if not isinstance(execution, dict):
                continue
            skill = str(execution.get("skill") or execution.get("skillKey") or "unknown").strip() or "unknown"
            status_label = str(execution.get("status") or "unknown").strip() or "unknown"
            skill_status_counts[f"{skill}:{status_label}"] += 1
            diagnostic = str(execution.get("diagnostic") or "").strip()
            if diagnostic:
                skill_diagnostics[f"{skill}:{diagnostic}"] += 1

        recent_runs.append(
            {
                "id": run.id,
                "agent_key": run.agent_key,
                "intent": run.intent,
                "status": run.status,
                "model": run.model,
                "created_at": run.created_at,
                "duration_ms": int(run.duration_ms or 0),
                "error_code": run.error_code,
                "routing_skills": [str(skill) for skill in _as_list(routing.get("skills")) if str(skill or "").strip()],
                "clarification_count": int(run_metrics.get("clarificationCount") or 0),
                "approval_request_count": int(run_metrics.get("approvalRequestCount") or 0),
                "approval_approved_count": int(run_metrics.get("approvalApprovedCount") or 0),
                "approval_rejected_count": int(run_metrics.get("approvalRejectedCount") or 0),
            }
        )

    run_count = len(runs)
    return {
        "family_id": family_id,
        "window": {"limit": normalized_limit, "days": days},
        "run_count": run_count,
        "status_counts": _counter_dict(status_counts),
        "intent_counts": _counter_dict(intent_counts),
        "routing_skill_counts": _counter_dict(routing_skill_counts),
        "clarification_reasons": _counter_dict(clarification_reasons),
        "clarification_by_skill": _counter_dict(clarification_by_skill),
        "approval_by_draft_type": {draft_type: _counter_dict(counts) for draft_type, counts in approval_by_draft_type.items()},
        "skill_diagnostics": _counter_dict(skill_diagnostics),
        "skill_status_counts": _counter_dict(skill_status_counts),
        "totals": {
            **totals,
            "totalDurationMs": total_duration_ms,
            "averageDurationMs": int(total_duration_ms / run_count) if run_count else 0,
        },
        "recent_runs": recent_runs,
    }
