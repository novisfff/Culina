# AI Message Event Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用服务端拥有唯一排序权的会话事件日志替换 Culina 当前的实时/历史多源合并，保证在线、刷新、断线恢复和审批恢复得到完全一致的 AI 对话时间线。

**Architecture:** 每个会话维护 `timeline_version`，所有可见变化通过 `AITimelineService` 在同一事务中分配连续 `sequence`、写入 append-only `AIConversationEvent` 并更新 `AIMessage` 物化快照。SSE、历史接口和 replay 返回同一事件 envelope；前端用一个按 sequence 幂等应用的 reducer，不再维护本地消息副本和独立 run-event 排版状态。

**Tech Stack:** FastAPI、SQLAlchemy 2、Alembic、MySQL、LangGraph、React 18、TypeScript、React Query、Vitest、Playwright、SSE。

**Spec:** `docs/superpowers/specs/2026-09-03-ai-message-event-protocol-design.md`

## Global Constraints

- 服务端 `AIConversationEvent.sequence` 是会话内唯一排序真相；不得使用 `created_at`、随机 ID 或网络到达时间排序。
- 所有可见消息/part/status 变化必须经过 `AITimelineService`；禁止 workflow、route 或组件直接改写 `AIMessage.parts` 作为时间线操作。
- 事件和物化快照必须在同一事务中提交，提交成功后才能进入 SSE queue。
- 客户端必须按 `event_id` 幂等、按 `sequence` 检测 gap；未知 message/part 不得生成猜测副本。
- 结果卡、草稿、审批、人机输入和 run activity 的更新必须原位替换稳定 `part_id`，不能删除后追加。
- 保持现有消息组件、卡片、审批语义、停止/重试、滚动、文案和桌面/移动端信息架构；本计划不新增视觉样式。
- 不保留 `LiveAIStreamCache`、旧 merge/fallback 或“双写新旧时间线”的运行时代码；`AIRunEvent` 只可作为调试观测投影。
- `persist_history=false` 的做菜流继续不写入主会话 timeline。
- 每个任务先写失败测试，再写最小实现；任务完成前运行该任务列出的定向验证并提交一次独立 commit。

---

### Task 1: 建立新的时间线数据模型和数据库约束

**Files:**
- Modify: `backend/app/models/domain.py:806-958`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/alembic/versions/a3b4c5d6e7f8_add_ai_conversation_events.py`
- Test: `backend/tests/ai_infra/test_ai_timeline_model.py`
- Test: `backend/tests/ai_infra/test_alembic_timeline.py`

**Interfaces:**
- Produces `AIConversation.timeline_version: int`, `AIMessage.timeline_position: int`, `AIMessage.snapshot_sequence: int`.
- Produces `AIConversationEvent` with `id`, `family_id`, `conversation_id`, `run_id`, `message_id`, `sequence`, `event_type`, `operation`, `part_id`, `payload`, `created_at`, `created_by`.
- Produces optional `AIRunEvent.timeline_event_id` and `AIRunEvent.timeline_sequence` for observability correlation only.

- [ ] **Step 1: Write the failing model tests**

~~~python
def test_conversation_event_sequence_is_unique_per_conversation(db):
    first = AIConversationEvent(
        id="evt-1", family_id="family-1", conversation_id="conversation-1",
        sequence=1, event_type="message.created", operation="append", payload={},
        created_at=utcnow(),
    )
    second = AIConversationEvent(
        id="evt-2", family_id="family-1", conversation_id="conversation-1",
        sequence=1, event_type="message.created", operation="append", payload={},
        created_at=utcnow(),
    )
    db.add_all([first, second])
    with pytest.raises(IntegrityError):
        db.commit()
~~~

Also assert a second conversation may independently use sequence `1`, defaults are `timeline_version=0` and `snapshot_sequence=0`, and `timeline_position` is present on every persistent message.

- [ ] **Step 2: Run the model tests and confirm they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_timeline_model.py -q`

Expected: import/column failures because the event model and sequence fields do not exist.

- [ ] **Step 3: Add the model fields and constraints**

Define `AIConversationEvent` beside the existing AI models. Use `BigInteger` for sequence fields, `JSON` for payload, the existing family/conversation cascade policy, and:

~~~python
UniqueConstraint("conversation_id", "sequence", name="uq_ai_conversation_events_conversation_sequence")
Index("ix_ai_conversation_events_conversation_sequence", "conversation_id", "sequence")
Index("ix_ai_conversation_events_run_sequence", "run_id", "sequence")
Index("ix_ai_conversation_events_message_sequence", "message_id", "sequence")
~~~

Set server/default `0` on counters. Do not make the timeline depend on `AIRunEvent`.

- [ ] **Step 4: Add the Alembic migration**

Create revision `a3b4c5d6e7f8` with `down_revision = "9d0e1f2a3b4c"`. Add columns, table, indexes and constraints in upgrade and remove them in reverse order in downgrade. Do not edit earlier migrations.

- [ ] **Step 5: Run model and migration checks**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_timeline_model.py tests/ai_infra/test_alembic_timeline.py -q`

Run: `npm run backend:migrate:smoke`

Expected: PASS, one Alembic head and unique sequence enforcement.

- [ ] **Step 6: Commit the data-model slice**

~~~bash
git add backend/app/models/domain.py backend/app/models/__init__.py backend/alembic/versions/a3b4c5d6e7f8_add_ai_conversation_events.py backend/tests/ai_infra/test_ai_timeline_model.py backend/tests/ai_infra/test_alembic_timeline.py
git commit -m "refactor(ai): add canonical conversation timeline model"
~~~

### Task 2: Implement the pure event reducer and transactional timeline service

**Files:**
- Create: `backend/app/ai/workflows/runner_support/timeline_types.py`
- Create: `backend/app/ai/workflows/runner_support/timeline_reducer.py`
- Create: `backend/app/services/ai_timeline.py`
- Test: `backend/tests/ai_infra/test_timeline_reducer.py`
- Test: `backend/tests/ai_infra/test_ai_timeline_service.py`

**Interfaces:**
- `TimelineEvent` is an immutable envelope with `event_id`, `conversation_id`, `run_id`, `message_id`, `sequence`, `event_type`, `operation`, `part_id`, `payload`, `is_terminal`.
- `reduce_message_snapshot(parts, event) -> list[dict[str, Any]]` applies append/delta/replace without changing unrelated indexes.
- `AITimelineService.create_message(...)`, `append_part(...)`, `append_delta(...)`, `replace_part(...)`, `update_message_status(...)`, `terminal(...)`, `snapshot(...)`, `replay(...)` are the only public visible-timeline operations.

- [ ] **Step 1: Write reducer tests for every invariant**

Cover:

~~~python
def test_replace_keeps_part_position(): ...
def test_delta_appends_only_to_target_text_part(): ...
def test_duplicate_part_id_is_rejected_instead_of_reordered(): ...
def test_terminal_message_rejects_new_visible_event(): ...
def test_unknown_message_or_part_returns_timeline_integrity_error(): ...
~~~

Use `[text("before"), draft("draft-1"), text("after")]` and assert replacing `draft-1` leaves indexes `[0, 1, 2]`. Assert a delta for the first text never creates a second text row.

- [ ] **Step 2: Run reducer tests and confirm they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_timeline_reducer.py -q`

Expected: FAIL because the new reducer module and event types are absent.

- [ ] **Step 3: Implement immutable event types and the pure reducer**

`part.appended` requires a new `part_id`; `part.delta` requires an existing text part; `part.replaced` preserves its index; `message.status` changes only status; `run.terminal` sets terminal state. Raise a typed error for unknown targets and any event after terminal.

- [ ] **Step 4: Write service concurrency and transaction tests**

Test two sessions appending to one conversation receive different contiguous sequences, two conversations can both receive sequence `1`, rollback exposes neither event nor counter increment, replay excludes `after_sequence`, and the same `event_id` does not mutate the snapshot twice.

- [ ] **Step 5: Implement `AITimelineService`**

For every operation: lock the family-scoped conversation first, lock the target message second, validate run/message ownership and terminal status, increment `timeline_version`, apply the reducer, update `snapshot_sequence`, flush event and snapshot together, and return a detached event plus snapshot. The service never enqueues or publishes. `replay()` filters family and conversation and orders only by `sequence.asc()`.

- [ ] **Step 6: Run service tests and commit**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_timeline_reducer.py tests/ai_infra/test_ai_timeline_service.py -q`

~~~bash
git add backend/app/ai/workflows/runner_support/timeline_types.py backend/app/ai/workflows/runner_support/timeline_reducer.py backend/app/services/ai_timeline.py backend/tests/ai_infra/test_timeline_reducer.py backend/tests/ai_infra/test_ai_timeline_service.py
git commit -m "refactor(ai): add transactional timeline service"
~~~

### Task 3: Pre-create canonical user and assistant messages

**Files:**
- Modify: `backend/app/ai/workflows/runner_support/user_message_preparer.py`
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/ai/workflows/runner_support/graph_run_initializer.py`
- Modify: `backend/app/ai/workflows/runner_support/assistant_result_persister.py`
- Modify: `backend/app/ai/workflows/runner_support/run_finalizer.py`
- Test: `backend/tests/ai_infra/test_workspace_chat.py`
- Test: `backend/tests/ai_infra/test_workspace_streaming.py`
- Test: `backend/tests/ai_infra/test_ai_timeline_service.py`

**Interfaces:**
- `PreparedUserMessage` returns `user_message_id` and `assistant_message_id`.
- Run state carries the canonical assistant `message_id` through normal, approval and human-input resume paths.

- [ ] **Step 1: Add failing preparation tests**

Assert one preparation transaction creates exactly one user message and one assistant message with `status="running"`, distinct non-zero positions, and two `message.created` events in user-then-assistant order. Retrying the same `client_message_id` returns existing IDs without another pair.

- [ ] **Step 2: Run focused tests and confirm the old behavior fails**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_workspace_chat.py -k "prepare or idempot" -q`

Expected: FAIL because assistant messages are currently created by final persistence.

- [ ] **Step 3: Create both messages through `AITimelineService`**

Inside the existing preparation transaction create the user message and event, create the empty assistant message with run ID and `status="running"` and event, then flush run/context updates. Preserve attachments and `client_message_id`. Do not insert a placeholder part; the current thinking indicator remains frontend rendering state.

- [ ] **Step 4: Thread the assistant ID through every runner state**

Replace every synthetic assistant ID fallback and late normal-path `AIMessage(...)` construction with the prepared ID. Approval and human-input resume look up exactly `(family_id, conversation_id, run_id, message_id)`.

- [ ] **Step 5: Make final persistence update, never create, the assistant message**

`AssistantResultPersister` appends/replaces parts through the service. `RunFinalizer` appends terminal text/status to the same message. A missing prepared message is an integrity error that marks the run failed; it never creates a second assistant message.

- [ ] **Step 6: Run regression tests and commit**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_workspace_chat.py tests/ai_infra/test_workspace_streaming.py -k "stream or response or preparation" -q`

~~~bash
git add backend/app/ai/workflows/runner_support/user_message_preparer.py backend/app/ai/workflows/runner.py backend/app/ai/workflows/runner_support/graph_run_initializer.py backend/app/ai/workflows/runner_support/assistant_result_persister.py backend/app/ai/workflows/runner_support/run_finalizer.py backend/tests/ai_infra/test_workspace_chat.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_ai_timeline_service.py
git commit -m "refactor(ai): create canonical assistant message before streaming"
~~~

### Task 4: Route every backend visible producer through the event service

**Files:**
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/ai/workflows/orchestrator/streaming.py`
- Modify: `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py`
- Modify: `backend/app/ai/workflows/runner_support/approval_followup_streamer.py`
- Modify: `backend/app/ai/workflows/runner_support/approval_resume_handler.py`
- Modify: `backend/app/ai/workflows/runner_support/human_input_resume_handler.py`
- Modify: `backend/app/ai/workflows/runner_support/runtime_failure_persister.py`
- Modify: `backend/app/services/ai_operations/run_cancellation.py`
- Modify: `backend/app/services/ai_operations/result_projection.py`
- Modify: `backend/app/services/ai_operations/messages.py`
- Modify: `backend/app/ai/workflows/runner_support/stream_bridge.py`
- Delete: `backend/app/ai/workflows/live_stream_cache.py`
- Delete: `backend/app/ai/workflows/runner_support/message_persistence.py` after moving non-order approval helpers
- Test: `backend/tests/ai_infra/test_workspace_streaming.py`
- Test: `backend/tests/ai_infra/test_ai_draft_routing.py`
- Test: `backend/tests/ai_infra/test_human_input_resume.py`
- Test: `backend/tests/ai_infra/test_run_cancellation.py`

**Interfaces:**
- `_persistent_progress_writer` emits a committed `TimelineEvent` and never writes process-local message state.
- Stable part IDs are used for text segments, activity, draft, approval and operation-result.
- `AIRunEvent` remains an observability projection linked to the event.

- [ ] **Step 1: Add failing producer-order tests**

Use these scripts and assert persisted event order equals snapshot order:

~~~text
text(before) → draft → approval → result_card → text(after) → terminal
skill running → skill completed (same activity part position)
approval request → approved response → continuation text
human input request → response part → continuation text
~~~

Also assert a result card persisted before publication retains its sequence, and a provider exception after a committed card cannot append generic failure text over it.

- [ ] **Step 2: Replace delta/part/activity cache calls**

`message_delta` becomes `part.delta`; `message_part` becomes `part.appended` or `part.replaced`. Commit before `enqueue(event, data)`. Remove cache helpers, live-stream base-part assembly, and all `live*` metadata.

- [ ] **Step 3: Make progress updates in-place**

An `AIRunEvent` status change appends `part.replaced` with the original activity `part_id`; update observability correlation in the same transaction. Never remove and reappend.

- [ ] **Step 4: Convert draft, approval, result, failure and cancellation paths**

Replace direct `message.parts` assignments with service calls. Keep current approval/commit gate and public result projection. Failed/cancelled runs update the prepared message and terminal status.

- [ ] **Step 5: Remove cache and ordering merge module**

Delete `live_stream_cache.py`. Move reusable approval serialization helpers to a focused module, then delete anchor merge, ordering dedupe, pending-interactive insertion and their tests.

- [ ] **Step 6: Run backend producer tests and commit**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_workspace_streaming.py tests/ai_infra/test_ai_draft_routing.py tests/ai_infra/test_human_input_resume.py tests/ai_infra/test_run_cancellation.py -q`

~~~bash
git add backend/app backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_ai_draft_routing.py backend/tests/ai_infra/test_human_input_resume.py backend/tests/ai_infra/test_run_cancellation.py
git commit -m "refactor(ai): publish all visible output through canonical events"
~~~

### Task 5: Replace history and SSE contracts with snapshot-plus-replay

**Files:**
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/services/ai_client_projection.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/app/api/ai_audio.py`
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/ai/workflows/runner_support/stream_bridge.py`
- Test: `backend/tests/ai_infra/test_ai_timeline_api.py`
- Test: `backend/tests/ai_infra/test_workspace_streaming.py`
- Test: `backend/tests/ai_infra/test_ai_client_projection.py`

**Interfaces:**
- `AIConversationEventDTO` mirrors the event envelope.
- `AIConversationSnapshotDTO` is `{conversation_id, snapshot_sequence, messages}`.
- `AIConversationReplayDTO` is `{conversation_id, from_sequence, to_sequence, events}`.
- `AIChatResponse` contains `snapshot_sequence` and a terminal event.

- [ ] **Step 1: Write API contract tests**

Assert history ordering by `timeline_position`, replay ascending sequences, SSE `id` and full envelope, matching terminal/snapshot sequence, and current 404 behavior for cross-family access.

- [ ] **Step 2: Run contract tests and confirm they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_timeline_api.py -q`

Expected: FAIL because history is a bare list, SSE has no event ID, and replay is absent.

- [ ] **Step 3: Implement serializers and DTOs**

Project event payload through existing client projection, expose safe fields only, include sequence/identity/terminal fields, and remove live metadata. Never sort timeline responses by `created_at`.

- [ ] **Step 4: Implement history and replay routes**

Change messages to return `AIConversationSnapshotDTO`. Add `GET /api/ai/conversations/{conversation_id}/events?after_sequence=` and `GET /api/ai/conversations/{conversation_id}/events/stream?after_sequence=` with existing access checks. Keep run debug endpoints for observability only.

- [ ] **Step 5: Emit standard SSE IDs and support resume cursors**

Every stream block writes:

~~~text
id: <event_id>
event: timeline
data: {"event_id":"...","sequence":42,...}
~~~

Read `Last-Event-ID` or `after_sequence`, replay committed events first, then continue live. If terminal, send terminal and close. Audio event sequence stays separate.

- [ ] **Step 6: Run backend API tests and commit**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_timeline_api.py tests/ai_infra/test_workspace_streaming.py tests/ai_infra/test_ai_client_projection.py -q`

~~~bash
git add backend/app/schemas/ai.py backend/app/services/serializers.py backend/app/services/ai_client_projection.py backend/app/api/ai.py backend/app/api/ai_audio.py backend/app/ai/workflows/runner.py backend/app/ai/workflows/runner_support/stream_bridge.py backend/tests/ai_infra/test_ai_timeline_api.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_ai_client_projection.py
git commit -m "refactor(ai): expose snapshot and replay timeline contract"
~~~

### Task 6: Add the frontend event contract, parser and single reducer

**Files:**
- Modify: `frontend/src/api/types/ai.ts`
- Modify: `frontend/src/api/aiApi.ts`
- Create: `frontend/src/components/ai/aiTimelineReducer.ts`
- Create: `frontend/src/components/ai/aiTimelineReducer.test.ts`
- Modify: `frontend/src/api/aiApi.test.ts`

**Interfaces:**
- `AiTimelineEvent`, `AiConversationSnapshot` and `AiConversationReplay` mirror backend DTOs.
- `applyAiTimelineEvent(state, event): { state, needsReplay }` is deterministic.
- `createAiTimelineState(snapshot)` initializes state.
- `mergeAiTimelineReplay(state, replay)` applies contiguous ranges only.

- [ ] **Step 1: Write reducer tests before implementation**

Cover:

~~~text
message.created(user) → message.created(assistant) → part.delta(text)
part.appended(draft) → part.replaced(draft) keeps index
duplicate event_id is ignored
sequence 4 while lastSequence is 2 sets gap {from: 3, to: 3}
replay 3 then live 4 clears gap and produces one message
conversation B never mutates conversation A
terminal rejects later part and requests snapshot
~~~

- [ ] **Step 2: Run reducer tests and confirm they fail**

Run: `npm --prefix frontend test -- src/components/ai/aiTimelineReducer.test.ts`

Expected: FAIL because the reducer and types do not exist.

- [ ] **Step 3: Implement reducer without merge heuristics**

Store `messagesById`, `messageOrder`, `lastSequence`, `seenEventIds`, `activeRunId` and `gap`. Insert by canonical position, append only for `part.appended`, update target text for `part.delta` and replace in place. Never concatenate by text similarity or create unknown messages.

- [ ] **Step 4: Update the SSE parser**

Parse `id:` and timeline payload. Dispatch one event type for live, replay and terminal. Preserve audio callbacks. Malformed/unknown visible events trigger snapshot reload.

- [ ] **Step 5: Add snapshot/replay clients and tests**

Implement `getAiMessages` returning snapshot, `getAiConversationEvents(conversationId, afterSequence)` and `streamAiConversationEvents(...)`. Test multiline data, ID extraction, terminal, duplicates and gap replay.

- [ ] **Step 6: Run contract tests and commit**

Run: `npm --prefix frontend test -- src/components/ai/aiTimelineReducer.test.ts src/api/aiApi.test.ts`

~~~bash
git add frontend/src/api/types/ai.ts frontend/src/api/aiApi.ts frontend/src/components/ai/aiTimelineReducer.ts frontend/src/components/ai/aiTimelineReducer.test.ts frontend/src/api/aiApi.test.ts
git commit -m "refactor(ai): add deterministic frontend timeline reducer"
~~~

### Task 7: Replace Workspace/Thread/Mobile state assembly with the reducer

**Files:**
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/ai/AiMobilePage.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.tsx`
- Modify: `frontend/src/components/ai/useAiConversationStreams.ts`
- Modify: `frontend/src/components/ai/useAiChatStream.ts`
- Modify: `frontend/src/components/ai/useAiApprovalStream.ts`
- Modify: `frontend/src/components/ai/useAiHumanInputStream.ts`
- Modify: `frontend/src/components/ai/useAiConversationLiveSync.ts`
- Modify: `frontend/src/components/ai/aiWorkspaceHelpers.tsx`
- Delete: ordering-only tests in `frontend/src/components/ai/aiWorkspaceHelpers.test.ts` after moving non-order helpers
- Test: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Test: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Test: `frontend/src/components/ai/AiConversationThread.test.tsx`
- Test: `frontend/src/components/ai/AiMobilePage.test.tsx`

**Interfaces:**
- Workspace owns `timelineByConversationId`, not local message/run-event arrays as facts.
- `AiConversationThread` receives canonical ordered messages and no separate run events for placement.
- Approval, human-input, card action and debug callbacks retain signatures.

- [ ] **Step 1: Add live/history equivalence tests**

Feed the same event list through live callbacks and a history snapshot and assert identical rendered order. Include text around a result card, activity replacement, approval continuation, no transient second line, refresh while running, and desktop/mobile parity.

- [ ] **Step 2: Run behavior tests and record old failures**

Run: `npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/ai/AiMobilePage.test.tsx`

Expected: failures identify bare-list, separate run-event and local assistant assumptions.

- [ ] **Step 3: Hydrate reducer state from snapshot**

Convert the query consumer to `createAiTimelineState(snapshot)`. Keep composer text/attachments and thinking timers as UI state. Map `messageOrder` to existing bubbles without visual prop changes.

- [ ] **Step 4: Route all stream callbacks into reducer**

Remove `applyStreamDelta`, `applyStreamPart`, `upsertStreamProgressEvent` and response merge. On `needsReplay`, fetch and merge a contiguous range; if replay fails, refetch snapshot and retain existing retry/error presentation.

- [ ] **Step 5: Remove asynchronous run-event insertion**

Delete historical per-message `getAiRunEvents` calls. Thread maps `run_activity` parts in array order; remove insertion-before-card and post-approval text movement.

- [ ] **Step 6: Preserve UX and mobile behavior**

Keep thinking, auto-scroll, composer busy/disabled, approval/human-input panels, card callbacks, debug drawer and mobile props. Add no CSS or token.

- [ ] **Step 7: Run behavior tests and commit**

Run: `npm --prefix frontend test -- src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/ai/AiMobilePage.test.tsx`

~~~bash
git add frontend/src/components/ai
git commit -m "refactor(ai): render conversation from canonical timeline"
~~~

### Task 8: Remove legacy ordering code and align planner/diagnostic consumers

**Files:**
- Modify: `backend/app/ai/workflows/timeline.py`
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/api/ai.py`
- Modify: `frontend/src/components/ai/aiWorkspaceHelpers.tsx`
- Modify: `docs/ai-assistant-standards.md`
- Modify: `docs/frontend-code-standards.md`
- Modify: `docs/backend-code-standards.md`
- Delete: obsolete ordering helpers/tests found by forbidden-symbol search
- Test: `backend/tests/ai_infra/test_workspace_chat.py`
- Test: `frontend/src/components/ai/aiTimelineReducer.test.ts`

**Interfaces:**
- Planner history is ordered by `AIMessage.timeline_position`.
- Run debug APIs may expose `AIRunEvent`, but no user view treats it as message position.

- [ ] **Step 1: Search for forbidden legacy symbols**

Run:

~~~bash
rg -n "LiveAIStreamCache|live_ai_stream_cache|liveStreaming|livePartIds|liveTextPartIds|streamOrderCanonical|mergeRemoteAndLocalMessage|mergeMessageParts|movePostApprovalTextAfterOperationResult|runEventsById|streamProgressByRunId|created_at\\.asc\\(\\)" backend/app frontend/src/components/ai
~~~

Expected after cleanup: no timeline consumer matches; remaining time sorting is audit-only.

- [ ] **Step 2: Replace planner and response ordering**

Update planner, `_chat_response`, serializers and message queries to use timeline sequence/position. Keep `created_at` only for display. Remove selection of latest assistant by timestamp.

- [ ] **Step 3: Delete compatibility tests and add negative assertions**

Delete anchor/fallback-only tests. Add service instrumentation proving visible producers do not directly mutate `message.parts`; unknown events trigger snapshot recovery instead of guessing.

- [ ] **Step 4: Update standards**

Document envelope, sequence/gap rules, snapshot/replay, terminal semantics and prohibition on independent run-event insertion. Keep draft/approval and visual contracts unchanged.

- [ ] **Step 5: Run cleanup tests and commit**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_workspace_chat.py tests/ai_infra/test_ai_timeline_service.py -q`

Run: `npm --prefix frontend test -- src/components/ai/aiTimelineReducer.test.ts`

~~~bash
git add backend/app frontend/src/components/ai docs/ai-assistant-standards.md docs/frontend-code-standards.md docs/backend-code-standards.md backend/tests/ai_infra frontend/src/components/ai
git commit -m "refactor(ai): remove legacy message ordering paths"
~~~

### Task 9: End-to-end verification and completion gate

**Files:**
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`
- Modify: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Create: `frontend/e2e/ai-timeline-order.spec.mjs`
- Create: `backend/tests/ai_infra/test_ai_timeline_contract.py`

**Interfaces:**
- One deterministic script feeds backend snapshot/replay and frontend reducer.
- E2E uses scripted provider fixtures, never paid/non-deterministic provider.

- [ ] **Step 1: Add cross-layer contract cases**

Use:

~~~text
user message → assistant placeholder → activity running → text(before)
→ draft → approval → activity completed → result card → text(after) → terminal
~~~

Assert backend snapshot, replay reconstruction and frontend reducer produce identical ordered part IDs/statuses. Repeat with duplicates, a missing sequence and reconnect cursor.

- [ ] **Step 2: Add browser scenarios**

At 375×812 and 1440×900 verify first-token streaming, result-card boundary order, no transient second line, refresh during/after run, approval/human-input resume in original message, and unchanged composer/scroll/card actions.

- [ ] **Step 3: Run focused contract suites**

Run: `cd backend && .venv/bin/python -m pytest tests/ai_infra/test_ai_timeline_contract.py tests/ai_infra/test_workspace_streaming.py tests/ai_infra/test_run_cancellation.py -q`

Run: `npm --prefix frontend test -- src/components/ai/aiTimelineReducer.test.ts src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiConversationThread.test.tsx`

- [ ] **Step 4: Run repository quality gates**

Run: `npm run frontend:quality`

Run: `npm run frontend:build`

Run: `npm run backend:quality`

Run: `npm run frontend:e2e:p0`

Run: `npm --prefix frontend run check:style-tokens`

Run: `git diff --check`

If a gate cannot run, record exact missing dependency/output; do not substitute a weaker command.

- [ ] **Step 5: Inspect required viewports and final diff**

Check 375×812, 390×844, 430×932, 768×1024, 1024×768 and 1440×900. Confirm no CSS drift, duplicate assistant message, independent run-event query, or direct visible `AIMessage.parts` writer outside the service.

- [ ] **Step 6: Commit verification artifacts**

~~~bash
git add backend/tests/ai_infra/test_ai_timeline_contract.py frontend/e2e/ai-timeline-order.spec.mjs backend/tests/ai_infra/test_workspace_streaming.py frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx
git commit -m "test(ai): verify canonical timeline across reconnect and history"
~~~

