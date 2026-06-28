from __future__ import annotations

import os


def pytest_configure() -> None:
    os.environ.setdefault("SEARCH_EMBEDDING_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_VECTOR_BACKEND", "disabled")
    os.environ.setdefault("SEARCH_RERANK_PROVIDER", "disabled")
    os.environ.setdefault("SEARCH_EMBEDDING_MODEL", "")
    os.environ.setdefault("SEARCH_EMBEDDING_DIMENSIONS", "0")
    os.environ.setdefault("QDRANT_URL", "")
    os.environ.setdefault("QDRANT_COLLECTION", "")
