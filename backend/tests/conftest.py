from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from scripts.model_usage_reference_artifact import (
    finalize_reference_performance_artifact,
)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "model_usage_reference: absolute model-usage latency gate for the first-launch MySQL 8.4 reference host",
    )


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    try:
        finalize_reference_performance_artifact(
            session.config,
            exit_code=int(exitstatus),
        )
    except (OSError, ValueError):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if reporter is not None:
            reporter.write_line("model_usage_reference_artifact_write_failed", red=True)


@pytest.fixture()
def model_usage_db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        yield db
        db.rollback()
    engine.dispose()
