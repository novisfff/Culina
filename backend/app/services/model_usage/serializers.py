from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.core.enums import ModelUsageIncidentCoverage
from app.services.model_usage.aggregation import UsageAggregate, UsageGapInterval
from app.services.model_usage.queries import (
    UsageBreakdown,
    UsageBreakdownItem,
    UsageOverview,
)
from app.services.model_usage.policies import policy_limits
from app.services.model_usage.periods import SHANGHAI


def decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, ".12f")


def _utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def serialize_cost_summary(aggregate: UsageAggregate) -> dict[str, object]:
    payload: dict[str, object] = {
        "known_priced_cost_cny": decimal_text(aggregate.known_priced_cost_cny),
        "pricing_complete": aggregate.pricing_complete,
        "unpriced_event_count": aggregate.unpriced_event_count,
    }
    if aggregate.pricing_complete:
        payload["total_cost_cny"] = decimal_text(aggregate.known_priced_cost_cny)
    return payload


def _public_gap_scope(
    scope: tuple[str, ...],
    *,
    coverage: ModelUsageIncidentCoverage,
) -> list[str]:
    if coverage is ModelUsageIncidentCoverage.UNKNOWN_SCOPE:
        return ["unknown_scope"]
    values: set[str] = set()
    for value in scope:
        if value in {"global", "family"}:
            values.add(value)
        elif value.startswith("capability:"):
            values.add(value)
    return sorted(values)


def _serialize_gap_interval(interval: UsageGapInterval) -> dict[str, object]:
    return {
        "started_at": interval.started_at,
        "ended_at": interval.ended_at,
        "scope": _public_gap_scope(interval.scope, coverage=interval.coverage),
        "coverage": interval.coverage,
    }


def serialize_measurement_health(aggregate: UsageAggregate) -> dict[str, object]:
    public_scopes: set[str] = set()
    for interval in aggregate.gap_intervals:
        public_scopes.update(
            _public_gap_scope(interval.scope, coverage=interval.coverage)
        )
    if not aggregate.gap_intervals:
        public_scopes.update(
            value
            for value in aggregate.measurement_gap_scope
            if value in {"global", "family", "unknown_scope"}
            or value.startswith("capability:")
        )
    return {
        "exact_event_count": aggregate.exact_event_count,
        "estimated_event_count": aggregate.estimated_event_count,
        "unpriced_event_count": aggregate.unpriced_event_count,
        "uncertain_attempt_count": aggregate.uncertain_attempt_count,
        "pending_attempt_count": aggregate.pending_attempt_count,
        "unresolved_unknown_execution_attempt_count": (
            aggregate.unresolved_unknown_execution_attempt_count
        ),
        "conservative_estimated_cost_cny": decimal_text(
            aggregate.conservative_estimated_cost_cny
        ),
        "known_unmeasured_attempt_count": aggregate.known_unmeasured_attempt_count,
        "measurement_gap": aggregate.measurement_gap,
        "measurement_gap_scope": sorted(public_scopes),
        "gap_intervals": [
            _serialize_gap_interval(interval) for interval in aggregate.gap_intervals
        ],
    }


def serialize_meter_totals(aggregate: UsageAggregate) -> list[dict[str, object]]:
    return [
        {
            "meter": meter,
            "quantity": decimal_text(quantity),
        }
        for meter, quantity in sorted(
            aggregate.meter_totals.items(), key=lambda item: item[0].value
        )
    ]


def _serialize_overview_base(overview: UsageOverview) -> dict[str, object]:
    return {
        "family_id": overview.family_id,
        "period": overview.period.local_month,
        "source": overview.source,
        "is_partial_period": overview.is_partial_period,
        "tracking_started_at": _utc_datetime(overview.tracking_started_at),
        **serialize_cost_summary(overview.aggregate),
        "meter_totals": serialize_meter_totals(overview.aggregate),
        "measurement_health": serialize_measurement_health(overview.aggregate),
    }


def serialize_personal_overview(overview: UsageOverview) -> dict[str, object]:
    if overview.scope != "me" or overview.family_budget_state is None:
        raise ValueError("model_usage_personal_overview_required")
    return {
        **_serialize_overview_base(overview),
        "scope": "me",
        "family_budget_state": overview.family_budget_state,
    }


def serialize_family_overview(overview: UsageOverview) -> dict[str, object]:
    if overview.scope != "family":
        raise ValueError("model_usage_family_overview_required")
    return {
        **_serialize_overview_base(overview),
        "scope": "family",
        "monthly_budget_cny": decimal_text(overview.monthly_budget_cny),
        "effective_spend_cny": decimal_text(overview.effective_spend_cny),
        "reserved_cost_cny": decimal_text(overview.reserved_cost_cny),
        "hard_limit_enabled": overview.hard_limit_enabled,
    }


def _serialize_breakdown_item(item: UsageBreakdownItem) -> dict[str, object]:
    return {
        "label": item.label,
        "capability": item.capability,
        "provider": item.provider,
        "billing_model": item.billing_model,
        "meter": item.meter,
        "meter_total": decimal_text(item.meter_total),
        "local_day": item.local_day.isoformat() if item.local_day is not None else None,
        **serialize_cost_summary(item.aggregate),
        "measurement_health": serialize_measurement_health(item.aggregate),
    }


def serialize_usage_breakdown(breakdown: UsageBreakdown) -> dict[str, object]:
    if breakdown.scope not in {"family", "me"}:
        raise ValueError("model_usage_breakdown_scope_required")
    return {
        "family_id": breakdown.family_id,
        "scope": breakdown.scope,
        "period": breakdown.period.local_month,
        "source": breakdown.source,
        "is_partial_period": breakdown.is_partial_period,
        "group_by": breakdown.group_by,
        "items": [_serialize_breakdown_item(item) for item in breakdown.items],
    }


def serialize_policy(db, policy) -> dict[str, object]:
    return {
        "version_number": policy.version_number,
        "monthly_budget_cny": decimal_text(policy.monthly_budget_cny),
        "alerts_enabled": policy.alerts_enabled,
        "hard_limit_enabled": policy.hard_limit_enabled,
        "budget_alert_revision": policy.budget_alert_revision,
        "capability_limits": [
            {
                "capability": limit.capability,
                "limit_kind": limit.limit_kind,
                "meter": limit.meter,
                "limit_value": decimal_text(limit.limit_value),
                "enabled": limit.enabled,
            }
            for limit in policy_limits(db, policy_version_id=policy.id)
        ],
        "effective_at": _utc_datetime(policy.effective_at),
    }


def serialize_alert_receipt(receipt) -> dict[str, object]:
    return {
        "alert_id": receipt.alert_id,
        "seen_at": _utc_datetime(receipt.seen_at),
        "dismissed_at": _utc_datetime(receipt.dismissed_at),
    }


def serialize_alert(alert, receipt) -> dict[str, object]:
    return {
        "id": alert.id,
        "period": _utc_datetime(alert.period_start).astimezone(SHANGHAI).strftime("%Y-%m"),
        "threshold": decimal_text(alert.threshold),
        "budget_cny": decimal_text(alert.budget_cny),
        "settled_value": decimal_text(alert.settled_value),
        "adjustment_value": decimal_text(alert.adjustment_value),
        "effective_spend_cny": decimal_text(alert.effective_spend_cny),
        "severity": alert.severity,
        "created_at": _utc_datetime(alert.created_at),
        **serialize_alert_receipt(receipt),
    }
