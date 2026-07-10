from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.ai.evals.models import SkillEvalReport


class SkillEvalThresholds(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["skill_eval_thresholds.v1"]
    minimumCaseCount: int = Field(ge=0)
    minimumRates: dict[str, float]
    maximumInvalidIdentityWriteCount: int = Field(ge=0)


def check_thresholds(*, report: SkillEvalReport, thresholds: SkillEvalThresholds) -> list[str]:
    failures: list[str] = []
    if report.source != "scripted":
        failures.append(f"source: expected scripted, got {report.source}")
    if report.caseCount < thresholds.minimumCaseCount:
        failures.append(f"caseCount: expected at least {thresholds.minimumCaseCount}, got {report.caseCount}")
    unknown = sorted(set(thresholds.minimumRates) - set(report.metrics))
    if unknown:
        failures.append("minimumRates: unknown metrics: " + ", ".join(unknown))
    for name, minimum in thresholds.minimumRates.items():
        metric = report.metrics.get(name)
        if metric is None:
            continue
        actual = metric.rate
        if actual is None or actual < minimum:
            actual_text = "null" if actual is None else f"{actual:.4f}"
            failures.append(f"{name}: expected at least {minimum:.4f}, got {actual_text}")
    if report.invalidIdentityWriteCount > thresholds.maximumInvalidIdentityWriteCount:
        failures.append(
            "invalidIdentityWriteCount: expected "
            f"{thresholds.maximumInvalidIdentityWriteCount}, got {report.invalidIdentityWriteCount}"
        )
    return failures
