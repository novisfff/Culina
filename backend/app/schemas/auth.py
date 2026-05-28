from __future__ import annotations

from pydantic import BaseModel, ConfigDict, field_validator

from app.core.security import validate_password_strength

from app.core.enums import UserRole
from app.schemas.family import FamilyDetailOut


class UserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_seed: str


class MembershipSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    family_id: str
    user_id: str
    role: UserRole
    status: str


class LoginRequest(BaseModel):
    username: str
    password: str


class UpdateProfileRequest(BaseModel):
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_seed: str | None = None


class UpdatePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, value: str) -> str:
        return validate_password_strength(value)


class LoginResponse(BaseModel):
    access_token: str
    user: UserSummary
    membership: MembershipSummary
    family: FamilyDetailOut


class MeResponse(LoginResponse):
    pass
