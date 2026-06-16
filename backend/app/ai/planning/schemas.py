from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PlannerRequest(BaseModel):
    family_id: str
    user_id: str
    conversation_id: str | None = None
    conversation: list[dict[str, Any]] = Field(default_factory=list)
    available_skills: list[dict[str, Any]] = Field(default_factory=list)
    pending_clarification: dict[str, Any] | None = None


class PlannerResult(BaseModel):
    skills: list[str] = Field(default_factory=list)
    raw_response: str | None = None
    attempts: int = 0
    error: str | None = None
    diagnostic: str | None = None
    structured_mode: str | None = None

    @property
    def failed(self) -> bool:
        return bool(self.error)
