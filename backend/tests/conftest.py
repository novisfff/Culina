from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base


def pytest_configure(config: pytest.Config) -> None:
    os.environ.setdefault("SEARCH_EMBEDDING_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_VECTOR_BACKEND", "disabled")
    os.environ.setdefault("SEARCH_RERANK_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_EMBEDDING_MODEL", "")
    os.environ.setdefault("SEARCH_EMBEDDING_DIMENSIONS", "0")
    os.environ.setdefault("QDRANT_URL", "")
    os.environ.setdefault("QDRANT_COLLECTION", "")
    config.addinivalue_line(
        "markers",
        "model_usage_reference: absolute model-usage latency gate for the first-launch MySQL 8.4 reference host",
    )


@pytest.fixture()
def model_usage_db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        yield db
        db.rollback()
    engine.dispose()
