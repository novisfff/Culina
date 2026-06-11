from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.core.enums import MediaSource
from app.db.session import SessionLocal
from app.models.domain import MediaAsset
from app.services.media import build_media_variants, read_media_object


TARGET_ENTITY_TYPES = {"ingredient", "food", "recipe", "food_scene"}
RASTER_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill WebP variants for AI-generated media assets.")
    parser.add_argument("--dry-run", action="store_true", help="Only print the assets that would be processed.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of assets to scan. Defaults to all.")
    parser.add_argument("--family-id", default="", help="Restrict backfill to one family.")
    return parser.parse_args()


def is_raster_asset(asset: MediaAsset) -> bool:
    suffix = Path(asset.file_path or asset.url or "").suffix.lower()
    return suffix in RASTER_EXTENSIONS


def main() -> None:
    args = parse_args()
    scanned = 0
    candidates = 0
    updated = 0
    skipped = 0
    failed = 0

    with SessionLocal() as db:
        statement = select(MediaAsset).where(
            MediaAsset.source == MediaSource.AI,
            MediaAsset.variants.is_(None),
            MediaAsset.entity_type.in_(TARGET_ENTITY_TYPES),
        )
        if args.family_id:
            statement = statement.where(MediaAsset.family_id == args.family_id)
        statement = statement.order_by(MediaAsset.created_at.asc(), MediaAsset.id.asc())
        if args.limit and args.limit > 0:
            statement = statement.limit(args.limit)

        assets = list(db.scalars(statement))
        for asset in assets:
            scanned += 1
            if not is_raster_asset(asset):
                skipped += 1
                continue

            candidates += 1
            if args.dry_run:
                print(f"would_backfill id={asset.id} family_id={asset.family_id} file_path={asset.file_path}")
                continue

            try:
                payload = read_media_object(asset)
                variants = build_media_variants(family_id=asset.family_id, asset_id=asset.id, payload=payload)
                if not variants:
                    failed += 1
                    print(f"failed id={asset.id} reason=no_variants")
                    continue
                asset.variants = variants
                updated += 1
            except Exception as exc:
                failed += 1
                print(f"failed id={asset.id} reason={exc}")

        if args.dry_run:
            db.rollback()
        else:
            db.commit()

    print(
        " ".join(
            [
                f"scanned={scanned}",
                f"candidates={candidates}",
                f"updated={updated}",
                f"skipped={skipped}",
                f"failed={failed}",
                f"dry_run={str(args.dry_run).lower()}",
            ]
        )
    )


if __name__ == "__main__":
    main()
