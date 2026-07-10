from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.core.enums import MembershipStatus
from app.models.domain import Family, Membership


FAMILY_READ_CONTEXT_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "properties": {},
}
FAMILY_READ_CONTEXT_OUTPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["familyId", "name", "location", "preferences", "avoidances", "members"],
    "properties": {
        "familyId": {"type": "string"},
        "name": {"type": "string"},
        "location": {"type": "string"},
        "preferences": {"type": "array", "items": {"type": "string"}},
        "avoidances": {"type": "array", "items": {"type": "string"}},
        "members": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "familyId", "userId", "displayName", "role"],
                "properties": {
                    "id": {"type": "string"},
                    "familyId": {"type": "string"},
                    "userId": {"type": "string"},
                    "displayName": {"type": "string"},
                    "role": {"type": "string"},
                },
            },
        },
    },
}


def execute_family_read_context(
    context: ToolContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    del arguments
    family = context.db.get(Family, context.family_id)
    if family is None:
        raise ValueError("当前家庭不存在")

    members = list(
        context.db.scalars(
            select(Membership)
            .options(selectinload(Membership.user))
            .where(
                Membership.family_id == context.family_id,
                Membership.status == MembershipStatus.ACTIVE,
            )
            .order_by(Membership.created_at.asc())
        )
    )
    return {
        "familyId": family.id,
        "name": family.name,
        "location": family.location,
        "preferences": list(family.food_preferences or []),
        "avoidances": list(family.food_avoidances or []),
        "members": [
            {
                "id": member.id,
                "familyId": member.family_id,
                "userId": member.user_id,
                "displayName": member.user.display_name,
                "role": member.role.value,
            }
            for member in members
        ],
    }


def register_family_context_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="family.read_context",
        display_name="家庭饮食偏好",
        description="读取当前家庭的饮食偏好、忌口和安全成员摘要，用于生成符合家庭情况的建议。",
        side_effect="read",
        handler=execute_family_read_context,
        input_schema=FAMILY_READ_CONTEXT_INPUT,
        output_schema=FAMILY_READ_CONTEXT_OUTPUT,
        requires_followup=True,
        followup_hint="读取家庭饮食偏好后，继续结合当前任务生成建议或草稿。",
    )
