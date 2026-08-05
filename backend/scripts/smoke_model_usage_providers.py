from __future__ import annotations

"""Fail-closed launcher for the first real model-usage provider smoke."""

import argparse
import json
import os
import re
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.enums import ModelUsageCapability
from scripts.model_usage_provider_smoke_driver import (
    CulinaProviderSmokeDriver,
    ProviderSmokeDriverError,
    ProviderSmokeResult,
)


SMOKE_SCHEMA_VERSION = "model_usage_provider_smoke.v1"
_TEST_FAMILY_PREFIXES = (
    "family-model-usage-smoke",
    "test-model-usage-",
)
_SAFE_EVENT_ID = re.compile(r"^usage-event-[a-z0-9]+$")
_EXECUTION_ORDER = (
    ModelUsageCapability.LLM,
    ModelUsageCapability.EMBEDDING,
    ModelUsageCapability.RERANK,
    # TTS supplies the transient audio used by the STT smoke.  Output remains
    # in canonical enum order and neither audio nor transcript is persisted.
    ModelUsageCapability.TTS,
    ModelUsageCapability.STT,
    ModelUsageCapability.REALTIME_AUDIO,
    ModelUsageCapability.IMAGE_GENERATION,
)


def _is_designated_test_family(family_id: str) -> bool:
    normalized = family_id.strip().lower()
    return any(normalized == prefix or normalized.startswith(f"{prefix}-") for prefix in _TEST_FAMILY_PREFIXES)


def _production_family_allowed() -> bool:
    return os.getenv("MODEL_USAGE_SMOKE_ALLOW_PRODUCTION_FAMILY") == "true"


def _report(
    *,
    results: dict[ModelUsageCapability, ProviderSmokeResult],
    failed_capability: ModelUsageCapability | None = None,
    error_code: str | None = None,
) -> dict[str, object]:
    passed = len(results) == len(ModelUsageCapability) and error_code is None
    execution_mode = "real_provider" if results else "not_run"
    capability_rows: list[dict[str, object]] = []
    for capability in ModelUsageCapability:
        result = results.get(capability)
        if result is not None:
            event_id = result.event_id
            if not _SAFE_EVENT_ID.fullmatch(event_id):
                passed = False
                event_id = None
                row_error = "provider_smoke_event_id_invalid"
            else:
                row_error = None
            row: dict[str, object] = {
                "capability": capability.value,
                "status": "passed" if row_error is None else "blocked",
            }
            if event_id is not None:
                row["eventId"] = event_id
            if row_error is not None:
                row["errorCode"] = row_error
            capability_rows.append(row)
            continue
        capability_rows.append(
            {
                "capability": capability.value,
                "status": "blocked",
                "errorCode": (
                    error_code
                    if capability is failed_capability and error_code is not None
                    else "provider_smoke_not_run"
                ),
            }
        )
    return {
        "schemaVersion": SMOKE_SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "passed" if passed else "blocked",
        "executionMode": "real_provider" if passed else execution_mode,
        "blockers": [] if passed else [error_code or "provider_smoke_not_passed"],
        "capabilities": capability_rows,
    }


def _write_new_report(output: Path, payload: dict[str, object]) -> None:
    """Atomically create, but never replace, a smoke artifact."""

    if output.exists() or output.is_symlink():
        raise ValueError("provider_smoke_output_already_exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()


def handle_smoke(
    args: argparse.Namespace,
    *,
    driver_factory: Callable[..., CulinaProviderSmokeDriver] = CulinaProviderSmokeDriver,
) -> int:
    if not _is_designated_test_family(args.family_id) and not _production_family_allowed():
        print("provider_smoke_test_family_required", file=sys.stderr)
        return 2

    results: dict[ModelUsageCapability, ProviderSmokeResult] = {}
    failed_capability: ModelUsageCapability | None = None
    error_code: str | None = None
    try:
        driver = driver_factory(family_id=args.family_id, user_id=args.user_id)
        for capability in _EXECUTION_ORDER:
            failed_capability = capability
            result = driver.run(capability)
            if result.capability is not capability:
                raise ProviderSmokeDriverError("provider_smoke_capability_mismatch")
            results[capability] = result
        failed_capability = None
    except ProviderSmokeDriverError as exc:
        error_code = exc.code
    except Exception:
        error_code = "provider_smoke_driver_failed"

    report = _report(
        results=results,
        failed_capability=failed_capability,
        error_code=error_code,
    )
    _write_new_report(args.output, report)
    if report["status"] == "passed":
        return 0
    print(error_code or "provider_smoke_not_passed", file=sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the all-capability model-usage provider smoke only for a designated test family"
    )
    parser.add_argument("--family-id", required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--acknowledge-provider-cost", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.set_defaults(handler=handle_smoke)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except (OSError, ValueError):
        print("model_usage_provider_smoke_cli_failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
