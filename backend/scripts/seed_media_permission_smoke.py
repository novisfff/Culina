from __future__ import annotations

import os
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import MembershipStatus, UserRole
from app.core.security import get_password_hash
from app.core.utils import create_id
from app.db.session import SessionLocal
from app.models.domain import Family, Membership, User, UserCredential

SMOKE_FLAG = "CULINA_MEDIA_PERMISSION_SMOKE"
SMOKE_USERNAME = "media-smoke-other-household"
SMOKE_PASSWORD = "MediaSmokeOther123"


def require_smoke_flag(environment: Mapping[str, str]) -> None:
    if environment.get(SMOKE_FLAG) != "1":
        raise RuntimeError(f"Refusing to seed without {SMOKE_FLAG}=1")


def ensure_secondary_smoke_household(db: Session) -> str:
    existing_user = db.scalar(select(User).where(User.username == SMOKE_USERNAME))
    if existing_user is not None:
        return existing_user.id

    system_actor = "media-permission-smoke"
    family = Family(
        id=create_id("family"),
        name="媒体权限 Smoke 第二家庭",
        created_by=system_actor,
        updated_by=system_actor,
    )
    user = User(
        id=create_id("user"),
        username=SMOKE_USERNAME,
        display_name="媒体权限 Smoke 用户",
        avatar_seed="media-permission-smoke",
        is_active=True,
        created_by=system_actor,
        updated_by=system_actor,
    )
    db.add_all([family, user])
    db.flush()
    db.add_all(
        [
            UserCredential(
                id=create_id("credential"),
                user_id=user.id,
                password_hash=get_password_hash(SMOKE_PASSWORD),
            ),
            Membership(
                id=create_id("membership"),
                family_id=family.id,
                user_id=user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
                created_by=system_actor,
                updated_by=system_actor,
            ),
        ]
    )
    db.commit()
    return user.id


def main() -> None:
    require_smoke_flag(os.environ)
    with SessionLocal() as db:
        user_id = ensure_secondary_smoke_household(db)
    print(f"Secondary smoke household ready for user {user_id}")


if __name__ == "__main__":
    main()
