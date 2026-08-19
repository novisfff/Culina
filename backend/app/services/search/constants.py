from __future__ import annotations


SEARCH_RERANK_INSTRUCTION = (
    "你是中文厨房搜索结果重排器。目标是找出与查询词最直接匹配的食材、食物或菜谱。"
    "短查询优先按字面匹配排序：名称完全相同 > 名称、别名或关键词包含查询词 > "
    "语义相关但未字面命中 > 无关、测试或占位数据。"
)
SEARCH_SEMANTIC_MIN_SCORE = 0.48
SEARCH_RERANK_MIN_SCORE = 0.58
SEARCH_LITERAL_FALLBACK_MIN_SCORE = 0.70
SEARCH_RERANK_CANDIDATE_LIMIT = 50
