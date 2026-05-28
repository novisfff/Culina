from __future__ import annotations

from datetime import datetime
from pathlib import Path
from uuid import uuid4


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12]}"


def utcnow() -> datetime:
    from app.services.clock import now_utc

    return now_utc()


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
