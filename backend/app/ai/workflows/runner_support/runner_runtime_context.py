from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session


@dataclass(frozen=True)
class RunnerRuntimeContext:
    db: Session
    provider: Any
    service: Any
    skill_registry: Any
    checkpointer: Any
    json_record: Callable[[Any], Any]
    cancel_requested: Callable[[str], bool]
    commit_stream_checkpoint: Callable[..., bool]
    optional_stream_writer: Callable[[], Any]
    persistent_progress_writer: Callable[[Any, Any], Any]
    tracer_for_state: Callable[[Any], Any]
