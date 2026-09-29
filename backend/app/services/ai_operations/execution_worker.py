from __future__ import annotations

import logging
from threading import Event, Thread

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.ai_operations.run_recovery import recover_expired_runs

logger = logging.getLogger(__name__)


class RunRecoveryWorker:
    def __init__(self, *, session_factory=SessionLocal):
        self._session_factory = session_factory
        self._stop = Event()
        self._thread: Thread | None = None

    def run_once(self) -> int:
        with self._session_factory() as db:
            return recover_expired_runs(db)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("AI Run recovery scan failed")
            self._stop.wait(get_settings().ai_run_recovery_interval_seconds)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._loop, name="ai-run-recovery", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
