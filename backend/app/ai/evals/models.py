from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


EVAL_METRIC_NAMES = {
    "casePassRate",
    "routingContractRate",
    "toolContractRate",
    "terminalContractRate",
    "draftFirstPassRate",
    "continuationContractRate",
    "identityBoundaryRate",
}


class SkillEvalCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["skill_eval_case.v1"]
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]+$")
    category: Literal[
        "routing",
        "query",
        "draft",
        "continuation",
        "identity_boundary",
        "attachment_boundary",
        "clarification",
    ]
    message: str = Field(min_length=1, max_length=500)
    quickTask: str | None = None
    subject: dict[str, Any] = Field(default_factory=dict)
    expectedSkills: list[str] = Field(default_factory=list)
    forbiddenSkills: list[str] = Field(default_factory=list)
    expectedTools: list[str] = Field(default_factory=list)
    forbiddenTools: list[str] = Field(default_factory=list)
    expectedCardTypes: list[str] = Field(default_factory=list)
    expectedDraftType: str | None = None
    expectedContinuationSchema: str | None = None
    expectedErrorCode: str | None = None
    expectedTerminalStatus: Literal[
        "completed",
        "waiting_approval",
        "waiting_human_input",
        "rejected",
    ]
    expectsFirstPassDraft: bool = False
    expectsIdentityRejection: bool = False
    expectsContinuationCompletion: bool = False
    expectedDraftValues: dict[str, Any] = Field(default_factory=dict)
    expectedToolValues: dict[str, dict[str, Any]] = Field(default_factory=dict)
    script: list[dict[str, Any]] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_identity_boundary(self) -> "SkillEvalCase":
        if self.expectsIdentityRejection and not self.expectedErrorCode:
            raise ValueError("identity rejection cases require expectedErrorCode")
        return self


class SkillEvalObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["skill_eval_observation.v1"]
    caseId: str
    source: Literal["scripted", "real_provider"]
    skills: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    draftType: str | None = None
    continuationSchema: str | None = None
    continuationCompleted: bool = False
    draftPayload: dict[str, Any] = Field(default_factory=dict)
    toolOutputs: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    cardTypes: list[str] = Field(default_factory=list)
    terminalStatus: str
    draftValidationAttempts: int = Field(default=0, ge=0)
    invalidIdentityWriteCount: int = Field(default=0, ge=0)
    errorCode: str | None = None


class RateMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    numerator: int = Field(ge=0)
    denominator: int = Field(ge=0)
    rate: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_rate(self) -> "RateMetric":
        if self.numerator > self.denominator:
            raise ValueError("rate numerator must not exceed denominator")
        expected = None if self.denominator == 0 else round(self.numerator / self.denominator, 4)
        if self.rate != expected:
            raise ValueError("rate must match numerator / denominator")
        return self


class SkillEvalCaseScore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    caseId: str
    passed: bool
    routingPassed: bool
    toolContractPassed: bool
    cardContractPassed: bool = True
    terminalPassed: bool
    draftPassed: bool
    firstPassDraftPassed: bool
    continuationPassed: bool
    identityBoundaryPassed: bool
    failures: list[str] = Field(default_factory=list)


class SkillEvalReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["skill_eval_report.v1"] = "skill_eval_report.v1"
    source: Literal["scripted", "real_provider"]
    generatedAt: datetime
    caseCount: int = Field(ge=0)
    passedCaseCount: int = Field(ge=0)
    metrics: dict[str, RateMetric]
    invalidIdentityWriteCount: int = Field(ge=0)
    cases: list[SkillEvalCaseScore]

    @model_validator(mode="after")
    def validate_report_consistency(self) -> "SkillEvalReport":
        case_ids = [case.caseId for case in self.cases]
        if len(case_ids) != len(set(case_ids)):
            raise ValueError("report caseId values must be unique")
        if self.caseCount != len(self.cases):
            raise ValueError("caseCount must match report cases length")
        passed_count = sum(case.passed for case in self.cases)
        if self.passedCaseCount != passed_count:
            raise ValueError("passedCaseCount must match passed report cases")
        metric_names = set(self.metrics)
        if metric_names != EVAL_METRIC_NAMES:
            missing = sorted(EVAL_METRIC_NAMES - metric_names)
            extra = sorted(metric_names - EVAL_METRIC_NAMES)
            raise ValueError(f"report metrics must match contract; missing={missing} extra={extra}")
        expected_case_metrics = {
            "casePassRate": passed_count,
            "routingContractRate": sum(case.routingPassed for case in self.cases),
            "toolContractRate": sum(case.toolContractPassed for case in self.cases),
            "terminalContractRate": sum(case.terminalPassed for case in self.cases),
        }
        for name, numerator in expected_case_metrics.items():
            metric = self.metrics[name]
            if metric.numerator != numerator or metric.denominator != self.caseCount:
                raise ValueError(f"{name} must match report case scores")
        return self
