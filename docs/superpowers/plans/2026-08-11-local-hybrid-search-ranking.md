# Culina Local Hybrid Search Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 直接用“置信分层 + 层内动态融合”替换现有固定权重本地排序，使 rerank 关闭或失败时仍能稳定返回高质量结果，同时保留 `text-embedding-v4 + Qdrant` 语义召回和配置控制的 rerank 链路。

**Architecture:** 新增确定性的查询分析、排序特征和纯本地排序三个模块；`keyword_store.py` 提供可验证的召回证据，`scoring.py` 只提供有符号业务信号与理由，`hybrid.py` 负责召回、按来源 rank 合并、业务实体复核、调用唯一的本地排序以及可选 rerank。质量集、指标和性能基准全部使用合成数据，不调用真实 embedding、Qdrant 或 rerank provider。

**Tech Stack:** Python 3.12、FastAPI、SQLAlchemy 2、Pydantic Settings、Qdrant、pytest、标准库 `dataclasses` / `enum` / `unicodedata` / `logging` / `time`。

## Global Constraints

- 保留现有 `text-embedding-v4 + Qdrant` 语义召回；不改变 embedding 文档、向量维度、collection 或索引。
- rerank 链路不删除、不关闭，继续由现有 provider 配置控制；候选上限、超时、计量和计费合同保持不变。
- 直接替换旧本地排序；不增加 v1/v2 开关、shadow 双算、灰度或旧算法兼容读取。
- 删除 `SEARCH_RERANK_SEMANTIC_MIN_SCORE`，新增 `SEARCH_SEMANTIC_MIN_SCORE=0.48`；`0.74`、`0.82` 和融合权重保持代码常量。
- 不引入新的外部模型、网络请求、中文分词器或第三方 NLP 依赖。
- API 字段保持 `score`、`keyword_score`、`semantic_score`、`business_score`、`match_reason`；`business_score` 允许 `[-1, 1]`，负向理由不展示。
- 所有业务查询继续按 `family_id` 隔离，餐食计划继续按 `family_id + user_id` 隔离；排序日志不得包含查询正文、实体 ID、家庭 ID、用户 ID或搜索文档内容。
- 不修改前端 UI，不新增数据库 schema，不创建 Alembic migration，不重建搜索文档或 Qdrant 索引。
- 每项实现先写失败测试、确认失败原因、做最小实现、运行定向测试后提交；不得使用 `git add -A`。

---

## File Map

### Production files

- Create `backend/app/services/search/query_analysis.py`: NFKC、标点/空白边界、意图 span 提取、查询类型和安全 token 匹配的唯一真相源。
- Create `backend/app/services/search/ranking_features.py`: 将召回 hit、`SearchDocument` 和业务理由转换成不可变排序特征。
- Create `backend/app/services/search/local_ranking.py`: L0-L4 分层、分数校准、动态融合、业务微调和稳定排序的唯一实现。
- Modify `backend/app/services/search/keyword_store.py`: 为每个关键词 hit 保留 `matched_fields` 与 `match_modes`，并复用安全 token matcher。
- Modify `backend/app/services/search/scoring.py`: 删除最终固定加权公式，只保留业务信号、正向/负向理由和确定性理由整理。
- Modify `backend/app/services/search/hybrid.py`: 收敛为查询分析、召回、候选合并、特征构建、本地排序、rerank 和无正文诊断的编排层。
- Modify `backend/app/core/config.py`: 用 `search_semantic_min_score` 替换旧字段并验证 `[0, 1)`。
- Modify `backend/.env.example`, `deploy/.env.example`, `deploy/docker-compose.yml`: 直接替换环境变量名。

### Test and evaluation files

- Create `backend/tests/search/test_query_analysis.py`.
- Create `backend/tests/search/test_ranking_features.py`.
- Create `backend/tests/search/test_local_ranking.py`.
- Create `backend/tests/search/test_local_ranking_quality.py`.
- Create `backend/tests/search/test_local_ranking_performance.py`.
- Create `backend/tests/search/ranking_quality.py`.
- Create `backend/tests/search/fixtures/local_ranking_quality_cases.json`.
- Create `backend/tests/search/fixtures/local_ranking_baseline.json`.
- Create `backend/scripts/build_search_quality_fixture.py` and retain it as the deterministic fixture generator.
- Create `backend/scripts/run_search_ranking_quality.py` as the human-readable quality gate entry point.
- Temporarily create, then delete, `backend/scripts/capture_legacy_search_baseline.py`; the final working tree must not retain the旧固定加权公式。
- Modify `backend/tests/search/test_keyword_store.py`, `test_scoring.py`, `test_hybrid_ranking_features.py`, `test_hybrid_search.py`, `test_search_api.py`, `test_inventory_search.py`, and `_support.py`.
- Modify `backend/tests/core/test_search_config.py`.
- Modify `backend/tests/ai_infra/test_tool_registry.py` only for search result ordering/score-contract assertions; do not alter AI approval behavior。

## Interface Lock

Later tasks must use these exact public interfaces:

```python
# query_analysis.py
class SearchQueryKind(str, Enum):
    LITERAL = "literal"
    INTENT = "intent"
    MIXED = "mixed"

@dataclass(frozen=True)
class SearchQueryProfile:
    original_text: str
    normalized_text: str
    compact_text: str
    kind: SearchQueryKind
    effective_length: int
    intent_keys: tuple[str, ...]

analyze_search_query(query: str) -> SearchQueryProfile
normalize_search_text(value: object) -> str
compact_search_text(value: object) -> str
safe_token_contains(query: object, value: object, *, merge_single_cjk: bool = True) -> bool

# keyword_store.py
class KeywordMatchMode(str, Enum):
    MYSQL_FULLTEXT = "mysql_fulltext"
    SUBSTRING = "substring"
    SAFE_COMPACT = "safe_compact"

@dataclass(frozen=True)
class KeywordSearchHit:
    entity_type: str
    entity_id: str
    keyword_score: float
    matched_fields: tuple[str, ...]
    match_modes: tuple[KeywordMatchMode, ...] = ()

# ranking_features.py
class LiteralMatchKind(str, Enum):
    NONE = "none"
    DETAIL = "detail"
    COMPACT_KEYWORD = "compact_keyword"
    STRUCTURED_KEYWORD = "structured_keyword"
    TITLE_CONTAINS = "title_contains"
    TITLE_PREFIX = "title_prefix"
    EXACT_NAME = "exact_name"

@dataclass(frozen=True)
class SearchRankingCandidate:
    entity_type: str
    entity_id: str
    keyword_score: float
    semantic_score: float
    keyword_rank: int | None
    semantic_rank: int | None
    literal_match: LiteralMatchKind
    literal_confidence: float
    trusted_keyword_match: bool
    detail_only_match: bool
    dual_source_match: bool
    signed_business_score: float
    positive_reasons: tuple[str, ...]

build_ranking_candidate(
    *,
    profile: SearchQueryProfile,
    entity_type: str,
    entity_id: str,
    document: SearchDocument | None,
    exact_name_match: bool,
    keyword_hit: KeywordSearchHit | None,
    keyword_rank: int | None,
    semantic_score: object,
    semantic_rank: int | None,
    business_reasons: Sequence[SearchReason],
) -> SearchRankingCandidate

# local_ranking.py
class SearchConfidenceLevel(IntEnum):
    EXACT = 0
    TITLE = 1
    STRONG = 2
    RELEVANT = 3
    WEAK = 4

@dataclass(frozen=True)
class LocalRankingScore:
    confidence_level: SearchConfidenceLevel
    keyword_confidence: float
    semantic_confidence: float
    agreement_bonus: float
    business_adjustment: float
    within_level_score: float
    final_score: float

rank_local_candidates(
    profile: SearchQueryProfile,
    candidates: list[SearchRankingCandidate],
) -> list[tuple[SearchRankingCandidate, LocalRankingScore]]
```

The signatures above are interface notation. Implementation steps below provide executable function bodies.

---

### Task 1: Freeze the synthetic quality set and legacy recall baseline

**Files:**
- Create: `backend/scripts/build_search_quality_fixture.py`
- Create temporarily: `backend/scripts/capture_legacy_search_baseline.py`
- Create: `backend/tests/search/fixtures/local_ranking_quality_cases.json`
- Create: `backend/tests/search/fixtures/local_ranking_baseline.json`
- Create: `backend/tests/search/test_local_ranking_quality.py`

**Interfaces:**
- Consumes: the current fixed-weight formula only in the temporary capture script.
- Produces: a deterministic 80-case JSON fixture and immutable baseline `{case_count, case_ids, recall_at_20}` used by Task 10.

- [ ] **Step 1: Write the fixture-contract test before the fixture exists**

Add this initial test to `backend/tests/search/test_local_ranking_quality.py`:

```python
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def test_local_ranking_quality_fixture_has_fixed_coverage() -> None:
    cases = json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))
    baseline = json.loads((FIXTURE_DIR / "local_ranking_baseline.json").read_text(encoding="utf-8"))

    assert len(cases) == 80
    assert Counter(case["category"] for case in cases) == {
        "literal": 20,
        "semantic": 15,
        "intent": 15,
        "mixed": 10,
        "noise": 10,
        "business": 10,
    }
    assert len({case["case_id"] for case in cases}) == 80
    assert baseline == {
        "case_count": 80,
        "case_ids": [case["case_id"] for case in cases],
        "recall_at_20": 1.0,
    }
    assert all(0 <= candidate["relevance"] <= 3 for case in cases for candidate in case["candidates"])
    assert all(len(case["candidates"]) >= 4 for case in cases)
    assert {
        candidate["entity_type"] for case in cases for candidate in case["candidates"]
    } == {"ingredient", "food", "recipe", "meal_plan"}
    assert sum(
        bool(case["scope_context"]["excluded_other_user_meal_plan_id"]) for case in cases
    ) == 10
    literal_best = [case["candidates"][0]["literal_match"] for case in cases if case["category"] == "literal"]
    assert Counter(literal_best) == {"exact_name": 7, "title_prefix": 7, "title_contains": 6}
```

- [ ] **Step 2: Run the contract test and confirm the missing fixture failure**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking_quality.py::test_local_ranking_quality_fixture_has_fixed_coverage -q
```

Expected: FAIL with `FileNotFoundError` for `local_ranking_quality_cases.json`.

- [ ] **Step 3: Add a deterministic fixture generator with all six required categories**

Create `backend/scripts/build_search_quality_fixture.py` with the following complete generator. It deliberately uses synthetic IDs and never reads a database or provider:

```python
from __future__ import annotations

import json
from pathlib import Path

OUTPUT = Path(__file__).parents[1] / "tests/search/fixtures/local_ranking_quality_cases.json"


def candidate(
    entity_id: str,
    relevance: int,
    *,
    literal_match: str = "none",
    literal_confidence: float = 0.0,
    keyword_score: float = 0.0,
    semantic_score: float = 0.0,
    trusted_keyword_match: bool = False,
    detail_only_match: bool = False,
    dual_source_match: bool = False,
    business_score: float = 0.0,
) -> dict[str, object]:
    return {
        "entity_type": "recipe",
        "entity_id": entity_id,
        "relevance": relevance,
        "keyword_score": keyword_score,
        "semantic_score": semantic_score,
        "keyword_rank": 1 if keyword_score > 0 else None,
        "semantic_rank": 1 if semantic_score > 0 else None,
        "literal_match": literal_match,
        "literal_confidence": literal_confidence,
        "trusted_keyword_match": trusted_keyword_match,
        "detail_only_match": detail_only_match,
        "dual_source_match": dual_source_match,
        "signed_business_score": business_score,
        "positive_reasons": ["合成质量证据"],
    }


def build_cases() -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for index in range(20):
        primary_kind, primary_confidence = (
            ("exact_name", 1.0),
            ("title_prefix", 0.95),
            ("title_contains", 0.90),
        )[index % 3]
        secondary_kind, secondary_confidence = (
            ("title_prefix", 0.95)
            if primary_kind == "exact_name"
            else ("structured_keyword", 0.80)
        )
        cases.append({
            "case_id": f"literal-{index + 1:02d}",
            "category": "literal",
            "query": f"家常菜{index + 1}",
            "candidates": [
                candidate(f"literal-{index}-best", 3, literal_match=primary_kind, literal_confidence=primary_confidence, keyword_score=1.0, trusted_keyword_match=True),
                candidate(f"literal-{index}-secondary", 2, literal_match=secondary_kind, literal_confidence=secondary_confidence, keyword_score=0.9, trusted_keyword_match=True),
                candidate(f"literal-{index}-semantic", 1, semantic_score=0.84),
                candidate(f"literal-{index}-noise", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
            ],
        })
    semantic_queries = ["清淡暖胃", "适合老人", "孩子爱吃", "雨天热汤", "运动后补充", "夏天开胃", "不油腻", "软烂好嚼", "一锅完成", "下班很累", "周末慢炖", "便于带饭", "高温天凉菜", "深夜少负担", "早起有精神"]
    for index, query in enumerate(semantic_queries):
        cases.append({
            "case_id": f"semantic-{index + 1:02d}",
            "category": "semantic",
            "query": query,
            "candidates": [
                candidate(f"semantic-{index}-best", 3, semantic_score=0.91),
                candidate(f"semantic-{index}-related", 2, semantic_score=0.80),
                candidate(f"semantic-{index}-weak", 1, semantic_score=0.56),
                candidate(f"semantic-{index}-noise", 0, semantic_score=0.47),
            ],
        })
    intent_queries = ["快手", "简单", "早餐", "午餐", "晚餐", "夜宵", "库存", "补货", "临期", "今天", "明天", "本周", "计划", "做过", "记录"]
    for index, query in enumerate(intent_queries):
        cases.append({
            "case_id": f"intent-{index + 1:02d}",
            "category": "intent",
            "query": query,
            "candidates": [
                candidate(f"intent-{index}-best", 3, semantic_score=0.90, business_score=0.4),
                candidate(f"intent-{index}-related", 2, semantic_score=0.83),
                candidate(f"intent-{index}-literal", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.8, trusted_keyword_match=True),
                candidate(f"intent-{index}-noise", 0, semantic_score=0.50, business_score=1.0),
            ],
        })
    mixed_queries = ["鸡肉 快手", "番茄 晚餐", "牛奶 早餐", "豆腐 补货", "鲈鱼 今天", "面条 明天", "南瓜 本周", "米饭 计划", "鸡蛋 做过", "酸奶 记录"]
    for index, query in enumerate(mixed_queries):
        cases.append({
            "case_id": f"mixed-{index + 1:02d}",
            "category": "mixed",
            "query": query,
            "candidates": [
                candidate(f"mixed-{index}-best", 3, literal_match="structured_keyword", literal_confidence=0.80, keyword_score=0.85, semantic_score=0.82, trusted_keyword_match=True, dual_source_match=True, business_score=0.2),
                candidate(f"mixed-{index}-semantic", 2, semantic_score=0.88),
                candidate(f"mixed-{index}-literal", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.75, trusted_keyword_match=True),
                candidate(f"mixed-{index}-noise", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
            ],
        })
    for index in range(10):
        cases.append({
            "case_id": f"noise-{index + 1:02d}",
            "category": "noise",
            "query": "鸡肉" if index % 2 == 0 else "料",
            "candidates": [
                candidate(f"noise-{index}-exact", 3, literal_match="exact_name", literal_confidence=1.0, keyword_score=1.0, trusted_keyword_match=True),
                candidate(f"noise-{index}-prefix", 2, literal_match="title_prefix", literal_confidence=0.95, keyword_score=0.9, trusted_keyword_match=True),
                candidate(f"noise-{index}-structured", 2, literal_match="structured_keyword", literal_confidence=0.80, keyword_score=0.8, trusted_keyword_match=True),
                candidate(f"noise-{index}-dual", 1, literal_match="compact_keyword", literal_confidence=0.70, keyword_score=0.7, semantic_score=0.70, trusted_keyword_match=True, dual_source_match=True),
                candidate(f"noise-{index}-semantic", 1, semantic_score=0.75),
                candidate(f"noise-{index}-detail", 0, literal_match="detail", literal_confidence=0.35, keyword_score=1.0, detail_only_match=True),
                candidate(f"noise-{index}-below-floor", 0, semantic_score=0.47),
            ],
        })
    for index in range(10):
        cases.append({
            "case_id": f"business-{index + 1:02d}",
            "category": "business",
            "query": f"家庭晚餐{index + 1}",
            "candidates": [
                candidate(f"business-{index}-positive", 3, semantic_score=0.80, business_score=0.8),
                candidate(f"business-{index}-neutral", 2, semantic_score=0.80),
                candidate(f"business-{index}-negative", 1, semantic_score=0.80, business_score=-0.8),
                candidate(f"business-{index}-weak", 0, semantic_score=0.52, business_score=1.0),
            ],
        })
    entity_types = ("ingredient", "food", "recipe", "meal_plan")
    for case_index, case in enumerate(cases):
        case["scope_context"] = {
            "family_id": "synthetic-family-a",
            "user_id": "synthetic-user-a",
            "excluded_other_user_meal_plan_id": (
                f"synthetic-other-user-plan-{case_index:02d}" if case_index < 10 else None
            ),
        }
        for candidate_index, item in enumerate(case["candidates"]):
            item["entity_type"] = entity_types[(case_index + candidate_index) % len(entity_types)]
    assert len(cases) == 80
    return cases


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build_cases(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(build_cases())} cases to {OUTPUT}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Generate the fixed dataset**

Run:

```bash
cd backend && .venv/bin/python scripts/build_search_quality_fixture.py
```

Expected: `wrote 80 cases` and a UTF-8 JSON file containing only synthetic IDs/text.

- [ ] **Step 5: Capture the old algorithm's aggregate Recall@20 and case IDs once**

Create `backend/scripts/capture_legacy_search_baseline.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

FIXTURE_DIR = Path(__file__).parents[1] / "tests/search/fixtures"


def legacy_score(candidate: dict[str, object]) -> float:
    keyword = float(candidate["keyword_score"])
    semantic = float(candidate["semantic_score"])
    business = max(0.0, min(float(candidate["signed_business_score"]), 1.0))
    exact_bonus = 1.0 if candidate["literal_match"] == "exact_name" else 0.0
    title_bonus = 0.05 if candidate["literal_match"] in {"title_prefix", "title_contains"} else 0.0
    relevance = max(keyword, semantic)
    return keyword * 0.45 + semantic * 0.50 + business * 0.05 * relevance + exact_bonus + title_bonus


def main() -> None:
    cases = json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))
    recovered = 0
    relevant = 0
    for case in cases:
        ranked = sorted(case["candidates"], key=lambda item: (-legacy_score(item), str(item["entity_id"])))[:20]
        relevant_ids = {item["entity_id"] for item in case["candidates"] if int(item["relevance"]) > 0}
        ranked_ids = {item["entity_id"] for item in ranked}
        relevant += len(relevant_ids)
        recovered += len(relevant_ids & ranked_ids)
    payload = {
        "case_count": len(cases),
        "case_ids": [case["case_id"] for case in cases],
        "recall_at_20": round(recovered / relevant, 6),
    }
    (FIXTURE_DIR / "local_ranking_baseline.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

Run:

```bash
cd backend && .venv/bin/python scripts/capture_legacy_search_baseline.py
```

Expected: JSON output with `"case_count": 80` and `"recall_at_20": 1.0`. Do not add query text or candidate documents to the baseline file.

- [ ] **Step 6: Run the fixture-contract test**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking_quality.py::test_local_ranking_quality_fixture_has_fixed_coverage -q
```

Expected: PASS.

- [ ] **Step 7: Commit the frozen quality inputs**

```bash
git add backend/scripts/build_search_quality_fixture.py backend/scripts/capture_legacy_search_baseline.py backend/tests/search/fixtures/local_ranking_quality_cases.json backend/tests/search/fixtures/local_ranking_baseline.json backend/tests/search/test_local_ranking_quality.py
git commit -m "test(search): freeze local ranking quality baseline"
```

---

### Task 2: Add deterministic query analysis and safe token matching

**Files:**
- Create: `backend/app/services/search/query_analysis.py`
- Create: `backend/tests/search/test_query_analysis.py`

**Interfaces:**
- Consumes: no project service; standard library only.
- Produces: `SearchQueryKind`, `SearchQueryProfile`, `analyze_search_query`, `normalize_search_text`, `compact_search_text`, and `safe_token_contains` exactly as locked above.

- [ ] **Step 1: Write failing table-driven query analysis tests**

Create `backend/tests/search/test_query_analysis.py`:

```python
from __future__ import annotations

import pytest

from app.services.search.query_analysis import (
    SearchQueryKind,
    analyze_search_query,
    compact_search_text,
    normalize_search_text,
    safe_token_contains,
)


@pytest.mark.parametrize(
    ("query", "normalized", "compact", "kind", "intent_keys"),
    [
        ("  番茄  鸡蛋 ", "番茄 鸡蛋", "番茄鸡蛋", SearchQueryKind.LITERAL, ()),
        ("ＦＡＳＴ，早餐", "fast 早餐", "fast早餐", SearchQueryKind.MIXED, ("meal",)),
        ("快手、晚餐", "快手 晚餐", "快手晚餐", SearchQueryKind.INTENT, ("quick", "meal")),
        ("鸡肉 快手", "鸡肉 快手", "鸡肉快手", SearchQueryKind.MIXED, ("quick",)),
        ("快过期", "快过期", "快过期", SearchQueryKind.INTENT, ("inventory",)),
        ("不存在的实体词", "不存在的实体词", "不存在的实体词", SearchQueryKind.LITERAL, ()),
    ],
)
def test_analyze_search_query(query, normalized, compact, kind, intent_keys) -> None:
    profile = analyze_search_query(query)

    assert profile.original_text == query
    assert profile.normalized_text == normalized
    assert profile.compact_text == compact
    assert profile.kind is kind
    assert profile.intent_keys == intent_keys
    assert profile.effective_length == len(compact)


def test_normalization_preserves_boundaries_instead_of_joining_tokens() -> None:
    assert normalize_search_text("三黄鸡／肉类") == "三黄鸡 肉类"
    assert compact_search_text("鸡 肉") == "鸡肉"


@pytest.mark.parametrize(
    ("query", "value", "merge_single_cjk", "expected"),
    [
        ("鸡肉", "鸡 肉", True, True),
        ("鸡肉", "三黄鸡 肉类", True, False),
        ("鸡肉", "冷冻鸡肉 肉类", True, True),
        ("料", "调味料", True, False),
        ("料", "料 调味", True, True),
        ("鸡肉", "鸡 肉", False, False),
    ],
)
def test_safe_token_contains(query, value, merge_single_cjk, expected) -> None:
    assert safe_token_contains(query, value, merge_single_cjk=merge_single_cjk) is expected
```

- [ ] **Step 2: Run the tests and verify the import failure**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_query_analysis.py -q
```

Expected: collection FAIL with `ModuleNotFoundError: app.services.search.query_analysis`.

- [ ] **Step 3: Implement the complete deterministic analyzer**

Create `backend/app/services/search/query_analysis.py`:

```python
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from enum import Enum


class SearchQueryKind(str, Enum):
    LITERAL = "literal"
    INTENT = "intent"
    MIXED = "mixed"


@dataclass(frozen=True)
class SearchQueryProfile:
    original_text: str
    normalized_text: str
    compact_text: str
    kind: SearchQueryKind
    effective_length: int
    intent_keys: tuple[str, ...]


INTENT_TERMS: dict[str, tuple[str, ...]] = {
    "quick": ("快手", "简单", "省时", "快", "速成", "容易", "新手"),
    "meal": ("早餐", "午餐", "午饭", "晚餐", "晚饭", "加餐", "夜宵"),
    "inventory": ("库存", "补货", "快没了", "低库存", "不足", "采购", "买", "临期", "到期", "快过期", "家里有"),
    "date": ("今天", "明天", "本周", "这周", "这星期"),
    "plan": ("计划", "安排", "菜单", "待做"),
    "history_status": ("完成", "做过", "吃过", "记录", "跳过"),
}

_ORDERED_INTENT_TERMS = tuple(
    sorted(
        ((term, key) for key, terms in INTENT_TERMS.items() for term in terms),
        key=lambda item: (-len(item[0]), item[0], item[1]),
    )
)


def _is_cjk(char: str) -> bool:
    return "\u4e00" <= char <= "\u9fff"


def _is_search_char(char: str) -> bool:
    return char.isalnum() or _is_cjk(char)


def normalize_search_text(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).lower()
    bounded = "".join(char if _is_search_char(char) else " " for char in normalized)
    return " ".join(bounded.split())


def compact_search_text(value: object) -> str:
    return "".join(char for char in normalize_search_text(value) if _is_search_char(char))


def _intent_spans(normalized: str) -> tuple[list[tuple[int, int, str]], tuple[str, ...]]:
    spans: list[tuple[int, int, str]] = []
    keys: list[str] = []
    cursor = 0
    while cursor < len(normalized):
        matched = next(
            ((term, key) for term, key in _ORDERED_INTENT_TERMS if normalized.startswith(term, cursor)),
            None,
        )
        if matched is None:
            cursor += 1
            continue
        term, key = matched
        spans.append((cursor, cursor + len(term), key))
        if key not in keys:
            keys.append(key)
        cursor += len(term)
    return spans, tuple(keys)


def analyze_search_query(query: str) -> SearchQueryProfile:
    normalized = normalize_search_text(query)
    compact = compact_search_text(normalized)
    spans, intent_keys = _intent_spans(normalized)
    remaining = list(normalized)
    for start, end, _key in spans:
        remaining[start:end] = " " * (end - start)
    remaining_compact = compact_search_text("".join(remaining))
    if not intent_keys:
        kind = SearchQueryKind.LITERAL
    elif remaining_compact:
        kind = SearchQueryKind.MIXED
    else:
        kind = SearchQueryKind.INTENT
    return SearchQueryProfile(
        original_text=query,
        normalized_text=normalized,
        compact_text=compact,
        kind=kind,
        effective_length=len(compact),
        intent_keys=intent_keys,
    )


def safe_token_contains(query: object, value: object, *, merge_single_cjk: bool = True) -> bool:
    compact_query = compact_search_text(query)
    if not compact_query:
        return False
    tokens = tuple(token for token in normalize_search_text(value).split(" ") if token)
    single_cjk_query = len(compact_query) == 1 and _is_cjk(compact_query)
    for token in tokens:
        compact_token = compact_search_text(token)
        if compact_token == compact_query:
            return True
        if not single_cjk_query and compact_query in compact_token:
            return True
    if not merge_single_cjk:
        return False
    run: list[str] = []
    for token in (*tokens, ""):
        compact_token = compact_search_text(token)
        if len(compact_token) == 1 and _is_cjk(compact_token):
            run.append(compact_token)
            continue
        if run and compact_query in "".join(run):
            return True
        run = []
    return False
```

- [ ] **Step 4: Run query analysis tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_query_analysis.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the query analyzer**

```bash
git add backend/app/services/search/query_analysis.py backend/tests/search/test_query_analysis.py
git commit -m "feat(search): add deterministic query analysis"
```

---

### Task 3: Preserve keyword retrieval evidence and make compact fallback safe

**Files:**
- Modify: `backend/app/services/search/keyword_store.py`
- Modify: `backend/tests/search/test_keyword_store.py`

**Interfaces:**
- Consumes: `compact_search_text`, `normalize_search_text`, `safe_token_contains` from Task 2.
- Produces: `KeywordMatchMode` and `KeywordSearchHit.match_modes`; all hit constructors and merge paths preserve exact modes and fields.

- [ ] **Step 1: Extend keyword-store tests with evidence and boundary failures**

Update imports and add these tests to `backend/tests/search/test_keyword_store.py`:

```python
from app.services.search.keyword_store import KeywordMatchMode, _compact_matched_fields


def test_merge_keyword_hits_preserves_fields_and_all_match_modes() -> None:
    hits = _merge_keyword_hits(
        [KeywordSearchHit("ingredient", "chicken", 0.6, ("keyword_text",), (KeywordMatchMode.MYSQL_FULLTEXT,))],
        [KeywordSearchHit("ingredient", "chicken", 0.8, ("title_text",), (KeywordMatchMode.SAFE_COMPACT,))],
        limit=10,
    )

    assert hits == [
        KeywordSearchHit(
            "ingredient",
            "chicken",
            0.8,
            ("title_text", "keyword_text"),
            (KeywordMatchMode.MYSQL_FULLTEXT, KeywordMatchMode.SAFE_COMPACT),
        )
    ]


def test_compact_matcher_joins_only_single_cjk_keyword_tokens() -> None:
    safe = SearchDocument(
        id="doc-safe", family_id="family-1", entity_type="ingredient", entity_id="safe",
        title_text="冷冻肉块", keyword_text="鸡 肉 肉类", detail_text="", semantic_text="食材", metadata_json={},
        content_hash="safe", document_builder_version="v1",
    )
    unsafe = SearchDocument(
        id="doc-unsafe", family_id="family-1", entity_type="ingredient", entity_id="unsafe",
        title_text="三黄鸡", keyword_text="三黄鸡 肉类", detail_text="", semantic_text="食材", metadata_json={},
        content_hash="unsafe", document_builder_version="v1",
    )

    assert _compact_matched_fields(safe, "鸡肉") == ["keyword_text"]
    assert _compact_matched_fields(unsafe, "鸡肉") == []


def test_single_cjk_compact_fallback_does_not_match_inside_multi_char_keyword() -> None:
    document = SearchDocument(
        id="doc-seasoning", family_id="family-1", entity_type="ingredient", entity_id="seasoning",
        title_text="盐", keyword_text="调味料", detail_text="常温放置", semantic_text="食材", metadata_json={},
        content_hash="seasoning", document_builder_version="v1",
    )

    assert _compact_matched_fields(document, "料") == []
```

Also update every existing `KeywordSearchHit(...)` expectation in this file to include the expected `match_modes` when asserting object equality.

- [ ] **Step 2: Run the three new tests and verify failures**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py -q
```

Expected: FAIL because `KeywordMatchMode` and `match_modes` do not exist and compact matching still joins arbitrary token boundaries.

- [ ] **Step 3: Add the mode enum and update every hit constructor**

In `backend/app/services/search/keyword_store.py`, add imports and definitions:

```python
from enum import Enum

from app.services.search.query_analysis import compact_search_text, normalize_search_text, safe_token_contains


class KeywordMatchMode(str, Enum):
    MYSQL_FULLTEXT = "mysql_fulltext"
    SUBSTRING = "substring"
    SAFE_COMPACT = "safe_compact"


@dataclass(frozen=True)
class KeywordSearchHit:
    entity_type: str
    entity_id: str
    keyword_score: float
    matched_fields: tuple[str, ...]
    match_modes: tuple[KeywordMatchMode, ...] = ()
```

Use `(KeywordMatchMode.SUBSTRING,)` for exact-name and LIKE hits, `(KeywordMatchMode.SAFE_COMPACT,)` for compact hits, and `(KeywordMatchMode.MYSQL_FULLTEXT,)` for MySQL hits. Replace `_normalize_query` and `_compact_query` bodies so they delegate to Task 2:

```python
def _normalize_query(value: str) -> str:
    return normalize_search_text(value)


def _compact_query(value: object) -> str:
    return compact_search_text(value)
```

- [ ] **Step 4: Replace unsafe compact field matching and merge modes deterministically**

Replace `_compact_matched_fields` and the merged-hit construction with:

```python
def _compact_matched_fields(document: SearchDocument, query: str) -> list[str]:
    matches: list[str] = []
    compact_query = compact_search_text(query)
    if compact_query and compact_query in compact_search_text(document.title_text):
        matches.append("title_text")
    if safe_token_contains(query, document.keyword_text):
        matches.append("keyword_text")
    if safe_token_contains(query, document.detail_text, merge_single_cjk=False):
        matches.append("detail_text")
    return matches


def _merged_modes(*hits: KeywordSearchHit) -> tuple[KeywordMatchMode, ...]:
    ordered = (
        KeywordMatchMode.MYSQL_FULLTEXT,
        KeywordMatchMode.SUBSTRING,
        KeywordMatchMode.SAFE_COMPACT,
    )
    return tuple(mode for mode in ordered if any(mode in hit.match_modes for hit in hits))
```

In `_merge_keyword_hits`, retain the current deterministic field order and construct the merged hit with:

```python
by_key[key] = KeywordSearchHit(
    entity_type=hit.entity_type,
    entity_id=hit.entity_id,
    keyword_score=max(existing.keyword_score, hit.keyword_score),
    matched_fields=matched_fields,
    match_modes=_merged_modes(existing, hit),
)
```

- [ ] **Step 5: Run keyword-store tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_keyword_store.py -q
```

Expected: PASS, including family isolation, MySQL statement, exact-name search, short-Chinese fallback and new token-boundary cases.

- [ ] **Step 6: Commit keyword evidence changes**

```bash
git add backend/app/services/search/keyword_store.py backend/tests/search/test_keyword_store.py
git commit -m "feat(search): preserve safe keyword match evidence"
```

---

### Task 4: Make business signals signed and consume the shared query profile

**Files:**
- Modify: `backend/app/services/search/scoring.py`
- Modify: `backend/tests/search/test_scoring.py`

**Interfaces:**
- Consumes: `SearchQueryProfile.intent_keys` from Task 2 and `KeywordSearchHit` from Task 3.
- Produces: `business_score_candidates` with the required `profile` keyword argument, `signed_business_score`, existing reason helpers, and no final keyword/semantic weighting function.

- [ ] **Step 1: Replace fixed-score tests with signed-business and reason-contract tests**

In `backend/tests/search/test_scoring.py`, remove tests that assert `score_search_candidate.final_score`. Keep entity-specific signal tests, but construct `profile = analyze_search_query(query)` and pass `profile=profile`. Add:

```python
from app.services.search.query_analysis import analyze_search_query
from app.services.search.scoring import signed_business_score


def test_signed_business_score_preserves_negative_signals() -> None:
    profile = analyze_search_query("早餐")
    reasons = business_score_candidates(
        entity_type="food",
        profile=profile,
        metadata={},
        signals=SearchBusinessSignals(inventory_available=False, days_since_used=1),
    )

    assert signed_business_score(reasons) == -0.56
    assert "库存不足" not in reason_labels(reasons)
    assert "最近刚吃过" not in reason_labels(reasons)


def test_signed_business_score_clamps_both_directions() -> None:
    assert signed_business_score([
        SearchReason("a", "A", 0.8, "business"),
        SearchReason("b", "B", 0.7, "business"),
    ]) == 1.0
    assert signed_business_score([
        SearchReason("a", "A", -0.8, "business"),
        SearchReason("b", "B", -0.7, "business"),
    ]) == -1.0


def test_business_intent_uses_query_profile_keys() -> None:
    quick = business_score_candidates(
        entity_type="recipe",
        profile=analyze_search_query("速成"),
        metadata={"prep_minutes": 15, "difficulty": "easy"},
    )
    literal = business_score_candidates(
        entity_type="recipe",
        profile=analyze_search_query("十五分钟"),
        metadata={"prep_minutes": 15, "difficulty": "easy"},
    )

    assert [reason.key for reason in quick] == ["quick_recipe", "easy_recipe"]
    assert literal == []
```

- [ ] **Step 2: Run scoring tests and verify the signature/negative-score failures**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_scoring.py -q
```

Expected: FAIL because the current API accepts `query`, clamps the sum to `[0, 1]`, and still owns the final fixed formula.

- [ ] **Step 3: Remove final weighting and add signed aggregation**

Delete `KEYWORD_WEIGHT`, `SEMANTIC_WEIGHT`, `BUSINESS_WEIGHT`, `TITLE_MATCH_BONUS`, `EXACT_NAME_BONUS`, `SearchScore`, and `score_search_candidate`. Add:

```python
from app.services.search.query_analysis import SearchQueryProfile


def signed_business_score(candidates: list[SearchReason]) -> float:
    return max(-1.0, min(sum(candidate.weight for candidate in candidates), 1.0))


def business_score_candidates(
    *,
    entity_type: str,
    profile: SearchQueryProfile,
    metadata: dict[str, object],
    signals: SearchBusinessSignals | None = None,
) -> list[SearchReason]:
    if entity_type == "recipe":
        return _recipe_business_candidates(profile=profile, metadata=metadata, signals=signals)
    if entity_type == "food":
        return _food_business_candidates(profile=profile, metadata=metadata, signals=signals)
    if entity_type == "ingredient":
        return _ingredient_business_candidates(profile=profile, signals=signals)
    if entity_type == "meal_plan":
        return _meal_plan_business_candidates(profile=profile, metadata=metadata, signals=signals)
    return []
```

- [ ] **Step 4: Convert each entity helper to profile-based intent checks**

Change helper parameters from `query: str` to `profile: SearchQueryProfile`. Apply these exact rules:

```python
def _has_intent(profile: SearchQueryProfile, key: str) -> bool:
    return key in profile.intent_keys


# recipe
if prep_minutes is not None and prep_minutes <= 20 and _has_intent(profile, "quick"):
    reasons.append(SearchReason("quick_recipe", f"{prep_minutes} 分钟内", 0.32, "business"))
if difficulty == "easy" and _has_intent(profile, "quick"):
    reasons.append(SearchReason("easy_recipe", "做法简单", 0.18, "business"))

# ingredient
if signals.low_stock:
    weight = 0.16 if _has_intent(profile, "inventory") else 0.08
    reasons.append(SearchReason("ingredient_low_stock", "低库存", weight, "business"))

# meal plan status/date
if plan_status == "planned" and _has_intent(profile, "plan"):
    reasons.append(SearchReason("meal_plan_planned", "待安排", 0.16, "business"))
elif plan_status == "cooked" and _has_intent(profile, "history_status"):
    reasons.append(SearchReason("meal_plan_cooked", "已完成", 0.12, "business"))
```

Use `profile.normalized_text` only to select the exact matched scene tag, meal label, or date label after the corresponding `intent_key` is present. Do not retain `_contains_any` or another hard-coded intent synonym set in `scoring.py`.

Keep `reason_labels` behavior unchanged: sort descending by weight, skip all non-positive weights, dedupe by key and label, and return at most three labels.

- [ ] **Step 5: Run scoring and query-analysis tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_scoring.py tests/search/test_query_analysis.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit the signed business model**

```bash
git add backend/app/services/search/scoring.py backend/tests/search/test_scoring.py
git commit -m "refactor(search): isolate signed business signals"
```

---

### Task 5: Build normalized ranking features from recall evidence

**Files:**
- Create: `backend/app/services/search/ranking_features.py`
- Create: `backend/tests/search/test_ranking_features.py`

**Interfaces:**
- Consumes: query normalization from Task 2, keyword evidence from Task 3, and `SearchReason`/reason helpers from Task 4.
- Produces: `LiteralMatchKind`, `SearchRankingCandidate`, and `build_ranking_candidate` exactly as locked in the File Map.

- [ ] **Step 1: Write failing feature extraction tests**

Create `backend/tests/search/test_ranking_features.py`:

```python
from __future__ import annotations

import math

import pytest

from app.models.domain import SearchDocument
from app.services.search.keyword_store import KeywordMatchMode, KeywordSearchHit
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, build_ranking_candidate
from app.services.search.scoring import SearchReason


def document(
    *,
    entity_id: str = "candidate",
    title: str = "三黄鸡",
    keywords: str = "三黄鸡 肉类",
    details: str = "",
    metadata: dict[str, object] | None = None,
) -> SearchDocument:
    return SearchDocument(
        id=f"doc-{entity_id}", family_id="family-1", entity_type="ingredient", entity_id=entity_id,
        title_text=title, keyword_text=keywords, detail_text=details, semantic_text=f"食材：{title}",
        metadata_json=metadata or {}, content_hash=f"hash-{entity_id}", document_builder_version="v1",
    )


def build(
    *,
    query: str,
    search_document: SearchDocument | None,
    exact: bool = False,
    hit: KeywordSearchHit | None = None,
    semantic_score: object = 0.0,
    business_reasons: list[SearchReason] | None = None,
):
    return build_ranking_candidate(
        profile=analyze_search_query(query),
        entity_type="ingredient",
        entity_id="candidate",
        document=search_document,
        exact_name_match=exact,
        keyword_hit=hit,
        keyword_rank=2 if hit else None,
        semantic_score=semantic_score,
        semantic_rank=3 if semantic_score else None,
        business_reasons=business_reasons or [],
    )


@pytest.mark.parametrize(
    ("query", "search_document", "exact", "expected_kind", "expected_confidence"),
    [
        ("三黄鸡", document(), True, LiteralMatchKind.EXACT_NAME, 1.0),
        ("三黄", document(), False, LiteralMatchKind.TITLE_PREFIX, 0.95),
        ("黄鸡", document(), False, LiteralMatchKind.TITLE_CONTAINS, 0.90),
        ("禽肉", document(metadata={"name": "三黄鸡", "category": "禽肉"}), False, LiteralMatchKind.STRUCTURED_KEYWORD, 0.80),
    ],
)
def test_build_ranking_candidate_classifies_strong_literal_evidence(
    query, search_document, exact, expected_kind, expected_confidence
) -> None:
    candidate = build(query=query, search_document=search_document, exact=exact)

    assert candidate.literal_match is expected_kind
    assert candidate.literal_confidence == expected_confidence


def test_safe_compact_keyword_does_not_cross_multi_character_tokens() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 1.0, ("keyword_text",), (KeywordMatchMode.SAFE_COMPACT,)
    )

    unsafe = build(query="鸡肉", search_document=document(keywords="三黄鸡 肉类"), hit=hit)
    safe = build(query="鸡肉", search_document=document(keywords="鸡 肉 肉类"), hit=hit)

    assert unsafe.literal_match is LiteralMatchKind.NONE
    assert unsafe.trusted_keyword_match is False
    assert safe.literal_match is LiteralMatchKind.COMPACT_KEYWORD
    assert safe.trusted_keyword_match is True


def test_detail_only_match_is_not_trusted_or_dual_source() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 1.0, ("detail_text",), (KeywordMatchMode.SUBSTRING,)
    )
    candidate = build(
        query="快手",
        search_document=document(details="适合快手晚餐"),
        hit=hit,
        semantic_score=0.80,
    )

    assert candidate.literal_match is LiteralMatchKind.DETAIL
    assert candidate.detail_only_match is True
    assert candidate.trusted_keyword_match is False
    assert candidate.dual_source_match is False


@pytest.mark.parametrize("invalid", [None, "bad", "0.8", math.nan, math.inf, -1.0, 2.0])
def test_invalid_semantic_scores_are_finite_and_clamped(invalid) -> None:
    candidate = build(query="晚餐", search_document=document(), semantic_score=invalid)

    assert math.isfinite(candidate.semantic_score)
    assert 0.0 <= candidate.semantic_score <= 1.0


def test_candidate_preserves_source_ranks_and_signed_business_score() -> None:
    hit = KeywordSearchHit(
        "ingredient", "candidate", 0.8, ("keyword_text",), (KeywordMatchMode.MYSQL_FULLTEXT,)
    )
    candidate = build(
        query="三黄鸡",
        search_document=document(),
        hit=hit,
        semantic_score=0.75,
        business_reasons=[SearchReason("recent", "最近刚吃过", -0.35, "business")],
    )

    assert candidate.keyword_rank == 2
    assert candidate.semantic_rank == 3
    assert candidate.signed_business_score == -0.35
    assert "最近刚吃过" not in candidate.positive_reasons
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_ranking_features.py -q
```

Expected: collection FAIL with `ModuleNotFoundError: app.services.search.ranking_features`.

- [ ] **Step 3: Define immutable feature types and score normalization**

Create `backend/app/services/search/ranking_features.py` with these definitions and helpers:

```python
from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from app.models.domain import SearchDocument
from app.services.search.keyword_store import KeywordMatchMode, KeywordSearchHit
from app.services.search.query_analysis import SearchQueryProfile, compact_search_text, normalize_search_text, safe_token_contains
from app.services.search.scoring import (
    SearchReason,
    keyword_reason_candidates,
    reason_labels,
    semantic_reason_candidates,
    signed_business_score,
)


class LiteralMatchKind(str, Enum):
    NONE = "none"
    DETAIL = "detail"
    COMPACT_KEYWORD = "compact_keyword"
    STRUCTURED_KEYWORD = "structured_keyword"
    TITLE_CONTAINS = "title_contains"
    TITLE_PREFIX = "title_prefix"
    EXACT_NAME = "exact_name"


@dataclass(frozen=True)
class SearchRankingCandidate:
    entity_type: str
    entity_id: str
    keyword_score: float
    semantic_score: float
    keyword_rank: int | None
    semantic_rank: int | None
    literal_match: LiteralMatchKind
    literal_confidence: float
    trusted_keyword_match: bool
    detail_only_match: bool
    dual_source_match: bool
    signed_business_score: float
    positive_reasons: tuple[str, ...]


def _finite_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    score = float(value)
    if not math.isfinite(score):
        return 0.0
    return max(0.0, min(score, 1.0))


def _valid_rank(value: int | None) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _metadata_values(document: SearchDocument) -> tuple[str, ...]:
    metadata = document.metadata_json or {}
    fields_by_type = {
        "ingredient": ("name", "category"),
        "food": ("name", "category", "flavor_tags", "scene_tags", "suitable_meal_types"),
        "recipe": ("title", "scene_tags", "ingredient_names"),
        "meal_plan": ("food_name", "recipe_title", "plan_date", "meal_type", "meal_type_label", "status", "status_label"),
    }
    values: list[str] = []
    for field in fields_by_type.get(document.entity_type, ()):
        value = metadata.get(field)
        if isinstance(value, list):
            values.extend(str(item) for item in value if str(item).strip())
        elif value is not None and str(value).strip():
            values.append(str(value))
    return tuple(values)
```

- [ ] **Step 4: Implement literal evidence classification and positive reasons**

Add these helpers below the type definitions:

```python
def _title_match(profile: SearchQueryProfile, document: SearchDocument | None) -> LiteralMatchKind:
    if document is None or not profile.compact_text:
        return LiteralMatchKind.NONE
    compact_title = compact_search_text(document.title_text)
    if compact_title.startswith(profile.compact_text):
        return LiteralMatchKind.TITLE_PREFIX
    if profile.compact_text in compact_title:
        return LiteralMatchKind.TITLE_CONTAINS
    return LiteralMatchKind.NONE


def _structured_match(profile: SearchQueryProfile, document: SearchDocument | None) -> bool:
    if document is None:
        return False
    return any(safe_token_contains(profile.normalized_text, value) for value in _metadata_values(document))


def _keyword_match(
    profile: SearchQueryProfile,
    document: SearchDocument | None,
    hit: KeywordSearchHit | None,
) -> bool:
    if document is None or hit is None or "keyword_text" not in hit.matched_fields:
        return False
    if KeywordMatchMode.MYSQL_FULLTEXT in hit.match_modes:
        query_tokens = tuple(token for token in profile.normalized_text.split(" ") if token)
        return any(safe_token_contains(token, document.keyword_text) for token in query_tokens)
    if KeywordMatchMode.SUBSTRING in hit.match_modes:
        return normalize_search_text(profile.normalized_text) in normalize_search_text(document.keyword_text)
    return KeywordMatchMode.SAFE_COMPACT in hit.match_modes and safe_token_contains(
        profile.normalized_text,
        document.keyword_text,
    )


def _detail_match(hit: KeywordSearchHit | None) -> bool:
    return hit is not None and "detail_text" in hit.matched_fields


def _literal_reason(entity_type: str, literal: LiteralMatchKind) -> SearchReason | None:
    title_label = "名称匹配" if entity_type in {"ingredient", "food"} else "标题匹配"
    mapping = {
        LiteralMatchKind.EXACT_NAME: SearchReason("title_match", title_label, 1.2, "exact_name"),
        LiteralMatchKind.TITLE_PREFIX: SearchReason("title_match", title_label, 1.0, "literal"),
        LiteralMatchKind.TITLE_CONTAINS: SearchReason("title_match", title_label, 0.95, "literal"),
        LiteralMatchKind.STRUCTURED_KEYWORD: SearchReason("structured_match", "关键词匹配", 0.80, "literal"),
        LiteralMatchKind.COMPACT_KEYWORD: SearchReason("keyword_match", "关键词匹配", 0.70, "literal"),
        LiteralMatchKind.DETAIL: SearchReason("detail_match", "详情提到", 0.30, "literal"),
    }
    return mapping.get(literal)
```

- [ ] **Step 5: Implement the public feature builder**

Add the complete builder:

```python
def build_ranking_candidate(
    *,
    profile: SearchQueryProfile,
    entity_type: str,
    entity_id: str,
    document: SearchDocument | None,
    exact_name_match: bool,
    keyword_hit: KeywordSearchHit | None,
    keyword_rank: int | None,
    semantic_score: object,
    semantic_rank: int | None,
    business_reasons: Sequence[SearchReason],
) -> SearchRankingCandidate:
    normalized_semantic = _finite_score(semantic_score)
    normalized_keyword = _finite_score(keyword_hit.keyword_score if keyword_hit is not None else 0.0)
    title_match = _title_match(profile, document)
    structured_match = _structured_match(profile, document)
    keyword_match = _keyword_match(profile, document, keyword_hit)
    detail_match = _detail_match(keyword_hit)
    if exact_name_match:
        literal = LiteralMatchKind.EXACT_NAME
        literal_confidence = 1.0
    elif title_match is LiteralMatchKind.TITLE_PREFIX:
        literal = title_match
        literal_confidence = 0.95
    elif title_match is LiteralMatchKind.TITLE_CONTAINS:
        literal = title_match
        literal_confidence = 0.90
    elif structured_match:
        literal = LiteralMatchKind.STRUCTURED_KEYWORD
        literal_confidence = 0.80
    elif keyword_match:
        literal = LiteralMatchKind.COMPACT_KEYWORD
        literal_confidence = 0.70
    elif detail_match:
        literal = LiteralMatchKind.DETAIL
        literal_confidence = 0.35
    else:
        literal = LiteralMatchKind.NONE
        literal_confidence = 0.0
    trusted_keyword = literal in {
        LiteralMatchKind.EXACT_NAME,
        LiteralMatchKind.TITLE_PREFIX,
        LiteralMatchKind.TITLE_CONTAINS,
        LiteralMatchKind.STRUCTURED_KEYWORD,
        LiteralMatchKind.COMPACT_KEYWORD,
    }
    detail_only = literal is LiteralMatchKind.DETAIL
    dual_source = trusted_keyword and normalized_semantic >= 0.48
    reasons: list[SearchReason] = []
    literal_reason = _literal_reason(entity_type, literal)
    if literal_reason is not None:
        reasons.append(literal_reason)
    if keyword_hit is not None:
        reasons.extend(keyword_reason_candidates(keyword_hit))
    reasons.extend(semantic_reason_candidates(query=profile.normalized_text, semantic_score=normalized_semantic))
    reasons.extend(business_reasons)
    return SearchRankingCandidate(
        entity_type=entity_type,
        entity_id=entity_id,
        keyword_score=normalized_keyword,
        semantic_score=normalized_semantic,
        keyword_rank=_valid_rank(keyword_rank),
        semantic_rank=_valid_rank(semantic_rank),
        literal_match=literal,
        literal_confidence=literal_confidence,
        trusted_keyword_match=trusted_keyword,
        detail_only_match=detail_only,
        dual_source_match=dual_source,
        signed_business_score=signed_business_score(list(business_reasons)),
        positive_reasons=tuple(reason_labels(reasons)),
    )
```

- [ ] **Step 6: Run feature, scoring, keyword and query tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_ranking_features.py tests/search/test_scoring.py tests/search/test_keyword_store.py tests/search/test_query_analysis.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit feature extraction**

```bash
git add backend/app/services/search/ranking_features.py backend/tests/search/test_ranking_features.py
git commit -m "feat(search): extract normalized ranking features"
```

---

### Task 6: Implement the only local fusion ranking algorithm

**Files:**
- Create: `backend/app/services/search/local_ranking.py`
- Create: `backend/tests/search/test_local_ranking.py`

**Interfaces:**
- Consumes: `SearchQueryProfile` and `SearchRankingCandidate` from Tasks 2 and 5.
- Produces: `SearchConfidenceLevel`, `LocalRankingScore`, and `rank_local_candidates`; no I/O and no provider access.

- [ ] **Step 1: Write failing L0-L4, calibration, business and tie-break tests**

Create `backend/tests/search/test_local_ranking.py`:

```python
from __future__ import annotations

from dataclasses import replace

import pytest

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import SearchQueryKind, SearchQueryProfile, analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate


def candidate(entity_id: str, **overrides) -> SearchRankingCandidate:
    values = {
        "entity_type": "recipe",
        "entity_id": entity_id,
        "keyword_score": 0.0,
        "semantic_score": 0.0,
        "keyword_rank": None,
        "semantic_rank": None,
        "literal_match": LiteralMatchKind.NONE,
        "literal_confidence": 0.0,
        "trusted_keyword_match": False,
        "detail_only_match": False,
        "dual_source_match": False,
        "signed_business_score": 0.0,
        "positive_reasons": (),
    }
    values.update(overrides)
    return SearchRankingCandidate(**values)


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        (candidate("exact", literal_match=LiteralMatchKind.EXACT_NAME, literal_confidence=1.0, keyword_score=1.0, trusted_keyword_match=True), SearchConfidenceLevel.EXACT),
        (candidate("title", literal_match=LiteralMatchKind.TITLE_CONTAINS, literal_confidence=0.9, keyword_score=0.8, trusted_keyword_match=True), SearchConfidenceLevel.TITLE),
        (candidate("structured", literal_match=LiteralMatchKind.STRUCTURED_KEYWORD, literal_confidence=0.8, keyword_score=0.8, trusted_keyword_match=True), SearchConfidenceLevel.STRONG),
        (candidate("dual-strong", literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, keyword_score=0.7, semantic_score=0.60, trusted_keyword_match=True, dual_source_match=True), SearchConfidenceLevel.STRONG),
        (candidate("semantic-strong", semantic_score=0.82), SearchConfidenceLevel.STRONG),
        (candidate("keyword", literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, keyword_score=0.7, trusted_keyword_match=True), SearchConfidenceLevel.RELEVANT),
        (candidate("semantic", semantic_score=0.74), SearchConfidenceLevel.RELEVANT),
        (candidate("detail", literal_match=LiteralMatchKind.DETAIL, literal_confidence=0.35, keyword_score=1.0, detail_only_match=True), SearchConfidenceLevel.WEAK),
        (candidate("semantic-weak", semantic_score=0.48), SearchConfidenceLevel.WEAK),
    ],
)
def test_confidence_level_contract(item, expected) -> None:
    ranked = rank_local_candidates(analyze_search_query("晚餐"), [item])

    assert ranked[0][1].confidence_level is expected


def test_pure_semantic_below_floor_is_filtered_but_keyword_evidence_survives() -> None:
    below = candidate("below", semantic_score=0.479999)
    keyword = candidate(
        "keyword", semantic_score=0.2, keyword_score=0.6,
        literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7, trusted_keyword_match=True,
    )

    ranked = rank_local_candidates(analyze_search_query("鸡肉"), [below, keyword])

    assert [item.entity_id for item, _score in ranked] == ["keyword"]


def test_semantic_calibration_boundaries() -> None:
    items = [candidate("floor", semantic_score=0.48), candidate("top", semantic_score=1.0)]
    scores = {item.entity_id: score for item, score in rank_local_candidates(analyze_search_query("清淡"), items)}

    assert scores["floor"].semantic_confidence == 0.0
    assert scores["top"].semantic_confidence == 1.0


def test_query_kind_changes_only_within_level_weighting() -> None:
    item = candidate(
        "dual", keyword_score=0.8, semantic_score=0.8,
        literal_match=LiteralMatchKind.COMPACT_KEYWORD, literal_confidence=0.7,
        trusted_keyword_match=True, dual_source_match=True,
    )
    literal_profile = analyze_search_query("鸡肉")
    mixed_profile = analyze_search_query("鸡肉 快手")
    intent_profile = analyze_search_query("快手")

    literal_score = rank_local_candidates(literal_profile, [item])[0][1]
    mixed_score = rank_local_candidates(mixed_profile, [item])[0][1]
    intent_score = rank_local_candidates(intent_profile, [item])[0][1]

    assert {literal_score.confidence_level, mixed_score.confidence_level, intent_score.confidence_level} == {SearchConfidenceLevel.STRONG}
    assert literal_score.agreement_bonus == 0.05
    assert mixed_score.agreement_bonus == 0.10
    assert intent_score.agreement_bonus == 0.10


def test_signed_business_adjustment_is_bounded_and_cannot_change_level() -> None:
    base = candidate("base", semantic_score=0.80)
    positive = replace(base, entity_id="positive", signed_business_score=1.0)
    negative = replace(base, entity_id="negative", signed_business_score=-1.0)
    ranked = rank_local_candidates(analyze_search_query("家庭晚餐"), [base, positive, negative])
    scores = {item.entity_id: score for item, score in ranked}

    assert scores["positive"].business_adjustment == pytest.approx(scores["positive"].within_level_score / 21, abs=0.002)
    assert scores["negative"].business_adjustment < 0
    assert {score.confidence_level for score in scores.values()} == {SearchConfidenceLevel.RELEVANT}
    assert [item.entity_id for item, _score in ranked] == ["positive", "base", "negative"]


def test_stable_tie_break_uses_literal_then_source_rank_then_identity() -> None:
    candidates = [
        candidate("z", semantic_score=0.75, semantic_rank=2),
        candidate("a", semantic_score=0.75, semantic_rank=2),
        candidate("rank-one", semantic_score=0.75, semantic_rank=1),
    ]

    first = rank_local_candidates(analyze_search_query("清淡"), candidates)
    second = rank_local_candidates(analyze_search_query("清淡"), list(reversed(candidates)))

    assert [item.entity_id for item, _score in first] == ["rank-one", "a", "z"]
    assert [item.entity_id for item, _score in first] == [item.entity_id for item, _score in second]
    assert all(0.0 <= score.final_score < 5.0 for _item, score in first)
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking.py -q
```

Expected: collection FAIL with `ModuleNotFoundError: app.services.search.local_ranking`.

- [ ] **Step 3: Implement confidence levels, constants and calibration**

Create `backend/app/services/search/local_ranking.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from app.services.search.query_analysis import SearchQueryKind, SearchQueryProfile
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate

SEMANTIC_MIN_SCORE = 0.48
SEMANTIC_RELEVANT_SCORE = 0.74
SEMANTIC_STRONG_SCORE = 0.82
DUAL_STRONG_SCORE = 0.60
BUSINESS_ADJUSTMENT_LIMIT = 0.05
MAX_WITHIN_LEVEL_SCORE = 0.999999


class SearchConfidenceLevel(IntEnum):
    EXACT = 0
    TITLE = 1
    STRONG = 2
    RELEVANT = 3
    WEAK = 4


@dataclass(frozen=True)
class LocalRankingScore:
    confidence_level: SearchConfidenceLevel
    keyword_confidence: float
    semantic_confidence: float
    agreement_bonus: float
    business_adjustment: float
    within_level_score: float
    final_score: float


def _confidence_level(candidate: SearchRankingCandidate) -> SearchConfidenceLevel | None:
    if candidate.literal_match is LiteralMatchKind.EXACT_NAME:
        return SearchConfidenceLevel.EXACT
    if candidate.literal_match in {LiteralMatchKind.TITLE_PREFIX, LiteralMatchKind.TITLE_CONTAINS}:
        return SearchConfidenceLevel.TITLE
    if candidate.literal_match is LiteralMatchKind.STRUCTURED_KEYWORD:
        return SearchConfidenceLevel.STRONG
    if candidate.trusted_keyword_match and candidate.semantic_score >= DUAL_STRONG_SCORE:
        return SearchConfidenceLevel.STRONG
    if not candidate.trusted_keyword_match and not candidate.detail_only_match and candidate.semantic_score >= SEMANTIC_STRONG_SCORE:
        return SearchConfidenceLevel.STRONG
    if candidate.trusted_keyword_match:
        return SearchConfidenceLevel.RELEVANT
    if not candidate.detail_only_match and candidate.semantic_score >= SEMANTIC_RELEVANT_SCORE:
        return SearchConfidenceLevel.RELEVANT
    if candidate.dual_source_match and candidate.semantic_score >= SEMANTIC_MIN_SCORE:
        return SearchConfidenceLevel.RELEVANT
    if candidate.detail_only_match or candidate.semantic_score >= SEMANTIC_MIN_SCORE:
        return SearchConfidenceLevel.WEAK
    return None


def _keyword_confidence(candidate: SearchRankingCandidate) -> float:
    field_cap = {
        LiteralMatchKind.EXACT_NAME: 1.0,
        LiteralMatchKind.TITLE_PREFIX: 0.95,
        LiteralMatchKind.TITLE_CONTAINS: 0.95,
        LiteralMatchKind.STRUCTURED_KEYWORD: 0.80,
        LiteralMatchKind.COMPACT_KEYWORD: 0.80,
        LiteralMatchKind.DETAIL: 0.35,
        LiteralMatchKind.NONE: 0.0,
    }[candidate.literal_match]
    return max(candidate.literal_confidence, candidate.keyword_score * field_cap)


def _semantic_confidence(candidate: SearchRankingCandidate) -> float:
    return max(0.0, min((candidate.semantic_score - SEMANTIC_MIN_SCORE) / (1.0 - SEMANTIC_MIN_SCORE), 1.0))


def _weights(kind: SearchQueryKind) -> tuple[float, float, float]:
    if kind is SearchQueryKind.LITERAL:
        return 0.60, 0.35, 0.05
    if kind is SearchQueryKind.MIXED:
        return 0.45, 0.45, 0.10
    return 0.30, 0.60, 0.10
```

- [ ] **Step 4: Implement fusion, signed adjustment and stable ordering**

Add:

```python
def _source_rank(candidate: SearchRankingCandidate) -> int:
    ranks = [rank for rank in (candidate.keyword_rank, candidate.semantic_rank) if rank is not None]
    return min(ranks) if ranks else 2**31 - 1


def rank_local_candidates(
    profile: SearchQueryProfile,
    candidates: list[SearchRankingCandidate],
) -> list[tuple[SearchRankingCandidate, LocalRankingScore]]:
    keyword_weight, semantic_weight, agreement_cap = _weights(profile.kind)
    ranked: list[tuple[SearchRankingCandidate, LocalRankingScore]] = []
    for candidate in candidates:
        confidence_level = _confidence_level(candidate)
        if confidence_level is None:
            continue
        keyword_confidence = _keyword_confidence(candidate)
        semantic_confidence = _semantic_confidence(candidate)
        agreement_bonus = agreement_cap if candidate.dual_source_match else 0.0
        base_relevance = min(
            keyword_confidence * keyword_weight + semantic_confidence * semantic_weight + agreement_bonus,
            1.0,
        )
        business_adjustment = candidate.signed_business_score * BUSINESS_ADJUSTMENT_LIMIT * base_relevance
        within_level_score = min(
            max(base_relevance + business_adjustment, 0.0),
            MAX_WITHIN_LEVEL_SCORE,
        )
        final_score = (4 - int(confidence_level)) + within_level_score
        ranked.append((candidate, LocalRankingScore(
            confidence_level=confidence_level,
            keyword_confidence=keyword_confidence,
            semantic_confidence=semantic_confidence,
            agreement_bonus=agreement_bonus,
            business_adjustment=business_adjustment,
            within_level_score=within_level_score,
            final_score=final_score,
        )))
    ranked.sort(key=lambda item: (
        int(item[1].confidence_level),
        -item[1].within_level_score,
        -item[0].literal_confidence,
        _source_rank(item[0]),
        item[0].entity_type,
        item[0].entity_id,
    ))
    return ranked
```

`MAX_WITHIN_LEVEL_SCORE` keeps the documented score bands strictly at L0=`4.x`, L1=`3.x`, L2=`2.x`, L3=`1.x`, L4=`0.x` even when all components reach their mathematical maximum.

- [ ] **Step 5: Run local ranking and dependency tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking.py tests/search/test_ranking_features.py tests/search/test_query_analysis.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit the unique local ranking implementation**

```bash
git add backend/app/services/search/local_ranking.py backend/tests/search/test_local_ranking.py
git commit -m "feat(search): add confidence-tier local ranking"
```

---

### Task 7: Integrate local ranking, global semantic ranks, rerank fallback and diagnostics

**Files:**
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/tests/search/_support.py`
- Modify: `backend/tests/search/test_hybrid_ranking_features.py`
- Modify: `backend/tests/search/test_hybrid_search.py`

**Interfaces:**
- Consumes: all production interfaces from Tasks 2-6 plus existing business-signal loaders and rerank client.
- Produces: one `hybrid_search` path whose local results are final when rerank is disabled/failed and are the input order/tie-break when rerank succeeds.

- [ ] **Step 1: Update test doubles to support user-filtered vector calls and disabled rerank**

Replace the vector doubles in `backend/tests/search/_support.py` with:

```python
class FakeVectorStore:
    def __init__(self, hits: list[VectorSearchHit]) -> None:
        self.hits = hits
        self.calls: list[dict[str, object]] = []

    def search(
        self,
        *,
        family_id: str,
        scopes: list[str],
        vector: list[float],
        limit: int,
        user_id: str | None = None,
    ) -> list[VectorSearchHit]:
        del vector
        self.calls.append({"family_id": family_id, "scopes": scopes, "limit": limit, "user_id": user_id})
        return [hit for hit in self.hits if hit.entity_type in scopes][:limit]


class ExplodingVectorStore:
    def search(
        self,
        *,
        family_id: str,
        scopes: list[str],
        vector: list[float],
        limit: int,
        user_id: str | None = None,
    ) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit, user_id
        raise AssertionError("vector store should not be called")


class DisabledFakeRerankClient(FakeRerankClient):
    enabled = False

    def rerank(self, **kwargs):
        del kwargs
        raise AssertionError("disabled rerank client should not be called")
```

In `search_settings`, replace `search_rerank_semantic_min_score` with `search_semantic_min_score`.

- [ ] **Step 2: Replace obsolete literal-fallback unit tests with rerank-local contract tests**

In `backend/tests/search/test_hybrid_ranking_features.py`, remove direct tests of `_literal_fallback_score`; Task 5 now owns literal evidence. Keep `_rerank_document_texts` coverage in `test_hybrid_search.py`. Add:

```python
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
        rerank_client=None, rerank_min_score=0.58, literal_fallback_min_score=0.70,
        rerank_candidate_limit=50, rerank_attribution=None, rerank_attempt_key=None,
    )
    blocked, blocked_degraded, blocked_code, blocked_used = _sort_with_rerank(
        query="晚餐", results=[replace(item) for item in local], documents_by_key=documents,
        rerank_client=BudgetBlockedRerankClient(), rerank_min_score=0.58, literal_fallback_min_score=0.70,
        rerank_candidate_limit=50, rerank_attribution=_attribution(), rerank_attempt_key="search-1:rerank",
    )

    assert [(item.entity_id, item.score) for item in disabled] == [("first", 2.8), ("second", 1.9), ("third", 0.4)]
    assert [(item.entity_id, item.score) for item in blocked] == [(item.entity_id, item.score) for item in disabled]
    assert (disabled_degraded, disabled_code, disabled_used) == (False, None, False)
    assert (blocked_degraded, blocked_code, blocked_used) == (True, "model_usage_capability_limit_exceeded", True)
```

Add `from dataclasses import replace` and this helper above the test:

```python
def _attribution() -> UsageAttribution:
    return UsageAttribution(
        family_id="family-1",
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id="user-1",
        operation_source=ModelUsageOperationSource.INTERACTIVE,
        logical_operation_id="search-1",
    )
```

Update existing `_sort_with_rerank` assertions to unpack four return values and assert whether a provider call occurred.

- [ ] **Step 3: Add integration tests for confidence tiers, global vector rank and diagnostics**

Add these tests to `backend/tests/search/test_hybrid_search.py`, reusing its existing `SessionLocal`, entity builders and `upsert_search_document` patterns:

```python
def test_search_vectors_rebuilds_global_rank_by_score_across_private_and_family_scopes() -> None:
    vector_store = FakeVectorStore([
        VectorSearchHit("recipe", "recipe-high", 0.91, 2),
        VectorSearchHit("recipe", "recipe-low", 0.62, 1),
        VectorSearchHit("meal_plan", "plan-high", 0.88, 2),
        VectorSearchHit("meal_plan", "plan-low", 0.55, 1),
    ])

    hits = hybrid_module._search_vectors(
        vector_store=vector_store,
        family_id="family-1",
        user_id="user-1",
        scopes=["recipe", "meal_plan"],
        vector=[0.1, 0.2],
        limit=3,
    )

    assert [(hit.entity_id, hit.semantic_score, hit.semantic_rank) for hit in hits] == [
        ("recipe-high", 0.91, 1),
        ("plan-high", 0.88, 2),
        ("recipe-low", 0.62, 3),
    ]
    assert vector_store.calls == [
        {"family_id": "family-1", "scopes": ["recipe"], "limit": 3, "user_id": None},
        {"family_id": "family-1", "scopes": ["meal_plan"], "limit": 3, "user_id": "user-1"},
    ]


def test_local_title_hit_stays_above_strong_pure_semantic_result_without_rerank(monkeypatch) -> None:
    SessionLocal = _seed_title_and_semantic_candidates()
    monkeypatch.setattr(hybrid_module, "get_settings", lambda: search_settings())
    disabled_rerank = DisabledFakeRerankClient()
    with SessionLocal() as db:
        response = hybrid_search(
            db, family_id="family-1", user_id="user-1", query="鸡肉", scopes=["ingredient"],
            limit=10, offset=0, embedding_client=FakeEmbeddingClient(),
            vector_store=FakeVectorStore([
                VectorSearchHit("ingredient", "ingredient-semantic", 0.95, 1),
                VectorSearchHit("ingredient", "ingredient-title", 0.70, 2),
            ]),
            rerank_client=disabled_rerank,
        )

    assert [item.entity_id for item in response.items] == ["ingredient-title", "ingredient-semantic"]
    assert 3.0 <= response.items[0].score < 4.0
    assert 2.0 <= response.items[1].score < 3.0
    assert response.degraded is False
    assert disabled_rerank.documents == []


def test_rerank_failure_returns_same_complete_local_items_as_disabled(monkeypatch) -> None:
    SessionLocal = _seed_title_and_semantic_candidates()
    monkeypatch.setattr(hybrid_module, "get_settings", lambda: search_settings())
    common = {
        "family_id": "family-1", "user_id": "user-1", "query": "鸡肉", "scopes": ["ingredient"],
        "limit": 10, "offset": 0, "embedding_client": FakeEmbeddingClient(),
        "vector_store": FakeVectorStore([
            VectorSearchHit("ingredient", "ingredient-semantic", 0.95, 1),
            VectorSearchHit("ingredient", "ingredient-title", 0.70, 2),
        ]),
    }
    with SessionLocal() as db:
        disabled = hybrid_search(db, **common, rerank_client=DisabledFakeRerankClient())
    with SessionLocal() as db:
        failed = hybrid_search(db, **common, rerank_client=FakeRerankClient(fail=True))

    local_projection = lambda response: [
        (item.entity_id, item.score, item.business_score, item.match_reason) for item in response.items
    ]
    assert local_projection(failed) == local_projection(disabled)
    assert failed.degraded is True
    assert failed.degradation_code == "search_rerank_unavailable"


def test_search_diagnostics_exclude_query_and_business_identifiers(monkeypatch, caplog) -> None:
    SessionLocal = _seed_title_and_semantic_candidates()
    monkeypatch.setattr(hybrid_module, "get_settings", lambda: search_settings())
    with SessionLocal() as db, caplog.at_level("INFO", logger="app.services.search.hybrid"):
        hybrid_search(
            db, family_id="family-secret", user_id="user-secret", query="私密鸡肉", scopes=["ingredient"],
            limit=10, offset=0, embedding_client=FakeEmbeddingClient(), vector_store=FakeVectorStore([]),
            rerank_client=DisabledFakeRerankClient(),
        )

    diagnostics = [record.search_diagnostics for record in caplog.records if hasattr(record, "search_diagnostics")]
    assert len(diagnostics) == 1
    assert set(diagnostics[0]) == {
        "query_profile", "keyword_candidate_count", "semantic_candidate_count", "dual_source_count",
        "level_0_count", "level_1_count", "level_2_count", "level_3_count", "level_4_count",
        "local_ranking_duration_ms", "rerank_used", "degradation_code",
    }
    assert "私密鸡肉" not in caplog.text
    assert "family-secret" not in caplog.text
    assert "user-secret" not in caplog.text
```

Add this complete fixture helper in the same file:

```python
def _seed_title_and_semantic_candidates():
    SessionLocal = session_factory()
    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        title = Ingredient(
            id="ingredient-title",
            family_id=family.id,
            name="冷冻鸡肉块",
            category="肉类",
            default_unit="克",
            unit_conversions=[],
            default_storage="冷冻",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        semantic = Ingredient(
            id="ingredient-semantic",
            family_id=family.id,
            name="三黄鸡",
            category="禽肉",
            default_unit="只",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
        )
        db.add_all([family, title, semantic])
        db.flush()
        for ingredient in (title, semantic):
            upsert_search_document(db, SearchDocumentPayload(
                family_id=family.id,
                entity_type="ingredient",
                entity_id=ingredient.id,
                title_text=ingredient.name,
                keyword_text=f"{ingredient.name} {ingredient.category}",
                detail_text="",
                semantic_text=f"食材：{ingredient.name}",
                metadata_json={"name": ingredient.name, "category": ingredient.category},
                content_hash=f"hash-{ingredient.id}",
            ))
        db.commit()
    return SessionLocal
```

- [ ] **Step 4: Run the targeted integration tests and verify failures**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_hybrid_ranking_features.py tests/search/test_hybrid_search.py -q
```

Expected: FAIL because `_merge_hits` still calls the deleted `score_search_candidate`, vector groups sort by independent ranks, `_sort_with_rerank` returns three values, and no diagnostics are emitted.

- [ ] **Step 5: Refactor hybrid types/imports and add diagnostics data**

In `backend/app/services/search/hybrid.py`:

```python
import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from time import perf_counter

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import SearchQueryProfile, analyze_search_query
from app.services.search.ranking_features import SearchRankingCandidate, build_ranking_candidate
from app.services.search.keyword_store import KeywordMatchMode
from app.services.search.scoring import SearchBusinessSignals, business_score_candidates

logger = logging.getLogger(__name__)
```

Delete `DEFAULT_RERANK_SEMANTIC_MIN_SCORE`. In `backend/app/core/config.py`, directly replace `search_rerank_semantic_min_score: float = 0.48` with `search_semantic_min_score: float = 0.48` so this integration commit never depends on a compatibility read. Task 8 adds the explicit range validator and deployment wiring. Keep the existing rerank constants and `HybridSearchResult` internal fields because `literal_score` remains the configured rerank literal bucket evidence.

Add:

```python
@dataclass(frozen=True)
class HybridSearchDiagnostics:
    query_profile: str
    keyword_candidate_count: int
    semantic_candidate_count: int
    dual_source_count: int
    level_0_count: int
    level_1_count: int
    level_2_count: int
    level_3_count: int
    level_4_count: int
    local_ranking_duration_ms: float

    def as_log_fields(self, *, rerank_used: bool, degradation_code: str | None) -> dict[str, object]:
        return {
            "query_profile": self.query_profile,
            "keyword_candidate_count": self.keyword_candidate_count,
            "semantic_candidate_count": self.semantic_candidate_count,
            "dual_source_count": self.dual_source_count,
            "level_0_count": self.level_0_count,
            "level_1_count": self.level_1_count,
            "level_2_count": self.level_2_count,
            "level_3_count": self.level_3_count,
            "level_4_count": self.level_4_count,
            "local_ranking_duration_ms": round(self.local_ranking_duration_ms, 3),
            "rerank_used": rerank_used,
            "degradation_code": degradation_code,
        }
```

- [ ] **Step 6: Rebuild semantic ranks globally by score**

Replace `_search_vectors` with:

```python
def _normalized_semantic_sort_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    score = float(value)
    return score if math.isfinite(score) else 0.0


def _with_global_semantic_ranks(hits: list[VectorSearchHit], *, limit: int) -> list[VectorSearchHit]:
    ordered = sorted(
        hits,
        key=lambda item: (
            -_normalized_semantic_sort_score(item.semantic_score),
            item.semantic_rank,
            item.entity_type,
            item.entity_id,
        ),
    )[:limit]
    return [
        VectorSearchHit(hit.entity_type, hit.entity_id, hit.semantic_score, rank)
        for rank, hit in enumerate(ordered, start=1)
    ]


def _search_vectors(
    *,
    vector_store: VectorStore,
    family_id: str,
    user_id: str | None,
    scopes: list[str],
    vector: list[float],
    limit: int,
) -> list[VectorSearchHit]:
    if not user_id or "meal_plan" not in scopes:
        return _with_global_semantic_ranks(
            vector_store.search(family_id=family_id, scopes=scopes, vector=vector, limit=limit),
            limit=limit,
        )
    hits: list[VectorSearchHit] = []
    other_scopes = [scope for scope in scopes if scope != "meal_plan"]
    if other_scopes:
        hits.extend(vector_store.search(
            family_id=family_id, scopes=other_scopes, vector=vector, limit=limit, user_id=None,
        ))
    hits.extend(vector_store.search(
        family_id=family_id, scopes=["meal_plan"], vector=vector, limit=limit, user_id=user_id,
    ))
    return _with_global_semantic_ranks(hits, limit=limit)
```

- [ ] **Step 7: Replace `_merge_hits` with feature construction and the unique local ranker**

Rename the function to `_merge_and_rank_hits`, remove all calls to `score_search_candidate` and `_literal_fallback_score`, and use this complete merge core. Existing `_load_candidate_documents`, `_load_existing_business_keys`, and `_load_business_signals` stay unchanged:

```python
def _merge_and_rank_hits(
    db: Session,
    *,
    family_id: str,
    user_id: str | None,
    profile: SearchQueryProfile,
    exact_name_hits: list[KeywordSearchHit],
    keyword_hits: list[KeywordSearchHit],
    semantic_hits: list[VectorSearchHit],
    semantic_min_score: float,
) -> tuple[list[HybridSearchResult], dict[tuple[str, str], SearchDocument], HybridSearchDiagnostics]:
    exact_by_key = {(hit.entity_type, hit.entity_id): hit for hit in exact_name_hits}
    keyword_by_key = {(hit.entity_type, hit.entity_id): hit for hit in keyword_hits}
    keyword_rank_by_key = {
        (hit.entity_type, hit.entity_id): rank for rank, hit in enumerate(keyword_hits, start=1)
    }
    exact_rank_by_key = {
        (hit.entity_type, hit.entity_id): rank for rank, hit in enumerate(exact_name_hits, start=1)
    }
    semantic_by_key: dict[tuple[str, str], VectorSearchHit] = {}
    for hit in semantic_hits:
        key = (hit.entity_type, hit.entity_id)
        existing = semantic_by_key.get(key)
        if existing is None or (
            _normalized_semantic_sort_score(hit.semantic_score), -hit.semantic_rank
        ) > (
            _normalized_semantic_sort_score(existing.semantic_score), -existing.semantic_rank
        ):
            semantic_by_key[key] = hit
    keys = set(exact_by_key) | set(keyword_by_key)
    keys.update(
        key for key, hit in semantic_by_key.items()
        if key in exact_by_key
        or key in keyword_by_key
        or _normalized_semantic_sort_score(hit.semantic_score) >= semantic_min_score
    )
    documents_by_key = _load_candidate_documents(db, family_id=family_id, keys=sorted(keys))
    keys = {key for key in keys if key in documents_by_key or key in exact_by_key}
    existing_keys = _load_existing_business_keys(
        db, family_id=family_id, user_id=user_id, keys=sorted(keys),
    )
    keys &= existing_keys
    business_signals = _load_business_signals(
        db, family_id=family_id, user_id=user_id, keys=sorted(keys),
    )
    def combined_keyword_hit(key: tuple[str, str]) -> KeywordSearchHit | None:
        hits = [hit for hit in (keyword_by_key.get(key), exact_by_key.get(key)) if hit is not None]
        if not hits:
            return None
        field_order = ("title_text", "keyword_text", "detail_text")
        mode_order = (
            KeywordMatchMode.MYSQL_FULLTEXT,
            KeywordMatchMode.SUBSTRING,
            KeywordMatchMode.SAFE_COMPACT,
        )
        return KeywordSearchHit(
            entity_type=key[0],
            entity_id=key[1],
            keyword_score=max(hit.keyword_score for hit in hits),
            matched_fields=tuple(field for field in field_order if any(field in hit.matched_fields for hit in hits)),
            match_modes=tuple(mode for mode in mode_order if any(mode in hit.match_modes for hit in hits)),
        )
    candidates: list[SearchRankingCandidate] = []
    for key in sorted(keys):
        document = documents_by_key.get(key)
        keyword_hit = combined_keyword_hit(key)
        semantic_hit = semantic_by_key.get(key)
        reasons = business_score_candidates(
            entity_type=key[0],
            profile=profile,
            metadata=(document.metadata_json if document is not None else {}) or {},
            signals=business_signals.get(key),
        )
        candidates.append(build_ranking_candidate(
            profile=profile,
            entity_type=key[0],
            entity_id=key[1],
            document=document,
            exact_name_match=key in exact_by_key,
            keyword_hit=keyword_hit,
            keyword_rank=keyword_rank_by_key.get(key, exact_rank_by_key.get(key)),
            semantic_score=semantic_hit.semantic_score if semantic_hit is not None else 0.0,
            semantic_rank=semantic_hit.semantic_rank if semantic_hit is not None else None,
            business_reasons=reasons,
        ))
    ranking_started_at = perf_counter()
    ranked = rank_local_candidates(profile, candidates)
    ranking_duration_ms = (perf_counter() - ranking_started_at) * 1000
    level_counts = Counter(score.confidence_level for _candidate, score in ranked)
    results = [
        HybridSearchResult(
            entity_type=candidate.entity_type,
            entity_id=candidate.entity_id,
            score=score.final_score,
            keyword_score=candidate.keyword_score,
            semantic_score=candidate.semantic_score,
            business_score=candidate.signed_business_score,
            exact_name_match=candidate.literal_match.value == "exact_name",
            local_score=score.final_score,
            literal_score=candidate.literal_confidence,
            literal_reason=candidate.positive_reasons[0] if candidate.literal_confidence > 0 and candidate.positive_reasons else "",
            match_reason=list(candidate.positive_reasons),
        )
        for candidate, score in ranked
    ]
    diagnostics = HybridSearchDiagnostics(
        query_profile=profile.kind.value,
        keyword_candidate_count=len(keyword_hits),
        semantic_candidate_count=len(semantic_hits),
        dual_source_count=sum(candidate.dual_source_match for candidate in candidates),
        level_0_count=level_counts[SearchConfidenceLevel.EXACT],
        level_1_count=level_counts[SearchConfidenceLevel.TITLE],
        level_2_count=level_counts[SearchConfidenceLevel.STRONG],
        level_3_count=level_counts[SearchConfidenceLevel.RELEVANT],
        level_4_count=level_counts[SearchConfidenceLevel.WEAK],
        local_ranking_duration_ms=ranking_duration_ms,
    )
    return results, documents_by_key, diagnostics
```

- [ ] **Step 8: Make rerank return whether a provider request was actually sent**

Change `_sort_with_rerank` return type to `tuple[list[HybridSearchResult], bool, str | None, bool]` and apply these exact return rules:

```python
local_sorted = list(results)
if rerank_client is None or not rerank_client.enabled or not local_sorted:
    return _local_rerank_fallback(local_sorted), False, None, False

# If no non-exact document can be sent:
return local_sorted, False, None, False

# Immediately before rerank_client.rerank(...), provider dispatch is considered used.
try:
    rerank_results = rerank_client.rerank(
        query=query,
        documents=rerank_documents,
        top_n=len(rerank_documents),
        attribution=rerank_attribution,
        attempt_key=rerank_attempt_key,
    )
except ModelUsageError as exc:
    return _local_rerank_fallback(local_sorted), True, exc.code, True
except RerankUnavailableError as exc:
    return _local_rerank_fallback(local_sorted), True, exc.code, True
```

For successful rerank, keep exact candidates at `item.score = item.local_score`, keep provider matches at `2.0 + rerank_score`, keep literal fallback at `1.0 + item.literal_score`, retain `-item.local_score` as the within-bucket tie-break, and return `(sorted_results, False, None, True)`. Do not send a second request on any failure.

- [ ] **Step 9: Rewire `hybrid_search` and emit privacy-safe diagnostics**

At the start of `hybrid_search`, use:

```python
response_query = query.strip()
profile = analyze_search_query(response_query)
if not profile.compact_text:
    return HybridSearchResponse(items=[], total=0, query=response_query, degraded=False)
recall_query = profile.normalized_text
```

Pass `recall_query` to exact-name, keyword, embedding and rerank calls. Replace the old `_merge_hits` call with:

```python
local_results, documents_by_key, diagnostics = _merge_and_rank_hits(
    db,
    family_id=family_id,
    user_id=user_id,
    profile=profile,
    exact_name_hits=exact_name_hits,
    keyword_hits=keyword_hits,
    semantic_hits=semantic_hits,
    semantic_min_score=settings.search_semantic_min_score,
)
merged, rerank_degraded, rerank_degradation_code, rerank_used = _sort_with_rerank(
    query=recall_query,
    results=local_results,
    documents_by_key=documents_by_key,
    rerank_client=rerank_client,
    rerank_min_score=settings.search_rerank_min_score or DEFAULT_RERANK_MIN_SCORE,
    literal_fallback_min_score=settings.search_literal_fallback_min_score or DEFAULT_LITERAL_FALLBACK_MIN_SCORE,
    rerank_candidate_limit=settings.search_rerank_candidate_limit or DEFAULT_RERANK_CANDIDATE_LIMIT,
    rerank_attribution=rerank_attribution,
    rerank_attempt_key=f"{search_request_id}:rerank" if search_request_id is not None else None,
)
```

After combining embedding/vector and rerank degradation codes, log only:

```python
logger.info(
    "Hybrid search local ranking completed",
    extra={
        "search_diagnostics": diagnostics.as_log_fields(
            rerank_used=rerank_used,
            degradation_code=degradation_code,
        )
    },
)
```

Return `query=response_query`, page only after `_sort_with_rerank`, and keep `search_mode="hybrid"` whenever hybrid is enabled even if rerank is disabled.

- [ ] **Step 10: Delete the old local ranking functions from `hybrid.py`**

Delete these functions entirely after all call sites use Tasks 5-6:

```text
_literal_fallback_score
_best_literal_score
_literal_keyword_values
_metadata_strings
_normalize_literal_text
_compact_literal_text
_is_single_cjk_query
```

Also remove the import of `score_search_candidate`. Retain `_rerank_document_texts`, all current family/user-scoped entity loaders, and all current business-signal DB loaders.

- [ ] **Step 11: Run the complete search suite**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
```

Expected: PASS. Confirm specifically that rerank disabled produces no `FakeRerankClient.documents`, rerank failures retain all local candidates, embedding/vector degradation still returns keyword candidates, exact business-table hits survive missing search documents, and Qdrant residual points are filtered.

- [ ] **Step 12: Commit hybrid integration**

```bash
git add backend/app/services/search/hybrid.py backend/app/core/config.py backend/tests/search/_support.py backend/tests/search/test_hybrid_ranking_features.py backend/tests/search/test_hybrid_search.py
git commit -m "feat(search): integrate local fusion with rerank fallback"
```

---

### Task 8: Directly replace the semantic threshold configuration

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/.env.example`
- Modify: `deploy/.env.example`
- Modify: `deploy/docker-compose.yml`
- Modify: `backend/tests/core/test_search_config.py`
- Modify: `backend/tests/search/_support.py`
- Verify only: the operator-managed current deployment environment; do not print secrets or commit local `.env` files.

**Interfaces:**
- Consumes: `settings.search_semantic_min_score` used by Task 7.
- Produces: only `SEARCH_SEMANTIC_MIN_SCORE`; the old environment name is intentionally rejected/ignored by normal Pydantic extra-field behavior and is not read as fallback.

- [ ] **Step 1: Write failing configuration default and range tests**

In `backend/tests/core/test_search_config.py`, replace the old assertion and add:

```python
def test_search_semantic_threshold_defaults_to_local_candidate_floor() -> None:
    settings = Settings(_env_file=None)

    assert settings.search_semantic_min_score == 0.48
    assert not hasattr(settings, "search_rerank_semantic_min_score")


@pytest.mark.parametrize("value", [-0.01, 1.0, 1.01])
def test_search_semantic_threshold_rejects_values_outside_half_open_unit_interval(value: float) -> None:
    with pytest.raises(ValidationError, match=r"SEARCH_SEMANTIC_MIN_SCORE must be in \[0, 1\)"):
        Settings(_env_file=None, search_semantic_min_score=value)
```

- [ ] **Step 2: Run configuration tests and verify failure**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/core/test_search_config.py -q
```

Expected: FAIL for the three invalid values because the field exists from Task 7 but explicit `[0, 1)` validation is not yet present.

- [ ] **Step 3: Replace the setting and add exact validation**

Confirm Task 7 already defines `search_semantic_min_score: float = 0.48` and no old field. Inside `validate_safe_runtime_settings`, before provider-specific validation, add:

```python
if not 0 <= self.search_semantic_min_score < 1:
    raise ValueError("SEARCH_SEMANTIC_MIN_SCORE must be in [0, 1)")
```

Do not add an alias, deprecated field, environment fallback, compatibility warning or local-ranker version switch.

- [ ] **Step 4: Replace environment variable names in all committed deployment examples**

Make these exact replacements:

```dotenv
# backend/.env.example and deploy/.env.example
SEARCH_SEMANTIC_MIN_SCORE=0.48
```

```yaml
# deploy/docker-compose.yml backend environment
SEARCH_SEMANTIC_MIN_SCORE: ${SEARCH_SEMANTIC_MIN_SCORE:-0.48}
```

Retain `SEARCH_RERANK_MIN_SCORE`, `SEARCH_LITERAL_FALLBACK_MIN_SCORE`, `SEARCH_RERANK_CANDIDATE_LIMIT` and every rerank provider setting unchanged.

- [ ] **Step 5: Update search test settings and prove the old name is gone**

In `backend/tests/search/_support.py`, keep:

```python
"search_semantic_min_score": 0.48,
```

Run:

```bash
rg -n "SEARCH_RERANK_SEMANTIC_MIN_SCORE|search_rerank_semantic_min_score" backend deploy
```

Expected: no matches. If an operator-managed uncommitted `.env` uses the old name, report its path without showing its value and replace only after confirming it is the active Culina deployment configuration in scope.

- [ ] **Step 6: Run configuration and search tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/core/test_search_config.py tests/search -q
```

Expected: PASS.

- [ ] **Step 7: Commit the direct configuration replacement**

```bash
git add backend/app/core/config.py backend/.env.example deploy/.env.example deploy/docker-compose.yml backend/tests/core/test_search_config.py backend/tests/search/_support.py
git commit -m "refactor(search): rename semantic candidate threshold"
```

---

### Task 9: Lock API, list-order and AI candidate contracts

**Files:**
- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/tests/search/test_search_api.py`
- Modify: `backend/tests/search/test_inventory_search.py`
- Modify: `backend/tests/ai_infra/test_tool_registry.py`
- Verify only: `backend/app/schemas/search.py`, `backend/app/api/ingredients.py`, `backend/app/api/foods.py`, `backend/app/api/recipes.py`, and search tool catalogs.

**Interfaces:**
- Consumes: unchanged `HybridSearchResponse`/`HybridSearchResult` fields.
- Produces: API and AI consumers that preserve the ranked ID order, accept negative `business_score`, never render negative reasons, and never auto-bind candidates based on a score threshold.

- [ ] **Step 1: Add an API contract test for the new score ranges and negative business score**

Add imports and this test to `backend/tests/search/test_search_api.py`:

```python
from app.services.search.hybrid import HybridSearchResponse, HybridSearchResult


def test_search_api_accepts_local_score_band_and_negative_business_score(monkeypatch) -> None:
    client, _SessionLocal = _search_test_client()
    from app.api import search as search_api

    monkeypatch.setattr(
        search_api,
        "hybrid_search",
        lambda *_args, **_kwargs: HybridSearchResponse(
            items=[HybridSearchResult(
                entity_type="ingredient",
                entity_id="ingredient-tomato",
                score=4.75,
                keyword_score=1.0,
                semantic_score=0.80,
                business_score=-0.56,
                match_reason=["名称匹配", "语意接近：番茄"],
            )],
            total=1,
            query="番茄",
            search_mode="hybrid",
            degraded=False,
        ),
    )
    try:
        response = client.get("/api/search", params={"q": "番茄", "scopes": "ingredients"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["score"] == 4.75
    assert item["business_score"] == -0.56
    assert item["match_reason"] == ["名称匹配", "语意接近：番茄"]
    assert "最近刚吃过" not in item["match_reason"]
    assert "库存不足" not in item["match_reason"]
```

- [ ] **Step 2: Add a meal-plan list test that exposes lost ranking order**

Extend `_search_test_client()` with this second current-user plan and include it in the existing `db.add_all(...)` call:

```python
later_plan = FoodPlanItem(
    id="plan-own-later",
    family_id=family.id,
    user_id=user.id,
    food_id=food.id,
    food=food,
    plan_date=date(2026, 6, 30),
    meal_type=MealType.DINNER,
    note="稍后晚餐安排",
    status="planned",
)
```

Then add:

```python
def test_food_plan_query_preserves_hybrid_ranking_order(monkeypatch) -> None:
    client, _SessionLocal = _search_test_client()
    from app.api import recipe_meta

    monkeypatch.setattr(
        recipe_meta,
        "hybrid_search",
        lambda *_args, **_kwargs: HybridSearchResponse(
            items=[
                HybridSearchResult("meal_plan", "plan-own-later", 3.8),
                HybridSearchResult("meal_plan", "plan-own", 2.7),
            ],
            total=2,
            query="晚餐",
        ),
    )
    try:
        response = client.get(
            "/api/food-plan",
            params={"date_from": "2026-06-28", "date_to": "2026-06-30", "q": "晚餐"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == ["plan-own-later", "plan-own"]
```

- [ ] **Step 3: Run the two API tests and confirm only meal-plan ordering fails**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_search_api.py -q
```

Expected: negative-score contract PASS; meal-plan order FAIL because `list_food_plan` converts ranked IDs to a set and returns date order.

- [ ] **Step 4: Preserve hybrid order when reloading meal plans**

In `backend/app/api/recipe_meta.py`, replace `matching_ids: set[str] | None` with:

```python
matching_ids: list[str] | None = None
rank_by_id: dict[str, int] = {}
```

After `hybrid_search`, populate:

```python
matching_ids = [item.entity_id for item in search_result.items if item.entity_type == "meal_plan"]
rank_by_id = {item_id: index for index, item_id in enumerate(matching_ids)}
```

Keep the existing `family_id + user_id + date range` SQL filters. After loading the date-ordered items and before serializing, apply:

```python
if matching_ids is not None:
    items.sort(key=lambda item: rank_by_id.get(item.id, len(rank_by_id)))
```

This stable sort keeps current date/meal/created order only as a tie-break and never allows another user's plan into the result.

- [ ] **Step 5: Strengthen list and inventory order assertions**

In `backend/tests/search/test_inventory_search.py`, change `_FakeHybridSearch` to return the already-seeded egg before tomato:

```python
HybridSearchResponse(
    items=[
        HybridSearchResult("ingredient", "ingredient-egg", 3.8),
        HybridSearchResult("ingredient", "ingredient-tomato", 2.7),
    ],
    total=2,
    query="排序",
    degraded=False,
)
```

After calling `/api/inventory?q=排序`, assert:

```python
self.assertEqual([item["id"] for item in response.json()], ["inventory-egg", "inventory-tomato"])
```

In `backend/tests/search/test_search_api.py`, add this complete test for the ordinary ingredient list:

```python
def test_ingredient_list_query_preserves_hybrid_order(monkeypatch) -> None:
    client, SessionLocal = _search_test_client()
    with SessionLocal() as db:
        db.add_all([
            Ingredient(
                id="ingredient-first", family_id="family-1", name="排序一", category="测试",
                default_unit="个", default_storage="冷藏",
            ),
            Ingredient(
                id="ingredient-second", family_id="family-1", name="排序二", category="测试",
                default_unit="个", default_storage="冷藏",
            ),
        ])
        db.commit()
    from app.api import ingredients as ingredients_api
    monkeypatch.setattr(
        ingredients_api,
        "hybrid_search",
        lambda *_args, **_kwargs: HybridSearchResponse(
            items=[
                HybridSearchResult("ingredient", "ingredient-second", 3.8),
                HybridSearchResult("ingredient", "ingredient-first", 2.7),
            ],
            total=2,
            query="排序",
            degraded=False,
        ),
    )
    try:
        response = client.get("/api/ingredients", params={"q": "排序", "limit": 10})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == ["ingredient-second", "ingredient-first"]
```

- [ ] **Step 6: Prove AI search tools preserve order and high score never auto-resolves ambiguity**

In `backend/tests/ai_infra/test_tool_registry.py`, update `test_batch_resolution_keeps_semantic_matches_as_candidates` so each fake item also has `score=4.999999`, `keyword_score=1.0`, `semantic_score=1.0`, `business_score=1.0`, and `match_reason=["名称匹配"]`. Keep these assertions:

```python
self.assertEqual(output["results"][0]["status"], "candidate")
self.assertEqual(output["results"][1]["status"], "ambiguous")
```

Add a separate order test by patching `app.ai.tools.catalog.ingredient.hybrid_search` to return two current-family ingredients in a deliberate order and assert `ingredient.search` returns exactly that ID order and serializes `businessScore=-0.4` without negative reason labels. The fake `HybridSearchResult` values must be:

```python
[
    HybridSearchResult("ingredient", second.id, 3.8, business_score=-0.4, match_reason=["名称匹配"]),
    HybridSearchResult("ingredient", first.id, 2.7, business_score=0.2, match_reason=["关键词匹配"]),
]
```

The existing food, recipe, and meal-plan catalog functions already rebuild ORM rows from `search_ids` in order; add parallel ID-order assertions to the existing `test_catalog_search_tools_use_hybrid_search_documents_for_query` rather than changing their output schemas.

- [ ] **Step 7: Run search API/list and AI tool tests**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_search_api.py tests/search/test_inventory_search.py tests/ai_infra/test_tool_registry.py -q
```

Expected: PASS. Verify no test asserts score thresholds for entity binding.

- [ ] **Step 8: Commit consumer contract changes**

```bash
git add backend/app/api/recipe_meta.py backend/tests/search/test_search_api.py backend/tests/search/test_inventory_search.py backend/tests/ai_infra/test_tool_registry.py
git commit -m "test(search): lock ranked consumer contracts"
```

---

### Task 10: Turn the 80 synthetic cases into quality gates and add a performance report

**Files:**
- Create: `backend/tests/search/ranking_quality.py`
- Modify: `backend/tests/search/test_local_ranking_quality.py`
- Create: `backend/tests/search/test_local_ranking_performance.py`
- Create: `backend/scripts/run_search_ranking_quality.py`
- Delete: `backend/scripts/capture_legacy_search_baseline.py`

**Interfaces:**
- Consumes: the immutable fixtures from Task 1 and the public local-ranking interfaces from Tasks 2, 5 and 6.
- Produces: deterministic MRR@10, nDCG@10, Recall@20, direct-hit Top-1, L4-in-Top-5 and repeatability metrics plus a non-gating p95 performance report.

- [ ] **Step 1: Add a reusable offline evaluator**

Create `backend/tests/search/ranking_quality.py`:

```python
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from app.services.search.local_ranking import SearchConfidenceLevel, rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate

FIXTURE_DIR = Path(__file__).parent / "fixtures"


@dataclass(frozen=True)
class RankingQualityMetrics:
    case_count: int
    direct_hit_top1: float
    mrr_at_10: float
    ndcg_at_10: float
    l4_top5_violations: int
    recall_at_20: float
    deterministic_rate: float

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


def load_quality_cases() -> list[dict[str, object]]:
    return json.loads((FIXTURE_DIR / "local_ranking_quality_cases.json").read_text(encoding="utf-8"))


def load_baseline() -> dict[str, object]:
    return json.loads((FIXTURE_DIR / "local_ranking_baseline.json").read_text(encoding="utf-8"))


def candidate_from_payload(payload: dict[str, object]) -> SearchRankingCandidate:
    return SearchRankingCandidate(
        entity_type=str(payload["entity_type"]),
        entity_id=str(payload["entity_id"]),
        keyword_score=float(payload["keyword_score"]),
        semantic_score=float(payload["semantic_score"]),
        keyword_rank=int(payload["keyword_rank"]) if payload["keyword_rank"] is not None else None,
        semantic_rank=int(payload["semantic_rank"]) if payload["semantic_rank"] is not None else None,
        literal_match=LiteralMatchKind(str(payload["literal_match"])),
        literal_confidence=float(payload["literal_confidence"]),
        trusted_keyword_match=bool(payload["trusted_keyword_match"]),
        detail_only_match=bool(payload["detail_only_match"]),
        dual_source_match=bool(payload["dual_source_match"]),
        signed_business_score=float(payload["signed_business_score"]),
        positive_reasons=tuple(str(reason) for reason in payload["positive_reasons"]),
    )


def _dcg(grades: list[int]) -> float:
    return sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))


def evaluate_quality_cases(cases: list[dict[str, object]]) -> RankingQualityMetrics:
    direct_total = 0
    direct_top1 = 0
    reciprocal_ranks: list[float] = []
    ndcgs: list[float] = []
    l4_top5_violations = 0
    relevant_total = 0
    relevant_recovered = 0
    deterministic = 0
    for case in cases:
        raw_candidates = list(case["candidates"])
        relevance_by_id = {str(item["entity_id"]): int(item["relevance"]) for item in raw_candidates}
        candidates = [candidate_from_payload(item) for item in raw_candidates]
        profile = analyze_search_query(str(case["query"]))
        ranked = rank_local_candidates(profile, candidates)
        ranked_ids = [candidate.entity_id for candidate, _score in ranked]
        repeated_ids = [
            candidate.entity_id
            for candidate, _score in rank_local_candidates(profile, list(reversed(candidates)))
        ]
        deterministic += int(ranked_ids == repeated_ids)
        if case["category"] == "literal":
            direct_total += 1
            direct_top1 += int(bool(ranked_ids) and relevance_by_id[ranked_ids[0]] == 3)
        first_best = next(
            (index for index, entity_id in enumerate(ranked_ids[:10], start=1) if relevance_by_id[entity_id] == 3),
            None,
        )
        reciprocal_ranks.append(0.0 if first_best is None else 1.0 / first_best)
        actual_grades = [relevance_by_id[entity_id] for entity_id in ranked_ids[:10]]
        ideal_grades = sorted(relevance_by_id.values(), reverse=True)[:10]
        ideal_dcg = _dcg(ideal_grades)
        ndcgs.append(_dcg(actual_grades) / ideal_dcg if ideal_dcg else 1.0)
        has_high_confidence = any(
            score.confidence_level <= SearchConfidenceLevel.STRONG for _candidate, score in ranked
        )
        if has_high_confidence:
            l4_top5_violations += sum(
                score.confidence_level is SearchConfidenceLevel.WEAK for _candidate, score in ranked[:5]
            )
        relevant_ids = {entity_id for entity_id, grade in relevance_by_id.items() if grade > 0}
        relevant_total += len(relevant_ids)
        relevant_recovered += len(relevant_ids & set(ranked_ids[:20]))
    return RankingQualityMetrics(
        case_count=len(cases),
        direct_hit_top1=direct_top1 / direct_total,
        mrr_at_10=sum(reciprocal_ranks) / len(reciprocal_ranks),
        ndcg_at_10=sum(ndcgs) / len(ndcgs),
        l4_top5_violations=l4_top5_violations,
        recall_at_20=relevant_recovered / relevant_total,
        deterministic_rate=deterministic / len(cases),
    )
```

- [ ] **Step 2: Add exact quality thresholds to the existing fixture test file**

Append to `backend/tests/search/test_local_ranking_quality.py`:

```python
from tests.search.ranking_quality import evaluate_quality_cases, load_baseline, load_quality_cases


def test_local_ranking_meets_offline_quality_gates() -> None:
    metrics = evaluate_quality_cases(load_quality_cases())
    baseline = load_baseline()

    assert metrics.case_count == 80
    assert metrics.direct_hit_top1 == 1.0
    assert metrics.mrr_at_10 >= 0.90
    assert metrics.ndcg_at_10 >= 0.85
    assert metrics.l4_top5_violations == 0
    assert metrics.recall_at_20 >= float(baseline["recall_at_20"])
    assert metrics.deterministic_rate == 1.0
```

- [ ] **Step 3: Run the quality gate and tune only documented constants if it fails**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking_quality.py -q
```

Expected: PASS with 80 cases. If it fails, inspect the failing case IDs by temporarily printing only synthetic IDs; corrections must remain within the confirmed `0.48/0.60/0.74/0.82`, query-type weights, literal confidences and 5% business cap. Do not add entity-specific quotas or a second local algorithm.

- [ ] **Step 4: Add a human-readable quality report command**

Create `backend/scripts/run_search_ranking_quality.py`:

```python
from __future__ import annotations

import json

from tests.search.ranking_quality import evaluate_quality_cases, load_baseline, load_quality_cases


def main() -> None:
    metrics = evaluate_quality_cases(load_quality_cases())
    baseline = load_baseline()
    report = {**metrics.to_dict(), "baseline_recall_at_20": baseline["recall_at_20"]}
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    failures = []
    if metrics.direct_hit_top1 != 1.0:
        failures.append("direct_hit_top1")
    if metrics.mrr_at_10 < 0.90:
        failures.append("mrr_at_10")
    if metrics.ndcg_at_10 < 0.85:
        failures.append("ndcg_at_10")
    if metrics.l4_top5_violations != 0:
        failures.append("l4_top5_violations")
    if metrics.recall_at_20 < float(baseline["recall_at_20"]):
        failures.append("recall_at_20")
    if metrics.deterministic_rate != 1.0:
        failures.append("deterministic_rate")
    if failures:
        raise SystemExit("quality gates failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()
```

Run:

```bash
cd backend && .venv/bin/python scripts/run_search_ranking_quality.py
```

Expected: exit code 0 and a JSON report meeting all six gates.

- [ ] **Step 5: Add a deterministic 160-candidate performance reference**

Create `backend/tests/search/test_local_ranking_performance.py`:

```python
from __future__ import annotations

import json
import time

from app.services.search.local_ranking import rank_local_candidates
from app.services.search.query_analysis import analyze_search_query
from app.services.search.ranking_features import LiteralMatchKind, SearchRankingCandidate


def _performance_candidates() -> list[SearchRankingCandidate]:
    candidates: list[SearchRankingCandidate] = []
    literal_cycle = (
        LiteralMatchKind.TITLE_CONTAINS,
        LiteralMatchKind.STRUCTURED_KEYWORD,
        LiteralMatchKind.COMPACT_KEYWORD,
        LiteralMatchKind.NONE,
        LiteralMatchKind.DETAIL,
    )
    for index in range(160):
        literal = literal_cycle[index % len(literal_cycle)]
        trusted = literal not in {LiteralMatchKind.NONE, LiteralMatchKind.DETAIL}
        semantic = 0.48 + (index % 53) / 100
        candidates.append(SearchRankingCandidate(
            entity_type=("ingredient", "food", "recipe", "meal_plan")[index % 4],
            entity_id=f"perf-{index:03d}",
            keyword_score=(index % 11) / 10,
            semantic_score=min(semantic, 1.0),
            keyword_rank=index + 1 if trusted else None,
            semantic_rank=160 - index,
            literal_match=literal,
            literal_confidence={
                LiteralMatchKind.TITLE_CONTAINS: 0.90,
                LiteralMatchKind.STRUCTURED_KEYWORD: 0.80,
                LiteralMatchKind.COMPACT_KEYWORD: 0.70,
                LiteralMatchKind.NONE: 0.0,
                LiteralMatchKind.DETAIL: 0.35,
            }[literal],
            trusted_keyword_match=trusted,
            detail_only_match=literal is LiteralMatchKind.DETAIL,
            dual_source_match=trusted and semantic >= 0.48,
            signed_business_score=((index % 21) - 10) / 10,
            positive_reasons=(),
        ))
    return candidates


def test_local_ranking_160_candidate_performance_reference() -> None:
    profile = analyze_search_query("鸡肉 快手")
    candidates = _performance_candidates()
    durations_ms: list[float] = []
    expected_order = None
    for _run in range(200):
        started = time.perf_counter()
        ranked = rank_local_candidates(profile, candidates)
        durations_ms.append((time.perf_counter() - started) * 1000)
        order = [candidate.entity_id for candidate, _score in ranked]
        expected_order = order if expected_order is None else expected_order
        assert order == expected_order
    ordered = sorted(durations_ms)
    p95 = ordered[int(len(ordered) * 0.95) - 1]
    report = {"candidate_count": 160, "runs": 200, "p95_ms": round(p95, 3)}
    print("local_ranking_performance=" + json.dumps(report, sort_keys=True))
    assert report["candidate_count"] == 160
    assert report["runs"] == 200
    assert p95 > 0
```

This test checks deterministic execution and emits the p95 report but intentionally does not fail on the `20ms` wall-time target, because shared CI hardware is noisy.

- [ ] **Step 6: Run and inspect the performance report**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking_performance.py -q -s
```

Expected: PASS and `candidate_count=160`, `runs=200`, with local-machine `p95_ms <= 20`. If the observed local p95 exceeds 20ms in three consecutive runs, profile `rank_local_candidates` before completion and remove avoidable per-candidate repeated work without weakening the quality gates.

- [ ] **Step 7: Delete the temporary legacy formula capture script and prove no old formula remains**

Delete `backend/scripts/capture_legacy_search_baseline.py`. Then run:

```bash
rg -n "KEYWORD_WEIGHT|SEMANTIC_WEIGHT|score_search_candidate|legacy_score|0\.45.*0\.50|search_rerank_semantic_min_score" backend deploy
```

Expected: no matches. The committed baseline JSON and synthetic case IDs remain; no executable old local-ranking path remains.

- [ ] **Step 8: Run the search suite and commit quality tooling**

Run:

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
```

Expected: PASS.

Commit:

```bash
git add backend/scripts/build_search_quality_fixture.py backend/scripts/run_search_ranking_quality.py backend/tests/search/ranking_quality.py backend/tests/search/test_local_ranking_quality.py backend/tests/search/test_local_ranking_performance.py backend/tests/search/fixtures/local_ranking_quality_cases.json backend/tests/search/fixtures/local_ranking_baseline.json
git add -u backend/scripts/capture_legacy_search_baseline.py
git commit -m "test(search): enforce local ranking quality gates"
```

---

### Task 11: Run release verification and inspect the direct replacement

**Files:**
- Verify only; change code only if a gate exposes a real defect, and rerun the owning task's tests after that correction.

**Interfaces:**
- Consumes: the completed implementation.
- Produces: fresh evidence for search behavior, AI consumers, full backend quality, configuration replacement, privacy-safe diagnostics and a clean diff.

- [ ] **Step 1: Run the direct search test command required by the design**

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
```

Expected: PASS.

- [ ] **Step 2: Run the repository search test command**

```bash
npm run backend:test:search
```

Expected: PASS for all `backend/tests/search` tests.

- [ ] **Step 3: Run the AI search-tool contract tests**

```bash
cd backend && .venv/bin/python -m pytest tests/ai_infra/test_tool_registry.py -q
```

Expected: PASS; high scores remain candidates and ambiguous results still require user choice.

Also run the retained rerank usage contract tests:

```bash
cd backend && .venv/bin/python -m pytest tests/model_usage/test_rerank_adapter.py tests/model_usage/test_privacy_boundaries.py -q
```

Expected: PASS; provider-enabled rerank accounting remains intact. Together with the disabled-client assertion in Task 7, this proves the disabled path never begins a rerank request and therefore creates zero rerank requests, documents or token usage.

- [ ] **Step 4: Generate the offline quality and performance reports**

```bash
cd backend && .venv/bin/python scripts/run_search_ranking_quality.py
cd backend && .venv/bin/python -m pytest tests/search/test_local_ranking_performance.py -q -s
```

Expected: all quality thresholds pass; performance prints 160 candidates, 200 runs and local p95 no greater than 20ms. Record the measured p95 in the implementation handoff.

- [ ] **Step 5: Run full backend quality**

```bash
npm run backend:quality
```

Expected: backend typecheck/compile checks and the full pytest suite PASS. This is the final regression gate and does not replace the search/AI-specific runs above.

- [ ] **Step 6: Audit direct replacement, rerank retention and migration scope**

Run:

```bash
rg -n "SEARCH_RERANK_SEMANTIC_MIN_SCORE|search_rerank_semantic_min_score|score_search_candidate|KEYWORD_WEIGHT|SEMANTIC_WEIGHT|legacy_score" backend deploy
rg -n "SEARCH_SEMANTIC_MIN_SCORE|search_semantic_min_score" backend deploy
rg -n "SEARCH_RERANK_PROVIDER|search_rerank_provider|RerankClient|rerank_requests|rerank_documents" backend deploy
git diff --check
git status --short
```

Expected:

- First `rg`: no matches.
- Second `rg`: only the new config, examples, compose wiring, hybrid use and tests.
- Third `rg`: existing configured rerank client, provider, candidate limit and usage governance remain present.
- `git diff --check`: no whitespace errors.
- `git status --short`: only intentional implementation files, or empty after the task commits.

Do not run Alembic migration or frontend visual tests: this implementation has no database schema or frontend UI change. If the active deployment environment could not be inspected without exposing secrets or accessing out-of-scope infrastructure, state that exact verification gap in the handoff.

- [ ] **Step 7: Prepare the implementation handoff**

Report:

```text
Search tests: <passed count and command>
AI tool tests: <passed count and command>
Backend quality: <result and command>
Quality metrics: direct Top-1, MRR@10, nDCG@10, L4 Top-5 violations, Recall@20, determinism
Performance: 160-candidate local ranking p95 in milliseconds
Rerank disabled: zero provider calls verified by test
Rerank failure: same local projection verified by test
Configuration: old name absent, new name present
Unrun checks: active deployment environment only, if inaccessible
```

Do not claim completion until every applicable command above has fresh output.
