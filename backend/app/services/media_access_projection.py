from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import MediaAsset
from app.services.media_references import media_reference_id
from app.services.serializers import serialize_media


_OMIT = object()


def _collect_media_reference_ids(value: Any, target: set[str]) -> None:
    media_id = media_reference_id(value)
    if media_id:
        target.add(media_id)
        return
    if isinstance(value, dict):
        for child in value.values():
            _collect_media_reference_ids(child, target)
    elif isinstance(value, list):
        for child in value:
            _collect_media_reference_ids(child, target)


def _project_media_references(value: Any, serialized_by_id: dict[str, dict]) -> Any:
    media_id = media_reference_id(value)
    if media_id:
        return serialized_by_id.get(media_id)
    if isinstance(value, list):
        projected: list[Any] = []
        for child in value:
            next_child = _project_media_references(child, serialized_by_id)
            if next_child is not _OMIT:
                projected.append(next_child)
        return projected
    if not isinstance(value, dict):
        return value

    projected = {
        key: None if (next_value := _project_media_references(child, serialized_by_id)) is _OMIT else next_value
        for key, child in value.items()
    }
    original_image = value.get("image")
    if (
        value.get("type") == "image"
        and isinstance(original_image, dict)
        and media_reference_id(original_image.get("asset"))
        and not isinstance((projected.get("image") or {}).get("asset"), dict)
    ):
        return _OMIT
    return projected


def rehydrate_media_access(db: Session, *, family_id: str, payload: Any) -> Any:
    """Replace durable/legacy media references with fresh family-scoped capabilities."""
    media_ids: set[str] = set()
    _collect_media_reference_ids(payload, media_ids)
    if not media_ids:
        return payload
    assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.id.in_(media_ids),
            )
        )
    )
    projected = _project_media_references(payload, {asset.id: serialize_media(asset) for asset in assets})
    return None if projected is _OMIT else projected
