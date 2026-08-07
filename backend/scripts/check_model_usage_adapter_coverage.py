from __future__ import annotations

import json
from pathlib import Path

from app.services.model_usage.provider_registry import (
    discover_remote_send_points,
    non_model_remote_send_point_reasons,
    registry_send_points,
)


def build_coverage_report() -> dict[str, object]:
    app_root = Path(__file__).resolve().parents[1] / "app"
    discovered = discover_remote_send_points(app_root)
    registered = registry_send_points()
    unregistered = discovered.model_provider - registered
    stale_registry_points = registered - discovered.model_provider
    non_model_reasons = non_model_remote_send_point_reasons()
    missing_exemption_reasons = discovered.non_model - set(non_model_reasons)
    status = "covered" if not (
        unregistered or stale_registry_points or missing_exemption_reasons
    ) else "blocked"
    return {
        "status": status,
        "model_provider_send_points": sorted(discovered.model_provider),
        "non_model_remote_send_points": [
            {"send_point": point, "reason": non_model_reasons[point]}
            for point in sorted(discovered.non_model)
        ],
        "unregistered_send_points": sorted(unregistered),
        "stale_registry_send_points": sorted(stale_registry_points),
        "missing_non_model_exemption_reasons": sorted(missing_exemption_reasons),
    }


def main() -> int:
    report = build_coverage_report()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "covered" else 1


if __name__ == "__main__":
    raise SystemExit(main())
