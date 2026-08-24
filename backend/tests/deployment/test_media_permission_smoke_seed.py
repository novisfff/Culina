from __future__ import annotations

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
import pytest

from app.core.security import verify_password
from app.models.domain import Base, Family, Membership, User, UserCredential
from scripts.seed_media_permission_smoke import (
    SMOKE_FLAG,
    SMOKE_PASSWORD,
    SMOKE_USERNAME,
    ensure_secondary_smoke_household,
    require_smoke_flag,
)


def test_media_smoke_seed_requires_explicit_environment_flag() -> None:
    with pytest.raises(RuntimeError, match=SMOKE_FLAG):
        require_smoke_flag({})

    require_smoke_flag({SMOKE_FLAG: "1"})


def test_media_smoke_seed_is_idempotent_and_creates_login_membership() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            first = ensure_secondary_smoke_household(db)
            second = ensure_secondary_smoke_household(db)

            assert first == second
            assert db.scalar(select(func.count()).select_from(User).where(User.username == SMOKE_USERNAME)) == 1
            membership = db.scalar(select(Membership).where(Membership.user_id == first))
            credential = db.scalar(select(UserCredential).where(UserCredential.user_id == first))
            assert membership is not None
            assert db.get(Family, membership.family_id) is not None
            assert credential is not None
            assert verify_password(SMOKE_PASSWORD, credential.password_hash)
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()
