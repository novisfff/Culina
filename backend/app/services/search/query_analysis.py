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
    "date": ("今天", "明天"),
    "week": ("本周", "这周", "这星期"),
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
