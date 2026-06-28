from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import get_settings


class RerankUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class RerankResult:
    index: int
    relevance_score: float


class RerankClient(Protocol):
    enabled: bool

    def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[RerankResult]:
        ...


@dataclass
class DisabledRerankClient:
    enabled: bool = False

    def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[RerankResult]:
        del query, documents, top_n
        raise RerankUnavailableError("search rerank provider disabled")


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
    ) -> None:
        self.provider = provider.strip().lower()
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = httpx.Timeout(max(timeout_seconds, 5.0), connect=10.0)
        self.instruct = instruct.strip()
        self.transport = transport

    def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[RerankResult]:
        if not query.strip() or not documents or top_n <= 0:
            return []
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
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise RerankUnavailableError(str(exc)) from exc
        body = response.json()
        raw_results = body.get("results")
        if not isinstance(raw_results, list):
            raise RerankUnavailableError("rerank response missing results")
        results: list[RerankResult] = []
        for item in raw_results:
            if not isinstance(item, dict):
                raise RerankUnavailableError("rerank response result must be an object")
            index = _int_value(item.get("index"))
            relevance_score = _float_value(item.get("relevance_score"))
            if index is None or index < 0 or index >= len(documents):
                raise RerankUnavailableError("rerank response result index out of range")
            if relevance_score is None:
                raise RerankUnavailableError("rerank response result missing relevance_score")
            results.append(RerankResult(index=index, relevance_score=relevance_score))
        return results

    def _endpoint_name(self) -> str:
        if self.provider == "dashscope":
            return "reranks"
        return "rerank"


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
        )
    return DisabledRerankClient()


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
