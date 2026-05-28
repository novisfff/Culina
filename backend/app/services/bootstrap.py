from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import MembershipStatus, UserRole
from app.core.security import get_password_hash
from app.core.utils import create_id
from app.db.transactions import commit_session
from app.models.domain import Family, Membership, User, UserCredential


def initialize_configured_admin(db: Session) -> bool:
    existing_user_id = db.scalar(select(User.id).limit(1))
    if existing_user_id:
        return False

    settings = get_settings()
    required = {
        "INITIAL_ADMIN_USERNAME": settings.initial_admin_username,
        "INITIAL_ADMIN_PASSWORD": settings.initial_admin_password,
        "INITIAL_ADMIN_DISPLAY_NAME": settings.initial_admin_display_name,
        "INITIAL_FAMILY_NAME": settings.initial_family_name,
    }
    missing = [name for name, value in required.items() if not value.strip()]
    if missing:
        raise RuntimeError(f"Missing initial admin settings: {', '.join(missing)}")

    system_actor = "system"
    family = Family(
        id=create_id("family"),
        name=settings.initial_family_name.strip(),
        motto=settings.initial_family_motto.strip(),
        location=settings.initial_family_location.strip(),
        created_by=system_actor,
        updated_by=system_actor,
    )
    db.add(family)
    db.flush()

    user = User(
        id=create_id("user"),
        username=settings.initial_admin_username.strip(),
        display_name=settings.initial_admin_display_name.strip(),
        email=settings.initial_admin_email.strip() or None,
        phone=settings.initial_admin_phone.strip() or None,
        avatar_seed=settings.initial_admin_display_name.strip(),
        is_active=True,
        created_by=system_actor,
        updated_by=system_actor,
    )
    db.add(user)
    db.flush()

    credential = UserCredential(
        id=create_id("credential"),
        user_id=user.id,
        password_hash=get_password_hash(settings.initial_admin_password),
    )
    membership = Membership(
        id=create_id("membership"),
        family_id=family.id,
        user_id=user.id,
        role=UserRole.OWNER,
        status=MembershipStatus.ACTIVE,
        created_by=system_actor,
        updated_by=system_actor,
    )
    db.add_all([credential, membership])
    commit_session(db)
    return True
