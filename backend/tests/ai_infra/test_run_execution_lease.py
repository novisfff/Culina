from __future__ import annotations

from datetime import timedelta
import importlib.util

import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.models.domain import AIAgentRun
from tests.ai_infra.test_ai_timeline_service import make_db, create_message
from app.services.ai_timeline import AITimelineService


@pytest.fixture
def db():
    session = make_db()
    try:
        yield session
    finally:
        session.close()
        session.get_bind().dispose()


def api():
    from app.services.ai_operations import execution_lease
    return execution_lease


def claim(db):
    return api().claim_execution(db, family_id='family-service', run_id='run-service')


def test_execution_lease_support_exists():
    assert importlib.util.find_spec('app.services.ai_operations.execution_lease') is not None


def test_only_one_worker_can_claim_a_run(db):
    lease = claim(db)
    db.commit()
    assert lease.fencing_token == 1
    with pytest.raises(api().ExecutionLeaseLost):
        claim(db)
    db.rollback()


def test_claim_rejects_other_family(db):
    with pytest.raises(LookupError):
        api().claim_execution(db, family_id='other-family', run_id='run-service')


def test_heartbeat_never_revives_an_expired_lease(db):
    lease = claim(db)
    db.commit()
    from app.models.domain import AIRunExecutionLease
    row = db.get(AIRunExecutionLease, lease.run_id)
    row.lease_until = utcnow() - timedelta(seconds=1)
    db.commit()
    assert api().renew_execution(db, lease) is False
    db.rollback()
    with pytest.raises(api().ExecutionLeaseLost):
        claim(db)


def test_renew_and_release_use_exact_owner_and_generation(db):
    from dataclasses import replace
    lease = claim(db)
    db.commit()
    wrong = replace(lease, worker_id='different-worker')
    assert api().renew_execution(db, wrong) is False
    db.rollback()
    api().release_execution(db, wrong)
    db.commit()
    assert api().renew_execution(db, lease) is True
    db.commit()
    api().release_execution(db, lease)
    db.commit()
    assert api().renew_execution(db, lease) is False


def test_stale_worker_cannot_flush_domain_changes(db):
    from app.models.domain import AIRunExecutionLease, Family
    lease = claim(db)
    db.commit()
    row = db.get(AIRunExecutionLease, lease.run_id)
    row.fencing_token += 1
    row.worker_id = None
    db.commit()
    fence = api().ExecutionFence(db, lease)
    fence.install()
    try:
        family = db.get(Family, 'family-service')
        family.name = 'must-not-be-written'
        with pytest.raises(api().ExecutionLeaseLost):
            db.commit()
        db.rollback()
        assert db.get(Family, 'family-service').name == '服务家庭'
    finally:
        fence.remove()


def test_stale_worker_cannot_execute_bulk_dml_or_take_business_lock(db):
    from app.models.domain import AIRunExecutionLease
    lease = claim(db)
    db.commit()
    db.get(AIRunExecutionLease, lease.run_id).lease_until = utcnow() - timedelta(seconds=1)
    db.commit()
    fence = api().ExecutionFence(db, lease)
    fence.install()
    try:
        with pytest.raises(api().ExecutionLeaseLost):
            db.execute(update(AIAgentRun).where(AIAgentRun.id == lease.run_id).values(status='completed'))
        db.rollback()
        with pytest.raises(api().ExecutionLeaseLost):
            db.scalar(select(AIAgentRun).where(AIAgentRun.id == lease.run_id).with_for_update())
        db.rollback()
    finally:
        fence.remove()
    assert db.get(AIAgentRun, lease.run_id).status == 'running'


def test_stale_worker_cannot_append_visible_timeline(db):
    from app.models.domain import AIRunExecutionLease, AIMessage
    service = AITimelineService(db)
    message_id = create_message(service, db)
    lease = claim(db)
    db.commit()
    db.get(AIRunExecutionLease, lease.run_id).fencing_token += 1
    db.commit()
    fence = api().ExecutionFence(db, lease)
    fence.install()
    try:
        with pytest.raises(api().ExecutionLeaseLost):
            service.append_text_delta(family_id='family-service', conversation_id='conversation-service', message_id=message_id, run_id=lease.run_id, part_id='late', delta='late', created_by='user-service')
        db.rollback()
    finally:
        fence.remove()
    assert db.get(AIMessage, message_id).content == ''


def test_stale_checkpoint_writer_is_fenced(db):
    from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
    from app.models.domain import AIRunExecutionLease, AIGraphWrite
    lease = claim(db)
    db.commit()
    saver = SQLAlchemyCheckpointSaver(db)
    saver.execution_lease = lease
    db.get(AIRunExecutionLease, lease.run_id).fencing_token += 1
    db.commit()
    with pytest.raises(api().ExecutionLeaseLost):
        saver.put_writes({'configurable': {'thread_id': 'conversation-service', 'checkpoint_id': 'old'}}, [('status', 'completed')], 'old-task')
    assert db.scalar(select(AIGraphWrite)) is None


def test_provider_guard_is_per_invocation_including_nested_dispatch(db):
    from app.ai.runtime.execution_guard import GuardedChatProvider, check_dispatch_guard
    calls = []

    class Provider:
        def generate(self, *, user):
            check_dispatch_guard()
            calls.append(user)
            return user

    shared = Provider()
    guarded = GuardedChatProvider(shared, lambda: (_ for _ in ()).throw(api().ExecutionLeaseLost()))
    with pytest.raises(api().ExecutionLeaseLost):
        guarded.generate(user='stale')
    assert shared.generate(user='unrelated') == 'unrelated'
    assert calls == ['unrelated']


def test_provider_scope_marks_uncertainty_before_dispatch(db):
    from app.services.ai_operations.execution_scope import RunExecutionScope
    from app.models.domain import AIRunExecutionLease
    scope = RunExecutionScope(db, family_id='family-service', run_id='run-service')
    scope.start()
    try:
        scope.before_dispatch()
        row = db.get(AIRunExecutionLease, 'run-service')
        assert row.provider_started is True
        assert not db.dirty
    finally:
        scope.close()


def test_independent_block_persistence_cannot_bypass_stale_fence(db):
    from app.models.domain import AIRunExecutionLease
    from app.services.ai_operations.run_blocking import persist_run_auto_execution_blocked_after_rollback
    mid = create_message(AITimelineService(db), db)
    db.get(AIAgentRun, 'run-service').message_id = mid
    db.commit()
    lease = claim(db)
    db.commit()
    db.get(AIRunExecutionLease, lease.run_id).fencing_token += 1
    db.commit()
    fence = api().ExecutionFence(db, lease)
    fence.install()
    try:
        assert persist_run_auto_execution_blocked_after_rollback(db, family_id=lease.family_id, run_id=lease.run_id) is False
    finally:
        fence.remove()
    db.expire_all()
    assert db.get(AIAgentRun, lease.run_id).status == 'running'


def test_old_initial_worker_cannot_claim_a_released_later_phase(db):
    lease = claim(db)
    db.commit()
    api().release_execution(db, lease)
    db.get(AIAgentRun, lease.run_id).status = 'waiting_input'
    db.commit()
    with pytest.raises(api().ExecutionLeaseLost):
        claim(db)


def test_resume_claim_requires_exact_token_and_increments_generation(db):
    lease = claim(db)
    db.commit()
    api().release_execution(db, lease)
    run = db.get(AIAgentRun, lease.run_id)
    run.status = 'waiting_input'
    run.context_summary = {'_streamResumeClaim': {'token': 'new-phase'}}
    db.commit()
    with pytest.raises(api().ExecutionLeaseLost):
        api().claim_execution(db, family_id=lease.family_id, run_id=lease.run_id, resume_token='old-phase')
    db.rollback()
    current = api().claim_execution(db, family_id=lease.family_id, run_id=lease.run_id, resume_token='new-phase')
    db.commit()
    assert current.fencing_token == lease.fencing_token + 1
    assert api().renew_execution(db, lease) is False


def test_live_execution_cannot_leave_a_new_resume_claim(db):
    from app.ai.errors import AIConflictError
    from app.ai.workflows.runner_support.human_input_resume_claim import claim_stream_resume
    lease = claim(db)
    run = db.get(AIAgentRun, lease.run_id)
    run.status = 'waiting_approval'
    db.commit()
    with pytest.raises(AIConflictError):
        claim_stream_resume(db, run=run, kind='approval', request_id='approval', user_id='user-service')
    db.rollback()
    assert '_streamResumeClaim' not in db.get(AIAgentRun, lease.run_id).context_summary


@pytest.mark.parametrize('settings', [
    {'ai_run_heartbeat_seconds': 0},
    {'ai_run_recovery_interval_seconds': 0},
    {'ai_run_lease_seconds': 44, 'ai_run_heartbeat_seconds': 15},
])
def test_invalid_lease_timing_is_rejected(settings):
    from app.core.config import Settings
    with pytest.raises(ValueError):
        Settings(_env_file=None, **settings)


def test_shared_sqlite_checkpoint_read_cannot_rollback_worker_transaction(db):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
    from app.models.domain import Family
    lease = claim(db)
    db.commit()
    saver = SQLAlchemyCheckpointSaver(db)
    started, finished = Event(), Event()
    fence = api().ExecutionFence(db, lease)
    fence.install()

    def read_checkpoint():
        started.set()
        saver.get_tuple({'configurable': {'thread_id': 'conversation-service'}})
        finished.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            db.get(Family, 'family-service').name = 'must-survive-checkpoint-read'
            db.flush()
            future = pool.submit(read_checkpoint)
            assert started.wait(timeout=2)
            assert not finished.wait(timeout=0.05)
            db.commit()
            future.result(timeout=2)
        finally:
            db.rollback()
            fence.remove()
    db.expire_all()
    assert db.get(Family, 'family-service').name == 'must-survive-checkpoint-read'


@pytest.mark.parametrize('module', [
    'app.services.ai_operations.execution_lease',
    'app.services.ai_operations.execution_scope',
    'app.services.ai_operations.execution_worker',
])
def test_execution_modules_import_without_prior_ai_initialization(module):
    from pathlib import Path
    import subprocess
    import sys
    result = subprocess.run(
        [sys.executable, '-c', f'import {module}'],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
