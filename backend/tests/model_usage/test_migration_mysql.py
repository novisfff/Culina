from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Iterator

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import MembershipStatus, UserRole
from app.models.domain import (
    AIImageGenerationJob,
    AIRunTraceSpan,
    Family,
    Membership,
    SearchIndexJob,
    User,
)


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def require_model_usage_mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not url.database or not url.database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


@dataclass
class MySqlAlembicDatabase:
    url: URL

    @classmethod
    def from_test_url(cls, url: URL) -> MySqlAlembicDatabase:
        return cls(url=url)

    @property
    def engine(self):
        return create_engine(self.url, pool_pre_ping=True)

    def _admin_url(self) -> URL:
        return URL.create(
            drivername=self.url.drivername,
            username=self.url.username,
            password=self.url.password,
            host=self.url.host,
            port=self.url.port,
            database=None,
            query=self.url.query,
        )

    def recreate(self) -> None:
        assert self.url.database is not None
        engine = create_engine(self._admin_url(), isolation_level="AUTOCOMMIT")
        try:
            with engine.connect() as connection:
                connection.execute(text(f"DROP DATABASE IF EXISTS `{self.url.database}`"))
                connection.execute(
                    text(
                        f"CREATE DATABASE `{self.url.database}` "
                        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                    )
                )
        finally:
            engine.dispose()

    def dispose(self) -> None:
        assert self.url.database is not None
        engine = create_engine(self._admin_url(), isolation_level="AUTOCOMMIT")
        try:
            with engine.connect() as connection:
                connection.execute(text(f"DROP DATABASE IF EXISTS `{self.url.database}`"))
        finally:
            engine.dispose()

    @contextmanager
    def _settings(self) -> Iterator[None]:
        env = {
            "MYSQL_HOST": self.url.host or "127.0.0.1",
            "MYSQL_PORT": str(self.url.port or 3306),
            "MYSQL_DATABASE": self.url.database or "",
            "MYSQL_USER": self.url.username or "",
            "MYSQL_PASSWORD": self.url.password or "",
        }
        previous = {key: os.environ.get(key) for key in env}
        os.environ.update(env)
        get_settings.cache_clear()
        try:
            yield
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            get_settings.cache_clear()

    def upgrade(self, revision: str) -> None:
        with self._settings():
            config = Config(str(BACKEND_ROOT / "alembic.ini"))
            config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
            command.upgrade(config, revision)

    def downgrade(self, revision: str) -> None:
        with self._settings():
            config = Config(str(BACKEND_ROOT / "alembic.ini"))
            config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
            command.downgrade(config, revision)

    def current_revision(self) -> str:
        return str(self.scalar("SELECT version_num FROM alembic_version"))

    def seed_existing_families(self) -> None:
        now = datetime.now(timezone.utc)
        with Session(self.engine) as db, db.begin():
            families = (
                Family(id="family-a", name="家庭 A", created_at=now, updated_at=now),
                Family(id="family-b", name="家庭 B", created_at=now, updated_at=now),
            )
            users = (
                User(
                    id="user-a",
                    username="model-usage-a",
                    display_name="成员 A",
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                ),
                User(
                    id="user-b",
                    username="model-usage-b",
                    display_name="成员 B",
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                ),
                User(
                    id="user-c",
                    username="model-usage-c",
                    display_name="成员 C",
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                ),
            )
            db.add_all((*families, *users))
            db.flush()
            db.add_all(
                (
                    Membership(
                        id="membership-a",
                        family_id="family-a",
                        user_id="user-a",
                        role=UserRole.OWNER,
                        status=MembershipStatus.ACTIVE,
                        created_at=now,
                        updated_at=now,
                    ),
                    Membership(
                        id="membership-b",
                        family_id="family-a",
                        user_id="user-b",
                        role=UserRole.MEMBER,
                        status=MembershipStatus.ACTIVE,
                        created_at=now,
                        updated_at=now,
                    ),
                    Membership(
                        id="membership-c",
                        family_id="family-b",
                        user_id="user-c",
                        role=UserRole.OWNER,
                        status=MembershipStatus.ACTIVE,
                        created_at=now,
                        updated_at=now,
                    ),
                    AIImageGenerationJob(
                        id="existing-image-job",
                        family_id="family-a",
                        user_id="user-a",
                        status="succeeded",
                        request_payload={"historical": True},
                        attempt_count=1,
                        created_at=now,
                        updated_at=now,
                    ),
                    SearchIndexJob(
                        id="existing-search-job",
                        family_id="family-b",
                        user_id="user-c",
                        status="succeeded",
                        entity_type="food",
                        entity_id="historical-food",
                        target_name="历史索引",
                        vector_status="indexed",
                        attempt_count=1,
                        created_at=now,
                        updated_at=now,
                    ),
                    AIRunTraceSpan(
                        id="existing-trace-span",
                        family_id="family-a",
                        run_id="historical-run",
                        trace_id="historical-trace",
                        span_id="historical-span",
                        span_type="provider",
                        name="historical-provider-call",
                        status="succeeded",
                        started_at=now,
                        ended_at=now,
                        duration_ms=1,
                        input_summary={},
                        output_summary={},
                        payload={},
                    ),
                )
            )

    def scalar(self, sql: str, params: dict[str, object] | None = None):
        with self.engine.connect() as connection:
            return connection.execute(text(sql), params or {}).scalar()

    def rows(self, sql: str) -> list[tuple]:
        with self.engine.connect() as connection:
            return [tuple(row) for row in connection.execute(text(sql)).all()]

    def execute(self, sql: str, params: dict[str, object]) -> None:
        with self.engine.begin() as connection:
            connection.execute(text(sql), params)


@pytest.fixture()
def mysql_alembic_database() -> Iterator[MySqlAlembicDatabase]:
    database = MySqlAlembicDatabase.from_test_url(require_model_usage_mysql_url())
    database.recreate()
    try:
        yield database
    finally:
        database.dispose()


def test_upgrade_initializes_policy_and_subjects_without_usage(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("1c2d3e4f5a6b")
    database.seed_existing_families()
    database.upgrade("2d3e4f5a6b7c")

    assert database.scalar("SELECT COUNT(*) FROM model_usage_events") == 0
    assert database.scalar("SELECT COUNT(*) FROM model_usage_family_policies") == 2
    assert database.scalar("SELECT COUNT(*) FROM model_usage_policy_versions") == 2
    assert database.scalar(
        "SELECT COUNT(*) FROM model_usage_family_policies "
        "WHERE current_policy_version_id IS NULL"
    ) == 0
    assert database.scalar("SELECT COUNT(*) FROM model_usage_subjects") == 5
    creators = database.rows(
        """
        SELECT s.subject_kind, s.user_id
        FROM model_usage_policy_versions AS p
        JOIN model_usage_subjects AS s ON s.id = p.created_by_subject_id
        WHERE p.version_number = 1
        ORDER BY p.family_id
        """
    )
    assert creators == [("system", None), ("system", None)]
    assert database.scalar(
        "SELECT COUNT(*) FROM model_usage_subjects "
        "WHERE subject_key LIKE '%user-a%' OR dimension_key LIKE '%user-a%'"
    ) == 0


def _claim_context(database: MySqlAlembicDatabase) -> dict[str, object]:
    subject_id, subject_key, policy_version_id = database.rows(
        """
        SELECT s.id, s.subject_key, p.current_policy_version_id
        FROM model_usage_subjects AS s
        JOIN model_usage_family_policies AS p ON p.family_id = s.family_id
        WHERE s.family_id = 'family-a' AND s.subject_kind = 'system'
        """
    )[0]
    now = datetime.now(timezone.utc)
    return {
        "family_id": "family-a",
        "subject_id": subject_id,
        "subject_key": subject_key,
        "policy_version_id": policy_version_id,
        "now": now,
    }


def _insert_reservation(
    database: MySqlAlembicDatabase,
    context: dict[str, object],
    *,
    row_id: str,
    attempt_key: str,
    client_attempt_id: str,
) -> None:
    database.execute(
        """
        INSERT INTO model_usage_reservations (
            id, attempt_key, client_attempt_id, fingerprint, family_id,
            subject_id, subject_key, attribution_kind, operation_source,
            logical_operation_id, operation_kind, capability, provider,
            requested_model, billing_model, variant_key, billing_scheme_key,
            recovery_mode, policy_version_id, pricing_status, period_start,
            period_end, status, reserved_at, updated_at
        ) VALUES (
            :id, :attempt_key, :client_attempt_id, 'fingerprint', :family_id,
            :subject_id, :subject_key, 'system', 'background_index',
            'logical-operation', 'test', 'embedding', 'test-provider',
            'test-model', 'test-model', 'default', 'test-scheme',
            'none', :policy_version_id, 'unpriced', :now,
            :now, 'reserved', :now, :now
        )
        """,
        {**context, "id": row_id, "attempt_key": attempt_key, "client_attempt_id": client_attempt_id},
    )


def _insert_event(
    database: MySqlAlembicDatabase,
    context: dict[str, object],
    *,
    row_id: str,
    attempt_key: str,
    client_attempt_id: str,
) -> None:
    database.execute(
        """
        INSERT INTO model_usage_events (
            id, reservation_id, recovery_source, attempt_key, fingerprint,
            client_attempt_id, family_id, subject_id, subject_key, capability,
            provider, requested_model, billing_model, variant_key,
            billing_scheme_key, pricing_status, policy_version_id,
            dispatch_policy_version_id, period_start, period_end,
            provider_outcome, execution_certainty, measurement_status, cost_cny,
            dispatched_at, completed_at, created_at
        ) VALUES (
            :id, NULL, 'fail_open_receipt', :attempt_key, 'fingerprint',
            :client_attempt_id, :family_id, :subject_id, :subject_key, 'embedding',
            'test-provider', 'test-model', 'test-model', 'default',
            'test-scheme', 'priced', :policy_version_id,
            :policy_version_id, :now, :now,
            'not_billed', 'confirmed_not_executed', 'exact', 0,
            :now, :now, :now
        )
        """,
        {**context, "id": row_id, "attempt_key": attempt_key, "client_attempt_id": client_attempt_id},
    )


def test_mysql_enforces_model_usage_idempotency_uniques(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("1c2d3e4f5a6b")
    database.seed_existing_families()
    database.upgrade("2d3e4f5a6b7c")
    context = _claim_context(database)

    _insert_reservation(
        database,
        context,
        row_id="reservation-a",
        attempt_key="attempt-1",
        client_attempt_id="mua-reservation-a",
    )
    with pytest.raises(IntegrityError):
        _insert_reservation(
            database,
            context,
            row_id="reservation-b",
            attempt_key="attempt-1",
            client_attempt_id="mua-reservation-b",
        )

    _insert_event(
        database,
        context,
        row_id="event-a",
        attempt_key="fail-open-1",
        client_attempt_id="mua-event-a",
    )
    with pytest.raises(IntegrityError):
        _insert_event(
            database,
            context,
            row_id="event-b",
            attempt_key="fail-open-1",
            client_attempt_id="mua-event-b",
        )

    database.execute(
        """
        INSERT INTO model_usage_adjustment_groups (
            id, family_id, idempotency_key, fingerprint, subject_id, subject_key,
            period_start, period_end, source_event_id, source_reservation_id,
            reason_code, operator, change_ticket, evidence_ref, created_at
        ) VALUES (
            'adjustment-a', :family_id, 'adjust-1', 'fingerprint-a',
            :subject_id, :subject_key, :now, :now, 'event-a', NULL,
            'test', 'test-operator', 'test-ticket', 'test-evidence', :now
        )
        """,
        context,
    )
    with pytest.raises(IntegrityError):
        database.execute(
            """
            INSERT INTO model_usage_adjustment_groups (
                id, family_id, idempotency_key, fingerprint, subject_id, subject_key,
                period_start, period_end, source_event_id, source_reservation_id,
                reason_code, operator, change_ticket, evidence_ref, created_at
            ) VALUES (
                'adjustment-b', :family_id, 'adjust-1', 'fingerprint-b',
                :subject_id, :subject_key, :now, :now, 'event-a', NULL,
                'test', 'test-operator', 'test-ticket', 'test-evidence', :now
            )
            """,
            context,
        )


def test_mysql_upgrade_downgrade_upgrade_is_reversible(
    mysql_alembic_database: MySqlAlembicDatabase,
) -> None:
    database = mysql_alembic_database
    database.upgrade("2d3e4f5a6b7c")
    database.downgrade("1c2d3e4f5a6b")
    assert database.scalar(
        "SELECT COUNT(*) FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_name LIKE 'model_usage_%'"
    ) == 0
    database.upgrade("2d3e4f5a6b7c")
    assert database.current_revision() == "2d3e4f5a6b7c"
