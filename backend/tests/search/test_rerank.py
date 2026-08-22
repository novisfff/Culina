from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import ModelUsageMeter, ModelUsageReservationStatus
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageReservation,
)
from app.services.family_model_settings.errors import FamilyModelSecretUnavailable
from app.services.family_model_settings.transport import ProviderResponse
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.adapters.rerank import RerankUsageAdapter
from app.services.model_usage.errors import (
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageStateError,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.search.rerank import OpenAICompatibleRerankClient, RerankUnavailableError
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


def _usage_adapter(model_usage_db: Session) -> RerankUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return RerankUsageAdapter(
        provider="dashscope",
        model="rerank-test",
        candidate_limit=20,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=ProviderUsageReceiptSigner(
            active_key_id="rerank-client-test-key",
            keys={"rerank-client-test-key": b"rerank-client-test-secret"},
        ),
        clock=lambda: NOW,
    )


def _family_rerank_binding() -> ResolvedCapabilityBinding:
    return ResolvedCapabilityBinding(
        family_id="family-reserve",
        config_revision_id="family-rerank-revision-a",
        provider_profile_id="family-rerank-profile-a",
        provider_profile_version_id="family-rerank-profile-version-a",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url="https://rerank.provider.example/v1",
            scheme="https",
            host="rerank.provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model="family-rerank-model",
        billing_model="family-rerank-model",
        capability="rerank",
        variant_key="search",
        billing_scheme_key="rerank-token-v1",
        options={"top_n": 20},
    )


def test_family_rerank_dispatches_before_decrypting_and_uses_provider_transport(
    reservation_context,
) -> None:
    binding = _family_rerank_binding()
    timeline: list[str] = []

    class Attempt:
        def prepare_dispatch(self):
            timeline.append("dispatch")
            return SimpleNamespace(
                credential_secret_version_id="family-rerank-secret-v2",
                provider_idempotency_key="family-rerank-attempt-a",
            )

        def settle(self, receipt: object) -> None:
            assert receipt == "settled-rerank-receipt"
            timeline.append("settle")

        def mark_uncertain(self, error_code: str) -> None:
            timeline.append(f"uncertain:{error_code}")

    class UsageAdapter:
        signer = ProviderUsageReceiptSigner(
            active_key_id="family-rerank-client-key",
            keys={"family-rerank-client-key": b"family-rerank-client-secret"},
        )

        def begin(self, **kwargs: object) -> Attempt:
            assert kwargs["attribution"] == reservation_context.attribution
            assert kwargs["attempt_key"] == "family-search-rerank:1"
            assert int(kwargs["estimated_input_tokens"]) > 0
            timeline.append("reserve")
            return Attempt()

        def receipt_from_response(self, permit: object, **kwargs: object) -> str:
            assert permit.credential_secret_version_id == "family-rerank-secret-v2"
            assert kwargs["reported_model"] == binding.requested_model
            assert kwargs["provider_request_id"] == "family-rerank-provider-request"
            assert kwargs["provider_input_tokens"] == 13
            timeline.append("receipt")
            return "settled-rerank-receipt"

    usage_adapter = UsageAdapter()
    usage_adapter.binding = binding

    class Transport:
        def request(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str],
            json: object | None = None,
        ) -> ProviderResponse:
            assert method == "POST"
            assert url == "https://rerank.provider.example/v1/rerank"
            assert headers["Authorization"] == "Bearer family-rerank-rotated-key"
            assert headers["Idempotency-Key"] == "family-rerank-attempt-a"
            assert isinstance(json, dict) and json["model"] == binding.requested_model
            timeline.append("transport")
            return ProviderResponse(
                status_code=200,
                headers={"x-request-id": "family-rerank-provider-request"},
                content=b'{"results":[{"index":0,"relevance_score":0.91}],"usage":{"total_tokens":13}}',
            )

    def resolve_credential(
        resolved: ResolvedCapabilityBinding,
        secret_version_id: str | None,
    ) -> DispatchCredential:
        assert resolved is binding
        assert secret_version_id == "family-rerank-secret-v2"
        assert timeline == ["reserve", "dispatch"]
        timeline.append("decrypt")
        return DispatchCredential(
            family_id=binding.family_id,
            provider_profile_id=binding.provider_profile_id,
            secret_version_id=secret_version_id,
            api_key="family-rerank-rotated-key",
        )

    client = OpenAICompatibleRerankClient(
        binding=binding,
        transport=Transport(),  # type: ignore[arg-type]
        usage_adapter=usage_adapter,  # type: ignore[arg-type]
        resolve_dispatch_credential=resolve_credential,
        model_usage_required=True,
    )

    result = client.rerank(
        query="鸡肉",
        documents=["三黄鸡"],
        top_n=1,
        attribution=reservation_context.attribution,
        attempt_key="family-search-rerank:1",
    )

    assert [(item.index, item.relevance_score) for item in result] == [(0, 0.91)]
    assert timeline == ["reserve", "dispatch", "decrypt", "transport", "receipt", "settle"]

    with pytest.raises(ModelUsageContractError, match="family_rerank_transport_required"):
        OpenAICompatibleRerankClient(
            binding=binding,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, request=request)),
            usage_adapter=usage_adapter,  # type: ignore[arg-type]
            resolve_dispatch_credential=resolve_credential,
            model_usage_required=True,
        )


def test_family_rerank_missing_secret_never_sends_and_settles_a_zero_receipt(
    reservation_context,
) -> None:
    binding = _family_rerank_binding()
    timeline: list[str] = []

    class Attempt:
        def prepare_dispatch(self):
            timeline.append("dispatch")
            return SimpleNamespace(
                credential_secret_version_id="missing-family-rerank-secret",
                provider_idempotency_key="family-rerank-attempt-missing-secret",
            )

        def settle(self, receipt: object) -> None:
            assert receipt == "zero-rerank-receipt"
            timeline.append("settle")

        def mark_uncertain(self, error_code: str) -> None:
            timeline.append(f"uncertain:{error_code}")

    class UsageAdapter:
        signer = ProviderUsageReceiptSigner(
            active_key_id="family-rerank-missing-key",
            keys={"family-rerank-missing-key": b"family-rerank-missing-secret"},
        )

        def begin(self, **kwargs: object) -> Attempt:
            del kwargs
            timeline.append("reserve")
            return Attempt()

        def confirmed_not_executed_receipt(self, permit: object) -> str:
            assert permit.credential_secret_version_id == "missing-family-rerank-secret"
            timeline.append("zero-receipt")
            return "zero-rerank-receipt"

    usage_adapter = UsageAdapter()
    usage_adapter.binding = binding

    class Transport:
        calls = 0

        def request(self, *args: object, **kwargs: object) -> ProviderResponse:
            del args, kwargs
            self.calls += 1
            raise AssertionError("a missing secret must prevent the Provider request")

    transport = Transport()

    def missing_credential(
        _binding: ResolvedCapabilityBinding,
        _secret_version_id: str | None,
    ) -> DispatchCredential:
        timeline.append("decrypt")
        raise FamilyModelSecretUnavailable()

    client = OpenAICompatibleRerankClient(
        binding=binding,
        transport=transport,  # type: ignore[arg-type]
        usage_adapter=usage_adapter,  # type: ignore[arg-type]
        resolve_dispatch_credential=missing_credential,
        model_usage_required=True,
    )

    with pytest.raises(RerankUnavailableError) as exc_info:
        client.rerank(
            query="鸡肉",
            documents=["三黄鸡"],
            top_n=1,
            attribution=reservation_context.attribution,
            attempt_key="family-search-rerank:missing-secret",
        )

    assert exc_info.value.code == "family_model_secret_unavailable"
    assert transport.calls == 0
    assert timeline == ["reserve", "dispatch", "decrypt", "zero-receipt", "settle"]


def test_rerank_client_parses_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/compatible-api/v1/reranks"
        payload = request.read()
        assert b'"model":"reranker"' in payload
        assert "你是中文厨房搜索结果重排器".encode() in payload
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": 1, "relevance_score": 0.92},
                    {"index": 0, "relevance_score": 0.44},
                ]
            },
        )

    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://dashscope.aliyuncs.com/compatible-api/v1",
        api_key="test-key",
        model="reranker",
        timeout_seconds=10,
        instruct=(
            "你是中文厨房搜索结果重排器。目标是找出与查询词最直接匹配的食材、食物或菜谱。"
            "短查询优先按字面匹配排序。"
        ),
        transport=httpx.MockTransport(handler),
    )

    results = client.rerank(query="鸡肉", documents=["鸡蛋", "三黄鸡"], top_n=2)

    assert [(item.index, item.relevance_score) for item in results] == [(1, 0.92), (0, 0.44)]


def test_rerank_client_raises_on_http_error() -> None:
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="reranker",
        timeout_seconds=10,
        transport=httpx.MockTransport(lambda request: httpx.Response(400, request=request)),
    )

    with pytest.raises(RerankUnavailableError):
        client.rerank(query="鸡肉", documents=["鸡蛋", "三黄鸡"], top_n=2)


def test_rerank_client_raises_on_missing_results() -> None:
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="reranker",
        timeout_seconds=10,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
    )

    with pytest.raises(RerankUnavailableError, match="missing results"):
        client.rerank(query="鸡肉", documents=["鸡蛋", "三黄鸡"], top_n=2)


def test_rerank_client_raises_on_invalid_index() -> None:
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="reranker",
        timeout_seconds=10,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"results": [{"index": 2, "relevance_score": 0.9}]})),
    )

    with pytest.raises(RerankUnavailableError, match="out of range"):
        client.rerank(query="鸡肉", documents=["鸡蛋", "三黄鸡"], top_n=2)


def test_rerank_client_dispatches_before_http_and_settles_exact_document_count(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _usage_adapter(model_usage_db)
    states_at_http: list[ModelUsageReservationStatus] = []

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        with adapter.session_factory() as db:
            reservation = db.scalar(select(ModelUsageReservation))
            assert reservation is not None
            states_at_http.append(reservation.status)
        return httpx.Response(
            200,
            headers={"x-request-id": "rerank-provider-request"},
            json={
                "results": [{"index": 1, "relevance_score": 0.93}],
                "usage": {"total_tokens": 19},
            },
        )

    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(handler),
        usage_adapter=adapter,
        model_usage_required=True,
    )

    results = client.rerank(
        query="鸡肉",
        documents=["鸡蛋", "三黄鸡", "鸡汤"],
        top_n=3,
        attribution=reservation_context.attribution,
        attempt_key="search-1:rerank",
    )

    assert [(item.index, item.relevance_score) for item in results] == [(1, 0.93)]
    assert states_at_http == [ModelUsageReservationStatus.DISPATCHING]
    event = model_usage_db.scalar(select(ModelUsageEvent))
    assert event is not None
    assert event.attempt_key == "search-1:rerank"
    meter = model_usage_db.scalar(
        select(ModelUsageEventMeter).where(ModelUsageEventMeter.event_id == event.id)
    )
    assert meter is not None
    assert meter.meter is ModelUsageMeter.INPUT_TOKENS
    assert meter.quantity == Decimal("19")
    assert "鸡肉" not in repr(event)


def test_rerank_client_settles_provider_usage_before_rejecting_invalid_results(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _usage_adapter(model_usage_db)
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                request=request,
                json={
                    "results": [{"index": 9, "relevance_score": 0.93}],
                    "usage": {"total_tokens": 23},
                },
            )
        ),
        usage_adapter=adapter,
        model_usage_required=True,
    )

    with pytest.raises(RerankUnavailableError) as exc_info:
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋", "三黄鸡"],
            top_n=2,
            attribution=reservation_context.attribution,
            attempt_key="search-invalid-results:rerank",
        )

    assert exc_info.value.code == "search_rerank_provider_response_invalid"
    reservation = model_usage_db.scalar(select(ModelUsageReservation))
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    event = model_usage_db.scalar(select(ModelUsageEvent))
    assert event is not None
    meter = model_usage_db.scalar(
        select(ModelUsageEventMeter).where(ModelUsageEventMeter.event_id == event.id)
    )
    assert meter is not None
    assert meter.meter is ModelUsageMeter.INPUT_TOKENS
    assert meter.quantity == Decimal("23")


def test_rerank_client_empty_input_makes_no_usage_attempt(
    model_usage_db: Session,
    reservation_context,
) -> None:
    adapter = _usage_adapter(model_usage_db)
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        usage_adapter=adapter,
        model_usage_required=True,
    )

    assert client.rerank(
        query="鸡肉",
        documents=[],
        top_n=2,
        attribution=reservation_context.attribution,
        attempt_key="search-empty:rerank",
    ) == []
    assert model_usage_db.scalar(select(ModelUsageReservation)) is None
    assert model_usage_db.scalar(select(ModelUsageEvent)) is None


def test_rerank_client_confirms_http_failure_not_executed(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _usage_adapter(model_usage_db)
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(lambda request: httpx.Response(400, request=request)),
        usage_adapter=adapter,
        model_usage_required=True,
    )

    with pytest.raises(RerankUnavailableError) as exc_info:
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋", "三黄鸡"],
            top_n=2,
            attribution=reservation_context.attribution,
            attempt_key="search-2:rerank",
        )

    assert exc_info.value.code == "search_rerank_provider_failed"
    reservation = model_usage_db.scalar(select(ModelUsageReservation))
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    event = model_usage_db.scalar(select(ModelUsageEvent))
    assert event is not None
    assert event.provider_outcome.value == "not_billed"


def test_rerank_client_marks_transport_failure_uncertain_once(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _usage_adapter(model_usage_db)
    provider_calls = 0

    def fail_transport(request: httpx.Request) -> httpx.Response:
        nonlocal provider_calls
        provider_calls += 1
        raise httpx.ReadTimeout("rerank timeout", request=request)

    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(fail_transport),
        usage_adapter=adapter,
        model_usage_required=True,
    )

    with pytest.raises(RerankUnavailableError) as exc_info:
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋", "三黄鸡"],
            top_n=2,
            attribution=reservation_context.attribution,
            attempt_key="search-3:rerank",
        )

    assert exc_info.value.code == "search_rerank_transport_uncertain"
    reservation = model_usage_db.scalar(select(ModelUsageReservation))
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN
    assert model_usage_db.scalar(select(ModelUsageEvent)) is None

    with pytest.raises(ModelUsageStateError, match="reservation_not_dispatchable"):
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋", "三黄鸡"],
            top_n=2,
            attribution=reservation_context.attribution,
            attempt_key="search-3:rerank",
        )

    assert provider_calls == 1


def test_rerank_client_treats_server_error_as_uncertain(
    model_usage_db: Session,
    reservation_context,
) -> None:
    publish(model_usage_db, raw_manifest())
    adapter = _usage_adapter(model_usage_db)
    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(lambda request: httpx.Response(500, request=request)),
        usage_adapter=adapter,
        model_usage_required=True,
    )

    with pytest.raises(RerankUnavailableError) as exc_info:
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋", "三黄鸡"],
            top_n=2,
            attribution=reservation_context.attribution,
            attempt_key="search-5:rerank",
        )

    assert exc_info.value.code == "search_rerank_transport_uncertain"
    reservation = model_usage_db.scalar(select(ModelUsageReservation))
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN
    assert model_usage_db.scalar(select(ModelUsageEvent)) is None


@pytest.mark.parametrize(
    "code",
    (
        "model_usage_budget_exceeded",
        "model_usage_capability_limit_exceeded",
        "model_usage_price_unavailable",
        "model_usage_ledger_unavailable",
    ),
)
def test_rerank_client_does_not_post_when_admission_is_blocked(reservation_context, code: str) -> None:
    class BlockingAdapter:
        signer = ProviderUsageReceiptSigner(
            active_key_id="blocked-rerank-test-key",
            keys={"blocked-rerank-test-key": b"blocked-rerank-test-secret"},
        )

        def begin(self, **kwargs):
            del kwargs
            raise ModelUsageBlocked(code)

    provider_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal provider_calls
        del request
        provider_calls += 1
        return httpx.Response(200, json={"results": []})

    client = OpenAICompatibleRerankClient(
        provider="dashscope",
        api_base="https://rerank.example/v1",
        api_key="test-key",
        model="rerank-test",
        timeout_seconds=10,
        transport=httpx.MockTransport(handler),
        usage_adapter=BlockingAdapter(),  # type: ignore[arg-type]
        model_usage_required=True,
    )

    with pytest.raises(ModelUsageBlocked, match=code):
        client.rerank(
            query="鸡肉",
            documents=["鸡蛋"],
            top_n=1,
            attribution=reservation_context.attribution,
            attempt_key="search-blocked:rerank",
        )

    assert provider_calls == 0
