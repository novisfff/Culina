from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from threading import RLock

from fastapi import HTTPException, status

from app.core.utils import utcnow


@dataclass(frozen=True)
class RealtimeVoiceSessionState:
    session_id: str
    family_id: str
    user_id: str
    provider: str
    recipe_id: str
    cook_session_id: str
    session_revision: int
    subject: dict
    created_at: datetime
    expires_at: datetime
    status: str = "listening"
    last_user_transcript: str = ""
    last_ai_run_id: str = ""


class RealtimeVoiceSessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, RealtimeVoiceSessionState] = {}
        self._lock = RLock()

    def put(self, state: RealtimeVoiceSessionState) -> None:
        with self._lock:
            self._cleanup_locked()
            stale_session_ids = [
                session_id
                for session_id, existing in self._sessions.items()
                if existing.family_id == state.family_id and existing.user_id == state.user_id
            ]
            for session_id in stale_session_ids:
                self._sessions.pop(session_id, None)
            self._sessions[state.session_id] = state

    def get(self, session_id: str) -> RealtimeVoiceSessionState:
        with self._lock:
            self._cleanup_locked()
            state = self._sessions.get(session_id)
            if state is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voice session not found")
            if state.expires_at <= utcnow():
                self._sessions.pop(session_id, None)
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Voice session expired")
            return state

    def require_owner(self, session_id: str, *, family_id: str, user_id: str) -> RealtimeVoiceSessionState:
        state = self.get(session_id)
        if state.family_id != family_id or state.user_id != user_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Voice session is not available")
        return state

    def close(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()

    def _cleanup_locked(self) -> None:
        now = utcnow()
        expired = [session_id for session_id, state in self._sessions.items() if state.expires_at <= now]
        for session_id in expired:
            self._sessions.pop(session_id, None)


realtime_voice_session_store = RealtimeVoiceSessionStore()
