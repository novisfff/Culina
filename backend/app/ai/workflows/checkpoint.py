from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from threading import RLock
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    ChannelVersions,
    get_checkpoint_id,
    get_checkpoint_metadata,
)
from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.core.utils import utcnow
from app.models.domain import AIGraphCheckpoint, AIGraphWrite


def _binary_blob(value: bytes | bytearray | memoryview) -> bytes:
    return bytes(value)


_SQLITE_CHECKPOINT_LOCK = RLock()


class SQLAlchemyCheckpointSaver(BaseCheckpointSaver[int]):
    """LangGraph checkpointer backed by the current SQLAlchemy session."""

    def __init__(self, db: Session) -> None:
        super().__init__()
        self.db = db
        bind = db.get_bind()
        self._is_sqlite = bind.dialect.name == "sqlite"
        self._use_shared_session = False
        self._session_factory = sessionmaker(bind=bind, expire_on_commit=False)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        query = select(AIGraphCheckpoint).where(
            AIGraphCheckpoint.thread_id == thread_id,
            AIGraphCheckpoint.checkpoint_ns == checkpoint_ns,
        )
        if checkpoint_id:
            query = query.where(AIGraphCheckpoint.checkpoint_id == checkpoint_id)
        else:
            query = query.order_by(AIGraphCheckpoint.checkpoint_id.desc())
        with self._session() as db:
            row = db.scalar(query.limit(1))
            if row is None:
                return None
            writes = list(
                db.scalars(
                    select(AIGraphWrite)
                    .where(
                        AIGraphWrite.thread_id == row.thread_id,
                        AIGraphWrite.checkpoint_ns == row.checkpoint_ns,
                        AIGraphWrite.checkpoint_id == row.checkpoint_id,
                    )
                    .order_by(AIGraphWrite.task_id.asc(), AIGraphWrite.write_idx.asc())
                )
            )
            config_with_checkpoint = {
                "configurable": {
                    "thread_id": row.thread_id,
                    "checkpoint_ns": row.checkpoint_ns,
                    "checkpoint_id": row.checkpoint_id,
                }
            }
            return CheckpointTuple(
                config=config_with_checkpoint,
                checkpoint=self.serde.loads_typed((row.checkpoint_type, row.checkpoint_blob)),
                metadata=self.serde.loads_typed((row.metadata_type, row.metadata_blob)),
                pending_writes=[
                    (item.task_id, item.channel, self.serde.loads_typed((item.value_type, item.value_blob)))
                    for item in writes
                ],
                parent_config=(
                    {
                        "configurable": {
                            "thread_id": row.thread_id,
                            "checkpoint_ns": row.checkpoint_ns,
                            "checkpoint_id": row.parent_checkpoint_id,
                        }
                    }
                    if row.parent_checkpoint_id
                    else None
                ),
            )

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        thread_id = config["configurable"]["thread_id"] if config else None
        checkpoint_ns = config["configurable"].get("checkpoint_ns") if config else None
        checkpoint_id = get_checkpoint_id(config) if config else None
        before_checkpoint_id = get_checkpoint_id(before) if before else None
        query = select(AIGraphCheckpoint)
        if thread_id is not None:
            query = query.where(AIGraphCheckpoint.thread_id == thread_id)
        if checkpoint_ns is not None:
            query = query.where(AIGraphCheckpoint.checkpoint_ns == checkpoint_ns)
        if checkpoint_id is not None:
            query = query.where(AIGraphCheckpoint.checkpoint_id == checkpoint_id)
        if before_checkpoint_id is not None:
            query = query.where(AIGraphCheckpoint.checkpoint_id < before_checkpoint_id)
        query = query.order_by(AIGraphCheckpoint.checkpoint_id.desc())
        yielded = 0
        with self._session() as db:
            rows = list(db.scalars(query))
        for row in rows:
            metadata = self.serde.loads_typed((row.metadata_type, row.metadata_blob))
            if filter and any(metadata.get(key) != value for key, value in filter.items()):
                continue
            if limit is not None and yielded >= limit:
                break
            yielded += 1
            tuple_config = {
                "configurable": {
                    "thread_id": row.thread_id,
                    "checkpoint_ns": row.checkpoint_ns,
                    "checkpoint_id": row.checkpoint_id,
                }
            }
            checkpoint_tuple = self.get_tuple(tuple_config)
            if checkpoint_tuple is not None:
                yield checkpoint_tuple

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        del new_versions
        thread_id, checkpoint_ns, _checkpoint_id = self._config_parts(config)
        checkpoint_id = checkpoint["id"]
        checkpoint_type, checkpoint_blob = self.serde.dumps_typed(checkpoint)
        metadata_type, metadata_blob = self.serde.dumps_typed(get_checkpoint_metadata(config, metadata))
        row_id = self._checkpoint_row_id(thread_id, checkpoint_ns, checkpoint_id)
        with self._session(write=True) as db:
            existing_id = db.scalar(select(AIGraphCheckpoint.id).where(AIGraphCheckpoint.id == row_id))
            values = {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": checkpoint_id,
                "parent_checkpoint_id": config["configurable"].get("checkpoint_id"),
                "checkpoint_type": checkpoint_type,
                "checkpoint_blob": _binary_blob(checkpoint_blob),
                "metadata_type": metadata_type,
                "metadata_blob": _binary_blob(metadata_blob),
            }
            if existing_id is None:
                db.execute(insert(AIGraphCheckpoint).values(id=row_id, created_at=utcnow(), **values))
            else:
                db.execute(update(AIGraphCheckpoint).where(AIGraphCheckpoint.id == row_id).values(**values))
        return {"configurable": {"thread_id": thread_id, "checkpoint_ns": checkpoint_ns, "checkpoint_id": checkpoint_id}}

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        if not checkpoint_id:
            return
        with self._session(write=True) as db:
            for index, (channel, value) in enumerate(writes):
                write_idx = WRITES_IDX_MAP.get(channel, index)
                row_id = self._write_row_id(thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx)
                existing_id = db.scalar(select(AIGraphWrite.id).where(AIGraphWrite.id == row_id))
                if write_idx >= 0 and existing_id is not None:
                    continue
                value_type, value_blob = self.serde.dumps_typed(value)
                values = {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": checkpoint_id,
                    "task_id": task_id,
                    "task_path": task_path,
                    "write_idx": write_idx,
                    "channel": channel,
                    "value_type": value_type,
                    "value_blob": _binary_blob(value_blob),
                }
                if existing_id is None:
                    db.execute(insert(AIGraphWrite).values(id=row_id, created_at=utcnow(), **values))
                else:
                    db.execute(update(AIGraphWrite).where(AIGraphWrite.id == row_id).values(**values))

    def delete_thread(self, thread_id: str) -> None:
        with self._session(write=True) as db:
            db.execute(delete(AIGraphWrite).where(AIGraphWrite.thread_id == thread_id))
            db.execute(delete(AIGraphCheckpoint).where(AIGraphCheckpoint.thread_id == thread_id))

    def _config_parts(self, config: RunnableConfig) -> tuple[str, str, str | None]:
        configurable = config.get("configurable") or {}
        thread_id = str(configurable["thread_id"])
        checkpoint_ns = str(configurable.get("checkpoint_ns") or "")
        checkpoint_id = configurable.get("checkpoint_id")
        return thread_id, checkpoint_ns, str(checkpoint_id) if checkpoint_id else None

    def _checkpoint_row_id(self, thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> str:
        return f"{thread_id}:{checkpoint_ns}:{checkpoint_id}"

    def _write_row_id(self, thread_id: str, checkpoint_ns: str, checkpoint_id: str, task_id: str, write_idx: int) -> str:
        return f"{thread_id}:{checkpoint_ns}:{checkpoint_id}:{task_id}:{write_idx}"

    @contextmanager
    def _session(self, *, write: bool = False) -> Iterator[Session]:
        lock = _SQLITE_CHECKPOINT_LOCK if self._is_sqlite else None
        if lock is not None:
            lock.acquire()
        if self._use_shared_session:
            try:
                with self.db.no_autoflush:
                    yield self.db
            finally:
                if lock is not None:
                    lock.release()
            return
        try:
            with self._session_factory() as db:
                yield db
                if write:
                    db.commit()
        finally:
            if lock is not None:
                lock.release()
