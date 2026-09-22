"""Execution lifetime belongs to the worker, never to the SSE subscriber."""
from __future__ import annotations

from contextlib import nullcontext
import logging
from threading import Event, Thread

from sqlalchemy import update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings
from app.models.domain import AIRunExecutionLease
from app.services.ai_operations.execution_lease import ExecutionFence, ExecutionLeaseLost, claim_execution, release_execution, renew_execution, is_lock_contention, shared_sqlite_lock

logger = logging.getLogger(__name__)


class RunExecutionScope:
    def __init__(self, db: Session, *, family_id: str, run_id: str, resume_token: str | None = None):
        self.db = db
        self.family_id, self.run_id, self.resume_token = family_id, run_id, resume_token
        self.lease = None
        self.fence = None
        self._stop = Event()
        self._heartbeat: Thread | None = None
        self._sessions = sessionmaker(bind=db.get_bind(), expire_on_commit=False)

    def start(self) -> None:
        try:
            with shared_sqlite_lock(self.db) or nullcontext():
                self.lease = claim_execution(self.db, family_id=self.family_id, run_id=self.run_id, resume_token=self.resume_token)
                self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        self.fence = ExecutionFence(self.db, self.lease)
        self.fence.install()
        # In-memory SQLite fixtures share ONE physical connection across Sessions.
        # Never let a background heartbeat commit another Session's transaction.
        bind = self.db.get_bind()
        if not (bind.dialect.name == "sqlite" and isinstance(bind.pool, StaticPool)):
            self._heartbeat = Thread(target=self._renew_loop, name=f"ai-run-heartbeat-{self.run_id}", daemon=True)
            self._heartbeat.start()

    def _renew_loop(self) -> None:
        while not self._stop.wait(get_settings().ai_run_heartbeat_seconds):
            try:
                with self._sessions() as db:
                    if not renew_execution(db, self.lease):
                        return
                    db.commit()
            except OperationalError as exc:
                if not is_lock_contention(exc):
                    logger.warning("AI Run heartbeat unavailable run_id=%s", self.run_id)
            except Exception:
                logger.exception("AI Run heartbeat failed run_id=%s", self.run_id)
            # Failed heartbeat grants no authority; every write checks DB expiry.

    def before_dispatch(self) -> None:
        if self.fence is None or self.lease is None:
            raise ExecutionLeaseLost("执行者未领取任务")
        # Called only at provider boundaries, never within a domain commit.
        # Finish the preceding trace/tool phase before waiting on the network.
        self.fence.check()
        self.db.execute(update(AIRunExecutionLease).where(
            AIRunExecutionLease.run_id == self.run_id,
            AIRunExecutionLease.family_id == self.family_id,
            AIRunExecutionLease.worker_id == self.lease.worker_id,
            AIRunExecutionLease.fencing_token == self.lease.fencing_token,
        ).values(provider_started=True))
        self.db.commit()

    def close(self, *, failed: bool = False) -> None:
        self._stop.set()
        if self._heartbeat is not None:
            self._heartbeat.join(timeout=2)
        try:
            if not failed and self.fence is not None:
                self.db.commit()
            else:
                self.db.rollback()
        except BaseException:
            self.db.rollback()
            raise
        finally:
            if self.fence is not None:
                self.fence.remove()
        # On failure keep ownership until expiry: the reaper projects any partial
        # result instead of allowing an unobserved exception to strand a Run.
        if not failed and self.lease is not None:
            with shared_sqlite_lock(self.db) or nullcontext():
                release_execution(self.db, self.lease)
                self.db.commit()
