from __future__ import annotations

from decimal import Decimal

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
from app.services.model_usage.adapters.rerank import RerankUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageStateError
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
