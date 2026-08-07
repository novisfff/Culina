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
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import UsageAttribution


ATTRIBUTION = UsageAttribution(
    family_id="family-search",
    attribution_kind=ModelUsageAttributionKind.USER,
    actor_user_id="user-search",
    operation_source=ModelUsageOperationSource.INTERACTIVE,
    logical_operation_id="search-request",
)

CALL_ORDER: list[str] = []


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
        CALL_ORDER.append("http")
        self.requests.append((url, headers, json))
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def fake_httpx_client(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeHttpxClient.requests = []
    FakeHttpxClient.responses = []
    CALL_ORDER.clear()
    monkeypatch.setattr("app.services.search.embeddings.httpx.Client", FakeHttpxClient)


class RecordingUsageAttempt:
    def __init__(self, call_order: list[str]) -> None:
        self.call_order = call_order

    def prepare_dispatch(self) -> object:
        self.call_order.append("dispatch")
        return object()

    def settle(self, receipt: object) -> SimpleNamespace:
        del receipt
        self.call_order.append("settle")
        return SimpleNamespace(event_id="usage-event-embedding-client")

    def mark_uncertain(self, stable_error_code: str) -> None:
        del stable_error_code
        self.call_order.append("uncertain")


class RecordingEmbeddingUsageAdapter:
    def __init__(self) -> None:
        self.call_order = CALL_ORDER

    def request_fingerprint(self, *, texts: list[str]) -> str:
        assert texts == ["番茄"]
        self.call_order.append("fingerprint")
        return "hmac:embedding-client"

    def begin_embedding_batch(self, **kwargs: object) -> RecordingUsageAttempt:
        assert kwargs["attempt_key"] == "search-request:embedding:metered"
        assert kwargs["text_token_estimates"]
        self.call_order.append("reserve")
        return RecordingUsageAttempt(self.call_order)

    def receipt_from_openai_response(self, permit: object, **kwargs: object) -> object:
        del permit
        assert kwargs["raw_usage"] == {"prompt_tokens": 2}
        self.call_order.append("receipt")
        return object()


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

    result = client.embed_batch(
        ["番茄", "清淡晚饭"],
        attribution=ATTRIBUTION,
        attempt_key="search-request:embedding:query",
    )

    assert result.vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert result.usage_event_id is None
    assert FakeHttpxClient.requests == [
        (
            "https://embedding.example/v1/embeddings",
            {"Authorization": "Bearer secret"},
            {"model": "embedding-model", "input": ["番茄", "清淡晚饭"], "dimensions": 2},
        )
    ]


def test_openai_compatible_embedding_client_dispatches_and_settles_around_http_send() -> None:
    FakeHttpxClient.responses = [
        FakeResponse(
            body={
                "model": "embedding-model",
                "usage": {"prompt_tokens": 2},
                "data": [{"index": 0, "embedding": [0.1, 0.2]}],
            }
        )
    ]
    adapter = RecordingEmbeddingUsageAdapter()
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key="secret",
        model="embedding-model",
        dimensions=2,
        timeout_seconds=1,
        usage_adapter=adapter,  # type: ignore[arg-type]
        model_usage_required=True,
    )

    result = client.embed_text(
        "番茄",
        attribution=ATTRIBUTION,
        attempt_key="search-request:embedding:metered",
    )

    assert result.usage_event_id == "usage-event-embedding-client"
    assert result.vectors == [[0.1, 0.2]]
    assert adapter.call_order == ["fingerprint", "reserve", "dispatch", "http", "receipt", "settle"]


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
        client.embed_batch(
            ["番茄", "清淡晚饭"],
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:count-mismatch",
        )


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
        client.embed_text(
            "番茄",
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:dimension-mismatch",
        )


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


def test_required_embedding_client_refuses_to_send_without_usage_adapter() -> None:
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key="secret",
        model="embedding-model",
        dimensions=2,
        timeout_seconds=1,
        model_usage_required=True,
    )

    with pytest.raises(ModelUsageContractError, match="model_usage_adapter_required"):
        client.embed_text(
            "番茄",
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:required",
        )

    assert FakeHttpxClient.requests == []
