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


class FamilyFoodContext(BaseModel):
    food_preferences: list[str] = Field(default_factory=list)
    food_avoidances: list[str] = Field(default_factory=list)

    @field_validator("food_preferences", "food_avoidances")
    @classmethod
    def normalize_food_context(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized: list[str] = []
        for raw in value:
            item = raw.strip()
            if item and item not in normalized:
                normalized.append(item)
        if len(normalized) > 20:
            raise ValueError("每类最多填写 20 项")
        if any(len(item) > 40 for item in normalized):
            raise ValueError("单项不能超过 40 个字符")
        return normalized


class UpdateFamilyRequest(FamilyFoodContext):
    food_preferences: list[str] | None = None
    food_avoidances: list[str] | None = None
    name: str
    motto: str = ""
    location: str = ""
    image_media_id: str | None = None
    pending_image_job_id: str | None = None


class FamilyDetailOut(FamilyFoodContext):
    id: str
    name: str
    motto: str
    location: str
    image: MediaAssetOut | None = None
    created_at: datetime
    updated_at: datetime
    ai_recommendations: list[AIRecommendationOut] = Field(default_factory=list)
