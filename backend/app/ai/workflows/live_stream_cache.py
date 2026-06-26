from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock
from typing import Any

from app.core.utils import utcnow

LIVE_OVERLAY_MESSAGE_STATUSES = {"pending", "running", "waiting_approval", "waiting_input"}


@dataclass
class LiveMessageSnapshot:
    family_id: str
    conversation_id: str
    run_id: str
    message_id: str
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    parts: list[dict[str, Any]] = field(default_factory=list)
    text_source_by_part_id: dict[str, str] = field(default_factory=dict)
    text_segment_count_by_source: dict[str, int] = field(default_factory=dict)

    def append_delta(self, source_part_id: str, delta: str) -> str:
        part_id = source_part_id
        last_part = self.parts[-1] if self.parts else None
        if (
            isinstance(last_part, dict)
            and last_part.get("type") == "text"
            and self.text_source_by_part_id.get(str(last_part.get("id") or "")) == source_part_id
        ):
            part_id = str(last_part.get("id") or source_part_id)
            last_part["text"] = f"{last_part.get('text') or ''}{delta}"
            self.updated_at = utcnow()
            return part_id

        if any(part.get("id") == part_id for part in self.parts if isinstance(part, dict)):
            count = self.text_segment_count_by_source.get(source_part_id, 1) + 1
            self.text_segment_count_by_source[source_part_id] = count
            part_id = f"{source_part_id}__stream_segment_{count}"
        else:
            self.text_segment_count_by_source[source_part_id] = 1
        self.parts.append({"id": part_id, "type": "text", "text": delta})
        self.text_source_by_part_id[part_id] = source_part_id
        self.updated_at = utcnow()
        return part_id

    def append_part(self, part: dict[str, Any]) -> dict[str, Any]:
        part_id = str(part.get("id") or "")
        if part_id:
            for index, current in enumerate(self.parts):
                if isinstance(current, dict) and current.get("id") == part_id:
                    self.parts[index] = dict(part)
                    self.updated_at = utcnow()
                    return dict(part)
        self.parts.append(dict(part))
        self.updated_at = utcnow()
        return dict(part)

    def append_activity(self, part: dict[str, Any]) -> dict[str, Any]:
        return self.append_part(part)

    @property
    def content(self) -> str:
        return "\n\n".join(
            str(part.get("text") or "").strip()
            for part in self.parts
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        )

    @property
    def live_text_part_ids(self) -> list[str]:
        return [
            str(part.get("id"))
            for part in self.parts
            if isinstance(part, dict) and part.get("type") == "text" and part.get("id")
        ]

    @property
    def live_part_ids(self) -> list[str]:
        return [
            str(part.get("id"))
            for part in self.parts
            if isinstance(part, dict) and part.get("id")
        ]

    @staticmethod
    def _is_pending_interactive_part(part: dict[str, Any]) -> bool:
        if part.get("type") == "approval_request":
            approval = part.get("approval") if isinstance(part.get("approval"), dict) else {}
            status = str(approval.get("status") or "").lower()
            return status in {"pending", "pending_retry"}
        if part.get("type") == "human_input_request":
            return str(part.get("status") or "pending").lower() == "pending"
        return False

    def _merge_parts_with_existing(self, existing_parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged = deepcopy(existing_parts)
        index_by_part_id = {
            str(part.get("id")): index
            for index, part in enumerate(merged)
            if isinstance(part, dict) and part.get("id")
        }
        appended_parts: list[dict[str, Any]] = []
        replaced_indexes: list[int] = []

        for part in deepcopy(self.parts):
            if not isinstance(part, dict):
                continue
            part_id = str(part.get("id") or "")
            existing_index = index_by_part_id.get(part_id) if part_id else None
            if existing_index is not None:
                merged[existing_index] = part
                replaced_indexes.append(existing_index)
                continue
            appended_parts.append(part)

        if not appended_parts:
            return merged

        pending_index = next(
            (
                index
                for index, part in enumerate(merged)
                if isinstance(part, dict) and self._is_pending_interactive_part(part)
            ),
            None,
        )
        insert_index = len(merged)
        if pending_index is not None and (not replaced_indexes or max(replaced_indexes) < pending_index):
            insert_index = pending_index

        return [*merged[:insert_index], *appended_parts, *merged[insert_index:]]

    def to_message(self, existing: dict | None = None) -> dict:
        if existing is not None:
            message = deepcopy(existing)
            message["run_id"] = self.run_id
            message["status"] = "running"
            message["content_type"] = "parts"
            message["metadata"] = {
                **(message.get("metadata") or {}),
                "liveStreaming": True,
                "liveTextPartIds": self.live_text_part_ids,
                "livePartIds": self.live_part_ids,
            }
            existing_parts = [
                dict(part)
                for part in message.get("parts") or []
                if isinstance(part, dict)
            ]
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
                "metadata": {
                    "liveStreaming": True,
                    "liveTextPartIds": self.live_text_part_ids,
                    "livePartIds": self.live_part_ids,
                },
                "client_message_id": None,
                "created_at": self.created_at,
            }
            existing_parts = []

        message["parts"] = self._merge_parts_with_existing(existing_parts)
        message["content"] = "\n\n".join(
            str(part.get("text") or "").strip()
            for part in message["parts"]
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
    ) -> tuple[str, str]:
        if not delta:
            return message_id, part_id
        with self._lock:
            snapshot = self._get_or_create_snapshot(
                family_id=family_id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                created_by=created_by,
            )
            return snapshot.message_id, snapshot.append_delta(part_id, delta)

    def append_activity(
        self,
        *,
        family_id: str,
        conversation_id: str,
        run_id: str,
        message_id: str,
        part: dict[str, Any],
        created_by: str | None,
    ) -> tuple[str, dict[str, Any]]:
        with self._lock:
            snapshot = self._get_or_create_snapshot(
                family_id=family_id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                created_by=created_by,
            )
            return snapshot.message_id, snapshot.append_activity(part)

    def append_part(
        self,
        *,
        family_id: str,
        conversation_id: str,
        run_id: str,
        message_id: str,
        part: dict[str, Any],
        created_by: str | None,
    ) -> tuple[str, dict[str, Any]]:
        with self._lock:
            snapshot = self._get_or_create_snapshot(
                family_id=family_id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                created_by=created_by,
            )
            return snapshot.message_id, snapshot.append_part(part)

    def parts_for_run(self, run_id: str | None) -> list[dict[str, Any]]:
        if not run_id:
            return []
        with self._lock:
            snapshot = self._messages_by_run_id.get(run_id)
            if snapshot is None:
                return []
            return deepcopy(snapshot.parts)

    def _get_or_create_snapshot(
        self,
        *,
        family_id: str,
        conversation_id: str,
        run_id: str,
        message_id: str,
        created_by: str | None,
    ) -> LiveMessageSnapshot:
        snapshot = self._messages_by_run_id.get(run_id)
        if snapshot is not None:
            return snapshot
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
        if conversation_id not in self._run_ids_by_conversation_id:
            self._run_ids_by_conversation_id[conversation_id] = set()
        self._run_ids_by_conversation_id[conversation_id].add(run_id)
        return snapshot

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
                existing_message = next_messages[existing_index]
                existing_status = str(existing_message.get("status") or "").lower()
                if existing_status and existing_status not in LIVE_OVERLAY_MESSAGE_STATUSES:
                    self.clear_run(snapshot.run_id)
                    continue
                next_messages[existing_index] = snapshot.to_message(existing_message)
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
