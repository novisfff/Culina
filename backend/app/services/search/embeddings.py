from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.model_usage.adapters.embedding import EmbeddingUsageAdapter
from app.services.model_usage.errors import ModelUsageContractError, ModelUsageError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.types import UsageAttribution


class EmbeddingUnavailableError(RuntimeError):
    pass


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
    ) -> MeteredEmbeddingResult:
        ...

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
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
    ) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key
        raise EmbeddingUnavailableError("search embedding provider disabled")

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
    ) -> MeteredEmbeddingResult:
        del texts, attribution, attempt_key
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
    ) -> MeteredEmbeddingResult:
        result = self.embed_batch(
            [text],
            attribution=attribution,
            attempt_key=attempt_key,
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
        if adapter is not None:
            attempt = adapter.begin_embedding_batch(
                attribution=attribution,
                attempt_key=attempt_key,
                text_token_estimates=[estimate_embedding_tokens(text) for text in texts],
                fingerprint=adapter.request_fingerprint(texts=texts),
            )
            permit = attempt.prepare_dispatch()

        try:
            response = self._post_embeddings(texts)
            body = response.json()
            if not isinstance(body, dict):
                raise EmbeddingUnavailableError("embedding response invalid")
            if adapter is not None and permit is not None:
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
            )
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
            if isinstance(exc, (EmbeddingUnavailableError, ModelUsageError)):
                raise
            raise EmbeddingUnavailableError(str(exc) or "embedding request failed") from exc

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
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise EmbeddingUnavailableError(str(exc)) from exc


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _provider_request_id(response: object, body: dict[str, object]) -> str | None:
    body_id = _optional_string(body.get("id"))
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
) -> list[list[float]]:
    data = body.get("data")
    if not isinstance(data, list):
        raise EmbeddingUnavailableError("embedding response missing data")
    vectors: list[tuple[int, list[float]]] = []
    for position, item in enumerate(data):
        if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
            raise EmbeddingUnavailableError("embedding response item missing vector")
        index = item.get("index", position)
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


def _embedding_usage_adapter(settings: object, *, provider: str) -> EmbeddingUsageAdapter | None:
    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    signer = decode_receipt_integrity_keyring(settings).signer()
    return EmbeddingUsageAdapter(
        provider=provider,
        model=str(getattr(settings, "search_embedding_model", "") or ""),
        dimensions=int(getattr(settings, "search_embedding_dimensions", 0) or 0),
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=signer,
    )


def build_embedding_client() -> EmbeddingClient:
    settings = get_settings()
    provider = settings.search_embedding_provider.strip().lower()
    if provider in {"", "disabled", "mock"}:
        return DisabledEmbeddingClient()
    if provider in {"openai", "openai-compatible", "compatible", "custom"}:
        if not settings.search_embedding_api_base or not settings.search_embedding_api_key or not settings.search_embedding_model:
            return DisabledEmbeddingClient()
        return OpenAICompatibleEmbeddingClient(
            api_base=settings.search_embedding_api_base,
            api_key=settings.search_embedding_api_key,
            model=settings.search_embedding_model,
            dimensions=settings.search_embedding_dimensions,
            timeout_seconds=settings.search_embedding_timeout_seconds,
            usage_adapter=_embedding_usage_adapter(settings, provider=provider),
            model_usage_required=bool(getattr(settings, "model_usage_required", False)),
        )
    return DisabledEmbeddingClient()
