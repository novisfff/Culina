from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.adapters.rerank import RerankUsageAdapter
from app.services.model_usage.errors import ModelUsageContractError, ModelUsageError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import DispatchPermit, UsageAttribution


class RerankUnavailableError(RuntimeError):
    """A safe local-fallback signal with no provider payload attached."""

    def __init__(self, message: str, *, code: str = "search_rerank_unavailable") -> None:
        self.code = code
        super().__init__(message)


class _ConfirmedRerankProviderFailure(RuntimeError):
    def __init__(self, message: str, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(message)


class _AmbiguousRerankTransportFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class RerankResult:
    index: int
    relevance_score: float


class RerankClient(Protocol):
    enabled: bool

    def rerank(
        self,
        *,
        query: str,
        documents: list[str],
        top_n: int,
        attribution: UsageAttribution | None = None,
        attempt_key: str | None = None,
    ) -> list[RerankResult]:
        ...


@dataclass
class DisabledRerankClient:
    enabled: bool = False

    def rerank(
        self,
        *,
        query: str,
        documents: list[str],
        top_n: int,
        attribution: UsageAttribution | None = None,
        attempt_key: str | None = None,
    ) -> list[RerankResult]:
        del query, documents, top_n, attribution, attempt_key
        raise RerankUnavailableError("search rerank provider disabled", code="search_rerank_unavailable")


class OpenAICompatibleRerankClient:
    enabled = True

    def __init__(
        self,
        *,
        provider: str,
        api_base: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        instruct: str = "",
        transport: httpx.BaseTransport | None = None,
        usage_adapter: RerankUsageAdapter | None = None,
        model_usage_required: bool = False,
    ) -> None:
        self.provider = provider.strip().lower()
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = httpx.Timeout(max(timeout_seconds, 5.0), connect=10.0)
        self.instruct = instruct.strip()
        self.transport = transport
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required

    def rerank(
        self,
        *,
        query: str,
        documents: list[str],
        top_n: int,
        attribution: UsageAttribution | None = None,
        attempt_key: str | None = None,
    ) -> list[RerankResult]:
        if not query.strip() or not documents or top_n <= 0:
            return []
        if any(not isinstance(document, str) for document in documents):
            raise ModelUsageContractError("rerank_document_invalid")

        adapter = self.usage_adapter
        if adapter is None and self.model_usage_required:
            raise ModelUsageContractError("model_usage_adapter_required")
        if adapter is not None and (attribution is None or not attempt_key):
            raise ModelUsageContractError("model_usage_attribution_required")

        attempt: MeteredProviderAttempt | None = None
        permit: DispatchPermit | None = None
        settled = False
        if adapter is not None:
            attempt = adapter.begin(
                attribution=attribution,
                attempt_key=attempt_key,
                estimated_input_tokens=estimate_rerank_input_tokens(
                    query=query,
                    documents=documents,
                    instruct=self.instruct,
                ),
                fingerprint=fingerprint_rerank_request(
                    signer=adapter.signer,
                    model=self.model,
                    query=query,
                    documents=documents,
                    top_n=min(top_n, len(documents)),
                    instruct=self.instruct,
                ),
            )
            permit = attempt.prepare_dispatch()

        try:
            response = self._post_rerank(query=query, documents=documents, top_n=top_n)
        except _ConfirmedRerankProviderFailure as exc:
            if attempt is not None and permit is not None:
                try:
                    attempt.settle(
                        adapter.confirmed_not_executed_receipt(
                            permit,
                            stable_provider_request_id=f"http_status_{exc.status_code}",
                        )
                    )
                except Exception:
                    self._mark_uncertain(attempt)
            raise RerankUnavailableError(
                "rerank provider returned an error response",
                code="search_rerank_provider_failed",
            ) from exc
        except _AmbiguousRerankTransportFailure as exc:
            if attempt is not None and permit is not None:
                self._mark_uncertain(attempt)
            raise RerankUnavailableError(
                "rerank provider transport outcome is uncertain",
                code="search_rerank_transport_uncertain",
            ) from exc

        try:
            if attempt is not None and permit is not None:
                attempt.settle(
                    adapter.receipt_from_response(
                        permit,
                        reported_model=self.model,
                        provider_request_id=_provider_request_id(response),
                        provider_input_tokens=_provider_total_tokens(response),
                    )
                )
                settled = True
            return _parse_rerank_response(
                response,
                document_count=len(documents),
            )
        except RerankUnavailableError:
            # A 2xx response was already recorded before parsing.  Returning a
            # local rank keeps search usable without creating a second send.
            raise
        except Exception as exc:
            if attempt is not None and permit is not None and not settled:
                self._mark_uncertain(attempt)
            if isinstance(exc, ModelUsageError):
                raise RerankUnavailableError(
                    "rerank usage settlement outcome is uncertain",
                    code="search_rerank_settlement_uncertain",
                ) from exc
            raise RerankUnavailableError(
                "rerank provider response is unavailable",
                code="search_rerank_provider_response_invalid",
            ) from exc

    @staticmethod
    def _mark_uncertain(attempt: MeteredProviderAttempt) -> None:
        try:
            attempt.mark_uncertain("search_rerank_transport_uncertain")
        except Exception:
            # Preserve the provider result; an active dispatch row remains a
            # conservative barrier to automatic resend if marking itself fails.
            pass

    def _post_rerank(self, *, query: str, documents: list[str], top_n: int) -> httpx.Response:
        payload = {
            "model": self.model,
            "query": query,
            "documents": documents,
            "top_n": min(top_n, len(documents)),
        }
        if self.instruct:
            payload["instruct"] = self.instruct
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.post(f"{self.api_base}/{self._endpoint_name()}", headers=headers, json=payload)
                response.raise_for_status()
                return response
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            # A provider's explicit client-side rejection is safe to settle as
            # not executed.  Server/timeout failures can still conceal a
            # completed rerank, so they retain the dispatching attempt as
            # uncertain and are never automatically re-sent.
            if status_code in {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}:
                raise _ConfirmedRerankProviderFailure(str(exc), status_code=status_code) from exc
            raise _AmbiguousRerankTransportFailure(str(exc)) from exc
        except httpx.TransportError as exc:  # pragma: no cover - network failure
            raise _AmbiguousRerankTransportFailure(str(exc)) from exc

    def _endpoint_name(self) -> str:
        if self.provider == "dashscope":
            return "reranks"
        return "rerank"


def _parse_rerank_response(response: httpx.Response, *, document_count: int) -> list[RerankResult]:
    try:
        body = response.json()
    except (TypeError, ValueError) as exc:
        raise RerankUnavailableError("rerank response invalid", code="search_rerank_provider_response_invalid") from exc
    if not isinstance(body, dict):
        raise RerankUnavailableError("rerank response invalid", code="search_rerank_provider_response_invalid")
    raw_results = body.get("results")
    if not isinstance(raw_results, list):
        raise RerankUnavailableError("rerank response missing results", code="search_rerank_provider_response_invalid")
    results: list[RerankResult] = []
    for item in raw_results:
        if not isinstance(item, dict):
            raise RerankUnavailableError("rerank response result must be an object", code="search_rerank_provider_response_invalid")
        index = _int_value(item.get("index"))
        relevance_score = _float_value(item.get("relevance_score"))
        if index is None or index < 0 or index >= document_count:
            raise RerankUnavailableError("rerank response result index out of range", code="search_rerank_provider_response_invalid")
        if relevance_score is None:
            raise RerankUnavailableError("rerank response result missing relevance_score", code="search_rerank_provider_response_invalid")
        results.append(RerankResult(index=index, relevance_score=relevance_score))
    return results


def build_rerank_client() -> RerankClient:
    settings = get_settings()
    provider = settings.search_rerank_provider.strip().lower()
    if provider in {"", "disabled", "mock"}:
        return DisabledRerankClient()
    if provider in {"openai", "openai-compatible", "compatible", "custom", "dashscope", "cohere", "jina"}:
        if not settings.search_rerank_api_base or not settings.search_rerank_api_key or not settings.search_rerank_model:
            return DisabledRerankClient()
        return OpenAICompatibleRerankClient(
            provider=provider,
            api_base=settings.search_rerank_api_base,
            api_key=settings.search_rerank_api_key,
            model=settings.search_rerank_model,
            timeout_seconds=settings.search_rerank_timeout_seconds,
            instruct=settings.search_rerank_instruct,
            usage_adapter=_rerank_usage_adapter(settings, provider=provider),
            model_usage_required=bool(getattr(settings, "model_usage_required", False)),
        )
    return DisabledRerankClient()


def _rerank_usage_adapter(settings: object, *, provider: str) -> RerankUsageAdapter | None:
    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    signer = decode_receipt_integrity_keyring(settings).signer()
    return RerankUsageAdapter(
        provider=provider,
        model=str(getattr(settings, "search_rerank_model", "") or ""),
        candidate_limit=int(getattr(settings, "search_rerank_candidate_limit", 50) or 50),
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=signer,
    )


def fingerprint_rerank_request(
    *,
    signer: ProviderUsageReceiptSigner,
    model: str,
    query: str,
    documents: list[str],
    top_n: int,
    instruct: str,
) -> str:
    """HMAC transient rerank content before it enters the usage boundary."""

    encoded = json.dumps(
        {
            "model": model,
            "query": query,
            "documents": documents,
            "top_n": top_n,
            "instruct": instruct,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return signer.request_fingerprint(encoded)


def _provider_request_id(response: httpx.Response) -> str | None:
    value = response.headers.get("x-request-id")
    return value if value else None


def estimate_rerank_input_tokens(
    *,
    query: str,
    documents: list[str],
    instruct: str,
) -> int:
    """Return a content-free conservative reservation estimate.

    Qwen rerank reports the exact total at settlement.  UTF-8 byte length plus
    per-field framing is an upper bound for its byte-fallback tokenizer and is
    persisted only as an aggregate quantity.
    """

    fields = [instruct, query, *documents]
    return max(1, sum(len(value.encode("utf-8")) + 8 for value in fields))


def _provider_total_tokens(response: httpx.Response) -> int:
    try:
        body = response.json()
        usage = body.get("usage") if isinstance(body, dict) else None
        value = usage.get("total_tokens") if isinstance(usage, dict) else None
    except (TypeError, ValueError):
        value = None
    parsed = _int_value(value)
    if parsed is None or parsed <= 0:
        raise ModelUsageContractError("rerank_provider_usage_invalid")
    return parsed


def _int_value(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _float_value(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
