from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.enums import UserRole
from app.core.security import validate_password_strength
from app.schemas.ai import AIRecommendationOut
from app.schemas.media import MediaAssetOut


class MemberOut(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_seed: str
    avatar_image: MediaAssetOut | None = None
    role: UserRole
    status: str


class CreateMemberRequest(BaseModel):
    username: str
    display_name: str
    password: str
    role: UserRole
    email: str | None = None

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        return validate_password_strength(value)


class UpdateMemberRequest(BaseModel):
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_media_id: str | None = None
    pending_image_job_id: str | None = None


class UpdateFamilyRequest(BaseModel):
    name: str
    motto: str = ""
    location: str = ""
    image_media_id: str | None = None
    pending_image_job_id: str | None = None


class FamilyDetailOut(BaseModel):
    id: str
    name: str
    motto: str
    location: str
    image: MediaAssetOut | None = None
    created_at: datetime
    updated_at: datetime
    ai_recommendations: list[AIRecommendationOut] = Field(default_factory=list)
