from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping

from .timeline_types import TimelineEvent


class TimelineIntegrityError(ValueError):
    """Raised when an event would make a canonical snapshot ambiguous."""


def _event(value: TimelineEvent | Mapping[str, Any]) -> TimelineEvent:
    return value if isinstance(value, TimelineEvent) else TimelineEvent.from_mapping(value)


def _part_index(parts: list[dict[str, Any]], part_id: str | None) -> int:
    if not part_id:
        raise TimelineIntegrityError("timeline event missing part id")
    for index, part in enumerate(parts):
        if str(part.get("id") or "") == part_id:
            return index
    return -1


def reduce_message_snapshot(
    parts: list[dict[str, Any]] | None,
    event: TimelineEvent | Mapping[str, Any],
    *,
    terminal: bool = False,
) -> list[dict[str, Any]]:
    """Apply one visible event without ever changing unrelated positions.

    The function is deliberately pure: callers can safely retry an event after
    a reconnect and compare the returned value with a history snapshot.
    Idempotency by ``event_id`` belongs to the outer conversation reducer; a
    duplicate part in a *new* event is an integrity violation rather than a
    reorder hint.
    """

    timeline_event = _event(event)
    current = [deepcopy(part) for part in (parts or []) if isinstance(part, dict)]
    event_type = timeline_event.event_type
    if terminal and event_type != "run.terminal":
        raise TimelineIntegrityError("cannot apply visible event after terminal")

    if event_type == "message.created":
        message = timeline_event.payload.get("message")
        if isinstance(message, Mapping) and not current:
            snapshot_parts = message.get("parts")
            if isinstance(snapshot_parts, list):
                return [deepcopy(part) for part in snapshot_parts if isinstance(part, dict)]
        return current

    if event_type == "part.appended":
        part = timeline_event.payload.get("part")
        if not isinstance(part, Mapping):
            raise TimelineIntegrityError("part.appended missing part payload")
        candidate = deepcopy(dict(part))
        candidate_id = str(candidate.get("id") or timeline_event.part_id or "")
        if not candidate_id:
            raise TimelineIntegrityError("part.appended missing part id")
        if timeline_event.part_id and candidate_id != timeline_event.part_id:
            raise TimelineIntegrityError("part id does not match event envelope")
        candidate["id"] = candidate_id
        if _part_index(current, candidate_id) >= 0:
            raise TimelineIntegrityError(f"duplicate part id: {candidate_id}")
        current.append(candidate)
        return current

    if event_type == "part.delta":
        index = _part_index(current, timeline_event.part_id)
        if index < 0:
            raise TimelineIntegrityError(f"unknown part id: {timeline_event.part_id}")
        part = current[index]
        if part.get("type") != "text":
            raise TimelineIntegrityError("part.delta target is not a text part")
        delta = timeline_event.payload.get("delta")
        if not isinstance(delta, str):
            raise TimelineIntegrityError("part.delta missing text delta")
        part["text"] = f"{part.get('text') or ''}{delta}"
        return current

    if event_type == "part.replaced":
        index = _part_index(current, timeline_event.part_id)
        if index < 0:
            raise TimelineIntegrityError(f"unknown part id: {timeline_event.part_id}")
        replacement = timeline_event.payload.get("part")
        patch = timeline_event.payload.get("patch")
        if isinstance(replacement, Mapping):
            next_part = deepcopy(dict(replacement))
        elif isinstance(patch, Mapping):
            next_part = {**current[index], **deepcopy(dict(patch))}
        else:
            raise TimelineIntegrityError("part.replaced missing part payload")
        replacement_id = str(next_part.get("id") or timeline_event.part_id or "")
        if replacement_id != timeline_event.part_id:
            raise TimelineIntegrityError("replacement cannot change part id")
        next_part["id"] = replacement_id
        current[index] = next_part
        return current

    if event_type in {"message.status", "run.terminal"}:
        return current

    raise TimelineIntegrityError(f"unknown timeline event type: {event_type}")
