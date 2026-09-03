from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    """Immutable transport envelope shared by history, replay and SSE."""

    event_id: str
    conversation_id: str
    run_id: str | None
    message_id: str | None
    sequence: int
    event_type: str
    operation: str
    part_id: str | None
    payload: Mapping[str, Any]
    is_terminal: bool = False

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "TimelineEvent":
        def _string(name: str, *, required: bool = False) -> str | None:
            raw = value.get(name)
            if raw is None:
                if required:
                    raise ValueError(f"timeline event missing {name}")
                return None
            text = str(raw).strip()
            if required and not text:
                raise ValueError(f"timeline event missing {name}")
            return text or None

        sequence = value.get("sequence")
        try:
            sequence_int = int(sequence)
        except (TypeError, ValueError) as exc:
            raise ValueError("timeline event sequence must be an integer") from exc
        payload = value.get("payload")
        if not isinstance(payload, Mapping):
            payload = {}
        return cls(
            event_id=_string("event_id", required=True) or "",
            conversation_id=_string("conversation_id", required=True) or "",
            run_id=_string("run_id"),
            message_id=_string("message_id"),
            sequence=sequence_int,
            event_type=_string("event_type", required=True) or "",
            operation=_string("operation", required=True) or "",
            part_id=_string("part_id"),
            payload=dict(payload),
            is_terminal=bool(value.get("is_terminal", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "conversation_id": self.conversation_id,
            "run_id": self.run_id,
            "message_id": self.message_id,
            "sequence": self.sequence,
            "event_type": self.event_type,
            "operation": self.operation,
            "part_id": self.part_id,
            "payload": dict(self.payload),
            "is_terminal": self.is_terminal,
        }


@dataclass(frozen=True, slots=True)
class ConversationSnapshot:
    conversation_id: str
    snapshot_sequence: int
    messages: tuple[dict[str, Any], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "snapshot_sequence": self.snapshot_sequence,
            "messages": [dict(message) for message in self.messages],
        }
