from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.enums import AIConversationVisibility
from app.core.utils import utcnow
from app.ai.evals.scoring import build_rate
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIRunLLMExchange, AIRunTraceSpan


QUALITY_METRIC_KEYS = (
    "skillExecutionCount",
    "completedSkillExecutionCount",
    "toolCallCount",
    "draftCount",
    "approvalRequestCount",
    "clarificationCount",
    "approvalApprovedCount",
    "approvalRejectedCount",
    "routeSelectionCount",
    "draftValidationCandidateCount",
    "draftValidationAttemptCount",
    "draftFirstPassSuccessCount",
    "invalidIdentityRejectedCount",
    "toolBudgetExhaustedCount",
    "continuationStartedCount",
    "continuationCompletedCount",
    "continuationRejectedCount",
)


def accessible_ai_run_clause(user_id: str):
    return or_(
        AIAgentRun.conversation_id.is_(None),
        and_(
            AIConversation.owner_user_id.is_not(None),
            or_(
                AIConversation.owner_user_id == user_id,
                AIConversation.visibility == AIConversationVisibility.FAMILY,
            ),
        ),
    )


def canonicalize_approval_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: canonicalize_approval_value(value[key])
            for key in sorted(value)
            if key not in {"comment", "clientOnly"}
        }
    if isinstance(value, list):
        return [canonicalize_approval_value(item) for item in value]
    if isinstance(value, str):
        return value.strip()
    return value


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
    user_id: str,
    limit: int = 50,
    days: int | None = None,
) -> dict[str, Any]:
    """Aggregate recent AI run diagnostics for a single family."""

    normalized_limit = max(1, min(int(limit or 50), 200))
    query = (
        select(AIAgentRun)
        .outerjoin(AIConversation, AIConversation.id == AIAgentRun.conversation_id)
        .where(
            AIAgentRun.family_id == family_id,
            accessible_ai_run_clause(user_id),
        )
    )
    if days is not None and days > 0:
        query = query.where(AIAgentRun.created_at >= utcnow() - timedelta(days=days))
    run_ids = list(db.scalars(query.with_only_columns(AIAgentRun.id).order_by(AIAgentRun.created_at.desc(), AIAgentRun.id.desc()).limit(normalized_limit)))
    runs_by_id = {
        run.id: run
        for run in db.scalars(select(AIAgentRun).where(AIAgentRun.family_id == family_id, AIAgentRun.id.in_(run_ids)))
    } if run_ids else {}
    runs = [runs_by_id[run_id] for run_id in run_ids if run_id in runs_by_id]

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
    run_error_codes: Counter[str] = Counter()

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
        if run.error_code:
            run_error_codes[str(run.error_code)] += 1
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
    approved_approvals = (
        list(
            db.scalars(
                select(AIApprovalRequest).where(
                    AIApprovalRequest.family_id == family_id,
                    AIApprovalRequest.run_id.in_(run_ids),
                    AIApprovalRequest.status == "approved",
                )
            )
        )
        if run_ids
        else []
    )
    resolved_approved = [approval for approval in approved_approvals if approval.submitted_values]
    unedited_approvals = sum(
        canonicalize_approval_value(approval.initial_values)
        == canonicalize_approval_value(approval.submitted_values)
        for approval in resolved_approved
    )
    trace_metrics = _build_trace_quality_metrics(db, family_id=family_id, run_ids=[run.id for run in runs], run_error_codes=run_error_codes)
    token_usage = _build_token_usage_metrics(db, family_id=family_id, user_id=user_id)
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
        "trace_metrics": trace_metrics,
        "operational_metrics": {
            "draftFirstPassRate": build_rate(
                totals["draftFirstPassSuccessCount"],
                totals["draftValidationCandidateCount"],
            ).model_dump(),
            "continuationCompletionRate": build_rate(
                totals["continuationCompletedCount"],
                max(
                    totals["continuationStartedCount"],
                    totals["continuationCompletedCount"],
                ),
            ).model_dump(),
            "approvalUneditedRate": build_rate(
                unedited_approvals,
                len(resolved_approved),
            ).model_dump(),
            "invalidIdentityRejectedCount": totals["invalidIdentityRejectedCount"],
            "toolBudgetExhaustedCount": totals["toolBudgetExhaustedCount"],
            "continuationRejectedCount": totals["continuationRejectedCount"],
        },
        "token_usage": token_usage,
        "recent_runs": recent_runs,
    }



TOKEN_USAGE_WINDOWS = (
    ("24h", 24),
    ("7d", 24 * 7),
    ("30d", 24 * 30),
)


def _as_non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _as_non_negative_float(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    if number != number:  # NaN
        return 0.0
    return max(0.0, number)


def _empty_token_usage_window(*, hours: int) -> dict[str, Any]:
    return {
        "hours": hours,
        "exchangeCount": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "cachedTokens": 0,
        "estimatedCostUsd": 0.0,
    }


def _coerce_aware_utc(value: Any):
    if value is None:
        return None
    if getattr(value, "tzinfo", None) is None:
        from datetime import timezone

        return value.replace(tzinfo=timezone.utc)
    return value


def _build_token_usage_metrics(db: Session, *, family_id: str, user_id: str) -> dict[str, Any]:
    """Aggregate provider token usage across fixed rolling windows."""

    now = _coerce_aware_utc(utcnow())
    windows = {
        key: _empty_token_usage_window(hours=hours)
        for key, hours in TOKEN_USAGE_WINDOWS
    }
    max_hours = max(hours for _, hours in TOKEN_USAGE_WINDOWS)
    exchanges = list(
        db.scalars(
            select(AIRunLLMExchange)
            .join(AIAgentRun, AIAgentRun.id == AIRunLLMExchange.run_id)
            .outerjoin(AIConversation, AIConversation.id == AIAgentRun.conversation_id)
            .where(
                AIRunLLMExchange.family_id == family_id,
                AIRunLLMExchange.started_at >= now - timedelta(hours=max_hours),
                accessible_ai_run_clause(user_id),
            )
        )
    )
    for exchange in exchanges:
        started_at = _coerce_aware_utc(exchange.started_at)
        if started_at is None:
            continue
        age = now - started_at
        age_hours = age.total_seconds() / 3600
        input_tokens = _as_non_negative_int(exchange.input_tokens)
        output_tokens = _as_non_negative_int(exchange.output_tokens)
        total_tokens = _as_non_negative_int(exchange.total_tokens)
        if total_tokens <= 0:
            total_tokens = input_tokens + output_tokens
        cached_tokens = _as_non_negative_int(exchange.cached_tokens)
        estimated_cost = _as_non_negative_float(exchange.estimated_cost_usd)
        for key, hours in TOKEN_USAGE_WINDOWS:
            if age_hours > hours:
                continue
            bucket = windows[key]
            bucket["exchangeCount"] += 1
            bucket["inputTokens"] += input_tokens
            bucket["outputTokens"] += output_tokens
            bucket["totalTokens"] += total_tokens
            bucket["cachedTokens"] += cached_tokens
            bucket["estimatedCostUsd"] = round(bucket["estimatedCostUsd"] + estimated_cost, 6)
    return {"windows": windows}



def _average_duration(items: list[int]) -> int:
    return int(sum(items) / len(items)) if items else 0


def _build_trace_quality_metrics(
    db: Session,
    *,
    family_id: str,
    run_ids: list[str],
    run_error_codes: Counter[str],
) -> dict[str, Any]:
    if not run_ids:
        return {
            "traceSpanCount": 0,
            "llmExchangeCount": 0,
            "failedSpanCount": 0,
            "failedExchangeCount": 0,
            "averageProviderDurationMs": 0,
            "averageToolDurationMs": 0,
            "averageScriptDurationMs": 0,
            "averageProviderRounds": 0,
            "errorCodes": _counter_dict(run_error_codes),
            "spanTypeCounts": {},
            "spanStatusCounts": {},
            "exchangeStatusCounts": {},
        }

    spans = list(
        db.scalars(
            select(AIRunTraceSpan)
            .where(AIRunTraceSpan.family_id == family_id, AIRunTraceSpan.run_id.in_(run_ids))
        )
    )
    exchanges = list(
        db.scalars(
            select(AIRunLLMExchange)
            .where(AIRunLLMExchange.family_id == family_id, AIRunLLMExchange.run_id.in_(run_ids))
        )
    )
    error_codes = Counter(run_error_codes)
    span_type_counts: Counter[str] = Counter()
    span_status_counts: Counter[str] = Counter()
    exchange_status_counts: Counter[str] = Counter()
    tool_durations: list[int] = []
    script_durations: list[int] = []
    provider_durations: list[int] = []
    provider_rounds_by_run: dict[str, set[int]] = defaultdict(set)

    for span in spans:
        span_type = str(span.span_type or "unknown")
        span_status = str(span.status or "unknown")
        span_type_counts[span_type] += 1
        span_status_counts[span_status] += 1
        if span.error_code:
            error_codes[str(span.error_code)] += 1
        if span_type == "tool_call":
            tool_durations.append(int(span.duration_ms or 0))
        elif span_type == "script_call":
            script_durations.append(int(span.duration_ms or 0))

    for exchange in exchanges:
        exchange_status = str(exchange.status or "unknown")
        exchange_status_counts[exchange_status] += 1
        provider_durations.append(int(exchange.duration_ms or 0))
        provider_rounds_by_run[str(exchange.run_id)].add(int(exchange.provider_round or 0))
        if exchange.error_code:
            error_codes[str(exchange.error_code)] += 1

    round_counts = [len(rounds) for rounds in provider_rounds_by_run.values()]
    return {
        "traceSpanCount": len(spans),
        "llmExchangeCount": len(exchanges),
        "failedSpanCount": sum(1 for span in spans if span.status == "failed" or span.error_code),
        "failedExchangeCount": sum(1 for exchange in exchanges if exchange.status == "failed" or exchange.error_code),
        "averageProviderDurationMs": _average_duration(provider_durations),
        "averageToolDurationMs": _average_duration(tool_durations),
        "averageScriptDurationMs": _average_duration(script_durations),
        "averageProviderRounds": _average_duration(round_counts),
        "errorCodes": _counter_dict(error_codes),
        "spanTypeCounts": _counter_dict(span_type_counts),
        "spanStatusCounts": _counter_dict(span_status_counts),
        "exchangeStatusCounts": _counter_dict(exchange_status_counts),
    }
