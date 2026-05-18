from __future__ import annotations
from pathlib import Path
from typing import Iterable
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import ImageGenerationMode, MediaSource
from app.core.utils import create_id, ensure_directory, utcnow
from app.models.domain import MediaAsset

ALLOWED_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
}


def _sanitize_basename(name: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in name)
    return cleaned[:80] or "media"


def _public_url(file_name: str) -> str:
    return f"/media/{file_name}"


def save_upload(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    upload: UploadFile,
    source: MediaSource,
    alt: str,
) -> MediaAsset:
    settings = get_settings()
    media_root = ensure_directory(settings.resolved_media_root)
    suffix = ALLOWED_CONTENT_TYPES.get(upload.content_type or "")
    if not suffix:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image type")

    file_name = f"{_sanitize_basename(Path(upload.filename or 'media').stem)}_{uuid4().hex}{suffix}"
    absolute_path = media_root / file_name
    payload = upload.file.read()
    absolute_path.write_bytes(payload)

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=upload.filename or file_name,
        url=_public_url(file_name),
        file_path=str(absolute_path),
        source=source,
        alt=alt or (upload.filename or file_name),
        created_at=utcnow(),
        created_by=user_id,
    )
    db.add(asset)
    db.flush()
    return asset


def save_svg_asset(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    title: str,
    svg_markup: str,
    source: MediaSource = MediaSource.AI,
    alt: str | None = None,
    generation_mode: ImageGenerationMode | None = None,
    reference_media_id: str | None = None,
    style_key: str | None = None,
    prompt_version: str | None = None,
) -> MediaAsset:
    settings = get_settings()
    media_root = ensure_directory(settings.resolved_media_root)
    file_name = f"{_sanitize_basename(title)}_{uuid4().hex}.svg"
    absolute_path = media_root / file_name
    absolute_path.write_text(svg_markup, encoding="utf-8")

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=title,
        url=_public_url(file_name),
        file_path=str(absolute_path),
        source=source,
        alt=alt or title,
        generation_mode=generation_mode,
        reference_media_id=reference_media_id,
        style_key=style_key,
        prompt_version=prompt_version,
        created_at=utcnow(),
        created_by=user_id,
    )
    db.add(asset)
    db.flush()
    return asset


def save_generated_asset(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    title: str,
    binary_payload: bytes,
    file_extension: str,
    source: MediaSource = MediaSource.AI,
    alt: str | None = None,
    generation_mode: ImageGenerationMode | None = None,
    reference_media_id: str | None = None,
    style_key: str | None = None,
    prompt_version: str | None = None,
) -> MediaAsset:
    settings = get_settings()
    media_root = ensure_directory(settings.resolved_media_root)
    normalized_extension = file_extension.lower()
    if not normalized_extension.startswith("."):
        normalized_extension = f".{normalized_extension}"
    if normalized_extension not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported generated image type")

    file_name = f"{_sanitize_basename(title)}_{uuid4().hex}{normalized_extension}"
    absolute_path = media_root / file_name
    absolute_path.write_bytes(binary_payload)

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=title,
        url=_public_url(file_name),
        file_path=str(absolute_path),
        source=source,
        alt=alt or title,
        generation_mode=generation_mode,
        reference_media_id=reference_media_id,
        style_key=style_key,
        prompt_version=prompt_version,
        created_at=utcnow(),
        created_by=user_id,
    )
    db.add(asset)
    db.flush()
    return asset


def get_media_asset(
    db: Session,
    *,
    family_id: str,
    media_id: str,
) -> MediaAsset | None:
    statement = select(MediaAsset).where(MediaAsset.family_id == family_id, MediaAsset.id == media_id)
    return db.scalar(statement)


def build_ai_cover_svg(title: str) -> str:
    palette = ["#f28f60", "#e56b6f", "#f7b267", "#7a9e7e", "#4c82a4"]
    seed = sum(ord(char) for char in title)
    primary = palette[seed % len(palette)]
    secondary = palette[(seed + 2) % len(palette)]
    shift_x = (seed % 58) - 29
    shift_y = (seed % 44) - 22
    tilt = (seed % 18) - 9
    return f"""
    <svg width="1200" height="800" viewBox="0 0 1200 800" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="800" rx="72" fill="#FFF6EE"/>
      <circle cx="{240 + shift_x}" cy="{180 + shift_y / 2}" r="180" fill="{secondary}" opacity="0.18"/>
      <circle cx="{980 - shift_x}" cy="{140 - shift_y / 3}" r="140" fill="{primary}" opacity="0.14"/>
      <circle cx="{920 - shift_x / 2}" cy="{620 + shift_y}" r="210" fill="{secondary}" opacity="0.14"/>
      <rect x="92" y="92" width="1016" height="616" rx="56" fill="url(#warm)"/>
      <ellipse cx="{520 + shift_x / 3}" cy="{442 + shift_y / 2}" rx="196" ry="214" fill="white" fill-opacity="0.22"/>
      <ellipse cx="{468 + shift_x}" cy="{432 + shift_y}" rx="128" ry="176" transform="rotate({tilt} {468 + shift_x} {432 + shift_y})" fill="white" fill-opacity="0.28"/>
      <ellipse cx="{626 - shift_x / 2}" cy="{418 - shift_y / 2}" rx="142" ry="184" transform="rotate({-tilt} {626 - shift_x / 2} {418 - shift_y / 2})" fill="{primary}" fill-opacity="0.18"/>
      <path d="M760 270C783.452 245.617 815.117 233.964 849.619 233.964C841.992 268.208 822.17 299.774 795.779 322.466C772.327 346.849 740.662 358.502 706.16 358.502C713.787 324.258 733.609 292.692 760 270Z" fill="white" fill-opacity="0.76"/>
      <path d="M700 308C719.62 287.604 746.12 277.852 774.989 277.852C768.607 306.505 752.01 332.919 729.92 351.912C710.3 372.308 683.8 382.06 654.931 382.06C661.313 353.407 677.91 326.993 700 308Z" fill="{secondary}" fill-opacity="0.34"/>
      <ellipse cx="588" cy="432" rx="72" ry="98" fill="white" fill-opacity="0.22"/>
      <defs>
        <linearGradient id="warm" x1="92" y1="92" x2="1108" y2="708" gradientUnits="userSpaceOnUse">
          <stop stop-color="{primary}"/>
          <stop offset="1" stop-color="{secondary}"/>
        </linearGradient>
      </defs>
    </svg>
    """.strip()


def bind_media_assets(
    db: Session,
    *,
    family_id: str,
    media_ids: Iterable[str],
    entity_type: str,
    entity_id: str,
) -> list[MediaAsset]:
    ids = list(dict.fromkeys(media_ids))
    if not ids:
        return []

    statement = select(MediaAsset).where(MediaAsset.family_id == family_id, MediaAsset.id.in_(ids))
    assets = list(db.scalars(statement))
    for asset in assets:
        asset.entity_type = entity_type
        asset.entity_id = entity_id
    db.flush()
    return assets


def replace_media_assets(
    db: Session,
    *,
    family_id: str,
    media_ids: Iterable[str],
    entity_type: str,
    entity_id: str,
) -> list[MediaAsset]:
    current_assets = list(
        db.scalars(
            select(MediaAsset).where(
                MediaAsset.family_id == family_id,
                MediaAsset.entity_type == entity_type,
                MediaAsset.entity_id == entity_id,
            )
        )
    )
    for asset in current_assets:
        asset.entity_type = None
        asset.entity_id = None

    return bind_media_assets(
        db,
        family_id=family_id,
        media_ids=media_ids,
        entity_type=entity_type,
        entity_id=entity_id,
    )
