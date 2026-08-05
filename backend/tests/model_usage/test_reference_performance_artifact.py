from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts.model_usage_reference_artifact import (
    REFERENCE_OUTPUT_ENV,
    REFERENCE_PROFILE,
    finalize_reference_performance_artifact,
    record_reference_latency,
    record_reference_query_plan,
)


def _record_complete_results(config: object) -> None:
    record_reference_latency(
        config,
        SimpleNamespace(
            reserve_p95_ms=10.0,
            settle_p95_ms=11.0,
            current_overview_p95_ms=20.0,
            current_breakdown_p95_ms=30.0,
            historical_rollup_p95_ms=21.0,
        ),
    )
    record_reference_query_plan(
        config,
        SimpleNamespace(
            has_full_table_scan=False,
            current_aggregate_query_count=11,
            current_breakdown_query_count=6,
            historical_rollup_query_count=3,
        ),
    )


def test_reference_artifact_is_content_free_complete_and_non_overwriting(
    tmp_path: Path,
) -> None:
    config = SimpleNamespace()
    _record_complete_results(config)
    output = tmp_path / "reference-performance.json"
    environment = {
        "MODEL_USAGE_REFERENCE_PROFILE": REFERENCE_PROFILE,
        REFERENCE_OUTPUT_ENV: str(output),
    }

    written = finalize_reference_performance_artifact(
        config,
        exit_code=0,
        environment=environment,
    )

    assert written == output.resolve()
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload == {
        "schemaVersion": "model_usage_reference_performance.v1",
        "exitCode": 0,
        "payload": {
            "profile": REFERENCE_PROFILE,
            "status": "passed",
            "sampleCount": 20,
            "reserveP95Ms": 10.0,
            "settleP95Ms": 11.0,
            "currentOverviewP95Ms": 20.0,
            "currentBreakdownP95Ms": 30.0,
            "historicalRollupP95Ms": 21.0,
            "hasFullTableScan": False,
            "currentAggregateQueryCount": 11,
            "currentBreakdownQueryCount": 6,
            "historicalRollupQueryCount": 3,
        },
    }
    with pytest.raises(FileExistsError):
        finalize_reference_performance_artifact(
            config,
            exit_code=0,
            environment=environment,
        )


def test_reference_artifact_never_passes_an_incomplete_or_failed_session(
    tmp_path: Path,
) -> None:
    output = tmp_path / "reference-performance.json"

    finalize_reference_performance_artifact(
        SimpleNamespace(),
        exit_code=1,
        environment={
            "MODEL_USAGE_REFERENCE_PROFILE": REFERENCE_PROFILE,
            REFERENCE_OUTPUT_ENV: str(output),
        },
    )

    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["exitCode"] == 1
    assert payload["payload"]["status"] == "blocked"
    assert payload["payload"]["reserveP95Ms"] is None


def test_reference_artifact_requires_the_designated_profile(tmp_path: Path) -> None:
    output = tmp_path / "reference-performance.json"

    with pytest.raises(
        ValueError,
        match="model_usage_reference_profile_required_for_artifact",
    ):
        finalize_reference_performance_artifact(
            SimpleNamespace(),
            exit_code=0,
            environment={
                "MODEL_USAGE_REFERENCE_PROFILE": "developer-laptop",
                REFERENCE_OUTPUT_ENV: str(output),
            },
        )

    assert output.exists() is False
