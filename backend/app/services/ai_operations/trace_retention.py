from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.utils import utcnow
from app.models.domain import AIRunLLMExchange, AIRunTraceSpan


def prune_ai_trace_records(db: Session, *, retention_days: int | None = None) -> dict[str, int]:
    settings = get_settings()
    days = int(retention_days if retention_days is not None else getattr(settings, "ai_trace_retention_days", 7))
    if days <= 0:
        return {"traceSpansDeleted": 0, "llmExchangesDeleted": 0}
    cutoff = utcnow() - timedelta(days=days)
    exchanges_result = db.execute(delete(AIRunLLMExchange).where(AIRunLLMExchange.started_at < cutoff))
    spans_result = db.execute(delete(AIRunTraceSpan).where(AIRunTraceSpan.started_at < cutoff))
    return {
        "traceSpansDeleted": int(spans_result.rowcount or 0),
        "llmExchangesDeleted": int(exchanges_result.rowcount or 0),
    }
