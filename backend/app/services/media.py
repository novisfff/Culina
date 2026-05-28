from __future__ import annotations
from pathlib import Path
from typing import Iterable
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status
from minio import Minio
from minio.error import S3Error
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import ImageGenerationMode, MediaSource
from app.core.utils import create_id, utcnow
from app.models.domain import MediaAsset

ALLOWED_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}

GENERATED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"}


def _detect_image_content_type(payload: bytes) -> str | None:
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if payload.startswith(b"BM"):
        return "image/bmp"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp"
    return None


def _sanitize_basename(name: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in name)
    return cleaned[:80] or "media"


def _storage_client() -> Minio:
    settings = get_settings()
    return Minio(
        settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
    )


def ensure_media_bucket() -> None:
    settings = get_settings()
    client = _storage_client()
    if not client.bucket_exists(settings.minio_bucket):
        client.make_bucket(settings.minio_bucket)
    policy = f"""{{
      "Version": "2012-10-17",
      "Statement": [
        {{
          "Effect": "Allow",
          "Principal": {{"AWS": ["*"]}},
          "Action": ["s3:GetObject"],
          "Resource": ["arn:aws:s3:::{settings.minio_bucket}/*"]
        }}
      ]
    }}"""
    client.set_bucket_policy(settings.minio_bucket, policy)


def _object_key(*, family_id: str, file_name: str) -> str:
    return f"{family_id}/{file_name}"


def _public_url(object_key: str) -> str:
    return f"/media/{object_key}"


def _put_media_object(*, object_key: str, payload: bytes, content_type: str) -> None:
    from io import BytesIO

    settings = get_settings()
    ensure_media_bucket()
    _storage_client().put_object(
        settings.minio_bucket,
        object_key,
        BytesIO(payload),
        length=len(payload),
        content_type=content_type,
    )


def read_media_object(asset: MediaAsset) -> bytes:
    settings = get_settings()
    response = None
    try:
        response = _storage_client().get_object(settings.minio_bucket, asset.file_path)
        return response.read()
    except S3Error as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reference media file not found") from exc
    finally:
        if response is not None:
            response.close()
            response.release_conn()


def delete_media_file(asset: MediaAsset) -> None:
    if asset.file_path:
        try:
            _storage_client().remove_object(get_settings().minio_bucket, asset.file_path)
        except S3Error:
            pass


def _read_validated_upload(upload: UploadFile, max_bytes: int) -> tuple[bytes, str]:
    declared_type = (upload.content_type or "").split(";")[0].strip().lower()
    if declared_type == "image/jpg":
        declared_type = "image/jpeg"
    if declared_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image type")

    payload = upload.file.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Image file is too large")

    detected_type = _detect_image_content_type(payload)
    if detected_type is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image file")
    if detected_type != declared_type:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image content does not match declared type")
    return payload, detected_type


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
    payload, content_type = _read_validated_upload(upload, settings.media_max_upload_bytes)
    suffix = ALLOWED_CONTENT_TYPES[content_type]

    file_name = f"{_sanitize_basename(Path(upload.filename or 'media').stem)}_{uuid4().hex}{suffix}"
    object_key = _object_key(family_id=family_id, file_name=file_name)
    _put_media_object(object_key=object_key, payload=payload, content_type=content_type)

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=upload.filename or file_name,
        url=_public_url(object_key),
        file_path=object_key,
        source=source,
        alt=alt or (upload.filename or file_name),
        created_at=utcnow(),
        created_by=user_id,
    )
    try:
        db.add(asset)
        db.flush()
    except Exception:
        delete_media_file(asset)
        raise
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
    file_name = f"{_sanitize_basename(title)}_{uuid4().hex}.svg"
    object_key = _object_key(family_id=family_id, file_name=file_name)
    _put_media_object(object_key=object_key, payload=svg_markup.encode("utf-8"), content_type="image/svg+xml")

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=title,
        url=_public_url(object_key),
        file_path=object_key,
        source=source,
        alt=alt or title,
        generation_mode=generation_mode,
        reference_media_id=reference_media_id,
        style_key=style_key,
        prompt_version=prompt_version,
        created_at=utcnow(),
        created_by=user_id,
    )
    try:
        db.add(asset)
        db.flush()
    except Exception:
        delete_media_file(asset)
        raise
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
    normalized_extension = file_extension.lower()
    if not normalized_extension.startswith("."):
        normalized_extension = f".{normalized_extension}"
    if normalized_extension not in GENERATED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported generated image type")

    file_name = f"{_sanitize_basename(title)}_{uuid4().hex}{normalized_extension}"
    object_key = _object_key(family_id=family_id, file_name=file_name)
    content_type_by_extension = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    }
    _put_media_object(
        object_key=object_key,
        payload=binary_payload,
        content_type=content_type_by_extension.get(normalized_extension, "application/octet-stream"),
    )

    asset = MediaAsset(
        id=create_id("photo"),
        family_id=family_id,
        name=title,
        url=_public_url(object_key),
        file_path=object_key,
        source=source,
        alt=alt or title,
        generation_mode=generation_mode,
        reference_media_id=reference_media_id,
        style_key=style_key,
        prompt_version=prompt_version,
        created_at=utcnow(),
        created_by=user_id,
    )
    try:
        db.add(asset)
        db.flush()
    except Exception:
        delete_media_file(asset)
        raise
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
