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
    AIRevertConflictDetailDTO,
    AIRevertRequest,
    AIRevertResponseDTO,
    AutoExecutionSettingUpdateRequest,
    AutoExecutionSettingsOut,
)
from app.services.ai_auto_execution.settings import (
    AutoExecutionSettingsError,
    get_auto_execution_settings,
    set_family_policy,
    set_member_preference,
)
from app.services.ai_operations.result_projection import serialize_ai_operation_result_projection
from app.services.ai_revert.coordinator import AIRevertCoordinator
from app.services.ai_revert.errors import AIRevertError
from app.services.ai_revert.types import AIRevertResponse


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


def _revert_response_dto(response: AIRevertResponse) -> AIRevertResponseDTO:
    return AIRevertResponseDTO(
        projection=serialize_ai_operation_result_projection(response.projection),
        result_card=response.result_card,
        cache_scopes=list(response.cache_scopes),
        server_now=response.server_now,
        replayed=response.replayed,
    )


def _permanent_revert_conflict(exc: AIRevertError) -> HTTPException:
    if exc.response is None:
        raise RuntimeError("permanent AI revert conflict is missing its public response")
    response = _revert_response_dto(exc.response)
    detail = AIRevertConflictDetailDTO(
        **response.model_dump(),
        code=exc.code,
        message=exc.message,
    )
    return HTTPException(status_code=exc.status_code, detail=detail.model_dump(mode="json"))


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


@router.post(
    "/api/ai/operations/{operation_id}/revert",
    response_model=AIRevertResponseDTO,
)
def revert_ai_operation(
    operation_id: str,
    payload: AIRevertRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> AIRevertResponseDTO:
    user, membership = auth
    try:
        result = AIRevertCoordinator.revert(
            db,
            family_id=membership.family_id,
            actor_user_id=user.id,
            actor_role=membership.role,
            operation_id=operation_id,
            client_request_id=payload.client_request_id,
            now=utcnow(),
        )
    except AIRevertError as exc:
        if exc.permanent_block and exc.response is not None:
            commit_session(db)
            exc.response = AIRevertCoordinator.hydrate_response(
                exc.response,
                server_now=utcnow(),
            )
            raise _permanent_revert_conflict(exc) from exc
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except Exception:
        db.rollback()
        raise
    commit_session(db)
    return _revert_response_dto(
        AIRevertCoordinator.hydrate_response(result, server_now=utcnow())
    )
