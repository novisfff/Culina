from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock

from app.core.utils import utcnow


@dataclass
class LiveMessageSnapshot:
    family_id: str
    conversation_id: str
    run_id: str
    message_id: str
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    part_order: list[str] = field(default_factory=list)
    text_by_part_id: dict[str, str] = field(default_factory=dict)

    def append(self, part_id: str, delta: str) -> None:
        if part_id not in self.text_by_part_id:
            self.part_order.append(part_id)
            self.text_by_part_id[part_id] = ""
        self.text_by_part_id[part_id] = f"{self.text_by_part_id[part_id]}{delta}"
        self.updated_at = utcnow()

    @property
    def content(self) -> str:
        return "\n\n".join(
            text.strip()
            for text in (self.text_by_part_id.get(part_id, "") for part_id in self.part_order)
            if text.strip()
        )

    def to_message(self, existing: dict | None = None) -> dict:
        if existing is not None:
            message = deepcopy(existing)
            message["run_id"] = self.run_id
            message["status"] = "running"
            message["content_type"] = "parts"
            message["metadata"] = {**(message.get("metadata") or {}), "liveStreaming": True, "liveTextPartIds": list(self.part_order)}
            parts = [dict(part) for part in message.get("parts") or [] if isinstance(part, dict)]
        else:
            message = {
                "id": self.message_id,
                "conversation_id": self.conversation_id,
                "role": "assistant",
                "content": "",
                "content_type": "parts",
                "parts": [],
                "run_id": self.run_id,
                "status": "running",
                "metadata": {"liveStreaming": True, "liveTextPartIds": list(self.part_order)},
                "client_message_id": None,
                "created_at": self.created_at,
            }
            parts = []

        for part_id in self.part_order:
            text = self.text_by_part_id.get(part_id, "")
            for index, part in enumerate(parts):
                if part.get("id") == part_id and part.get("type") == "text":
                    parts[index] = {**part, "text": text}
                    break
            else:
                parts.append({"id": part_id, "type": "text", "text": text})

        message["parts"] = parts
        message["content"] = "\n\n".join(
            str(part.get("text") or "").strip()
            for part in parts
            if part.get("type") == "text" and str(part.get("text") or "").strip()
        )
        return message


class LiveAIStreamCache:
    def __init__(self) -> None:
        self._lock = RLock()
        self._messages_by_run_id: dict[str, LiveMessageSnapshot] = {}
        self._run_ids_by_conversation_id: dict[str, set[str]] = {}

    def append_delta(
        self,
        *,
        family_id: str,
        conversation_id: str,
        run_id: str,
        message_id: str,
        part_id: str,
        delta: str,
        created_by: str | None,
    ) -> None:
        if not delta:
            return
        with self._lock:
            snapshot = self._messages_by_run_id.get(run_id)
            if snapshot is None:
                snapshot = LiveMessageSnapshot(
                    family_id=family_id,
                    conversation_id=conversation_id,
                    run_id=run_id,
                    message_id=message_id,
                    created_by=created_by,
                    created_at=utcnow(),
                    updated_at=utcnow(),
                )
                self._messages_by_run_id[run_id] = snapshot
                self._run_ids_by_conversation_id.setdefault(conversation_id, set()).add(run_id)
            snapshot.append(part_id, delta)

    def overlay_messages(self, *, family_id: str, conversation_id: str, messages: list[dict]) -> list[dict]:
        with self._lock:
            run_ids = list(self._run_ids_by_conversation_id.get(conversation_id) or [])
            snapshots = [
                deepcopy(self._messages_by_run_id[run_id])
                for run_id in run_ids
                if run_id in self._messages_by_run_id and self._messages_by_run_id[run_id].family_id == family_id
            ]
        if not snapshots:
            return messages

        next_messages = list(messages)
        for snapshot in sorted(snapshots, key=lambda item: item.created_at):
            existing_index = next(
                (
                    index
                    for index, message in enumerate(next_messages)
                    if message.get("id") == snapshot.message_id
                    or (message.get("run_id") == snapshot.run_id and message.get("role") == "assistant")
                ),
                -1,
            )
            if existing_index >= 0:
                next_messages[existing_index] = snapshot.to_message(next_messages[existing_index])
            else:
                next_messages.append(snapshot.to_message())
        return next_messages

    def clear_run(self, run_id: str | None) -> None:
        if not run_id:
            return
        with self._lock:
            snapshot = self._messages_by_run_id.pop(run_id, None)
            if snapshot is None:
                return
            run_ids = self._run_ids_by_conversation_id.get(snapshot.conversation_id)
            if run_ids is not None:
                run_ids.discard(run_id)
                if not run_ids:
                    self._run_ids_by_conversation_id.pop(snapshot.conversation_id, None)


live_ai_stream_cache = LiveAIStreamCache()
