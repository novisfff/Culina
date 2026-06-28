from __future__ import annotations

from app.models.domain import AIRunLLMExchange, AIRunTraceSpan
from app.services.serializers import _utc_datetime


def serialize_ai_run_trace_span(item: AIRunTraceSpan) -> dict:
    return {
        "id": item.id,
        "runId": item.run_id,
        "conversationId": item.conversation_id,
        "traceId": item.trace_id,
        "spanId": item.span_id,
        "parentSpanId": item.parent_span_id,
        "spanType": item.span_type,
        "name": item.name,
        "status": item.status,
        "roundIndex": item.round_index,
        "attemptIndex": item.attempt_index,
        "startedAt": _utc_datetime(item.started_at),
        "endedAt": _utc_datetime(item.ended_at),
        "durationMs": item.duration_ms,
        "inputSummary": item.input_summary,
        "outputSummary": item.output_summary,
        "errorCode": item.error_code,
        "errorMessage": item.error_message,
        "exceptionType": item.exception_type,
        "payload": item.payload,
    }


def _tool_name_from_payload(item: object) -> str | None:
    if not isinstance(item, dict):
        return None
    for key in ("name", "tool", "functionName", "internal_code"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    function = item.get("function")
    if isinstance(function, dict):
        value = function.get("name")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _tool_names(items: list[dict]) -> list[str]:
    names: list[str] = []
    for item in items:
        name = _tool_name_from_payload(item)
        if name and name not in names:
            names.append(name)
    return names


def serialize_ai_run_llm_exchange(item: AIRunLLMExchange, *, include_payload: bool = True) -> dict:
    request_tool_names = _tool_names(item.request_tools or [])
    response_tool_call_names = _tool_names(item.response_tool_calls or [])
    return {
        "id": item.id,
        "runId": item.run_id,
        "conversationId": item.conversation_id,
        "traceId": item.trace_id,
        "spanId": item.span_id,
        "providerRound": item.provider_round,
        "attemptIndex": item.attempt_index,
        "mode": item.mode,
        "model": item.model,
        "requestToolCount": len(item.request_tools or []),
        "requestToolNames": request_tool_names,
        "responseToolCallCount": len(item.response_tool_calls or []),
        "responseToolCallNames": response_tool_call_names,
        "payloadIncluded": include_payload,
        "requestMessages": item.request_messages if include_payload else [],
        "requestTools": item.request_tools if include_payload else [],
        "requestOptions": item.request_options if include_payload else {},
        "requestOriginalDigest": item.request_original_digest,
        "requestOriginalBytes": item.request_original_bytes,
        "requestDigest": item.request_digest,
        "requestBytes": item.request_bytes,
        "requestTruncated": item.request_truncated,
        "responseMessage": item.response_message if include_payload else {},
        "responseText": item.response_text if include_payload else None,
        "responseToolCalls": item.response_tool_calls if include_payload else [],
        "streamChunks": item.stream_chunks if include_payload else [],
        "responseOriginalDigest": item.response_original_digest,
        "responseOriginalBytes": item.response_original_bytes,
        "responseDigest": item.response_digest,
        "responseBytes": item.response_bytes,
        "responseTruncated": item.response_truncated,
        "inputTokens": item.input_tokens,
        "outputTokens": item.output_tokens,
        "totalTokens": item.total_tokens,
        "cachedTokens": item.cached_tokens,
        "estimatedCostUsd": item.estimated_cost_usd,
        "tokenUsage": item.token_usage or {},
        "status": item.status,
        "errorCode": item.error_code,
        "errorMessage": item.error_message,
        "startedAt": _utc_datetime(item.started_at),
        "endedAt": _utc_datetime(item.ended_at),
        "durationMs": item.duration_ms,
    }
