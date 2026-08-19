from __future__ import annotations

from app.models.domain import SearchDocument
from app.services.search.constants import (
    SEARCH_LITERAL_FALLBACK_MIN_SCORE,
    SEARCH_RERANK_CANDIDATE_LIMIT,
    SEARCH_RERANK_INSTRUCTION,
    SEARCH_RERANK_MIN_SCORE,
    SEARCH_SEMANTIC_MIN_SCORE,
)
from app.services.search.hybrid import HybridSearchResult, _sort_with_rerank
from app.services.search.rerank import RerankResult


class _FixedRerankClient:
    enabled = True

    def rerank(self, **_kwargs):
        return [RerankResult(index=0, relevance_score=SEARCH_RERANK_MIN_SCORE)]


def test_search_constants_are_fixed_platform_policy() -> None:
    assert SEARCH_RERANK_INSTRUCTION == (
        "你是中文厨房搜索结果重排器。目标是找出与查询词最直接匹配的食材、食物或菜谱。"
        "短查询优先按字面匹配排序：名称完全相同 > 名称、别名或关键词包含查询词 > "
        "语义相关但未字面命中 > 无关、测试或占位数据。"
    )
    assert SEARCH_SEMANTIC_MIN_SCORE == 0.48
    assert SEARCH_RERANK_MIN_SCORE == 0.58
    assert SEARCH_LITERAL_FALLBACK_MIN_SCORE == 0.70
    assert SEARCH_RERANK_CANDIDATE_LIMIT == 50


def test_fixed_rerank_threshold_accepts_the_boundary_score() -> None:
    candidate = HybridSearchResult(
        entity_type="recipe",
        entity_id="recipe-1",
        score=0.1,
        local_score=0.1,
    )
    document = SearchDocument(
        family_id="family-1",
        entity_type="recipe",
        entity_id="recipe-1",
        title_text="番茄鸡蛋",
        keyword_text="番茄",
        detail_text="",
        semantic_text="",
        content_hash="test-hash",
        document_builder_version="v1",
    )

    ordered, degraded, code, used = _sort_with_rerank(
        query="番茄",
        results=[candidate],
        documents_by_key={("recipe", "recipe-1"): document},
        rerank_client=_FixedRerankClient(),
        rerank_min_score=SEARCH_RERANK_MIN_SCORE,
        literal_fallback_min_score=SEARCH_LITERAL_FALLBACK_MIN_SCORE,
        rerank_candidate_limit=SEARCH_RERANK_CANDIDATE_LIMIT,
        rerank_attribution=None,
        rerank_attempt_key=None,
    )

    assert ordered == [candidate]
    assert candidate.score == 2.58
    assert (degraded, code, used) == (False, None, True)
