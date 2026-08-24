from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.core.enums import UserRole
from app.models.domain import AIAutoExecutionPreference, AIFamilyAutoExecutionPolicy
from app.repos.ai_auto_execution import (
    get_family_policy,
    get_member_preference,
    list_family_policies,
    list_member_preferences,
)
from app.schemas.ai_auto_execution import (
    AutoExecutionConsentNoticeOut,
    AutoExecutionSettingEntryOut,
    AutoExecutionSettingsOut,
)
from app.services.ai_auto_execution.catalog import (
    AUTO_EXECUTION_CATALOG,
    CATALOG_VERSION,
    CONSENT_NOTICE_VERSION,
)


class AutoExecutionSettingsError(Exception):
    code: str
    message: str
    status_code: int

    def __init__(self, code: str, message: str, status_code: int) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _unknown_action() -> AutoExecutionSettingsError:
    return AutoExecutionSettingsError("auto_execution_action_not_found", "未找到自动执行动作", 404)


def _stale_settings() -> AutoExecutionSettingsError:
    return AutoExecutionSettingsError("auto_execution_settings_stale", "设置已更新，请刷新后重试", 409)


def _stale_notice() -> AutoExecutionSettingsError:
    return AutoExecutionSettingsError("auto_execution_consent_notice_stale", "安全说明已更新，请重新确认", 409)


def _require_catalog_action(action_key: str, *, family_policy: bool = False) -> None:
    definition = AUTO_EXECUTION_CATALOG.get(action_key)
    if definition is None or (family_policy and not definition.family_policy_required):
        raise _unknown_action()


def _entry(
    *,
    action_key: str,
    enabled: bool,
    row_version: int,
    consent_notice_version: str | None,
) -> AutoExecutionSettingEntryOut:
    effective_enabled = enabled and consent_notice_version == CONSENT_NOTICE_VERSION
    return AutoExecutionSettingEntryOut(
        action_key=action_key,
        enabled=enabled,
        effective_enabled=effective_enabled,
        row_version=row_version,
        consent_notice_version=consent_notice_version,
        requires_reconsent=enabled and not effective_enabled,
    )


def _member_entry(
    action_key: str,
    preference: AIAutoExecutionPreference | None,
) -> AutoExecutionSettingEntryOut:
    if preference is None:
        return _entry(action_key=action_key, enabled=False, row_version=0, consent_notice_version=None)
    return _entry(
        action_key=action_key,
        enabled=preference.enabled,
        row_version=preference.row_version,
        consent_notice_version=preference.consent_notice_version,
    )


def _family_entry(
    action_key: str,
    policy: AIFamilyAutoExecutionPolicy | None,
) -> AutoExecutionSettingEntryOut:
    if policy is None:
        return _entry(action_key=action_key, enabled=False, row_version=0, consent_notice_version=None)
    return _entry(
        action_key=action_key,
        enabled=policy.enabled,
        row_version=policy.row_version,
        consent_notice_version=policy.consent_notice_version,
    )


def get_auto_execution_settings(
    db: Session, *, family_id: str, user_id: str, user_role: UserRole, now: datetime
) -> AutoExecutionSettingsOut:
    preference_by_action = {row.action_key: row for row in list_member_preferences(
        db, family_id=family_id, user_id=user_id,
    )}
    policy_by_action = {row.action_key: row for row in list_family_policies(db, family_id=family_id)}
    member_preferences = [
        _member_entry(action_key, preference_by_action.get(action_key))
        for action_key in AUTO_EXECUTION_CATALOG
    ]
    family_action_keys = [
        action_key for action_key, definition in AUTO_EXECUTION_CATALOG.items()
        if definition.family_policy_required
    ]
    family_policies = [
        _family_entry(action_key, policy_by_action.get(action_key))
        for action_key in family_action_keys
    ]
    preference_acknowledged = any(
        row.consent_notice_version == CONSENT_NOTICE_VERSION and row.consented_at is not None
        for row in preference_by_action.values()
    )
    policy_acknowledged = user_role is UserRole.OWNER and any(
        row.consent_notice_version == CONSENT_NOTICE_VERSION
        and row.consented_at is not None
        and row.consented_by == user_id
        for row in policy_by_action.values()
    )
    return AutoExecutionSettingsOut(
        catalog_version=CATALOG_VERSION,
        consent_notice=AutoExecutionConsentNoticeOut(
            version=CONSENT_NOTICE_VERSION,
            acknowledged=preference_acknowledged or policy_acknowledged,
        ),
        member_preferences=member_preferences,
        family_policies=family_policies,
        limits={
            action_key: dict(definition.limits)
            for action_key, definition in AUTO_EXECUTION_CATALOG.items()
            if definition.limits
        },
        server_now=now,
    )


def set_member_preference(
    db: Session, *, family_id: str, user_id: str, action_key: str,
    enabled: bool, expected_row_version: int, consent_notice_version: str | None,
    now: datetime,
) -> AutoExecutionSettingEntryOut:
    _require_catalog_action(action_key)
    preference = get_member_preference(
        db, family_id=family_id, user_id=user_id, action_key=action_key, for_update=True,
    )
    if preference is None:
        if expected_row_version != 0:
            raise _stale_settings()
        preference = AIAutoExecutionPreference(
            family_id=family_id,
            user_id=user_id,
            action_key=action_key,
            enabled=False,
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(preference)
    elif preference.row_version != expected_row_version:
        raise _stale_settings()

    if enabled and consent_notice_version != CONSENT_NOTICE_VERSION:
        raise _stale_notice()
    preference.enabled = enabled
    preference.updated_by = user_id
    if enabled:
        preference.consent_notice_version = CONSENT_NOTICE_VERSION
        preference.consented_at = now
    db.flush()
    return _member_entry(action_key, preference)


def set_family_policy(
    db: Session, *, family_id: str, owner_user_id: str, action_key: str,
    enabled: bool, expected_row_version: int, consent_notice_version: str | None,
    now: datetime,
) -> AutoExecutionSettingEntryOut:
    _require_catalog_action(action_key, family_policy=True)
    policy = get_family_policy(db, family_id=family_id, action_key=action_key, for_update=True)
    if policy is None:
        if expected_row_version != 0:
            raise _stale_settings()
        policy = AIFamilyAutoExecutionPolicy(
            family_id=family_id,
            action_key=action_key,
            enabled=False,
            created_by=owner_user_id,
            updated_by=owner_user_id,
        )
        db.add(policy)
    elif policy.row_version != expected_row_version:
        raise _stale_settings()

    if enabled and consent_notice_version != CONSENT_NOTICE_VERSION:
        raise _stale_notice()
    policy.enabled = enabled
    policy.updated_by = owner_user_id
    if enabled:
        policy.consent_notice_version = CONSENT_NOTICE_VERSION
        policy.consented_at = now
        policy.consented_by = owner_user_id
    db.flush()
    return _family_entry(action_key, policy)
