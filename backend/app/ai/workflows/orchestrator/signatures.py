from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any


def tool_signature(name: str, payload: dict[str, Any] | None) -> str:
    return f"{name}:{json.dumps(payload or {}, sort_keys=True, ensure_ascii=False, default=str)}"


def historical_tool_signatures(artifacts: Iterable[Any]) -> list[str]:
    signatures: list[str] = []
    for artifact in artifacts:
        if not isinstance(artifact, dict) or artifact.get("type") != "tool_call":
            continue
        signature = str(artifact.get("signature") or "").strip()
        if signature:
            signatures.append(signature)
    return signatures
