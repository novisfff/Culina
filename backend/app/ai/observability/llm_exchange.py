from __future__ import annotations

import logging
import hashlib
import json
from time import perf_counter
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from sqlalchemy.orm import Session

from app.ai.observability import error_codes
from app.ai.observability.redaction import redact_for_trace
from app.core.config import get_settings
from app.core.utils import create_id, utcnow
from app.models.domain import AIRunLLMExchange

logger = logging.getLogger(__name__)


class LLMExchangeHandle:
    def __init__(self, recorder: "LLMExchangeRecorder", exchange: AIRunLLMExchange | None, *, started_perf: float) -> None:
        self.recorder = recorder
        self.exchange = exchange
        self.started_perf = started_perf

    def finish(
        self,
        *,
        response_message: Any,
        response_text: str | None,
        response_tool_calls: list[dict[str, Any]] | None = None,
        stream_chunks: list[dict[str, Any]] | None = None,
        status: str = "completed",
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        if self.exchange is None:
            return
        try:
            clean_response_message = self.recorder._clean_response(self.recorder.serialize_message(response_message))
            clean_response_tool_calls = self.recorder._clean_response(response_tool_calls or [])
            clean_stream_chunks = self.recorder._clean_response(stream_chunks or [])
            clean_response_text = self.recorder._clean_response(response_text) if response_text is not None else None
            original_response_payload = self.recorder._clean_response(
                {
                    "message": self.recorder.serialize_message(response_message),
                    "text": response_text,
                    "toolCalls": response_tool_calls or [],
                    "streamChunks": stream_chunks or [],
                },
                max_bytes=0,
            )
            response_payload = {
                "message": clean_response_message,
                "text": clean_response_text,
                "toolCalls": clean_response_tool_calls,
                "streamChunks": clean_stream_chunks,
            }
            response_original_digest, response_original_bytes, _ = self.recorder.payload_metadata(original_response_payload)
            response_digest, response_bytes, response_truncated = self.recorder.payload_metadata(response_payload)
            self.recorder._safe_update(
                self.exchange,
                response_message=clean_response_message,
                response_text=self.recorder.response_text_value(clean_response_text),
                response_tool_calls=clean_response_tool_calls,
                stream_chunks=clean_stream_chunks,
                response_original_digest=response_original_digest,
                response_original_bytes=response_original_bytes,
                response_digest=response_digest,
                response_bytes=response_bytes,
                response_truncated=response_truncated,
                status=status,
                error_code=error_code,
                error_message=error_message,
                ended_at=utcnow(),
                duration_ms=int((perf_counter() - self.started_perf) * 1000),
            )
        except Exception:
            logger.exception(
                "AI LLM exchange finish failed run_id=%s trace_id=%s exchange_id=%s",
                self.recorder.run_id,
                self.recorder.trace_id,
                getattr(self.exchange, "id", None),
            )

    def fail(self, *, error_code: str, error_message: str, response_message: Any | None = None) -> None:
        self.finish(
            response_message=response_message or {},
            response_text=None,
            response_tool_calls=[],
            stream_chunks=[],
            status="failed",
            error_code=error_code,
            error_message=error_message,
        )


class LLMExchangeRecorder:
    def __init__(
        self,
        *,
        db: Session,
        family_id: str,
        run_id: str,
        conversation_id: str | None,
        trace_id: str,
        user_id: str | None = None,
        span_id: str | None = None,
        durable_writes: bool = False,
    ) -> None:
        settings = get_settings()
        self.enabled = bool(getattr(settings, "ai_trace_enabled", True)) and bool(
            getattr(settings, "ai_trace_capture_llm_exchanges", True)
        )
        self.capture_stream_chunks = bool(getattr(settings, "ai_trace_capture_stream_chunks", False))
        self.capture_image_bytes = bool(getattr(settings, "ai_trace_capture_image_bytes", False))
        self.payload_mode = str(getattr(settings, "ai_trace_payload_mode", "redacted") or "redacted")
        self.max_request_bytes = int(getattr(settings, "ai_trace_max_request_bytes", 1024 * 1024) or 1024 * 1024)
        self.max_response_bytes = int(getattr(settings, "ai_trace_max_response_bytes", 1024 * 1024) or 1024 * 1024)
        self.db = db
        self.family_id = family_id
        self.run_id = run_id
        self.conversation_id = conversation_id
        self.trace_id = trace_id
        self.user_id = user_id
        self.span_id = span_id
        del durable_writes
        self.durable_writes = True

    def start_exchange(
        self,
        *,
        span_id: str | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
        model: str,
        request_messages: list[Any],
        request_tools: list[dict[str, Any]],
        request_options: dict[str, Any],
    ) -> LLMExchangeHandle:
        started_perf = perf_counter()
        if not self.enabled:
            return LLMExchangeHandle(self, None, started_perf=started_perf)
        try:
            exchange = AIRunLLMExchange(
                id=create_id("ai_llm_exchange"),
                family_id=self.family_id,
                run_id=self.run_id,
                conversation_id=self.conversation_id,
                trace_id=self.trace_id,
                span_id=span_id or self.span_id,
                provider_round=provider_round,
                attempt_index=attempt_index,
                mode=mode,
                model=model,
                request_messages=[],
                request_tools=[],
                request_options={},
                request_original_digest="",
                request_original_bytes=0,
                request_digest="",
                request_bytes=0,
                request_truncated=False,
                response_message={},
                response_text=None,
                response_tool_calls=[],
                stream_chunks=[],
                response_original_digest="",
                response_original_bytes=0,
                response_digest="",
                response_bytes=0,
                response_truncated=False,
                status="running",
                started_at=utcnow(),
                duration_ms=0,
                created_by=self.user_id,
            )
            raw_request_payload = {
                "messages": [self.serialize_message(message) for message in request_messages],
                "tools": request_tools,
                "options": request_options,
            }
            original_request_payload = self._clean_request(raw_request_payload, max_bytes=0)
            cleaned_request_payload = {
                "messages": self._clean_request(raw_request_payload["messages"]),
                "tools": self._clean_request(raw_request_payload["tools"]),
                "options": self._clean_request(raw_request_payload["options"]),
            }
            request_original_digest, request_original_bytes, _ = self.payload_metadata(original_request_payload)
            request_digest, request_bytes, request_truncated = self.payload_metadata(cleaned_request_payload)
            exchange.request_messages = cleaned_request_payload.get("messages", [])
            exchange.request_tools = cleaned_request_payload.get("tools", [])
            exchange.request_options = cleaned_request_payload.get("options", {})
            exchange.request_original_digest = request_original_digest
            exchange.request_original_bytes = request_original_bytes
            exchange.request_digest = request_digest
            exchange.request_bytes = request_bytes
            exchange.request_truncated = request_truncated
            self._commit_durable_exchange(exchange)
        except Exception:
            logger.exception(
                "AI LLM exchange start failed run_id=%s trace_id=%s round=%s attempt=%s",
                self.run_id,
                self.trace_id,
                provider_round,
                attempt_index,
            )
            return LLMExchangeHandle(self, None, started_perf=started_perf)
        return LLMExchangeHandle(self, exchange, started_perf=started_perf)

    def serialize_message(self, message: Any) -> dict[str, Any]:
        if isinstance(message, SystemMessage):
            role = "system"
        elif isinstance(message, HumanMessage):
            role = "user"
        elif isinstance(message, AIMessage):
            role = "assistant"
        elif isinstance(message, ToolMessage):
            role = "tool"
        elif isinstance(message, BaseMessage):
            role = str(getattr(message, "type", "message") or "message")
        elif isinstance(message, dict):
            return message
        else:
            return {"type": type(message).__name__, "repr": str(message)}
        return {
            "role": role,
            "type": type(message).__name__,
            "content": getattr(message, "content", None),
            "toolCalls": list(getattr(message, "tool_calls", None) or []),
            "toolCallChunks": list(getattr(message, "tool_call_chunks", None) or []),
            "toolCallId": getattr(message, "tool_call_id", None),
            "id": getattr(message, "id", None),
        }

    def stream_chunks_payload(self, chunks: list[str]) -> list[dict[str, Any]]:
        try:
            if not self.capture_stream_chunks:
                return []
            return [{"index": index, "text": text} for index, text in enumerate(chunks)]
        except Exception:
            logger.exception("AI LLM exchange stream chunk capture failed run_id=%s trace_id=%s", self.run_id, self.trace_id)
            return []

    def provider_error_code(self, *, mode: str, empty: bool = False, max_rounds: bool = False) -> str:
        if empty:
            return error_codes.PROVIDER_EMPTY_RESPONSE
        if max_rounds:
            return error_codes.PROVIDER_MAX_ROUNDS_EXCEEDED
        if mode == "blocking":
            return error_codes.PROVIDER_BLOCKING_FAILED
        return error_codes.PROVIDER_STREAM_FAILED

    def _safe_update(self, exchange: AIRunLLMExchange, **values: Any) -> None:
        try:
            for key, value in values.items():
                setattr(exchange, key, value)
            if values:
                self._commit_durable_update(exchange.id, values)
        except Exception:
            logger.exception(
                "AI LLM exchange update failed run_id=%s trace_id=%s exchange_id=%s",
                self.run_id,
                self.trace_id,
                getattr(exchange, "id", None),
            )

    def _clean_request(self, value: Any, *, max_bytes: int | None = None) -> Any:
        return redact_for_trace(
            value,
            payload_mode=self.payload_mode,
            max_bytes=self.max_request_bytes if max_bytes is None else max_bytes,
            capture_image_bytes=self.capture_image_bytes,
        )

    def _clean_response(self, value: Any, *, max_bytes: int | None = None) -> Any:
        return redact_for_trace(
            value,
            payload_mode=self.payload_mode,
            max_bytes=self.max_response_bytes if max_bytes is None else max_bytes,
            capture_image_bytes=self.capture_image_bytes,
        )

    def payload_metadata(self, value: Any) -> tuple[str, int, bool]:
        try:
            serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            serialized = json.dumps(str(value), ensure_ascii=False)
        encoded = serialized.encode("utf-8")
        truncated = self.contains_truncation(value)
        return hashlib.sha256(encoded).hexdigest(), len(encoded), truncated

    def contains_truncation(self, value: Any) -> bool:
        if isinstance(value, dict):
            return bool(value.get("truncated")) or any(self.contains_truncation(item) for item in value.values())
        if isinstance(value, list):
            return any(self.contains_truncation(item) for item in value)
        return False

    def response_text_value(self, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            return str(value)

    def _new_durable_session(self) -> Session:
        return Session(
            bind=self.db.get_bind(),
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
        )

    def _commit_durable_exchange(self, exchange: AIRunLLMExchange) -> None:
        durable_db = self._new_durable_session()
        try:
            durable_db.add(exchange)
            durable_db.commit()
        except Exception:
            durable_db.rollback()
            raise
        finally:
            durable_db.close()

    def _commit_durable_update(self, exchange_id: str, values: dict[str, Any]) -> None:
        durable_db = self._new_durable_session()
        try:
            durable_exchange = durable_db.get(AIRunLLMExchange, exchange_id)
            if durable_exchange is None:
                return
            for key, value in values.items():
                setattr(durable_exchange, key, value)
            durable_db.commit()
        except Exception:
            durable_db.rollback()
            raise
        finally:
            durable_db.close()
