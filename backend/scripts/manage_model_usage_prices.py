from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Sequence

from sqlalchemy import select

from app.core.config import get_settings
from app.core.enums import ModelUsageCapability, ModelUsageMeter, ModelUsageMeterRole
from app.db.session import SessionLocal
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.services.model_usage.configured_variants import (
    AUDIO_TOKEN_METERS,
    ConfiguredUsageVariant,
    ProviderUsageContract,
    configured_usage_variants,
)
from app.services.model_usage.errors import ModelUsageError
from app.services.model_usage.pricing import (
    PublishPriceCommand,
    cancel_price_version,
    price_coverage,
    publish_price_manifest,
)
from app.services.model_usage.pricing_manifest import (
    ValidatedPriceManifest,
    load_price_manifest,
)
from app.services.model_usage.periods import require_aware_utc
from app.core.utils import utcnow


def _inferred_variants(
    validated: ValidatedPriceManifest,
) -> tuple[ConfiguredUsageVariant, ...]:
    grouped: dict[
        tuple[str, str, ModelUsageCapability, str, str], set[ModelUsageMeter]
    ] = defaultdict(set)
    for rate in validated.manifest.rates:
        if rate.meter_role is ModelUsageMeterRole.BILLABLE:
            grouped[rate.scheme_identity].add(rate.meter)

    variants = []
    for identity, billable in grouped.items():
        provider, billing_model, capability, variant_key, scheme_key = identity
        token_realtime = (
            capability is ModelUsageCapability.REALTIME_AUDIO
            and bool(billable & AUDIO_TOKEN_METERS)
        )
        variants.append(
            ConfiguredUsageVariant(
                provider=provider,
                billing_model=billing_model,
                capability=capability,
                variant_key=variant_key,
                billing_scheme_key=scheme_key,
                billable_meters=frozenset(billable),
                produced_meters=frozenset(billable),
                input_tokens_per_second_cap=Decimal("1") if token_realtime else None,
                output_tokens_per_second_cap=Decimal("1") if token_realtime else None,
                lease_boundary_cumulative_meters=(
                    frozenset(billable & AUDIO_TOKEN_METERS)
                    if token_realtime
                    else frozenset()
                ),
                provider_contract=ProviderUsageContract(
                    supports_lease_boundary_cumulative_usage=token_realtime
                ),
            )
        )
    return tuple(sorted(variants, key=lambda item: item.identity))


def _load_for_validation(path: str) -> tuple[ValidatedPriceManifest, tuple[ConfiguredUsageVariant, ...]]:
    initial = load_price_manifest(path, configured_variants=())
    inferred = _inferred_variants(initial)
    return load_price_manifest(path, configured_variants=inferred), inferred


def _coverage_payload(
    variants: Sequence[ConfiguredUsageVariant],
) -> list[dict[str, object]]:
    return [
        {
            "provider": variant.provider,
            "billing_model": variant.billing_model,
            "capability": variant.capability.value,
            "variant": variant.variant_key,
            "billing_scheme_key": variant.billing_scheme_key,
            "billable_meters": sorted(meter.value for meter in variant.billable_meters),
        }
        for variant in variants
    ]


def handle_validate(args: argparse.Namespace) -> int:
    validated, variants = _load_for_validation(args.file)
    payload = {
        "checksum": validated.checksum,
        "catalog_version": validated.manifest.catalog_version,
        "coverage": _coverage_payload(variants),
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        print(f"checksum={validated.checksum}")
        for row in payload["coverage"]:
            print(
                f"{row['capability']} {row['provider']} {row['billing_model']} "
                f"{row['variant']} {','.join(row['billable_meters'])}"
            )
    return 0


def handle_publish(args: argparse.Namespace) -> int:
    settings = get_settings()
    variants = configured_usage_variants(settings)
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    with SessionLocal() as db, db.begin():
        version = publish_price_manifest(
            db,
            PublishPriceCommand(
                manifest=raw,
                configured_variants=variants,
                operator=args.operator,
                change_ticket=args.change_ticket,
                confirm_checksum=args.confirm_checksum,
            ),
        )
        result = {
            "id": version.id,
            "version_number": version.version_number,
            "checksum": version.manifest_checksum,
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


def handle_list(args: argparse.Namespace) -> int:
    del args
    with SessionLocal() as db:
        versions = db.scalars(
            select(ModelUsagePriceVersion).order_by(
                ModelUsagePriceVersion.version_number.desc()
            )
        ).all()
        payload = [
            {
                "id": version.id,
                "version_number": version.version_number,
                "status": version.status,
                "effective_from": version.effective_from.isoformat(),
                "checksum": version.manifest_checksum,
            }
            for version in versions
        ]
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


def handle_show(args: argparse.Namespace) -> int:
    with SessionLocal() as db:
        version = db.get(ModelUsagePriceVersion, args.version_id)
        if version is None:
            raise ModelUsageError("price_version_not_found")
        rates = db.scalars(
            select(ModelUsagePriceRate)
            .where(ModelUsagePriceRate.price_version_id == version.id)
            .order_by(ModelUsagePriceRate.provider, ModelUsagePriceRate.billing_model)
        ).all()
        payload = {
            "id": version.id,
            "version_number": version.version_number,
            "status": version.status,
            "checksum": version.manifest_checksum,
            "rates": [
                {
                    "provider": rate.provider,
                    "billing_model": rate.billing_model,
                    "capability": rate.capability.value,
                    "variant": rate.variant_key,
                    "meter": rate.meter.value,
                    "meter_role": rate.meter_role.value,
                    "unit_quantity": str(rate.unit_quantity),
                    "unit_price": str(rate.unit_price) if rate.unit_price is not None else None,
                    "source_currency": rate.source_currency,
                }
                for rate in rates
            ],
        }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


def handle_diff(args: argparse.Namespace) -> int:
    validated, _ = _load_for_validation(args.file)
    with SessionLocal() as db:
        current = db.scalar(
            select(ModelUsagePriceVersion)
            .where(ModelUsagePriceVersion.status == "published")
            .order_by(ModelUsagePriceVersion.effective_from.desc())
            .limit(1)
        )
    payload = {
        "candidate_checksum": validated.checksum,
        "current_checksum": current.manifest_checksum if current is not None else None,
        "changed": current is None or current.manifest_checksum != validated.checksum,
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


def handle_coverage(args: argparse.Namespace) -> int:
    del args
    variants = configured_usage_variants(get_settings())
    with SessionLocal() as db:
        report = price_coverage(db, configured_variants=variants, at=utcnow())
    payload = {
        "healthy": report.healthy,
        "price_version_id": report.price_version_id,
        "rows": [
            {
                "provider": row.provider,
                "billing_model": row.billing_model,
                "capability": row.capability,
                "variant": row.variant_key,
                "billing_scheme_key": row.billing_scheme_key,
                "missing_meters": sorted(meter.value for meter in row.missing_meters),
            }
            for row in report.rows
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if report.healthy else 1


def handle_cancel(args: argparse.Namespace) -> int:
    at = require_aware_utc(utcnow())
    with SessionLocal() as db, db.begin():
        version = cancel_price_version(db, version_id=args.version_id, at=at)
    print(json.dumps({"id": version.id, "status": version.status}, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage immutable model-usage prices")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--file", required=True)
    validate.add_argument("--json", action="store_true")
    validate.set_defaults(handler=handle_validate)

    diff = subparsers.add_parser("diff")
    diff.add_argument("--file", required=True)
    diff.set_defaults(handler=handle_diff)

    publish = subparsers.add_parser("publish")
    publish.add_argument("--file", required=True)
    publish.add_argument("--operator", required=True)
    publish.add_argument("--change-ticket", required=True)
    publish.add_argument("--confirm-checksum", required=True)
    publish.set_defaults(handler=handle_publish)

    list_command = subparsers.add_parser("list")
    list_command.set_defaults(handler=handle_list)

    show = subparsers.add_parser("show")
    show.add_argument("--version-id", required=True)
    show.set_defaults(handler=handle_show)

    coverage = subparsers.add_parser("coverage")
    coverage.set_defaults(handler=handle_coverage)

    cancel = subparsers.add_parser("cancel")
    cancel.add_argument("--version-id", required=True)
    cancel.set_defaults(handler=handle_cancel)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except ModelUsageError as exc:
        print(exc.code, file=sys.stderr)
        return 2
    except Exception:
        print("model_usage_price_cli_failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
