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


def serialize_ai_run_llm_exchange(item: AIRunLLMExchange) -> dict:
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
        "requestMessages": item.request_messages,
        "requestTools": item.request_tools,
        "requestOptions": item.request_options,
        "requestOriginalDigest": item.request_original_digest,
        "requestOriginalBytes": item.request_original_bytes,
        "requestDigest": item.request_digest,
        "requestBytes": item.request_bytes,
        "requestTruncated": item.request_truncated,
        "responseMessage": item.response_message,
        "responseText": item.response_text,
        "responseToolCalls": item.response_tool_calls,
        "streamChunks": item.stream_chunks,
        "responseOriginalDigest": item.response_original_digest,
        "responseOriginalBytes": item.response_original_bytes,
        "responseDigest": item.response_digest,
        "responseBytes": item.response_bytes,
        "responseTruncated": item.response_truncated,
        "status": item.status,
        "errorCode": item.error_code,
        "errorMessage": item.error_message,
        "startedAt": _utc_datetime(item.started_at),
        "endedAt": _utc_datetime(item.ended_at),
        "durationMs": item.duration_ms,
    }
