from __future__ import annotations


ALIASES = {
    "西红柿": "番茄",
    "土豆": "马铃薯",
    "小葱": "葱",
    "香葱": "葱",
    "洋芋": "马铃薯",
    "鸡脯肉": "鸡胸肉",
    "牛肉片": "牛肉",
    "猪肉末": "猪肉糜",
    "肉末": "猪肉糜",
}


def normalize_ingredient(name: str) -> str:
    """Normalize common Chinese ingredient aliases to canonical names."""
    text = str(name).strip()
    return ALIASES.get(text, text)


def normalize_ingredient_detail(name: str) -> dict:
    """Normalize ingredient aliases and return confidence metadata."""
    original = str(name).strip()
    normalized = ALIASES.get(original, original)
    changed = normalized != original
    return {
        "original": original,
        "normalized": normalized,
        "changed": changed,
        "confidence": 0.95 if changed else 0.6,
        "needsConfirmation": False if changed else not bool(original),
    }
