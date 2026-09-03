from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from datetime import timedelta

from app.core.enums import AiMode
from app.core.utils import utcnow
from app.ai.workflows.runner_support.timeline_reducer import TimelineIntegrityError
from app.ai.workflows.timeline import build_planner_conversation
from app.db.base import Base
from app.models.domain import AIAgentRun, AIConversation, AIConversationEvent, AIMessage, Family
from app.services.ai_timeline import AITimelineService


def make_db() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    family = Family(id="family-service", name="服务家庭", motto="", location="")
    conversation = AIConversation(
        id="conversation-service",
        family_id=family.id,
        mode=AiMode.RECOMMENDATION,
        prompt="",
        response="",
        context={},
        title="",
        summary="",
        status="active",
    )
    db.add_all([family, conversation])
    db.add(
        AIAgentRun(
            id="run-service",
            family_id=family.id,
            conversation_id=conversation.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            input_summary="",
            context_summary={},
            output_summary="",
            status="running",
            model="test",
            input={},
            output={},
            tool_calls=[],
        )
    )
    db.commit()
    return db


def create_message(service: AITimelineService, db: Session) -> str:
    mutation = service.create_message(
        family_id="family-service",
        conversation_id="conversation-service",
        role="assistant",
        content="",
        parts=[],
        run_id="run-service",
        status="running",
        created_by="user-service",
    )
    db.commit()
    assert mutation.sequence == 1
    return mutation.message.id


def test_service_assigns_contiguous_sequences_and_replays_in_order() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        first = service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "text-1", "type": "text", "text": "前"},
            created_by="user-service",
        )
        second = service.append_delta(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part_id="text-1",
            delta="置",
            created_by="user-service",
        )
        db.commit()
        assert (first.sequence, second.sequence) == (2, 3)
        replay = service.replay(
            family_id="family-service",
            conversation_id="conversation-service",
            after_sequence=1,
        )
        assert [item.sequence for item in replay] == [2, 3]
        snapshot = service.snapshot(family_id="family-service", conversation_id="conversation-service")
        assert snapshot.snapshot_sequence == 3
        assert snapshot.messages[0]["parts"][0]["text"] == "前置"
    finally:
        db.close()


def test_planner_does_not_fallback_to_created_at_for_message_order() -> None:
    db = make_db()
    try:
        now = utcnow()
        db.add_all([
            AIMessage(
                id="message-order-a",
                family_id="family-service",
                conversation_id="conversation-service",
                role="user",
                content="A",
                content_type="text",
                parts=[],
                status="completed",
                created_at=now + timedelta(seconds=2),
            ),
            AIMessage(
                id="message-order-b",
                family_id="family-service",
                conversation_id="conversation-service",
                role="assistant",
                content="B",
                content_type="text",
                parts=[],
                status="completed",
                created_at=now,
            ),
        ])
        db.commit()

        timeline = build_planner_conversation(
            db,
            family_id="family-service",
            conversation_id="conversation-service",
        )

        assert [item["id"] for item in timeline] == ["message-order-a", "message-order-b"]
    finally:
        db.close()


def test_service_event_id_is_idempotent() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        first = service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "draft-1", "type": "draft"},
            event_id="stable-event",
            created_by="user-service",
        )
        db.commit()
        duplicate = service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "draft-1", "type": "draft", "status": "changed"},
            event_id="stable-event",
            created_by="user-service",
        )
        db.commit()
        assert duplicate.sequence == first.sequence
        assert db.scalar(select(AIConversationEvent.sequence).where(AIConversationEvent.id == "stable-event")) == 2
        message = db.get(AIMessage, message_id)
        assert [part["id"] for part in message.parts] == ["draft-1"]
        assert message.parts[0].get("status") is None
    finally:
        db.close()


def test_service_replaces_parts_in_place_and_terminal_blocks_late_output() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        for part in [
            {"id": "before", "type": "text", "text": "前"},
            {"id": "draft-1", "type": "draft", "status": "pending"},
            {"id": "after", "type": "text", "text": "后"},
        ]:
            service.append_part(
                family_id="family-service",
                conversation_id="conversation-service",
                message_id=message_id,
                run_id="run-service",
                part=part,
            )
        service.replace_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part_id="draft-1",
            part={"id": "draft-1", "type": "draft", "status": "executed"},
        )
        terminal = service.terminal(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            status="completed",
        )
        db.commit()
        message = db.get(AIMessage, message_id)
        assert [part["id"] for part in message.parts] == ["before", "draft-1", "after"]
        assert message.parts[1]["status"] == "executed"
        assert terminal.event.is_terminal is True
        with pytest.raises(TimelineIntegrityError, match="terminal"):
            service.append_delta(
                family_id="family-service",
                conversation_id="conversation-service",
                message_id=message_id,
                run_id="run-service",
                part_id="after",
                delta="late",
            )
    finally:
        db.close()


def test_service_upsert_appends_once_then_replaces_at_the_same_position() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "before", "type": "text", "text": "前"},
        )
        appended = service.upsert_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "activity-1", "type": "run_activity", "activity": {"status": "running"}},
        )
        service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "after", "type": "text", "text": "后"},
        )
        replaced = service.upsert_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "activity-1", "type": "run_activity", "activity": {"status": "completed"}},
        )
        db.commit()

        message = db.get(AIMessage, message_id)
        assert [part["id"] for part in message.parts] == ["before", "activity-1", "after"]
        assert message.parts[1]["activity"]["status"] == "completed"
        assert appended.event.event_type == "part.appended"
        assert replaced.event.event_type == "part.replaced"
    finally:
        db.close()


def test_service_append_text_delta_decides_append_or_delta_while_message_is_locked() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)

        first = service.append_text_delta(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part_id="text-stream",
            delta="第一段",
        )
        second = service.append_text_delta(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part_id="text-stream",
            delta="继续",
        )
        db.commit()

        message = db.get(AIMessage, message_id)
        assert message.parts == [
            {"id": "text-stream", "type": "text", "text": "第一段继续"},
        ]
        assert first.event.event_type == "part.appended"
        assert second.event.event_type == "part.delta"
        assert (first.sequence, second.sequence) == (2, 3)
    finally:
        db.close()


def test_service_metadata_update_is_a_canonical_snapshot_event() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)

        mutation = service.update_message_metadata(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            patch={"skillKey": "inventory_analysis", "temporary": True},
        )
        cleaned = service.update_message_metadata(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            patch={"skillKeys": ["inventory_analysis"]},
            remove_keys=("temporary",),
        )
        db.commit()

        message = db.get(AIMessage, message_id)
        assert message.message_metadata == {
            "skillKey": "inventory_analysis",
            "skillKeys": ["inventory_analysis"],
        }
        assert mutation.event.event_type == "message.metadata"
        assert mutation.event.payload["metadata"]["temporary"] is True
        assert cleaned.event.payload["metadata"] == message.message_metadata
        assert message.snapshot_sequence == cleaned.sequence
    finally:
        db.close()


def test_service_rejects_unknown_run_scope() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        with pytest.raises(TimelineIntegrityError, match="run does not belong"):
            service.append_part(
                family_id="family-service",
                conversation_id="conversation-service",
                message_id=message_id,
                run_id="missing-run",
                part={"id": "draft-1", "type": "draft"},
            )
    finally:
        db.close()


def test_service_rollback_hides_event_and_counter_increment() -> None:
    db = make_db()
    try:
        service = AITimelineService(db)
        message_id = create_message(service, db)
        service.append_part(
            family_id="family-service",
            conversation_id="conversation-service",
            message_id=message_id,
            run_id="run-service",
            part={"id": "draft-rollback", "type": "draft"},
            created_by="user-service",
        )
        db.rollback()
        replay = service.replay(
            family_id="family-service",
            conversation_id="conversation-service",
            after_sequence=0,
        )
        assert [event.sequence for event in replay] == [1]
        conversation = db.get(AIConversation, "conversation-service")
        assert conversation.timeline_version == 1
    finally:
        db.close()
