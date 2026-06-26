from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

from fastapi.encoders import jsonable_encoder


SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "cookie",
    "token",
    "secret",
    "password",
    "access_token",
    "refresh_token",
    "credential",
}

DATA_URL_RE = re.compile(r"^data:(?P<content_type>[^;,]+)(?:;[^,]+)?,(?P<payload>.*)$", re.DOTALL)
MESSAGE_CONTENT_KEYS = {"content", "text", "args", "arguments"}


def redact_for_trace(
    value: Any,
    *,
    payload_mode: str = "redacted",
    max_bytes: int = 1024 * 1024,
    capture_image_bytes: bool = False,
    capture_message_content: bool = False,
) -> Any:
    encoded = _safe_jsonable(value)
    normalized_mode = payload_mode.strip().lower()
    if normalized_mode == "summary":
        encoded = _summarize(encoded)
    elif normalized_mode != "full":
        encoded = _redact(
            encoded,
            capture_image_bytes=capture_image_bytes,
            capture_message_content=capture_message_content,
        )
    return _truncate_to_bytes(encoded, max_bytes=max_bytes)


def summarize_keys(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {"keys": sorted(str(key) for key in value.keys())}
    if isinstance(value, list):
        return {"count": len(value)}
    if isinstance(value, str):
        return {"length": len(value)}
    return {"type": type(value).__name__}


def _safe_jsonable(value: Any) -> Any:
    try:
        return jsonable_encoder(value)
    except Exception:
        return str(value)


def _redact(value: Any, *, capture_image_bytes: bool, capture_message_content: bool) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key).lower()
            if any(sensitive in normalized_key for sensitive in SENSITIVE_KEYS):
                result[key] = "[REDACTED]"
                continue
            if not capture_message_content and normalized_key in MESSAGE_CONTENT_KEYS:
                result[key] = _summarize_without_preview(item)
                continue
            if key == "url" and isinstance(item, str) and item.startswith("data:") and not capture_image_bytes:
                result[key] = _redact_data_url(item)
                continue
            result[key] = _redact(
                item,
                capture_image_bytes=capture_image_bytes,
                capture_message_content=capture_message_content,
            )
        return result
    if isinstance(value, list):
        return [
            _redact(
                item,
                capture_image_bytes=capture_image_bytes,
                capture_message_content=capture_message_content,
            )
            for item in value
        ]
    if isinstance(value, bytes):
        if capture_image_bytes:
            return base64.b64encode(value).decode("ascii")
        return {
            "redacted": True,
            "byteSize": len(value),
            "sha256": hashlib.sha256(value).hexdigest(),
        }
    return value


def _redact_data_url(value: str) -> dict[str, Any]:
    match = DATA_URL_RE.match(value)
    if match is None:
        return {"redacted": True, "kind": "data_url", "length": len(value)}
    payload = match.group("payload")
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception:
        raw = payload.encode("utf-8", errors="ignore")
    return {
        "redacted": True,
        "kind": "data_url",
        "contentType": match.group("content_type"),
        "byteSize": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def _summarize(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            "type": "object",
            "keys": sorted(str(key) for key in value.keys()),
            "fields": {str(key): _summarize(item) for key, item in value.items()},
        }
    if isinstance(value, list):
        return {
            "type": "array",
            "count": len(value),
            "items": [_summarize(item) for item in value[:5]],
            **({"truncatedItems": len(value) - 5} if len(value) > 5 else {}),
        }
    if isinstance(value, str):
        return {"type": "string", "length": len(value), "preview": value[:160]}
    return {"type": type(value).__name__, "value": value}


def _summarize_without_preview(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            "type": "object",
            "keys": sorted(str(key) for key in value.keys()),
            "fields": {str(key): _summarize_without_preview(item) for key, item in value.items()},
        }
    if isinstance(value, list):
        return {
            "type": "array",
            "count": len(value),
            "items": [_summarize_without_preview(item) for item in value[:5]],
            **({"truncatedItems": len(value) - 5} if len(value) > 5 else {}),
        }
    if isinstance(value, str):
        return {"type": "string", "length": len(value)}
    return {"type": type(value).__name__}


def _truncate_to_bytes(value: Any, *, max_bytes: int) -> Any:
    if max_bytes <= 0:
        return value
    serialized = json.dumps(value, ensure_ascii=False, default=str)
    encoded = serialized.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    truncated = encoded[:max_bytes].decode("utf-8", errors="ignore")
    return {
        "truncated": True,
        "originalSize": len(encoded),
        "storedSize": len(truncated.encode("utf-8")),
        "payload": truncated,
    }
