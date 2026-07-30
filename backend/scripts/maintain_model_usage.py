from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Sequence

from sqlalchemy import select

from app.core.config import get_settings
from app.core.enums import (
    ModelUsageCapability,
    ModelUsageCorrectionStatus,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageResolutionKind,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.model_usage import ModelUsagePeriodCounter
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.counter_audit import audit_counters_batch
from app.services.model_usage.incidents import IncidentAttemptCommand, IncidentCommand, record_incident
from app.services.model_usage.maintenance import (
    check_price_coverage_batch,
    query_uncertain_batch,
    reconcile_reservations_batch,
)
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.pricing import UsagePriceRateSnapshot, UsagePriceSnapshot
from app.services.model_usage.retention import RetentionTarget, prune_period
from app.services.model_usage.rollups import rebuild_monthly_rollups
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.errors import ModelUsageError


def _period(value: str) -> BillingPeriod:
    try:
        local_start = datetime.strptime(value, "%Y-%m").replace(tzinfo=SHANGHAI)
    except ValueError as exc:
        raise ValueError("period must use YYYY-MM") from exc
    if local_start.month == 12:
        next_start = datetime(local_start.year + 1, 1, 1, tzinfo=SHANGHAI)
    else:
        next_start = datetime(local_start.year, local_start.month + 1, 1, tzinfo=SHANGHAI)
    return BillingPeriod(
        local_month=value,
        start_at=local_start.astimezone(timezone.utc),
        end_at=next_start.astimezone(timezone.utc),
    )


def _decimal(value: object | None) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _optional_enum(enum_type, value: object | None):
    return None if value is None else enum_type(str(value))


def _snapshot(payload: object | None) -> UsagePriceSnapshot | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise ValueError("adjustment price_snapshot must be an object")
    raw_rates = payload.get("rates", [])
    if not isinstance(raw_rates, list):
        raise ValueError("adjustment price_snapshot.rates must be an array")
    rates = tuple(
        UsagePriceRateSnapshot(
            meter=ModelUsageMeter(str(row["meter"])),
            meter_role=ModelUsageMeterRole(str(row["meter_role"])),
            unit_quantity=Decimal(str(row["unit_quantity"])),
            unit_price=_decimal(row.get("unit_price")),
            source_currency=(str(row["source_currency"]) if row.get("source_currency") else None),
            fx_to_cny=_decimal(row.get("fx_to_cny")),
            unit_price_cny=_decimal(row.get("unit_price_cny")),
        )
        for row in raw_rates
        if isinstance(row, dict)
    )
    if len(rates) != len(raw_rates):
        raise ValueError("adjustment price_snapshot.rates contains an invalid row")
    return UsagePriceSnapshot(
        pricing_status=ModelUsagePricingStatus(str(payload["pricing_status"])),
        price_version_id=(str(payload["price_version_id"]) if payload.get("price_version_id") else None),
        billing_model=str(payload["billing_model"]),
        billing_scheme_key=(
            str(payload["billing_scheme_key"])
            if payload.get("billing_scheme_key")
            else None
        ),
        rates=rates,
        missing_billable_meters=frozenset(
            ModelUsageMeter(str(item))
            for item in payload.get("missing_billable_meters", [])
        ),
        checksum=(str(payload["checksum"]) if payload.get("checksum") else None),
    )


def _adjustment_command_from_file(path: str) -> AdjustmentCommand:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("lines"), list):
        raise ValueError("adjustment command must contain a lines array")
    lines = tuple(
        AdjustmentLineCommand(
            resolution_kind=ModelUsageResolutionKind(str(item["resolution_kind"])),
            meter=_optional_enum(ModelUsageMeter, item.get("meter")),
            meter_delta=_decimal(item.get("meter_delta")),
            cost_delta_cny=_decimal(item.get("cost_delta_cny")),
            resulting_provider_outcome=_optional_enum(
                ModelUsageProviderOutcome, item.get("resulting_provider_outcome")
            ),
            resulting_execution_certainty=_optional_enum(
                ModelUsageExecutionCertainty, item.get("resulting_execution_certainty")
            ),
            resulting_measurement_status=_optional_enum(
                ModelUsageMeasurementStatus, item.get("resulting_measurement_status")
            ),
            resulting_pricing_status=_optional_enum(
                ModelUsagePricingStatus, item.get("resulting_pricing_status")
            ),
            price_snapshot=_snapshot(item.get("price_snapshot")),
            resolved_cost_cny=_decimal(item.get("resolved_cost_cny")),
        )
        for item in payload["lines"]
        if isinstance(item, dict)
    )
    if len(lines) != len(payload["lines"]):
        raise ValueError("adjustment command lines contain an invalid row")
    return AdjustmentCommand(
        family_id=str(payload["family_id"]),
        source_event_id=str(payload["source_event_id"]),
        source_reservation_id=(
            str(payload["source_reservation_id"])
            if payload.get("source_reservation_id")
            else None
        ),
        idempotency_key=str(payload["idempotency_key"]),
        fingerprint=str(payload["fingerprint"]),
        reason_code=str(payload["reason_code"]),
        operator=str(payload["operator"]),
        change_ticket=str(payload["change_ticket"]),
        evidence_ref=str(payload["evidence_ref"]),
        lines=lines,
        confirm_checksum=(
            str(payload["confirm_checksum"]) if payload.get("confirm_checksum") else None
        ),
    )


def _preflight_health_payload() -> tuple[bool, dict[str, object]]:
    settings = get_settings()
    try:
        keyring = decode_receipt_integrity_keyring(settings)
        keyring_payload = keyring.health_payload
        keyring_healthy = True
    except ModelUsageError as exc:
        keyring_payload = {"error": exc.code}
        keyring_healthy = False
    try:
        coverage = check_price_coverage_batch()
        coverage_payload: dict[str, object] = {
            "healthy": coverage.healthy,
            "priceVersionId": coverage.price_version_id,
            "missing": sorted(
                {
                    row.capability
                    for row in coverage.rows
                    if row.missing_meters
                }
            ),
        }
        coverage_healthy = coverage.healthy
    except Exception:
        coverage_payload = {
            "healthy": False,
            "priceVersionId": None,
            "missing": [],
            "error": "unavailable",
        }
        coverage_healthy = False
    try:
        with SessionLocal() as db:
            drifted = bool(
                db.scalar(
                    select(ModelUsagePeriodCounter)
                    .where(ModelUsagePeriodCounter.health_status != "healthy")
                    .limit(1)
                )
            )
    except Exception:
        drifted = True
    payload = {
        "healthy": keyring_healthy and coverage_healthy and not drifted,
        "receiptIntegrity": keyring_payload,
        "priceCoverage": coverage_payload,
        "counterDrift": drifted,
    }
    return bool(payload["healthy"]), payload


def handle_health(args: argparse.Namespace) -> int:
    healthy, payload = _preflight_health_payload()
    exit_code = 0 if healthy else 2
    if args.json:
        print(json.dumps({**payload, "exitCode": exit_code}, ensure_ascii=False, sort_keys=True))
    else:
        print("healthy" if healthy else "unhealthy")
    return exit_code


def handle_reconcile(args: argparse.Namespace) -> int:
    released = reconcile_reservations_batch(limit=args.limit)
    uncertain = query_uncertain_batch(limit=args.limit)
    print(json.dumps({"released": released, "uncertainReconciled": uncertain}, sort_keys=True))
    return 0


def handle_audit(args: argparse.Namespace) -> int:
    with SessionLocal() as db:
        with db.begin():
            report = audit_counters_batch(
                db,
                repair=args.repair,
                limit=args.limit,
                fail_closed=not args.fail_open,
                record_verification=not args.verify_only,
            )
    payload = {
        "healthy": report.healthy,
        "reports": len(report.reports),
        "errors": list(report.errors),
        "repaired": sum(item.repaired for item in report.reports),
    }
    exit_code = 0 if report.healthy or args.fail_open else 2
    payload["exitCode"] = exit_code
    print(json.dumps(payload, sort_keys=True))
    return exit_code


def handle_rollup(args: argparse.Namespace) -> int:
    period = _period(args.period)
    with SessionLocal() as db:
        with db.begin():
            result = rebuild_monthly_rollups(db, family_id=args.family_id, period=period)
    print(
        json.dumps(
            {"exitCode": 0, "revision": result.revision, "rows": len(result.rows)},
            sort_keys=True,
        )
    )
    return 0


def handle_prune(args: argparse.Namespace) -> int:
    target = RetentionTarget(args.family_id, _period(args.period))
    with SessionLocal() as db:
        with db.begin():
            result = prune_period(
                db,
                target,
                batch_size=args.batch_size,
                dry_run=args.dry_run,
                verify_only=args.verify_only,
            )
    print(
        json.dumps(
            {
                "eligible": result.verification.eligible,
                "failures": list(result.verification.failures),
                "deleted": result.deleted,
                "status": result.status.value,
                "dryRun": result.dry_run,
            },
            sort_keys=True,
        )
    )
    return 0 if result.verification.eligible else 2


def handle_adjustment(args: argparse.Namespace) -> int:
    command = _adjustment_command_from_file(args.file)
    with SessionLocal() as db:
        with db.begin():
            if args.adjustment_command == "preview":
                preview = preview_adjustment(db, command)
                payload = {"checksum": preview.checksum, "preview": dict(preview.payload)}
            else:
                result = apply_adjustment(db, command)
                payload = {
                    "groupId": result.group.id,
                    "checksum": result.preview.checksum if result.preview else None,
                    "alertIds": [alert.id for alert in result.alerts],
                }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
    return 0


def _instant(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("incident instant must be an ISO-8601 string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("incident instant must be timezone-aware")
    return parsed.astimezone(timezone.utc)


def handle_incident_record(args: argparse.Namespace) -> int:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("incident command must be an object")
    attempts = tuple(
        IncidentAttemptCommand(
            client_attempt_id=str(item["client_attempt_id"]),
            subject_id=(str(item["subject_id"]) if item.get("subject_id") else None),
            capability=_optional_enum(ModelUsageCapability, item.get("capability")),
        )
        for item in payload.get("attempts", [])
        if isinstance(item, dict)
    )
    if len(attempts) != len(payload.get("attempts", [])):
        raise ValueError("incident attempts contain an invalid row")
    with SessionLocal() as db:
        with db.begin():
            incident = record_incident(
                db,
                IncidentCommand(
                    incident_key=str(payload["incident_key"]),
                    family_id=(str(payload["family_id"]) if payload.get("family_id") else None),
                    subject_id=(str(payload["subject_id"]) if payload.get("subject_id") else None),
                    subject_key=(str(payload["subject_key"]) if payload.get("subject_key") else None),
                    capability=_optional_enum(ModelUsageCapability, payload.get("capability")),
                    period_start=_instant(payload["period_start"]),
                    period_end=_instant(payload["period_end"]),
                    mode=str(payload["mode"]),
                    cause_code=str(payload["cause_code"]),
                    started_at=_instant(payload["started_at"]),
                    recovered_at=(
                        _instant(payload["recovered_at"])
                        if payload.get("recovered_at")
                        else None
                    ),
                    coverage=ModelUsageIncidentCoverage(str(payload["coverage"])),
                    source_instance=str(payload.get("source_instance") or get_settings().model_usage_source_instance),
                    attempts=attempts,
                ),
            )
    print(json.dumps({"id": incident.id}, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Operate model-usage maintenance safely")
    subparsers = parser.add_subparsers(dest="command", required=True)

    health = subparsers.add_parser("health")
    health.add_argument("--json", action="store_true")
    health.set_defaults(handler=handle_health)

    reconcile = subparsers.add_parser("reconcile")
    reconcile.add_argument("--limit", type=int, default=100)
    reconcile.set_defaults(handler=handle_reconcile)

    audit = subparsers.add_parser("audit")
    audit_mode = audit.add_mutually_exclusive_group()
    audit_mode.add_argument("--repair", action="store_true")
    audit_mode.add_argument("--verify-only", action="store_true")
    audit.add_argument("--fail-open", action="store_true")
    audit.add_argument("--limit", type=int, default=100)
    audit.add_argument("--json", action="store_true")
    audit.set_defaults(handler=handle_audit)

    rollup = subparsers.add_parser("rollup")
    rollup.add_argument("--family", dest="family_id", required=True)
    rollup.add_argument("--period", required=True)
    rollup.add_argument("--json", action="store_true")
    rollup.set_defaults(handler=handle_rollup)

    prune = subparsers.add_parser("prune")
    prune.add_argument("--family", dest="family_id", required=True)
    prune.add_argument("--period", required=True)
    prune.add_argument("--batch-size", type=int, default=500)
    prune.add_argument("--dry-run", action="store_true")
    prune.add_argument("--verify-only", action="store_true")
    prune.set_defaults(handler=handle_prune)

    adjustment = subparsers.add_parser("adjustment")
    adjustment_commands = adjustment.add_subparsers(dest="adjustment_command", required=True)
    for name in ("preview", "apply"):
        command = adjustment_commands.add_parser(name)
        command.add_argument("--file", required=True)
        command.set_defaults(handler=handle_adjustment)

    incident = subparsers.add_parser("incident")
    incident_commands = incident.add_subparsers(dest="incident_command", required=True)
    record = incident_commands.add_parser("record")
    record.add_argument("--file", required=True)
    record.set_defaults(handler=handle_incident_record)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except (ModelUsageError, ValueError, KeyError, json.JSONDecodeError) as exc:
        # Commands take only operational metadata/IDs.  Keep output stable and
        # content-free even when a supplied JSON file is malformed.
        print(getattr(exc, "code", "model_usage_maintenance_cli_failed"), file=sys.stderr)
        return 2
    except Exception:
        print("model_usage_maintenance_cli_failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
