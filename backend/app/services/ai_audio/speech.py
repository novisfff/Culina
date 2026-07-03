from __future__ import annotations

import re

from fastapi import HTTPException, status


MARKDOWN_TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$")


def sanitize_speech_text(text: str, max_chars: int = 300) -> str:
    cleaned_lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if MARKDOWN_TABLE_LINE.match(stripped):
            continue
        if stripped.startswith(("```", "{", "}", "[", "]")):
            continue
        cleaned_lines.append(stripped)
    cleaned = " ".join(cleaned_lines)
    cleaned = re.sub(r"[*_`#>\-]+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="没有可播报的文本")
    if len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].rstrip()
    return cleaned
