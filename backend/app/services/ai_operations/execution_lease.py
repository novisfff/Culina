"""Durable ownership for chat execution; no execution/retry policy lives here."""
from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import event, func, literal_column, select, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.exc import OperationalError


from app.core.config import get_settings
from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIRunExecutionLease


class ExecutionLeaseLost(RuntimeError):
    """Fail closed: this execution is no longer allowed to produce effects."""


@dataclass(frozen=True, slots=True)
class ExecutionLease:
    family_id: str
    run_id: str
    worker_id: str
    fencing_token: int



def shared_sqlite_lock(db: Session):
    """StaticPool test Sessions share one connection, not isolated transactions."""
    bind = db.get_bind()
    if bind.dialect.name == "sqlite" and isinstance(bind.pool, StaticPool):
        from app.ai.workflows.checkpoint import _SQLITE_CHECKPOINT_LOCK
        return _SQLITE_CHECKPOINT_LOCK
    return None


def as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def database_now(db: Session) -> datetime:
    if db.get_bind().dialect.name in {"mysql", "mariadb"}:
        return as_utc(db.connection().scalar(select(func.utc_timestamp(6))))
    return utcnow()



def is_lock_contention(exc: OperationalError) -> bool:
    return bool(getattr(exc.orig, "args", ()) and exc.orig.args[0] in {1205, 1213, 3572})


def require_execution_idle(db: Session, run: AIAgentRun) -> None:
    """Called with Run locked; NOWAIT prevents the reverse-order lock cycle.

    Do not persist a resume claim while the prior execution is still finishing,
    otherwise a fast UI response can create an orphan claim behind a live lease.
    """
    from app.ai.errors import AIConflictError

    try:
        worker = db.scalar(select(AIRunExecutionLease.worker_id).where(
            AIRunExecutionLease.run_id == run.id,
            AIRunExecutionLease.family_id == run.family_id,
        ).with_for_update(nowait=True))
    except OperationalError as exc:
        if not is_lock_contention(exc):
            raise
        raise AIConflictError("上一次处理仍在收尾，请稍后刷新") from None
    if worker is not None:
        raise AIConflictError("上一次处理仍在执行或等待失联回收，请稍后刷新")


def _owned(lease: ExecutionLease):
    return (
        AIRunExecutionLease.run_id == lease.run_id,
        AIRunExecutionLease.family_id == lease.family_id,
        AIRunExecutionLease.worker_id == lease.worker_id,
        AIRunExecutionLease.fencing_token == lease.fencing_token,
    )


def claim_execution(db: Session, *, family_id: str, run_id: str, resume_token: str | None = None) -> ExecutionLease:
    # Existing rows always lock lease -> run. First claim serializes on the Run;
    # it cannot race an existing owner because the lease row does not exist yet.
    exists = db.scalar(select(AIRunExecutionLease.run_id).where(AIRunExecutionLease.run_id == run_id))
    row = db.scalar(select(AIRunExecutionLease).where(AIRunExecutionLease.run_id == run_id).with_for_update().execution_options(populate_existing=True)) if exists else None
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id).with_for_update().execution_options(populate_existing=True))
    if run is None:
        raise LookupError("运行任务不存在")
    if row is None:
        row = db.scalar(select(AIRunExecutionLease).where(AIRunExecutionLease.run_id == run_id).with_for_update().execution_options(populate_existing=True))
    if row is not None and row.worker_id is not None:
        # Expired work must be recovered, NEVER stolen and automatically replayed.
        raise ExecutionLeaseLost("运行任务已有执行者或等待失联回收")
    claim = (run.context_summary or {}).get("_streamResumeClaim")
    if resume_token is not None:
        if not isinstance(claim, dict) or not resume_token or claim.get("token") != resume_token or run.status not in {"waiting_approval", "waiting_input", "running"}:
            raise ExecutionLeaseLost("恢复任务领取已失效")
    elif row is not None or claim is not None or run.status not in {"pending", "running", "cancelling"}:
        raise ExecutionLeaseLost("运行任务已结束或执行阶段已改变")
    now = database_now(db)
    if row is None:
        row = AIRunExecutionLease(run_id=run_id, family_id=family_id, fencing_token=0)
        db.add(row)
    row.fencing_token += 1
    row.worker_id = uuid4().hex
    row.heartbeat_at = now
    row.lease_until = now + timedelta(seconds=get_settings().ai_run_lease_seconds)
    row.provider_started = False
    db.flush()
    return ExecutionLease(family_id, run_id, row.worker_id, row.fencing_token)


def renew_execution(db: Session, lease: ExecutionLease) -> bool:
    # NOWAIT avoids a heartbeat waiting behind its own business transaction.
    row = db.scalar(select(AIRunExecutionLease).where(*_owned(lease)).with_for_update(nowait=True).execution_options(populate_existing=True))
    now = database_now(db)
    if row is None or row.lease_until is None or as_utc(row.lease_until) <= now:
        return False
    mysql = db.get_bind().dialect.name in {"mysql", "mariadb"}
    current = func.utc_timestamp(6) if mysql else utcnow()
    seconds = get_settings().ai_run_lease_seconds
    deadline = func.timestampadd(literal_column("SECOND"), seconds, current) if mysql else current + timedelta(seconds=seconds)
    result = db.execute(
        update(AIRunExecutionLease)
        .where(*_owned(lease), AIRunExecutionLease.lease_until > current)
        .values(heartbeat_at=current, lease_until=deadline)
        .execution_options(synchronize_session=False)
    )
    db.expire(row)
    return result.rowcount == 1


def release_execution(db: Session, lease: ExecutionLease) -> None:
    db.execute(update(AIRunExecutionLease).where(*_owned(lease)).values(worker_id=None, lease_until=None))


class ExecutionFence:
    """Lock/validate ownership in the SAME transaction as every protected write.

    Hooks are Session-local, not global: API cancellation/approval and the reaper
    remain independent. The lease is always locked before a business row lock.
    A pre-commit recheck prevents an overlong transaction committing after expiry.
    """
    def __init__(self, db: Session, lease: ExecutionLease):
        self.db, self.lease = db, lease
        self._installed = False
        self._sqlite_lock = shared_sqlite_lock(db)
        self._sqlite_lock_held = False

    def check(self) -> None:
        if self._sqlite_lock is not None and not self._sqlite_lock_held:
            self._sqlite_lock.acquire()
            self._sqlite_lock_held = True
        table = AIRunExecutionLease.__table__
        # Connection-level SQL bypasses Session hooks and identity-map snapshots.
        row = self.db.connection().execute(select(table).where(*_owned(self.lease)).with_for_update()).mappings().first()
        if row is None or row["lease_until"] is None or as_utc(row["lease_until"]) <= database_now(self.db):
            raise ExecutionLeaseLost("执行租约已失效，禁止旧执行者继续写入")

    def _before_flush(self, *_args) -> None:
        self.check()

    def _before_commit(self, *_args) -> None:
        self.check()

    def _before_execute(self, state) -> None:
        if not state.is_select or getattr(state.statement, "_for_update_arg", None) is not None:
            self.check()

    def _transaction_ended(self, session, transaction) -> None:
        if transaction.parent is None and self._sqlite_lock_held:
            self._sqlite_lock_held = False
            self._sqlite_lock.release()

    def install(self) -> None:
        if not self._installed:
            event.listen(self.db, "before_flush", self._before_flush)
            event.listen(self.db, "before_commit", self._before_commit)
            event.listen(self.db, "after_flush_postexec", self._before_flush)
            event.listen(self.db, "do_orm_execute", self._before_execute)
            event.listen(self.db, "after_transaction_end", self._transaction_ended)
            self.db.info["ai_execution_lease"] = self.lease
            self._installed = True

    def remove(self) -> None:
        if self._installed:
            event.remove(self.db, "before_flush", self._before_flush)
            event.remove(self.db, "before_commit", self._before_commit)
            event.remove(self.db, "after_flush_postexec", self._before_flush)
            event.remove(self.db, "do_orm_execute", self._before_execute)
            event.remove(self.db, "after_transaction_end", self._transaction_ended)
            if self._sqlite_lock_held:
                self._sqlite_lock_held = False
                self._sqlite_lock.release()
            self.db.info.pop("ai_execution_lease", None)
            self._installed = False


@contextmanager
def inherited_execution_fence(source: Session, target: Session):
    """Independent error-recovery transactions retain the caller's authority."""
    lease = source.info.get("ai_execution_lease")
    fence = ExecutionFence(target, lease) if lease is not None else None
    if fence is not None:
        fence.install()
    try:
        yield
    finally:
        if fence is not None:
            fence.remove()
