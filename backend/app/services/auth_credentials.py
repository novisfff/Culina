from __future__ import annotations

import hmac

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import get_password_hash, verify_password
from app.models.domain import UserCredential
from app.services.auth_sessions import revoke_all_user_sessions


def lock_verified_login_credential(
    db: Session,
    *,
    credential: UserCredential,
    plain_password: str,
) -> UserCredential | None:
    """Verify outside the lock, then prove the same hash still owns the row."""

    observed_hash = credential.password_hash
    if not verify_password(plain_password, observed_hash):
        return None

    locked_credential = db.scalar(
        select(UserCredential)
        .where(UserCredential.id == credential.id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if locked_credential is None or not hmac.compare_digest(
        locked_credential.password_hash,
        observed_hash,
    ):
        return None
    return locked_credential


def update_password_and_revoke_sessions(
    db: Session,
    *,
    user_id: str,
    current_password: str,
    new_password: str,
) -> bool:
    new_password_hash = get_password_hash(new_password)
    credential = db.scalar(
        select(UserCredential)
        .where(UserCredential.user_id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if credential is None or not verify_password(
        current_password,
        credential.password_hash,
    ):
        return False

    credential.password_hash = new_password_hash
    revoke_all_user_sessions(
        db,
        user_id=user_id,
        reason="password_changed",
    )
    db.flush()
    return True
