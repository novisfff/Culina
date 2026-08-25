from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.ai_auto_execution.policy_types import AICacheScope


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AutoExecutionSettingUpdateRequest(_StrictModel):
    enabled: bool
    expected_row_version: int = Field(ge=0)
    consent_notice_version: str | None = Field(default=None, max_length=80)


class AutoExecutionSettingEntryOut(_StrictModel):
    action_key: str
    enabled: bool
    effective_enabled: bool
    row_version: int
    consent_notice_version: str | None
    requires_reconsent: bool


class AutoExecutionConsentNoticeOut(_StrictModel):
    version: str
    acknowledged: bool


class AutoExecutionSettingsOut(_StrictModel):
    catalog_version: str
    consent_notice: AutoExecutionConsentNoticeOut
    member_preferences: list[AutoExecutionSettingEntryOut]
    family_policies: list[AutoExecutionSettingEntryOut]
    limits: dict[str, dict[str, int]]
    server_now: datetime


class AIOperationResultProjectionOut(_StrictModel):
    draft_id: str
    operation_id: str | None
    result_status: Literal["completed", "no_change", "failed", "reverted"]
    execution_mode: Literal["manual_approval", "policy_auto", "policy_no_change"]
    operation_status: Literal["pending", "completed", "failed", "reverted"] | None
    execution_explanation: str
    revert_availability: Literal["available", "expired", "unsupported", "blocked", "reverted"]
    revertible_until: datetime | None
    revert_blocked_code: str | None
    server_now: datetime
    entities: list[dict[str, Any]] = Field(default_factory=list)
    cache_scopes: list[
        Literal["food", "meal_log", "meal_plan", "shopping_list", "inventory", "ai_conversation"]
    ] = Field(default_factory=list)


class AIRevertRequest(_StrictModel):
    client_request_id: str = Field(min_length=1, max_length=120)


class AIRevertResponseDTO(_StrictModel):
    projection: AIOperationResultProjectionOut
    result_card: dict[str, Any]
    cache_scopes: list[AICacheScope]
    server_now: datetime
    replayed: bool


class AIRevertConflictDetailDTO(AIRevertResponseDTO):
    code: Literal[
        "revert_target_changed",
        "revert_dependency_exists",
        "revert_adapter_version_unsupported",
    ]
    message: str
