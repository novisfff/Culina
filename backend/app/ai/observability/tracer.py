from __future__ import annotations

import logging
from time import perf_counter
from typing import Any

from sqlalchemy.orm import Session

from app.ai.observability import error_codes
from app.ai.observability.redaction import redact_for_trace
from app.core.config import get_settings
from app.core.utils import create_id, utcnow
from app.models.domain import AIRunTraceSpan

logger = logging.getLogger(__name__)


class TraceSpanContext:
    def __init__(
        self,
        tracer: "AIRunTracer",
        span: AIRunTraceSpan | None,
        *,
        started_perf: float,
    ) -> None:
        self.tracer = tracer
        self.span = span
        self.started_perf = started_perf
        self._finished = False

    @property
    def span_id(self) -> str | None:
        return self.span.span_id if self.span is not None else None

    def set_output_summary(self, output_summary: dict[str, Any]) -> None:
        if self.span is None:
            return
        self.tracer._safe_update(self.span, output_summary=output_summary)

    def set_payload(self, payload: dict[str, Any]) -> None:
        if self.span is None:
            return
        self.tracer._safe_update(self.span, payload=payload)

    def finish(
        self,
        *,
        status: str | None = "completed",
        output_summary: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        exception_type: str | None = None,
    ) -> None:
        if self.span is None:
            return
        if self._finished:
            return
        self._finished = True
        ended_at = utcnow()
        update: dict[str, Any] = {
            "status": self.tracer._terminal_status(status),
            "ended_at": ended_at,
            "duration_ms": int((perf_counter() - self.started_perf) * 1000),
            "error_code": error_code,
            "error_message": error_message,
            "exception_type": exception_type,
        }
        if output_summary is not None:
            update["output_summary"] = output_summary
        self.tracer._safe_update(self.span, **update)

    def __enter__(self) -> "TraceSpanContext":
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, _tb: Any) -> bool:
        if exc is None:
            self.finish()
            return False
        error_code = self.tracer.error_code_for_exception(exc)
        self.finish(
            status="failed",
            error_code=error_code,
            error_message=str(exc),
            exception_type=exc_type.__name__ if exc_type is not None else type(exc).__name__,
        )
        return False


class AIRunTracer:
    def __init__(
        self,
        *,
        db: Session,
        family_id: str,
        run_id: str,
        conversation_id: str | None,
        user_id: str | None = None,
        trace_id: str | None = None,
        durable_writes: bool = False,
    ) -> None:
        settings = get_settings()
        self.enabled = bool(getattr(settings, "ai_trace_enabled", True))
        self.db = db
        self.family_id = family_id
        self.run_id = run_id
        self.conversation_id = conversation_id
        self.user_id = user_id
        self.trace_id = trace_id or create_id("ai_trace")
        del durable_writes
        self.durable_writes = True
        self.payload_mode = str(getattr(settings, "ai_trace_payload_mode", "redacted") or "redacted")
        self.capture_image_bytes = bool(getattr(settings, "ai_trace_capture_image_bytes", False))
        self.max_request_bytes = int(getattr(settings, "ai_trace_max_request_bytes", 1024 * 1024) or 1024 * 1024)
        self.max_response_bytes = int(getattr(settings, "ai_trace_max_response_bytes", 1024 * 1024) or 1024 * 1024)

    def start_span(
        self,
        span_type: str,
        name: str,
        *,
        parent_span_id: str | None = None,
        round_index: int | None = None,
        attempt_index: int | None = None,
        input_summary: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> TraceSpanContext:
        started_perf = perf_counter()
        if not self.enabled:
            return TraceSpanContext(self, None, started_perf=started_perf)
        try:
            span_id = create_id("ai_span")
            span = AIRunTraceSpan(
                id=span_id,
                family_id=self.family_id,
                run_id=self.run_id,
                conversation_id=self.conversation_id,
                trace_id=self.trace_id,
                span_id=span_id,
                parent_span_id=parent_span_id,
                span_type=span_type,
                name=name[:120],
                status="running",
                round_index=round_index,
                attempt_index=attempt_index,
                started_at=utcnow(),
                input_summary=self._clean_payload(input_summary or {}, max_bytes=self.max_request_bytes),
                output_summary={},
                payload=self._clean_payload(payload or {}, max_bytes=self.max_request_bytes),
                created_by=self.user_id,
            )
            self._commit_durable_span(span)
        except Exception:
            logger.exception(
                "AI trace span start failed run_id=%s trace_id=%s span_type=%s name=%s",
                self.run_id,
                self.trace_id,
                span_type,
                name,
            )
            return TraceSpanContext(self, None, started_perf=started_perf)
        return TraceSpanContext(self, span, started_perf=started_perf)

    def record_event(
        self,
        span_type: str,
        name: str,
        *,
        status: str | None = "completed",
        parent_span_id: str | None = None,
        round_index: int | None = None,
        attempt_index: int | None = None,
        payload: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        with self.start_span(
            span_type,
            name,
            parent_span_id=parent_span_id,
            round_index=round_index,
            attempt_index=attempt_index,
            payload=payload,
        ) as span:
            span.finish(status=status, error_code=error_code, error_message=error_message)

    def child(self, *, run_id: str | None = None, conversation_id: str | None = None) -> "AIRunTracer":
        return AIRunTracer(
            db=self.db,
            family_id=self.family_id,
            run_id=run_id or self.run_id,
            conversation_id=conversation_id if conversation_id is not None else self.conversation_id,
            user_id=self.user_id,
            trace_id=self.trace_id,
            durable_writes=self.durable_writes,
        )

    def error_code_for_exception(self, exc: BaseException) -> str:
        if exc.__class__.__name__ == "AIExecutionCancelled":
            return error_codes.CANCELLED
        return error_codes.UNEXPECTED_ERROR

    def _clean_payload(self, value: Any, *, max_bytes: int) -> Any:
        return redact_for_trace(
            value,
            payload_mode=self.payload_mode,
            max_bytes=max_bytes,
            capture_image_bytes=self.capture_image_bytes,
        )

    def _terminal_status(self, status: str | None) -> str:
        normalized = str(status or "").strip()
        return normalized or "completed"

    def _safe_update(self, span: AIRunTraceSpan, **values: Any) -> None:
        try:
            cleaned_values: dict[str, Any] = {}
            for key, value in values.items():
                if key in {"input_summary", "payload"}:
                    value = self._clean_payload(value, max_bytes=self.max_request_bytes)
                elif key == "output_summary":
                    value = self._clean_payload(value, max_bytes=self.max_response_bytes)
                cleaned_values[key] = value
                setattr(span, key, value)
            if cleaned_values:
                self._commit_durable_update(span.id, cleaned_values)
        except Exception:
            logger.exception(
                "AI trace span update failed run_id=%s trace_id=%s span_id=%s",
                self.run_id,
                self.trace_id,
                getattr(span, "span_id", None),
            )

    def _new_durable_session(self) -> Session:
        return Session(
            bind=self.db.get_bind(),
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
        )

    def _commit_durable_span(self, span: AIRunTraceSpan) -> None:
        durable_db = self._new_durable_session()
        try:
            durable_db.add(span)
            durable_db.commit()
        except Exception:
            durable_db.rollback()
            raise
        finally:
            durable_db.close()

    def _commit_durable_update(self, span_id: str, values: dict[str, Any]) -> None:
        durable_db = self._new_durable_session()
        try:
            durable_span = durable_db.get(AIRunTraceSpan, span_id)
            if durable_span is None:
                return
            for key, value in values.items():
                setattr(durable_span, key, value)
            durable_db.commit()
        except Exception:
            durable_db.rollback()
            raise
        finally:
            durable_db.close()
