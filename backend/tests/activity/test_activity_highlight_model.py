from __future__ import annotations

import pytest
from sqlalchemy import create_engine, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind
from app.models.domain import ActivityLog, Base, Family
from app.services.activity import ActivityHighlight, log_activity


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    session.add(Family(id="family-highlight", name="高亮家庭", motto="", location=""))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_log_activity_defaults_to_audit_only(db: Session) -> None:
    activity = log_activity(
        db,
        family_id="family-highlight",
        actor_id="user-1",
        action=ActivityAction.UPDATE,
        entity_type="Family",
        entity_id="family-highlight",
        summary="更新家庭资料",
    )
    db.flush()
    assert activity.highlight_kind is None
    assert activity.highlight_summary is None


def test_log_activity_normalizes_a_structured_highlight(db: Session) -> None:
    activity = log_activity(
        db,
        family_id="family-highlight",
        actor_id="user-1",
        action=ActivityAction.UPDATE,
        entity_type="InventoryOperation",
        entity_id="operation-1",
        summary="登记采购",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.SHOPPING,
            summary="  完成 5 项采购入库  ",
        ),
    )
    db.flush()
    assert activity.highlight_kind is ActivityHighlightKind.SHOPPING
    assert activity.highlight_summary == "完成 5 项采购入库"


@pytest.mark.parametrize("summary", ["", "   ", "食" * 256])
def test_log_activity_rejects_invalid_highlight_summary(db: Session, summary: str) -> None:
    with pytest.raises(ValueError):
        log_activity(
            db,
            family_id="family-highlight",
            actor_id="user-1",
            action=ActivityAction.UPDATE,
            entity_type="InventoryOperation",
            entity_id="operation-1",
            summary="登记采购",
            highlight=ActivityHighlight(kind=ActivityHighlightKind.SHOPPING, summary=summary),
        )


def test_database_constraint_rejects_a_half_populated_highlight(db: Session) -> None:
    with pytest.raises(IntegrityError):
        db.execute(
            insert(ActivityLog).values(
                id="activity-half",
                family_id="family-highlight",
                actor_id="user-1",
                action=ActivityAction.UPDATE,
                entity_type="Family",
                entity_id="family-highlight",
                summary="非法半字段",
                highlight_kind=ActivityHighlightKind.FAMILY,
                highlight_summary=None,
            )
        )
        db.flush()
    db.rollback()
