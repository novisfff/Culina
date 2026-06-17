from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolDefinition
from app.ai.tools.registry import ToolRegistry
from app.models.domain import MediaAsset
from app.services.serializers import group_media_by_entity, serialize_media


def register_tool(
    registry: ToolRegistry,
    *,
    name: str,
    display_name: str,
    description: str,
    side_effect: str,
    handler,
    input_schema: dict[str, Any],
    output_schema: dict[str, Any],
    permission: str | None = None,
) -> None:
    resolved_permission = permission or ("family:draft" if side_effect == "draft" else "family:read")
    registry.register(
        ToolDefinition(
            name=name,
            display_name=display_name,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
            permission=resolved_permission,
            side_effect=side_effect,  # type: ignore[arg-type]
            requires_confirmation=side_effect == "draft",
            handler=handler,
        )
    )


def decimal_text(value: Decimal | int | float | None) -> str:
    if value is None:
        return "0"
    return f"{float(value):g}"


def entity_media_map(db, *, family_id: str, entity_types: set[str], entity_ids: list[str]) -> dict[tuple[str, str], list[MediaAsset]]:
    ids = list(dict.fromkeys(item for item in entity_ids if item))
    if not ids:
        return {}
    assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.entity_type.in_(entity_types),
                MediaAsset.entity_id.in_(ids),
            )
        )
    )
    return group_media_by_entity(assets)


def first_entity_media(media_map: dict[tuple[str, str], list[MediaAsset]], entity_type: str, entity_id: str) -> dict[str, Any] | None:
    assets = media_map.get((entity_type, entity_id), [])
    if not assets:
        return None
    media = serialize_media(assets[0])
    created_at = media.get("created_at")
    if hasattr(created_at, "isoformat"):
        media["created_at"] = created_at.isoformat()
    return media
