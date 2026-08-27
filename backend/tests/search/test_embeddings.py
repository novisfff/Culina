from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.services.search.embeddings import (
    DisabledEmbeddingClient,
    EmbeddingUnavailableError,
    FamilyOpenAICompatibleEmbeddingClient,
    OpenAICompatibleEmbeddingClient,
    build_embedding_client,
)
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.services.family_model_settings.errors import FamilyModelProviderTransportError
from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    EmbeddingUsageSnapshot,
    ResolvedProviderEndpoint,
    ResolvedSearchProfile,
)
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
    responses: list[object] = []

    def __init__(self, *, timeout: object) -> None:
        self.timeout = timeout

    def __enter__(self) -> "FakeHttpxClient":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    def post(self, url: str, *, headers: dict[str, str], json: dict[str, Any]) -> object:
        CALL_ORDER.append("http")
        self.requests.append((url, headers, json))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


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


def _family_search_binding() -> ResolvedSearchProfile:
    return ResolvedSearchProfile(
        family_id="family-search",
        search_profile_id="search-profile-a",
        provider_profile_id="provider-profile-a",
        provider_profile_version_id="provider-profile-version-a",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url="https://embedding.example/v1",
            scheme="https",
            host="embedding.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        embedding_model="embedding-model",
        dimensions=1024,
        distance="Cosine",
        document_builder_version="v1",
        qdrant_collection="culina_fsp_private_collection",
    )


class RecordingFamilyUsageAttempt:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls

    def prepare_dispatch(self) -> SimpleNamespace:
        self.calls.append("dispatch")
        return SimpleNamespace(
            credential_secret_version_id="secret-version-a",
            provider_idempotency_key="provider-idempotency-a",
        )

    def settle(self, receipt: object) -> SimpleNamespace:
        del receipt
        self.calls.append("settle")
        return SimpleNamespace(event_id="usage-event-family-embedding")

    def mark_uncertain(self, stable_error_code: str) -> None:
        assert stable_error_code == "embedding_provider_result_unavailable"
        self.calls.append("uncertain")


class RecordingFamilyUsageAdapter:
    def __init__(self, binding: ResolvedSearchProfile) -> None:
        self.binding = binding
        self.calls: list[str] = []

    def request_fingerprint(self, *, texts: list[str]) -> str:
        assert texts
        self.calls.append("fingerprint")
        return "hmac:family-embedding"

    def begin_embedding_batch(self, **kwargs: object) -> RecordingFamilyUsageAttempt:
        assert kwargs["usage_snapshot"] is not None
        self.calls.append("reserve")
        return RecordingFamilyUsageAttempt(self.calls)

    def confirmed_not_executed_receipt(self, permit: object) -> object:
        del permit
        self.calls.append("not-executed-receipt")
        return object()

    def receipt_from_openai_response(self, permit: object, **kwargs: object) -> object:
        del permit, kwargs
        self.calls.append("provider-receipt")
        return object()


class RecordingFamilyTransport:
    def __init__(self, response: ProviderResponse | BaseException) -> None:
        self.response = response
        self.calls: list[tuple[str, str, dict[str, str], object | None]] = []

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: object | None = None,
    ) -> ProviderResponse:
        self.calls.append((method, url, headers, json))
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response


def _family_embedding_client(
    *,
    response: ProviderResponse | BaseException,
    private_key: str,
) -> tuple[FamilyOpenAICompatibleEmbeddingClient, RecordingFamilyUsageAdapter]:
    binding = _family_search_binding()
    adapter = RecordingFamilyUsageAdapter(binding)
    client = FamilyOpenAICompatibleEmbeddingClient(
        binding=binding,
        transport=RecordingFamilyTransport(response),  # type: ignore[arg-type]
        resolve_dispatch_credential=lambda resolved, secret_id: DispatchCredential(
            family_id=resolved.family_id,
            provider_profile_id=resolved.provider_profile_id,
            secret_version_id=secret_id,
            api_key=private_key,
        ),
        usage_adapter=adapter,  # type: ignore[arg-type]
    )
    return client, adapter


def _candidate_usage_snapshot() -> EmbeddingUsageSnapshot:
    return EmbeddingUsageSnapshot(
        config_revision_id=None,
        price_version_id="candidate-price-a",
        candidate=True,
    )


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


def test_openai_compatible_embedding_client_keeps_safe_http_rejection_diagnostics() -> None:
    private_text = "家庭私密的搜索正文"
    private_key = "sk-provider-secret-value"
    request = httpx.Request("POST", "https://embedding.example/v1/embeddings")
    FakeHttpxClient.responses = [
        httpx.Response(
            400,
            request=request,
            json={
                "error": {
                    "code": "invalid_dimensions",
                    "message": (
                        f"dimensions unsupported; input={private_text}; "
                        f"api_key={private_key}; see https://private.provider.example/debug"
                    ),
                }
            },
        )
    ]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key=private_key,
        model="embedding-model",
        dimensions=1024,
        timeout_seconds=1,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:http-400",
        )

    diagnostic = caught.value.diagnostic_record()
    assert diagnostic["code"] == "search_embedding_provider_rejected"
    assert diagnostic["provider_http_status"] == 400
    assert diagnostic["provider_error_code"] == "invalid_dimensions"
    assert diagnostic["request_sent"] is True
    assert diagnostic["execution_certainty"] == "confirmed_not_executed"
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert "dimensions unsupported" in serialized
    assert private_text not in serialized
    assert private_key not in serialized
    assert "private.provider.example" not in serialized


def test_openai_compatible_embedding_client_hides_transport_exception_details() -> None:
    private_text = "不应出现在诊断里的请求正文"
    private_key = "sk-transport-secret-value"
    request = httpx.Request("POST", "https://embedding.example/v1/embeddings")
    FakeHttpxClient.responses = [
        httpx.ConnectError(
            f"failed at https://private.provider.example api_key={private_key} input={private_text}",
            request=request,
        )
    ]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key=private_key,
        model="embedding-model",
        dimensions=1024,
        timeout_seconds=1,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:transport",
        )

    diagnostic = caught.value.diagnostic_record()
    assert diagnostic == {
        "code": "search_embedding_transport_uncertain",
        "detail": "embedding provider transport unavailable",
        "provider_http_status": None,
        "provider_error_code": None,
        "provider_error_message": None,
        "request_sent": True,
        "execution_certainty": "unknown",
    }
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert private_text not in serialized
    assert private_key not in serialized
    assert "private.provider.example" not in serialized


def test_openai_compatible_embedding_client_hides_invalid_response_exception_details() -> None:
    private_text = "解析异常不得回显的正文"
    private_key = "sk-parser-secret-value"

    class InvalidJsonResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            raise ValueError(
                f"invalid response at https://private.provider.example "
                f"api_key={private_key} input={private_text}"
            )

    FakeHttpxClient.responses = [InvalidJsonResponse()]
    client = OpenAICompatibleEmbeddingClient(
        api_base="https://embedding.example/v1",
        api_key=private_key,
        model="embedding-model",
        dimensions=1024,
        timeout_seconds=1,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:embedding:invalid-json",
        )

    diagnostic = caught.value.diagnostic_record()
    assert diagnostic == {
        "code": "search_embedding_response_invalid",
        "detail": "嵌入服务返回了无法解析的响应",
        "provider_http_status": None,
        "provider_error_code": None,
        "provider_error_message": None,
        "request_sent": True,
        "execution_certainty": "unknown",
    }
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert private_text not in serialized
    assert private_key not in serialized
    assert "private.provider.example" not in serialized


def test_family_embedding_client_persists_only_safe_http_rejection_fields() -> None:
    private_text = "家庭候选索引的私密正文"
    private_key = "sk-family-provider-secret"
    response = ProviderResponse(
        status_code=400,
        headers={},
        content=json.dumps(
            {
                "error": {
                    "code": "invalid_dimensions",
                    "message": (
                        f"unsupported dimensions; input={private_text}; "
                        f"api_key={private_key}; https://private.provider.example/debug"
                    ),
                }
            },
            ensure_ascii=False,
        ).encode("utf-8"),
    )
    client, adapter = _family_embedding_client(
        response=response,
        private_key=private_key,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:family:http-400",
            usage_snapshot=_candidate_usage_snapshot(),
        )

    diagnostic = caught.value.diagnostic_record()
    assert diagnostic["code"] == "search_embedding_provider_rejected"
    assert diagnostic["provider_http_status"] == 400
    assert diagnostic["provider_error_code"] == "invalid_dimensions"
    assert diagnostic["request_sent"] is True
    assert diagnostic["execution_certainty"] == "confirmed_not_executed"
    serialized = json.dumps(diagnostic, ensure_ascii=False)
    assert "unsupported dimensions" in serialized
    assert private_text not in serialized
    assert private_key not in serialized
    assert "private.provider.example" not in serialized
    assert adapter.calls == [
        "fingerprint",
        "reserve",
        "dispatch",
        "not-executed-receipt",
        "settle",
    ]


def test_family_embedding_client_marks_transport_failure_uncertain_without_echoing_it() -> None:
    private_text = "网络异常里的私密正文"
    private_key = "sk-family-transport-secret"
    client, adapter = _family_embedding_client(
        response=FamilyModelProviderTransportError(
            f"https://private.provider.example api_key={private_key} input={private_text}"
        ),
        private_key=private_key,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:family:transport",
            usage_snapshot=_candidate_usage_snapshot(),
        )

    assert caught.value.diagnostic_record() == {
        "code": "search_embedding_transport_uncertain",
        "detail": "嵌入服务连接中断，执行结果暂时无法确认",
        "provider_http_status": None,
        "provider_error_code": None,
        "provider_error_message": None,
        "request_sent": True,
        "execution_certainty": "unknown",
    }
    assert adapter.calls == ["fingerprint", "reserve", "dispatch", "uncertain"]


def test_family_embedding_client_marks_invalid_response_uncertain_without_echoing_body() -> None:
    private_text = "错误响应里的私密正文"
    private_key = "sk-family-parser-secret"
    client, adapter = _family_embedding_client(
        response=ProviderResponse(
            status_code=200,
            headers={},
            content=(
                f"not-json https://private.provider.example "
                f"api_key={private_key} input={private_text}"
            ).encode("utf-8"),
        ),
        private_key=private_key,
    )

    with pytest.raises(EmbeddingUnavailableError) as caught:
        client.embed_text(
            private_text,
            attribution=ATTRIBUTION,
            attempt_key="search-request:family:invalid-json",
            usage_snapshot=_candidate_usage_snapshot(),
        )

    assert caught.value.diagnostic_record() == {
        "code": "search_embedding_response_invalid",
        "detail": "embedding response invalid",
        "provider_http_status": None,
        "provider_error_code": None,
        "provider_error_message": None,
        "request_sent": True,
        "execution_certainty": "unknown",
    }
    assert adapter.calls == ["fingerprint", "reserve", "dispatch", "uncertain"]


def test_build_embedding_client_fails_closed_without_a_resolved_family_profile() -> None:
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
