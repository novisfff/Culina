from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from app.core.enums import UserRole
from app.schemas.domain import FamilyDetailOut


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


class LoginResponse(BaseModel):
    access_token: str
    user: UserSummary
    membership: MembershipSummary
    family: FamilyDetailOut


class MeResponse(LoginResponse):
    pass
