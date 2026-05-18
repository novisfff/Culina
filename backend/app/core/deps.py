from __future__ import annotations

from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import UserRole
from app.db.session import get_db
from app.models.domain import Membership, User
from app.repos.auth import get_active_membership, get_user_by_id

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> tuple[User, Membership]:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    settings = get_settings()
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    subject = payload.get("sub")
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject")

    user = get_user_by_id(db, subject)
    membership = get_active_membership(db, subject)
    if user is None or membership is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User or membership missing")

    return user, membership


def get_current_user(auth: tuple[User, Membership] = Depends(get_current_auth)) -> User:
    return auth[0]


def get_current_membership(auth: tuple[User, Membership] = Depends(get_current_auth)) -> Membership:
    return auth[1]


def require_owner(auth: tuple[User, Membership] = Depends(get_current_auth)) -> tuple[User, Membership]:
    if auth[1].role != UserRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner permission required")
    return auth
