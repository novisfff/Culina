from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.enums import (
    ModelUsageCapability,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.db.session import SessionLocal
from app.models.domain import Family
from app.models.model_usage import (
    ModelUsageFamilyPolicy,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    configured_usage_variants,
)
from app.services.model_usage.errors import ModelUsageError, ModelUsagePreflightError
from app.services.model_usage.provider_registry import (
    ProviderUsageRegistration,
    discover_remote_send_points,
    discover_sdk_retry_configuration_gaps,
    provider_usage_registrations,
    registry_send_points,
)
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


@dataclass(frozen=True, slots=True)
class FirstLaunchPreflightReport:
    """Content-free, all-or-nothing evidence for the first public opening.

    This is deliberately separate from the startup preflight.  A first launch
    needs an empty active-attempt namespace, while later restarts must not
    treat a legitimate in-flight provider operation as a deployment failure.
    """

    required_capabilities: frozenset[ModelUsageCapability]
    configured_capabilities: frozenset[ModelUsageCapability]
    missing_capabilities: frozenset[ModelUsageCapability]
    source_migration_heads: frozenset[str]
    database_migration_heads: frozenset[str]
    database_at_head: bool
    migration_error: str | None
    missing_schema_tables: frozenset[str]
    missing_idempotency_uniques: frozenset[str]
    families_missing_default_policies: int
    families_missing_subjects: int
    unregistered_send_points: frozenset[str]
    stale_registry_send_points: frozenset[str]
    registry_errors: frozenset[str]
    missing_guardrail_meter_coverage: frozenset[str]
    unsupported_lease_boundary_cumulative_meters: frozenset[str]
    invalid_recovery_policies: frozenset[str]
    receipt_integrity_keyring_valid: bool
    receipt_integrity_error: str | None
    price_coverage: PriceCoverageReport
    price_coverage_healthy: bool
    price_coverage_error: str | None
    maintenance_enabled: bool
    fail_open_proof_ttl_valid: bool
    sdk_retry_configuration_gaps: frozenset[str]
    active_provider_attempts: int

    @property
    def blockers(self) -> tuple[str, ...]:
        blockers: list[str] = []
        if self.migration_error is not None:
            blockers.append(self.migration_error)
        elif not self.database_at_head:
            blockers.append("database_not_at_current_alembic_head")
        if self.missing_schema_tables:
            blockers.append("model_usage_schema_tables_missing")
        if self.missing_idempotency_uniques:
            blockers.append("model_usage_idempotency_uniques_missing")
        if self.families_missing_default_policies:
            blockers.append("model_usage_default_policies_missing")
        if self.families_missing_subjects:
            blockers.append("model_usage_default_subjects_missing")
        if self.missing_capabilities:
            blockers.append("model_usage_required_capabilities_missing")
        if self.unregistered_send_points:
            blockers.append("model_usage_provider_send_points_unregistered")
        if self.stale_registry_send_points:
            blockers.append("model_usage_provider_send_registry_stale")
        blockers.extend(sorted(self.registry_errors))
        if self.missing_guardrail_meter_coverage:
            blockers.append("model_usage_guardrail_meter_coverage_missing")
        if self.unsupported_lease_boundary_cumulative_meters:
            blockers.append("model_usage_lease_boundary_meter_unsupported")
        if self.invalid_recovery_policies:
            blockers.append("model_usage_recovery_policy_invalid")
        if not self.receipt_integrity_keyring_valid:
            blockers.append(self.receipt_integrity_error or "receipt_integrity_keyring_invalid")
        if self.price_coverage_error is not None:
            blockers.append(self.price_coverage_error)
        elif not self.price_coverage_healthy:
            blockers.append("model_usage_price_coverage_missing")
        if not self.maintenance_enabled:
            blockers.append("model_usage_maintenance_disabled")
        if not self.fail_open_proof_ttl_valid:
            blockers.append("model_usage_fail_open_proof_ttl_invalid")
        if self.sdk_retry_configuration_gaps:
            blockers.append("model_usage_sdk_retries_not_disabled")
        if self.active_provider_attempts:
            blockers.append("model_usage_active_provider_attempts_present")
        return tuple(blockers)

    @property
    def ready(self) -> bool:
        return not self.blockers

    def as_dict(self) -> dict[str, object]:
        """Return a safe report payload without receipt key or request content."""

        return {
            "ready": self.ready,
            "blockers": list(self.blockers),
            "requiredCapabilities": sorted(item.value for item in self.required_capabilities),
            "configuredCapabilities": sorted(item.value for item in self.configured_capabilities),
            "missingCapabilities": sorted(item.value for item in self.missing_capabilities),
            "sourceMigrationHeads": sorted(self.source_migration_heads),
            "databaseMigrationHeads": sorted(self.database_migration_heads),
            "databaseAtHead": self.database_at_head,
            "migrationError": self.migration_error,
            "missingSchemaTables": sorted(self.missing_schema_tables),
            "missingIdempotencyUniques": sorted(self.missing_idempotency_uniques),
            "familiesMissingDefaultPolicies": self.families_missing_default_policies,
            "familiesMissingSubjects": self.families_missing_subjects,
            "unregisteredSendPoints": sorted(self.unregistered_send_points),
            "staleRegistrySendPoints": sorted(self.stale_registry_send_points),
            "registryErrors": sorted(self.registry_errors),
            "missingGuardrailMeterCoverage": sorted(self.missing_guardrail_meter_coverage),
            "unsupportedLeaseBoundaryCumulativeMeters": sorted(
                self.unsupported_lease_boundary_cumulative_meters
            ),
            "invalidRecoveryPolicies": sorted(self.invalid_recovery_policies),
            "receiptIntegrityKeyringValid": self.receipt_integrity_keyring_valid,
            "receiptIntegrityError": self.receipt_integrity_error,
            "priceCoverage": {
                "healthy": self.price_coverage_healthy,
                "error": self.price_coverage_error,
                "priceVersionId": self.price_coverage.price_version_id,
                "missingCapabilities": sorted(
                    {
                        row.capability
                        for row in self.price_coverage.rows
                        if row.missing_meters
                    }
                ),
            },
            "maintenanceEnabled": self.maintenance_enabled,
            "failOpenProofTtlValid": self.fail_open_proof_ttl_valid,
            "sdkRetryConfigurationGaps": sorted(self.sdk_retry_configuration_gaps),
            "activeProviderAttempts": self.active_provider_attempts,
        }


_REQUIRED_MODEL_USAGE_TABLES = frozenset(
    {
        "model_usage_events",
        "model_usage_reservations",
        "model_usage_adjustment_groups",
        "model_usage_period_counters",
        "model_usage_monthly_rollups",
        "model_usage_realtime_watermarks",
    }
)
_REQUIRED_IDEMPOTENCY_UNIQUES = (
    ("model_usage_reservations", frozenset({"family_id", "attempt_key"})),
    ("model_usage_events", frozenset({"family_id", "attempt_key"})),
    ("model_usage_adjustment_groups", frozenset({"family_id", "idempotency_key"})),
)
_ACTIVE_PROVIDER_ATTEMPT_STATUSES = frozenset(
    {
        ModelUsageReservationStatus.RESERVED,
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.UNCERTAIN,
    }
)


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


def _has_unique_columns(
    inspector: object,
    *,
    table_name: str,
    required_columns: frozenset[str],
) -> bool:
    get_unique_constraints = getattr(inspector, "get_unique_constraints")
    constraints = get_unique_constraints(table_name)
    if any(
        set(constraint.get("column_names") or ()) == required_columns
        for constraint in constraints
    ):
        return True
    get_indexes = getattr(inspector, "get_indexes")
    return any(
        index.get("unique")
        and set(index.get("column_names") or ()) == required_columns
        for index in get_indexes(table_name)
    )


def schema_preflight_gaps(db: Session) -> tuple[frozenset[str], frozenset[str]]:
    """Inspect actual database constraints rather than trusting ORM metadata."""

    # Inspect through the caller's active connection.  Opening a second Engine
    # connection can roll back an in-progress SQLite transaction and makes a
    # release preflight observe a different transactional snapshot.
    inspector = inspect(db.connection())
    existing_tables = set(inspector.get_table_names())
    missing_tables = frozenset(_REQUIRED_MODEL_USAGE_TABLES - existing_tables)
    missing_uniques = frozenset(
        f"{table_name}:{','.join(sorted(columns))}"
        for table_name, columns in _REQUIRED_IDEMPOTENCY_UNIQUES
        if table_name not in missing_tables
        and not _has_unique_columns(
            inspector,
            table_name=table_name,
            required_columns=columns,
        )
    )
    return missing_tables, missing_uniques


def _require_schema_constraints(db: Session) -> None:
    missing_tables, missing_uniques = schema_preflight_gaps(db)
    if missing_tables:
        raise ModelUsagePreflightError("model_usage_migration_missing")
    if missing_uniques:
        # Keep the pre-existing daily-startup error code stable for callers.
        raise ModelUsagePreflightError("model_usage_event_idempotency_unique_missing")


def family_default_preflight_gaps(db: Session) -> tuple[int, int]:
    family_ids = tuple(db.scalars(select(Family.id).order_by(Family.id)))
    if not family_ids:
        return 0, 0
    policy_family_ids = set(db.scalars(select(ModelUsageFamilyPolicy.family_id)))
    subject_family_ids = set(db.scalars(select(ModelUsageSubject.family_id)))
    return (
        sum(family_id not in policy_family_ids for family_id in family_ids),
        sum(family_id not in subject_family_ids for family_id in family_ids),
    )


def _require_family_policy_and_subjects(db: Session) -> None:
    missing_policies, missing_subjects = family_default_preflight_gaps(db)
    if missing_policies:
        raise ModelUsagePreflightError("model_usage_family_policy_missing")
    if missing_subjects:
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


def source_migration_heads() -> frozenset[str]:
    """Resolve source Alembic heads without depending on the process cwd."""

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    backend_root = Path(__file__).resolve().parents[3]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


def database_migration_heads(db: Session) -> frozenset[str]:
    """Read the database revision table directly and support multiple heads."""

    inspector = inspect(db.connection())
    if "alembic_version" not in set(inspector.get_table_names()):
        return frozenset()
    return frozenset(
        str(value)
        for value in db.scalars(text("SELECT version_num FROM alembic_version"))
        if value is not None
    )


def _guardrail_meter_coverage_gaps(
    registrations: tuple[ProviderUsageRegistration, ...],
) -> frozenset[str]:
    """Require every active variant to produce each guardrail meter it exposes."""

    by_capability: dict[ModelUsageCapability, list[ProviderUsageRegistration]] = {}
    for registration in registrations:
        by_capability.setdefault(registration.capability, []).append(registration)
    gaps: set[str] = set()
    for capability, capability_registrations in by_capability.items():
        exposed = frozenset().union(
            *(registration.produced_guardrail_meters for registration in capability_registrations)
        )
        for registration in capability_registrations:
            for meter in exposed - registration.produced_guardrail_meters:
                gaps.add(f"{capability.value}:{meter.value}")
    return frozenset(gaps)


def _unsupported_lease_boundary_cumulative_meters(
    registrations: tuple[ProviderUsageRegistration, ...],
) -> frozenset[str]:
    unsupported: set[str] = set()
    for registration in registrations:
        if registration.capability is not ModelUsageCapability.REALTIME_AUDIO:
            unsupported.update(
                f"{registration.capability.value}:{meter.value}"
                for meter in registration.lease_boundary_cumulative_meters
            )
            continue
        unsupported.update(
            f"{registration.capability.value}:{meter.value}"
            for meter in (
                registration.lease_boundary_cumulative_meters
                - registration.produced_guardrail_meters
            )
        )
    return frozenset(unsupported)


def _invalid_recovery_policies(
    registrations: tuple[ProviderUsageRegistration, ...],
) -> frozenset[str]:
    """Fail closed until a non-none provider recovery contract is auditable."""

    invalid: set[str] = set()
    for registration in registrations:
        policy = registration.recovery_policy
        if policy.mode is ModelUsageRecoveryMode.NONE:
            if any(
                value is not None
                for value in (
                    policy.idempotency_window_seconds,
                    policy.query_window_seconds,
                    policy.automatic_resend_deadline_seconds,
                )
            ):
                invalid.add(f"{registration.capability.value}:none_policy_has_windows")
            continue
        # The static registry currently has no persisted provider-evidence
        # contract for an idempotent/queryable mode.  Treating one as launch
        # ready would make an unsupported claim about external recovery.
        invalid.add(f"{registration.capability.value}:non_none_policy_unreviewed")
    return frozenset(invalid)


def _registry_materialization_errors(
    registrations: tuple[ProviderUsageRegistration, ...],
) -> frozenset[str]:
    errors: set[str] = set()
    known_send_points = registry_send_points()
    for registration in registrations:
        if not registration.source_send_points:
            errors.add(f"{registration.capability.value}:source_send_points_missing")
        if not registration.source_send_points <= known_send_points:
            errors.add(f"{registration.capability.value}:source_send_points_unknown")
    return frozenset(errors)


def _fail_open_proof_ttl_is_valid(settings: object) -> bool:
    ttl = getattr(settings, "model_usage_fail_open_proof_ttl_seconds", None)
    if type(ttl) is not int or ttl <= 0:
        return False
    timeout_names = (
        "ai_timeout_seconds",
        "ai_stt_timeout_seconds",
        "ai_tts_timeout_seconds",
        "ai_realtime_timeout_seconds",
        "search_embedding_timeout_seconds",
        "search_rerank_timeout_seconds",
        "qdrant_timeout_seconds",
    )
    timeouts: list[float] = []
    for name in timeout_names:
        value = getattr(settings, name, None)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            return False
        timeouts.append(float(value))
    return ttl < min(timeouts)


def _empty_price_coverage() -> PriceCoverageReport:
    return PriceCoverageReport(price_version_id=None, rows=())


def _stable_error_code(error: Exception, *, fallback: str) -> str:
    return error.code if isinstance(error, ModelUsageError) else fallback


def _first_launch_database_state(
    db: Session,
    *,
    variants: tuple[ConfiguredUsageVariant, ...],
    at: datetime,
) -> tuple[
    frozenset[str],
    frozenset[str],
    int,
    int,
    frozenset[str],
    PriceCoverageReport,
    bool,
    str | None,
]:
    missing_tables, missing_uniques = schema_preflight_gaps(db)
    missing_policies, missing_subjects = family_default_preflight_gaps(db)
    database_heads = database_migration_heads(db)
    try:
        coverage = price_coverage(db, configured_variants=variants, at=at)
    except Exception as exc:
        return (
            missing_tables,
            missing_uniques,
            missing_policies,
            missing_subjects,
            database_heads,
            _empty_price_coverage(),
            False,
            _stable_error_code(exc, fallback="model_usage_price_coverage_unavailable"),
        )
    return (
        missing_tables,
        missing_uniques,
        missing_policies,
        missing_subjects,
        database_heads,
        coverage,
        coverage.healthy,
        None,
    )


def run_first_launch_preflight(
    settings: Settings,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    db: Session | None = None,
    at: datetime | None = None,
    app_root: Path | None = None,
) -> FirstLaunchPreflightReport:
    """Collect all first-launch gates without sending a Provider request.

    The report intentionally returns a blocked result rather than raising for
    ordinary launch gaps, so the release report can record exactly which
    evidence is absent.  Database/registry exceptions are reduced to stable
    codes and never echo a connection string, key, prompt, or provider payload.
    """

    required_capabilities = frozenset(ModelUsageCapability)
    now = (at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    root = app_root or Path(__file__).resolve().parents[2]

    try:
        variants = configured_usage_variants(settings)
    except Exception as exc:
        variants = ()
        registry_errors = {"configured_usage_variant_invalid"}
        if isinstance(exc, ModelUsageError):
            registry_errors.add(exc.code)
    else:
        registry_errors = set()
    configured_capabilities = frozenset(variant.capability for variant in variants)

    try:
        registrations = provider_usage_registrations(settings)
    except Exception as exc:
        registrations = ()
        registry_errors.add(_stable_error_code(exc, fallback="model_usage_provider_registry_unavailable"))
    else:
        registry_errors.update(_registry_materialization_errors(registrations))

    try:
        inventory = discover_remote_send_points(root)
    except Exception as exc:
        inventory_model_provider = frozenset()
        registry_errors.add(
            _stable_error_code(exc, fallback="model_usage_provider_inventory_unavailable")
        )
    else:
        inventory_model_provider = inventory.model_provider
    registered_send_points = registry_send_points()
    unregistered_send_points = inventory_model_provider - registered_send_points
    stale_registry_send_points = registered_send_points - inventory_model_provider

    try:
        sdk_retry_configuration_gaps = discover_sdk_retry_configuration_gaps(root)
    except Exception as exc:
        sdk_retry_configuration_gaps = frozenset({
            _stable_error_code(exc, fallback="model_usage_sdk_retry_configuration_unavailable")
        })

    try:
        expected_heads = source_migration_heads()
    except Exception:
        expected_heads = frozenset()
        migration_error = "source_alembic_heads_unavailable"
    else:
        migration_error = None

    try:
        decode_receipt_integrity_keyring(settings, now=now)
    except Exception as exc:
        receipt_integrity_keyring_valid = False
        receipt_integrity_error = _stable_error_code(
            exc,
            fallback="receipt_integrity_keyring_invalid",
        )
    else:
        receipt_integrity_keyring_valid = True
        receipt_integrity_error = None

    def inspect_database(session: Session) -> tuple[
        frozenset[str],
        frozenset[str],
        int,
        int,
        frozenset[str],
        PriceCoverageReport,
        bool,
        str | None,
        int,
    ]:
        (
            missing_tables,
            missing_uniques,
            missing_policies,
            missing_subjects,
            database_heads,
            coverage,
            coverage_healthy,
            coverage_error,
        ) = _first_launch_database_state(session, variants=variants, at=now)
        active_attempts = int(
            session.scalar(
                select(func.count())
                .select_from(ModelUsageReservation)
                .where(ModelUsageReservation.status.in_(_ACTIVE_PROVIDER_ATTEMPT_STATUSES))
            )
            or 0
        )
        return (
            missing_tables,
            missing_uniques,
            missing_policies,
            missing_subjects,
            database_heads,
            coverage,
            coverage_healthy,
            coverage_error,
            active_attempts,
        )

    try:
        if db is None:
            with session_factory() as session:
                database_state = inspect_database(session)
        else:
            database_state = inspect_database(db)
    except Exception as exc:
        database_state = (
            frozenset(),
            frozenset(),
            0,
            0,
            frozenset(),
            _empty_price_coverage(),
            False,
            _stable_error_code(exc, fallback="model_usage_first_launch_database_unavailable"),
            0,
        )

    (
        missing_schema_tables,
        missing_idempotency_uniques,
        families_missing_default_policies,
        families_missing_subjects,
        database_heads,
        coverage,
        coverage_healthy,
        coverage_error,
        active_provider_attempts,
    ) = database_state
    database_at_head = bool(expected_heads) and database_heads == expected_heads
    return FirstLaunchPreflightReport(
        required_capabilities=required_capabilities,
        configured_capabilities=configured_capabilities,
        missing_capabilities=required_capabilities - configured_capabilities,
        source_migration_heads=expected_heads,
        database_migration_heads=database_heads,
        database_at_head=database_at_head,
        migration_error=migration_error,
        missing_schema_tables=missing_schema_tables,
        missing_idempotency_uniques=missing_idempotency_uniques,
        families_missing_default_policies=families_missing_default_policies,
        families_missing_subjects=families_missing_subjects,
        unregistered_send_points=unregistered_send_points,
        stale_registry_send_points=stale_registry_send_points,
        registry_errors=frozenset(registry_errors),
        missing_guardrail_meter_coverage=_guardrail_meter_coverage_gaps(registrations),
        unsupported_lease_boundary_cumulative_meters=(
            _unsupported_lease_boundary_cumulative_meters(registrations)
        ),
        invalid_recovery_policies=_invalid_recovery_policies(registrations),
        receipt_integrity_keyring_valid=receipt_integrity_keyring_valid,
        receipt_integrity_error=receipt_integrity_error,
        price_coverage=coverage,
        price_coverage_healthy=coverage_healthy,
        price_coverage_error=coverage_error,
        maintenance_enabled=bool(
            getattr(settings, "model_usage_maintenance_enabled", False)
        ),
        fail_open_proof_ttl_valid=_fail_open_proof_ttl_is_valid(settings),
        sdk_retry_configuration_gaps=sdk_retry_configuration_gaps,
        active_provider_attempts=active_provider_attempts,
    )


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
