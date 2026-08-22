from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.domain import Base
from app.services.model_usage.types import UsageAttribution
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.rerank import RerankResult, RerankUnavailableError
from app.services.search.vector_store import VectorSearchHit


@dataclass
class FakeEmbeddingClient:
    model: str = "fake-embedding"
    dimensions: int = 2

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: object | None = None,
    ) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key, usage_snapshot
        return MeteredEmbeddingResult(vectors=[[0.1, 0.2]], usage_event_id=None)

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
    ) -> MeteredEmbeddingResult:
        del attribution, attempt_key
        return MeteredEmbeddingResult(
            vectors=[[0.1, 0.2] for _ in texts],
            usage_event_id=None,
        )


@dataclass
class ExplodingEmbeddingClient:
    model: str = "fake-embedding"
    dimensions: int = 2

    def embed_text(
        self,
        text: str,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        usage_snapshot: object | None = None,
    ) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key, usage_snapshot
        raise AssertionError("embedding client should not be called")

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
    ) -> MeteredEmbeddingResult:
        del texts, attribution, attempt_key
        raise AssertionError("embedding client should not be called")


class FakeVectorStore:
    def __init__(self, hits: list[VectorSearchHit]) -> None:
        self.hits = hits
        self.calls: list[dict[str, object]] = []

    def search(
        self,
        *,
        family_id: str,
        scopes: list[str],
        vector: list[float],
        limit: int,
        user_id: str | None = None,
    ) -> list[VectorSearchHit]:
        del vector
        self.calls.append({"family_id": family_id, "scopes": scopes, "limit": limit, "user_id": user_id})
        return [hit for hit in self.hits if hit.entity_type in scopes][:limit]


class ExplodingVectorStore:
    def search(
        self,
        *,
        family_id: str,
        scopes: list[str],
        vector: list[float],
        limit: int,
        user_id: str | None = None,
    ) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit, user_id
        raise AssertionError("vector store should not be called")


class FakeRerankClient:
    enabled = True

    def __init__(self, results: list[RerankResult] | None = None, *, fail: bool = False) -> None:
        self.results = results or []
        self.fail = fail
        self.documents: list[str] = []
        self.attribution: UsageAttribution | None = None
        self.attempt_key: str | None = None

    def rerank(
        self,
        *,
        query: str,
        documents: list[str],
        top_n: int,
        attribution: UsageAttribution | None = None,
        attempt_key: str | None = None,
    ) -> list[RerankResult]:
        del query, top_n
        self.documents = documents
        self.attribution = attribution
        self.attempt_key = attempt_key
        if self.fail:
            raise RerankUnavailableError("rerank failed")
        return self.results


class DisabledFakeRerankClient(FakeRerankClient):
    enabled = False

    def rerank(self, **kwargs):
        del kwargs
        raise AssertionError("disabled rerank client should not be called")


def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)


def search_settings(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "search_hybrid_enabled": True,
        "search_vector_backend": "qdrant",
    }
    values.update(overrides)
    return SimpleNamespace(**values)
