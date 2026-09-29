"""Real InnoDB lock tests. Never run against a non-disposable database."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
from threading import Barrier
import time
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, event, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.db.base import Base
from app.models.domain import AIAgentRun, Family, AIRunExecutionLease
from app.services.ai_operations.execution_lease import ExecutionFence, ExecutionLeaseLost, claim_execution, database_now, renew_execution
from app.services.ai_operations.run_recovery import recover_expired_runs


@pytest.fixture
def mysql_runs():
    url = os.environ.get('CULINA_TEST_MYSQL_URL', '').strip()
    if not url:
        pytest.skip('CULINA_TEST_MYSQL_URL is not set; SQLite cannot validate InnoDB locking')
    parsed = make_url(url)
    if parsed.get_backend_name() != 'mysql' or not (parsed.database or '').endswith('_test'):
        pytest.fail('A dedicated MySQL database ending in _test is required')
    engine = create_engine(url, poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def bounded_lock_wait(connection, _record):
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION innodb_lock_wait_timeout=5")

    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    family_id, run_id = f'lease-family-{uuid4().hex}', f'lease-run-{uuid4().hex}'
    with sessions() as db:
        db.add(Family(id=family_id, name='lease-test', motto='', location=''))
        db.flush()
        db.add(AIAgentRun(id=run_id, family_id=family_id, status='running', agent_key='workspace_orchestrator', feature_key='ai_workspace_chat'))
        db.commit()
    try:
        yield sessions, family_id, run_id
    finally:
        with sessions() as db:
            db.execute(delete(Family).where(Family.id == family_id))
            db.commit()
        engine.dispose()


def test_two_mysql_workers_can_only_claim_once(mysql_runs):
    sessions, family, run = mysql_runs
    barrier = Barrier(2)

    def attempt():
        with sessions() as db:
            barrier.wait(timeout=5)
            try:
                lease = claim_execution(db, family_id=family, run_id=run)
                db.commit()
                return lease
            except ExecutionLeaseLost:
                db.rollback()
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: attempt(), range(2)))
    assert sum(result is not None for result in results) == 1


def test_mysql_reaper_skips_locked_worker_then_rolls_back_expired_commit(mysql_runs):
    sessions, family, run = mysql_runs
    with sessions() as db:
        lease = claim_execution(db, family_id=family, run_id=run)
        deadline = database_now(db) + timedelta(seconds=3)
        db.get(AIRunExecutionLease, run).lease_until = deadline
        db.commit()
    with sessions() as worker:
        fence = ExecutionFence(worker, lease)
        fence.install()
        try:
            family_row = worker.scalar(select(Family).where(Family.id == family).with_for_update())
            family_row.name = 'must-rollback'
            worker.flush()
            # Let DB time, not the Python host clock, pass the durable deadline.
            with sessions() as clock_db:
                while database_now(clock_db) <= deadline:
                    time.sleep(0.05)
            with sessions() as reaper:
                assert recover_expired_runs(reaper) == 0  # NOWAIT: owner still holds the fence
            with pytest.raises(ExecutionLeaseLost):
                worker.commit()
            worker.rollback()
        finally:
            fence.remove()
    with sessions() as reaper:
        assert recover_expired_runs(reaper) == 1
        assert reaper.get(Family, family).name == 'lease-test'
        assert reaper.get(AIAgentRun, run).status == 'failed'
        assert not renew_execution(reaper, lease)


def test_mysql_stale_snapshot_cannot_write_after_recovery(mysql_runs):
    sessions, family, run = mysql_runs
    with sessions() as db:
        lease = claim_execution(db, family_id=family, run_id=run)
        db.commit()
    with sessions() as old:
        cached = old.get(AIAgentRun, run)  # REPEATABLE READ snapshot predates recovery
        with sessions() as reaper:
            reaper.get(AIRunExecutionLease, run).lease_until = database_now(reaper) - timedelta(seconds=1)
            reaper.commit()
            assert recover_expired_runs(reaper) == 1
        fence = ExecutionFence(old, lease)
        fence.install()
        try:
            cached.status = 'completed'
            with pytest.raises(ExecutionLeaseLost):
                old.commit()
            old.rollback()
        finally:
            fence.remove()
    with sessions() as db:
        assert db.get(AIAgentRun, run).status == 'failed'


def test_mysql_competing_reapers_only_recover_once(mysql_runs):
    sessions, family, run = mysql_runs
    with sessions() as db:
        claim_execution(db, family_id=family, run_id=run)
        db.get(AIRunExecutionLease, run).lease_until = database_now(db) - timedelta(seconds=1)
        db.commit()
    barrier = Barrier(2)

    def recover():
        with sessions() as db:
            barrier.wait(timeout=5)
            return recover_expired_runs(db)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: recover(), range(2)))
    assert sum(results) == 1


def test_mysql_graph_checkpoint_and_heartbeat_do_not_wait_on_own_fence(mysql_runs, monkeypatch):
    from types import SimpleNamespace
    from app.ai.runtime.types import BaseChatProvider, ChatProviderResult
    from app.ai.workspace_service import AIApplicationService
    from app.core.enums import MembershipStatus, UserRole
    from app.models.domain import User, Membership
    from app.services.ai_operations import execution_lease, execution_scope

    sessions, family, _run = mysql_runs
    timing = SimpleNamespace(ai_run_lease_seconds=3, ai_run_heartbeat_seconds=1)
    monkeypatch.setattr(execution_lease, 'get_settings', lambda: timing)
    monkeypatch.setattr(execution_scope, 'get_settings', lambda: timing)
    user_id = f'lease-user-{uuid4().hex}'

    class SlowProvider(BaseChatProvider):
        model_name = 'mysql-lease-test'

        def generate_with_tools(self, **kwargs):
            # Longer than the lease: only an independent heartbeat can keep it alive.
            time.sleep(4)
            return ChatProviderResult(text='你好', status='completed', model=self.model_name)

    with sessions() as db:
        db.add(User(id=user_id, username=user_id, display_name='test', avatar_seed='', is_active=True))
        db.flush()
        db.add(Membership(family_id=family, user_id=user_id, role=UserRole.OWNER, status=MembershipStatus.ACTIVE))
        db.commit()
    try:
        with sessions() as db:
            result = AIApplicationService(db, provider=SlowProvider()).chat(family_id=family, user_id=user_id, message='你好')
            db.commit()
            assert result['run']['status'] == 'completed'
            row = db.get(AIRunExecutionLease, result['run']['id'])
            assert row.worker_id is None
            assert row.provider_started
    finally:
        with sessions() as db:
            db.execute(delete(User).where(User.id == user_id))
            db.commit()
