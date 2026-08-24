from __future__ import annotations

from datetime import UTC, datetime
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.core.config import LOCAL_ENVIRONMENTS, Settings, get_settings
from app.core.deps import bearer_scheme, get_current_auth
from app.core.security import AccessTokenInvalid, create_access_token, decode_access_token
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.db.session import get_db
from app.db.transactions import commit_session
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.repos.auth import (
    get_active_membership,
    get_user_by_id,
    get_user_by_username,
    get_user_credential,
)
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    MeResponse,
    RefreshResponse,
    UpdatePasswordRequest,
    UpdateProfileRequest,
    UserSummary,
)
from app.services.auth_sessions import (
    IssuedAuthSession,
    RefreshSessionInvalid,
    create_auth_session,
    decode_refresh_token,
    prune_stale_user_sessions,
    revoke_auth_session,
    rotate_refresh_session,
)
from app.services.auth_credentials import (
    lock_verified_login_credential,
    update_password_and_revoke_sessions,
)
from app.services.media import replace_media_assets
from app.services.serializers import serialize_family, serialize_membership, serialize_user

router = APIRouter(prefix="/api/auth", tags=["auth"])
REFRESH_COOKIE_NAME = "culina-refresh"


def _auth_error(
    *,
    status_code: int,
    code: str,
    message: str,
    clear_refresh_cookie: bool = False,
) -> HTTPException:
    headers: dict[str, str] = {}
    if clear_refresh_cookie:
        response = Response()
        _clear_refresh_cookie(response)
        headers["Set-Cookie"] = response.headers["set-cookie"]
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
        headers=headers or None,
    )


def _cookie_is_secure(settings: Settings | object | None = None) -> bool:
    current_settings = settings or get_settings()
    environment = str(getattr(current_settings, "environment", "local")).strip().lower()
    return environment not in LOCAL_ENVIRONMENTS


def _set_refresh_cookie(response: Response, issued: IssuedAuthSession) -> None:
    expires_at = issued.session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    remaining_seconds = max(
        0,
        int((expires_at - datetime.now(UTC)).total_seconds()),
    )
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=issued.refresh_token,
        max_age=remaining_seconds,
        expires=expires_at,
        path="/api/auth",
        secure=_cookie_is_secure(),
        httponly=True,
        samesite="strict",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path="/api/auth",
        secure=_cookie_is_secure(),
        httponly=True,
        samesite="strict",
    )


def _origin_is_trusted(origin: str, settings: Settings | object) -> bool:
    candidate = origin.strip().rstrip("/")
    configured = str(getattr(settings, "frontend_origin", "")).strip().rstrip("/")
    if candidate and candidate == configured:
        return True
    environment = str(getattr(settings, "environment", "local")).strip().lower()
    if environment not in LOCAL_ENVIRONMENTS:
        return False
    return re.fullmatch(r"http://(localhost|127\.0\.0\.1):\d+", candidate) is not None


def require_trusted_auth_origin(request: Request) -> None:
    origin = request.headers.get("origin", "")
    if not _origin_is_trusted(origin, get_settings()):
        raise _auth_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code="auth_origin_not_allowed",
            message="请求来源不受信任",
        )


def _auth_snapshot(db: Session, user, membership) -> dict:
    family = membership.family
    user_media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=membership.family_id,
            entity_type="user",
            entity_ids=[user.id],
        )
    )
    family_media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=membership.family_id,
            entity_type="family",
            entity_ids=[family.id],
        )
    )
    return {
        "user": serialize_user(user, user_media_map),
        "membership": serialize_membership(membership),
        "family": serialize_family(family, [], family_media_map),
    }


@router.post("/login", response_model=LoginResponse)
def login(
    payload: LoginRequest,
    response: Response,
    _: None = Depends(require_trusted_auth_origin),
    db: Session = Depends(get_db),
) -> dict:
    user = get_user_by_username(db, payload.username)
    if user is None:
        raise _auth_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_credentials",
            message="用户名或密码不正确",
        )

    credential = get_user_credential(db, user.id)
    membership = get_active_membership(db, user.id)
    if credential is None or membership is None:
        raise _auth_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_credentials",
            message="用户名或密码不正确",
        )
    locked_credential = lock_verified_login_credential(
        db,
        credential=credential,
        plain_password=payload.password,
    )
    if locked_credential is None:
        raise _auth_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_credentials",
            message="用户名或密码不正确",
        )

    prune_stale_user_sessions(db, user_id=user.id)
    issued = create_auth_session(db, user_id=user.id)
    snapshot = _auth_snapshot(db, user, membership)
    token = create_access_token(user.id, session_id=issued.session.id)
    commit_session(db)
    _set_refresh_cookie(response, issued)
    return {"access_token": token, **snapshot}


@router.post("/refresh", response_model=RefreshResponse)
def refresh(
    request: Request,
    response: Response,
    _: None = Depends(require_trusted_auth_origin),
    db: Session = Depends(get_db),
) -> dict:
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME, "")
    try:
        issued = rotate_refresh_session(db, refresh_token=refresh_token)
    except RefreshSessionInvalid as exc:
        raise _auth_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="refresh_session_invalid",
            message="登录已过期，请重新登录",
        ) from exc

    user = get_user_by_id(db, issued.session.user_id)
    membership = get_active_membership(db, issued.session.user_id)
    if user is None or membership is None:
        revoke_auth_session(
            db,
            session_id=issued.session.id,
            reason="identity_inactive",
        )
        commit_session(db)
        raise _auth_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="refresh_identity_inactive",
            message="账号或家庭成员身份已停用",
        )

    snapshot = _auth_snapshot(db, user, membership)
    token = create_access_token(user.id, session_id=issued.session.id)
    commit_session(db)
    _set_refresh_cookie(response, issued)
    return {"access_token": token, **snapshot}


@router.get("/me", response_model=MeResponse)
def me(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> dict:
    user, membership = auth
    return _auth_snapshot(db, user, membership)


@router.patch("/me", response_model=UserSummary)
def update_me(
    payload: UpdateProfileRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required")
    user.display_name = display_name
    user.email = payload.email.strip() if payload.email and payload.email.strip() else None
    user.phone = payload.phone.strip() if payload.phone and payload.phone.strip() else None
    user.avatar_seed = (payload.avatar_seed or display_name).strip() or display_name
    user.updated_by = user.id
    if "avatar_media_id" in payload.model_fields_set:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=[payload.avatar_media_id] if payload.avatar_media_id else [],
            entity_type="user",
            entity_id=user.id,
        )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="user",
                entity_id=user.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    commit_session(db)
    db.refresh(user)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="user", entity_ids=[user.id]))
    return serialize_user(user, media_map)


@router.patch("/password", status_code=status.HTTP_204_NO_CONTENT)
def update_password(
    payload: UpdatePasswordRequest,
    _: None = Depends(require_trusted_auth_origin),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    user, _ = auth
    if not update_password_and_revoke_sessions(
        db,
        user_id=user.id,
        current_password=payload.current_password,
        new_password=payload.new_password,
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    commit_session(db)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    _: None = Depends(require_trusted_auth_origin),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> Response:
    session_ids: set[str] = set()
    if credentials is not None:
        try:
            access_claims = decode_access_token(credentials.credentials)
        except AccessTokenInvalid:
            pass
        else:
            session_ids.add(access_claims.session_id)

    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME, "")
    try:
        refresh_claims = decode_refresh_token(refresh_token)
    except RefreshSessionInvalid:
        pass
    else:
        session_ids.add(refresh_claims.session_id)

    for session_id in sorted(session_ids):
        revoke_auth_session(
            db,
            session_id=session_id,
            reason="logout",
        )
    commit_session(db)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(response)
    return response
