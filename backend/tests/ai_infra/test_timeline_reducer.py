from __future__ import annotations

import pytest

from app.ai.workflows.runner_support.timeline_reducer import (
    TimelineIntegrityError,
    reduce_message_snapshot,
)
from app.ai.workflows.runner_support.timeline_types import TimelineEvent


def event(
    *,
    sequence: int,
    event_type: str,
    operation: str,
    part_id: str | None = None,
    payload: dict | None = None,
    is_terminal: bool = False,
) -> TimelineEvent:
    return TimelineEvent(
        event_id=f"event-{sequence}",
        conversation_id="conversation-1",
        run_id="run-1",
        message_id="message-1",
        sequence=sequence,
        event_type=event_type,
        operation=operation,
        part_id=part_id,
        payload=payload or {},
        is_terminal=is_terminal,
    )


def test_replace_keeps_part_position() -> None:
    parts = [
        {"id": "before", "type": "text", "text": "前"},
        {"id": "draft-1", "type": "draft", "draft": {"status": "pending"}},
        {"id": "after", "type": "text", "text": "后"},
    ]
    result = reduce_message_snapshot(
        parts,
        event=event(
            sequence=4,
            event_type="part.replaced",
            operation="replace",
            part_id="draft-1",
            payload={"part": {"id": "draft-1", "type": "draft", "draft": {"status": "executed"}}},
        ),
    )
    assert [part["id"] for part in result] == ["before", "draft-1", "after"]
    assert result[1]["draft"]["status"] == "executed"


def test_delta_appends_only_to_target_text_part() -> None:
    parts = [
        {"id": "text-1", "type": "text", "text": "第一"},
        {"id": "text-2", "type": "text", "text": "第二"},
    ]
    result = reduce_message_snapshot(
        parts,
        event=event(
            sequence=3,
            event_type="part.delta",
            operation="delta",
            part_id="text-1",
            payload={"delta": "段"},
        ),
    )
    assert result == [
        {"id": "text-1", "type": "text", "text": "第一段"},
        {"id": "text-2", "type": "text", "text": "第二"},
    ]


def test_duplicate_part_id_is_rejected_instead_of_reordered() -> None:
    with pytest.raises(TimelineIntegrityError, match="duplicate part"):
        reduce_message_snapshot(
            [{"id": "draft-1", "type": "draft"}],
            event(
                sequence=2,
                event_type="part.appended",
                operation="append",
                part_id="draft-1",
                payload={"part": {"id": "draft-1", "type": "draft"}},
            ),
        )


def test_unknown_part_is_rejected() -> None:
    with pytest.raises(TimelineIntegrityError, match="unknown part"):
        reduce_message_snapshot(
            [{"id": "text-1", "type": "text", "text": "x"}],
            event(
                sequence=2,
                event_type="part.delta",
                operation="delta",
                part_id="missing",
                payload={"delta": "y"},
            ),
        )


def test_terminal_message_rejects_new_visible_event() -> None:
    with pytest.raises(TimelineIntegrityError, match="terminal"):
        reduce_message_snapshot(
            [{"id": "text-1", "type": "text", "text": "done"}],
            event(
                sequence=3,
                event_type="part.delta",
                operation="delta",
                part_id="text-1",
                payload={"delta": "late"},
            ),
            terminal=True,
        )
