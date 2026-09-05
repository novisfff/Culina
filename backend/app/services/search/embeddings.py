from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.services.family_model_settings.errors import (
    FamilyModelSecretUnavailable,
    FamilyModelSettingsError,
    FamilyModelProviderTransportError,
)
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    EmbeddingUsageSnapshot,
    ResolvedSearchProfile,
)
from app.services.model_usage.adapters.embedding import (
    EmbeddingUsageAdapter,
    EmbeddingUsageDependencies,
)
from app.services.model_usage.errors import ModelUsageContractError, ModelUsageError
from app.services.model_usage.types import UsageAttribution

logger = logging.getLogger(__name__)


_SAFE_DIAGNOSTIC_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$")
_CONFIRMED_PROVIDER_FAILURE_STATUSES = frozenset(
    {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}
)
_DIAGNOSTIC_SECRET_RE = re.compile(
    r"(?i)(?:bearer\s+|api[_ -]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+"
)
_DIAGNOSTIC_URL_RE = re.compile(r"https?://[^\s,;]+", re.IGNORECASE)
_DIAGNOSTIC_REQUEST_RE = re.compile(
    r'(?i)(?:"?(?:input|prompt|messages|text)"?\s*[:=])'
    r'(?:\[[^\]]*\]|\{[^}]*\}|"[^"]*"|[^,;]+)'
)
_DIAGNOSTIC_SECRET_VALUE_RE = re.compile(
    r"(?i)^(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}$"
)


def _safe_diagnostic_code(
    value: object,
    *,
    sensitive_values: Sequence[str] = (),
) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not _SAFE_DIAGNOSTIC_CODE_RE.fullmatch(value):
        return None
    if _DIAGNOSTIC_SECRET_VALUE_RE.fullmatch(value):
        return None
    if any(secret and secret in value for secret in sensitive_values):
        return None
    return value


def _safe_diagnostic_text(
    value: object,
    *,
    max_length: int = 240,
    sensitive_values: Sequence[str] = (),
) -> str | None:
    if not isinstance(value, str):
        return None
    # Provider errors are untrusted input.  Normalize controls and redact the
    # common credential/endpoint forms before retaining a short diagnostic.
    value = " ".join(value.replace("\r", " ").replace("\n", " ").split())
    value = _DIAGNOSTIC_SECRET_RE.sub("[redacted]", value)
    value = _DIAGNOSTIC_URL_RE.sub("[provider-url]", value)
    value = _DIAGNOSTIC_REQUEST_RE.sub("request=[redacted]", value)
    for sensitive in sensitive_values:
        if sensitive:
            value = value.replace(sensitive, "[request-content]")
    if not value:
        return None
    return value[:max_length]


def _provider_error_fields(
    response: ProviderResponse,
    *,
    sensitive_values: Sequence[str] = (),
) -> tuple[str | None, str | None]:
    """Extract a tiny allow-listed error tuple from a provider response."""

    try:
        body = response.json()
    except Exception:
        return None, None
    if not isinstance(body, dict):
        return None, None

    # OpenAI-compatible providers commonly use ``error: {code, type,
    # message}``, while a few gateways put the fields at the top level.  Do
    # not recursively walk arbitrary JSON: that could retain request text.
    candidates: list[dict[str, object]] = [body]
    nested = body.get("error")
    if isinstance(nested, dict):
        candidates.insert(0, nested)
    provider_code: str | None = None
    provider_message: str | None = None
    for candidate in candidates:
        if provider_code is None:
            for key in ("code", "type", "error_code"):
                provider_code = _safe_diagnostic_code(
                    candidate.get(key),
                    sensitive_values=sensitive_values,
                )
                if provider_code:
                    break
        if provider_message is None:
            for key in ("message", "detail", "error_message"):
                provider_message = _safe_diagnostic_text(
                    candidate.get(key),
                    sensitive_values=sensitive_values,
                )
                if provider_message:
                    break
        if provider_code and provider_message:
            break
    return provider_code, provider_message


def _provider_failure_detail(
    *,
    status_code: int,
    provider_error_code: str | None,
    provider_error_message: str | None,
) -> str:
    detail = f"嵌入服务拒绝了请求（HTTP {status_code}）"
    if provider_error_code:
        detail += f"：{provider_error_code}"
    if provider_error_message:
        detail += f"，{provider_error_message}"
    return _safe_diagnostic_text(detail) or "嵌入服务拒绝了请求"


class EmbeddingUnavailableError(RuntimeError):
    """A safe, structured signal for an embedding request that did not finish.

    The old implementation collapsed every provider/transport outcome into a
    bare ``RuntimeError``.  That made a failed search replacement impossible
    to diagnose and, more importantly, encouraged callers to treat a confirmed
    provider rejection and an ambiguous network failure as the same thing.
    Only bounded, redacted values are kept here; provider response bodies,
    credentials and request text never travel past this boundary.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "search_embedding_unavailable",
        safe_detail: str | None = None,
        status_code: int | None = None,
        provider_error_code: str | None = None,
        provider_error_message: str | None = None,
        request_sent: bool | None = None,
        execution_certainty: str | None = None,
    ) -> None:
        self.code = _safe_diagnostic_code(code) or "search_embedding_unavailable"
        self.status_code = status_code if isinstance(status_code, int) and 100 <= status_code <= 599 else None
        # ``provider_http_status`` is the name used by the progress API.  Keep
        # both spellings on the exception so older call sites/tests can use
        # ``status_code`` without an adapter shim.
        self.provider_http_status = self.status_code
        self.provider_error_code = _safe_diagnostic_code(provider_error_code)
        self.provider_error_message = _safe_diagnostic_text(provider_error_message)
        self.request_sent = request_sent if isinstance(request_sent, bool) else None
        self.execution_certainty = (
            execution_certainty
            if execution_certainty in {"confirmed_executed", "confirmed_not_executed", "unknown"}
            else None
        )
        self.safe_detail = _safe_diagnostic_text(safe_detail) or _safe_diagnostic_text(message) or "嵌入服务不可用"
        # A few integrations use the shorter names when serializing a failure.
        self.provider_message = self.provider_error_message
        self.request_was_sent = self.request_sent
        super().__init__(message)

    def diagnostic_record(self) -> dict[str, object]:
        """Return only the bounded fields safe for persistence/UI projection."""

        return {
            "code": self.code,
            "detail": self.safe_detail,
            "provider_http_status": self.provider_http_status,
            "provider_error_code": self.provider_error_code,
            "provider_error_message": self.provider_error_message,
            "request_sent": self.request_sent,
            "execution_certainty": self.execution_certainty,
        }


class _KnownNoSendEmbeddingFailure(RuntimeError):
    """Credential resolution failed after admission but before any transport call."""

    pass


class _ConfirmedEmbeddingProviderFailure(RuntimeError):
    def __init__(
        self,
        *,
        status_code: int,
        provider_error_code: str | None = None,
        provider_error_message: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.provider_error_code = provider_error_code
        self.provider_error_message = provider_error_message
        super().__init__("embedding provider rejected request")


@dataclass(frozen=True, slots=True)
class MeteredEmbeddingResult:
    """Embedding vectors paired with the durable event created for their send."""

    vectors: list[list[float]]
    # Local development can intentionally run with model usage disabled.  In
    # required mode this is always a durable event ID.
    usage_event_id: str | None


class EmbeddingClient(Protocol):
    model: str
    dimensions: int

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        ...

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        ...


@dataclass
class DisabledEmbeddingClient:
    model: str = ""
    dimensions: int = 0

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key, usage_snapshot
        raise EmbeddingUnavailableError("search embedding provider disabled")

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        del texts, attribution, attempt_key, usage_snapshot
        raise EmbeddingUnavailableError("search embedding provider disabled")


def estimate_embedding_tokens(text: str) -> int:
    """Use a deterministic, privacy-safe conservative token estimate.

    The provider's reported usage replaces this at settlement whenever it is
    available.  It is deliberately based only on the transient request bytes
    and is never persisted or logged.
    """

    if not isinstance(text, str):
        raise ModelUsageContractError("embedding_text_invalid")
    return max(1, (len(text.encode("utf-8")) + 3) // 4)


class OpenAICompatibleEmbeddingClient:
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model: str,
        dimensions: int,
        timeout_seconds: float,
        usage_adapter: EmbeddingUsageAdapter | None = None,
        model_usage_required: bool = False,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions
        self.timeout = httpx.Timeout(max(timeout_seconds, 5.0), connect=10.0)
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        result = self.embed_batch(
            [text],
            attribution=attribution,
            attempt_key=attempt_key,
            usage_snapshot=usage_snapshot,
        )
        if len(result.vectors) != 1:
            raise EmbeddingUnavailableError("embedding response count mismatch")
        return result

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        if not texts:
            return MeteredEmbeddingResult(vectors=[], usage_event_id=None)
        if any(not isinstance(text, str) for text in texts):
            raise ModelUsageContractError("embedding_text_invalid")
        if attribution is None:
            raise ModelUsageContractError("model_usage_attribution_required")

        adapter = self.usage_adapter
        if adapter is None and self.model_usage_required:
            raise ModelUsageContractError("model_usage_adapter_required")

        attempt = None
        permit = None
        settlement = None
        reserve_duration_ms = 0.0
        dispatch_duration_ms = 0.0
        provider_duration_ms = 0.0
        settlement_duration_ms = 0.0
        parse_duration_ms = 0.0
        if adapter is not None:
            reserve_started_at = perf_counter()
            attempt = adapter.begin_embedding_batch(
                attribution=attribution,
                attempt_key=attempt_key,
                text_token_estimates=[estimate_embedding_tokens(text) for text in texts],
                fingerprint=adapter.request_fingerprint(texts=texts),
                usage_snapshot=usage_snapshot,
            )
            reserve_duration_ms = (perf_counter() - reserve_started_at) * 1000
            dispatch_started_at = perf_counter()
            permit = attempt.prepare_dispatch()
            dispatch_duration_ms = (perf_counter() - dispatch_started_at) * 1000

        try:
            provider_started_at = perf_counter()
            response = self._post_embeddings(texts)
            provider_duration_ms = (perf_counter() - provider_started_at) * 1000
            try:
                body = response.json()
            except Exception as exc:
                raise EmbeddingUnavailableError(
                    "embedding response invalid",
                    code="search_embedding_response_invalid",
                    safe_detail="嵌入服务返回了无法解析的响应",
                    request_sent=True,
                    execution_certainty="unknown",
                ) from exc
            if not isinstance(body, dict):
                raise EmbeddingUnavailableError(
                    "embedding response invalid",
                    code="search_embedding_response_invalid",
                    safe_detail="嵌入服务返回了无法解析的响应",
                    request_sent=True,
                    execution_certainty="unknown",
                )
            if adapter is not None and permit is not None:
                settlement_started_at = perf_counter()
                settlement = attempt.settle(
                    adapter.receipt_from_openai_response(
                        permit,
                        raw_usage=body.get("usage"),
                        reported_model=_optional_string(body.get("model")) or self.model,
                        provider_request_id=_provider_request_id(response, body),
                    )
                )
                settlement_duration_ms = (perf_counter() - settlement_started_at) * 1000
            parse_started_at = perf_counter()
            vectors = _parse_vectors(
                body,
                expected_count=len(texts),
                dimensions=self.dimensions,
            )
            parse_duration_ms = (perf_counter() - parse_started_at) * 1000
        except Exception as exc:
            # A request that reached dispatching but has no durable settlement
            # must never be automatically sent again.  This includes malformed
            # provider responses, where a successful remote charge is possible.
            if attempt is not None and permit is not None and settlement is None:
                try:
                    attempt.mark_uncertain("embedding_provider_result_unavailable")
                except Exception:
                    # Preserve the original provider/ledger failure; the
                    # dispatching reservation remains a conservative record.
                    pass
            if isinstance(exc, EmbeddingUnavailableError):
                if exc.request_sent is None:
                    exc.request_sent = True
                    exc.request_was_sent = True
                    exc.execution_certainty = (
                        "confirmed_executed" if settlement is not None else "unknown"
                    )
                raise
            if isinstance(exc, ModelUsageError):
                raise
            raise EmbeddingUnavailableError(
                "embedding request failed",
                code="search_embedding_unavailable",
                safe_detail="嵌入服务请求失败",
                request_sent=True,
                execution_certainty="unknown",
            ) from exc

        logger.info(
            "Search embedding request completed",
            extra={
                "embedding_timing": {
                    "reserve_ms": round(reserve_duration_ms, 3),
                    "dispatch_ms": round(dispatch_duration_ms, 3),
                    "provider_ms": round(provider_duration_ms, 3),
                    "settlement_ms": round(settlement_duration_ms, 3),
                    "parse_ms": round(parse_duration_ms, 3),
                    "batch_size": len(texts),
                    "model": self.model,
                    "metered": adapter is not None,
                }
            },
        )
        return MeteredEmbeddingResult(
            vectors=vectors,
            usage_event_id=settlement.event_id if settlement is not None else None,
        )

    def _post_embeddings(self, texts: list[str]) -> Any:
        payload: dict[str, object] = {"model": self.model, "input": texts}
        if self.dimensions > 0:
            payload["dimensions"] = self.dimensions
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(f"{self.api_base}/embeddings", headers=headers, json=payload)
                response.raise_for_status()
                return response
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            provider_error_code, provider_error_message = _provider_error_fields(
                exc.response,  # type: ignore[arg-type]
                sensitive_values=(*texts, self.api_key, self.api_base),
            )
            raise EmbeddingUnavailableError(
                "embedding provider rejected request",
                code="search_embedding_provider_rejected",
                safe_detail=_provider_failure_detail(
                    status_code=status_code,
                    provider_error_code=provider_error_code,
                    provider_error_message=provider_error_message,
                ),
                status_code=status_code,
                provider_error_code=provider_error_code,
                provider_error_message=provider_error_message,
                request_sent=True,
                execution_certainty="confirmed_not_executed"
                if status_code in _CONFIRMED_PROVIDER_FAILURE_STATUSES
                else "unknown",
            ) from exc
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise EmbeddingUnavailableError(
                "embedding provider transport unavailable",
                code="search_embedding_transport_uncertain",
                request_sent=True,
                execution_certainty="unknown",
            ) from exc


class FamilyOpenAICompatibleEmbeddingClient:
    """Embedding client reconstructed from an immutable family search profile.

    The profile owns endpoint/model/dimensions/collection identity, while the
    caller supplies one persisted usage snapshot for every send.  Credential
    plaintext is resolved only after the usage permit is durably dispatching.
    """

    def __init__(
        self,
        *,
        binding: ResolvedSearchProfile,
        transport: ProviderTransport,
        resolve_dispatch_credential: Callable[
            [ResolvedSearchProfile, str | None], DispatchCredential
        ],
        usage_adapter: EmbeddingUsageAdapter,
        model_usage_required: bool = True,
    ) -> None:
        if binding.adapter_kind not in {"openai_compatible_http", "dashscope"}:
            raise ModelUsageContractError("embedding_binding_adapter_unsupported")
        if usage_adapter.binding is not binding and usage_adapter.binding != binding:
            raise ModelUsageContractError("embedding_binding_required")
        self.binding = binding
        self.transport = transport
        self.resolve_dispatch_credential = resolve_dispatch_credential
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required
        self.model = binding.embedding_model
        self.dimensions = binding.dimensions

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        result = self.embed_batch(
            [text],
            attribution=attribution,
            attempt_key=attempt_key,
            usage_snapshot=usage_snapshot,
        )
        if len(result.vectors) != 1:
            raise EmbeddingUnavailableError("embedding response count mismatch")
        return result

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
    ) -> MeteredEmbeddingResult:
        if not texts:
            return MeteredEmbeddingResult(vectors=[], usage_event_id=None)
        if any(not isinstance(text, str) for text in texts):
            raise ModelUsageContractError("embedding_text_invalid")
        if attribution is None:
            raise ModelUsageContractError("model_usage_attribution_required")
        if usage_snapshot is None:
            raise ModelUsageContractError("embedding_usage_snapshot_required")
        if not self.model_usage_required:
            raise ModelUsageContractError("family_embedding_usage_required")

        adapter = self.usage_adapter
        attempt = adapter.begin_embedding_batch(
            attribution=attribution,
            attempt_key=attempt_key,
            text_token_estimates=[estimate_embedding_tokens(text) for text in texts],
            fingerprint=adapter.request_fingerprint(texts=texts),
            usage_snapshot=usage_snapshot,
        )
        permit = attempt.prepare_dispatch()
        settlement = None
        credential: DispatchCredential | None = None
        response: ProviderResponse | None = None
        try:
            try:
                credential = self.resolve_dispatch_credential(
                    self.binding,
                    permit.credential_secret_version_id,
                )
            except (FamilyModelSecretUnavailable, FamilyModelSettingsError) as exc:
                raise _KnownNoSendEmbeddingFailure() from exc
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            if self.binding.auth_mode == "api_key":
                if not credential.api_key:
                    raise _KnownNoSendEmbeddingFailure()
                headers["Authorization"] = f"Bearer {credential.api_key}"
            if permit.provider_idempotency_key:
                headers["Idempotency-Key"] = permit.provider_idempotency_key
            response = self.transport.request(
                "POST",
                _embedding_endpoint_url(self.binding),
                headers=headers,
                json=_embedding_payload(self.binding, texts),
            )
            if not 200 <= response.status_code < 300:
                provider_error_code, provider_error_message = _provider_error_fields(
                    response,
                    sensitive_values=(
                        *texts,
                        credential.api_key or "",
                        self.binding.endpoint.normalized_url,
                    ),
                )
                if response.status_code in _CONFIRMED_PROVIDER_FAILURE_STATUSES:
                    raise _ConfirmedEmbeddingProviderFailure(
                        status_code=response.status_code,
                        provider_error_code=provider_error_code,
                        provider_error_message=provider_error_message,
                    )
                raise EmbeddingUnavailableError(
                    "embedding provider response unavailable",
                    code="search_embedding_transport_uncertain",
                    safe_detail=_provider_failure_detail(
                        status_code=response.status_code,
                        provider_error_code=provider_error_code,
                        provider_error_message=provider_error_message,
                    ),
                    status_code=response.status_code,
                    provider_error_code=provider_error_code,
                    provider_error_message=provider_error_message,
                    request_sent=True,
                    execution_certainty="unknown",
                )
            try:
                body = response.json()
            except Exception as exc:
                raise EmbeddingUnavailableError(
                    "embedding response invalid",
                    code="search_embedding_response_invalid",
                    request_sent=True,
                    execution_certainty="unknown",
                ) from exc
            if not isinstance(body, dict):
                raise EmbeddingUnavailableError(
                    "embedding response invalid",
                    code="search_embedding_response_invalid",
                    request_sent=True,
                    execution_certainty="unknown",
                )
            settlement = attempt.settle(
                adapter.receipt_from_openai_response(
                    permit,
                    raw_usage=body.get("usage"),
                    reported_model=_optional_string(body.get("model")) or self.model,
                    provider_request_id=_provider_request_id(response, body),
                )
            )
            vectors = _parse_vectors(
                body,
                expected_count=len(texts),
                dimensions=self.dimensions,
                adapter_kind=self.binding.adapter_kind,
            )
        except _KnownNoSendEmbeddingFailure as exc:
            # The permit exists but credential decrypt/auth header assembly did
            # not reach ProviderTransport, so settle a zero, confirmed-no-send
            # receipt instead of leaving an unnecessary uncertain reservation.
            settlement = attempt.settle(adapter.confirmed_not_executed_receipt(permit))
            raise EmbeddingUnavailableError(
                "family_model_secret_unavailable",
                code="family_model_secret_unavailable",
                safe_detail="当前嵌入服务的凭据不可用",
                request_sent=False,
                execution_certainty="confirmed_not_executed",
            ) from exc
        except _ConfirmedEmbeddingProviderFailure as exc:
            settlement = attempt.settle(adapter.confirmed_not_executed_receipt(permit))
            raise EmbeddingUnavailableError(
                "embedding provider rejected request",
                code="search_embedding_provider_rejected",
                safe_detail=_provider_failure_detail(
                    status_code=exc.status_code,
                    provider_error_code=exc.provider_error_code,
                    provider_error_message=exc.provider_error_message,
                ),
                status_code=exc.status_code,
                provider_error_code=exc.provider_error_code,
                provider_error_message=exc.provider_error_message,
                request_sent=True,
                execution_certainty="confirmed_not_executed",
            ) from exc
        except Exception as exc:
            if settlement is None:
                try:
                    attempt.mark_uncertain("embedding_provider_result_unavailable")
                except Exception:
                    pass
            if isinstance(exc, (EmbeddingUnavailableError, ModelUsageError, ModelUsageContractError)):
                if isinstance(exc, EmbeddingUnavailableError) and exc.request_sent is None:
                    # A malformed 2xx response or vector payload was reached
                    # only after the provider call.  A settled usage receipt
                    # proves execution; otherwise the conservative answer is
                    # unknown and the reservation has already been guarded.
                    exc.request_sent = True
                    exc.request_was_sent = True
                    exc.execution_certainty = (
                        "confirmed_executed" if settlement is not None else "unknown"
                    )
                raise
            if isinstance(exc, FamilyModelProviderTransportError):
                raise EmbeddingUnavailableError(
                    "embedding provider transport unavailable",
                    code="search_embedding_transport_uncertain",
                    safe_detail="嵌入服务连接中断，执行结果暂时无法确认",
                    request_sent=True,
                    execution_certainty="unknown",
                ) from exc
            raise EmbeddingUnavailableError(
                "embedding request failed",
                code="search_embedding_unavailable",
                request_sent=True,
                execution_certainty="unknown",
            ) from exc
        finally:
            credential = None

        return MeteredEmbeddingResult(
            vectors=vectors,
            usage_event_id=settlement.event_id if settlement is not None else None,
        )

def _embedding_endpoint_url(binding: ResolvedSearchProfile) -> str:
    parsed = urlsplit(binding.endpoint.normalized_url)
    endpoint_path = (
        "services/embeddings/text-embedding/text-embedding"
        if binding.adapter_kind == "dashscope"
        else "embeddings"
    )
    path = "/".join(
        part.strip("/") for part in (parsed.path, endpoint_path) if part.strip("/")
    )
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{path}", "", ""))


def _embedding_payload(
    binding: ResolvedSearchProfile,
    texts: list[str],
) -> dict[str, object]:
    if binding.adapter_kind == "dashscope":
        # DashScope's native embedding endpoint uses a different envelope
        # from its OpenAI-compatible endpoint.  Keep the profile dimensions
        # as a local output invariant; the native API chooses the model's
        # supported dimension and the parser rejects a mismatch safely.
        return {
            "model": binding.embedding_model,
            "input": {"texts": texts},
            "parameters": {"text_type": "document"},
        }
    payload: dict[str, object] = {"model": binding.embedding_model, "input": texts}
    if binding.dimensions > 0:
        payload["dimensions"] = binding.dimensions
    return payload


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _provider_request_id(response: object, body: dict[str, object]) -> str | None:
    body_id = _optional_string(body.get("id")) or _optional_string(body.get("request_id"))
    if body_id is not None:
        return body_id
    headers = getattr(response, "headers", None)
    if headers is not None:
        try:
            return _optional_string(headers.get("x-request-id"))
        except AttributeError:
            return None
    return None


def _parse_vectors(
    body: dict[str, object],
    *,
    expected_count: int,
    dimensions: int,
    adapter_kind: str | None = None,
) -> list[list[float]]:
    data = body.get("data")
    if data is None and adapter_kind == "dashscope":
        output = body.get("output")
        if isinstance(output, dict):
            data = output.get("embeddings")
    if not isinstance(data, list):
        raise EmbeddingUnavailableError("embedding response missing data")
    vectors: list[tuple[int, list[float]]] = []
    for position, item in enumerate(data):
        if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
            raise EmbeddingUnavailableError("embedding response item missing vector")
        index = item.get("index", item.get("text_index", position))
        if isinstance(index, bool) or not isinstance(index, int):
            raise EmbeddingUnavailableError("embedding response index invalid")
        try:
            vector = [float(value) for value in item["embedding"]]
        except (TypeError, ValueError) as exc:
            raise EmbeddingUnavailableError("embedding response vector invalid") from exc
        if dimensions > 0 and len(vector) != dimensions:
            raise EmbeddingUnavailableError("embedding vector dimension mismatch")
        vectors.append((index, vector))
    vectors.sort(key=lambda item: item[0])
    if len(vectors) != expected_count or [index for index, _ in vectors] != list(range(expected_count)):
        raise EmbeddingUnavailableError("embedding response count mismatch")
    return [vector for _, vector in vectors]


def build_embedding_client(
    profile: ResolvedSearchProfile | None = None,
    *,
    transport: ProviderTransport | None = None,
    usage_dependencies: EmbeddingUsageDependencies | None = None,
    resolve_dispatch_credential: Callable[
        [ResolvedSearchProfile, str | None], DispatchCredential
    ]
    | None = None,
) -> EmbeddingClient:
    """Build a family-bound client or fail closed without a resolved profile."""

    if profile is not None:
        if profile.adapter_kind not in {"openai_compatible_http", "dashscope"}:
            raise ModelUsageContractError("embedding_binding_adapter_unsupported")
        if usage_dependencies is None or resolve_dispatch_credential is None or transport is None:
            raise ModelUsageContractError("family_embedding_dependencies_required")
        return FamilyOpenAICompatibleEmbeddingClient(
            binding=profile,
            transport=transport,
            resolve_dispatch_credential=resolve_dispatch_credential,
            usage_adapter=EmbeddingUsageAdapter.for_search_profile(
                profile,
                usage_dependencies,
            ),
            model_usage_required=True,
        )
    return DisabledEmbeddingClient()
