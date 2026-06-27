from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.config import get_settings


class EmbeddingUnavailableError(RuntimeError):
    pass


class EmbeddingClient(Protocol):
    model: str
    dimensions: int

    def embed_text(self, text: str) -> list[float]:
        ...

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        ...


@dataclass
class DisabledEmbeddingClient:
    model: str = ""
    dimensions: int = 0

    def embed_text(self, text: str) -> list[float]:
        del text
        raise EmbeddingUnavailableError("search embedding provider disabled")

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        del texts
        raise EmbeddingUnavailableError("search embedding provider disabled")


class OpenAICompatibleEmbeddingClient:
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model: str,
        dimensions: int,
        timeout_seconds: float,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions
        self.timeout = httpx.Timeout(max(timeout_seconds, 5.0), connect=10.0)

    def embed_text(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        payload: dict[str, object] = {"model": self.model, "input": texts}
        if self.dimensions > 0:
            payload["dimensions"] = self.dimensions
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(f"{self.api_base}/embeddings", headers=headers, json=payload)
                response.raise_for_status()
        except httpx.HTTPError as exc:  # pragma: no cover - network failure
            raise EmbeddingUnavailableError(str(exc)) from exc
        body = response.json()
        data = body.get("data")
        if not isinstance(data, list):
            raise EmbeddingUnavailableError("embedding response missing data")
        vectors: list[list[float]] = []
        for item in sorted(data, key=lambda value: int(value.get("index", 0)) if isinstance(value, dict) else 0):
            if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
                raise EmbeddingUnavailableError("embedding response item missing vector")
            vector = [float(value) for value in item["embedding"]]
            if self.dimensions > 0 and len(vector) != self.dimensions:
                raise EmbeddingUnavailableError("embedding vector dimension mismatch")
            vectors.append(vector)
        if len(vectors) != len(texts):
            raise EmbeddingUnavailableError("embedding response count mismatch")
        return vectors


def build_embedding_client() -> EmbeddingClient:
    settings = get_settings()
    provider = settings.search_embedding_provider.strip().lower()
    if provider in {"", "disabled", "mock"}:
        return DisabledEmbeddingClient()
    if provider in {"openai", "openai-compatible", "dashscope"}:
        if not settings.search_embedding_api_base or not settings.search_embedding_api_key or not settings.search_embedding_model:
            return DisabledEmbeddingClient()
        return OpenAICompatibleEmbeddingClient(
            api_base=settings.search_embedding_api_base,
            api_key=settings.search_embedding_api_key,
            model=settings.search_embedding_model,
            dimensions=settings.search_embedding_dimensions,
            timeout_seconds=settings.search_embedding_timeout_seconds,
        )
    return DisabledEmbeddingClient()
