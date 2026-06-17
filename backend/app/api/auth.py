from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.security import create_access_token, get_password_hash, verify_password
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.db.session import get_db
from app.db.transactions import commit_session
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.repos.auth import get_active_membership, get_user_by_username, get_user_credential
from app.schemas.auth import LoginRequest, LoginResponse, MeResponse, UpdatePasswordRequest, UpdateProfileRequest, UserSummary
from app.services.media import replace_media_assets
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
    user_media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="user", entity_ids=[user.id]))
    family_media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="family", entity_ids=[family.id]))
    token = create_access_token(user.id)
    return {
        "access_token": token,
        "user": serialize_user(user, user_media_map),
        "membership": serialize_membership(membership),
        "family": serialize_family(family, [], family_media_map),
    }


@router.get("/me", response_model=MeResponse)
def me(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> dict:
    user, membership = auth
    family = membership.family
    user_media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="user", entity_ids=[user.id]))
    family_media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="family", entity_ids=[family.id]))
    token = create_access_token(user.id)
    return {
        "access_token": token,
        "user": serialize_user(user, user_media_map),
        "membership": serialize_membership(membership),
        "family": serialize_family(family, [], family_media_map),
    }


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
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    user, _ = auth
    credential = get_user_credential(db, user.id)
    if credential is None or not verify_password(payload.current_password, credential.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    credential.password_hash = get_password_hash(payload.new_password)
    commit_session(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)
