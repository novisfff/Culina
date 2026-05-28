from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.enums import UserRole
from app.core.security import validate_password_strength
from app.schemas.ai import AIRecommendationOut


class MemberOut(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_seed: str
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


class FamilyDetailOut(BaseModel):
    id: str
    name: str
    motto: str
    location: str
    created_at: datetime
    updated_at: datetime
    ai_recommendations: list[AIRecommendationOut] = Field(default_factory=list)
