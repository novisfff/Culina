from __future__ import annotations

from pathlib import Path

from app.db.session import SessionLocal
from app.models.domain import MediaAsset
from app.services.media import _object_key, _public_url, _put_media_object


CONTENT_TYPES_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
}


def is_local_media_path(value: str) -> bool:
    if not value:
        return False
    if value.startswith("s3://"):
        return False
    if value.startswith("/") or value.startswith("storage/"):
        return True
    return Path(value).exists()


def migrate() -> tuple[int, int]:
    migrated = 0
    skipped = 0
    with SessionLocal() as db:
        assets = db.query(MediaAsset).all()
        for asset in assets:
            if not is_local_media_path(asset.file_path):
                skipped += 1
                continue

            source_path = Path(asset.file_path)
            if not source_path.exists():
                skipped += 1
                continue

            suffix = source_path.suffix.lower()
            content_type = CONTENT_TYPES_BY_EXTENSION.get(suffix, "application/octet-stream")
            object_key = _object_key(family_id=asset.family_id, file_name=source_path.name)
            _put_media_object(object_key=object_key, payload=source_path.read_bytes(), content_type=content_type)
            asset.file_path = object_key
            asset.url = _public_url(object_key)
            migrated += 1

        db.commit()
    return migrated, skipped


if __name__ == "__main__":
    migrated_count, skipped_count = migrate()
    print(f"migrated={migrated_count} skipped={skipped_count}")
