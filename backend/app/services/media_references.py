from __future__ import annotations

from typing import Any


STABLE_MEDIA_FIELDS = (
    "id",
    "name",
    "source",
    "alt",
    "generation_mode",
    "reference_media_id",
    "style_key",
    "prompt_version",
    "created_at",
    "created_by",
)


def media_reference_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    media_id = str(value.get("id") or "").strip()
    if not media_id:
        return None
    if value.get("media_reference") is True:
        return media_id
    url = value.get("url")
    if not isinstance(url, str):
        return None
    if url.startswith(f"/api/media/{media_id}/content?") or url.startswith("/media/"):
        return media_id
    return None


def stable_media_reference(value: Any) -> dict[str, Any] | None:
    media_id = media_reference_id(value)
    if media_id is None or not isinstance(value, dict):
        return None
    return {
        "media_reference": True,
        **{field: value.get(field) for field in STABLE_MEDIA_FIELDS},
        "id": media_id,
    }
