from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.enums import UserRole
from app.core.security import AccessTokenInvalid, decode_access_token
from app.db.session import get_db
from app.models.domain import Membership, User
from app.repos.auth import get_active_membership, get_user_by_id
from app.services.auth_sessions import get_active_auth_session

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> tuple[User, Membership]:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    try:
        claims = decode_access_token(credentials.credentials)
    except AccessTokenInvalid as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "access_token_invalid", "message": "登录已失效，请重新登录"},
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    auth_session = get_active_auth_session(
        db,
        session_id=claims.session_id,
        user_id=claims.user_id,
    )
    user = get_user_by_id(db, claims.user_id)
    membership = get_active_membership(db, claims.user_id)
    if auth_session is None or user is None or membership is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth_session_invalid", "message": "登录已失效，请重新登录"},
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user, membership


def get_current_user(auth: tuple[User, Membership] = Depends(get_current_auth)) -> User:
    return auth[0]


def get_current_membership(auth: tuple[User, Membership] = Depends(get_current_auth)) -> Membership:
    return auth[1]


def require_owner(auth: tuple[User, Membership] = Depends(get_current_auth)) -> tuple[User, Membership]:
    if auth[1].role != UserRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner permission required")
    return auth
