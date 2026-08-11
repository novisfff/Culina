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
