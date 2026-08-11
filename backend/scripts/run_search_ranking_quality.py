from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from tests.search.ranking_quality import evaluate_quality_cases, load_baseline, load_quality_cases


def main() -> None:
    metrics = evaluate_quality_cases(load_quality_cases())
    baseline = load_baseline()
    report = {**metrics.to_dict(), "baseline_recall_at_20": baseline["recall_at_20"]}
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    failures = []
    if metrics.direct_hit_top1 != 1.0:
        failures.append("direct_hit_top1")
    if metrics.mrr_at_10 < 0.90:
        failures.append("mrr_at_10")
    if metrics.ndcg_at_10 < 0.85:
        failures.append("ndcg_at_10")
    if metrics.l4_top5_violations != 0:
        failures.append("l4_top5_violations")
    if metrics.recall_at_20 < float(baseline["recall_at_20"]):
        failures.append("recall_at_20")
    if metrics.deterministic_rate != 1.0:
        failures.append("deterministic_rate")
    if failures:
        raise SystemExit("quality gates failed: " + ", ".join(failures))


if __name__ == "__main__":
    main()
