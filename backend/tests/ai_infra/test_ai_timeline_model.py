from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.enums import AiMode
from app.db.base import Base
from app.models.domain import AIConversation, AIConversationEvent, AIMessage, Family


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    try:
        family = Family(id="family-timeline", name="时间线家庭", motto="", location="")
        conversation = AIConversation(
            id="conversation-timeline",
            family_id=family.id,
            mode=AiMode.RECOMMENDATION,
            prompt="",
            response="",
            context={},
            title="",
            summary="",
            status="active",
        )
        session.add_all([family, conversation])
        session.commit()
        yield session
    finally:
        session.close()
        engine.dispose()


def _event(*, event_id: str, conversation_id: str, sequence: int) -> AIConversationEvent:
    return AIConversationEvent(
        id=event_id,
        family_id="family-timeline",
        conversation_id=conversation_id,
        sequence=sequence,
        event_type="message.created",
        operation="append",
        payload={},
        created_at=datetime.now(timezone.utc),
    )


def test_conversation_event_sequence_is_unique_per_conversation(db: Session) -> None:
    db.add_all(
        [
            _event(event_id="evt-1", conversation_id="conversation-timeline", sequence=1),
            _event(event_id="evt-2", conversation_id="conversation-timeline", sequence=1),
        ]
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_conversation_event_sequence_can_restart_for_another_conversation(db: Session) -> None:
    second = AIConversation(
        id="conversation-timeline-2",
        family_id="family-timeline",
        mode=AiMode.RECOMMENDATION,
        prompt="",
        response="",
        context={},
        title="",
        summary="",
        status="active",
    )
    db.add(second)
    db.flush()
    db.add_all(
        [
            _event(event_id="evt-1", conversation_id="conversation-timeline", sequence=1),
            _event(event_id="evt-2", conversation_id="conversation-timeline-2", sequence=1),
        ]
    )
    db.commit()
    assert db.get(AIConversation, "conversation-timeline").timeline_version == 0
    assert db.get(AIConversation, "conversation-timeline-2").timeline_version == 0


def test_message_timeline_counters_have_deterministic_defaults(db: Session) -> None:
    message = AIMessage(
        id="message-timeline",
        family_id="family-timeline",
        conversation_id="conversation-timeline",
        role="assistant",
        content="",
        parts=[],
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    assert message.timeline_position == 0
    assert message.snapshot_sequence == 0
