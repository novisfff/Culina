from __future__ import annotations


def normalize_ingredient(name: str) -> str:
    """Normalize common Chinese ingredient aliases to canonical names."""
    aliases = {"西红柿": "番茄", "土豆": "马铃薯", "小葱": "葱"}
    text = str(name).strip()
    return aliases.get(text, text)
