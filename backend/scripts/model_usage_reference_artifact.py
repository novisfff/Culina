from __future__ import annotations

"""Collect content-free reference performance evidence from pytest.

The reference tests record only aggregate timings and query counts on the
pytest config object.  The session-finish hook calls this module after pytest
has determined the complete exit status, so a partially passing test run can
never emit a passing launch artifact.
"""

import json
import math
import os
from pathlib import Path
from typing import Mapping

from app.services.model_usage.reference_targets import (
    REFERENCE_LATENCY_TARGETS_MS,
    REFERENCE_QUERY_COUNT_TARGETS,
)


REFERENCE_PROFILE = "culina-first-launch-mysql84-v1"
REFERENCE_SCHEMA_VERSION = "model_usage_reference_performance.v1"
REFERENCE_OUTPUT_ENV = "MODEL_USAGE_REFERENCE_OUTPUT"
REFERENCE_SAMPLE_COUNT = 20
_LATENCY_ATTRIBUTE = "_model_usage_reference_latency"
_PLAN_ATTRIBUTE = "_model_usage_reference_query_plan"


def _safe_timing(value: object) -> float | None:
    if type(value) not in {int, float}:
        return None
    normalized = float(value)
    if not math.isfinite(normalized) or normalized < 0:
        return None
    return normalized


def _safe_count(value: object) -> int | None:
    return value if type(value) is int and value >= 0 else None


def record_reference_latency(config: object, result: object) -> None:
    setattr(
        config,
        _LATENCY_ATTRIBUTE,
        {
            "sampleCount": REFERENCE_SAMPLE_COUNT,
            "reserveP95Ms": _safe_timing(getattr(result, "reserve_p95_ms", None)),
            "settleP95Ms": _safe_timing(getattr(result, "settle_p95_ms", None)),
            "currentOverviewP95Ms": _safe_timing(
                getattr(result, "current_overview_p95_ms", None)
            ),
            "currentBreakdownP95Ms": _safe_timing(
                getattr(result, "current_breakdown_p95_ms", None)
            ),
            "historicalRollupP95Ms": _safe_timing(
                getattr(result, "historical_rollup_p95_ms", None)
            ),
        },
    )


def record_reference_query_plan(config: object, result: object) -> None:
    has_full_table_scan = getattr(result, "has_full_table_scan", None)
    setattr(
        config,
        _PLAN_ATTRIBUTE,
        {
            "hasFullTableScan": (
                has_full_table_scan if type(has_full_table_scan) is bool else None
            ),
            "currentAggregateQueryCount": _safe_count(
                getattr(result, "current_aggregate_query_count", None)
            ),
            "currentBreakdownQueryCount": _safe_count(
                getattr(result, "current_breakdown_query_count", None)
            ),
            "historicalRollupQueryCount": _safe_count(
                getattr(result, "historical_rollup_query_count", None)
            ),
        },
    )


def _write_new_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(
                payload,
                output,
                allow_nan=False,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
    except Exception:
        path.unlink(missing_ok=True)
        raise


def _within_reference_targets(payload: Mapping[str, object]) -> bool:
    timings_valid = all(
        type(payload.get(field)) in {int, float}
        and math.isfinite(float(payload[field]))
        and 0 <= float(payload[field]) <= maximum
        for field, maximum in REFERENCE_LATENCY_TARGETS_MS.items()
    )
    query_counts_valid = all(
        type(payload.get(field)) is int
        and 0 <= int(payload[field]) <= maximum
        for field, maximum in REFERENCE_QUERY_COUNT_TARGETS.items()
    )
    return (
        timings_valid
        and query_counts_valid
        and payload.get("hasFullTableScan") is False
    )


def finalize_reference_performance_artifact(
    config: object,
    *,
    exit_code: int,
    environment: Mapping[str, str] | None = None,
) -> Path | None:
    selected_environment = os.environ if environment is None else environment
    raw_output = (selected_environment.get(REFERENCE_OUTPUT_ENV) or "").strip()
    if not raw_output:
        return None
    profile = (selected_environment.get("MODEL_USAGE_REFERENCE_PROFILE") or "").strip()
    if profile != REFERENCE_PROFILE:
        raise ValueError("model_usage_reference_profile_required_for_artifact")

    latency = getattr(config, _LATENCY_ATTRIBUTE, {})
    plan = getattr(config, _PLAN_ATTRIBUTE, {})
    if not isinstance(latency, dict):
        latency = {}
    if not isinstance(plan, dict):
        plan = {}
    payload = {
        "profile": REFERENCE_PROFILE,
        "status": "blocked",
        "sampleCount": latency.get("sampleCount"),
        "reserveP95Ms": latency.get("reserveP95Ms"),
        "settleP95Ms": latency.get("settleP95Ms"),
        "currentOverviewP95Ms": latency.get("currentOverviewP95Ms"),
        "currentBreakdownP95Ms": latency.get("currentBreakdownP95Ms"),
        "historicalRollupP95Ms": latency.get("historicalRollupP95Ms"),
        "hasFullTableScan": plan.get("hasFullTableScan"),
        "currentAggregateQueryCount": plan.get("currentAggregateQueryCount"),
        "currentBreakdownQueryCount": plan.get("currentBreakdownQueryCount"),
        "historicalRollupQueryCount": plan.get("historicalRollupQueryCount"),
    }
    complete = all(
        value is not None
        for key, value in payload.items()
        if key not in {"profile", "status"}
    )
    if exit_code == 0 and complete and _within_reference_targets(payload):
        payload["status"] = "passed"

    artifact = {
        "schemaVersion": REFERENCE_SCHEMA_VERSION,
        "exitCode": int(exit_code),
        "payload": payload,
    }
    output_path = Path(raw_output).expanduser().resolve()
    _write_new_json(output_path, artifact)
    return output_path
