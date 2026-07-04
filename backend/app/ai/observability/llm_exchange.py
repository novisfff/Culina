from __future__ import annotations

import logging
import hashlib
import json
from collections.abc import Mapping
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

USAGE_FIELD_KEYS = (
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cached_tokens",
    "cachedTokens",
    "input_token_details",
    "input_tokens_details",
    "output_token_details",
    "output_tokens_details",
    "prompt_tokens_details",
    "completion_tokens_details",
    "inputTokenDetails",
    "outputTokenDetails",
    "promptTokenDetails",
    "completionTokenDetails",
    "estimated_cost_usd",
    "estimatedCostUsd",
)


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
        token_usage: dict[str, Any] | None = None,
        status: str = "completed",
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        if self.exchange is None:
            return
        try:
            token_usage = token_usage or self.recorder.extract_token_usage(response_message)
            clean_response_message = self.recorder._clean_response(self.recorder.serialize_message(response_message))
            clean_response_tool_calls = self.recorder._clean_response(response_tool_calls or [])
            clean_stream_chunks = self.recorder._clean_response(stream_chunks or [])
            clean_response_text = (
                self.recorder._clean_response(response_text)
                if response_text is not None and self.recorder.capture_message_content
                else None
            )
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
                input_tokens=token_usage.get("inputTokens"),
                output_tokens=token_usage.get("outputTokens"),
                total_tokens=token_usage.get("totalTokens"),
                cached_tokens=token_usage.get("cachedTokens"),
                estimated_cost_usd=token_usage.get("estimatedCostUsd"),
                token_usage=token_usage,
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
        self.capture_message_content = bool(getattr(settings, "ai_trace_capture_message_content", False))
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
                input_tokens=None,
                output_tokens=None,
                total_tokens=None,
                cached_tokens=None,
                estimated_cost_usd=None,
                token_usage=None,
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
            if not self.capture_stream_chunks or not self.capture_message_content:
                return []
            return [{"index": index, "text": text} for index, text in enumerate(chunks)]
        except Exception:
            logger.exception("AI LLM exchange stream chunk capture failed run_id=%s trace_id=%s", self.run_id, self.trace_id)
            return []

    def extract_token_usage(self, response_message: Any) -> dict[str, Any]:
        usage_metadata = self._field_value(response_message, "usage_metadata", "usageMetadata")
        response_metadata = self._usage_mapping(
            self._field_value(response_message, "response_metadata", "responseMetadata")
        )
        additional_kwargs = self._usage_mapping(
            self._field_value(response_message, "additional_kwargs", "additionalKwargs")
        )
        token_usage = self._field_value(response_metadata, "token_usage", "tokenUsage")
        response_usage = self._field_value(response_metadata, "usage")
        additional_usage = self._field_value(additional_kwargs, "usage")
        message_usage = self._field_value(response_message, "usage", "token_usage", "tokenUsage")

        raw_usage: dict[str, Any] = {}
        for usage in (token_usage, response_usage, additional_usage, message_usage, usage_metadata):
            normalized = self._usage_mapping(usage)
            if normalized:
                raw_usage.update(normalized)

        input_tokens = self._int_usage_value(raw_usage, "input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
        output_tokens = self._int_usage_value(raw_usage, "output_tokens", "completion_tokens", "outputTokens", "completionTokens")
        total_tokens = self._int_usage_value(raw_usage, "total_tokens", "totalTokens")
        if total_tokens is None and (input_tokens is not None or output_tokens is not None):
            total_tokens = int(input_tokens or 0) + int(output_tokens or 0)

        cached_tokens = self._cached_token_count(raw_usage)
        estimated_cost = self._float_usage_value(raw_usage, "estimated_cost_usd", "estimatedCostUsd")
        if not raw_usage and all(value is None for value in (input_tokens, output_tokens, total_tokens, cached_tokens, estimated_cost)):
            return {}
        return {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "cachedTokens": cached_tokens,
            "estimatedCostUsd": estimated_cost,
            "raw": self._clean_response(raw_usage),
        }

    def _int_usage_value(self, data: dict[str, Any], *keys: str) -> int | None:
        for key in keys:
            value = data.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, float) and value.is_integer():
                return int(value)
            if isinstance(value, str):
                normalized = value.strip()
                if normalized.isdigit():
                    return int(normalized)
        return None

    def _float_usage_value(self, data: dict[str, Any], *keys: str) -> float | None:
        for key in keys:
            value = data.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                return float(value)
        return None

    def _cached_token_count(self, data: dict[str, Any]) -> int | None:
        direct = self._int_usage_value(data, "cached_tokens", "cachedTokens")
        if direct is not None:
            return direct
        for detail_key in (
            "input_token_details",
            "input_tokens_details",
            "prompt_tokens_details",
            "inputTokenDetails",
            "promptTokenDetails",
        ):
            details = data.get(detail_key)
            if not isinstance(details, dict):
                continue
            cached = self._int_usage_value(details, "cache_read", "cached_tokens", "cachedTokens")
            if cached is not None:
                return cached
        return None

    def _field_value(self, value: Any, *keys: str) -> Any:
        if value is None:
            return None
        if isinstance(value, Mapping):
            for key in keys:
                if key in value:
                    return value[key]
            return None
        for key in keys:
            if hasattr(value, key):
                return getattr(value, key)
        return None

    def _usage_mapping(self, value: Any) -> dict[str, Any]:
        normalized = self._normalize_usage_value(value)
        return normalized if isinstance(normalized, dict) else {}

    def _normalize_usage_value(self, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, Mapping):
            return {str(key): self._normalize_usage_value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._normalize_usage_value(item) for item in value]
        if hasattr(value, "model_dump"):
            try:
                return self._normalize_usage_value(value.model_dump())
            except Exception:
                pass
        if hasattr(value, "dict"):
            try:
                return self._normalize_usage_value(value.dict())
            except Exception:
                pass
        if hasattr(value, "__dict__") and not isinstance(value, (str, bytes, bytearray)):
            public_values = {
                key: item
                for key, item in vars(value).items()
                if not key.startswith("_") and not callable(item)
            }
            if public_values:
                return self._normalize_usage_value(public_values)
        object_values = {
            key: getattr(value, key)
            for key in USAGE_FIELD_KEYS
            if hasattr(value, key) and not callable(getattr(value, key))
        }
        if object_values:
            return self._normalize_usage_value(object_values)
        return value

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
            capture_message_content=self.capture_message_content,
        )

    def _clean_response(self, value: Any, *, max_bytes: int | None = None) -> Any:
        return redact_for_trace(
            value,
            payload_mode=self.payload_mode,
            max_bytes=self.max_response_bytes if max_bytes is None else max_bytes,
            capture_image_bytes=self.capture_image_bytes,
            capture_message_content=self.capture_message_content,
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
