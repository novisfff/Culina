from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage, AIRunExecutionLease, AIConversationEvent, AIApprovalRequest, AIOperation, AITaskDraft
from app.services.ai_timeline import AITimelineService
from tests.ai_infra.test_run_execution_lease import db, claim
from tests.ai_infra.test_ai_timeline_service import create_message


def recover(db, **kwargs):
    from app.services.ai_operations.run_recovery import recover_expired_runs
    return recover_expired_runs(db, **kwargs)


def expire(db, *, provider_started=False):
    lease = claim(db)
    row = db.get(AIRunExecutionLease, lease.run_id)
    row.lease_until = utcnow() - timedelta(seconds=1)
    row.provider_started = provider_started
    db.get(AIConversation, 'conversation-service').context = {'activeRunId': lease.run_id}
    db.commit()
    return lease


def test_expired_execution_unblocks_conversation_and_is_idempotent(db):
    mid = create_message(AITimelineService(db), db)
    lease = expire(db)
    assert recover(db) == 1
    assert db.get(AIAgentRun, lease.run_id).status == 'failed'
    assert 'activeRunId' not in db.get(AIConversation, 'conversation-service').context
    assert db.get(AIMessage, mid).status == 'failed'
    assert db.get(AIRunExecutionLease, lease.run_id).fencing_token > lease.fencing_token
    count = len(list(db.scalars(select(AIConversationEvent))))
    assert recover(db) == 0
    assert len(list(db.scalars(select(AIConversationEvent)))) == count


def test_healthy_owner_is_never_reclaimed(db):
    lease = claim(db)
    db.commit()
    assert recover(db) == 0
    assert db.get(AIRunExecutionLease, lease.run_id).worker_id == lease.worker_id


def test_cancelling_orphan_becomes_cancelled(db):
    expire(db)
    db.get(AIAgentRun, 'run-service').status = 'cancelling'
    db.commit()
    assert recover(db) == 1
    assert db.get(AIAgentRun, 'run-service').status == 'cancelled'


def test_unknown_provider_outcome_is_not_automatically_retried(db):
    mid = create_message(AITimelineService(db), db)
    expire(db, provider_started=True)
    assert recover(db) == 1
    run = db.get(AIAgentRun, 'run-service')
    assert run.error_code == 'execution_outcome_unknown'
    assert '再次计费' in db.get(AIMessage, mid).content


def test_legacy_unclaimed_runs_have_grace_period(db):
    assert recover(db) == 0
    db.get(AIAgentRun, 'run-service').created_at = utcnow() - timedelta(minutes=3)
    db.commit()
    assert recover(db) == 1
    assert db.get(AIAgentRun, 'run-service').status == 'failed'


@pytest.mark.parametrize('status', ['waiting_approval', 'waiting_input'])
def test_normal_waiting_without_claim_is_untouched(db, status):
    run = db.get(AIAgentRun, 'run-service')
    run.status = status
    run.created_at = utcnow() - timedelta(days=3)
    db.commit()
    assert recover(db) == 0
    assert run.status == status


def test_abandoned_unconsumed_resume_claim_returns_to_waiting(db):
    run = db.get(AIAgentRun, 'run-service')
    run.status = 'waiting_input'
    run.created_at = utcnow() - timedelta(days=3)
    run.context_summary = {'_streamResumeClaim': {'token': 'lost', 'claimedAt': utcnow().isoformat()}}
    db.commit()
    assert recover(db) == 0
    run.context_summary = {'_streamResumeClaim': {'token': 'lost', 'claimedAt': (utcnow() - timedelta(minutes=3)).isoformat()}}
    db.commit()
    assert recover(db) == 1
    assert run.status == 'waiting_input'
    assert '_streamResumeClaim' not in run.context_summary


def test_pending_approval_survives_expired_worker(db):
    expire(db)
    db.add(AIApprovalRequest(id='approval', family_id='family-service', conversation_id='conversation-service', run_id='run-service', draft_id='draft', draft_version=1, draft_schema_version='recipe.v1', approval_type='recipe.create', status='pending'))
    db.commit()
    assert recover(db) == 1
    assert db.get(AIAgentRun, 'run-service').status == 'waiting_approval'
    assert db.get(AIApprovalRequest, 'approval').status == 'pending'


def test_completed_business_result_is_preserved_not_rerun_or_whole_task_completed(db):
    mid = create_message(AITimelineService(db), db)
    card = {'id': 'result', 'type': 'result_card', 'card': {'type': 'operation_result', 'data': {'operationStatus': 'completed'}}}
    AITimelineService(db).append_part(family_id='family-service', conversation_id='conversation-service', message_id=mid, run_id='run-service', part=card)
    db.add(AITaskDraft(id='draft', family_id='family-service', conversation_id='conversation-service', source_run_id='run-service', status='executed', draft_type='recipe.create', payload_hash='hash', idempotency_key='draft-key'))
    db.add(AIOperation(id='op', family_id='family-service', run_id='run-service', draft_id='draft', operation_type='recipe.create', status='completed', idempotency_key='op-key', result_json={'entityId': 'keep-me'}))
    db.commit()
    expire(db, provider_started=True)
    assert recover(db) == 1
    assert db.get(AIAgentRun, 'run-service').status == 'failed'
    assert card in db.get(AIMessage, mid).parts
    assert db.get(AIOperation, 'op').result_json == {'entityId': 'keep-me'}
    assert db.get(AITaskDraft, 'draft').status == 'executed'


def test_recovery_is_family_scoped(db):
    expire(db)
    assert recover(db, family_id='other-family') == 0
    assert db.get(AIAgentRun, 'run-service').status == 'running'


def test_pending_operation_is_reported_as_unknown_not_as_committed(db):
    mid = create_message(AITimelineService(db), db)
    db.add(AIOperation(id='pending-op', family_id='family-service', run_id='run-service', draft_id='draft', operation_type='recipe.create', status='pending', idempotency_key='pending-key'))
    db.commit()
    expire(db)
    assert recover(db) == 1
    assert db.get(AIAgentRun, 'run-service').error_code == 'execution_outcome_unknown'
    assert db.get(AIOperation, 'pending-op').status == 'pending'
    assert '未确认' in db.get(AIMessage, mid).content


def test_orphan_cancellation_also_cancels_pending_interaction(db):
    from app.models.domain import AIRunCancelRequest
    mid = create_message(AITimelineService(db), db)
    AITimelineService(db).append_part(family_id='family-service', conversation_id='conversation-service', message_id=mid, run_id='run-service', part={'id': 'input', 'type': 'human_input_request', 'status': 'pending', 'request': {'id': 'ask'}})
    db.add(AIRunCancelRequest(family_id='family-service', run_id='run-service', requested_by='user-service'))
    db.commit()
    expire(db)
    db.get(AIAgentRun, 'run-service').status = 'cancelling'
    db.commit()
    assert recover(db) == 1
    part = next(p for p in db.get(AIMessage, mid).parts if p['id'] == 'input')
    assert part['status'] == 'cancelled'
