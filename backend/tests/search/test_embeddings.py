from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.services.search.embeddings import (
    DisabledEmbeddingClient,
    EmbeddingUnavailableError,
    OpenAICompatibleEmbeddingClient,
    build_embedding_client,
)


class FakeResponse:
    def __init__(self, *, body: dict[str, Any]) -> None:
        self.body = body

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.body


class FakeHttpxClient:
    requests: list[tuple[str, dict[str, str], dict[str, Any]]] = []
    responses: list[FakeResponse] = []

    def __init__(self, *, timeout: object) -> None:
        self.timeout = timeout

    def __enter__(self) -> "FakeHttpxClient":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    def post(self, url: str, *, headers: dict[str, str], json: dict[str, Any]) -> FakeResponse:
        self.requests.append((url, headers, json))
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def fake_httpx_client(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeHttpxClient.requests = []
    FakeHttpxClient.responses = []
    monkeypatch.setattr("app.services.search.embeddings.httpx.Client", FakeHttpxClient)


def test_openai_compatible_embedding_client_sends_batch_request_and_orders_vectors() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(
            body={
                "data": [
                    {"index": 1, "embedding": [0.3, 0.4]},
                    {"index": 0, "embedding": [0.1, 0.2]},
                ]
            }
        )
    ]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1/",
        api_key="secret",
        model="embedding-model",
        dimensions=2,
        timeout_seconds=1,
    )

    vectors = client.embed_batch(["番茄", "清淡晚饭"])

    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert FakeHttpxClient.requests == [
        (
            "https://embedding.example/v1/embeddings",
            {"Authorization": "Bearer secret"},
            {"model": "embedding-model", "input": ["番茄", "清淡晚饭"], "dimensions": 2},
        )
    ]


def test_openai_compatible_embedding_client_rejects_count_mismatch() -> None:
    FakeHttpxClient.responses = [FakeResponse(body={"data": [{"index": 0, "embedding": [0.1, 0.2]}]})]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key="secret",
        model="embedding-model",
        dimensions=2,
        timeout_seconds=1,
    )

    with pytest.raises(EmbeddingUnavailableError, match="count mismatch"):
        client.embed_batch(["番茄", "清淡晚饭"])


def test_openai_compatible_embedding_client_rejects_dimension_mismatch() -> None:
    FakeHttpxClient.responses = [FakeResponse(body={"data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]})]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key="secret",
        model="embedding-model",
        dimensions=2,
        timeout_seconds=1,
    )

    with pytest.raises(EmbeddingUnavailableError, match="dimension mismatch"):
        client.embed_text("番茄")


def test_build_embedding_client_uses_search_embedding_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.search.embeddings.get_settings",
        lambda: SimpleNamespace(
            search_embedding_provider="openai",
            search_embedding_api_base="https://embedding.example/v1",
            search_embedding_api_key="secret",
            search_embedding_model="embedding-model",
            search_embedding_dimensions=2,
            search_embedding_timeout_seconds=1,
        ),
    )

    client = build_embedding_client()

    assert isinstance(client, OpenAICompatibleEmbeddingClient)
    assert client.model == "embedding-model"
    assert client.dimensions == 2


def test_build_embedding_client_returns_disabled_for_incomplete_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.search.embeddings.get_settings",
        lambda: SimpleNamespace(
            search_embedding_provider="openai",
            search_embedding_api_base="",
            search_embedding_api_key="",
            search_embedding_model="",
            search_embedding_dimensions=0,
            search_embedding_timeout_seconds=1,
        ),
    )

    assert isinstance(build_embedding_client(), DisabledEmbeddingClient)
