from __future__ import annotations

import httpx
import pytest

from app.services.search.rerank import OpenAICompatibleRerankClient, RerankUnavailableError


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
        transport=httpx.MockTransport(lambda request: httpx.Response(500, request=request)),
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
