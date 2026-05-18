from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.security import create_access_token, verify_password
from app.db.session import get_db
from app.repos.auth import get_active_membership, get_user_by_username, get_user_credential
from app.schemas.auth import LoginRequest, LoginResponse, MeResponse
from app.services.serializers import serialize_family, serialize_membership, serialize_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> dict:
    user = get_user_by_username(db, payload.username)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    credential = get_user_credential(db, user.id)
    membership = get_active_membership(db, user.id)
    if credential is None or membership is None or not verify_password(payload.password, credential.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    family = membership.family
    token = create_access_token(user.id)
    return {
        "access_token": token,
        "user": serialize_user(user),
        "membership": serialize_membership(membership),
        "family": serialize_family(family, []),
    }


@router.get("/me", response_model=MeResponse)
def me(auth: tuple = Depends(get_current_auth)) -> dict:
    user, membership = auth
    family = membership.family
    token = create_access_token(user.id)
    return {
        "access_token": token,
        "user": serialize_user(user),
        "membership": serialize_membership(membership),
        "family": serialize_family(family, []),
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)
