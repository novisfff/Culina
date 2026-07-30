from __future__ import annotations

"""Fail-closed launcher for the first real model-usage provider smoke.

This command deliberately does not call a provider until a single, audited
driver can exercise all seven capabilities through their production adapters.
Writing a machine-readable blocked artifact is useful release evidence; it is
not a substitute for the real smoke and always exits non-zero.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.enums import ModelUsageCapability


SMOKE_SCHEMA_VERSION = "model_usage_provider_smoke.v1"
_DRIVER_UNAVAILABLE = "provider_smoke_driver_unavailable"
_TEST_FAMILY_PREFIXES = (
    "family-model-usage-smoke",
    "test-model-usage-",
)


def _is_designated_test_family(family_id: str) -> bool:
    normalized = family_id.strip().lower()
    return any(normalized == prefix or normalized.startswith(f"{prefix}-") for prefix in _TEST_FAMILY_PREFIXES)


def _production_family_allowed() -> bool:
    return os.getenv("MODEL_USAGE_SMOKE_ALLOW_PRODUCTION_FAMILY") == "true"


def _blocked_report(*, error_code: str) -> dict[str, object]:
    return {
        "schemaVersion": SMOKE_SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "blocked",
        "executionMode": "not_run",
        "blockers": [error_code],
        "capabilities": [
            {
                "capability": capability.value,
                "status": "blocked",
                "errorCode": error_code,
            }
            for capability in ModelUsageCapability
        ],
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


def handle_smoke(args: argparse.Namespace) -> int:
    if not _is_designated_test_family(args.family_id) and not _production_family_allowed():
        print("provider_smoke_test_family_required", file=sys.stderr)
        return 2

    # A real driver must only be enabled once it sends all seven capability
    # requests through the accounting adapters and returns their safe IDs.  Do
    # not provide a partial or direct-SDK fallback here: either would make a
    # false first-launch claim possible.
    _write_new_report(args.output, _blocked_report(error_code=_DRIVER_UNAVAILABLE))
    print(_DRIVER_UNAVAILABLE, file=sys.stderr)
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
