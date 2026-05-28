from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.orm import Session


def commit_session(db: Session, *, on_error: Callable[[], None] | None = None) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
        if on_error is not None:
            on_error()
        raise

