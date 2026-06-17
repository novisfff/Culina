from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth, require_owner
from app.core.enums import ActivityAction
from app.core.security import get_password_hash
from app.core.utils import create_id
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import AIRecommendation, Membership, User, UserCredential
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.repos.auth import get_user_by_username
from app.schemas.family import CreateMemberRequest, FamilyDetailOut, MemberOut, UpdateFamilyRequest, UpdateMemberRequest
from app.services.activity import log_activity
from app.services.media import replace_media_assets
from app.services.serializers import serialize_family, serialize_member

router = APIRouter(tags=["family"])


@router.get("/api/family", response_model=FamilyDetailOut)
def get_family(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> dict:
    _, membership = auth
    recommendations = list(
        db.scalars(
            select(AIRecommendation)
            .where(AIRecommendation.family_id == membership.family_id)
            .order_by(AIRecommendation.created_at.desc())
            .limit(3)
        )
    )
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="family", entity_ids=[membership.family_id]))
    return serialize_family(membership.family, recommendations, media_map)


@router.patch("/api/family", response_model=FamilyDetailOut)
def update_family(
    payload: UpdateFamilyRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Family name is required")
    family = membership.family
    family.name = name
    family.motto = payload.motto.strip()
    family.location = payload.location.strip()
    family.updated_by = user.id
    if "image_media_id" in payload.model_fields_set:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=[payload.image_media_id] if payload.image_media_id else [],
            entity_type="family",
            entity_id=family.id,
        )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="family",
                entity_id=family.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Family",
        entity_id=family.id,
        summary=f"更新家庭信息 {family.name}",
    )
    commit_session(db)
    db.refresh(family)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="family", entity_ids=[family.id]))
    return serialize_family(family, [], media_map)


@router.get("/api/members", response_model=list[MemberOut])
def list_members(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    memberships = list(
        db.scalars(
            select(Membership)
            .where(Membership.family_id == membership.family_id)
            .order_by(Membership.created_at.asc())
        )
    )
    user_ids = [item.user_id for item in memberships]
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="user", entity_ids=user_ids))
    return [serialize_member(item.user, item, media_map) for item in memberships]


@router.post("/api/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def create_member(
    payload: CreateMemberRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    if payload.role.name == "OWNER" and payload.role != membership.role:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Members cannot promote to owner")
    if get_user_by_username(db, payload.username):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already exists")

    member_user = User(
        id=create_id("user"),
        username=payload.username,
        display_name=payload.display_name,
        email=payload.email,
        avatar_seed=payload.display_name,
        is_active=True,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(member_user)
    db.flush()
    credential = UserCredential(
        id=create_id("credential"),
        user_id=member_user.id,
        password_hash=get_password_hash(payload.password),
    )
    member_membership = Membership(
        id=create_id("membership"),
        family_id=membership.family_id,
        user_id=member_user.id,
        role=payload.role,
        status="active",
        created_by=user.id,
        updated_by=user.id,
    )
    db.add_all([credential, member_membership])
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.INVITE,
        entity_type="Membership",
        entity_id=member_membership.id,
        summary=f"邀请 {member_user.display_name} 成为{'管理员' if payload.role.value == 'Owner' else '成员'}",
    )
    commit_session(db)
    db.refresh(member_user)
    db.refresh(member_membership)
    return serialize_member(member_user, member_membership, {})


@router.patch("/api/members/{member_id}", response_model=MemberOut)
def update_member(
    member_id: str,
    payload: UpdateMemberRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    member_membership = db.scalar(
        select(Membership).where(Membership.family_id == membership.family_id, Membership.user_id == member_id)
    )
    if member_membership is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    member_user = member_membership.user
    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required")

    member_user.display_name = display_name
    member_user.email = payload.email.strip() if payload.email and payload.email.strip() else None
    member_user.phone = payload.phone.strip() if payload.phone and payload.phone.strip() else None
    member_user.avatar_seed = display_name
    member_user.updated_by = user.id
    if "avatar_media_id" in payload.model_fields_set:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=[payload.avatar_media_id] if payload.avatar_media_id else [],
            entity_type="user",
            entity_id=member_user.id,
        )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="user",
                entity_id=member_user.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="User",
        entity_id=member_user.id,
        summary=f"更新成员信息 {member_user.display_name}",
    )
    commit_session(db)
    db.refresh(member_user)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="user", entity_ids=[member_user.id]))
    return serialize_member(member_user, member_membership, media_map)
