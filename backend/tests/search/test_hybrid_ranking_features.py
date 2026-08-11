from __future__ import annotations

from dataclasses import replace

from app.models.domain import SearchDocument
from app.services.search.hybrid import HybridSearchResult, _sort_with_rerank
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


def _attribution() -> UsageAttribution:
    return UsageAttribution(
        family_id="family-1",
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id="user-1",
        operation_source=ModelUsageOperationSource.INTERACTIVE,
        logical_operation_id="search-1",
    )


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

    client = FakeRerankClient(
        [
            RerankResult(index=0, relevance_score=0.95),
            RerankResult(index=2, relevance_score=0.20),
            RerankResult(index=4, relevance_score=0.20),
        ]
    )
    sorted_results, degraded, degradation_code, rerank_used = _sort_with_rerank(
        query="鸡肉",
        results=[exact, reranked, literal, weak],
        documents_by_key={
            ("ingredient", "reranked"): _document(entity_id="reranked", title_text="三黄鸡"),
            ("ingredient", "literal"): _document(entity_id="literal", title_text="冷冻鸡肉块"),
            ("ingredient", "weak"): _document(entity_id="weak", title_text="青椒"),
        },
        rerank_client=client,
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
    assert rerank_used is True
    assert client.documents
    assert [item.entity_id for item in sorted_results] == ["exact", "reranked", "literal"]
    assert exact.score == 0.4
    assert reranked.score == 2.95
    assert literal.score == 1.89
    assert literal.match_reason[0] == "名称包含"


def test_sort_with_rerank_returns_identical_local_order_when_disabled_or_blocked() -> None:
    local = [
        HybridSearchResult("recipe", "first", 2.8, local_score=2.8, literal_score=0.8),
        HybridSearchResult("recipe", "second", 1.9, local_score=1.9, literal_score=0.7),
        HybridSearchResult("recipe", "third", 0.4, local_score=0.4, literal_score=0.0),
    ]
    documents = {
        ("recipe", item.entity_id): _document(entity_id=item.entity_id, title_text=item.entity_id)
        for item in local
    }

    disabled, disabled_degraded, disabled_code, disabled_used = _sort_with_rerank(
        query="晚餐", results=[replace(item) for item in local], documents_by_key=documents,
        rerank_client=None,
        rerank_min_score=0.58, literal_fallback_min_score=0.70,
        rerank_candidate_limit=50, rerank_attribution=None,
        rerank_attempt_key="search-1:rerank",
    )
    blocked, blocked_degraded, blocked_code, blocked_used = _sort_with_rerank(
        query="晚餐", results=[replace(item) for item in local], documents_by_key=documents,
        rerank_client=BudgetBlockedRerankClient(),
        rerank_min_score=0.58, literal_fallback_min_score=0.70,
        rerank_candidate_limit=50, rerank_attribution=_attribution(),
        rerank_attempt_key="search-1:rerank",
    )

    assert [(item.entity_id, item.score) for item in disabled] == [("first", 2.8), ("second", 1.9), ("third", 0.4)]
    assert [(item.entity_id, item.score) for item in blocked] == [(item.entity_id, item.score) for item in disabled]
    assert (disabled_degraded, disabled_code, disabled_used) == (False, None, False)
    assert (blocked_degraded, blocked_code, blocked_used) == (True, "model_usage_capability_limit_exceeded", True)
