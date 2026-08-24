from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth, require_owner
from app.core.utils import utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.ai_auto_execution import (
    AutoExecutionSettingUpdateRequest,
    AutoExecutionSettingsOut,
)
from app.services.ai_auto_execution.settings import (
    AutoExecutionSettingsError,
    get_auto_execution_settings,
    set_family_policy,
    set_member_preference,
)


router = APIRouter(tags=["ai-auto-execution"])


def _error_response(exc: AutoExecutionSettingsError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": exc.message},
    )


def _stale_write_response() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": "auto_execution_settings_stale", "message": "设置已更新，请刷新后重试"},
    )


@router.get("/api/ai/auto-execution/settings", response_model=AutoExecutionSettingsOut)
def get_settings(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> AutoExecutionSettingsOut:
    user, membership = auth
    return get_auto_execution_settings(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        user_role=membership.role,
        now=utcnow(),
    )


@router.put(
    "/api/ai/auto-execution/preferences/{action_key}",
    response_model=AutoExecutionSettingsOut,
)
def update_member_preference(
    action_key: str,
    payload: AutoExecutionSettingUpdateRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> AutoExecutionSettingsOut:
    user, membership = auth
    now = utcnow()
    try:
        set_member_preference(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            action_key=action_key,
            enabled=payload.enabled,
            expected_row_version=payload.expected_row_version,
            consent_notice_version=payload.consent_notice_version,
            now=now,
        )
        commit_session(db)
    except AutoExecutionSettingsError as exc:
        db.rollback()
        raise _error_response(exc) from exc
    except (IntegrityError, StaleDataError) as exc:
        db.rollback()
        raise _stale_write_response() from exc
    return get_auto_execution_settings(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        user_role=membership.role,
        now=utcnow(),
    )


@router.put(
    "/api/ai/auto-execution/family-policies/{action_key}",
    response_model=AutoExecutionSettingsOut,
)
def update_family_policy(
    action_key: str,
    payload: AutoExecutionSettingUpdateRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AutoExecutionSettingsOut:
    owner, membership = auth
    now = utcnow()
    try:
        set_family_policy(
            db,
            family_id=membership.family_id,
            owner_user_id=owner.id,
            action_key=action_key,
            enabled=payload.enabled,
            expected_row_version=payload.expected_row_version,
            consent_notice_version=payload.consent_notice_version,
            now=now,
        )
        commit_session(db)
    except AutoExecutionSettingsError as exc:
        db.rollback()
        raise _error_response(exc) from exc
    except (IntegrityError, StaleDataError) as exc:
        db.rollback()
        raise _stale_write_response() from exc
    return get_auto_execution_settings(
        db,
        family_id=membership.family_id,
        user_id=owner.id,
        user_role=membership.role,
        now=utcnow(),
    )
