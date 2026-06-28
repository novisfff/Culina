from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.orm import Session


@contextmanager
def fail_next_commit(message: str = "forced commit failure") -> Iterator[None]:
    armed = {"value": True}

    def raise_before_commit(session: Session) -> None:
        if armed["value"]:
            armed["value"] = False
            raise RuntimeError(message)

    event.listen(Session, "before_commit", raise_before_commit)
    try:
        yield
    finally:
        event.remove(Session, "before_commit", raise_before_commit)
