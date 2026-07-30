from __future__ import annotations

from app.models.domain import SearchDocument
from app.services.search.hybrid import HybridSearchResult, _literal_fallback_score, _sort_with_rerank
from app.services.search.rerank import RerankResult
from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.services.model_usage.errors import ModelUsageBlocked
from app.services.model_usage.types import UsageAttribution
from tests.search._support import FakeRerankClient


def _document(
    *,
    entity_id: str,
    title_text: str,
    keyword_text: str = "",
    detail_text: str = "",
    metadata_json: dict[str, object] | None = None,
) -> SearchDocument:
    return SearchDocument(
        id=f"search-doc-{entity_id}",
        family_id="family-1",
        entity_type="ingredient",
        entity_id=entity_id,
        title_text=title_text,
        keyword_text=keyword_text,
        detail_text=detail_text,
        semantic_text=f"食材：{title_text}",
        metadata_json=metadata_json or {},
        content_hash=f"hash-{entity_id}",
        document_builder_version="v1",
    )


def test_literal_fallback_scores_title_and_keyword_matches_without_detail_text() -> None:
    title_document = _document(entity_id="title", title_text="冷冻鸡肉块", keyword_text="肉类", detail_text="鸡肉适合炖汤")
    keyword_document = _document(entity_id="keyword", title_text="冷冻肉块", keyword_text="鸡 肉 肉类")
    detail_only_document = _document(entity_id="detail", title_text="番茄汤", keyword_text="番茄", detail_text="适合快手晚餐")

    assert _literal_fallback_score(query="鸡肉", document=title_document) == (0.85, "名称包含")
    assert _literal_fallback_score(query="鸡肉", document=keyword_document) == (0.70, "关键词匹配")
    assert _literal_fallback_score(query="快手", document=detail_only_document) == (0.0, "")


def test_literal_fallback_ignores_single_character_keyword_matches() -> None:
    document = _document(
        entity_id="seasoning",
        title_text="盐",
        keyword_text="盐 调味料",
        metadata_json={"name": "盐", "category": "调味料"},
    )

    assert _literal_fallback_score(query="料", document=document) == (0.0, "")


def test_sort_with_rerank_assigns_separate_exact_rerank_and_literal_buckets() -> None:
    exact = HybridSearchResult(entity_type="ingredient", entity_id="exact", score=0, exact_name_match=True, local_score=0.4)
    reranked = HybridSearchResult(entity_type="ingredient", entity_id="reranked", score=0, local_score=0.9)
    literal = HybridSearchResult(
        entity_type="ingredient",
        entity_id="literal",
        score=0,
        local_score=0.2,
        literal_score=0.89,
        literal_reason="名称包含",
        match_reason=["语意接近：鸡肉"],
    )
    weak = HybridSearchResult(entity_type="ingredient", entity_id="weak", score=0, local_score=0.8, literal_score=0.2)

    sorted_results, degraded, degradation_code = _sort_with_rerank(
        query="鸡肉",
        results=[weak, literal, reranked, exact],
        documents_by_key={
            ("ingredient", "reranked"): _document(entity_id="reranked", title_text="三黄鸡"),
            ("ingredient", "literal"): _document(entity_id="literal", title_text="冷冻鸡肉块"),
            ("ingredient", "weak"): _document(entity_id="weak", title_text="青椒"),
        },
        rerank_client=FakeRerankClient(
            [
                RerankResult(index=0, relevance_score=0.95),
                RerankResult(index=2, relevance_score=0.20),
                RerankResult(index=4, relevance_score=0.20),
            ]
        ),
        rerank_min_score=0.58,
        literal_fallback_min_score=0.70,
        rerank_candidate_limit=50,
        rerank_attribution=UsageAttribution(
            family_id="family-1",
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id="user-1",
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="search-1",
        ),
        rerank_attempt_key="search-1:rerank",
    )

    assert degraded is False
    assert degradation_code is None
    assert [item.entity_id for item in sorted_results] == ["exact", "reranked", "literal"]
    assert exact.score == 3.4
    assert reranked.score == 2.95
    assert literal.score == 1.89
    assert literal.match_reason[0] == "名称包含"


def test_sort_with_rerank_uses_local_order_when_reranker_is_disabled() -> None:
    first = HybridSearchResult(entity_type="ingredient", entity_id="first", score=0, local_score=0.2)
    second = HybridSearchResult(entity_type="ingredient", entity_id="second", score=0, local_score=0.8)
    exact = HybridSearchResult(entity_type="ingredient", entity_id="exact", score=0, exact_name_match=True, local_score=0.1)

    sorted_results, degraded, degradation_code = _sort_with_rerank(
        query="鸡肉",
        results=[first, second, exact],
        documents_by_key={},
        rerank_client=None,
        rerank_min_score=0.58,
        literal_fallback_min_score=0.70,
        rerank_candidate_limit=50,
        rerank_attribution=UsageAttribution(
            family_id="family-1",
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id="user-1",
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="search-1",
        ),
        rerank_attempt_key="search-1:rerank",
    )

    assert degraded is False
    assert degradation_code is None
    assert [item.entity_id for item in sorted_results] == ["exact", "second", "first"]


def test_sort_with_rerank_returns_local_order_and_usage_block_code() -> None:
    class BudgetBlockedRerankClient:
        enabled = True

        def __init__(self) -> None:
            self.attribution: UsageAttribution | None = None
            self.attempt_key: str | None = None

        def rerank(self, *, query, documents, top_n, attribution=None, attempt_key=None):
            del query, documents, top_n
            self.attribution = attribution
            self.attempt_key = attempt_key
            raise ModelUsageBlocked("model_usage_capability_limit_exceeded")

    first = HybridSearchResult(entity_type="ingredient", entity_id="first", score=0, local_score=0.2)
    second = HybridSearchResult(entity_type="ingredient", entity_id="second", score=0, local_score=0.8)
    client = BudgetBlockedRerankClient()
    attribution = UsageAttribution(
        family_id="family-1",
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id="user-1",
        operation_source=ModelUsageOperationSource.INTERACTIVE,
        logical_operation_id="search-usage-1",
    )

    sorted_results, degraded, degradation_code = _sort_with_rerank(
        query="鸡肉",
        results=[first, second],
        documents_by_key={
            ("ingredient", "first"): _document(entity_id="first", title_text="冷冻鸡肉"),
            ("ingredient", "second"): _document(entity_id="second", title_text="三黄鸡"),
        },
        rerank_client=client,
        rerank_min_score=0.58,
        literal_fallback_min_score=0.70,
        rerank_candidate_limit=50,
        rerank_attribution=attribution,
        rerank_attempt_key="search-usage-1:rerank",
    )

    assert degraded is True
    assert degradation_code == "model_usage_capability_limit_exceeded"
    assert [item.entity_id for item in sorted_results] == ["second", "first"]
    assert [item.score for item in sorted_results] == [0.8, 0.2]
    assert client.attribution == attribution
    assert client.attempt_key == "search-usage-1:rerank"
