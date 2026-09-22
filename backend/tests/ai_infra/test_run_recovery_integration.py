from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event

from sqlalchemy import select

from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workspace_service import AIApplicationService
from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIMessage, AIRunExecutionLease
from app.services.ai_operations.execution_lease import claim_execution
from app.services.ai_operations.run_recovery import recover_expired_runs
from ._support import AIAgentInfraTestCase, BaseChatProvider, ChatProviderResult, FakeChatProvider


class RunRecoveryIntegrationTestCase(AIAgentInfraTestCase):
    def prepare_orphan(self):
        with self.SessionLocal() as db:
            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))
            prepared = runner._prepare_user_message(
                family_id=self.family.id, user_id=self.user.id, conversation_id=None,
                prompt='你好', message_summary='你好', client_message_id=None,
                client_run_id='orphan-run', quick_task=None, subject=None,
            )
            lease = claim_execution(db, family_id=self.family.id, run_id=prepared['run_id'])
            db.get(AIRunExecutionLease, lease.run_id).lease_until = utcnow() - timedelta(seconds=1)
            db.commit()
            return prepared

    def test_cancel_orphan_then_recovery_allows_explicit_retry(self):
        prepared = self.prepare_orphan()
        blocked = self.client.post('/api/ai/chat', json={'message': '你好', 'conversation_id': prepared['conversation_id']})
        self.assertEqual(blocked.status_code, 409)
        cancelled = self.client.post('/api/ai/runs/orphan-run/cancel')
        self.assertEqual(cancelled.status_code, 202)
        with self.SessionLocal() as db:
            self.assertEqual(db.get(AIAgentRun, 'orphan-run').status, 'cancelling')
            self.assertEqual(recover_expired_runs(db), 1)
            self.assertEqual(db.get(AIAgentRun, 'orphan-run').status, 'cancelled')
        retried = self.client.post('/api/ai/runs/orphan-run/retry')
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertNotEqual(retried.json()['run']['id'], 'orphan-run')

    def test_recovery_unblocks_new_message_without_model_replay(self):
        prepared = self.prepare_orphan()
        with self.SessionLocal() as db:
            self.assertEqual(recover_expired_runs(db), 1)
            self.assertEqual(db.get(AIAgentRun, 'orphan-run').status, 'failed')
        response = self.client.post('/api/ai/chat', json={'message': '你好', 'conversation_id': prepared['conversation_id']})
        self.assertEqual(response.status_code, 200, response.text)
        with self.SessionLocal() as db:
            self.assertEqual(db.get(AIAgentRun, 'orphan-run').status, 'failed')

    def test_paused_stream_worker_cannot_overwrite_recovery_or_new_run(self):
        entered, resume = Event(), Event()
        failures = []

        class SlowProvider(BaseChatProvider):
            model_name = 'paused-test-provider'

            def generate_with_tools(self, *, message_handler=None, **kwargs):
                if message_handler:
                    message_handler('已经写入的前半段')
                entered.set()
                if not resume.wait(timeout=10):
                    raise RuntimeError('test synchronization timed out')
                if message_handler:
                    message_handler('不应写入的迟到结果')
                return ChatProviderResult(text='不应写入的迟到结果', status='completed', model=self.model_name)

        def run_stream():
            try:
                with self.SessionLocal() as db:
                    list(AIApplicationService(db, provider=SlowProvider()).stream_chat(
                        family_id=self.family.id, user_id=self.user.id, message='你好', client_run_id='paused-run',
                    ))
            except BaseException as exc:
                failures.append(exc)

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run_stream)
            try:
                self.assertTrue(entered.wait(timeout=10))
                with self.SessionLocal() as db:
                    lease = db.get(AIRunExecutionLease, 'paused-run')
                    self.assertIsNotNone(lease)
                    self.assertTrue(lease.provider_started)
                    lease.lease_until = utcnow() - timedelta(seconds=1)
                    db.commit()
                    self.assertEqual(recover_expired_runs(db), 1)
                    run = db.get(AIAgentRun, 'paused-run')
                    conversation_id = run.conversation_id
                    message = db.scalar(select(AIMessage).where(AIMessage.run_id == run.id, AIMessage.role == 'assistant'))
                    old_content = message.content
                    old_sequence = message.snapshot_sequence
                with self.SessionLocal() as db:
                    result = AIApplicationService(db, provider=FakeChatProvider()).chat(
                        family_id=self.family.id, user_id=self.user.id, message='你好', conversation_id=conversation_id,
                    )
                    db.commit()
                    new_run_id = result['run']['id']
            finally:
                resume.set()
            future.result(timeout=10)
        self.assertTrue(failures)
        with self.SessionLocal() as db:
            self.assertEqual(db.get(AIAgentRun, 'paused-run').status, 'failed')
            message = db.scalar(select(AIMessage).where(AIMessage.run_id == 'paused-run', AIMessage.role == 'assistant'))
            self.assertEqual(message.content, old_content)
            self.assertEqual(message.snapshot_sequence, old_sequence)
            self.assertEqual(db.get(AIAgentRun, new_run_id).status, 'completed')
