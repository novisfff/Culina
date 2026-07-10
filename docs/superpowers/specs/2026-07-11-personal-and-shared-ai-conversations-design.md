# Personal and Shared AI Conversations Design

**Date:** 2026-07-11

**Status:** Approved design

## Goal

Make the main AI workspace private by default for each family member, let a conversation owner publish a conversation for family-wide collaboration, and allow different conversations to run concurrently without mixing their messages, drafts, attachments, progress, or cancellation state.

## Scope

This design applies only to persistent conversations in the main AI workspace.

It does not change the cooking-page assistant. That surface continues to send `quick_task="cooking_assistant"` with `persist_history=false`, use a transient conversation, and delete its system AI history after the response.

## Current State

The current implementation has three relevant properties:

1. Persistent AI conversations record `created_by`, but conversation listing and most conversation-derived APIs authorize only by `family_id`. Members of the same family can therefore access each other's conversation history if they obtain it through the list or know a resource ID.
2. The backend already prevents two active runs in the same conversation, but it does not impose a family-wide or user-wide active-run limit.
3. The frontend calculates `isAnotherConversationRunning` and pauses the current composer whenever a different conversation is active. Stream mutation state and composer state are also partly global, so simply removing that pause would risk cross-conversation state mixing.

## Product Rules

### Ownership and default privacy

- Every accessible persistent main-AI conversation has one immutable owner.
- New conversations are private by default.
- A private conversation is visible and usable only by its owner.
- The original owner does not change when another family member contributes to a published conversation.
- `created_by` on messages, runs, approvals, and other child records continues to record the user who performed that specific action.

### Family collaboration

- The conversation owner can publish a private conversation to the current family.
- All active members of that family can view and contribute to a published conversation.
- Contribution includes sending messages, responding to human-input requests, approving or rejecting drafts, retrying failed runs, regenerating parts, and cancelling the current run.
- Only the conversation owner can publish, unpublish, or delete the conversation.
- Unpublishing immediately removes the conversation from other members' accessible history.
- If the owner leaves the family, their private conversations become inaccessible because they no longer have an active membership. Conversations they already published remain available to the original family, but no remaining member inherits management permission. The same user regains management only if they rejoin that family.

### Concurrency

- One conversation may have at most one active run at a time.
- Different conversations may run concurrently, regardless of whether they are private or family-published.
- Switching conversations does not cancel background work.
- Cancelling one run does not affect any other conversation.

### History presentation

- The history list combines the current user's conversations and family-published conversations.
- The combined list is ordered by latest conversation activity.
- Published conversations display a `家庭公开` badge and the owner's display name.
- Multiple history items may independently display running or waiting status.

## Data Model

### Conversation visibility enum

Add `AIConversationVisibility` to `backend/app/core/enums.py`:

```python
class AIConversationVisibility(str, Enum):
    PRIVATE = "private"
    FAMILY = "family"
```

### AIConversation fields

Add these columns to `AIConversation`:

- `owner_user_id: str | None`: foreign key to `users.id`, indexed. Application code requires this value for every newly created conversation. The database column remains nullable only so unassignable legacy rows can be retained but quarantined from access.
- `visibility: AIConversationVisibility`: non-null, default `private`.

Keep `created_by` as the historical audit field. For new conversations, `owner_user_id` and `created_by` are both initialized from the authenticated user.

Add two query-oriented indexes:

- `(family_id, owner_user_id, last_message_at, created_at)` for a user's own recent conversations.
- `(family_id, visibility, last_message_at, created_at)` for recent family-published conversations.

The API and application layer treat a null `owner_user_id` as an inaccessible quarantined legacy conversation. It cannot be listed, opened, published, continued, or deleted through normal member APIs.

### Migration

The Alembic migration performs these steps:

1. Add nullable `owner_user_id` and non-null `visibility` with a temporary server default of `private`.
2. Backfill `owner_user_id = created_by` only where `created_by` matches an existing `users.id`.
3. Leave unmatched or null legacy owners as null and therefore inaccessible.
4. Create the foreign key and both recent-conversation indexes.
5. Keep `visibility=private` for every existing conversation.
6. Remove the temporary server default if the project migration convention requires application-owned defaults.

No legacy conversation is automatically published, assigned to a family owner, or deleted.

## Permission Model

### Capabilities

Centralize access around three capabilities:

- `view`: read conversation metadata, messages, run events, and accessible diagnostic summaries.
- `contribute`: perform conversation operations that modify the shared timeline or resolve its workflow.
- `manage`: publish, unpublish, or delete the conversation.

The rules are:

| Actor | Private conversation | Family-published conversation |
| --- | --- | --- |
| Owner | view, contribute, manage | view, contribute, manage |
| Active member of the same family | none | view, contribute |
| User outside the family | none | none |

There is no Owner-role override for private AI history. A family Owner cannot view another member's private conversation merely because of the family role.

### Central access helpers

Extend the conversation workflow boundary so routes and services do not repeat ad hoc predicates. The helpers accept the authenticated `family_id` and `user_id`, resolve the conversation, and enforce one of the capabilities above.

Child-resource helpers first resolve the parent conversation:

- message -> `AIMessage.conversation_id`
- run -> `AIAgentRun.conversation_id`
- approval -> `AIApprovalRequest.conversation_id`
- human-input request -> containing message/conversation
- LLM exchange or trace -> run -> conversation

If a persistent run or child resource cannot be connected to an accessible conversation, the main-workspace endpoint returns 404. This prevents resource-ID guessing from bypassing conversation privacy.

Runs with `conversation_id=None` are not persistent main-workspace history. Existing authorization for cooking-page, standalone recipe generation, and other non-conversation diagnostics remains unchanged.

### HTTP behavior

- Unauthorized and nonexistent conversation-derived resources both return 404.
- A second active run in the same conversation returns 409.
- Different conversations are never rejected merely because another conversation is active.
- A member whose access was removed by unpublishing receives 404 on the next poll or operation.

## API Contract

### Conversation response

Extend `AIConversationOut` and the frontend `AiConversation` type with:

```text
owner_user_id: string
owner_display_name: string
visibility: "private" | "family"
is_owner: boolean
```

Only accessible conversations have an owner, so `owner_user_id` is non-null in API responses even though the migration column permits quarantined nulls.

The conversation list query returns rows satisfying:

```text
family_id = current_family
AND owner_user_id IS NOT NULL
AND (owner_user_id = current_user OR visibility = "family")
```

It joins or batches the owner user record so the UI does not issue per-row member requests. The existing limit of 20 applies after combining private-owned and family-published conversations, ordered by `coalesce(last_message_at, created_at)` descending.

### Visibility mutation

Add:

```http
PATCH /api/ai/conversations/{conversation_id}/visibility
Content-Type: application/json

{"visibility":"family"}
```

The request accepts only `private` or `family` and returns the updated `AIConversationOut`.

Only the owner may call the endpoint. When the conversation has a `pending` or `running` run, visibility changes and deletion return 409 so an in-flight stream cannot race with access revocation or destructive cleanup. Waiting-for-approval and waiting-for-input states may be unpublished; after that, only the owner can resume them.

## Backend Flow

### Conversation creation and continuation

- `get_or_create_conversation` sets `owner_user_id=user_id` and `visibility=private` for a new persistent conversation.
- Continuing an existing conversation requires `contribute`, not merely matching `family_id`.
- Idempotent message/run lookup must also validate that the resolved run belongs to a conversation the current user may contribute to.
- The existing per-conversation active-run query remains the concurrency guard.

### Read and management routes

- List conversations using the accessible predicate above.
- Fetch messages only after `view` authorization.
- Publish, unpublish, and delete only after `manage` authorization.
- Run events and live event polling require `view` on the run's parent conversation.
- Cancel, retry, regenerate, approval decisions, and human-input responses require `contribute`.
- Recommendation selection and inventory quick-draft actions resolve their message's conversation and require `contribute`.

### Diagnostics and quality metrics

- Trace, trace-tree, and LLM-exchange routes retain their existing family Owner-role requirement and additionally require `view` for conversation-backed runs.
- A family Owner therefore cannot inspect another member's private conversation trace.
- Quality metrics exclude conversation-backed runs that the current user cannot view.
- Metrics may continue to include `conversation_id=None` runs under their current family-scoped behavior so cooking-page and standalone AI diagnostics are not changed by this feature.
- Token usage, trace metrics, operational metrics, and `recent_runs` are all calculated from the same authorized run set rather than mixing accessible recent runs with family-wide private totals.

## Frontend Design

### History list

Desktop and mobile use the same conversation permission fields and display rules:

- Published item: `家庭公开` badge plus `owner_display_name`.
- Owner's private item: no family badge.
- Owner item menu: publish/unpublish and delete actions as allowed by current visibility.
- Collaborator item: no visibility or delete action.

The visibility mutation updates the conversation query on success. The existing two-second conversation polling makes another member's newly published conversation, latest activity, running state, and unpublication appear without a page reload.

### Per-conversation run manager

Replace singleton mutation-derived busy state with a run registry keyed by conversation and run:

```ts
type AiConversationRunState = {
  conversationKey: string;
  runId: string;
  kind: 'chat' | 'approval' | 'human_input';
  status: 'streaming' | 'waiting' | 'completed' | 'failed';
};
```

The registry owns or indexes:

- active run IDs by conversation key
- abort controllers by run ID
- stream target message IDs
- progress events and thinking state
- terminal errors

Sending in conversation B is allowed while conversation A is active. Sending again in conversation A remains disabled until A completes, waits, fails, or is cancelled.

### Scoped composer state

Draft text and attachments are keyed by conversation key, including pending conversation keys. Switching conversations restores that conversation's unsent composer state. It must never carry unsent text or uploaded media into a different conversation.

When a new conversation response replaces a pending key with its server conversation ID, migrate only that key's:

- local messages
- draft text
- attachments
- active run state
- progress and stream targets

Other pending or established conversations continue unchanged.

### Cancellation and live synchronization

- The cancel button targets only the active run associated with the currently displayed conversation.
- History status derives from both local run registry entries and server-polled conversation state.
- Several history entries may show running or waiting indicators simultaneously.
- Refreshing the page reconstructs server-backed running and waiting states from each conversation's `last_run_status` and `context.activeRunId`.
- If a collaborator loses access after unpublishing, a 404 clears message and approval caches for that conversation, removes local run/composer state, selects the next accessible conversation, and shows `该会话已取消公开`.

## Error Handling

- Same-conversation conflict: show `这个会话正在处理另一条消息` and refresh its messages, approvals, and conversation metadata.
- Visibility/delete during generation: show `会话正在生成回复，请先等待完成或取消当前任务`.
- Lost public access: clear only the inaccessible conversation's cached and local state; do not reset other running conversations.
- Stream failure: mark only the affected run failed and leave other streams active.
- One run's cancellation or abort controller must never be reused for another run.

## Testing Strategy

### Backend

Add two users with active memberships in the same family to the AI infrastructure fixtures and cover:

1. Each user lists only their private conversations plus family-published conversations.
2. Migration-compatible null-owner rows are absent from lists and return 404 by ID.
3. A valid legacy `created_by` backfills ownership and remains private.
4. Only the owner can publish, unpublish, and delete.
5. A family collaborator can read, continue, approve, reject, answer human input, retry, regenerate, and cancel a published conversation.
6. Private child resources return 404 through conversation, message, run, approval, trace, tree, and LLM-exchange endpoints.
7. Family Owner role does not bypass private conversation trace access.
8. Two different conversations can have active runs concurrently.
9. A second run in the same conversation returns 409.
10. Cancelling one concurrent run leaves the other run active.
11. Visibility change and deletion fail during pending/running generation but unpublishing succeeds while waiting for approval/input.
12. Quality metrics exclude inaccessible private conversation runs.
13. Cooking assistant tests still prove `persist_history=false` leaves no system AI conversation history.

### Frontend

Cover desktop and mobile behavior:

1. The unified list orders owned and published conversations by latest activity.
2. Published items display the badge and owner name.
3. Management actions appear only when `is_owner=true`.
4. Visibility mutation updates history state and handles 409 feedback.
5. Two conversation streams can progress and complete independently.
6. Switching conversations does not pause a different conversation's stream.
7. Drafts and attachments remain scoped to their conversation.
8. Cancelling one run does not abort another.
9. Pending conversation keys remap independently when concurrent new conversations receive server IDs.
10. A 404 after unpublishing removes only the inaccessible conversation and selects a safe fallback.
11. Multiple history entries render independent running/waiting indicators.

### Verification commands

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_chat.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_approvals.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_cooking_assistant_skill.py -q
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
npm run backend:migrate
git diff --check
```

## Acceptance Criteria

- A newly created main-AI conversation is visible only to its creator.
- Existing attributable conversations belong to `created_by` and remain private.
- Unattributable legacy conversations remain stored but inaccessible.
- Publishing makes the conversation visible and collaborative to current members of the same family.
- Only the creator can change visibility or delete the conversation.
- A family collaborator can contribute to the shared timeline and approval workflow without becoming the owner.
- Different conversations can run at the same time without mixed messages, drafts, attachments, progress, errors, or cancellation.
- The same conversation remains serialized to one active run.
- Private conversation details cannot be accessed through child resource or diagnostic IDs.
- The cooking-page assistant behavior and transient-history cleanup remain unchanged.
