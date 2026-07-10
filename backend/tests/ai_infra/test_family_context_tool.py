from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.ai.tools.base import ToolContext
from app.core.enums import MembershipStatus, UserRole
from app.models.domain import Base, Family, Membership, User


@pytest.fixture()
def tool_context() -> Iterator[ToolContext]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)

    with session_local() as db:
        current_family = Family(
            id="family-current",
            name="当前家庭",
            location="上海",
        )
        current_family.food_preferences = ["清淡"]
        current_family.food_avoidances = ["花生"]
        other_family = Family(id="family-other", name="其他家庭", location="北京")
        owner = User(
            id="user-owner",
            username="owner",
            display_name="主理人",
            email="owner@example.com",
            phone="13800000000",
            avatar_seed="owner",
        )
        inactive = User(
            id="user-inactive",
            username="inactive",
            display_name="已停用成员",
            email="inactive@example.com",
            avatar_seed="inactive",
        )
        outsider = User(
            id="user-outsider",
            username="outsider",
            display_name="其他家庭成员",
            email="outsider@example.com",
            avatar_seed="outsider",
        )
        db.add_all([current_family, other_family, owner, inactive, outsider])
        db.flush()
        db.add_all(
            [
                Membership(
                    id="membership-owner",
                    family_id=current_family.id,
                    user_id=owner.id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                Membership(
                    id="membership-inactive",
                    family_id=current_family.id,
                    user_id=inactive.id,
                    role=UserRole.MEMBER,
                    status=MembershipStatus.INVITED,
                ),
                Membership(
                    id="membership-outsider",
                    family_id=other_family.id,
                    user_id=outsider.id,
                    role=UserRole.MEMBER,
                    status=MembershipStatus.ACTIVE,
                ),
            ]
        )
        db.commit()

        yield ToolContext(
            db=db,
            family_id=current_family.id,
            user_id=owner.id,
            conversation_id="conversation-family-context",
            run_id="run-family-context",
        )

    Base.metadata.drop_all(engine)
    engine.dispose()


def test_family_context_returns_only_current_family_members(tool_context: ToolContext) -> None:
    from app.ai.tools.catalog.family_context import execute_family_read_context

    result = execute_family_read_context(tool_context, {"familyId": "family-other"})

    assert result["familyId"] == tool_context.family_id
    assert result["preferences"] == ["清淡"]
    assert result["avoidances"] == ["花生"]
    assert [item["userId"] for item in result["members"]] == ["user-owner"]
    assert all(item["familyId"] == tool_context.family_id for item in result["members"])
    assert all("email" not in item and "phone" not in item for item in result["members"])


def test_family_context_tool_is_registered_and_authorized_only_for_consumers() -> None:
    from app.ai.skills.registry import build_workspace_skill_registry
    from app.ai.tools.registry import build_workspace_tool_registry

    tool = build_workspace_tool_registry().get("family.read_context")
    assert tool.side_effect == "read"
    assert tool.input_schema["additionalProperties"] is False

    skills = build_workspace_skill_registry()
    authorized = {
        skill.manifest.key
        for skill in skills.list()
        if "family.read_context" in skill.manifest.tools
    }
    assert authorized == {"meal_plan", "meal_log", "recipe_cook", "recipe_draft"}
