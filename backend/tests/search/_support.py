from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.domain import Base
from app.services.search.rerank import RerankResult, RerankUnavailableError
from app.services.search.vector_store import VectorSearchHit


@dataclass
class FakeEmbeddingClient:
    model: str = "fake-embedding"
    dimensions: int = 2

    def embed_text(self, text: str) -> list[float]:
        del text
        return [0.1, 0.2]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2] for _ in texts]


@dataclass
class ExplodingEmbeddingClient:
    model: str = "fake-embedding"
    dimensions: int = 2

    def embed_text(self, text: str) -> list[float]:
        del text
        raise AssertionError("embedding client should not be called")

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        del texts
        raise AssertionError("embedding client should not be called")


class FakeVectorStore:
    def __init__(self, hits: list[VectorSearchHit]) -> None:
        self.hits = hits

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, vector
        return [hit for hit in self.hits if hit.entity_type in scopes][:limit]


class ExplodingVectorStore:
    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit
        raise AssertionError("vector store should not be called")


class FakeRerankClient:
    enabled = True

    def __init__(self, results: list[RerankResult] | None = None, *, fail: bool = False) -> None:
        self.results = results or []
        self.fail = fail
        self.documents: list[str] = []

    def rerank(self, *, query: str, documents: list[str], top_n: int) -> list[RerankResult]:
        del query, top_n
        self.documents = documents
        if self.fail:
            raise RerankUnavailableError("rerank failed")
        return self.results


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
        "search_rerank_semantic_min_score": 0.48,
        "search_rerank_min_score": 0.58,
        "search_literal_fallback_min_score": 0.70,
        "search_rerank_candidate_limit": 50,
    }
    values.update(overrides)
    return SimpleNamespace(**values)
