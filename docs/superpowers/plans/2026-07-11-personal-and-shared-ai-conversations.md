# Personal and Shared AI Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make main-AI conversations private per user by default, optionally family-collaborative, and independently runnable across multiple conversations while leaving the cooking-page assistant unchanged.

**Architecture:** Persist an immutable conversation owner and explicit visibility, then authorize every conversation-derived resource through one access-policy module. Keep one active run per conversation, but replace frontend-wide busy/composer state with conversation-keyed state so different conversations can stream concurrently without cross-talk.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, Pydantic, MySQL, pytest, React 18, TypeScript, React Query, Vitest.

## Global Constraints

- Scope only persistent main-AI workspace conversations; do not change cooking-page `persist_history=false` behavior.
- Existing attributable conversations inherit `AIConversation.created_by` and remain private; unattributable rows remain stored but inaccessible.
- Only the conversation creator may publish, unpublish, or delete; active family members may collaborate only after publication.
- Same-conversation runs remain serialized; different conversations may run concurrently.
- Unauthorized conversation-derived resources return 404; same-conversation conflicts return 409.
- Family Owner role does not override another member's private AI history.
- UI work must first follow `.agents/skills/frontend-ui-style`; use `.agents/skills/frontend-ui-engineering` for state-flow and accessibility decisions.
- Follow `docs/backend-code-standards.md`, `docs/frontend-code-standards.md`, and `docs/ai-assistant-standards.md`.
- Use TDD, keep commits scoped to one task, and do not modify the cooking assistant contract.

## File Map

- Create `backend/alembic/versions/1d2e3f4a5b6c_add_ai_conversation_ownership.py`: migrate owner, visibility, backfill, foreign key, and recent-list indexes.
- Create `backend/app/ai/workflows/conversation_access.py`: define view/contribute/manage policy and parent-resource resolution.
- Create `backend/tests/ai_infra/test_conversation_access.py`: cover ownership, publication, collaboration, and ID-based privacy.
- Modify `backend/app/core/enums.py`, `backend/app/models/domain.py`, `backend/app/schemas/ai.py`, `backend/app/services/serializers.py`: persist and expose ownership/visibility.
- Modify `backend/app/ai/workflows/conversations.py`, `backend/app/ai/workflows/run_lifecycle.py`, `backend/app/ai/workspace_service.py`, `backend/app/api/ai.py`: enforce access throughout main-AI entry points.
- Modify `backend/app/services/ai_quality.py`, `backend/tests/ai_infra/test_ai_observability.py`, `backend/tests/ai_infra/test_registry_and_metrics.py`: scope diagnostics to accessible runs.
- Modify `frontend/src/api/types.ts`, `frontend/src/api/aiApi.ts`, `frontend/src/api/aiApi.test.ts`, `frontend/src/components/ai/aiWorkspaceTestFixtures.ts`: add the cross-end contract.
- Modify `frontend/src/components/ai/AiConversationHistory.tsx`, `frontend/src/components/ai/AiMobileChrome.tsx`, `frontend/src/components/ai/AiMobilePage.tsx`, `frontend/src/components/ai/AiWorkspace.tsx`, `frontend/src/styles/09-ai-workspace.css`: expose owner-only publication management and shared labels.
- Create `frontend/src/components/ai/useAiConversationComposerState.ts` and its test: scope drafts by conversation key.
- Modify `frontend/src/components/ai/useAiAttachmentState.ts` and add its test: scope attachments and hidden-send recovery by conversation key.
- Replace `frontend/src/components/ai/useAiStreamMutations.ts` with `frontend/src/components/ai/useAiConversationStreams.ts`: run concurrent streams without singleton mutation state.
- Modify AI workspace integration tests and `docs/ai-assistant-standards.md`: verify and document the complete behavior.

---

### Task 1: Persist Conversation Ownership and Visibility

**Files:**
- Create: `backend/alembic/versions/1d2e3f4a5b6c_add_ai_conversation_ownership.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/models/domain.py:535-558`
- Modify: `backend/tests/ai_infra/_support.py:45-55`
- Test: `backend/tests/ai_infra/test_conversation_access.py`

**Interfaces:**
- Consumes: current Alembic head `0c1d2e3f4a5b`; existing `AIConversation.created_by`.
- Produces: `AIConversationVisibility`, `AIConversation.owner_user_id`, and `AIConversation.visibility`.

- [ ] **Step 1: Write the failing ORM ownership test**

```python
from ._support import *


class AIConversationAccessTestCase(AIAgentInfraTestCase):
    def test_conversation_persists_explicit_owner_and_private_visibility(self) -> None:
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-owned",
                family_id=self.family.id,
                owner_user_id=self.user.id,
                visibility=AIConversationVisibility.PRIVATE,
                mode=AiMode.RECOMMENDATION,
                prompt="我的问题",
                response="",
                context={"workspace": True},
                title="我的问题",
                summary="",
                status="active",
                created_by=self.user.id,
            )
            db.add(conversation)
            db.commit()
            stored = db.get(AIConversation, conversation.id)
            assert stored is not None
            self.assertEqual(stored.owner_user_id, self.user.id)
            self.assertEqual(stored.visibility, AIConversationVisibility.PRIVATE)
```

- [ ] **Step 2: Run the test and verify the new contract is absent**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py::AIConversationAccessTestCase::test_conversation_persists_explicit_owner_and_private_visibility -q`

Expected: FAIL because `AIConversationVisibility` and the ORM fields do not exist.

- [ ] **Step 3: Add the enum and ORM fields**

```python
class AIConversationVisibility(str, Enum):
    PRIVATE = "private"
    FAMILY = "family"
```

```python
class AIConversation(Base):
    __tablename__ = "ai_conversations"
    __table_args__ = (
        Index("ix_ai_conversations_family_owner_recent", "family_id", "owner_user_id", "last_message_at", "created_at"),
        Index("ix_ai_conversations_family_visibility_recent", "family_id", "visibility", "last_message_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("conversation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    visibility: Mapped[AIConversationVisibility] = mapped_column(
        SqlEnum(AIConversationVisibility, native_enum=False),
        default=AIConversationVisibility.PRIVATE,
        nullable=False,
    )
```

Also import `AIConversationVisibility` into `domain.py` and the shared AI test support enum import list without changing the remaining conversation fields or relationships.

- [ ] **Step 4: Add the forward and reverse migration**

```python
"""Add AI conversation ownership and visibility."""

from alembic import op
import sqlalchemy as sa

revision = "1d2e3f4a5b6c"
down_revision = "0c1d2e3f4a5b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_conversations", sa.Column("owner_user_id", sa.String(length=64), nullable=True))
    op.add_column(
        "ai_conversations",
        sa.Column(
            "visibility",
            sa.Enum("PRIVATE", "FAMILY", name="aiconversationvisibility", native_enum=False),
            nullable=False,
            server_default="PRIVATE",
        ),
    )
    op.execute(
        sa.text(
            "UPDATE ai_conversations AS c "
            "INNER JOIN users AS u ON u.id = c.created_by "
            "SET c.owner_user_id = c.created_by"
        )
    )
    op.create_foreign_key(
        "fk_ai_conversations_owner_user_id_users",
        "ai_conversations",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_ai_conversations_owner_user_id", "ai_conversations", ["owner_user_id"])
    op.create_index(
        "ix_ai_conversations_family_owner_recent",
        "ai_conversations",
        ["family_id", "owner_user_id", "last_message_at", "created_at"],
    )
    op.create_index(
        "ix_ai_conversations_family_visibility_recent",
        "ai_conversations",
        ["family_id", "visibility", "last_message_at", "created_at"],
    )
    op.alter_column("ai_conversations", "visibility", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_ai_conversations_family_visibility_recent", table_name="ai_conversations")
    op.drop_index("ix_ai_conversations_family_owner_recent", table_name="ai_conversations")
    op.drop_index("ix_ai_conversations_owner_user_id", table_name="ai_conversations")
    op.drop_constraint("fk_ai_conversations_owner_user_id_users", "ai_conversations", type_="foreignkey")
    op.drop_column("ai_conversations", "visibility")
    op.drop_column("ai_conversations", "owner_user_id")
```

- [ ] **Step 5: Run the model test and migration checks**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q
(cd backend && .venv/bin/alembic heads)
(cd backend && .venv/bin/alembic upgrade head)
```

Expected: PASS; Alembic reports `1d2e3f4a5b6c (head)` and upgrades without error.

- [ ] **Step 6: Commit the persistence contract**

```bash
git add backend/app/core/enums.py backend/app/models/domain.py backend/alembic/versions/1d2e3f4a5b6c_add_ai_conversation_ownership.py backend/tests/ai_infra/_support.py backend/tests/ai_infra/test_conversation_access.py
git commit -m "feat(ai): persist conversation ownership"
```

### Task 2: Centralize Conversation Access and Public Listing

**Files:**
- Create: `backend/app/ai/workflows/conversation_access.py`
- Modify: `backend/app/ai/workflows/conversations.py:61-166`
- Modify: `backend/app/schemas/ai.py:13-28`
- Modify: `backend/app/services/serializers.py:424-440`
- Modify: `backend/app/api/ai.py:196-209`
- Modify: `backend/tests/ai_infra/_support.py:1236-1390`
- Test: `backend/tests/ai_infra/test_conversation_access.py`
- Test fixtures: `backend/tests/ai_infra/test_composite_operations.py`
- Test fixtures: `backend/tests/ai_infra/test_foundation.py`
- Test fixtures: `backend/tests/ai_infra/test_inventory_operations.py`
- Test fixtures: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Test fixtures: `backend/tests/ai_infra/test_workspace_approvals.py`
- Test fixtures: `backend/tests/ai_infra/test_workspace_chat.py`
- Test fixtures: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**
- Consumes: `AIConversationVisibility` and ownership fields from Task 1.
- Produces: `accessible_ai_conversation_clause(user_id)`, `require_ai_conversation_access`, and owner-aware `AIConversationOut`.

- [ ] **Step 1: Add failing list and capability tests with a second family member**

```python
def create_family_member(self, *, user_id: str = "user-ai-two") -> tuple[User, Membership]:
    with self.SessionLocal() as db:
        user = User(id=user_id, username=f"{user_id}-login", display_name="家庭成员", avatar_seed="", is_active=True)
        membership = Membership(
            id=f"membership-{user_id}",
            family_id=self.family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        db.add_all([user, membership])
        db.commit()
        return user, membership

def authenticate_as(self, user_id: str, membership_id: str) -> None:
    def override_auth():
        with self.SessionLocal() as db:
            user = db.get(User, user_id)
            membership = db.get(Membership, membership_id)
            assert user is not None and membership is not None
            return user, membership
    app.dependency_overrides[get_current_auth] = override_auth

def _conversation(
    self,
    conversation_id: str,
    owner_user_id: str,
    visibility: AIConversationVisibility,
    last_message_at: datetime,
) -> AIConversation:
    return AIConversation(
        id=conversation_id,
        family_id=self.family.id,
        owner_user_id=owner_user_id,
        visibility=visibility,
        mode=AiMode.RECOMMENDATION,
        prompt=conversation_id,
        response="",
        context={"workspace": True},
        title=conversation_id,
        summary="",
        status="active",
        last_message_at=last_message_at,
        last_run_status="completed",
        created_by=owner_user_id,
    )

def _persist_conversation(
    self,
    conversation_id: str,
    owner_user_id: str,
    visibility: AIConversationVisibility,
) -> AIConversation:
    with self.SessionLocal() as db:
        conversation = self._conversation(
            conversation_id,
            owner_user_id,
            visibility,
            datetime(2026, 7, 11, 12, 0, 0),
        )
        db.add(conversation)
        db.commit()
        db.refresh(conversation)
        return conversation

def test_history_contains_owned_private_and_family_public_only(self) -> None:
    other_user, other_membership = self.create_family_member()
    with self.SessionLocal() as db:
        db.add_all([
            self._conversation("mine-private", self.user.id, AIConversationVisibility.PRIVATE, datetime(2026, 7, 11, 10, 0, 0)),
            self._conversation("other-private", other_user.id, AIConversationVisibility.PRIVATE, datetime(2026, 7, 11, 11, 0, 0)),
            self._conversation("other-public", other_user.id, AIConversationVisibility.FAMILY, datetime(2026, 7, 11, 12, 0, 0)),
        ])
        db.commit()
    response = self.client.get("/api/ai/conversations")
    self.assertEqual(response.status_code, 200, response.text)
    self.assertEqual([item["id"] for item in response.json()], ["other-public", "mine-private"])
    self.assertTrue(response.json()[1]["is_owner"])
    self.assertEqual(response.json()[0]["owner_display_name"], other_user.display_name)
```

Place `create_family_member` and `authenticate_as` on `AIAgentInfraTestCase` in `_support.py`; place `_conversation`, `_persist_conversation`, and the test method on `AIConversationAccessTestCase`.

- [ ] **Step 2: Run the list test and verify private rows leak today**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py::AIConversationAccessTestCase::test_history_contains_owned_private_and_family_public_only -q`

Expected: FAIL because the current list returns all family conversations and lacks owner metadata.

- [ ] **Step 3: Implement the access-policy module**

```python
from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.enums import AIConversationVisibility
from app.models.domain import AIAgentRun, AIConversation, AIMessage

ConversationCapability = Literal["view", "contribute", "manage"]


def accessible_ai_conversation_clause(user_id: str):
    return and_(
        AIConversation.owner_user_id.is_not(None),
        or_(
            AIConversation.owner_user_id == user_id,
            AIConversation.visibility == AIConversationVisibility.FAMILY,
        ),
    )


def require_ai_conversation_access(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str,
    capability: ConversationCapability,
    for_update: bool = False,
) -> AIConversation:
    query = select(AIConversation).where(
        AIConversation.id == conversation_id,
        AIConversation.family_id == family_id,
        AIConversation.owner_user_id.is_not(None),
    )
    if for_update:
        query = query.with_for_update()
    conversation = db.scalar(query)
    if conversation is None:
        raise LookupError("会话不存在")
    is_owner = conversation.owner_user_id == user_id
    is_family_public = conversation.visibility == AIConversationVisibility.FAMILY
    allowed = is_owner if capability == "manage" else is_owner or is_family_public
    if not allowed:
        raise LookupError("会话不存在")
    return conversation


def require_ai_message_access(db: Session, *, family_id: str, user_id: str, message_id: str, capability: ConversationCapability) -> AIMessage:
    message = db.scalar(select(AIMessage).where(AIMessage.id == message_id, AIMessage.family_id == family_id))
    if message is None:
        raise LookupError("消息不存在")
    require_ai_conversation_access(
        db,
        family_id=family_id,
        user_id=user_id,
        conversation_id=message.conversation_id,
        capability=capability,
    )
    return message


def require_ai_run_access(db: Session, *, family_id: str, user_id: str, run_id: str, capability: ConversationCapability) -> AIAgentRun:
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None:
        raise LookupError("运行任务不存在")
    if run.conversation_id is not None:
        require_ai_conversation_access(
            db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=run.conversation_id,
            capability=capability,
        )
    return run
```

- [ ] **Step 4: Make creation and continuation ownership-aware**

Update `get_or_create_conversation` so existing IDs call `require_ai_conversation_access` with `capability="contribute"` and `for_update=True`; new rows contain:

```python
conversation = AIConversation(
    id=create_id("conversation"),
    family_id=family_id,
    owner_user_id=user_id,
    visibility=AIConversationVisibility.PRIVATE,
    mode=AiMode.RECOMMENDATION,
    prompt=prompt,
    response="",
    context={"workspace": True},
    title=title,
    summary="",
    status="active",
    last_message_at=utcnow(),
    created_by=user_id,
)
```

- [ ] **Step 5: Extend the API schema, serializer, and list query**

```python
class AIConversationOut(BaseModel):
    id: str
    family_id: str
    owner_user_id: str
    owner_display_name: str
    visibility: AIConversationVisibility
    is_owner: bool
    mode: AiMode
    prompt: str
    response: str
    created_at: datetime
    created_by: str | None = None
    context: dict
    title: str = ""
    summary: str = ""
    status: str = "active"
    last_message_at: datetime | None = None
    last_run_status: str = ""
```

```python
def serialize_ai_conversation(item: AIConversation, *, owner_display_name: str, current_user_id: str) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "owner_user_id": item.owner_user_id,
        "owner_display_name": owner_display_name,
        "visibility": item.visibility,
        "is_owner": item.owner_user_id == current_user_id,
        "mode": item.mode,
        "prompt": item.prompt,
        "response": item.response,
        "created_at": _utc_datetime(item.created_at),
        "created_by": item.created_by,
        "context": item.context,
        "title": item.title,
        "summary": item.summary,
        "status": item.status,
        "last_message_at": _utc_datetime(item.last_message_at),
        "last_run_status": item.last_run_status,
    }
```

In `list_ai_conversations`, select `(AIConversation, User.display_name)`, join `User.id == AIConversation.owner_user_id`, apply family plus `accessible_ai_conversation_clause(user.id)`, retain the existing order and limit, and serialize with the authenticated user ID.

- [ ] **Step 6: Update persistent-conversation test fixtures to the new invariant**

For every manually constructed accessible `AIConversation` in the seven listed AI infrastructure files, add:

```python
owner_user_id=self.user.id,
visibility=AIConversationVisibility.PRIVATE,
```

Use the actual existing `created_by` user when a fixture belongs to another user. Leave `owner_user_id=None` only in the explicit quarantined-legacy test. This prevents unrelated list, approval, and streaming tests from silently creating inaccessible pseudo-legacy rows.

- [ ] **Step 7: Run access tests**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q`

Expected: PASS for owner/private/public listing and capability decisions.

- [ ] **Step 8: Commit the access foundation**

```bash
git add backend/app/ai/workflows/conversation_access.py backend/app/ai/workflows/conversations.py backend/app/schemas/ai.py backend/app/services/serializers.py backend/app/api/ai.py backend/tests/ai_infra
git commit -m "feat(ai): isolate conversation access"
```

### Task 3: Add Owner-Only Visibility Management

**Files:**
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/api/ai.py:281-352`
- Test: `backend/tests/ai_infra/test_conversation_access.py`

**Interfaces:**
- Consumes: `require_ai_conversation_access` with the `manage` capability.
- Produces: `PATCH /api/ai/conversations/{conversation_id}/visibility` and active-run management conflicts.

- [ ] **Step 1: Write failing publication and management tests**

```python
def test_only_owner_can_publish_unpublish_and_delete(self) -> None:
    other_user, other_membership = self.create_family_member()
    conversation = self._persist_conversation("conversation-manage", self.user.id, AIConversationVisibility.PRIVATE)
    published = self.client.patch(
        f"/api/ai/conversations/{conversation.id}/visibility",
        json={"visibility": "family"},
    )
    self.assertEqual(published.status_code, 200, published.text)
    self.assertEqual(published.json()["visibility"], "family")
    self.authenticate_as(other_user.id, other_membership.id)
    self.assertEqual(
        self.client.patch(f"/api/ai/conversations/{conversation.id}/visibility", json={"visibility": "private"}).status_code,
        404,
    )
    self.assertEqual(self.client.delete(f"/api/ai/conversations/{conversation.id}").status_code, 404)
```

Add a second test with an `AIAgentRun(status="running")` attached to the conversation and assert both visibility PATCH and DELETE return 409.

- [ ] **Step 2: Run tests and verify the endpoint/guards are missing**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q`

Expected: FAIL with 405 for PATCH and incorrect delete authorization.

- [ ] **Step 3: Add the request schema and visibility endpoint**

```python
class AIConversationVisibilityRequest(BaseModel):
    visibility: AIConversationVisibility
```

```python
@router.patch("/api/ai/conversations/{conversation_id}/visibility", response_model=AIConversationOut)
def update_ai_conversation_visibility(
    conversation_id: str,
    payload: AIConversationVisibilityRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    conversation = require_ai_conversation_access(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        conversation_id=conversation_id,
        capability="manage",
        for_update=True,
    )
    active = find_active_conversation_run(db, family_id=membership.family_id, conversation_id=conversation.id)
    if active is not None and active.status in {"pending", "running"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="会话正在生成回复，请先等待完成或取消当前任务")
    conversation.visibility = payload.visibility
    commit_session(db)
    return serialize_ai_conversation(
        conversation,
        owner_display_name=user.display_name,
        current_user_id=user.id,
    )
```

- [ ] **Step 4: Apply the same manage and active-run checks before deletion**

Replace the family-only conversation lookup at the beginning of `delete_ai_conversation` with the same manage helper. Reject only `pending`/`running`; preserve the existing cascade cleanup for waiting approvals, drafts, messages, checkpoints, and detached observability rows.

- [ ] **Step 5: Run the management test and related backend suite**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q
```

Expected: PASS; existing deletion cleanup tests remain green.

- [ ] **Step 6: Commit visibility management**

```bash
git add backend/app/schemas/ai.py backend/app/api/ai.py backend/tests/ai_infra/test_conversation_access.py
git commit -m "feat(ai): publish conversations to family"
```

### Task 4: Enforce Access Across Child Resources and Workflow Actions

**Files:**
- Modify: `backend/app/api/ai.py:354-1003`
- Modify: `backend/app/ai/workspace_service.py:62-505`
- Modify: `backend/app/ai/workflows/conversations.py:61-166`
- Modify: `backend/app/ai/workflows/run_lifecycle.py:34-145`
- Modify: `backend/app/ai/workflows/runner_support/user_message_preparer.py:60-145`
- Test: `backend/tests/ai_infra/test_conversation_access.py`
- Test: `backend/tests/ai_infra/test_workspace_approvals.py`
- Test: `backend/tests/ai_infra/test_foundation.py`

**Interfaces:**
- Consumes: view/contribute/manage helpers from Task 2.
- Produces: complete ID-based privacy for messages, runs, approvals, human input, retry, regenerate, quick actions, and streams.

- [ ] **Step 1: Write a parameterized private-child-resource regression test**

```python
def _seed_private_conversation_graph(self, *, owner_user_id: str) -> SimpleNamespace:
    with self.SessionLocal() as db:
        conversation = self._conversation(
            "conversation-private-graph",
            owner_user_id,
            AIConversationVisibility.PRIVATE,
            datetime(2026, 7, 11, 12, 0, 0),
        )
        run = AIAgentRun(
            id="run-private-graph",
            family_id=self.family.id,
            conversation_id=conversation.id,
            message_id="message-private-graph",
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="general_chat",
            input_summary="私有问题",
            context_summary={},
            output_summary="",
            status="running",
            model="fake-model",
            input={"prompt": "私有问题"},
            output={},
            tool_calls=[],
            created_by=owner_user_id,
        )
        message = AIMessage(
            id="message-private-graph",
            family_id=self.family.id,
            conversation_id=conversation.id,
            role="assistant",
            content="私有回复",
            content_type="parts",
            parts=[{"id": "part-private-graph", "type": "text", "text": "私有回复"}],
            run_id=run.id,
            status="running",
            created_by=owner_user_id,
        )
        draft = AITaskDraft(
            id="draft-private-graph",
            family_id=self.family.id,
            conversation_id=conversation.id,
            source_run_id=run.id,
            message_id=message.id,
            draft_type="recipe",
            payload={},
            preview_summary="私有草稿",
            status="pending",
            version=1,
            schema_version="recipe.v1",
            validation_errors=[],
            ai_metadata={},
            idempotency_key="draft-private-graph",
            created_by=owner_user_id,
        )
        approval = AIApprovalRequest(
            id="approval-private-graph",
            family_id=self.family.id,
            conversation_id=conversation.id,
            message_id=message.id,
            run_id=run.id,
            draft_id=draft.id,
            draft_version=1,
            draft_schema_version="recipe.v1",
            approval_type="recipe.create",
            status="pending",
            request_payload={},
            field_schema=[],
            initial_values={},
            submitted_values={},
            created_by=owner_user_id,
        )
        db.add_all([conversation, run, message, draft, approval])
        db.commit()
        return SimpleNamespace(
            conversation_id=conversation.id,
            run_id=run.id,
            message_id=message.id,
            part_id="part-private-graph",
            approval_id=approval.id,
        )

def test_private_child_resource_endpoints_return_not_found_to_other_member(self) -> None:
    other_user, other_membership = self.create_family_member()
    seeded = self._seed_private_conversation_graph(owner_user_id=self.user.id)
    self.authenticate_as(other_user.id, other_membership.id)
    requests = [
        ("GET", f"/api/ai/conversations/{seeded.conversation_id}/messages", None),
        ("GET", f"/api/ai/conversations/{seeded.conversation_id}/approvals/pending", None),
        ("GET", f"/api/ai/runs/{seeded.run_id}/events", None),
        ("POST", f"/api/ai/runs/{seeded.run_id}/cancel", None),
        ("POST", f"/api/ai/runs/{seeded.run_id}/retry", None),
        ("POST", f"/api/ai/messages/{seeded.message_id}/parts/{seeded.part_id}/regenerate", None),
    ]
    for method, path, payload in requests:
        response = self.client.request(method, path, json=payload)
        self.assertEqual(response.status_code, 404, f"{method} {path}: {response.text}")

def test_published_conversation_accepts_family_member_contribution(self) -> None:
    other_user, other_membership = self.create_family_member()
    seeded = self._seed_private_conversation_graph(owner_user_id=self.user.id)
    with self.SessionLocal() as db:
        conversation = db.get(AIConversation, seeded.conversation_id)
        assert conversation is not None
        conversation.visibility = AIConversationVisibility.FAMILY
        db.commit()
    self.authenticate_as(other_user.id, other_membership.id)
    messages = self.client.get(f"/api/ai/conversations/{seeded.conversation_id}/messages")
    self.assertEqual(messages.status_code, 200, messages.text)
    approvals = self.client.get(f"/api/ai/conversations/{seeded.conversation_id}/approvals/pending")
    self.assertEqual(approvals.status_code, 200, approvals.text)
```

In `test_ai_workspace_recipe_draft_approval_creates_recipe_after_decision` and `test_workspace_orchestrator_human_input_interrupt_resumes_same_run`, publish the created conversation, then switch authentication before the existing resume request:

```python
other_user, other_membership = self.create_family_member()
with self.SessionLocal() as db:
    conversation = db.get(AIConversation, data["conversation_id"])
    assert conversation is not None
    conversation.visibility = AIConversationVisibility.FAMILY
    db.commit()
self.authenticate_as(other_user.id, other_membership.id)
```

Keep each test's existing valid decision/response payload. After completion, reload the approval or resumed user message and assert its actor field equals `other_user.id`.

- [ ] **Step 2: Run the private-resource tests and observe family-only authorization failures**

Run: `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q`

Expected: FAIL because current endpoints accept same-family IDs.

- [ ] **Step 3: Pass `user_id` through every service boundary**

Use these exact signatures:

```python
def pending_approvals(self, *, family_id: str, user_id: str, conversation_id: str) -> list[dict[str, Any]]:
def find_idempotent_run(self, *, family_id: str, user_id: str, client_message_id: str | None, client_run_id: str | None) -> AIAgentRun | None:
def _require_conversation(self, *, family_id: str, user_id: str, conversation_id: str, capability: ConversationCapability = "view") -> AIConversation:
```

Before delegating, enforce `contribute` in `record_recommendation_selection`, `create_inventory_quick_draft`, `cancel_run`, `retry_run`, `regenerate_part`, `decide_approval`, `stream_approval_decision`, `respond_human_input`, and `stream_human_input_response`. Continue to record the authenticated collaborator as `created_by`/`updated_by`; do not substitute `owner_user_id`.

- [ ] **Step 4: Guard direct route queries**

Apply `view` to message listing and run-event reads; apply `contribute` to chat continuation, quick actions, cancellation, retry, regeneration, approvals, and human input. In SSE generators, catch `LookupError` and emit the existing error event with status 404.

Pass the current `user_id` from `user_message_preparer.py` into both idempotent lookup calls. In `find_idempotent_run`, after resolving a candidate with a persistent `conversation_id`, call:

```python
require_ai_conversation_access(
    db,
    family_id=family_id,
    user_id=user_id,
    conversation_id=run.conversation_id,
    capability="contribute",
)
```

Keep `conversation_id=None` behavior unchanged for non-persistent cooking and standalone runs.

- [ ] **Step 5: Verify collaboration and private denial**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_chat.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_approvals.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_phase_flows.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_cooking_assistant_skill.py -q
```

Expected: PASS; cooking tests still confirm transient history deletion.

- [ ] **Step 6: Commit end-to-end authorization**

```bash
git add backend/app/api/ai.py backend/app/ai/workspace_service.py backend/app/ai/workflows/conversations.py backend/app/ai/workflows/run_lifecycle.py backend/app/ai/workflows/runner_support/user_message_preparer.py backend/tests/ai_infra/test_conversation_access.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_foundation.py
git commit -m "fix(ai): protect conversation child resources"
```

### Task 5: Scope Diagnostics and Quality Metrics to Accessible Runs

**Files:**
- Modify: `backend/app/services/ai_quality.py:68-330`
- Modify: `backend/app/api/ai.py:270-279,639-746`
- Modify: `backend/tests/ai_infra/_support.py:1236-1475`
- Test: `backend/tests/ai_infra/test_ai_observability.py`
- Test: `backend/tests/ai_infra/test_registry_and_metrics.py`

**Interfaces:**
- Consumes: accessible conversation policy and `require_ai_run_access`.
- Produces: user-aware quality aggregation and Owner-role diagnostics that cannot cross private conversation boundaries.

- [ ] **Step 1: Add failing privacy tests for diagnostics and metrics**

```python
def _seed_visibility_run(
    self,
    run_id: str,
    *,
    owner_user_id: str,
    visibility: AIConversationVisibility,
) -> AIAgentRun:
    with self.SessionLocal() as db:
        if db.get(User, owner_user_id) is None:
            db.add_all([
                User(id=owner_user_id, username=owner_user_id, display_name="另一位成员", avatar_seed="", is_active=True),
                Membership(
                    id=f"membership-{owner_user_id}",
                    family_id=self.family.id,
                    user_id=owner_user_id,
                    role=UserRole.MEMBER,
                    status=MembershipStatus.ACTIVE,
                ),
            ])
            db.flush()
        conversation = AIConversation(
            id=f"conversation-{run_id}",
            family_id=self.family.id,
            owner_user_id=owner_user_id,
            visibility=visibility,
            mode=AiMode.RECOMMENDATION,
            prompt=run_id,
            response="",
            context={"workspace": True},
            title=run_id,
            summary="",
            status="active",
            created_by=owner_user_id,
        )
        run = AIAgentRun(
            id=run_id,
            family_id=self.family.id,
            conversation_id=conversation.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="general_chat",
            input_summary=run_id,
            context_summary={"runMetrics": {}},
            output_summary="",
            status="completed",
            model="fake-model",
            input={},
            output={},
            tool_calls=[],
            created_by=owner_user_id,
        )
        db.add_all([conversation, run])
        db.commit()
        db.refresh(run)
        return run

def test_family_owner_cannot_open_another_members_private_trace(self) -> None:
    private_run = self._seed_visibility_run(
        "other-private-trace",
        owner_user_id="user-ai-two",
        visibility=AIConversationVisibility.PRIVATE,
    )
    response = self.client.get(f"/api/ai/runs/{private_run.id}/trace")
    self.assertEqual(response.status_code, 404, response.text)

def test_quality_metrics_exclude_other_members_private_runs(self) -> None:
    self._seed_visibility_run("mine", owner_user_id=self.user.id, visibility=AIConversationVisibility.PRIVATE)
    self._seed_visibility_run("other-private", owner_user_id="user-ai-two", visibility=AIConversationVisibility.PRIVATE)
    self._seed_visibility_run("other-public", owner_user_id="user-ai-two", visibility=AIConversationVisibility.FAMILY)
    response = self.client.get("/api/ai/quality-metrics?limit=50")
    self.assertEqual(response.status_code, 200, response.text)
    self.assertEqual({item["id"] for item in response.json()["recent_runs"]}, {"mine", "other-public"})
```

Place `_seed_visibility_run` on `AIAgentInfraTestCase` in `_support.py`, then place the trace test in `test_ai_observability.py` and the metrics test in `test_registry_and_metrics.py`.

- [ ] **Step 2: Run the tests and verify family-wide leakage**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_registry_and_metrics.py -q
```

Expected: FAIL because trace and metrics currently filter only by `family_id`.

- [ ] **Step 3: Add an authorized-run predicate and user-aware metrics signature**

```python
def accessible_ai_run_clause(user_id: str):
    return or_(
        AIAgentRun.conversation_id.is_(None),
        and_(
            AIConversation.owner_user_id.is_not(None),
            or_(
                AIConversation.owner_user_id == user_id,
                AIConversation.visibility == AIConversationVisibility.FAMILY,
            ),
        ),
    )


def build_ai_quality_metrics(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    limit: int = 50,
    days: int | None = None,
) -> dict[str, Any]:
```

Build the recent-run query with an outer join from `AIAgentRun.conversation_id` to `AIConversation.id`, apply `accessible_ai_run_clause(user_id)`, and use the resulting authorized IDs for totals, approvals, spans, exchanges, and recent runs.

- [ ] **Step 4: Scope rolling token usage with the same access rule**

Change `_build_token_usage_metrics` to accept `user_id`. For each rolling window, join `AIRunLLMExchange.run_id` to `AIAgentRun.id`, outer join the conversation, and apply family, time, and `accessible_ai_run_clause(user_id)`. This preserves unscoped cooking/standalone metrics but excludes other members' private main-AI exchanges.

- [ ] **Step 5: Add conversation access to trace and exchange endpoints**

After the existing `require_owner` dependency, resolve the run through:

```python
run = require_ai_run_access(
    db,
    family_id=membership.family_id,
    user_id=user.id,
    run_id=run_id,
    capability="view",
)
```

Use this in trace, trace tree, exchange list, and exchange detail; the detail endpoint must resolve the run before selecting the exchange. Pass `user.id` into `build_ai_quality_metrics`.

- [ ] **Step 6: Run diagnostics tests and commit**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_registry_and_metrics.py -q
```

Expected: PASS with private runs absent and published/unscoped runs retained.

```bash
git add backend/app/services/ai_quality.py backend/app/api/ai.py backend/tests/ai_infra/_support.py backend/tests/ai_infra/test_ai_observability.py backend/tests/ai_infra/test_registry_and_metrics.py
git commit -m "fix(ai): scope diagnostics to visible conversations"
```

### Task 6: Add the Frontend Visibility Contract and History Controls

**Files:**
- Modify: `frontend/src/api/types.ts:663-680`
- Modify: `frontend/src/api/aiApi.ts:150-180`
- Modify: `frontend/src/api/aiApi.test.ts`
- Modify: `frontend/src/components/ai/aiWorkspaceTestFixtures.ts:100-130`
- Modify: `frontend/src/components/ai/AiConversationHistory.tsx`
- Modify: `frontend/src/components/ai/AiMobileChrome.tsx`
- Modify: `frontend/src/components/ai/AiMobilePage.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/styles/09-ai-workspace.css`
- Test: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Test: `frontend/src/components/ai/AiMobilePage.test.tsx`
- Test fixtures: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Test fixtures: `frontend/src/components/ai/AiDeleteConversationDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 PATCH endpoint and owner-aware DTO.
- Produces: `AiConversationVisibility`, `api.updateAiConversationVisibility`, owner-only desktop/mobile management controls.

- [ ] **Step 1: Write failing API and history rendering tests**

```ts
it('patches AI conversation visibility', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    id: 'conversation-1',
    owner_user_id: 'user-1',
    owner_display_name: '小林',
    visibility: 'family',
    is_owner: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await aiApi.updateAiConversationVisibility('conversation-1', 'family');
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining('/api/ai/conversations/conversation-1/visibility'),
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ visibility: 'family' }) }),
  );
});
```

```ts
it('shows owner controls only on owned conversations', async () => {
  const owned = conversation({ visibility: 'private', is_owner: true });
  const shared = conversation({ id: 'conversation-shared', visibility: 'family', is_owner: false, owner_display_name: '家人' });
  const rendered = await renderWithQuery(<AiWorkspace conversations={[owned, shared]} isLoading={false} />);
  expect(rendered.container.textContent).toContain('家庭公开');
  expect(rendered.container.textContent).toContain('家人');
  expect(rendered.container.querySelectorAll('[aria-label^="管理会话"]')).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests and verify missing types/API/UI**

Run: `npm --prefix frontend run test -- src/api/aiApi.test.ts src/components/ai/AiWorkspace.test.tsx`

Expected: FAIL because the fields, API method, and controls do not exist.

- [ ] **Step 3: Add the type and API method**

```ts
export type AiConversationVisibility = 'private' | 'family';

export interface AiConversation {
  id: string;
  family_id: string;
  owner_user_id: string;
  owner_display_name: string;
  visibility: AiConversationVisibility;
  is_owner: boolean;
  mode: AiMode;
  prompt: string;
  response: string;
  created_at: string;
  created_by?: string | null;
  context: Record<string, unknown>;
  title: string;
  summary: string;
  status: string;
  last_message_at?: string | null;
  last_run_status: string;
}
```

```ts
updateAiConversationVisibility: (conversationId: string, visibility: AiConversationVisibility) =>
  request<AiConversation>(`/api/ai/conversations/${conversationId}/visibility`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility }),
  }),
```

Update `conversation(overrides: Partial<AiConversation> = {})` so all existing tests receive owner defaults and can override them.

Update any inline `AiConversation` object in `AiWorkspaceLiveSync.test.tsx` and `AiDeleteConversationDialog.test.tsx` with the same four required fields. Prefer `conversation({ id: 'custom-conversation' })` where the test does not need a completely custom object.

- [ ] **Step 4: Add shared metadata and owner-only actions to desktop and mobile history**

Render this metadata inside each item:

```tsx
{conversation.visibility === 'family' && (
  <span className="ai-history-sharing-meta">
    <span className="ai-history-shared-badge">家庭公开</span>
    <span className="ai-history-owner-name">{conversation.owner_display_name}</span>
  </span>
)}
```

Expose sibling action buttons rather than nesting buttons. Share this component between desktop and mobile:

```tsx
export function AiConversationActions(props: {
  conversation: AiConversation;
  isUpdating: boolean;
  onChangeVisibility: (conversation: AiConversation, visibility: AiConversationVisibility) => void;
  onDelete: (conversation: AiConversation) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!props.conversation.is_owner) return null;
  const nextVisibility = props.conversation.visibility === 'family' ? 'private' : 'family';
  return (
    <div className="ai-conversation-actions">
      <button
        type="button"
        aria-label={`管理会话：${props.conversation.title || 'AI 会话'}`}
        aria-expanded={open}
        disabled={props.isUpdating}
        onClick={() => setOpen((value) => !value)}
      >
        ···
      </button>
      {open && (
        <div className="ai-conversation-action-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => props.onChangeVisibility(props.conversation, nextVisibility)}>
            {nextVisibility === 'family' ? '公开给家庭' : '取消公开'}
          </button>
          <button type="button" role="menuitem" onClick={() => props.onDelete(props.conversation)}>删除</button>
        </div>
      )}
    </div>
  );
}
```

Add props for `onChangeVisibility`, `onDeleteConversation`, and the updating ID to desktop and mobile history. Close the menu after either action and on conversation selection.

- [ ] **Step 5: Wire mutations and conflict feedback in AiWorkspace**

```ts
const visibilityMutation = useMutation({
  mutationFn: ({ conversationId, visibility }: { conversationId: string; visibility: AiConversationVisibility }) =>
    api.updateAiConversationVisibility(conversationId, visibility),
  onSuccess: (updated) => {
    queryClient.setQueryData<AiConversation[]>(queryKeys.aiConversations, (items = []) =>
      items.map((item) => item.id === updated.id ? updated : item));
  },
  onError: (error) => {
    setPlanFeedback(isApiError(error) && error.status === 409
      ? '会话正在生成回复，请先等待完成或取消当前任务'
      : error instanceof Error ? error.message : '更新公开状态失败');
  },
});
```

Move the existing delete confirmation dialog outside the desktop-only container so mobile can invoke the same owner-only confirmation flow.

- [ ] **Step 6: Add scoped styles and run focused tests**

Add `.ai-history-sharing-meta`, `.ai-history-shared-badge`, `.ai-history-owner-name`, `.ai-conversation-actions`, and equivalent mobile layout rules under the existing `ai-` namespace. Preserve current dimensions and warm palette; do not redesign the history rail.

Run:

```bash
npm --prefix frontend run test -- src/api/aiApi.test.ts src/components/ai/AiWorkspace.test.tsx src/components/ai/AiMobilePage.test.tsx
npm --prefix frontend run build
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 7: Commit the publication UI**

```bash
git add frontend/src/api/types.ts frontend/src/api/aiApi.ts frontend/src/api/aiApi.test.ts frontend/src/components/ai/aiWorkspaceTestFixtures.ts frontend/src/components/ai/AiConversationHistory.tsx frontend/src/components/ai/AiMobileChrome.tsx frontend/src/components/ai/AiMobilePage.tsx frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspace.test.tsx frontend/src/components/ai/AiMobilePage.test.tsx frontend/src/styles/09-ai-workspace.css
git commit -m "feat(ai): manage shared conversation visibility"
```

### Task 7: Scope Drafts and Attachments by Conversation

**Files:**
- Create: `frontend/src/components/ai/useAiConversationComposerState.ts`
- Create: `frontend/src/components/ai/useAiConversationComposerState.test.tsx`
- Modify: `frontend/src/components/ai/useAiAttachmentState.ts`
- Create: `frontend/src/components/ai/useAiAttachmentState.test.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx:162-270,1004-1132`
- Test: `frontend/src/components/ai/AiWorkspaceAttachments.test.tsx`

**Interfaces:**
- Consumes: conversation keys and pending keys from `AiConversationHistory.tsx`.
- Produces: `draft`, `setDraft`, `moveScope`, `clearScope` and a scoped attachment API with identical visible attachment operations.

- [ ] **Step 1: Write failing hook tests for draft and attachment isolation**

```ts
it('keeps drafts isolated and remaps only the requested conversation', async () => {
  let state: ReturnType<typeof useAiConversationComposerState> | null = null;
  function Harness() {
    state = useAiConversationComposerState('conversation-a');
    return <span data-testid="draft">{state.draft}</span>;
  }
  const rendered = await renderWithQuery(<Harness />);
  act(() => state?.setDraft('A 的草稿'));
  act(() => state?.selectScope('conversation-b'));
  expect(rendered.container.textContent).toBe('');
  act(() => state?.setDraft('B 的草稿'));
  act(() => state?.moveScope('conversation-a', 'conversation-server-a'));
  act(() => state?.selectScope('conversation-server-a'));
  expect(rendered.container.textContent).toBe('A 的草稿');
  rendered.unmount();
});
```

For attachments, upload one file in scope A, switch to B, assert B is empty, move A to a server ID, and assert the ready asset and preview URL move only to that ID.

- [ ] **Step 2: Run hook tests and verify no scoped APIs exist**

Run: `npm --prefix frontend run test -- src/components/ai/useAiConversationComposerState.test.tsx src/components/ai/useAiAttachmentState.test.tsx`

Expected: FAIL because both scoped hooks are missing.

- [ ] **Step 3: Implement conversation-keyed draft state**

```ts
export const NEW_AI_CONVERSATION_SCOPE = 'new-ai-conversation';

export function useAiConversationComposerState(initialScope: string) {
  const [scope, selectScope] = useState(initialScope);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[scope] ?? '';
  const setDraft = useCallback((value: string) => {
    setDrafts((current) => ({ ...current, [scope]: value }));
  }, [scope]);
  const moveScope = useCallback((from: string, to: string) => {
    setDrafts((current) => {
      if (!(from in current) || from === to) return current;
      const next = { ...current, [to]: current[from] };
      delete next[from];
      return next;
    });
    setScope((current) => current === from ? to : current);
  }, []);
  const clearScope = useCallback((key: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  return { scope, draft, setDraft, selectScope, moveScope, clearScope };
}
```

- [ ] **Step 4: Refactor attachment state to records keyed by scope**

Change `useAiAttachmentState(scopeKey)` to store `attachmentsByScope` and `hiddenAttachmentsByScope` records. Every upload callback captures the initiating `scopeKey`; `removeAttachment`, `hideAttachments`, restore, and discard operate only on that scope. Add `moveScope(from,to)` and `clearScope(key)` that also revoke superseded blob URLs exactly once.

Return the current scope's existing interface so `AiComposerAttachments` requires no changes:

```ts
return {
  attachments,
  readyAttachments: attachments.filter((item) => item.status === 'ready' && item.asset),
  hasUploadingAttachment: attachments.some((item) => item.status === 'uploading'),
  hasFailedAttachment: attachments.some((item) => item.status === 'failed'),
  canAddMore: attachments.length < MAX_ATTACHMENTS,
  uploadFiles,
  removeAttachment,
  clearAttachments,
  hideAttachments,
  restoreHiddenAttachments,
  discardHiddenAttachments,
  moveScope,
  clearScope,
};
```

- [ ] **Step 5: Integrate scope transitions in AiWorkspace**

Use `activeConversationKey ?? NEW_AI_CONVERSATION_SCOPE` as the selected scope. On send of a new conversation, move the new scope to its pending key before hiding attachments. When `applyChatResponse` maps a pending key to the server ID, move draft and attachment scopes with the existing local-message/run remap. Selecting history changes scope; starting a new conversation selects the new scope without clearing other drafts.

- [ ] **Step 6: Run hook and attachment integration tests**

Run:

```bash
npm --prefix frontend run test -- src/components/ai/useAiConversationComposerState.test.tsx src/components/ai/useAiAttachmentState.test.tsx src/components/ai/AiWorkspaceAttachments.test.tsx
```

Expected: PASS, including existing hide-after-send and blob URL cleanup assertions.

- [ ] **Step 7: Commit scoped composer state**

```bash
git add frontend/src/components/ai/useAiConversationComposerState.ts frontend/src/components/ai/useAiConversationComposerState.test.tsx frontend/src/components/ai/useAiAttachmentState.ts frontend/src/components/ai/useAiAttachmentState.test.tsx frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspaceAttachments.test.tsx
git commit -m "refactor(ai): scope composer state by conversation"
```

### Task 8: Run Different Conversation Streams Concurrently

**Files:**
- Create: `frontend/src/components/ai/useAiConversationStreams.ts`
- Delete: `frontend/src/components/ai/useAiStreamMutations.ts`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx:850-1160`
- Test: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Test: `frontend/src/components/ai/AiWorkspace.test.tsx`

**Interfaces:**
- Consumes: active stream maps and scoped composer state from Task 7.
- Produces: `startChat`, `startApproval`, `startHumanInput`, per-conversation submission sets, and independent cancellation.

- [ ] **Step 1: Write a failing two-stream integration test**

```ts
async function sendInConversation(
  rendered: Awaited<ReturnType<typeof renderWithQuery>>,
  conversationId: string,
  message: string,
) {
  const historyButton = Array.from(
    rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-conversation-main'),
  ).find((button) => button.closest('.ai-conversation-item')?.getAttribute('data-conversation-id') === conversationId);
  await act(async () => historyButton?.click());
  const textarea = rendered.container.querySelector<HTMLTextAreaElement>('.ai-desktop-view textarea.text-input');
  if (!textarea) throw new Error(`missing composer for ${conversationId}`);
  changeInput(textarea, message);
  await act(async () => {
    rendered.container.querySelector<HTMLFormElement>('.ai-desktop-view form.ai-composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flushAsync();
}

function concurrentResponse(conversationId: string, text: string): AiChatResponse {
  return {
    conversation_id: conversationId,
    message: {
      id: `message-${conversationId}`,
      conversation_id: conversationId,
      role: 'assistant',
      content: text,
      content_type: 'parts',
      parts: [{ id: `part-${conversationId}`, type: 'text', text }],
      run_id: `run-${conversationId}`,
      status: 'completed',
      metadata: {},
      created_at: '2026-07-11T12:00:00Z',
    },
    run: {
      id: `run-${conversationId}`,
      agent_key: 'workspace_orchestrator',
      intent: 'general_chat',
      status: 'completed',
      model: 'fake-model',
      created_at: '2026-07-11T12:00:00Z',
    },
    events: [],
    included: { result_cards: [], drafts: [], approvals: [] },
  };
}

async function resolveConversationStream(
  pending: Map<string, (response: AiChatResponse) => void>,
  conversationId: string,
  text: string,
) {
  await act(async () => pending.get(conversationId)?.(concurrentResponse(conversationId, text)));
  await flushAsync();
}

it('sends and completes two different conversations concurrently', async () => {
  const pending = new Map<string, (response: AiChatResponse) => void>();
  vi.spyOn(api, 'streamChatAi').mockImplementation((payload) => new Promise((resolve) => {
    pending.set(payload.conversation_id as string, resolve);
  }));
  const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation({ id: 'conversation-a' }), conversation({ id: 'conversation-b' })]} isLoading={false} />);
  await sendInConversation(rendered, 'conversation-a', '问题 A');
  await sendInConversation(rendered, 'conversation-b', '问题 B');
  expect(api.streamChatAi).toHaveBeenCalledTimes(2);
  expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(2);
  await resolveConversationStream(pending, 'conversation-b', '回答 B');
  expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(1);
  await resolveConversationStream(pending, 'conversation-a', '回答 A');
  expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
});
```

Add `data-conversation-id={conversation.id}` to desktop and mobile history item wrappers as a stable test/accessibility-neutral identifier; do not derive test selection from translated title text.

Add a cancellation test that captures two `AbortSignal`s, cancels A, and asserts only A is aborted while B completes.

- [ ] **Step 2: Run concurrency tests and verify the global pause blocks B**

Run: `npm --prefix frontend run test -- src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiWorkspace.test.tsx`

Expected: FAIL because `isAnotherConversationRunning` pauses B and singleton mutation state tracks only one current variable.

- [ ] **Step 3: Replace mutation-observer state with an imperative stream coordinator**

Expose this interface from `useAiConversationStreams.ts`:

```ts
export type AiConversationStreams = {
  startChat: (payload: ChatStreamPayload) => Promise<AiChatResponse>;
  startApproval: (payload: ApprovalStreamPayload) => Promise<void>;
  startHumanInput: (payload: HumanInputStreamPayload) => Promise<AiChatResponse>;
  submittingApprovalIds: Set<string>;
  submittingHumanInputRequestIds: Set<string>;
};
```

Implement each starter with `useCallback` and direct API promises. Register its controller/run before awaiting, call the existing progress/delta/part callbacks with the payload's `conversationKey`, and remove only matching entries in `finally`. Store submitting IDs in sets so one approval or human-input submission does not disable another conversation.

The chat starter follows this exact lifecycle; approval and human-input starters use the same register/try/finally structure with their existing callbacks:

```ts
const startChat = useCallback(async (payload: ChatStreamPayload) => {
  const controller = new AbortController();
  context.chatAbortByRunIdRef.current[payload.client_run_id] = controller;
  context.setActiveStreamRunIdsByConversationKey((current) => ({
    ...current,
    [payload.conversationKey]: payload.client_run_id,
  }));
  context.startThinking(payload.client_run_id);
  const { conversationKey, ...requestPayload } = payload;
  try {
    const response = await api.streamChatAi(requestPayload, {
      signal: controller.signal,
      onProgress: (event) => {
        const nextEvent = buildStreamProgressEvent(event, payload.client_run_id, 'stream');
        context.ensureStreamingAssistantMessage(nextEvent.run_id, conversationKey);
        context.updateThinkingForProgressEvent(nextEvent, payload.client_run_id);
        context.upsertStreamProgressEvent(nextEvent);
      },
      onMessagePart: (event) => context.applyStreamPart(event, conversationKey),
      onMessageDelta: (event) => context.applyStreamDelta(event, conversationKey),
    });
    context.applyChatResponse(response, conversationKey, payload.client_run_id);
    return response;
  } finally {
    context.stopThinking(payload.client_run_id);
    delete context.chatAbortByRunIdRef.current[payload.client_run_id];
    context.setActiveStreamRunIdsByConversationKey((current) => {
      if (current[conversationKey] !== payload.client_run_id) return current;
      const next = { ...current };
      delete next[conversationKey];
      return next;
    });
    delete context.streamConversationTargetRef.current[conversationKey];
    delete context.streamConversationTargetRef.current[payload.client_run_id];
  }
}, [context]);
```

- [ ] **Step 4: Remove cross-conversation composer blocking**

Delete `isAnotherConversationRunning`, its pause message, and singleton `chatMutation.variables`/`isPending` derivations. Compute busy state only from the active conversation:

```ts
const isCurrentConversationBusy = Boolean(
  activeConversationKey
  && (
    activeStreamRunIdsByConversationKey[activeConversationKey]
    || isActiveConversationServerRunning
    || activeApprovalRunId
    || activeHumanInputRunId
  )
);
const effectiveComposerPaused = isComposerPaused;
const isAssistantBusy = isCurrentConversationBusy;
```

Keep the same-conversation send guard and use the new starter functions for chat, approval, and human input.

- [ ] **Step 5: Preserve independent pending-key remaps and progress**

In `applyChatResponse`, only remap entries whose conversation key or run ID matches that response. Do not reset `streamMessageTargetRef.current` globally when starting a new run; assign and delete only the new run's key. Keep `streamProgressByRunId` and local messages keyed per run/conversation.

- [ ] **Step 6: Run concurrency, cancellation, and full workspace tests**

Run:

```bash
npm --prefix frontend run test -- src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceAttachments.test.tsx
npm --prefix frontend run build
```

Expected: PASS; two running indicators coexist and cancelling A leaves B active.

- [ ] **Step 7: Commit concurrent streams**

```bash
git add frontend/src/components/ai/useAiConversationStreams.ts frontend/src/components/ai/useAiStreamMutations.ts frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx frontend/src/components/ai/AiWorkspace.test.tsx
git commit -m "feat(ai): run conversations concurrently"
```

### Task 9: Recover from Lost Publication Access and Verify End to End

**Files:**
- Modify: `frontend/src/api/aiApi.ts:45-130`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/ai/useAiConversationLiveSync.ts`
- Modify: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Modify: `docs/ai-assistant-standards.md`

**Interfaces:**
- Consumes: `ApiError`, accessible conversation polling, per-conversation clear/move operations.
- Produces: deterministic 404 cleanup, documented privacy/concurrency rules, and full verification evidence.

- [ ] **Step 1: Write the failing lost-access regression test**

```ts
it('clears only an unpublished shared conversation after a 404', async () => {
  const shared = conversation({ id: 'shared', visibility: 'family', is_owner: false, owner_display_name: '家人' });
  const mine = conversation({ id: 'mine', visibility: 'private', is_owner: true });
  vi.spyOn(api, 'getAiMessages').mockImplementation(async (conversationId) => {
    if (conversationId === 'shared') {
      throw new ApiError({ status: 404, detail: '会话不存在', path: `/api/ai/conversations/${conversationId}/messages`, payload: {} });
    }
    return [];
  });
  const rendered = await renderWithQuery(<AiWorkspace conversations={[shared, mine]} isLoading={false} />);
  await flushAsync();
  expect(rendered.container.textContent).toContain('该会话已取消公开');
  expect(rendered.container.querySelector('.ai-conversation-item.active')?.textContent).toContain('帮我生成菜谱');
  expect(rendered.queryClient.getQueryData(queryKeys.aiMessages('shared'))).toBeUndefined();
});
```

- [ ] **Step 2: Run the regression and verify 404 remains a generic message error**

Run: `npm --prefix frontend run test -- src/components/ai/AiWorkspaceLiveSync.test.tsx`

Expected: FAIL because the workspace currently leaves the inaccessible conversation selected.

- [ ] **Step 3: Preserve status codes from SSE error events**

In `streamAiResponse`, replace the generic error with:

```ts
const errorPayload = data && typeof data === 'object' ? data as { detail?: unknown; status?: unknown } : {};
throw new ApiError({
  status: Number(errorPayload.status) || 500,
  detail: typeof errorPayload.detail === 'string' ? errorPayload.detail : '流式请求失败',
  path: url,
  payload: data,
});
```

Import `ApiError` from `request.ts`; keep network/abort errors unchanged.

- [ ] **Step 4: Add targeted inaccessible-conversation cleanup**

Implement `clearInaccessibleConversation(conversationId)` in `AiWorkspace` to:

```ts
const inaccessibleRunId = activeStreamRunIdsByConversationKey[conversationId];
queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
setLocalMessagesByConversationKey((current) => {
  const next = { ...current };
  delete next[conversationId];
  return next;
});
composerState.clearScope(conversationId);
attachmentState.clearScope(conversationId);
setActiveStreamRunIdsByConversationKey((current) => {
  const next = { ...current };
  delete next[conversationId];
  return next;
});
if (inaccessibleRunId) {
  stopThinking(inaccessibleRunId);
  setStreamProgressByRunId((current) => {
    const next = { ...current };
    delete next[inaccessibleRunId];
    return next;
  });
  setRunEventsById((current) => {
    const next = { ...current };
    delete next[inaccessibleRunId];
    return next;
  });
  delete streamMessageTargetRef.current[inaccessibleRunId];
  delete chatAbortByRunIdRef.current[inaccessibleRunId];
}
const fallbackConversation = conversations.find((item) => item.id !== conversationId) ?? null;
setActiveConversationKey(fallbackConversation?.id ?? null);
setIsStartingNewConversation(fallbackConversation === null);
setPlanFeedback('该会话已取消公开');
```

Call it only for `isApiError(error) && error.status === 404` from message/approval queries and stream failures. If polling removes the active published conversation, perform one message refetch; clear only when that verification returns 404 so the 20-item list limit cannot evict a still-accessible active conversation.

- [ ] **Step 5: Document the stable contract**

Add a concise section to `docs/ai-assistant-standards.md` stating:

```markdown
### 主 AI 会话所有权与公开协作

- 主 AI 持久化会话默认归创建者私有；家庭 Owner 不自动获得查看权。
- 创建者可将会话公开给当前家庭。公开后家庭成员可继续对话和处理审批，但只有创建者可取消公开或删除。
- 所有消息、运行、审批和调试接口必须从子资源反查会话并执行相同权限校验。
- 同一会话只允许一个活动 run；不同会话允许并行，前端状态必须按 conversation/run 隔离。
- 做菜页继续使用 `persist_history=false`，不进入主 AI 历史与公开机制。
```

- [ ] **Step 6: Run the full verification matrix**

Run:

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_conversation_access.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_chat.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_approvals.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_cooking_assistant_skill.py -q
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
(cd backend && .venv/bin/alembic heads)
(cd backend && .venv/bin/alembic upgrade head)
git diff --check
```

Expected: all commands exit 0; Alembic reports `1d2e3f4a5b6c (head)`; cooking assistant history tests remain unchanged.

- [ ] **Step 7: Commit recovery and documentation**

```bash
git add frontend/src/api/aiApi.ts frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/useAiConversationLiveSync.ts frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx docs/ai-assistant-standards.md
git commit -m "fix(ai): recover from revoked conversation access"
```
