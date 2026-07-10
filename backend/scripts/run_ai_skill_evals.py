from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ai.evals.loader import join_cases_and_observations, load_eval_cases, load_eval_observations
from app.ai.evals.scoring import score_report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.output.exists() and not args.force:
        parser.error(f"output already exists: {args.output}; pass --force to overwrite")
    pairs = join_cases_and_observations(
        cases=load_eval_cases(args.cases),
        observations=load_eval_observations(args.observations),
    )
    report = score_report(pairs)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    print(f"AI skill eval: {report.passedCaseCount}/{report.caseCount} passed ({report.source})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
