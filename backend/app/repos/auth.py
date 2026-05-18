from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Membership, User, UserCredential


def get_user_by_username(db: Session, username: str) -> User | None:
    statement = select(User).where(User.username == username, User.is_active.is_(True))
    return db.scalar(statement)


def get_user_by_id(db: Session, user_id: str) -> User | None:
    statement = select(User).where(User.id == user_id, User.is_active.is_(True))
    return db.scalar(statement)


def get_user_credential(db: Session, user_id: str) -> UserCredential | None:
    statement = select(UserCredential).where(UserCredential.user_id == user_id)
    return db.scalar(statement)


def get_active_membership(db: Session, user_id: str) -> Membership | None:
    statement = select(Membership).where(Membership.user_id == user_id, Membership.status == "active")
    return db.scalar(statement)
