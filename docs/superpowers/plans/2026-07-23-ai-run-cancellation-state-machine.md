# AI Run Cancellation State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one durable, idempotent cancellation state machine for the main AI workspace and every cooking-assistant transport, with lock-safe approval/input recovery and backend-confirmed frontend status.

**Architecture:** Persist cancellation intent in a new `ai_run_cancel_requests` table before attempting to lock a run. Route every run transition through lock-and-recheck helpers, let waiting states finalize synchronously, and let active workers cooperatively finalize `cancelling` runs. On the frontend, share one per-run cancellation controller that aborts a stream only after a 200/202 response and treats `cancelled` as backend-owned state.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, MySQL, LangGraph checkpoints, pytest/unittest, React 18, TypeScript, Vitest, React Query, SSE, WebSocket.

## Global Constraints

- Work only on branch `feat/ai-run-cancellation`; never commit these changes on `main`.
- Keep formal writes on `draft -> approval -> service commit`; cancellation never gives the model a write tool.
- Once an approval business transaction has started, do not roll it back solely because cancellation arrived; commit the business result once and suppress continuation and later AI output.
- Every family-scoped read and write filters by the authenticated `family_id`; inaccessible cross-family runs return 404.
- `cancelling` is an active run status and blocks a second run in the same conversation.
- The frontend displays “已取消” only after the backend returns or synchronizes `run.status=cancelled`.
- A 404, 409, or 500 cancellation response never aborts the active stream and never creates a local cancelled message/event.
- Main chat, approval resume, human-input resume, cooking SSE, cooking voice SSE, and realtime cooking turns share the same cancellation semantics.
- Cooking assistant keeps `persist_history=false`; transient conversation data may be deleted, while `AIAgentRun` and cancellation audit data remain.
- Cancellation is distinct from failure and rejection in run, message, part, approval, draft, and event status.
- Use TDD for every production change: run the new test and observe the specified failure before implementation.
- Preserve user-owned worktree changes and stage only the files named by each task.

---

## File Structure

### New backend files

- `backend/alembic/versions/1c2d3e4f5a6b_add_ai_run_cancel_requests.py`: schema for durable pre-run cancellation intent.
- `backend/app/services/ai_operations/run_cancellation.py`: cancellation request upsert, run locking, state transitions, waiting-state cascade, event/message/context finalization, and status serialization input.
- `backend/tests/ai_infra/test_run_cancellation.py`: idempotency, pre-run, state/event semantics, refresh, family isolation, checkpoint guard, and worker finalization tests.
- `backend/tests/ai_infra/test_run_cancellation_concurrency.py`: approval/cancel and human-input/cancel races using explicit barriers.

### New frontend files

- `frontend/src/lib/aiStreamAbort.ts`: typed abort reasons and the single expected-abort predicate.
- `frontend/src/lib/aiStreamAbort.test.ts`: expected and unexpected abort classification.
- `frontend/src/hooks/useAiRunCancellation.ts`: per-run promise deduplication, 200/202 handling, polling, visible errors, and controller abort.
- `frontend/src/hooks/useAiRunCancellation.test.tsx`: rapid-click, polling, failure, and run-isolation tests.

### Existing backend files to modify

- `backend/app/models/domain.py`: `AIRunCancelRequest` ORM model.
- `backend/app/models/__init__.py`: model export.
- `backend/app/schemas/ai.py`: cancellation response DTOs and `cancelled` event status.
- `backend/app/services/serializers.py`: cancellation request serializer.
- `backend/app/ai/workflows/runner_support/run_status.py`: `CANCELLING` and complete active/terminal sets.
- `backend/app/ai/workflows/conversations.py`: treat `cancelling` as active.
- `backend/app/ai/workflows/live_stream_cache.py`: treat `cancelling` as unfinished.
- `backend/app/ai/workflows/run_lifecycle.py`: retain retry/regenerate helpers; remove the legacy cancellation writer.
- `backend/app/ai/workspace_service.py`: expose cancellation request/apply/query facade methods.
- `backend/app/api/ai.py`: two-phase POST and read-only GET cancellation endpoints.
- `backend/app/ai/workflows/runner_support/user_message_preparer.py`: honor cancellation intent before provider execution.
- `backend/app/ai/workflows/runner.py`: check durable intent as well as run status.
- `backend/app/ai/workflows/runner_support/run_finalizer.py`: lock and recheck before terminal writes.
- `backend/app/ai/workflows/runner_support/assistant_result_persister.py`: prevent post-cancel assistant persistence.
- `backend/app/ai/workflows/runner_support/runtime_failure_persister.py`: prevent cancellation from becoming failure.
- `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py`: prevent a cancelled run from returning to approval.
- `backend/app/ai/workflows/runner_support/approval_followup_streamer.py`: stop continuation after cancellation.
- `backend/app/services/ai_operations/approval_decisions.py`: run-first lock order and pre/post-business-write cancellation checks.
- `backend/app/services/ai_operations/messages.py`: cancelled approval/draft/activity part synchronization.
- `backend/app/ai/workflows/runner_support/approval_resume_preparer.py`: run lock and checkpoint recheck.
- `backend/app/ai/workflows/runner_support/approval_resume_handler.py`: do not overwrite cancellation during resume.
- `backend/app/ai/workflows/runner_support/human_input_resume.py`: cancelled human-input part/context helpers.
- `backend/app/ai/workflows/runner_support/human_input_resume_preparer.py`: run lock, cancellation guard, and checkpoint re-read.
- `backend/app/ai/workflows/runner_support/human_input_resume_handler.py`: lock-safe response persistence.
- `backend/app/services/ai_audio/cooking_voice_stream.py`: preserve caller-provided run ID and cancellation terminal response.
- `backend/app/api/ai_audio.py`: realtime turn ID/run ID unification and service-backed `cancel_turn`/hangup.
- `backend/tests/ai_audio/test_ai_audio_api.py`: SSE and realtime cancellation transport tests.

### Existing frontend files to modify

- `frontend/src/api/types.ts`: cancellation DTOs, `cancelling`, and `cancelled` event/part status.
- `frontend/src/api/aiApi.ts`: POST cancellation and GET cancellation status clients.
- `frontend/src/api/aiApi.test.ts`: response parsing and request-path tests.
- `frontend/src/components/ai/useAiConversationStreams.ts`: shared AbortError handling in all three main flows.
- `frontend/src/components/ai/AiWorkspace.tsx`: shared cancellation hook, backend-confirmed UI, and visible failure state.
- `frontend/src/components/ai/AiMobilePage.tsx`: cancel phase/disabled props.
- `frontend/src/components/ai/AiConversationThread.tsx`: cancelled activity and human-input rendering.
- `frontend/src/components/ai/aiWorkspaceHelpers.tsx`: cancelled part merge and pending-state rules.
- `frontend/src/components/ai/AiWorkspace.test.tsx`: rapid click, 200/202/404/409/500, approval/input abort, and refresh tests.
- `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`: final confirmation and two-conversation isolation.
- `frontend/src/components/ai/AiConversationThread.test.tsx`: cancelled event/input presentation.
- `frontend/src/lib/aiWorkspaceContracts.test.ts`: cross-end cancellation enum contract.
- `frontend/src/components/recipes/useCookingAssistantStream.ts`: shared cancellation controller and non-danger cancellation message.
- `frontend/src/components/recipes/useCookingAssistantStream.test.tsx`: accepted/failed stop behavior.
- `frontend/src/components/recipes/CookingAssistantPanel.tsx`: in-flight state and visible error.
- `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts`: `cancel_turn` acknowledgement and hangup sequencing.
- `frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx`: turn cancellation acknowledgement.
- `frontend/src/styles/09-ai-workspace.css`: 44px main send/stop target and cancelling state.
- `frontend/src/styles/03-recipe-workspace.css`: 44px cooking send/stop target and error state.

---

### Task 1: Persist Cancellation Intent and Status Vocabulary

**Files:**
- Create: `backend/alembic/versions/1c2d3e4f5a6b_add_ai_run_cancel_requests.py`
- Modify: `backend/app/models/domain.py:806`
- Modify: `backend/app/models/__init__.py:1`
- Modify: `backend/app/ai/workflows/runner_support/run_status.py:1`
- Modify: `backend/app/ai/workflows/conversations.py:15`
- Modify: `backend/app/ai/workflows/live_stream_cache.py:11`
- Test: `backend/tests/ai_infra/test_run_cancellation.py`

**Interfaces:**
- Produces: `AIRunCancelRequest`, `CANCELLING`, `FALLBACK`, `ACTIVE_RUN_STATUSES`, `TERMINAL_RUN_STATUSES`.
- Consumes: existing `AIAgentRun`, `Family`, `User`, `create_id`, and `utcnow` conventions.

- [ ] **Step 1: Write the failing model/status tests**

Create `backend/tests/ai_infra/test_run_cancellation.py` with the following initial tests:

```python
from sqlalchemy import select

from ._support import *
from app.ai.workflows.conversations import ACTIVE_CONVERSATION_RUN_STATUSES
from app.ai.workflows.runner_support.run_status import ACTIVE_RUN_STATUSES, CANCELLING
from app.models.domain import AIRunCancelRequest


class AIRunCancellationTestCase(AIAgentInfraTestCase):
    def test_cancelling_is_an_active_run_status(self) -> None:
        self.assertEqual(CANCELLING, "cancelling")
        self.assertIn(CANCELLING, ACTIVE_RUN_STATUSES)
        self.assertIn(CANCELLING, ACTIVE_CONVERSATION_RUN_STATUSES)

    def test_cancel_request_is_unique_per_family_and_run(self) -> None:
        with self.SessionLocal() as db:
            first = AIRunCancelRequest(
                id="run_cancel-first",
                family_id=self.family.id,
                run_id="agent_run-precreate",
                requested_by=self.user.id,
                status="requested",
                outcome_code="cancel_requested",
            )
            db.add(first)
            db.commit()
            loaded = db.scalar(
                select(AIRunCancelRequest).where(
                    AIRunCancelRequest.family_id == self.family.id,
                    AIRunCancelRequest.run_id == "agent_run-precreate",
                )
            )
            self.assertEqual(loaded.id, first.id)
```

- [ ] **Step 2: Run the tests and observe the missing model/constants**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py
```

Expected: collection fails because `AIRunCancelRequest`, `CANCELLING`, and `ACTIVE_RUN_STATUSES` do not exist.

- [ ] **Step 3: Add the migration and ORM model**

Create the migration with revision `1c2d3e4f5a6b`, `down_revision = "0b1c2d3e4f5a"`, a non-FK `run_id`, family/user foreign keys, unique constraint `uq_ai_run_cancel_requests_family_run`, and indexes for `run_id` and `(family_id, status)`:

```python
def upgrade() -> None:
    op.create_table(
        "ai_run_cancel_requests",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("requested_by", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("outcome_code", sa.String(length=64), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["family_id"], ["families.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("family_id", "run_id", name="uq_ai_run_cancel_requests_family_run"),
    )
    op.create_index("ix_ai_run_cancel_requests_run_id", "ai_run_cancel_requests", ["run_id"], unique=False)
    op.create_index(
        "ix_ai_run_cancel_requests_family_status",
        "ai_run_cancel_requests",
        ["family_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_run_cancel_requests_family_status", table_name="ai_run_cancel_requests")
    op.drop_index("ix_ai_run_cancel_requests_run_id", table_name="ai_run_cancel_requests")
    op.drop_table("ai_run_cancel_requests")
```

Add the matching SQLAlchemy model with defaults `status="requested"`, `outcome_code="cancel_requested"`, `requested_at=utcnow`, and nullable `resolved_at`. Export it from `backend/app/models/__init__.py`.

- [ ] **Step 4: Add centralized status sets**

Replace scattered literals with these definitions in `run_status.py` and import them from conversation/cache code:

```python
CANCELLING = "cancelling"
FALLBACK = "fallback"
ACTIVE_RUN_STATUSES = {PENDING, RUNNING, WAITING_APPROVAL, WAITING_INPUT, CANCELLING}
TERMINAL_RUN_STATUSES = {COMPLETED, FAILED, FALLBACK, CANCELLED}
```

- [ ] **Step 5: Run the tests and migration metadata check**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py
cd backend && .venv/bin/alembic heads
```

Expected: tests pass and Alembic reports `1c2d3e4f5a6b (head)`.

- [ ] **Step 6: Commit the persistence primitive**

```bash
git add backend/alembic/versions/1c2d3e4f5a6b_add_ai_run_cancel_requests.py backend/app/models/domain.py backend/app/models/__init__.py backend/app/ai/workflows/runner_support/run_status.py backend/app/ai/workflows/conversations.py backend/app/ai/workflows/live_stream_cache.py backend/tests/ai_infra/test_run_cancellation.py
git commit -m "feat: persist AI run cancellation intent"
```

---

### Task 2: Build the Idempotent Cancellation Service and HTTP Contract

**Files:**
- Create: `backend/app/services/ai_operations/run_cancellation.py`
- Modify: `backend/app/schemas/ai.py:119,518`
- Modify: `backend/app/services/serializers.py:574`
- Modify: `backend/app/ai/workspace_service.py:30,406`
- Modify: `backend/app/ai/workflows/run_lifecycle.py:1`
- Modify: `backend/app/api/ai.py:1,947`
- Test: `backend/tests/ai_infra/test_run_cancellation.py`

**Interfaces:**
- Consumes: `AIRunCancelRequest`, `CANCELLING`, current authentication, and `commit_session`.
- Produces: `record_run_cancellation_request()`, `apply_run_cancellation_request()`, `get_run_cancellation_result()`, `is_run_cancellation_requested()`, `AIRunCancellationResponse`.

- [ ] **Step 1: Add failing API tests for pre-run, replay, 404, and 409**

Add these test methods to `AIRunCancellationTestCase` using the existing authenticated `self.client` and database helpers:

```python
def test_cancel_before_run_exists_returns_202_and_replays_one_request(self) -> None:
    first = self.client.post("/api/ai/runs/agent_run-before-create/cancel")
    second = self.client.post("/api/ai/runs/agent_run-before-create/cancel")
    self.assertEqual(first.status_code, 202, first.text)
    self.assertEqual(second.status_code, 202, second.text)
    self.assertEqual(first.json()["request"]["run_id"], "agent_run-before-create")
    with self.SessionLocal() as db:
        count = db.scalar(
            select(func.count(AIRunCancelRequest.id)).where(
                AIRunCancelRequest.family_id == self.family.id,
                AIRunCancelRequest.run_id == "agent_run-before-create",
            )
        )
    self.assertEqual(count, 1)

def test_cancel_completed_run_returns_structured_409(self) -> None:
    run_id = self._create_completed_run()
    response = self.client.post(f"/api/ai/runs/{run_id}/cancel")
    self.assertEqual(response.status_code, 409, response.text)
    self.assertEqual(response.json()["detail"]["code"], "run_not_cancellable")
    self.assertEqual(response.json()["detail"]["run_status"], "completed")

def test_cross_family_run_cancel_returns_404(self) -> None:
    run_id = self._create_run_for_other_family()
    response = self.client.post(f"/api/ai/runs/{run_id}/cancel")
    self.assertEqual(response.status_code, 404, response.text)

def test_cancel_internal_failure_keeps_durable_request(self) -> None:
    failing_client = TestClient(app, raise_server_exceptions=False)
    with patch(
        "app.ai.workspace_service.apply_run_cancellation_request",
        side_effect=RuntimeError("cancel apply failed"),
    ):
        response = failing_client.post("/api/ai/runs/agent_run-apply-failure/cancel")
    self.assertEqual(response.status_code, 500, response.text)
    with self.SessionLocal() as db:
        request = db.scalar(
            select(AIRunCancelRequest).where(
                AIRunCancelRequest.family_id == self.family.id,
                AIRunCancelRequest.run_id == "agent_run-apply-failure",
            )
        )
    self.assertEqual(request.status, "requested")
```

Implement the fixture helpers in the test class:

```python
def _create_completed_run(self) -> str:
    return self._seed_visibility_run(
        "agent_run-completed-cancel-test",
        owner_user_id=self.user.id,
        visibility=AIConversationVisibility.PRIVATE,
    ).id

def _create_run_for_other_family(self) -> str:
    with self.SessionLocal() as db:
        run = AIAgentRun(
            id="agent_run-other-family-cancel-test",
            family_id=self.other_family.id,
            conversation_id=None,
            message_id=None,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="general_chat",
            input_summary="其他家庭任务",
            context_summary={},
            output_summary="",
            status="running",
            model="fake-model",
            input={},
            output={},
            tool_calls=[],
            created_by=self.user.id,
        )
        db.add(run)
        db.commit()
        return run.id
```

- [ ] **Step 2: Run the API tests and observe legacy 404/409 behavior**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "before_run or completed_run or cross_family or internal_failure"
```

Expected: pre-run cancellation returns 404 and the structured response keys are missing.

- [ ] **Step 3: Implement service result types and two-phase operations**

Define the exact service API:

```python
@dataclass(frozen=True)
class RunCancellationResult:
    outcome: Literal["cancel_requested", "cancelled", "already_cancelled", "run_not_cancellable"]
    request: AIRunCancelRequest
    run: AIAgentRun | None
    events: list[AIRunEvent]
    http_status: int


def record_run_cancellation_request(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> AIRunCancelRequest:
    run = db.get(AIAgentRun, run_id)
    if run is not None:
        if run.family_id != family_id:
            raise LookupError("运行任务不存在")
        require_ai_run_access(db, family_id=family_id, user_id=user_id, run_id=run_id, capability="contribute")
    existing = db.scalar(
        select(AIRunCancelRequest).where(
            AIRunCancelRequest.family_id == family_id,
            AIRunCancelRequest.run_id == run_id,
        )
    )
    if existing is not None:
        return existing
    request = AIRunCancelRequest(
        id=create_id("run_cancel"),
        family_id=family_id,
        run_id=run_id,
        requested_by=user_id,
        status="requested",
        outcome_code="cancel_requested",
    )
    try:
        with db.begin_nested():
            db.add(request)
            db.flush()
        return request
    except IntegrityError:
        existing = db.scalar(
            select(AIRunCancelRequest).where(
                AIRunCancelRequest.family_id == family_id,
                AIRunCancelRequest.run_id == run_id,
            )
        )
        if existing is None:
            raise
        return existing


def apply_run_cancellation_request(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> RunCancellationResult:
    request = db.scalar(
        select(AIRunCancelRequest)
        .where(AIRunCancelRequest.family_id == family_id, AIRunCancelRequest.run_id == run_id)
        .with_for_update()
    )
    if request is None:
        raise LookupError("取消请求不存在")
    run = db.scalar(
        select(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .with_for_update()
    )
    if run is None:
        if request.requested_by != user_id:
            raise LookupError("运行任务不存在")
        return RunCancellationResult("cancel_requested", request, None, [], 202)
    require_ai_run_access(db, family_id=family_id, user_id=user_id, run_id=run_id, capability="contribute")
    events = list(
        db.scalars(
            select(AIRunEvent)
            .where(AIRunEvent.family_id == family_id, AIRunEvent.run_id == run_id)
            .order_by(AIRunEvent.created_at.asc(), AIRunEvent.id.asc())
        )
    )
    if run.status == "cancelled":
        request.status = "applied"
        request.outcome_code = "already_cancelled"
        request.resolved_at = request.resolved_at or utcnow()
        return RunCancellationResult("already_cancelled", request, run, events, 200)
    if run.status in {"completed", "failed", "fallback"}:
        request.status = "rejected"
        request.outcome_code = "run_not_cancellable"
        request.resolved_at = utcnow()
        return RunCancellationResult("run_not_cancellable", request, run, events, 409)
    if run.status != "cancelling":
        run.status = "cancelling"
    return RunCancellationResult("cancel_requested", request, run, events, 202)


def get_run_cancellation_result(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> RunCancellationResult:
    request = db.scalar(
        select(AIRunCancelRequest).where(
            AIRunCancelRequest.family_id == family_id,
            AIRunCancelRequest.run_id == run_id,
        )
    )
    if request is None:
        raise LookupError("取消请求不存在")
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None and request.requested_by != user_id:
        raise LookupError("取消请求不存在")
    if run is not None:
        require_ai_run_access(db, family_id=family_id, user_id=user_id, run_id=run_id, capability="view")
    events = list(
        db.scalars(
            select(AIRunEvent)
            .where(AIRunEvent.family_id == family_id, AIRunEvent.run_id == run_id)
            .order_by(AIRunEvent.created_at.asc(), AIRunEvent.id.asc())
        )
    )
    if run is not None and run.status == "cancelled":
        outcome = "already_cancelled" if request.outcome_code == "already_cancelled" else "cancelled"
        return RunCancellationResult(outcome, request, run, events, 200)
    if request.status == "rejected":
        return RunCancellationResult("run_not_cancellable", request, run, events, 409)
    return RunCancellationResult("cancel_requested", request, run, events, 202)


def is_run_cancellation_requested(db: Session, *, family_id: str, run_id: str) -> bool:
    return bool(
        db.scalar(
            select(AIRunCancelRequest.id).where(
                AIRunCancelRequest.family_id == family_id,
                AIRunCancelRequest.run_id == run_id,
                AIRunCancelRequest.status.in_({"requested", "applied"}),
            )
        )
    )
```

Serialize the dataclass through one exact helper:

```python
def serialize_run_cancellation_result(result: RunCancellationResult) -> dict[str, Any]:
    return {
        "outcome": result.outcome,
        "request": serialize_ai_run_cancel_request(result.request),
        "run": serialize_ai_run(result.run) if result.run is not None else None,
        "events": [serialize_ai_run_event(event) for event in result.events],
    }
```

For an existing run, call `require_ai_run_access()` before upsert. For a missing run, create a family/user-scoped request. Before treating a run as missing, query its primary key without returning foreign ownership details; if a row exists outside the family, raise `LookupError("运行任务不存在")`.

Handle simultaneous inserts by flushing the new request inside a savepoint, catching `IntegrityError`, rolling back the savepoint, and re-reading the unique `(family_id, run_id)` row. Never replace its original `requested_by` or `requested_at`.

- [ ] **Step 4: Add DTOs, serializers, application facade, and routes**

Add `AIRunCancellationRequestDTO` and `AIRunCancellationResponse` to `schemas/ai.py`; extend `AIRunEventStatus` with `"cancelled"`. The POST route must commit the request before applying it:

```python
@router.post("/api/ai/runs/{run_id}/cancel", response_model=AIRunCancellationResponse)
def cancel_ai_run(run_id: str, response: Response, auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> dict:
    user, membership = auth
    service = AIApplicationService(db)
    try:
        service.record_run_cancellation(family_id=membership.family_id, user_id=user.id, run_id=run_id)
        commit_session(db)
        result = service.apply_run_cancellation(family_id=membership.family_id, user_id=user.id, run_id=run_id)
        commit_session(db)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if result["outcome"] == "run_not_cancellable":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "run_not_cancellable", "run_status": result["run"]["status"], "recovery_hint": "refresh"},
        )
    response.status_code = status.HTTP_202_ACCEPTED if result["outcome"] == "cancel_requested" else status.HTTP_200_OK
    return result
```

Expose these facade signatures on `AIApplicationService` and serialize the dataclass result there:

```python
def record_run_cancellation(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
    request = record_run_cancellation_request(self.db, family_id=family_id, user_id=user_id, run_id=run_id)
    return serialize_ai_run_cancel_request(request)

def apply_run_cancellation(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
    return serialize_run_cancellation_result(
        apply_run_cancellation_request(self.db, family_id=family_id, user_id=user_id, run_id=run_id)
    )

def get_run_cancellation(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
    return serialize_run_cancellation_result(
        get_run_cancellation_result(self.db, family_id=family_id, user_id=user_id, run_id=run_id)
    )
```

Add the GET route with the same access rules and response model. Remove the old `cancel_workspace_run()` import and implementation after all call sites use the new service.

- [ ] **Step 5: Run API/service tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "before_run or completed_run or cross_family or internal_failure"
```

Expected: all selected tests pass; repeated pre-run POST returns the same persisted request.

- [ ] **Step 6: Commit the HTTP contract**

```bash
git add backend/app/services/ai_operations/run_cancellation.py backend/app/schemas/ai.py backend/app/services/serializers.py backend/app/ai/workspace_service.py backend/app/ai/workflows/run_lifecycle.py backend/app/api/ai.py backend/tests/ai_infra/test_run_cancellation.py
git commit -m "feat: add idempotent AI run cancellation API"
```

---

### Task 3: Honor Pre-Run Cancellation and Protect Worker Finalization

**Files:**
- Modify: `backend/app/ai/workflows/runner_support/user_message_preparer.py:61`
- Modify: `backend/app/ai/workflows/runner.py:596`
- Modify: `backend/app/ai/workflows/runner_support/run_finalizer.py:29`
- Modify: `backend/app/ai/workflows/runner_support/assistant_result_persister.py:50`
- Modify: `backend/app/ai/workflows/runner_support/runtime_failure_persister.py:120`
- Modify: `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py:145`
- Modify: `backend/app/ai/workflows/runner_support/approval_followup_streamer.py:330`
- Test: `backend/tests/ai_infra/test_run_cancellation.py`
- Test: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**
- Consumes: Task 2 cancellation lookup and finalization helpers.
- Produces: provider-free pre-run cancellation and cancellation-safe worker transitions.

- [ ] **Step 1: Add failing provider and finalizer tests**

Add a provider that fails if called and test the cancelled response:

```python
class ProviderMustNotRun(BaseChatProvider):
    model_name = "must-not-run"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("provider must not run after pre-run cancellation")

    def generate_with_tools(self, *, system: str, user: str, tools, tool_handler, message_handler=None, max_rounds: int = 8) -> ChatProviderResult:
        raise AssertionError("provider must not run after pre-run cancellation")


def test_precreated_cancel_request_skips_provider_and_returns_cancelled(self) -> None:
    run_id = "agent_run-precreated-cancel"
    self.client.post(f"/api/ai/runs/{run_id}/cancel")
    with patch("app.ai.workspace_service.get_chat_provider", return_value=ProviderMustNotRun()):
        response = self.client.post("/api/ai/chat", json={"message": "安排晚餐", "client_run_id": run_id})
    self.assertEqual(response.status_code, 200, response.text)
    self.assertEqual(response.json()["run"]["status"], "cancelled")
    self.assertEqual(response.json()["message"]["status"], "cancelled")
```

Add a test that sets a run to `cancelling`, invokes `RunFinalizer.finalize()` with graph state `completed`, and asserts run/message/conversation remain or become `cancelled`.

- [ ] **Step 2: Run the tests and observe provider/finalizer failures**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "skips_provider or finalizer"
```

Expected: the provider is called or finalizer overwrites the cancellation state.

- [ ] **Step 3: Add lock-and-recheck transition helpers**

Add this exact primitive to `run_cancellation.py` and use it before every terminal/approval transition listed in this task:

```python
def lock_run_for_transition(db: Session, *, family_id: str, run_id: str) -> AIAgentRun:
    run = db.scalar(
        select(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .with_for_update()
    )
    if run is None:
        raise LookupError("运行任务不存在")
    return run


def cancellation_wins(db: Session, *, run: AIAgentRun) -> bool:
    return run.status in {"cancelling", "cancelled"} or is_run_cancellation_requested(
        db,
        family_id=run.family_id,
        run_id=run.id,
    )
```

`RunFinalizer`, result persistence, failure persistence, draft publication, and approval follow-up must acquire the run through this helper immediately before writing status. If `cancellation_wins()` is true, call the cancellation finalizer and return without writing a non-cancel status.

- [ ] **Step 4: Make user-message preparation consume pre-run intent**

After creating the run but before starting the graph, check the request. When found, create a terminal assistant message with content `已中止这次处理。`, finalize run/message/conversation as cancelled, mark the request applied, commit, and return:

```python
return PreparedUserMessage(
    existing=True,
    conversation_id=conversation.id,
    run_id=run.id,
    user_message_id=user_message.id,
    subject=normalized_subject,
    attachments=user_attachment_summaries,
)
```

This makes both `/chat` and `/chat/stream` reuse `_chat_response()` without provider execution.

- [ ] **Step 5: Run focused and existing streaming cancellation tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "skips_provider or finalizer"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_workspace_streaming.py -k "cancel or finalize"
```

Expected: all selected tests pass; no status writer changes cancelled back to completed or failed.

- [ ] **Step 6: Commit worker safety**

```bash
git add backend/app/services/ai_operations/run_cancellation.py backend/app/ai/workflows/runner_support/user_message_preparer.py backend/app/ai/workflows/runner.py backend/app/ai/workflows/runner_support/run_finalizer.py backend/app/ai/workflows/runner_support/assistant_result_persister.py backend/app/ai/workflows/runner_support/runtime_failure_persister.py backend/app/ai/workflows/runner_support/progressive_draft_publisher.py backend/app/ai/workflows/runner_support/approval_followup_streamer.py backend/tests/ai_infra/test_run_cancellation.py backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "fix: preserve AI cancellation through worker finalization"
```

---

### Task 4: Finalize Waiting Approval/Input and Separate Cancelled Semantics

**Files:**
- Modify: `backend/app/services/ai_operations/run_cancellation.py`
- Modify: `backend/app/services/ai_operations/messages.py:19`
- Modify: `backend/app/ai/workflows/runner_support/human_input_resume.py:72`
- Modify: `backend/app/ai/workflows/checkpoint.py:96`
- Test: `backend/tests/ai_infra/test_run_cancellation.py`
- Test: `backend/tests/ai_infra/test_workspace_phase_flows.py`

**Interfaces:**
- Consumes: Task 2 service and `SQLAlchemyCheckpointSaver.delete_thread()`.
- Produces: `cancelled_human_input_request_parts()` and a complete waiting-state cancellation cascade.

- [ ] **Step 1: Add failing waiting-input and cancellation-semantic tests**

Build a waiting-input fixture through the existing human-input provider path, cancel it, then assert:

```python
self.assertEqual(run.status, "cancelled")
self.assertIsNone(run.error)
self.assertEqual(message.status, "cancelled")
self.assertEqual(human_part["status"], "cancelled")
self.assertNotIn("response", human_part)
self.assertNotIn("pendingHumanInput", run.context_summary)
self.assertNotIn("pendingHumanInput", conversation.context.get("taskState", {}))
self.assertNotIn("activeRunId", conversation.context)
self.assertEqual(checkpoint_count, 0)
self.assertEqual(write_count, 0)
self.assertTrue(all(event.status == "cancelled" for event in unfinished_events))
```

Add a waiting-approval test asserting `approval.status == "cancelled"`, `approval.decision is None`, `draft.status == "cancelled"`, `message.status == "cancelled"`, and the embedded approval/draft parts carry the same status.

- [ ] **Step 2: Run the tests and observe 409/failed/rejected remnants**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "waiting_input or waiting_approval or event_semantics"
```

Expected: waiting input is rejected, approval draft becomes rejected, and cancel events are failed.

- [ ] **Step 3: Implement cancelled part/context helpers**

Add the helper:

```python
def cancelled_human_input_request_parts(
    parts: list[dict[str, Any]] | None,
    *,
    request_id: str,
    cancelled_at: str,
) -> list[dict[str, Any]]:
    return [
        {
            **part,
            "status": "cancelled",
            "cancelled_at": cancelled_at,
            "cancellation": {"reason": "user_cancel", "message": "已取消这次任务"},
        }
        if isinstance(part, dict)
        and part.get("type") == "human_input_request"
        and str((part.get("request") or {}).get("id") or "") == request_id
        else part
        for part in parts or []
        if isinstance(part, dict)
    ]
```

Add a message activity helper that rewrites embedded `run_activity.activity.status` from pending/running/waiting to cancelled. Update `sync_message_approval_parts()` to set the message status to cancelled when approval/draft cancellation is synchronized.

- [ ] **Step 4: Complete the waiting-state cascade**

In one transaction after run lock:

- lock pending approvals by stable ID, then drafts by stable ID, then assistant messages, then conversation;
- set approval status cancelled without a rejected decision;
- set pending/pending_retry drafts to cancelled;
- set assistant message and unfinished parts/events to cancelled;
- remove pending human input and active run context;
- add `lastHumanInputCancellation={requestId, cancelledAt, requestedBy}` only for input cancellation;
- delete graph checkpoints and writes for the conversation;
- create exactly one `user_cancel` event with status cancelled;
- mark the cancellation request applied and resolved.

- [ ] **Step 5: Run waiting-state and existing phase-flow tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "waiting_input or waiting_approval or event_semantics"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_workspace_phase_flows.py -k "approval or human_input"
```

Expected: all selected tests pass and existing approval/input flows retain their non-cancel behavior.

- [ ] **Step 6: Commit waiting-state finalization**

```bash
git add backend/app/services/ai_operations/run_cancellation.py backend/app/services/ai_operations/messages.py backend/app/ai/workflows/runner_support/human_input_resume.py backend/app/ai/workflows/checkpoint.py backend/tests/ai_infra/test_run_cancellation.py backend/tests/ai_infra/test_workspace_phase_flows.py
git commit -m "fix: fully cancel waiting AI runs"
```

---

### Task 5: Enforce Run-First Approval Locking and Post-Commit Cancellation

**Files:**
- Create: `backend/tests/ai_infra/test_run_cancellation_concurrency.py`
- Modify: `backend/app/services/ai_operations/approval_decisions.py:122`
- Modify: `backend/app/ai/workflows/runner_support/approval_resume_preparer.py:35`
- Modify: `backend/app/ai/workflows/runner_support/approval_resume_handler.py:27`

**Interfaces:**
- Consumes: `lock_run_for_transition()`, `cancellation_wins()`, and Task 4 cancellation finalizer.
- Produces: deterministic cancel-wins-before-write and commit-once-then-stop semantics.

- [ ] **Step 1: Write three barrier-based failing concurrency tests**

Create a test service hook around `execute_ai_operation_draft` and use `threading.Event` barriers. The first test records cancellation before approval acquires the run lock and asserts zero business rows. The second lets approval acquire the run lock and enter the business write, records cancellation, releases the write, and asserts:

```python
self.assertEqual(operation_count, 1)
self.assertEqual(business_entity_count, 1)
self.assertEqual(provider_followup_calls, 0)
self.assertEqual(run.status, "cancelled")
self.assertEqual(cancel_request.status, "applied")
```

Use the exact test names `test_cancel_wins_before_approval_business_write`, `test_approval_business_write_commits_once_then_cancel_stops_continuation`, and `test_approval_failure_rolls_back_business_write_but_keeps_cancel_request`.

In the failure test, make `execute_ai_operation_draft` insert its business row and then raise `RuntimeError("approval write failed")` inside the nested transaction. Assert the business row and `AIOperation` do not remain, while the independently committed `AIRunCancelRequest` still has `status="requested"` and can be applied by a new session.

- [ ] **Step 2: Run both tests and observe the race**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation_concurrency.py -k "approval"
```

Expected: cancellation and approval can overwrite each other or the follow-up provider starts.

- [ ] **Step 3: Change approval acquisition to the fixed order**

Implement this order inside `apply_ai_approval_decision()`:

```python
approval_ref = db.scalar(
    select(AIApprovalRequest).where(
        AIApprovalRequest.id == approval_id,
        AIApprovalRequest.family_id == family_id,
        AIApprovalRequest.conversation_id == conversation_id,
    )
)
if approval_ref is None:
    raise LookupError("确认请求不存在")
run = lock_run_for_transition(db, family_id=family_id, run_id=str(approval_ref.run_id or ""))
approval = db.scalar(
    select(AIApprovalRequest)
    .where(AIApprovalRequest.id == approval_id, AIApprovalRequest.family_id == family_id)
    .with_for_update()
)
if approval is None or approval.run_id != run.id:
    raise AIConflictError("确认请求关联的运行状态已变化，请刷新后重试")
```

Then lock draft and operation. Before business execution, reject if cancellation wins. After business execution, use a locking/current read of `AIRunCancelRequest`; if cancellation arrived, serialize and retain the operation result, finalize run cancellation, and return a result marked to suppress continuation.

- [ ] **Step 4: Guard approval preparation and handler status writes**

`ApprovalResumePreparer.prepare()` must lock the run, verify `waiting_approval`, re-read checkpoint, and compare checkpoint run ID to approval run ID. `ApprovalResumeHandler` must check the cancellation result before every direct `run.status` assignment and return a cancelled state patch instead of continuation.

- [ ] **Step 5: Run concurrency and existing approval tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation_concurrency.py -k "approval"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_workspace_streaming.py -k "approval"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_workspace_phase_flows.py -k "approval"
```

Expected: race tests and existing approval tests pass; business writes remain exactly once.

- [ ] **Step 6: Commit approval concurrency safety**

```bash
git add backend/tests/ai_infra/test_run_cancellation_concurrency.py backend/app/services/ai_operations/approval_decisions.py backend/app/ai/workflows/runner_support/approval_resume_preparer.py backend/app/ai/workflows/runner_support/approval_resume_handler.py
git commit -m "fix: serialize AI approval and cancellation"
```

---

### Task 6: Guard Human-Input Resume Against Cancellation and Stale Checkpoints

**Files:**
- Modify: `backend/app/ai/workflows/runner_support/human_input_resume_preparer.py:37`
- Modify: `backend/app/ai/workflows/runner_support/human_input_resume_handler.py:24`
- Modify: `backend/tests/ai_infra/test_run_cancellation_concurrency.py`
- Modify: `backend/tests/ai_infra/test_run_cancellation.py`

**Interfaces:**
- Consumes: run lock/cancellation helpers and Task 4 cancelled input helper.
- Produces: lock-safe human response persistence and stale-checkpoint rejection.

- [ ] **Step 1: Add failing resume/cancel race tests**

Add these tests with events around the first run lock:

```python
def test_cancel_wins_before_human_input_resume(self) -> None:
    self.assertEqual(response.status_code, 409)
    self.assertEqual(human_result_artifact_count, 0)
    self.assertEqual(human_part["status"], "cancelled")

def test_human_input_resume_commits_answer_once_then_cancel_stops_followup(self) -> None:
    self.assertEqual(human_result_artifact_count, 1)
    self.assertEqual(provider_followup_calls, 0)
    self.assertEqual(run.status, "cancelled")

def test_stale_human_input_checkpoint_cannot_resume_cancelled_run(self) -> None:
    self._restore_checkpoint_rows_from_fixture()
    response = self.client.post(response_path, json={"selected_option_ids": ["option-1"]})
    self.assertEqual(response.status_code, 409)
    self.assertEqual(human_result_artifact_count, 0)
```

Store checkpoint fixture rows before cancellation and reinsert them explicitly in `_restore_checkpoint_rows_from_fixture()` so the test proves the run guard, not checkpoint deletion, blocks resume.

- [ ] **Step 2: Run the human-input race tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation_concurrency.py -k "human_input"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "stale_human_input"
```

Expected: stale snapshot or handler code writes `running` after cancellation.

- [ ] **Step 3: Lock, re-read, and validate in the preparer**

Implement this sequence:

```python
snapshot = self.graph.get_state(config)
snapshot_run_id = str((snapshot.values or {}).get("run_id") or "")
run = lock_run_for_transition(self.db, family_id=family_id, run_id=snapshot_run_id)
if run.status != "waiting_input" or cancellation_wins(self.db, run=run):
    raise AIConflictError("这次补充信息任务已取消或结束，请刷新后重试")
locked_snapshot = self.graph.get_state(config)
locked_values = locked_snapshot.values or {}
pending = locked_values.get("pending_human_input") or locked_values.get("pendingHumanInput") or {}
if str(locked_values.get("run_id") or "") != run.id or str(pending.get("id") or "") != request_id:
    raise AIConflictError("用户补充信息请求已变化，请刷新后重试")
```

Return the locked snapshot. In the handler, use the same locked run and check cancellation immediately before updating message/run/conversation.

- [ ] **Step 4: Run human-input and phase-flow tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation_concurrency.py -k "human_input"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py -k "stale_human_input"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_workspace_phase_flows.py -k "human_input"
```

Expected: all selected tests pass with exactly one answer artifact only when resume wins.

- [ ] **Step 5: Commit human-input guards**

```bash
git add backend/app/ai/workflows/runner_support/human_input_resume_preparer.py backend/app/ai/workflows/runner_support/human_input_resume_handler.py backend/tests/ai_infra/test_run_cancellation_concurrency.py backend/tests/ai_infra/test_run_cancellation.py
git commit -m "fix: guard AI human input resume from cancellation"
```

---

### Task 7: Route Cooking SSE and Realtime Turns Through the Cancellation Service

**Files:**
- Modify: `backend/app/services/ai_audio/cooking_voice_stream.py:79`
- Modify: `backend/app/api/ai_audio.py:300,421`
- Modify: `backend/tests/ai_audio/test_ai_audio_api.py`

**Interfaces:**
- Consumes: Task 2 `AIApplicationService.record_run_cancellation/apply_run_cancellation` and client-provided run IDs.
- Produces: `turn_id == client_run_id`, `cancel_turn` acknowledgement, and service-backed hangup/new-turn replacement.

- [ ] **Step 1: Add failing cooking transport tests**

Add tests asserting:

```python
def test_cooking_voice_stream_forwards_client_run_id(self) -> None:
    self.assertEqual(captured_client_run_id, "cook-run-client")

def test_realtime_cancel_turn_persists_cancellation_before_ack(self) -> None:
    websocket.send_json({"type": "user_transcript_done", "text": "下一步", "turn_id": "voice_turn-cancel"})
    websocket.send_json({"type": "cancel_turn", "turn_id": "voice_turn-cancel"})
    message = receive_json_until_type(websocket, "turn_cancelled")
    self.assertEqual(message["turn_id"], "voice_turn-cancel")
    self.assertEqual(cancelled_run_ids, ["voice_turn-cancel"])

def test_realtime_hangup_cancels_active_turn_before_close(self) -> None:
    self.assertLess(call_order.index("cancel:voice_turn-hangup"), call_order.index("close"))

def test_realtime_new_turn_cancels_previous_turn_through_service(self) -> None:
    self.assertEqual(cancelled_run_ids, ["voice_turn-first"])
```

Add this helper beside the existing websocket test helpers:

```python
def receive_json_until_type(websocket, event_type: str) -> dict:
    while True:
        message = receive_json_with_timeout(websocket, timeout=1.0)
        if message.get("type") == event_type:
            return message
```

- [ ] **Step 2: Run the audio tests and observe task-only cancellation**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_audio/test_ai_audio_api.py -k "client_run_id or cancel_turn or hangup_cancels or new_turn_cancels"
```

Expected: turn IDs are not passed as run IDs and `cancel_turn` is unsupported.

- [ ] **Step 3: Pass stable IDs and persist cancellation before task cancellation**

Pass `client_run_id=turn_id` into `stream_cooking_assistant_voice_events()`. Replace `cancel_current_turn()` with:

```python
async def cancel_current_turn(*, reason: str) -> dict | None:
    nonlocal current_turn_task
    run_id = active_turn_id
    result = None
    if run_id:
        service = AIApplicationService(db)
        service.record_run_cancellation(family_id=session.family_id, user_id=session.user_id, run_id=run_id)
        commit_session(db)
        result = service.apply_run_cancellation(family_id=session.family_id, user_id=session.user_id, run_id=run_id)
        commit_session(db)
    if current_turn_task is not None and not current_turn_task.done():
        current_turn_task.cancel()
        try:
            await current_turn_task
        except asyncio.CancelledError:
            pass
    current_turn_task = None
    return result
```

For `cancel_turn`, verify the supplied turn ID matches the active turn, call the helper, then emit `turn_cancel_requested` for 202 or `turn_cancelled` for 200. Hangup calls the helper before closing. Starting a new turn calls it before changing `active_turn_id`, so the old ID is retained for cancellation.

- [ ] **Step 4: Run focused audio and cooking skill tests**

Run:

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_audio/test_ai_audio_api.py -k "client_run_id or cancel_turn or hangup_cancels or new_turn_cancels"
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_cooking_assistant_skill.py
```

Expected: all tests pass and transient cooking history behavior remains unchanged.

- [ ] **Step 5: Commit cooking backend integration**

```bash
git add backend/app/services/ai_audio/cooking_voice_stream.py backend/app/api/ai_audio.py backend/tests/ai_audio/test_ai_audio_api.py
git commit -m "feat: cancel cooking assistant runs durably"
```

---

### Task 8: Define Frontend Cancellation and Abort Contracts

**Files:**
- Create: `frontend/src/lib/aiStreamAbort.ts`
- Create: `frontend/src/lib/aiStreamAbort.test.ts`
- Modify: `frontend/src/api/types.ts:1473,1530`
- Modify: `frontend/src/api/aiApi.ts:1,190`
- Modify: `frontend/src/api/aiApi.test.ts`
- Modify: `frontend/src/lib/aiWorkspaceContracts.test.ts`

**Interfaces:**
- Consumes: Task 2 POST/GET JSON contract.
- Produces: `AiRunCancellationResponse`, `AiRunCancellationPhase`, `abortAiStream()`, `isExpectedAiStreamAbort()`.

- [ ] **Step 1: Add failing API and abort-helper tests**

Add tests named `test_cancel_ai_run_uses_post_path`, `test_get_ai_run_cancellation_uses_get_path`, and `recognizes only typed intentional aborts`. The abort predicate assertion is:

```ts
it('recognizes only typed intentional aborts', () => {
  const controller = new AbortController();
  abortAiStream(controller, { type: 'cancel_accepted', runId: 'run-1' });
  expect(isExpectedAiStreamAbort(new DOMException('Aborted', 'AbortError'), controller.signal)).toBe(true);
  expect(isExpectedAiStreamAbort(new DOMException('Aborted', 'AbortError'), new AbortController().signal)).toBe(false);
  expect(isExpectedAiStreamAbort(new Error('BodyStreamBuffer was aborted'), new AbortController().signal)).toBe(false);
});
```

API tests must assert POST `/api/ai/runs/run-1/cancel` and GET `/api/ai/runs/run-1/cancellation` return typed results with outcome and request fields.

- [ ] **Step 2: Run tests and observe missing exports/types**

Run:

```bash
npm --prefix frontend test -- src/lib/aiStreamAbort.test.ts src/api/aiApi.test.ts src/lib/aiWorkspaceContracts.test.ts
```

Expected: imports and `cancelled` event status contract fail.

- [ ] **Step 3: Implement exact frontend types and abort reasons**

Add:

```ts
export type AiRunStatus = 'pending' | 'running' | 'waiting_approval' | 'waiting_input' | 'cancelling' | 'completed' | 'failed' | 'fallback' | 'cancelled';
export type AiRunEventStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type AiRunCancellationPhase = 'idle' | 'requesting' | 'cancelling' | 'cancelled' | 'failed';
export type AiRunCancellationOutcome = 'cancel_requested' | 'cancelled' | 'already_cancelled';

export interface AiRunCancellationResponse {
  outcome: AiRunCancellationOutcome;
  request: { run_id: string; status: 'requested' | 'applied'; requested_at: string; resolved_at?: string | null };
  run: AiRun | null;
  events: AiRunEvent[];
}
```

Implement typed abort reasons:

```ts
export type AiStreamAbortReason =
  | { type: 'cancel_accepted'; runId: string }
  | { type: 'component_cleanup' }
  | { type: 'conversation_inaccessible'; conversationId: string }
  | { type: 'stream_replaced'; runId: string };

export function abortAiStream(controller: AbortController, reason: AiStreamAbortReason) {
  controller.abort(reason);
}

export function isExpectedAiStreamAbort(_error: unknown, signal: AbortSignal) {
  if (!signal.aborted || !signal.reason || typeof signal.reason !== 'object') return false;
  const type = (signal.reason as { type?: unknown }).type;
  return type === 'cancel_accepted' || type === 'component_cleanup' || type === 'conversation_inaccessible' || type === 'stream_replaced';
}
```

- [ ] **Step 4: Add API methods and run tests**

Add `cancelAiRun(runId): Promise<AiRunCancellationResponse>` and `getAiRunCancellation(runId): Promise<AiRunCancellationResponse>` to `aiApi`.

Run:

```bash
npm --prefix frontend test -- src/lib/aiStreamAbort.test.ts src/api/aiApi.test.ts src/lib/aiWorkspaceContracts.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit frontend contracts**

```bash
git add frontend/src/lib/aiStreamAbort.ts frontend/src/lib/aiStreamAbort.test.ts frontend/src/api/types.ts frontend/src/api/aiApi.ts frontend/src/api/aiApi.test.ts frontend/src/lib/aiWorkspaceContracts.test.ts
git commit -m "feat: define AI cancellation frontend contracts"
```

---

### Task 9: Build the Shared Per-Run Cancellation Hook

**Files:**
- Create: `frontend/src/hooks/useAiRunCancellation.ts`
- Create: `frontend/src/hooks/useAiRunCancellation.test.tsx`

**Interfaces:**
- Consumes: `api.cancelAiRun`, `api.getAiRunCancellation`, `abortAiStream`, and caller-owned controllers.
- Produces: `cancelRun(runId, controller)`, `getCancellationState(runId)`, `clearCancellation(runId)`.

- [ ] **Step 1: Write failing hook tests for rapid clicks and failures**

Expose the hook through a probe and add tests that call `cancelRun()` twice before resolving the POST. Assert one POST. Add table-driven 404/409/500 errors and assert controller signal remains false. Add a 202 test that advances fake timers through GET polling and checks phases `requesting -> cancelling -> cancelled`. Add a two-run test that resolves run A while run B remains requesting.

The probe value is:

```ts
type ProbeValue = {
  cancelRun: (runId: string, controller: AbortController) => Promise<AiRunCancellationResponse>;
  getCancellationState: (runId: string) => { phase: AiRunCancellationPhase; error: string };
};
```

- [ ] **Step 2: Run tests and observe missing hook**

Run:

```bash
npm --prefix frontend test -- src/hooks/useAiRunCancellation.test.tsx
```

Expected: test collection fails because the hook does not exist.

- [ ] **Step 3: Implement promise deduplication before React state updates**

Use these refs and public return type:

```ts
type CancellationState = { phase: AiRunCancellationPhase; error: string; response?: AiRunCancellationResponse };

export function useAiRunCancellation(options: {
  pollIntervalMs?: number;
  onConfirmed?: (runId: string, response: AiRunCancellationResponse) => void;
  onConflict?: (runId: string) => void;
}) {
  const promiseByRunIdRef = useRef<Record<string, Promise<AiRunCancellationResponse>>>({});
  const [stateByRunId, setStateByRunId] = useState<Record<string, CancellationState>>({});
```

`cancelRun()` must store the Promise in the ref before awaiting. On 200, abort with `cancel_accepted`, set cancelled, and call `onConfirmed`. On 202, abort, set cancelling, and poll GET at `pollIntervalMs ?? 250` until 200/cancelled. On error, do not abort, set failed with the API message, call `onConflict` only for 409, and rethrow. Always remove the stored Promise in `finally`.

- [ ] **Step 4: Run hook tests**

Run:

```bash
npm --prefix frontend test -- src/hooks/useAiRunCancellation.test.tsx
```

Expected: rapid clicks issue one POST, 202 polls, failures do not abort, and run states remain isolated.

- [ ] **Step 5: Commit the shared hook**

```bash
git add frontend/src/hooks/useAiRunCancellation.ts frontend/src/hooks/useAiRunCancellation.test.tsx
git commit -m "feat: add shared AI run cancellation controller"
```

---

### Task 10: Integrate Main Chat, Approval, and Human-Input Streams

**Files:**
- Modify: `frontend/src/components/ai/useAiConversationStreams.ts:1`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx:285,1350`
- Modify: `frontend/src/components/ai/AiMobilePage.tsx:300`
- Modify: `frontend/src/components/ai/aiWorkspaceHelpers.tsx:1`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Modify: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`

**Interfaces:**
- Consumes: Task 9 hook and Task 8 abort helper.
- Produces: backend-confirmed stop UX for all main workspace flows.

- [ ] **Step 1: Add failing workspace cancellation tests**

Add tests with the exact names `deduplicates rapid stop clicks for one run`, `shows cancelling for 202 and waits for backend cancelled status`, `keeps the stream alive when cancel returns 404`, `keeps the stream alive when cancel returns 409`, `keeps the stream alive when cancel returns 500`, `does not render approval AbortError after accepted cancellation`, `does not render human input AbortError or a submitted answer after accepted cancellation`, `keeps cancellation state isolated between two conversations`, and `restores cancelled status from refreshed messages`.

For each error case, assert `streamController.signal.aborted === false`, visible error text exists, and no `user_cancel` local event was appended.

- [ ] **Step 2: Run the new tests and observe optimistic cancellation**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx -t "stop|cancel|AbortError|isolated|refreshed"
```

Expected: legacy code aborts after failed POST, marks events failed, or swallows approval/input abort inconsistently.

- [ ] **Step 3: Replace `cancelStreamingChat()` with the shared controller**

Instantiate the hook once in `AiWorkspace`. The stop handler becomes:

```ts
async function cancelStreamingChat() {
  const runId = activeCancellableRunId;
  const controller = runId ? chatAbortByRunIdRef.current[runId] : undefined;
  if (!runId || !controller) return;
  setCancellationError('');
  try {
    await runCancellation.cancelRun(runId, controller);
  } catch (error) {
    setCancellationError(streamFailureMessage(error));
  }
}
```

Delete local fallback events and the pre-response call to `markStreamingAssistantStopped()`. Feed `requesting/cancelling` to desktop and mobile buttons. `onConfirmed` merges backend events and invalidates messages/conversations; 202 does not mark the message cancelled.

- [ ] **Step 4: Unify all three stream catch paths**

In `startChat`, `startApproval`, and `startHumanInput`, use:

```ts
if (isExpectedAiStreamAbort(error, controller.signal)) {
  await context.refreshAfterApprovalSettled();
  throw error;
}
```

Only non-expected errors call:

```ts
context.markStreamingAssistantStopped(runId ?? null, `AI 后续处理失败：${message}`);
```

Abort controllers created for unmount, permission loss, and replacement must be aborted through `abortAiStream()` with a typed reason. Human-input UI must refresh persisted parts after cancellation and clear its optimistic answer summary when the returned part has `status=cancelled`.

- [ ] **Step 5: Run workspace tests**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx -t "stop|cancel|AbortError|isolated|refreshed"
```

Expected: all selected tests pass; 404/409/500 never abort and 202 never displays final cancelled early.

- [ ] **Step 6: Commit main workspace integration**

```bash
git add frontend/src/components/ai/useAiConversationStreams.ts frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiMobilePage.tsx frontend/src/components/ai/aiWorkspaceHelpers.tsx frontend/src/components/ai/AiWorkspace.test.tsx frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx
git commit -m "fix: confirm AI cancellation before stopping streams"
```

---

### Task 11: Render Cancellation as Cancellation, Not Failure

**Files:**
- Modify: `frontend/src/components/ai/AiConversationThread.tsx:120,363`
- Modify: `frontend/src/components/ai/AiConversationThread.test.tsx`
- Modify: `frontend/src/components/recipes/useCookingAssistantStream.ts:25`
- Modify: `frontend/src/components/recipes/useCookingAssistantStream.test.tsx`

**Interfaces:**
- Consumes: `cancelled` event/part status and expected-abort helper.
- Produces: neutral cancelled activity/input/cooking messages.

- [ ] **Step 1: Add failing presentation tests**

Add tests that render a cancelled run event and assert `已取消这次任务` is present while `执行失败` and danger classes are absent. Render a cancelled human-input part and assert controls are disabled and `任务已取消，未提交回答` is visible. For cooking, reject the stream with a typed accepted abort and assert `已取消这次回复` uses warning/neutral tone; reject with an untyped AbortError and assert it remains a visible connection failure.

- [ ] **Step 2: Run presentation tests**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiConversationThread.test.tsx src/components/recipes/useCookingAssistantStream.test.tsx -t "cancel"
```

Expected: cancelled activity is labelled as failure or cooking treats every AbortError as a successful stop.

- [ ] **Step 3: Add explicit cancelled branches**

Update labels with explicit branches before failed branches:

```ts
if (event.status === 'cancelled') return event.user_message || '已取消这次任务';
if (event.status === 'failed') return `执行失败：${event.user_message}`;
```

For human input, derive `isCancelled = part.status === 'cancelled'` and render the fixed cancelled summary without response controls. In cooking progress helpers, map cancelled to `已取消` and a non-danger tone. Remove `streamFailureMessage()` logic that infers successful cancellation solely from `DOMException.name`.

- [ ] **Step 4: Run presentation tests**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiConversationThread.test.tsx src/components/recipes/useCookingAssistantStream.test.tsx -t "cancel"
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit cancellation presentation**

```bash
git add frontend/src/components/ai/AiConversationThread.tsx frontend/src/components/ai/AiConversationThread.test.tsx frontend/src/components/recipes/useCookingAssistantStream.ts frontend/src/components/recipes/useCookingAssistantStream.test.tsx
git commit -m "fix: render AI cancellation separately from failure"
```

---

### Task 12: Integrate Cooking Stop and Realtime Voice Acknowledgement

**Files:**
- Modify: `frontend/src/components/recipes/useCookingAssistantStream.ts:111`
- Modify: `frontend/src/components/recipes/CookingAssistantPanel.tsx:123,450`
- Modify: `frontend/src/components/recipes/useCookingAssistantStream.test.tsx`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts:1`
- Modify: `frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx`

**Interfaces:**
- Consumes: Task 9 hook, Task 8 typed abort helper, and Task 7 websocket messages.
- Produces: backend-confirmed cooking SSE stop and ack-gated realtime turn cancellation/hangup.

- [ ] **Step 1: Add failing cooking hook tests**

Expose `stop`, `cancellationPhase`, and `cancellationError` from the test probe. Add tests named `does not abort cooking stream when cancel API fails`, `shows cancelling after 202 and waits for cancellation polling`, and `aborts cooking text and audio only after cancel is accepted`.

Assert the same `client_run_id` sent to `streamChatAi` is passed to `cancelAiRun`.

- [ ] **Step 2: Add failing realtime voice tests**

Extend the mock WebSocket and assert:

```ts
const hangupPromise = latest?.hangup();
expect(socket.readyState).toBe(WebSocket.OPEN);
expect(lastSentMessage()).toMatchObject({ type: 'hangup', turn_id: activeTurnId });
socket.emitMessage({ type: 'turn_cancelled', turn_id: activeTurnId });
await hangupPromise;
expect(socket.close).toHaveBeenCalled();
```

Also test `cancelTurn()` returns to listening after `turn_cancelled` without closing the session.

- [ ] **Step 3: Run cooking tests and observe immediate abort/close**

Run:

```bash
npm --prefix frontend test -- src/components/recipes/useCookingAssistantStream.test.tsx src/components/recipes/useCookingRealtimeVoiceSession.test.tsx -t "cancel|hangup|stop"
```

Expected: SSE aborts locally and hangup closes before backend acknowledgement.

- [ ] **Step 4: Use the shared cancellation hook in cooking SSE**

Store `activeRunId` beside the controller. `stop()` calls `cancelRun(activeRunId, controller)`. Return phase/error to `CookingAssistantPanel`; disable the stop button during requesting/cancelling and render the error above the composer. On confirmed cancellation, replace only the active assistant message with the neutral backend-confirmed cancellation text.

- [ ] **Step 5: Make realtime cancellation acknowledgement-driven**

Maintain one resolver per active turn:

```ts
type PendingTurnCancellation = { turnId: string; resolve: () => void; reject: (error: Error) => void };
const pendingTurnCancellationRef = useRef<PendingTurnCancellation | null>(null);
```

`cancelTurn()` sends `{type:'cancel_turn', turn_id}` and resolves only on matching `turn_cancel_requested` or `turn_cancelled`. `hangup()` sends `{type:'hangup', turn_id}`, waits for `turn_cancelled` or closed status, then closes locally. Socket error/close rejects the pending resolver with a visible error.

- [ ] **Step 6: Run cooking tests**

Run:

```bash
npm --prefix frontend test -- src/components/recipes/useCookingAssistantStream.test.tsx src/components/recipes/useCookingRealtimeVoiceSession.test.tsx -t "cancel|hangup|stop"
```

Expected: all selected tests pass; cancellation errors do not stop cooking output.

- [ ] **Step 7: Commit cooking frontend integration**

```bash
git add frontend/src/components/recipes/useCookingAssistantStream.ts frontend/src/components/recipes/CookingAssistantPanel.tsx frontend/src/components/recipes/useCookingAssistantStream.test.tsx frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts frontend/src/components/recipes/useCookingRealtimeVoiceSession.test.tsx
git commit -m "fix: confirm cooking assistant cancellation"
```

---

### Task 13: Finish Accessible Button States and Responsive Targets

**Files:**
- Modify: `frontend/src/styles/09-ai-workspace.css:2724`
- Modify: `frontend/src/styles/03-recipe-workspace.css:4023`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Modify: `frontend/src/components/recipes/useCookingAssistantStream.test.tsx`

**Interfaces:**
- Consumes: cancellation phases from Tasks 10 and 12.
- Produces: 44px controls, disabled in-flight state, `aria-busy`, and visible alert semantics.

- [ ] **Step 1: Add failing accessibility assertions**

Assert main and cooking stop buttons have `disabled`, `aria-busy="true"`, and an `aria-label` containing `正在停止` during requesting/cancelling. Assert cancellation errors render inside `role="alert"`.

- [ ] **Step 2: Run component tests**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/recipes/useCookingAssistantStream.test.tsx -t "aria|stopping|正在停止"
```

Expected: aria state and visible alerts are absent.

- [ ] **Step 3: Implement controls and fixed minimum size**

Use the exact CSS floor in final selectors, including mobile overrides:

```css
.ai-send-button,
.recipe-cook-ai-send-btn {
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
}
```

Buttons use `disabled={phase === 'requesting' || phase === 'cancelling'}`, `aria-busy` with the same condition, and phase-specific labels. Error surfaces use `role="alert"` and `aria-live="assertive"`.

- [ ] **Step 4: Run tests and style-token report**

Run:

```bash
npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/recipes/useCookingAssistantStream.test.tsx -t "aria|stopping|正在停止"
npm --prefix frontend run check:style-tokens
```

Expected: tests pass. Inspect the style-token report and confirm no newly introduced non-token color, spacing, radius, or shadow values.

- [ ] **Step 5: Commit accessible cancellation UI**

```bash
git add frontend/src/styles/09-ai-workspace.css frontend/src/styles/03-recipe-workspace.css frontend/src/components/ai/AiWorkspace.test.tsx frontend/src/components/recipes/useCookingAssistantStream.test.tsx
git commit -m "fix: improve AI stop control states"
```

---

### Task 14: Full Regression, Migration, and Visual Verification

**Files:**
- No planned file changes; a failure returns execution to the owning task before this verification task is rerun.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh evidence for backend, frontend, migration, contracts, and responsive behavior.

- [ ] **Step 1: Run the complete focused backend cancellation suite**

```bash
backend/.venv/bin/python -m pytest -q backend/tests/ai_infra/test_run_cancellation.py backend/tests/ai_infra/test_run_cancellation_concurrency.py backend/tests/ai_audio/test_ai_audio_api.py
```

Expected: all tests pass.

- [ ] **Step 2: Run the complete AI backend suite**

```bash
npm run backend:test:ai
```

Expected: all `backend/tests/ai_infra` tests pass.

- [ ] **Step 3: Apply the migration and verify the single head**

```bash
npm run backend:migrate
cd backend && .venv/bin/alembic heads
```

Expected: migration succeeds and reports only `1c2d3e4f5a6b (head)`.

- [ ] **Step 4: Run focused frontend tests**

```bash
npm --prefix frontend test -- src/lib/aiStreamAbort.test.ts src/hooks/useAiRunCancellation.test.tsx src/api/aiApi.test.ts src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/recipes/useCookingAssistantStream.test.tsx src/components/recipes/useCookingRealtimeVoiceSession.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Run frontend quality and build**

```bash
npm run frontend:quality
npm run frontend:build
```

Expected: typecheck, Vitest, style-token report stage, and production build pass. Manually inspect style-token output rather than relying only on exit code.

- [ ] **Step 6: Run responsive smoke and manually exercise cancellation**

```bash
npm run frontend:smoke
```

At `390×844`, `768×1024`, and `1440×900`, verify:

- stop target is at least 44×44px;
- one click changes to requesting/cancelling and disables the control;
- 202 does not display final cancellation early;
- 404/409/500 leaves the stream active and displays an error;
- refreshed waiting-input and waiting-approval cards remain cancelled and non-interactive;
- cancelling one of two conversations leaves the other unchanged;
- cooking text/audio stop and realtime hangup wait for backend acknowledgement.

- [ ] **Step 7: Run repository hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intentional files are modified.

- [ ] **Step 8: Confirm verification introduced no uncommitted correction**

If `git status --short` is non-empty because a verification failure required code changes, stop Task 14, return to the task that owns those files, repeat that task's failing-test/pass-test cycle and exact staging command, then rerun Task 14 from Step 1. Do not create an empty verification commit and do not stage an entire directory.
