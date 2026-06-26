from __future__ import annotations

import argparse
import sys
from pathlib import Path
from datetime import timedelta

from sqlalchemy import func, select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.domain import AIRunLLMExchange, AIRunTraceSpan
from app.services.ai_operations.trace_retention import prune_ai_trace_records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prune expired AI agent trace spans and LLM exchanges.")
    parser.add_argument("--retention-days", type=int, default=0, help="Override AI_TRACE_RETENTION_DAYS for this run.")
    parser.add_argument("--dry-run", action="store_true", help="Only print the records that would be pruned.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    settings = get_settings()
    retention_days = args.retention_days if args.retention_days > 0 else settings.ai_trace_retention_days

    with SessionLocal() as db:
        if args.dry_run:
            cutoff = utcnow() - timedelta(days=retention_days)
            trace_spans = db.scalar(select(func.count()).select_from(AIRunTraceSpan).where(AIRunTraceSpan.started_at < cutoff)) or 0
            llm_exchanges = db.scalar(select(func.count()).select_from(AIRunLLMExchange).where(AIRunLLMExchange.started_at < cutoff)) or 0
            result = {"traceSpansDeleted": int(trace_spans), "llmExchangesDeleted": int(llm_exchanges)}
            db.rollback()
        else:
            result = prune_ai_trace_records(db, retention_days=retention_days)
            db.commit()

    print(
        " ".join(
            [
                f"retention_days={retention_days}",
                f"trace_spans={result['traceSpansDeleted']}",
                f"llm_exchanges={result['llmExchangesDeleted']}",
                f"dry_run={str(args.dry_run).lower()}",
            ]
        )
    )


if __name__ == "__main__":
    main()
