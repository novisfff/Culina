from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import MediaAsset


def get_media_assets_for_family(db: Session, family_id: str) -> list[MediaAsset]:
    statement = select(MediaAsset).where(MediaAsset.family_id == family_id)
    return list(db.scalars(statement))


def build_media_map(assets: list[MediaAsset]) -> dict[tuple[str, str], list[MediaAsset]]:
    media_map: dict[tuple[str, str], list[MediaAsset]] = defaultdict(list)
    for asset in assets:
        if asset.entity_type and asset.entity_id:
            media_map[(asset.entity_type, asset.entity_id)].append(asset)
    return media_map
