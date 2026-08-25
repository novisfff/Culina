from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy.orm import Session

from app.core.enums import UserRole
from app.models.domain import AIOperation
from app.services.ai_auto_execution.policy_types import (
    AICacheScope,
    AIOperationResultProjection,
)


@dataclass(frozen=True, slots=True)
class AIRevertContext:
    db: Session
    operation: AIOperation
    family_id: str
    actor_user_id: str
    actor_role: UserRole
    now: datetime


@dataclass(frozen=True, slots=True)
class AIRevertResult:
    result_json: dict[str, Any]
    entities: tuple[dict[str, Any], ...]
    cache_scopes: tuple[AICacheScope, ...]


class AIRevertAdapter(Protocol):
    key: str
    schema_version: int

    def revert(self, context: AIRevertContext) -> AIRevertResult: ...


@dataclass(frozen=True, slots=True)
class AIRevertResponse:
    projection: AIOperationResultProjection
    result_card: dict[str, Any]
    cache_scopes: tuple[AICacheScope, ...]
    server_now: datetime
    replayed: bool
