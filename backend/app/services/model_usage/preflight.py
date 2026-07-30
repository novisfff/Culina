from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.enums import ModelUsageCapability
from app.db.session import SessionLocal
from app.models.domain import Family
from app.models.model_usage import ModelUsageFamilyPolicy, ModelUsageSubject
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.errors import ModelUsagePreflightError
from app.services.model_usage.pricing import PriceCoverageReport, price_coverage
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import CAPABILITY_METER_CONTRACTS


@dataclass(frozen=True, slots=True)
class ReceiptIntegrityKey:
    key_id: str
    material: bytes
    retire_after: datetime | None


@dataclass(frozen=True, slots=True)
class ReceiptIntegrityKeyring:
    active_key_id: str
    keys: Mapping[str, ReceiptIntegrityKey]

    def signer(self) -> ProviderUsageReceiptSigner:
        return ProviderUsageReceiptSigner(
            active_key_id=self.active_key_id,
            keys={key_id: item.material for key_id, item in self.keys.items()},
        )

    @property
    def health_payload(self) -> dict[str, object]:
        return {
            "activeKeyId": self.active_key_id,
            "keys": [
                {
                    "keyId": key_id,
                    "retireAfter": (
                        item.retire_after.astimezone(timezone.utc).isoformat()
                        if item.retire_after is not None
                        else None
                    ),
                }
                for key_id, item in sorted(self.keys.items())
            ],
        }


@dataclass(frozen=True, slots=True)
class ModelUsagePreflightReport:
    keyring: ReceiptIntegrityKeyring
    price_coverage: PriceCoverageReport
    configured_capabilities: tuple[ModelUsageCapability, ...]


def _parse_retire_after(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ModelUsagePreflightError("receipt_integrity_key_retirement_invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ModelUsagePreflightError(
            "receipt_integrity_key_retirement_invalid"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ModelUsagePreflightError("receipt_integrity_key_retirement_invalid")
    return parsed.astimezone(timezone.utc)


def decode_receipt_integrity_keyring(
    settings: Settings,
    *,
    now: datetime | None = None,
) -> ReceiptIntegrityKeyring:
    """Decode the dedicated receipt-HMAC keyring without exposing key material.

    The secret is deliberately parsed only at the deployment boundary.  Callers
    receive a signer and a redacted health payload, never a serializable secret.
    """

    active_key_id = settings.model_usage_receipt_integrity_active_key_id.strip()
    secret = settings.model_usage_receipt_integrity_keys_json.get_secret_value()
    if not active_key_id or not secret.strip():
        raise ModelUsagePreflightError("receipt_integrity_keyring_required")
    try:
        raw = json.loads(secret)
    except json.JSONDecodeError as exc:
        raise ModelUsagePreflightError("receipt_integrity_keyring_invalid") from exc
    if not isinstance(raw, dict):
        raise ModelUsagePreflightError("receipt_integrity_keyring_invalid")

    keys: dict[str, ReceiptIntegrityKey] = {}
    for key_id, value in raw.items():
        if not isinstance(key_id, str) or not key_id.strip() or not isinstance(value, dict):
            raise ModelUsagePreflightError("receipt_integrity_keyring_invalid")
        material = value.get("key")
        if not isinstance(material, str) or not material:
            raise ModelUsagePreflightError("receipt_integrity_keyring_invalid")
        keys[key_id] = ReceiptIntegrityKey(
            key_id=key_id,
            material=material.encode("utf-8"),
            retire_after=_parse_retire_after(value.get("retireAfter")),
        )
    active = keys.get(active_key_id)
    if active is None:
        raise ModelUsagePreflightError("receipt_integrity_active_key_missing")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if active.retire_after is not None and active.retire_after <= current:
        raise ModelUsagePreflightError("receipt_integrity_key_expired")
    return ReceiptIntegrityKeyring(active_key_id=active_key_id, keys=keys)


def _require_schema_constraints(db: Session) -> None:
    bind = db.get_bind()
    inspector = inspect(bind)
    required_tables = {
        "model_usage_events",
        "model_usage_reservations",
        "model_usage_adjustment_groups",
        "model_usage_period_counters",
        "model_usage_monthly_rollups",
        "model_usage_realtime_watermarks",
    }
    existing_tables = set(inspector.get_table_names())
    missing_tables = sorted(required_tables - existing_tables)
    if missing_tables:
        raise ModelUsagePreflightError("model_usage_migration_missing")

    unique_constraints = inspector.get_unique_constraints("model_usage_events")
    has_attempt_key = any(
        set(constraint.get("column_names") or ()) == {"family_id", "attempt_key"}
        for constraint in unique_constraints
    )
    if not has_attempt_key:
        # SQLite reports table-level unique constraints here; MySQL does too.
        unique_indexes = inspector.get_indexes("model_usage_events")
        has_attempt_key = any(
            index.get("unique")
            and set(index.get("column_names") or ()) == {"family_id", "attempt_key"}
            for index in unique_indexes
        )
    if not has_attempt_key:
        raise ModelUsagePreflightError("model_usage_event_idempotency_unique_missing")


def _require_family_policy_and_subjects(db: Session) -> None:
    family_ids = tuple(db.scalars(select(Family.id).order_by(Family.id)))
    if not family_ids:
        return
    policy_family_ids = set(db.scalars(select(ModelUsageFamilyPolicy.family_id)))
    subject_family_ids = set(db.scalars(select(ModelUsageSubject.family_id)))
    for family_id in family_ids:
        if family_id not in policy_family_ids:
            raise ModelUsagePreflightError("model_usage_family_policy_missing")
        if family_id not in subject_family_ids:
            raise ModelUsagePreflightError("model_usage_subject_missing")


def _require_capability_contract_coverage() -> None:
    covered = {capability for capability, _ in CAPABILITY_METER_CONTRACTS}
    for capability in ModelUsageCapability:
        if capability not in covered:
            raise ModelUsagePreflightError(f"{capability.value}:meter_contract_missing")


def _require_price_coverage(report: PriceCoverageReport) -> None:
    if not report.rows:
        return
    if report.price_version_id is None:
        missing = sorted({row.capability for row in report.rows})
        raise ModelUsagePreflightError(f"{','.join(missing)}:missing")
    missing = sorted(
        {
            row.capability
            for row in report.rows
            if row.missing_meters
        }
    )
    if missing:
        raise ModelUsagePreflightError(f"{','.join(missing)}:missing")


def run_model_usage_preflight(
    settings: Settings,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    db: Session | None = None,
    at: datetime | None = None,
) -> ModelUsagePreflightReport:
    """Verify required-mode prerequisites without changing user ledger data."""

    keyring = decode_receipt_integrity_keyring(settings, now=at)
    _require_capability_contract_coverage()
    try:
        variants = configured_usage_variants(settings)
    except Exception as exc:
        raise ModelUsagePreflightError("configured_usage_variant_invalid") from exc
    def check(session: Session) -> PriceCoverageReport:
        _require_schema_constraints(session)
        _require_family_policy_and_subjects(session)
        coverage = price_coverage(
            session,
            configured_variants=variants,
            at=(at or datetime.now(timezone.utc)).astimezone(timezone.utc),
        )
        _require_price_coverage(coverage)
        return coverage

    if db is None:
        with session_factory() as session:
            coverage = check(session)
    else:
        coverage = check(db)
    return ModelUsagePreflightReport(
        keyring=keyring,
        price_coverage=coverage,
        configured_capabilities=tuple(
            sorted({variant.capability for variant in variants}, key=lambda item: item.value)
        ),
    )
