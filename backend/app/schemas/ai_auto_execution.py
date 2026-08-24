from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


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
