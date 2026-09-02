from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.workflows.runner_support.message_parts import aggregate_text_from_parts
from app.ai.workflows.runner_support.timeline_reducer import (
    TimelineIntegrityError,
    reduce_message_snapshot,
)
from app.ai.workflows.runner_support.timeline_types import ConversationSnapshot, TimelineEvent
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIConversationEvent, AIMessage


@dataclass(slots=True)
class TimelineMutation:
    """Result returned by timeline writes.

    The convenience properties intentionally mirror ``TimelineEvent`` so a
    caller can pass a mutation to existing event sinks while still accessing
    the materialized message when it needs to update UI metadata.
    """

    event: TimelineEvent
    message: AIMessage | None

    @property
    def event_id(self) -> str:
        return self.event.event_id

    @property
    def sequence(self) -> int:
        return self.event.sequence

    @property
    def conversation_id(self) -> str:
        return self.event.conversation_id

    @property
    def message_id(self) -> str | None:
        return self.event.message_id

    @property
    def part_id(self) -> str | None:
        return self.event.part_id

    def to_dict(self) -> dict[str, Any]:
        return self.event.to_dict()


class AITimelineService:
    """Single transactional writer for visible AI conversation state.

    The service never publishes to a queue.  A worker must commit its session
    first and only then hand ``mutation.event`` to SSE; this makes replay the
    source of truth after a process or network failure.
    """

    def __init__(self, db: Session) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Public write API
    # ------------------------------------------------------------------
    def create_message(
        self,
        *,
        family_id: str,
        conversation_id: str,
        role: str,
        content: str = "",
        content_type: str = "text",
        parts: list[dict[str, Any]] | None = None,
        run_id: str | None = None,
        status: str = "completed",
        metadata: dict[str, Any] | None = None,
        client_message_id: str | None = None,
        message_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        conversation = self._lock_conversation(family_id=family_id, conversation_id=conversation_id)
        existing = self._existing_event(
            event_id=event_id,
            family_id=family_id,
            conversation_id=conversation_id,
        )
        if existing is not None:
            return self._mutation_from_row(existing)

        # Idempotent retries can arrive without the original event id.  The
        # client message key is already unique per family; reuse its canonical
        # message and created event instead of allocating another position.
        if client_message_id:
            existing_message = self.db.scalar(
                select(AIMessage).where(
                    AIMessage.family_id == family_id,
                    AIMessage.client_message_id == client_message_id,
                )
            )
            if existing_message is not None:
                existing_created = self.db.scalar(
                    select(AIConversationEvent).where(
                        AIConversationEvent.family_id == family_id,
                        AIConversationEvent.conversation_id == conversation_id,
                        AIConversationEvent.message_id == existing_message.id,
                        AIConversationEvent.event_type == "message.created",
                    )
                )
                if existing_created is not None:
                    return self._mutation_from_row(existing_created)

        sequence = self._next_sequence(conversation)
        message_parts = [deepcopy(part) for part in (parts or []) if isinstance(part, dict)]
        message = AIMessage(
            id=message_id or create_id("ai_message"),
            family_id=family_id,
            conversation_id=conversation_id,
            role=role,
            content=content or aggregate_text_from_parts(message_parts),
            content_type=content_type or ("parts" if message_parts else "text"),
            parts=self._json(message_parts),
            run_id=run_id,
            status=status,
            message_metadata=self._json(metadata or {}),
            client_message_id=client_message_id,
            timeline_position=sequence,
            snapshot_sequence=sequence,
            created_by=created_by,
        )
        self.db.add(message)
        self.db.flush()
        event = self._add_event(
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id,
            message_id=message.id,
            sequence=sequence,
            event_id=event_id,
            event_type="message.created",
            operation="append",
            part_id=None,
            payload={"message": self._message_snapshot(message)},
            is_terminal=False,
            created_by=created_by,
        )
        return TimelineMutation(event=self._event_value(event), message=message)

    def append_part(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        part: dict[str, Any],
        run_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        return self._mutate_part(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            event_id=event_id,
            event_type="part.appended",
            operation="append",
            part_id=str(part.get("id") or "") or None,
            payload={"part": deepcopy(part)},
            created_by=created_by,
        )

    def append_delta(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        part_id: str,
        delta: str,
        run_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        if not delta:
            raise TimelineIntegrityError("empty delta is not a visible event")
        return self._mutate_part(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            event_id=event_id,
            event_type="part.delta",
            operation="delta",
            part_id=part_id,
            payload={"delta": delta},
            created_by=created_by,
        )

    def replace_part(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        part_id: str,
        part: dict[str, Any] | None = None,
        patch: dict[str, Any] | None = None,
        run_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        payload: dict[str, Any] = {}
        if part is not None:
            payload["part"] = deepcopy(part)
        if patch is not None:
            payload["patch"] = deepcopy(patch)
        return self._mutate_part(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            event_id=event_id,
            event_type="part.replaced",
            operation="replace",
            part_id=part_id,
            payload=payload,
            created_by=created_by,
        )

    def update_message_status(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        status: str,
        run_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        conversation = self._lock_conversation(family_id=family_id, conversation_id=conversation_id)
        existing = self._existing_event(event_id=event_id, family_id=family_id, conversation_id=conversation_id)
        if existing is not None:
            return self._mutation_from_row(existing)
        message = self._lock_message(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
        )
        self._ensure_run_scope(run_id=run_id, family_id=family_id, conversation_id=conversation_id)
        sequence = self._next_sequence(conversation)
        message.status = status
        message.snapshot_sequence = sequence
        self.db.flush()
        event = self._add_event(
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id or message.run_id,
            message_id=message.id,
            sequence=sequence,
            event_id=event_id,
            event_type="message.status",
            operation="status",
            part_id=None,
            payload={"status": status},
            is_terminal=False,
            created_by=created_by,
        )
        return TimelineMutation(event=self._event_value(event), message=message)

    def terminal(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        status: str = "completed",
        content: str | None = None,
        run_id: str | None = None,
        created_by: str | None = None,
        event_id: str | None = None,
    ) -> TimelineMutation:
        conversation = self._lock_conversation(family_id=family_id, conversation_id=conversation_id)
        existing = self._existing_event(event_id=event_id, family_id=family_id, conversation_id=conversation_id)
        if existing is not None:
            return self._mutation_from_row(existing)
        message = self._lock_message(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
        )
        self._ensure_run_scope(run_id=run_id, family_id=family_id, conversation_id=conversation_id)
        existing_terminal = self.db.scalar(
            select(AIConversationEvent).where(
                AIConversationEvent.family_id == family_id,
                AIConversationEvent.conversation_id == conversation_id,
                AIConversationEvent.message_id == message_id,
                AIConversationEvent.is_terminal.is_(True),
            )
        )
        if existing_terminal is not None:
            return self._mutation_from_row(existing_terminal)
        sequence = self._next_sequence(conversation)
        if content is not None:
            message.content = content
        elif message.parts:
            message.content = aggregate_text_from_parts(message.parts)
        message.content_type = "parts"
        message.status = status
        message.snapshot_sequence = sequence
        self.db.flush()
        event = self._add_event(
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id or message.run_id,
            message_id=message.id,
            sequence=sequence,
            event_id=event_id,
            event_type="run.terminal",
            operation="terminal",
            part_id=None,
            payload={
                "status": status,
                "message": self._message_snapshot(message),
            },
            is_terminal=True,
            created_by=created_by,
        )
        return TimelineMutation(event=self._event_value(event), message=message)

    # ------------------------------------------------------------------
    # Read API
    # ------------------------------------------------------------------
    def snapshot(self, *, family_id: str, conversation_id: str) -> ConversationSnapshot:
        conversation = self._load_conversation(family_id=family_id, conversation_id=conversation_id)
        messages = list(
            self.db.scalars(
                select(AIMessage)
                .where(
                    AIMessage.family_id == family_id,
                    AIMessage.conversation_id == conversation_id,
                )
                .order_by(AIMessage.timeline_position.asc(), AIMessage.id.asc())
            )
        )
        return ConversationSnapshot(
            conversation_id=conversation.id,
            snapshot_sequence=int(conversation.timeline_version or 0),
            messages=tuple(self._message_snapshot(message) for message in messages),
        )

    def replay(
        self,
        *,
        family_id: str,
        conversation_id: str,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[TimelineEvent]:
        self._load_conversation(family_id=family_id, conversation_id=conversation_id)
        query = (
            select(AIConversationEvent)
            .where(
                AIConversationEvent.family_id == family_id,
                AIConversationEvent.conversation_id == conversation_id,
                AIConversationEvent.sequence > int(after_sequence),
            )
            .order_by(AIConversationEvent.sequence.asc())
        )
        if limit is not None:
            query = query.limit(max(0, int(limit)))
        return [self._event_value(item) for item in self.db.scalars(query)]

    # ------------------------------------------------------------------
    # Internal transaction helpers
    # ------------------------------------------------------------------
    def _mutate_part(
        self,
        *,
        family_id: str,
        conversation_id: str,
        message_id: str,
        run_id: str | None,
        event_id: str | None,
        event_type: str,
        operation: str,
        part_id: str | None,
        payload: dict[str, Any],
        created_by: str | None,
    ) -> TimelineMutation:
        conversation = self._lock_conversation(family_id=family_id, conversation_id=conversation_id)
        existing = self._existing_event(event_id=event_id, family_id=family_id, conversation_id=conversation_id)
        if existing is not None:
            return self._mutation_from_row(existing)
        message = self._lock_message(
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
        )
        self._ensure_run_scope(run_id=run_id, family_id=family_id, conversation_id=conversation_id)
        self._ensure_not_terminal(conversation_id=conversation_id, message=message)
        sequence = self._next_sequence(conversation)
        try:
            next_parts = reduce_message_snapshot(message.parts, TimelineEvent(
                event_id=event_id or "pending",
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                sequence=sequence,
                event_type=event_type,
                operation=operation,
                part_id=part_id,
                payload=payload,
            ))
        except TimelineIntegrityError:
            # Do not leave a consumed sequence in the caller's transaction when
            # validation rejects an event.  The surrounding transaction may
            # contain earlier legitimate writes, so restore only the counter;
            # no flush has happened after increment yet.
            conversation.timeline_version = sequence - 1
            raise
        message.parts = self._json(next_parts)
        message.content_type = "parts"
        message.content = aggregate_text_from_parts(next_parts)
        message.snapshot_sequence = sequence
        self.db.flush()
        event = self._add_event(
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id or message.run_id,
            message_id=message.id,
            sequence=sequence,
            event_id=event_id,
            event_type=event_type,
            operation=operation,
            part_id=part_id,
            payload=payload,
            is_terminal=False,
            created_by=created_by,
        )
        return TimelineMutation(event=self._event_value(event), message=message)

    def _lock_conversation(self, *, family_id: str, conversation_id: str) -> AIConversation:
        conversation = self.db.scalar(
            select(AIConversation)
            .where(
                AIConversation.id == conversation_id,
                AIConversation.family_id == family_id,
            )
            .with_for_update()
        )
        if conversation is None:
            raise TimelineIntegrityError("conversation does not belong to family")
        return conversation

    def _load_conversation(self, *, family_id: str, conversation_id: str) -> AIConversation:
        conversation = self.db.scalar(
            select(AIConversation).where(
                AIConversation.id == conversation_id,
                AIConversation.family_id == family_id,
            )
        )
        if conversation is None:
            raise TimelineIntegrityError("conversation does not belong to family")
        return conversation

    def _lock_message(self, *, family_id: str, conversation_id: str, message_id: str) -> AIMessage:
        message = self.db.scalar(
            select(AIMessage)
            .where(
                AIMessage.id == message_id,
                AIMessage.family_id == family_id,
                AIMessage.conversation_id == conversation_id,
            )
            .with_for_update()
        )
        if message is None:
            raise TimelineIntegrityError("message does not belong to conversation")
        return message

    def _ensure_run_scope(self, *, run_id: str | None, family_id: str, conversation_id: str) -> None:
        if not run_id:
            return
        run = self.db.scalar(
            select(AIAgentRun).where(
                AIAgentRun.id == run_id,
                AIAgentRun.family_id == family_id,
            )
        )
        if run is None or run.conversation_id != conversation_id:
            raise TimelineIntegrityError("run does not belong to conversation")

    def _ensure_not_terminal(
        self,
        *,
        conversation_id: str,
        message: AIMessage,
    ) -> None:
        terminal_event = self.db.scalar(
            select(AIConversationEvent.id).where(
                AIConversationEvent.conversation_id == conversation_id,
                AIConversationEvent.message_id == message.id,
                AIConversationEvent.is_terminal.is_(True),
            )
        )
        if terminal_event is not None:
            raise TimelineIntegrityError("cannot append visible event after terminal")

    @staticmethod
    def _next_sequence(conversation: AIConversation) -> int:
        sequence = int(conversation.timeline_version or 0) + 1
        conversation.timeline_version = sequence
        return sequence

    def _existing_event(
        self,
        *,
        event_id: str | None,
        family_id: str,
        conversation_id: str,
    ) -> AIConversationEvent | None:
        if not event_id:
            return None
        return self.db.scalar(
            select(AIConversationEvent).where(
                AIConversationEvent.id == event_id,
                AIConversationEvent.family_id == family_id,
                AIConversationEvent.conversation_id == conversation_id,
            )
        )

    def _add_event(
        self,
        *,
        family_id: str,
        conversation_id: str,
        run_id: str | None,
        message_id: str | None,
        sequence: int,
        event_id: str | None,
        event_type: str,
        operation: str,
        part_id: str | None,
        payload: Mapping[str, Any],
        is_terminal: bool,
        created_by: str | None,
    ) -> AIConversationEvent:
        event = AIConversationEvent(
            id=event_id or create_id("ai_event"),
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id,
            message_id=message_id,
            sequence=sequence,
            event_type=event_type,
            operation=operation,
            part_id=part_id,
            payload=self._json(dict(payload)),
            is_terminal=is_terminal,
            created_at=utcnow(),
            created_by=created_by,
        )
        self.db.add(event)
        self.db.flush()
        return event

    def _mutation_from_row(self, event: AIConversationEvent) -> TimelineMutation:
        message = self.db.get(AIMessage, event.message_id) if event.message_id else None
        return TimelineMutation(event=self._event_value(event), message=message)

    @staticmethod
    def _event_value(event: AIConversationEvent) -> TimelineEvent:
        return TimelineEvent(
            event_id=event.id,
            conversation_id=event.conversation_id,
            run_id=event.run_id,
            message_id=event.message_id,
            sequence=int(event.sequence),
            event_type=event.event_type,
            operation=event.operation,
            part_id=event.part_id,
            payload=deepcopy(event.payload or {}),
            is_terminal=bool(event.is_terminal),
        )

    @staticmethod
    def _message_snapshot(message: AIMessage) -> dict[str, Any]:
        return jsonable_encoder(
            {
                "id": message.id,
                "conversation_id": message.conversation_id,
                "role": message.role,
                "content": message.content or "",
                "content_type": message.content_type,
                "parts": deepcopy(message.parts or []),
                "run_id": message.run_id,
                "status": message.status,
                "metadata": deepcopy(message.message_metadata or {}),
                "client_message_id": message.client_message_id,
                "created_at": message.created_at,
                "timeline_position": int(message.timeline_position or 0),
                "snapshot_sequence": int(message.snapshot_sequence or 0),
            }
        )

    @staticmethod
    def _json(value: Any) -> Any:
        return jsonable_encoder(value)
