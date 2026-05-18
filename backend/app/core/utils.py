from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12]}"


def utcnow() -> datetime:
    return datetime.now(UTC)


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
