# AI Draft 撤销与低风险自动执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不向模型暴露正式 Write Tool 的前提下，为五类明确、低风险 Draft 增加服务端策略自动执行，并为已支持的 AI Operation 提供一小时、可审计、冲突安全的补偿式撤销。

**Architecture:** 模型只输出 Draft 与离散意图证据；Draft Tool 在领域归一化前分离 evidence，服务端用当前消息、canonical 值匹配和可信上下文验证后，由 `DraftRoutingCoordinator` 决定人工确认、自动执行或无需变更。人工与自动路径统一进入 `DraftCommitCoordinator`，领域执行返回带版本化撤销上下文的 `DraftExecutionReceipt`；撤销由 `AIRevertCoordinator` 分发到固定领域适配器。活动 chat 的自动结果继续走既有 SSE，人工审批与撤销通过普通 HTTP 响应更新发起端，所有结果统一持久化到消息、Artifact 和前端缓存范围。

**Tech Stack:** FastAPI、Pydantic v2、SQLAlchemy 2、Alembic/MySQL、pytest；React 18、TypeScript、React Query、Vitest、Playwright、Culina UI kit/CSS token。

## Global Constraints

- 模型仍只能调用 read/draft/control Tool；所有相关 Draft Tool 的 `requires_confirmation` 保持 `True`，不新增或暴露正式业务 Write Tool。
- 不使用连续 `confidence`；`intent_clarity` 只允许 `explicit_complete | explicit_context_resolved | explicit_incomplete | inferred`。
- 四档完整定义必须通过共享 JSON Schema description 和相关 Skill 指令对模型可见；枚举名本身不作为充分提示。
- `sourceQuotes.fields` 只是模型声明。自动执行还必须由服务端确定性解析并证明 quote/可信来源中的 canonical 值与规范化 payload 值一致；无法证明即人工确认。
- 自动执行动作只允许 `food.set_favorite`、`meal_log.rate_food`、`shopping_list.safe_write`、`meal_log.simple_create`、`meal_plan.simple_create`。
- `meal_log.simple_create` 和 `meal_plan.simple_create` 必须有当前消息明确要求新增的 `action` 证据；字段齐全的事实陈述或意向描述仍然人工确认。
- 五类动作默认关闭并要求当前成员 opt-in；`shopping_list.safe_write` 还要求当前 Owner 开启家庭策略；notice 版本固定从 `auto-execution-consent.v1` 开始。
- 购物新增/恢复最多 5 项、修改最多 1 项；评分最多 5 项；简单餐食最多 5 个 Food；简单计划最多 5 项。
- 每条用户消息最多尝试一个免确认 Draft；`no_change` 和执行失败同样占用名额；Composite 与 Continuation 始终人工确认。
- AI Operation 撤销窗口固定为提交成功后 1 小时，边界 `now <= revertible_until` 可撤销；普通页面领域撤销继续默认 15 分钟。
- 撤销只允许原执行人或当前家庭 Owner；撤销是不可重做的补偿操作，不改变真实 Approval/AIUserApproval 事实，不覆盖后续修改，不允许批量部分成功。
- 首批撤销适配器为 `food.favorite.v1`、`meal_log.rating.v1`、`shopping_list.safe_write.v1`、`meal_log.simple_create.v1`、`meal_plan.simple_create.v1`、`inventory.operation_ref.v1`。
- `inventory.operation_ref.v1` 只覆盖 AI 人工确认的库存入库、盘点、单独消耗和单独丢弃；做菜、硬删除、复杂媒体/参与人、Composite 整组和 Continuation 整链不实现撤销。
- 不实现 Shadow Mode、灰度、事件溯源框架、通用 JSON 回滚器、任务队列或新微服务；系统未上线，直接迁移到目标状态。
- 所有设置、Draft、Run、Approval、Operation、领域实体和撤销查询都以当前 membership 的 `family_id` 隔离；actor 固定为当前消息/Run 创建人，公开会话不继承会话 Owner 权限。
- 数据迁移基于当前 Alembic head `7b8c9d0e1f2a`（auth sessions），新 migration 使用 revision `7c8d9e0f1a2b`，必须支持 MySQL upgrade/downgrade 并保持单一 head。
- 前端只使用现有视觉 token、按钮、`StateBlock`、`StatusBadge` 和 overlay；不新增任意色值、阴影或圆角；switch 点击区至少 44px，使用 `role="switch"`、`aria-checked` 和关联说明。
- 人工视觉验收必须覆盖 `375×812`、`390×844`、`430×932`、`768×1024`、`1024×768`、`1440×900`。

---

## File Map

### Backend persistence and public contracts

- Create `backend/alembic/versions/7c8d9e0f1a2b_ai_draft_auto_execution_and_revert.py`: tables, columns, indexes, status/data backfill, MySQL-safe FK replacement and downgrade.
- Modify `backend/app/core/enums.py`: add `consume` and `dispose` to `InventoryOperationType`.
- Modify `backend/app/models/domain.py`: settings models, Draft/Run/Operation audit fields and `FoodPlanItem.row_version`.
- Create `backend/app/schemas/ai_auto_execution.py`: settings PUT/GET, operation projection and revert request/response DTOs.
- Modify `backend/app/schemas/ai.py`: new Draft statuses and strict operation-result card projection.
- Modify `backend/app/services/serializers.py`: Draft and Operation persistence serializers; never expose authorization snapshot, committed payload or revert context; every message response hydrates result cards with one fresh response-level `server_now`.

### Backend policy, routing and commit

- Create `backend/app/services/ai_auto_execution/catalog.py`: five immutable action definitions, limits, notice/catalog versions and labels.
- Create `backend/app/repos/ai_auto_execution.py`: family-scoped preference/policy loads, fixed-order locks and optimistic writes.
- Create `backend/app/services/ai_auto_execution/settings.py`: effective authorization and API mutation service.
- Create `backend/app/services/ai_auto_execution/intent_evidence.py`: quote normalization, trusted resolution validation and critical-field provenance.
- Create `backend/app/services/ai_auto_execution/policy_types.py`: cross-policy dataclasses and reason codes.
- Create `backend/app/services/ai_auto_execution/policy_registry.py`: global gates and per-action registration.
- Create `backend/app/services/ai_auto_execution/policies/food_favorite.py`.
- Create `backend/app/services/ai_auto_execution/policies/meal_rating.py`.
- Create `backend/app/services/ai_auto_execution/policies/shopping_safe_write.py`.
- Create `backend/app/services/ai_auto_execution/policies/simple_meal.py`.
- Create `backend/app/services/ai_auto_execution/policies/simple_plan.py`.
- Create `backend/app/services/ai_operations/commit_coordinator.py`: shared operation idempotency, domain execution, result persistence and failure handling.
- Create `backend/app/services/ai_operations/routing.py`: Draft persistence, preflight/final policy decision and manual/auto/no-change routing.
- Create `backend/app/services/ai_operations/result_projection.py`: safe `AIOperationResultProjection`, result card, Artifact and cache-scope builders.
- Modify `backend/app/services/ai_operations/registry_types.py`, `registry.py`, `registry_specs.py`, `executor.py` and all registered domain handlers: use `DraftExecutionReceipt`.
- Modify `backend/app/services/ai_operations/approval_decisions.py`: retain genuine decision recording and delegate committed writes to `DraftCommitCoordinator`.

### Backend Runtime and Skill contract

- Modify `backend/app/ai/tools/schemas.py` and the four selected Draft Tool handlers in `backend/app/ai/tools/catalog/`: shared bounded, model-described `INTENT_EVIDENCE_SCHEMA`; split evidence before existing domain normalizers.
- Modify `backend/app/ai/workflows/orchestrator/state.py` and `tools.py`: retain trusted call IDs/entity versions for read/UI/artifact references.
- Modify `backend/app/ai/workflows/orchestrator/draft_capture.py` and `backend/app/ai/errors.py`: carry raw evidence beside normalized business payload and use route-aware control flow rather than unconditional `ApprovalRequired`.
- Modify `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py`, `assistant_result_persister.py`, `orchestrator_next_state.py`, `message_parts.py` and `run_status.py`: create Approval only for `waiting_approval` and publish only the route-appropriate persistent result.
- Modify `backend/app/ai/workflows/run_lifecycle.py`, `backend/app/ai/workspace_service.py` and the existing retry endpoint: intercept a `pending_retry` Draft before prompt replay and directly recover the same Run/Draft.
- Modify `backend/app/ai/skills/loader.py`, `backend/app/ai/skills/base.py`, the four selected `skill.yaml` files and their `SKILL.md`: add `draft_then_policy` only when a server policy exists and require the model-visible evidence contract.

### Backend revert and domain ledgers

- Create `backend/app/services/ai_revert/__init__.py`, `types.py`, `registry.py`, `coordinator.py` and `errors.py`: fixed adapter protocol, family/permission/window/idempotency checks and stable errors.
- Create `backend/app/services/ai_revert/adapters/__init__.py`, `food_favorite.py`, `meal_rating.py`, `shopping_safe_write.py`, `simple_meal.py`, `simple_plan.py`, `inventory_operation_ref.py`.
- Create `backend/app/repos/ai_operations.py`: family-scoped operation locks and global revert request-ID lookup.
- Modify `backend/app/schemas/meal_recording.py`, `backend/app/services/meal_recording.py`, `backend/app/repos/meal_log_record_operations.py` and `backend/app/services/meal_log_record_history.py`: explicit deadline plus simple AI create ledger.
- Modify `backend/app/services/inventory_operation_history.py`, `backend/app/repos/inventory_operations.py`, `backend/app/services/inventory_operations.py`, `inventory_intake.py` and `inventory_reconciliation.py`: explicit deadline and consume/dispose snapshot ledgers.
- Create `backend/app/api/ai_auto_execution.py` and register it in `backend/app/api/router.py`: settings and `POST /api/ai/operations/{operation_id}/revert`.

### Frontend

- Modify `frontend/src/api/types.ts`, `frontend/src/api/aiApi.ts`, `frontend/src/api/queryKeys.ts`, `frontend/src/api/cacheInvalidation.ts`: exact cross-end contracts and scope-driven invalidation.
- Create `frontend/src/features/ai-auto-execution/aiAutoExecutionModel.ts`, `useAiAutoExecutionSettings.ts`, `AiAutoExecutionSwitchRow.tsx`, `AiAutoExecutionConsentDialog.tsx`, `AiAutoExecutionSettingsView.tsx`, `AiAutoExecutionDesktopPanel.tsx`, `AiAutoExecutionMobilePage.tsx` and focused tests.
- Create `frontend/src/features/ai-auto-execution/useAiOperationRevert.ts` and focused tests: idempotent online-only revert mutation and scope-driven cache invalidation.
- Modify `frontend/src/app/appNavigationModel.ts`, `useAppNavigationState.ts`, `frontend/src/App.tsx`, `frontend/src/features/family/FamilySettings.tsx`, `FamilyMobileView.tsx`: AI settings surface plus family shortcut.
- Modify `frontend/src/components/ai/AiWorkspace.tsx`, `AiMobilePage.tsx`, `AiMobileChrome.tsx`: title-bar settings entry and responsive settings surface.
- Modify `frontend/src/components/ai/AiResultCardModel.ts`, `AiResultCards.tsx`, `AiConversationThread.tsx`, live-sync hooks/tests: execution mode, deadline, direct revert, blocked/expired/reverted rendering and persisted replacement.
- Modify `frontend/src/styles/09-ai-workspace.css` and `frontend/src/styles/02-family-settings.css`: token-only desktop/mobile layouts.

### Documentation and verification

- Modify `docs/ai-assistant-standards.md`: replace the universal approval statement with the server commit gate and document policy/revert contracts.
- Modify `backend/tests/ai_evals/cases/core.jsonl`: explicit/inferred intent evidence scenarios while default authorization remains off.
- Modify `frontend/e2e/p0-critical-journeys.spec.mjs`: mobile/desktop settings and result-card smoke path.

## Stable Cross-Task Interfaces

The following names and field spellings are fixed for every task; do not introduce aliases with different semantics.

```python
# backend/app/services/ai_auto_execution/policy_types.py
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

IntentClarity = Literal[
    "explicit_complete",
    "explicit_context_resolved",
    "explicit_incomplete",
    "inferred",
]
PolicyRoute = Literal["auto_execute", "manual_confirmation", "no_change"]
DraftExecutionRoute = Literal["manual_confirmation", "policy_auto", "policy_no_change"]
DraftRouteStatus = Literal["waiting_approval", "auto_executed", "no_change", "execution_failed"]
ExecutionMode = Literal["manual_approval", "policy_auto", "policy_no_change"]
AuthorizationSource = Literal[
    "approval_request",
    "member_preference",
    "member_and_family_policy",
]
AICacheScope = Literal[
    "food",
    "meal_log",
    "meal_plan",
    "shopping_list",
    "inventory",
    "ai_conversation",
]
RevertAvailability = Literal["available", "expired", "unsupported", "blocked", "reverted"]

@dataclass(frozen=True, slots=True)
class TrustedResolutionSource:
    kind: Literal["current_ui_context", "tool_result", "conversation_artifact"]
    reference_id: str
    family_id: str
    entity_versions: dict[str, int | str | None]
    entity_values: dict[str, dict[str, Any]] = field(default_factory=dict)

@dataclass(frozen=True, slots=True)
class IntentEvidenceValidation:
    clarity: IntentClarity
    normalized_evidence: dict[str, Any]
    verified_fields: frozenset[str]
    verified_values: dict[str, Any]
    reason_codes: tuple[str, ...] = ()

@dataclass(frozen=True, slots=True)
class CriticalEvidenceRequirement:
    field: str
    expected_value: Any
    matcher_key: Literal[
        "explicit_action", "entity_id", "boolean_direction", "rating",
        "quantity", "unit", "date", "meal_type", "servings", "text",
    ]

@dataclass(frozen=True, slots=True)
class AuthorizationSnapshot:
    source: AuthorizationSource
    member_preference_version: int
    member_notice_version: str
    family_policy_version: int | None
    family_notice_version: str | None
    catalog_version: str
    policy_version: str

@dataclass(frozen=True, slots=True)
class AutoExecutionDecision:
    route: PolicyRoute
    policy_key: str | None
    policy_version: str | None
    reason_codes: tuple[str, ...]
    authorization_source: AuthorizationSource | None = None
    authorization_snapshot: dict[str, Any] = field(default_factory=dict)

@dataclass(frozen=True, slots=True)
class DraftExecutionReceipt:
    business_entity: dict[str, Any]
    entity_ids: tuple[str, ...]
    cache_scopes: tuple[AICacheScope, ...]
    revert_adapter_key: str | None = None
    revert_context: dict[str, Any] | None = None

@dataclass(frozen=True, slots=True)
class DraftCommitRequest:
    family_id: str
    actor_user_id: str
    conversation_id: str
    run_id: str | None
    draft_id: str
    draft_version: int
    committed_payload: dict[str, Any]
    execution_mode: Literal["manual_approval", "policy_auto"]
    authorization_source: AuthorizationSource
    authorization_snapshot: dict[str, Any]
    approval_request_id: str | None
    policy_key: str | None
    policy_version: str | None
    policy_reason_codes: tuple[str, ...]
    committed_at: datetime

@dataclass(frozen=True, slots=True)
class AIOperationResultProjection:
    draft_id: str
    operation_id: str | None
    result_status: Literal["completed", "no_change", "failed", "reverted"]
    execution_mode: ExecutionMode
    operation_status: Literal["pending", "completed", "failed", "reverted"] | None
    execution_explanation: str
    revert_availability: RevertAvailability
    revertible_until: datetime | None
    revert_blocked_code: str | None
    server_now: datetime
    entities: tuple[dict[str, Any], ...]
    cache_scopes: tuple[AICacheScope, ...]

@dataclass(frozen=True, slots=True)
class DraftCommitResult:
    operation_id: str
    receipt: DraftExecutionReceipt
    projection: AIOperationResultProjection
    result_part: dict[str, Any]
    artifacts: tuple[dict[str, Any], ...]

@dataclass(frozen=True, slots=True)
class DraftRouteOutcome:
    status: DraftRouteStatus
    draft_id: str
    approval_id: str | None
    operation_id: str | None
    published_part_ids: tuple[str, ...]
    projection: AIOperationResultProjection | None
```

```python
# backend/app/services/ai_revert/types.py
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from sqlalchemy.orm import Session
from app.core.enums import UserRole
from app.models.domain import AIOperation
from app.services.ai_auto_execution.policy_types import AICacheScope, AIOperationResultProjection

@dataclass(frozen=True, slots=True)
class AIRevertContext:
    db: Session
    operation: AIOperation
    family_id: str
    actor_user_id: str
    actor_role: UserRole
    now: datetime

@dataclass(frozen=True, slots=True)
class AIRevertResult:
    result_json: dict[str, Any]
    entities: tuple[dict[str, Any], ...]
    cache_scopes: tuple[AICacheScope, ...]

class AIRevertAdapter(Protocol):
    key: str
    schema_version: int

    def revert(self, context: AIRevertContext) -> AIRevertResult: ...

@dataclass(frozen=True, slots=True)
class AIRevertResponse:
    projection: AIOperationResultProjection
    result_card: dict[str, Any]
    cache_scopes: tuple[AICacheScope, ...]
    server_now: datetime
    replayed: bool
```

```typescript
// frontend/src/api/types.ts
export type AiAutoExecutionActionKey =
  | 'food.set_favorite'
  | 'meal_log.rate_food'
  | 'shopping_list.safe_write'
  | 'meal_log.simple_create'
  | 'meal_plan.simple_create';
export type AiCacheScope =
  | 'food' | 'meal_log' | 'meal_plan' | 'shopping_list' | 'inventory' | 'ai_conversation';
export type AiRevertAvailability = 'available' | 'expired' | 'unsupported' | 'blocked' | 'reverted';
export type AiOperationResultStatus = 'completed' | 'no_change' | 'failed' | 'reverted';
export type AiOperationExecutionMode = 'manual_approval' | 'policy_auto' | 'policy_no_change';

export interface AiOperationResultProjection {
  draft_id: string;
  operation_id: string | null;
  result_status: AiOperationResultStatus;
  execution_mode: AiOperationExecutionMode;
  operation_status: 'pending' | 'completed' | 'failed' | 'reverted' | null;
  execution_explanation: string;
  revert_availability: AiRevertAvailability;
  revertible_until: string | null;
  revert_blocked_code: string | null;
  server_now: string;
  entities: AiOperationResultEntity[];
  cache_scopes: AiCacheScope[];
}
```

---

### Task 1: Persistence model and complete Alembic migration

**Files:**
- Create: `backend/alembic/versions/7c8d9e0f1a2b_ai_draft_auto_execution_and_revert.py`
- Create: `backend/tests/ai_infra/test_ai_auto_execution_migration.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/models/domain.py`

**Interfaces:**
- Consumes: existing head `7b8c9d0e1f2a`, existing `AuditMixin`, `AIAgentRun`, `AITaskDraft`, `AIOperation`, `FoodPlanItem`, `InventoryOperationType`.
- Produces: ORM fields/tables named exactly as the confirmed spec; new migration head `7c8d9e0f1a2b`; new operation statuses `pending | completed | failed | reverted`.

- [ ] **Step 1: Write failing ORM and MySQL migration tests**

Add a model-shape test and a MySQL round-trip test. Seed legacy Draft/Operation rows at `7b8c9d0e1f2a`, upgrade, and assert exact mappings; then downgrade and upgrade again.

```python
def test_models_expose_auto_execution_and_revert_columns(self) -> None:
    self.assertIn("intent_clarity", AITaskDraft.__table__.c)
    self.assertIn("intent_evidence_json", AITaskDraft.__table__.c)
    self.assertIn("payload_hash", AITaskDraft.__table__.c)
    self.assertIn("auto_execution_attempted", AIAgentRun.__table__.c)
    self.assertTrue(AIOperation.__table__.c.approval_request_id.nullable)
    self.assertIn("revertible_until", AIOperation.__table__.c)
    self.assertIn("row_version", FoodPlanItem.__table__.c)
    self.assertIn("consume", {item.value for item in InventoryOperationType})
    self.assertIn("dispose", {item.value for item in InventoryOperationType})

def test_ai_auto_execution_migration_backfills_and_round_trips(mysql_alembic_database) -> None:
    db = mysql_alembic_database
    db.upgrade("7b8c9d0e1f2a")
    seed_legacy_ai_rows(db, draft_status="confirmed", operation_status="succeeded")
    db.upgrade("7c8d9e0f1a2b")
    assert db.rows("SELECT status, execution_route FROM ai_task_drafts") == [
        ("executed", "manual_confirmation")
    ]
    assert len(db.scalar("SELECT payload_hash FROM ai_task_drafts LIMIT 1")) == 64
    assert db.rows(
        "SELECT status, execution_mode, authorization_source FROM ai_operations"
    ) == [("completed", "manual_approval", "approval_request")]
    assert db.scalar("SELECT COUNT(*) FROM ai_auto_execution_preferences") == 0
    assert db.scalar("SELECT COUNT(*) FROM ai_family_auto_execution_policies") == 0
    db.downgrade("7b8c9d0e1f2a")
    db.upgrade("7c8d9e0f1a2b")
    assert db.current_revision() == "7c8d9e0f1a2b"
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_migration.py -q`

Expected: FAIL because the migration, models and enum values do not exist. If `CULINA_TEST_MYSQL_URL` is absent, the MySQL case may SKIP, but the ORM shape test must FAIL.

- [ ] **Step 3: Add models, enum values and the full migration**

Add `AIAutoExecutionPreference` and `AIFamilyAutoExecutionPolicy` as versioned audit models with these exact uniqueness rules:

```python
class AIAutoExecutionPreference(AuditMixin, Base):
    __tablename__ = "ai_auto_execution_preferences"
    __table_args__ = (
        UniqueConstraint("family_id", "user_id", "action_key", name="uq_ai_auto_execution_preference_actor_action"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai-auto-pref"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    action_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa.false(), nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    consent_notice_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    __mapper_args__ = {"version_id_col": row_version}

class AIFamilyAutoExecutionPolicy(AuditMixin, Base):
    __tablename__ = "ai_family_auto_execution_policies"
    __table_args__ = (
        UniqueConstraint("family_id", "action_key", name="uq_ai_family_auto_execution_policy_action"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("ai-family-policy"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    action_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa.false(), nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    consent_notice_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consented_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    __mapper_args__ = {"version_id_col": row_version}
```

Add every persistence field from spec sections 12 and 21. `AITaskDraft.payload_hash` stores SHA-256 of canonical normalized business payload JSON (`sort_keys=True`, compact separators, UTF-8, no `intentEvidence`) and is immutable for a Draft version; migration code backfills it for legacy Draft rows before making it non-null. `AIOperation.actor_user_id` and `run_id` remain nullable only for legacy rows; new coordinator writes reject missing actors. Replace the approval FK by inspecting the existing FK name and recreating named constraint `fk_ai_operations_approval_request_id_ai_approval_requests` with `SET NULL`.

The migration performs these exact data mappings before narrowing the target status semantics:

```python
op.execute("UPDATE ai_task_drafts SET status='executed' WHERE status='confirmed'")
op.execute("UPDATE ai_task_drafts SET status='execution_failed' WHERE status='confirmation_failed'")
op.execute("UPDATE ai_task_drafts SET status='pending_confirmation' WHERE status='pending'")
op.execute("UPDATE ai_task_drafts SET execution_route='manual_confirmation'")
op.execute("UPDATE ai_operations SET status='pending' WHERE status='running'")
op.execute("UPDATE ai_operations SET status='completed' WHERE status='succeeded'")
op.execute(
    "UPDATE ai_operations SET execution_mode='manual_approval', "
    "authorization_source='approval_request'"
)
```

Backfill `actor_user_id` in priority order from the latest matching `AIUserApproval.approved_by`, then approval `updated_by`, then Draft `created_by`; leave it null if none are trustworthy. Downgrade maps `pending_confirmation -> pending`, `executed | no_change | reverted -> confirmed`, `execution_failed -> confirmation_failed`, `expired -> rejected`, `pending -> running`, `completed | reverted -> succeeded`, then drops all new objects in reverse dependency order.

- [ ] **Step 4: Run focused model and migration verification**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_migration.py -q`

Expected: ORM test PASS; MySQL test PASS when configured, otherwise only that case SKIP.

Run: `cd backend && .venv/bin/alembic heads`

Expected: exactly `7c8d9e0f1a2b (head)`.

- [ ] **Step 5: Commit the persistence foundation**

```bash
git add backend/app/core/enums.py backend/app/models/domain.py backend/alembic/versions/7c8d9e0f1a2b_ai_draft_auto_execution_and_revert.py backend/tests/ai_infra/test_ai_auto_execution_migration.py
git commit -m "feat: add AI operation policy and revert persistence"
```

### Task 2: Action catalog, settings service and settings API

**Files:**
- Create: `backend/app/services/ai_auto_execution/__init__.py`
- Create: `backend/app/services/ai_auto_execution/catalog.py`
- Create: `backend/app/repos/ai_auto_execution.py`
- Create: `backend/app/services/ai_auto_execution/settings.py`
- Create: `backend/app/schemas/ai_auto_execution.py`
- Create: `backend/app/api/ai_auto_execution.py`
- Create: `backend/tests/ai_infra/test_ai_auto_execution_settings.py`
- Modify: `backend/app/api/router.py`

**Interfaces:**
- Consumes: Task 1 models, current `get_current_auth`, `require_owner`, `commit_session`.
- Produces: `AUTO_EXECUTION_CATALOG`, `get_auto_execution_settings`, `set_member_preference`, `set_family_policy`; the three settings routes from spec section 17.1.

- [ ] **Step 1: Write failing catalog/service/API tests**

Cover missing rows as disabled, all five catalog rows, current notice mismatch, Owner-only family mutation, 409 row-version conflict and no request-body family/user trust.

```python
class AIAutoExecutionSettingsTestCase(AIAgentInfraTestCase):
    def test_defaults_are_off_and_catalog_limits_are_server_owned(self) -> None:
        response = self.client.get("/api/ai/auto-execution/settings")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["catalog_version"], "auto-execution.v1")
        self.assertEqual({row["action_key"] for row in body["member_preferences"]}, {
            "food.set_favorite", "meal_log.rate_food", "shopping_list.safe_write",
            "meal_log.simple_create", "meal_plan.simple_create",
        })
        self.assertTrue(all(not row["effective_enabled"] for row in body["member_preferences"]))
        self.assertEqual(body["limits"]["shopping_list.safe_write"]["add_or_restore_items"], 5)

    def test_enable_requires_current_notice_and_expected_version(self) -> None:
        response = self.client.put(
            "/api/ai/auto-execution/preferences/food.set_favorite",
            json={"enabled": True, "expected_row_version": 0,
                  "consent_notice_version": "auto-execution-consent.v1"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        favorite = next(
            row for row in body["member_preferences"]
            if row["action_key"] == "food.set_favorite"
        )
        self.assertTrue(favorite["effective_enabled"])
        self.assertEqual(body["catalog_version"], "auto-execution.v1")
        stale = self.client.put(
            "/api/ai/auto-execution/preferences/food.set_favorite",
            json={"enabled": False, "expected_row_version": 0},
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["code"], "auto_execution_settings_stale")
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_settings.py -q`

Expected: FAIL with missing `app.services.ai_auto_execution` or 404 routes.

- [ ] **Step 3: Implement immutable catalog and versioned settings writes**

Use a frozen action definition; the database may only toggle catalog keys and cannot raise limits.

```python
CATALOG_VERSION = "auto-execution.v1"
CONSENT_NOTICE_VERSION = "auto-execution-consent.v1"

@dataclass(frozen=True, slots=True)
class AutoExecutionActionDefinition:
    key: str
    label: str
    description: str
    exclusions: str
    member_opt_in_required: bool
    family_policy_required: bool
    limits: dict[str, int]

AUTO_EXECUTION_CATALOG = {
    item.key: item for item in (
        AutoExecutionActionDefinition("food.set_favorite", "收藏状态", "收藏或取消收藏一个已有食物", "不修改食物资料或图片", True, False, {}),
        AutoExecutionActionDefinition("meal_log.rate_food", "餐食评分", "一次评分或取消评分最多 5 个食物项", "不修改餐食组成、参与人或图片", True, False, {"items": 5}),
        AutoExecutionActionDefinition("shopping_list.safe_write", "购物清单安全操作", "新增/恢复最多 5 项，修改最多 1 项", "不删除、不标记买到、不入库", True, True, {"add_or_restore_items": 5, "update_items": 1}),
        AutoExecutionActionDefinition("meal_log.simple_create", "简单餐食记录", "使用最多 5 个已有食物新增一餐", "不扣库存、不关联计划、不添加图片", True, False, {"foods": 5}),
        AutoExecutionActionDefinition("meal_plan.simple_create", "简单餐食计划", "使用最多 5 个已有食物新增计划", "不更新状态、不联动购物清单", True, False, {"items": 5}),
    )
}
```

`set_member_preference(...)` and `set_family_policy(...)` lock only their own setting rows. For a missing row, `expected_row_version` must be `0`; for an existing row it must equal `row_version`. Enabling requires the exact current notice version and updates consent fields; disabling takes effect immediately but retains the last consent audit fields. GET serializes missing rows with `row_version=0`, and computes `effective_enabled = enabled and consent_notice_version == CONSENT_NOTICE_VERSION`.

Compute `consent_notice.acknowledged` only for the current member: it is true when that member has any current-version preference consent, or when the current Owner is the `consented_by` actor on a current-version family policy. This aggregate field controls whether the notice is shown; it never authorizes an action. Authorization always uses each row's `effective_enabled`, and shopping additionally requires the effective family row.

The public functions use these exact signatures:

```python
def get_auto_execution_settings(
    db: Session, *, family_id: str, user_id: str, user_role: UserRole, now: datetime
) -> AutoExecutionSettingsOut: ...

def set_member_preference(
    db: Session, *, family_id: str, user_id: str, action_key: str,
    enabled: bool, expected_row_version: int, consent_notice_version: str | None,
    now: datetime,
) -> AutoExecutionSettingEntryOut: ...

def set_family_policy(
    db: Session, *, family_id: str, owner_user_id: str, action_key: str,
    enabled: bool, expected_row_version: int, consent_notice_version: str | None,
    now: datetime,
) -> AutoExecutionSettingEntryOut: ...
```

The service setters may return the changed `AutoExecutionSettingEntryOut` internally, but both successful PUT routes must call `get_auto_execution_settings(...)` after the write and return the complete `AutoExecutionSettingsOut` envelope, exactly like GET. This keeps `consent_notice.acknowledged`, both row collections, limits and `server_now` server-owned; the frontend never patches a single row into cached aggregate state.

Map unknown action keys to 404, non-Owner family writes to 403, stale versions and old notice versions to structured 409. Register `ai_auto_execution.router` after `ai_router` without changing existing paths.

- [ ] **Step 4: Run settings tests and API contract checks**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_settings.py -q`

Expected: PASS, including Member read-only family policy projection and Owner mutation.

- [ ] **Step 5: Commit settings contracts**

```bash
git add backend/app/services/ai_auto_execution backend/app/repos/ai_auto_execution.py backend/app/schemas/ai_auto_execution.py backend/app/api/ai_auto_execution.py backend/app/api/router.py backend/tests/ai_infra/test_ai_auto_execution_settings.py
git commit -m "feat: add AI auto execution settings"
```

### Task 3: Intent Evidence schema and trusted resolution capture

**Files:**
- Create: `backend/app/services/ai_auto_execution/intent_evidence.py`
- Create: `backend/tests/ai_infra/test_ai_intent_evidence.py`
- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/ai/tools/catalog/food.py`
- Modify: `backend/app/ai/tools/catalog/meal_log.py`
- Modify: `backend/app/ai/tools/catalog/meal_plan.py`
- Modify: `backend/app/ai/tools/catalog/shopping.py`
- Modify: `backend/app/ai/workflows/orchestrator/state.py`
- Modify: `backend/app/ai/workflows/orchestrator/tools.py`
- Modify: `backend/app/ai/workflows/orchestrator/draft_capture.py`
- Modify: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/test_tool_registry.py`

**Interfaces:**
- Consumes: raw Draft Tool input, separately normalized business Draft, current user message, normalized `subject`, `tool_call_id`, read/tool outputs and current run Artifacts.
- Produces: model-visible `INTENT_CLARITY_MODEL_DESCRIPTION`, `INTENT_EVIDENCE_SCHEMA`, `TrustedResolutionSource`, `CriticalEvidenceRequirement`, `IntentEvidenceValidation`, `validate_intent_evidence(...)`; the persisted validation record distinguishes model claims from server-verified fields/values.

- [ ] **Step 1: Write failing schema and validator tests**

Test all four clarity levels, NFC/whitespace quote match, quote mismatch, untrusted call ID, cross-family entity, stale version, array/text bounds, defaulted critical fields and evidence omission falling back to manual eligibility. Add canonical mismatch cases including message “打 4 分” with normalized `rating=5`, “买 1 盒” with `quantity=10`, opposite favorite direction, wrong date/meal type, a trusted entity ID that differs from the payload target, and an Artifact whose allowlisted quantity/unit facts differ from the Draft; all must remain manual-only. Include a complete simple-meal/simple-plan payload whose current message only states what was eaten or may be eaten: without a verified semantic `action` field, validation remains manual-only.

Add one Tool-to-Draft integration test per selected Draft Tool. Pass `intentEvidence` inside the raw Tool input, let the real handler normalizer rebuild its business Draft, then assert capture/routing receives the unchanged evidence separately, persists a server-owned validation record on `AITaskDraft.intent_evidence_json`, and never inserts `intentEvidence` into the committed domain payload.

```python
def test_explicit_context_resolution_requires_trusted_call_and_version() -> None:
    validation = validate_intent_evidence(
        evidence={
            "intentClarity": "explicit_context_resolved",
            "sourceQuotes": [{"fields": ["action"], "text": "收藏这个"}],
            "resolutionSources": [{
                "fields": ["targetId"], "kind": "tool_result",
                "referenceId": "call-food-1", "entityId": "food-tomato", "rowVersion": 3,
            }],
            "ambiguityCodes": [], "defaultedFields": [],
        },
        current_message="  收藏这个  ",
        family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),
            CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),
        ),
        trusted_sources={"call-food-1": TrustedResolutionSource(
            kind="tool_result", reference_id="call-food-1", family_id="family-ai",
            entity_versions={"food-tomato": 3},
        )},
    )
    assert validation.clarity == "explicit_context_resolved"
    assert validation.verified_fields == frozenset({"action", "targetId"})
    assert validation.verified_values["targetId"] == "food-tomato"
    assert validation.reason_codes == ()

def test_model_declared_empty_defaults_does_not_prove_critical_fields() -> None:
    validation = validate_intent_evidence(
        evidence={"intentClarity": "explicit_complete", "sourceQuotes": [],
                  "resolutionSources": [], "ambiguityCodes": [], "defaultedFields": []},
        current_message="收藏这个", family_id="family-ai",
        requirements=(
            CriticalEvidenceRequirement("action", "set_favorite:true", "explicit_action"),
            CriticalEvidenceRequirement("targetId", "food-tomato", "entity_id"),
        ),
        trusted_sources={},
    )
    assert "intent_evidence_missing" in validation.reason_codes
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_intent_evidence.py backend/tests/ai_infra/test_ai_draft_contracts.py backend/tests/ai_infra/test_tool_registry.py -q`

Expected: FAIL because `INTENT_EVIDENCE_SCHEMA` and validator do not exist.

- [ ] **Step 3: Add bounded schema and server-owned trusted sources**

Define one shared model-visible description and schema, then attach it as optional `intentEvidence` to `FOOD_PROFILE_DRAFT_SCHEMA`, `MEAL_LOG_DRAFT_SCHEMA`, `MEAL_PLAN_DRAFT_SCHEMA`, and `SHOPPING_LIST_DRAFT_SCHEMA`:

```python
INTENT_CLARITY_MODEL_DESCRIPTION = """
只选择一个档位，不生成置信度：
- explicit_complete：当前用户明确要求该操作，并直接给出唯一目标和全部关键值。
- explicit_context_resolved：当前用户明确要求该操作；只有唯一目标/指代来自当前 UI、本轮 Tool 结果或可信 Artifact，且没有关键默认值。
- explicit_incomplete：用户要求了操作，但关键值或目标缺失、歧义、冲突或依赖默认值。
- inferred：用户没有直接要求写入；事实陈述、称赞或可能的未来打算都不是操作指令。
不得因为 Draft 看起来合理而升级档位。没有证据时省略 intentEvidence，服务端会要求人工确认。
""".strip()

INTENT_EVIDENCE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "description": INTENT_CLARITY_MODEL_DESCRIPTION,
    "required": ["intentClarity", "sourceQuotes", "resolutionSources", "ambiguityCodes", "defaultedFields"],
    "properties": {
        "intentClarity": {
            "type": "string",
            "description": INTENT_CLARITY_MODEL_DESCRIPTION,
            "enum": ["explicit_complete", "explicit_context_resolved", "explicit_incomplete", "inferred"],
        },
        "sourceQuotes": {"type": "array", "maxItems": 12, "items": {
            "type": "object", "additionalProperties": False, "required": ["fields", "text"],
            "properties": {
                "fields": {"type": "array", "minItems": 1, "maxItems": 24,
                           "description": "使用零基具体 payload 路径；[] 通配符不能证明全部数组项。",
                           "items": {"type": "string", "minLength": 1, "maxLength": 80}},
                "text": {"type": "string", "minLength": 1, "maxLength": 240},
            },
        }},
        "resolutionSources": {"type": "array", "maxItems": 12, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["fields", "kind", "referenceId", "entityId"],
            "properties": {
                "fields": {"type": "array", "minItems": 1, "maxItems": 24,
                           "description": "使用由该可信实体解析出的零基具体 payload 路径。",
                           "items": {"type": "string", "minLength": 1, "maxLength": 80}},
                "kind": {"type": "string", "enum": ["current_ui_context", "tool_result", "conversation_artifact"]},
                "referenceId": {"type": "string", "minLength": 1, "maxLength": 120},
                "entityId": {"type": "string", "minLength": 1, "maxLength": 64},
                "rowVersion": {"type": ["integer", "string", "null"]},
            },
        }},
        "ambiguityCodes": {"type": "array", "maxItems": 12,
                           "items": {"type": "string", "minLength": 1, "maxLength": 80}},
        "defaultedFields": {"type": "array", "maxItems": 24,
                            "items": {"type": "string", "minLength": 1, "maxLength": 80}},
    },
}
```

The field/default bounds are 24 because the largest first-batch case is five tracked shopping operation creates with four concrete requirements each; tests cover 20 valid paths and rejection at 25. Quote/source entry counts remain bounded at 12.

The four Draft handlers must split the raw input before calling their current normalizers:

```python
raw_draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
raw_intent_evidence = raw_draft.get("intentEvidence")
business_draft = {key: value for key, value in raw_draft.items() if key != "intentEvidence"}
normalized_draft = normalize_existing_domain_draft(..., payload=business_draft)
```

`capture_draft_output` reads `raw_intent_evidence` from `tool_payload["draft"]`, never from `output["draft"]`, and places it in a separate `intent_evidence_input` member of the routing request. The handler output and persisted/committed business payload remain the normalized Draft only. This rule applies even if a current Pydantic model would silently ignore the extra field.

Change `OrchestratorToolGateway._capture_tool_output(...)` to accept `tool_call_id`. Retain existing `read_outputs` for recommendation assembly, and additionally populate `state.trusted_resolution_sources` with server-extracted IDs/versions, the current family and only the per-Tool allowlisted canonical facts needed by first-batch matchers. Register `current_ui_context` only from normalized server `subject`; register `conversation_artifact` only from a successful `workspace.read_artifact` output. Never copy an arbitrary Tool/Artifact document into authorization state, and never trust an ID or value merely because the model repeated it in Draft JSON.

`validate_intent_evidence` receives the normalized payload plus `tuple[CriticalEvidenceRequirement, ...]`. It normalizes message/quotes with Unicode NFC, collapses all Unicode whitespace to one ASCII space and first verifies substring containment. For every requirement it then uses the server-owned matcher named by `matcher_key` to derive a canonical value from the quote or trusted source and compares that value to `expected_value`. A model-declared field is added to `verified_fields/verified_values` only after this comparison; field coverage alone never passes authorization. Relative dates use the family timezone and a fixed product dictionary. The validator produces stable codes `intent_evidence_missing`, `source_quote_mismatch`, `source_value_unverifiable`, `source_value_mismatch`, `resolution_source_untrusted`, `critical_default_used`, `ambiguity_present`; it never upgrades model clarity and never invokes a model.

Persist `normalized_evidence`, `verified_fields`, `verified_values` and `reason_codes` together in `AITaskDraft.intent_evidence_json`. Raw quote text may be retained for private audit, but only the server-verified fields and values participate in policy authorization.

- [ ] **Step 4: Run focused contract tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_intent_evidence.py backend/tests/ai_infra/test_ai_draft_contracts.py backend/tests/ai_infra/test_tool_registry.py -q`

Expected: PASS; over-limit evidence fails Draft schema validation, missing/unverifiable/mismatched values remain valid Drafts but return manual-only reason codes, and all four real normalizers preserve the evidence through the separate capture envelope without leaking it into domain payloads.

- [ ] **Step 5: Commit evidence validation**

```bash
git add backend/app/services/ai_auto_execution/intent_evidence.py backend/app/ai/tools/schemas.py backend/app/ai/tools/catalog/food.py backend/app/ai/tools/catalog/meal_log.py backend/app/ai/tools/catalog/meal_plan.py backend/app/ai/tools/catalog/shopping.py backend/app/ai/workflows/orchestrator/state.py backend/app/ai/workflows/orchestrator/tools.py backend/app/ai/workflows/orchestrator/draft_capture.py backend/tests/ai_infra/test_ai_intent_evidence.py backend/tests/ai_infra/test_ai_draft_contracts.py backend/tests/ai_infra/test_tool_registry.py
git commit -m "feat: validate AI draft intent evidence"
```

### Task 4: Policy types, registry and global auto-execution gates

**Files:**
- Create: `backend/app/services/ai_auto_execution/policy_types.py`
- Create: `backend/app/services/ai_auto_execution/policy_registry.py`
- Create: `backend/tests/ai_infra/test_ai_auto_execution_policy_registry.py`
- Modify: `backend/app/services/ai_auto_execution/settings.py`
- Modify: `backend/app/services/ai_operations/registry_types.py`
- Modify: `backend/app/services/ai_operations/registry_specs.py`

**Interfaces:**
- Consumes: `IntentEvidenceValidation`, settings rows/catalog, `AIRevertAdapterRegistry.supports(key)` and current Run/Draft facts.
- Produces: stable cross-task dataclasses above; `AutoExecutionPolicyRegistry.evaluate(context) -> AutoExecutionDecision`; `resolve_effective_authorization(...) -> EffectiveAuthorization`.

- [ ] **Step 1: Write failing global-gate tests**

Use a fake action policy that otherwise allows execution, and parameterize every global blocker. Assert reason codes and that unauthorized `no_change` is converted to `manual_confirmation`.

```python
@pytest.mark.parametrize("override,reason", [
    ({"clarity": "inferred"}, "intent_not_explicit"),
    ({"evidence_reasons": ("source_quote_mismatch",)}, "source_quote_mismatch"),
    ({"evidence_reasons": ("source_value_unverifiable",)}, "source_value_unverifiable"),
    ({"evidence_reasons": ("source_value_mismatch",)}, "source_value_mismatch"),
    ({"member_enabled": False}, "member_authorization_missing"),
    ({"family_enabled": False}, "family_policy_disabled"),
    ({"has_revert_adapter": False}, "revert_adapter_missing"),
    ({"has_continuation": True}, "continuation_not_allowed"),
    ({"is_composite": True}, "composite_not_allowed"),
    ({"auto_execution_attempted": True}, "auto_execution_already_attempted"),
])
def test_global_gate_downgrades_to_manual(base_context, override, reason):
    decision = registry.evaluate(replace(base_context, **override))
    assert decision.route == "manual_confirmation"
    assert reason in decision.reason_codes

def test_unauthorized_already_satisfied_target_still_requires_confirmation(base_context):
    context = replace(base_context, member_enabled=False, target_state="already_satisfied")
    assert registry.evaluate(context).route == "manual_confirmation"
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_policy_registry.py -q`

Expected: FAIL with missing policy registry/types.

- [ ] **Step 3: Implement the deterministic registry and authorization resolver**

Add these exact supporting contracts:

```python
@dataclass(frozen=True, slots=True)
class EffectiveAuthorization:
    enabled: bool
    source: AuthorizationSource | None
    snapshot: dict[str, Any]
    reason_codes: tuple[str, ...]

@dataclass(frozen=True, slots=True)
class ActionPolicyEvaluation:
    allowed: bool
    all_targets_satisfied: bool
    reason_codes: tuple[str, ...]

@dataclass(frozen=True, slots=True)
class AutoExecutionPolicyContext:
    db: Session
    family_id: str
    actor_user_id: str
    draft_type: str
    payload: dict[str, Any]
    evidence: IntentEvidenceValidation
    authorization: EffectiveAuthorization
    auto_execution_attempted: bool
    has_continuation: bool
    is_composite: bool
    has_external_side_effect: bool
    registered_revert_adapters: frozenset[str]

class AutoExecutionActionPolicy(Protocol):
    key: str
    version: str
    draft_types: frozenset[str]
    revert_adapter_key: str

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool: ...
    def evidence_requirements(
        self, *, db: Session, family_id: str, actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]: ...
    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation: ...
```

`resolve_effective_authorization` accepts `for_update: bool`. It checks current notice versions even when raw `enabled=True`, includes both row versions/notices in the snapshot, requires the family row only for shopping, and never creates missing rows during a read or policy decision.

The registry resolves the one matching policy before evidence validation so routing can call its read-only `evidence_requirements(...)`; only after `validate_intent_evidence` returns does it build `AutoExecutionPolicyContext` and run gates in a stable order. It deduplicates reason codes without sorting away that order. It returns `no_change` only after every global gate and action policy passes and `all_targets_satisfied=True`; partial satisfaction returns manual with `domain_constraint_failed`. No matching policy returns `action_not_allowed`. Register policy key/version and revert adapter key in server code, never from Draft payload.

Expose `auto_execution_policy_key: str | None` and `revert_adapter_key: str | None` on `DraftOperationSpec` only as server registry metadata; existing specs default to `None`.

- [ ] **Step 4: Run the policy registry tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_policy_registry.py backend/tests/ai_infra/test_registry_and_metrics.py -q`

Expected: PASS; existing Draft specs remain registered and default to manual.

- [ ] **Step 5: Commit the policy foundation**

```bash
git add backend/app/services/ai_auto_execution/policy_types.py backend/app/services/ai_auto_execution/policy_registry.py backend/app/services/ai_auto_execution/settings.py backend/app/services/ai_operations/registry_types.py backend/app/services/ai_operations/registry_specs.py backend/tests/ai_infra/test_ai_auto_execution_policy_registry.py
git commit -m "feat: add deterministic AI auto execution gates"
```

### Task 5: Five action-specific auto-execution policies

**Files:**
- Create: `backend/app/services/ai_auto_execution/policies/__init__.py`
- Create: `backend/app/services/ai_auto_execution/policies/food_favorite.py`
- Create: `backend/app/services/ai_auto_execution/policies/meal_rating.py`
- Create: `backend/app/services/ai_auto_execution/policies/shopping_safe_write.py`
- Create: `backend/app/services/ai_auto_execution/policies/simple_meal.py`
- Create: `backend/app/services/ai_auto_execution/policies/simple_plan.py`
- Create: `backend/tests/ai_infra/test_ai_auto_execution_action_policies.py`
- Modify: `backend/app/services/ai_auto_execution/policy_registry.py`

**Interfaces:**
- Consumes: `AutoExecutionPolicyContext`, existing domain rows/locks, catalog hard limits and server-known action/revert keys.
- Produces: five `AutoExecutionActionPolicy` instances, each versioned `*.v1`, with exhaustive field allowlists and no write side effects during evaluation.

- [ ] **Step 1: Write the complete policy matrix as failing tests**

Parameterize allowed/no-change/rejected examples and hard boundaries 1/5/6. Include permission and field-diff cases, not only happy paths.

```python
@pytest.mark.parametrize("case", [
    PolicyCase("favorite-on", "food.set_favorite", favorite_payload(True), "auto_execute"),
    PolicyCase("favorite-no-change", "food.set_favorite", favorite_payload(current=True), "no_change"),
    PolicyCase("favorite-extra-field", "food.set_favorite", favorite_payload(True, notes="x"), "manual_confirmation"),
    PolicyCase("rating-five", "meal_log.rate_food", rating_payload(count=5), "auto_execute"),
    PolicyCase("rating-six", "meal_log.rate_food", rating_payload(count=6), "manual_confirmation"),
    PolicyCase("shopping-add-five", "shopping_list.safe_write", shopping_create_payload(5), "auto_execute"),
    PolicyCase("shopping-add-six", "shopping_list.safe_write", shopping_create_payload(6), "manual_confirmation"),
    PolicyCase("shopping-delete", "shopping_list.safe_write", shopping_delete_payload(), "manual_confirmation"),
    PolicyCase("meal-simple", "meal_log.simple_create", simple_meal_payload(foods=5), "auto_execute"),
    PolicyCase("meal-deduct", "meal_log.simple_create", simple_meal_payload(deduct_stock=True), "manual_confirmation"),
    PolicyCase("plan-simple", "meal_plan.simple_create", simple_plan_payload(items=5), "auto_execute"),
    PolicyCase("plan-status", "meal_plan.simple_create", plan_status_payload(), "manual_confirmation"),
])
def test_action_policy_matrix(policy_context_factory, case):
    decision = registry.evaluate(policy_context_factory(case))
    assert decision.route == case.expected_route
```

Also assert: rating actor must be MealLog creator or participant; shopping modes cannot mix; tracked-quantity shopping requires quote/artifact provenance for quantity and unit; ready Food types are only `readyMade | instant | packaged`; simple meal has one current actor, explicit create intent/date/meal type/servings, no media/plan/stock/Continuation; simple plan has explicit create intent, fixes `user_id` to actor and only creates unique planned items. For both create policies, field-complete statements such as “今天午餐吃了番茄炒蛋” or “明晚吃番茄炒蛋” without a request to record/add must return `manual_confirmation`.

Shopping tests must exercise each actual normalized shape separately: plain `shopping_list.v1` create, operation create, update and restore. Assert plain/operation create do not require nonexistent `targetId`; identity comes from `ingredient_id | food_id`; update requires its target and exact changed fields; restore requires `targetId + done=false` but no quantity/unit; tracked targets require quantity/unit while non-tracked targets accept only the server-fixed representation. Add negative cases where evidence names the right field but its canonical value differs from the normalized payload.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_action_policies.py -q`

Expected: FAIL because the five policies are not registered.

- [ ] **Step 3: Implement exact field allowlists and state checks**

Use one policy version per action:

```python
POLICY_VERSIONS = {
    "food.set_favorite": "food.set_favorite.v1",
    "meal_log.rate_food": "meal_log.rate_food.v1",
    "shopping_list.safe_write": "shopping_list.safe_write.v1",
    "meal_log.simple_create": "meal_log.simple_create.v1",
    "meal_plan.simple_create": "meal_plan.simple_create.v1",
}
```

Every policy implements `evidence_requirements(...)` and expands arrays into concrete indexed paths. `[]` is documentation shorthand only and is never accepted as proof for all elements:

| Action | Concrete requirements |
| --- | --- |
| `food.set_favorite` | semantic `action`, `targetId`, `payload.favorite` |
| `meal_log.rate_food` | semantic `action`, `targetId`, and for every entry `payload.foodEntryRatings[i].id` plus `.rating` |
| `meal_log.simple_create` | semantic `action`, `date`, `mealType`, and for every food `foods[i].foodId` plus `.servings` |
| `meal_plan.simple_create` | semantic `action`, and for every item `items[i].date`, `.mealType`, `.foodId` |

The model-visible evidence field grammar uses the same concrete JSON-style paths with zero-based `[i]` indexes. One quote may claim several paths, but the validator compares every path to its own `expected_value`; evidence for item 0 never verifies item 1.

`shopping_list.safe_write` must instead call `shopping_critical_requirements(normalized_payload, server_targets)` and return concrete indexed `CriticalEvidenceRequirement` values from these rules:

| Normalized mode | Required fields |
| --- | --- |
| `shopping_list.v1` create | semantic `action`; each `items[i].ingredient_id` or `items[i].food_id`; for server-confirmed tracked targets only, `items[i].quantity` and `items[i].unit` |
| operation create | `operations[i].action`; `operations[i].payload.ingredient_id` or `food_id`; for tracked targets only, payload `quantity` and `unit`; never `targetId` |
| operation update | `operations[0].action`, `operations[0].targetId`, and every field in the server-computed normalized diff among `quantity | unit | reason` |
| restore | each `operations[i].action`, `operations[i].targetId` and `operations[i].payload.done=false`; never quantity/unit |

The helper rejects any mixed mode, delete, `done=true`, target replacement or diff outside the whitelist before evidence validation. It derives tracked/non-tracked status and target identity from family-scoped server rows, never from model-supplied `quantity_mode`. The server-fixed “需要补充” representation for non-tracked Ingredients is not a model default.

For every action, convert the selected fields into `CriticalEvidenceRequirement(field, expected_value, matcher_key)` using values from the normalized business Draft/current server rows. `validate_intent_evidence` must prove those values, not merely the path names. “今天/明天/今晚” may resolve through the family timezone/product dictionary, but current-clock meal-type inference is always `critical_default_used`.

State checks are read-only and family-scoped. Compare both `baseUpdatedAt` and current row version where the model supports both; store the current post-policy version in the later receipt rather than accepting a model-supplied version. For batches, all targets must be valid and all already satisfied for `no_change`; never return a partial auto plan.

- [ ] **Step 4: Run action-policy and domain-boundary tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_action_policies.py backend/tests/shopping/test_shopping_list_api.py backend/tests/meal_logs/test_meal_logs.py -q`

Expected: PASS with no database writes from policy evaluation.

- [ ] **Step 5: Commit the action policies**

```bash
git add backend/app/services/ai_auto_execution/policies backend/app/services/ai_auto_execution/policy_registry.py backend/tests/ai_infra/test_ai_auto_execution_action_policies.py
git commit -m "feat: define low risk AI action policies"
```

### Task 6: Domain execution receipt contract

**Files:**
- Create: `backend/tests/ai_infra/test_ai_draft_execution_receipts.py`
- Modify: `backend/app/services/ai_operations/registry_types.py`
- Modify: `backend/app/services/ai_operations/registry.py`
- Modify: `backend/app/services/ai_operations/executor.py`
- Modify: `backend/app/services/ai_operations/foods.py`
- Modify: `backend/app/services/ai_operations/ingredients.py`
- Modify: `backend/app/services/ai_operations/meal_logs.py`
- Modify: `backend/app/services/ai_operations/meal_plans.py`
- Modify: `backend/app/services/ai_operations/shopping.py`
- Modify: `backend/app/services/ai_operations/inventory.py`
- Modify: `backend/app/services/ai_operations/inventory_intake.py`
- Modify: `backend/app/services/ai_operations/recipes.py`
- Modify: `backend/app/services/ai_operations/composite.py`
- Modify: `backend/app/services/ai_operations/registry_specs.py`

**Interfaces:**
- Consumes: existing domain Service writes and `DraftExecuteContext`.
- Produces: every registered executor returns `DraftExecutionReceipt`; `DraftExecuteContext` additionally carries `committed_at` and `revertible_until`.

- [ ] **Step 1: Write failing receipt contract tests**

Exercise one handler per registered Draft type and assert no executor returns the old tuple. Assert non-revertible operations explicitly use `None`, not an invented generic context.

```python
def test_every_registered_executor_returns_typed_receipt(self) -> None:
    for fixture in registered_draft_execution_fixtures(self):
        with self.subTest(draft_type=fixture.draft_type):
            receipt = draft_operation_registry.execute(fixture.context)
            self.assertIsInstance(receipt, DraftExecutionReceipt)
            self.assertIsInstance(receipt.entity_ids, tuple)
            self.assertIn("ai_conversation", receipt.cache_scopes)

def test_recipe_cook_does_not_claim_generic_revert(self) -> None:
    receipt = execute_fixture("recipe_cook")
    self.assertIsNone(receipt.revert_adapter_key)
    self.assertIsNone(receipt.revert_context)
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_execution_receipts.py -q`

Expected: FAIL because registry executors return `(business_entity, entity_ids)` tuples.

- [ ] **Step 3: Change registry and all handlers atomically to receipts**

Change the callable type and context exactly:

```python
@dataclass(frozen=True, slots=True)
class DraftExecuteContext:
    db: Session
    draft_type: str
    family_id: str
    user_id: str
    payload: dict[str, Any]
    assert_updated_at_matches: AssertUpdatedAt
    operation_idempotency_key: str
    conversation_id: str = ""
    committed_at: datetime | None = None
    revertible_until: datetime | None = None

ExecuteDraft = Callable[[DraftExecuteContext], DraftExecutionReceipt]
```

Each handler wraps its existing domain result with exact cache scopes. Always include `ai_conversation`; add only the affected business scopes. At this task, adapters not yet implemented must still return `revert_adapter_key=None`. Do not add fallback conversion in the registry: a stale tuple is a test failure, so the migration cannot remain half-complete.

The public executor becomes:

```python
def execute_ai_operation_draft(
    db: Session, *, family_id: str, user_id: str, draft_type: str,
    payload: dict[str, Any], assert_updated_at_matches: AssertUpdatedAt,
    operation_idempotency_key: str, conversation_id: str = "",
    committed_at: datetime | None = None, revertible_until: datetime | None = None,
) -> DraftExecutionReceipt: ...
```

Keep existing domain Services responsible for locks, membership, versions and transactions. This task changes the return envelope only; it must not yet enable auto execution.

- [ ] **Step 4: Run receipt and existing approval tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_execution_receipts.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_composite_operations.py -q`

Expected: PASS; manual approval behavior and Composite results remain unchanged.

- [ ] **Step 5: Commit the typed receipt refactor**

```bash
git add backend/app/services/ai_operations backend/tests/ai_infra/test_ai_draft_execution_receipts.py
git commit -m "refactor: return typed AI draft execution receipts"
```

### Task 7: Shared DraftCommitCoordinator and manual approval migration

**Files:**
- Create: `backend/app/services/ai_operations/commit_coordinator.py`
- Create: `backend/app/repos/ai_operations.py`
- Create: `backend/tests/ai_infra/test_ai_draft_commit_coordinator.py`
- Modify: `backend/app/services/ai_operations/approval_decisions.py`
- Modify: `backend/app/services/ai_operations/approval_requests.py`
- Modify: `backend/app/services/ai_operations/artifacts.py`
- Modify: `backend/app/services/ai_operations/messages.py`
- Modify: `backend/app/services/serializers.py`

**Interfaces:**
- Consumes: `DraftCommitRequest`, locked Run/Draft from caller, `DraftExecutionReceipt`, existing retry approval and post-execute hooks.
- Produces: `DraftCommitCoordinator.commit_locked(...) -> DraftCommitResult`; `DraftCommitCoordinator.retry_pending_locked(...) -> DraftCommitResult`; `derive_draft_payload_hash(payload)`; `derive_draft_operation_idempotency_key(draft_id, draft_version)`; manual approvals remain genuine and immutable.

- [ ] **Step 1: Write failing coordinator and manual-path tests**

Assert manual and direct coordinator calls invoke the same fake executor, derive the same operation key, persist one operation, retain approved status on domain failure/revert preparation and use the current decision maker as actor.

Add direct policy-auto pending-retry tests: the same Draft ID/version/payload hash derives the same Operation key and succeeds once after a simulated transient failure; changed payload/version is rejected before the executor; two concurrent recovery calls produce one domain write and replay one persisted result. A manual-path `pending_retry` remains owned by its existing retry Approval and is rejected by this method.

```python
def test_manual_approval_delegates_to_shared_coordinator(self) -> None:
    with patch.object(DraftCommitCoordinator, "commit_locked", wraps=DraftCommitCoordinator.commit_locked) as commit:
        response = self.approve_food_favorite_draft()
    self.assertEqual(response.status_code, 200)
    self.assertEqual(commit.call_count, 1)
    request = commit.call_args.kwargs["request"]
    self.assertEqual(request.execution_mode, "manual_approval")
    self.assertEqual(request.authorization_source, "approval_request")
    self.assertEqual(request.actor_user_id, self.user.id)

def test_same_draft_version_is_committed_once(self) -> None:
    first = commit_fixture(draft_id="draft-1", draft_version=3)
    second = commit_fixture(draft_id="draft-1", draft_version=3)
    self.assertEqual(second.operation_id, first.operation_id)
    self.assertEqual(count_domain_writes(), 1)
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_commit_coordinator.py -q`

Expected: FAIL because `DraftCommitCoordinator` does not exist and approval logic executes inline.

- [ ] **Step 3: Extract operation acquisition, execution and result persistence**

Use the deterministic idempotency key:

```python
def derive_draft_operation_idempotency_key(draft_id: str, draft_version: int) -> str:
    digest = hashlib.sha256(f"{draft_id}\0{draft_version}".encode("utf-8")).hexdigest()
    return f"ai-draft:{digest}"

def derive_draft_payload_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

class DraftCommitCoordinator:
    @classmethod
    def commit_locked(
        cls, db: Session, *, request: DraftCommitRequest,
        locked_run: AIAgentRun | None, locked_draft: AITaskDraft,
    ) -> DraftCommitResult: ...

    @classmethod
    def retry_pending_locked(
        cls, db: Session, *, family_id: str, actor_user_id: str,
        locked_run: AIAgentRun, locked_draft: AITaskDraft,
        expected_payload_hash: str, now: datetime,
    ) -> DraftCommitResult: ...
```

`retry_pending_locked` requires `locked_draft.execution_route == "policy_auto"`, `status == "pending_retry"` and no Approval retry association. It never replaces the existing manual retry-Approval path.

Verify locked object IDs/family/version before any write. Create/replay `AIOperation(status="pending")`, pass a one-hour `revertible_until` into `DraftExecuteContext`, execute the domain Service inside `db.begin_nested()`, then persist `committed_payload_json`, receipt result, adapter/context/deadline, activity, Artifact and message result. The caller owns the outer commit; an active chat may emit SSE only after that commit, while ordinary mutation callers return their result only after commit.

On target/version/domain conflict, roll back the nested business write, set Operation `failed` with stable `error_code/error_message/failed_at`, and set Draft `execution_failed`. For a genuine manual approval, keep the original Approval `approved`, create `AIUserApproval`, then create exactly one retry Approval and move Draft to `pending_retry` using existing recovery behavior. For policy auto, never create a retry Approval. Preserve the existing recipe-cook rule: a manual `pending_retry` may reuse its failed operation to keep completion idempotency; policy-auto domain failures cannot be repurposed.

Treat retryable `OperationalError`/connection failures separately from domain conflicts. Roll back the full pending Operation/business transaction, then use the existing recovery transaction to persist Draft `pending_retry`, the unchanged payload hash and a retryable error code. `retry_pending_locked` accepts only that identical Draft ID/version/payload hash, derives the same Operation idempotency key and never creates an Approval. It must recheck cancellation, original actor/current membership, authorization, target versions and the one-attempt Run state before touching business data. A different payload or a confirmed domain conflict requires a new Draft/version.

Reduce `apply_ai_approval_decision` to: lock in existing Run → Approval → Draft order; validate submitted values; record rejection or genuine approval; build `DraftCommitRequest`; delegate; attach any retry state. Remove `_acquire_operation_for_approval` after its covered behavior moves to the coordinator.

- [ ] **Step 4: Run coordinator, approval, cancellation and recipe tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_commit_coordinator.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_run_cancellation.py backend/tests/ai_infra/test_recipe_drafts_and_images.py -q`

Expected: PASS; approval rows still reflect real user decisions and no duplicate business entity is created.

- [ ] **Step 5: Commit the shared commit path**

```bash
git add backend/app/services/ai_operations/commit_coordinator.py backend/app/repos/ai_operations.py backend/app/services/ai_operations/approval_decisions.py backend/app/services/ai_operations/approval_requests.py backend/app/services/ai_operations/artifacts.py backend/app/services/ai_operations/messages.py backend/app/services/serializers.py backend/tests/ai_infra/test_ai_draft_commit_coordinator.py
git commit -m "refactor: share AI draft commit coordination"
```

### Task 8: Draft routing, Runtime control flow and one-attempt guard

**Files:**
- Create: `backend/app/services/ai_operations/routing.py`
- Create: `backend/tests/ai_infra/test_ai_draft_routing.py`
- Modify: `backend/app/ai/errors.py`
- Modify: `backend/app/ai/workflows/orchestrator/draft_capture.py`
- Modify: `backend/app/ai/workflows/orchestrator/agent.py`
- Modify: `backend/app/ai/workflows/orchestrator/results.py`
- Modify: `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py`
- Modify: `backend/app/ai/workflows/runner_support/assistant_result_persister.py`
- Modify: `backend/app/ai/workflows/runner_support/orchestrator_next_state.py`
- Modify: `backend/app/ai/workflows/runner_support/message_parts.py`
- Modify: `backend/app/ai/workflows/runner_support/run_status.py`
- Modify: `backend/app/ai/workflows/state.py`
- Modify: `backend/app/ai/workflows/run_lifecycle.py`
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**
- Consumes: policy registry, settings resolver, `DraftCommitCoordinator`, current message/trusted sources/Skill approval policy and existing cancellation lock order.
- Produces: `route_draft(db, request) -> DraftRouteOutcome`; `DraftRouted(outcome)` control flow; persisted manual/auto/no-change/failure states without pending-card flicker.

- [ ] **Step 1: Write failing route/state-machine tests**

Cover manual default, authorized auto success, final authorization downgrade, no-change, second attempt, conflict failure, idempotent replay, cancellation-before-lock and no Continuation advance. Exercise the full Runner final-persistence path and assert it cannot recreate an Approval for an auto/no-change Draft merely because `approval_id` is absent. Cover the existing Run retry endpoint in all three branches: a policy-auto `pending_retry` Draft recovers the same Run/Draft without a provider call; a manual `pending_retry` remains on its retry Approval and does not prompt-replay; an unrelated failed/fallback/cancelled Run retains the existing prompt-retry/new-Run behavior.

```python
def test_auto_route_creates_no_approval_and_commits_once(self) -> None:
    outcome = self.route_explicit_favorite(authorized=True)
    self.assertEqual(outcome.status, "auto_executed")
    with self.SessionLocal() as db:
        self.assertEqual(db.scalar(select(func.count(AIApprovalRequest.id))), 0)
        self.assertEqual(db.scalar(select(func.count(AIUserApproval.id))), 0)
        run = db.get(AIAgentRun, self.run.id)
        self.assertTrue(run.auto_execution_attempted)
        self.assertEqual(run.auto_operation_id, outcome.operation_id)

def test_no_change_persists_result_and_consumes_attempt_slot(self) -> None:
    outcome = self.route_explicit_favorite(authorized=True, already_favorite=True)
    self.assertEqual(outcome.status, "no_change")
    self.assertIsNone(outcome.operation_id)
    with self.SessionLocal() as db:
        self.assertEqual(db.scalar(select(func.count(AIOperation.id))), 0)
        self.assertTrue(db.get(AIAgentRun, self.run.id).auto_execution_attempted)
        self.assertEqual(db.get(AITaskDraft, outcome.draft_id).status, "no_change")
```

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_routing.py -q`

Expected: FAIL because Publisher always creates Approval and capture always raises `ApprovalRequired`.

- [ ] **Step 3: Implement route-aware persistence and control flow**

Define the routing request exactly:

```python
@dataclass(frozen=True, slots=True)
class DraftRouteRequest:
    family_id: str
    actor_user_id: str
    conversation_id: str
    message_id: str
    run_id: str
    draft_type: str
    payload: dict[str, Any]
    intent_evidence_input: dict[str, Any] | None
    schema_version: str
    tool_name: str
    skill_approval_policy: str
    current_message: str
    trusted_resolution_sources: dict[str, TrustedResolutionSource]
    continuation: dict[str, Any]
```

`route_draft` receives normalized business `payload` and the separately captured raw `intent_evidence_input`. After resolving the candidate action, it builds the action-specific `CriticalEvidenceRequirement` tuple, calls `validate_intent_evidence`, then persists/loads the idempotent Draft with `intent_clarity`, the complete server-owned validation record in `intent_evidence_json`, and `payload_hash=derive_draft_payload_hash(payload)`. Loading an existing same-version Draft requires the stored hash to match before routing; the committed payload never contains `intentEvidence`. `draft_then_confirm`, Composite, any Continuation, missing/unverifiable evidence, settings/adapter absence and policy denial create exactly one `AIApprovalRequest` and return `waiting_approval`. Only `draft_then_policy` may run preflight.

For an auto candidate, acquire locks in this order: `AIAgentRun -> AITaskDraft -> family policy row -> member preference row -> AIOperation -> domain Service`. Recheck cancellation, actor/run ownership, notice versions, limits, versions and adapter after locks. If the final decision no longer passes before business data is touched, set Draft route to manual and create Approval. If final decision is `no_change`, lock/set `run.auto_execution_attempted=True`, leave `auto_operation_id=None`, persist result message/Artifact and return. If auto commit begins, mark attempted before calling Coordinator; a failed commit remains attempted.

Add route-aware exception:

```python
class DraftRouted(Exception):
    def __init__(self, outcome: DraftRouteOutcome) -> None:
        super().__init__(outcome.status)
        self.outcome = outcome
```

`capture_draft_output` raises `ApprovalRequired` only for `waiting_approval`; it raises `DraftRouted` for `auto_executed | no_change | execution_failed`. The assembler returns the persisted Draft/result and a completed/failed SkillResult. `OrchestratorNextStateResolver` accepts a Draft without Approval only when its route outcome is one of those three; the existing `draft_without_approval` guard remains for malformed results.

Refactor `AssistantResultPersister` so `assistant_status`, Draft/Approval association and missing-part repair use the persisted route outcome, not `bool(result.drafts)` or `approval is None`. It may call `_create_draft_approval` and `missing_draft_approval_message_parts` only for `waiting_approval`; auto/no-change/failure results reuse their already-persisted Draft/result part and leave `approval_ids=[]`. This final persistence pass must be covered by the routing tests.

Publisher emits Draft+Approval parts only after the manual checkpoint. Auto/no-change emit only the persisted result part after commit, so no pending card is visible. Retried completed/reverted Operations and `no_change` Drafts replay persisted parts without policy/domain re-execution. Any failure suppresses Continuation and does not let the model call a second Draft. A transient `pending_retry` keeps `run.auto_execution_attempted=True`; the one-attempt gate permits only the explicit recovery of that same Draft ID/version/payload hash and never opens a slot for another Draft.

Wire this recovery into the existing `POST /api/ai/runs/{run_id}/retry` before `build_retry_chat_request` or `AIApplicationService.chat()`:

1. authorize and `FOR UPDATE` lock the original Run, then load the unique associated `AITaskDraft(status="pending_retry")`;
2. require the original Run actor, active membership and stored Draft version/payload hash; reject ambiguous/mismatched recovery;
3. for `execution_route="policy_auto"`, call `DraftCommitCoordinator.retry_pending_locked` on that same Run/Draft and return a normal `AIChatResponse` projection of the same Run/message; for a manual-path Draft, return/retain its existing retry Approval and never prompt-replay;
4. never generate a new `client_message_id`, call the provider, create a new Run/Draft, reset `auto_execution_attempted`, or reopen Continuation;
5. if no `pending_retry` Draft exists, fall through unchanged to the current prompt retry path.

Tests patch the provider and assert call count 0, identical Run/Draft IDs and payload hash, no new Draft/Approval, and at most one domain write under duplicate/concurrent retries. Retrying a completed/reverted Operation or `no_change` also returns the persisted part before any model call.

- [ ] **Step 4: Run routing, streaming and cancellation tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_routing.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_phase_flows.py backend/tests/ai_infra/test_run_cancellation.py backend/tests/ai_infra/test_run_cancellation_concurrency.py -q`

Expected: PASS; no auto result is emitted before the transaction checkpoint and cancellation-first never writes business data.

- [ ] **Step 5: Commit route-aware Runtime behavior**

```bash
git add backend/app/services/ai_operations/routing.py backend/app/ai/errors.py backend/app/ai/workflows/orchestrator backend/app/ai/workflows/runner_support backend/app/ai/workflows/state.py backend/app/ai/workflows/run_lifecycle.py backend/app/ai/workspace_service.py backend/app/api/ai.py backend/tests/ai_infra/test_ai_draft_routing.py backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "feat: route AI drafts through server policy"
```

### Task 9: Unified Operation result projection, message, Artifact and transport contract

**Files:**
- Create: `backend/app/services/ai_operations/result_projection.py`
- Create: `backend/tests/ai_infra/test_ai_operation_result_projection.py`
- Modify: `backend/app/schemas/ai_auto_execution.py`
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/services/ai_operations/artifacts.py`
- Modify: `backend/app/services/ai_operations/messages.py`
- Modify: `backend/app/services/ai_operations/commit_coordinator.py`
- Modify: `backend/app/services/ai_operations/routing.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/app/ai/workflows/runner_support/message_parts.py`
- Modify: `backend/app/ai/workflows/runner_support/progressive_draft_publisher.py`

**Interfaces:**
- Consumes: `AIOperationResultProjection`, `DraftExecutionReceipt`, persisted Draft/Operation, active chat post-commit publishing and ordinary mutation responses from Tasks 6–8.
- Produces: `project_ai_operation_result(...) -> AIOperationResultProjection`, `serialize_ai_operation_result_projection(...) -> dict[str, Any]`, `hydrate_operation_result_server_now(...) -> dict[str, Any]`, `upsert_message_operation_result(...) -> dict[str, Any]`, `operation_result_artifacts(...) -> tuple[dict[str, Any], ...]`; active chat delivery reuses SSE `message_part`, while ordinary approval/revert endpoints return JSON.

- [ ] **Step 1: Write failing public-projection and persistence tests**

Assert all four terminal routes use the same whitelist, card shell and stable Draft-keyed identity. Include a leakage test and the exact no-change contract.

```python
PUBLIC_RESULT_FIELDS = {
    "draft_id", "operation_id", "result_status", "execution_mode",
    "operation_status", "execution_explanation", "revert_availability",
    "revertible_until", "revert_blocked_code", "server_now",
    "entities", "cache_scopes",
}

def test_no_change_projection_has_no_operation_or_business_invalidation(self) -> None:
    projection = project_fixture(route="policy_no_change")
    self.assertEqual(projection.result_status, "no_change")
    self.assertEqual(projection.execution_mode, "policy_no_change")
    self.assertIsNone(projection.operation_id)
    self.assertIsNone(projection.operation_status)
    self.assertEqual(projection.revert_availability, "unsupported")
    self.assertEqual(projection.cache_scopes, ("ai_conversation",))

def test_public_projection_never_leaks_private_audit_payloads(self) -> None:
    record = serialize_ai_operation_result_projection(
        project_fixture(route="policy_auto", private_sentinels=True)
    )
    self.assertEqual(set(record), PUBLIC_RESULT_FIELDS)
    encoded = json.dumps(record, ensure_ascii=False)
    for secret_key in (
        "authorization_snapshot_json", "intent_evidence_json",
        "committed_payload_json", "revert_context_json",
    ):
        self.assertNotIn(secret_key, encoded)

def test_result_part_is_replaced_in_place_on_terminal_state_change(self) -> None:
    first = persist_result_fixture(result_status="completed")
    second = persist_result_fixture(result_status="reverted")
    self.assertEqual(second["id"], first["id"])
    self.assertEqual(count_result_parts_for_draft(first["card"]["data"]["draft_id"]), 1)
    self.assertEqual(second["card"]["data"]["result_status"], "reverted")

def test_message_rehydration_uses_fresh_response_clock(self) -> None:
    persisted = persist_result_fixture(server_now="2026-08-24T10:00:00Z")
    response = serialize_messages_fixture(
        parts=[persisted], server_now="2026-08-24T10:30:00Z",
    )
    self.assertEqual(
        response[0]["parts"][0]["card"]["data"]["server_now"],
        "2026-08-24T10:30:00Z",
    )
```

Parameterize persisted projections for `manual_approval`, `policy_auto`, `policy_no_change`, `failed` and `reverted`. For results produced inside an active `/api/ai/chat/stream`, assert the only transport event is `message_part`, carrying `message_id/conversation_id/run_id/part`, and that no event is emitted before commit. For manual approval and revert POSTs, assert the response returns the complete persisted result card/part and scopes without trying to enqueue an SSE event. Reconnect/refetch reads the persisted part without invoking policy, model or domain executor. Do not add top-level `operation_completed`, `operation_failed`, `operation_reverted` or `draft_no_change` events that the current frontend parser would drop.

Add delayed-refresh cases at +30 minutes and just after `revertible_until`: every messages response uses one newly captured response-level `server_now`, not the historical value stored in the card. The underlying stored JSON remains unchanged by a read.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_operation_result_projection.py -q`

Expected: FAIL because manual result cards are approval-shaped and there is no route-independent projection/upsert path.

- [ ] **Step 3: Implement one safe projection and stable result artifacts**

Use a fixed field whitelist and server-owned explanations:

```python
PUBLIC_RESULT_FIELDS = (
    "draft_id", "operation_id", "result_status", "execution_mode",
    "operation_status", "execution_explanation", "revert_availability",
    "revertible_until", "revert_blocked_code", "server_now",
    "entities", "cache_scopes",
)

EXECUTION_EXPLANATIONS = {
    "manual_approval": "已按你的确认执行。",
    "policy_auto": "你明确要求执行此操作，且它符合已开启的低风险规则。",
    "policy_no_change": "相关内容已经是你要求的状态。",
}

def project_ai_operation_result(
    *,
    draft: AITaskDraft,
    operation: AIOperation | None,
    entities: tuple[dict[str, Any], ...],
    cache_scopes: tuple[AICacheScope, ...],
    server_now: datetime,
) -> AIOperationResultProjection:
    if draft.status == "no_change":
        return AIOperationResultProjection(
            draft_id=draft.id,
            operation_id=None,
            result_status="no_change",
            execution_mode="policy_no_change",
            operation_status=None,
            execution_explanation=EXECUTION_EXPLANATIONS["policy_no_change"],
            revert_availability="unsupported",
            revertible_until=None,
            revert_blocked_code=None,
            server_now=server_now,
            entities=entities,
            cache_scopes=("ai_conversation",),
        )
    if operation is None:
        raise ValueError("真实写入结果必须关联 AIOperation")
    return _project_persisted_operation(
        draft=draft,
        operation=operation,
        entities=entities,
        cache_scopes=cache_scopes,
        server_now=server_now,
    )
```

`_project_persisted_operation` maps `pending | completed | failed | reverted` without exposing raw payloads. For `completed`, return `available` only when the adapter/context/deadline are present, no blocked code exists, and `server_now <= revertible_until`; return `expired`, `blocked` or `unsupported` otherwise. For `reverted`, always return `result_status=reverted` and `revert_availability=reverted`. Failed Operations never claim revert support.

Serialize with an explicit dictionary, never `model.__dict__`:

```python
def serialize_ai_operation_result_projection(
    projection: AIOperationResultProjection,
) -> dict[str, Any]:
    encoded = jsonable_encoder(projection)
    return {field: encoded[field] for field in PUBLIC_RESULT_FIELDS}
```

Build one card ID and one Artifact ID per Draft:

```python
def build_operation_result_card(
    projection: AIOperationResultProjection,
    *,
    title: str,
    workspace_label: str,
) -> dict[str, Any]:
    return {
        "id": f"operation-result:{projection.draft_id}",
        "type": "operation_result",
        "title": title,
        "data": {
            **serialize_ai_operation_result_projection(projection),
            "workspaceLabel": workspace_label,
            "workspaceHint": f"可前往{workspace_label}查看",
        },
    }

def operation_result_artifacts(
    projection: AIOperationResultProjection,
    *,
    card: dict[str, Any],
) -> tuple[dict[str, Any], ...]:
    return ({
        "id": f"ai_operation_result:{projection.draft_id}",
        "type": "ai_operation_result",
        "kind": "operation_result",
        "version": 1,
        "status": projection.result_status,
        "sourceDraftId": projection.draft_id,
        "sourceOperationId": projection.operation_id,
        "payload": card,
    },)
```

`upsert_message_operation_result` finds an existing `result_card` by `card.data.draft_id`; it retains the message-part ID and replaces the card and matching metadata Artifact. If absent, it creates one part after the matching Approval for manual execution or appends it for policy routes. Remove approval-only assumptions from the old builder, but preserve approval IDs as optional display metadata for existing clients.

Treat `server_now` as hydration-only transport data. `upsert_message_operation_result` may persist the commit-time projection, but `serialize_ai_message(item, *, response_now: datetime | None = None)` and all response/event/operation-result-Artifact projection helpers must call `hydrate_operation_result_server_now(part, response_now)` on a copied payload; the optional default captures a fresh UTC time for existing single-message callers. `list_ai_messages` captures `response_now` once and passes that same value to every serialized message/card in the response. Revert and approval responses use their post-commit response time. Never write the refreshed clock back during a GET, and never use the historical stored value as the frontend offset source.

`DraftCommitCoordinator` and `DraftRoutingCoordinator` persist projection, part and Artifact inside the transaction. When the caller is the still-active chat stream, after commit the publisher emits a response-hydrated copy of the persisted part through the existing envelope:

```python
{
    "event": "message_part",
    "data": {
        "message_id": message.id,
        "conversation_id": message.conversation_id,
        "run_id": message.run_id,
        "part": result_part,
    },
}
```

This must flow through the current `aiApi.streamAiResponse` `onMessagePart` handler and `AiWorkspace.applyStreamPart`, whose stable card ID replaces an earlier result part. Manual approval and revert are not active chat generators: their HTTP response carries the equivalent hydrated result card/part, the caller applies it, and AI queries are invalidated for other views. `no_change` always passes only `("ai_conversation",)`; real writes use the receipt scopes. Operation serialization and response schemas use the same whitelist.

- [ ] **Step 4: Run projection, streaming and existing card tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_operation_result_projection.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_approvals.py -q`

Expected: PASS; manual cards still render, automatic/no-change results are durable, ordinary mutations do not claim nonexistent SSE broadcast, delayed refresh receives a fresh clock, and no private audit data appears in client DTOs or SSE.

- [ ] **Step 5: Commit the unified result contract**

```bash
git add backend/app/services/ai_operations/result_projection.py backend/app/services/ai_operations/artifacts.py backend/app/services/ai_operations/messages.py backend/app/services/ai_operations/commit_coordinator.py backend/app/services/ai_operations/routing.py backend/app/services/serializers.py backend/app/schemas/ai.py backend/app/schemas/ai_auto_execution.py backend/app/api/ai.py backend/app/ai/workflows/runner_support/message_parts.py backend/app/ai/workflows/runner_support/progressive_draft_publisher.py backend/tests/ai_infra/test_ai_operation_result_projection.py
git commit -m "feat: unify AI operation result projection"
```

### Task 10: Generic revert registry, coordinator, API and idempotency

**Files:**
- Create: `backend/app/services/ai_revert/__init__.py`
- Create: `backend/app/services/ai_revert/types.py`
- Create: `backend/app/services/ai_revert/errors.py`
- Create: `backend/app/services/ai_revert/registry.py`
- Create: `backend/app/services/ai_revert/coordinator.py`
- Modify: `backend/app/api/ai_auto_execution.py`
- Create: `backend/tests/ai_infra/test_ai_revert_coordinator.py`
- Modify: `backend/app/repos/ai_operations.py`
- Modify: `backend/app/schemas/ai_auto_execution.py`
- Modify: `backend/app/api/router.py`
- Modify: `backend/app/services/ai_operations/result_projection.py`
- Modify: `backend/app/services/ai_operations/messages.py`

**Interfaces:**
- Consumes: `AIRevertContext`, `AIRevertResult`, `AIRevertAdapter`, `AIRevertResponse`, Task 9 projection/upsert functions and family-scoped current authentication.
- Produces: `AIRevertAdapterRegistry.register(adapter)`, `AIRevertAdapterRegistry.require(key)`, and `AIRevertCoordinator.revert(...) -> AIRevertResponse`; public `POST /api/ai/operations/{operation_id}/revert`.

- [ ] **Step 1: Write failing coordinator, permission, boundary and request-ID tests**

Use a fake adapter that records calls and can raise a permanent target/dependency conflict or a transient database error.

```python
def test_revert_deadline_is_inclusive(self) -> None:
    operation = completed_operation(revertible_until=self.now)
    response = self.coordinator.revert(
        self.db,
        family_id=self.family.id,
        actor_user_id=self.actor.id,
        actor_role=UserRole.MEMBER,
        operation_id=operation.id,
        client_request_id="revert-1",
        now=self.now,
    )
    self.assertEqual(response.projection.result_status, "reverted")

def test_same_request_replays_without_second_adapter_call(self) -> None:
    first = self.revert("operation-1", "request-1")
    second = self.revert("operation-1", "request-1")
    self.assertTrue(second.replayed)
    self.assertEqual(second.result_card, first.result_card)
    self.assertEqual(self.adapter.call_count, 1)

def test_request_id_cannot_move_between_operations(self) -> None:
    self.revert("operation-1", "request-1")
    with self.assertRaisesRegex(AIRevertError, "revert_request_id_reused"):
        self.revert("operation-2", "request-1")

def test_permanent_conflict_is_recorded_but_transient_error_is_not(self) -> None:
    with self.assertRaises(AIRevertTargetChanged):
        self.revert("operation-permanent", "request-permanent")
    self.assertEqual(load_operation("operation-permanent").revert_blocked_code, "revert_target_changed")
    with self.assertRaises(OperationalError):
        self.revert("operation-transient", "request-transient")
    self.assertIsNone(load_operation("operation-transient").revert_blocked_code)
```

Also cover: cross-family 404, original actor, current Owner, other member 403, actor who left the family, `now > revertible_until`, missing adapter, unsupported context schema version, already blocked, all-or-nothing nested rollback, Draft status update, activity log, message/Artifact replacement and a post-commit HTTP response containing the updated result card/part, scopes and fresh response clock. Assert the ordinary revert route does not attempt to publish into the chat SSE generator. Add explicit cases where an unauthorized member reuses the original actor's successful or permanently blocked request ID: both must fail permission before any replay payload or global request-ID result is returned.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_revert_coordinator.py -q`

Expected: FAIL because there is no generic adapter registry or AI Operation revert endpoint.

- [ ] **Step 3: Implement stable errors, registry and transaction coordinator**

Define stable error semantics:

```python
class AIRevertError(ValueError):
    def __init__(
        self, code: str, message: str, *,
        status_code: int = 409,
        permanent_block: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.permanent_block = permanent_block

ERRORS = {
    "operation_not_revertible": (409, False),
    "revert_expired": (409, False),
    "revert_forbidden": (403, False),
    "revert_target_changed": (409, True),
    "revert_dependency_exists": (409, True),
    "revert_adapter_version_unsupported": (409, True),
    "revert_request_id_reused": (409, False),
}
```

The registry accepts one adapter per exact key and rejects duplicate key/schema pairs:

```python
class AIRevertAdapterRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, AIRevertAdapter] = {}

    def register(self, adapter: AIRevertAdapter) -> None:
        if adapter.key in self._adapters:
            raise ValueError(f"duplicate AI revert adapter: {adapter.key}")
        self._adapters[adapter.key] = adapter

    def require(self, key: str) -> AIRevertAdapter:
        adapter = self._adapters.get(key)
        if adapter is None:
            raise ai_revert_error("operation_not_revertible")
        return adapter
```

Add repository methods with exact scopes and locks:

```python
def get_family_ai_operation_for_update(
    db: Session, *, family_id: str, operation_id: str,
) -> AIOperation | None: ...

def find_ai_operation_by_revert_request_id_for_update(
    db: Session, *, client_request_id: str,
) -> AIOperation | None: ...
```

`AIRevertCoordinator.revert` performs checks in this order:

1. family-scoped Operation load and `FOR UPDATE`;
2. original actor/current Owner permission;
3. global request-ID reuse check;
4. exact successful/permanent-result replay for the same Operation and request ID;
5. `status=completed`, adapter/context presence and no prior blocked state;
6. inclusive deadline check;
7. adapter key and `revert_context_json.schema_version == adapter.schema_version`;
8. adapter locks, validates and compensates all targets inside one nested transaction;
9. Operation `reverted`, Draft `reverted`, activity, result projection, message and Artifact update;
10. caller commit, then return the updated persisted result card/part, scopes and freshly hydrated `server_now` in the HTTP response; do not invoke a nonexistent cross-request SSE broadcaster.

The coordinator signature is fixed:

```python
class AIRevertCoordinator:
    @classmethod
    def revert(
        cls,
        db: Session,
        *,
        family_id: str,
        actor_user_id: str,
        actor_role: UserRole,
        operation_id: str,
        client_request_id: str,
        now: datetime,
    ) -> AIRevertResponse: ...
```

When an adapter raises `revert_target_changed`, `revert_dependency_exists` or `revert_adapter_version_unsupported`, roll back the nested compensation, store `revert_request_id`, `revert_blocked_at`, `revert_blocked_code` and a replay-safe result, rebuild the persisted card, and let the route commit before returning the structured 409. The 409 `detail` must contain `code`, `message`, and the same public `projection`, `result_card`, `cache_scopes`, `server_now`, `replayed` fields as a successful response so the client can replace the card immediately. Do not set blocked fields, consume the request ID or return a fabricated blocked projection for `OperationalError`, connection errors or transaction failures.

Define strict DTOs:

```python
class AIRevertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_request_id: str = Field(min_length=1, max_length=120)

class AIRevertResponseDTO(BaseModel):
    projection: AIOperationResultProjectionDTO
    result_card: dict[str, Any]
    cache_scopes: list[AICacheScope]
    server_now: datetime
    replayed: bool

class AIRevertConflictDetailDTO(AIRevertResponseDTO):
    code: Literal[
        "revert_target_changed",
        "revert_dependency_exists",
        "revert_adapter_version_unsupported",
    ]
    message: str
```

The API reads `user, membership = get_current_auth`, never accepts family/role/actor from the request, uses `commit_session`, and maps the seven stable errors without returning cross-family existence. It must not perform same-request replay or global request-ID lookup before coordinator permission validation. A permanent conflict is committed before the HTTP error is raised and returns the latest public blocked-card fields in `detail`; transient exceptions roll back. Register the router once in `backend/app/api/router.py`.

- [ ] **Step 4: Run coordinator, API and transaction tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_revert_coordinator.py backend/tests/ai_infra/test_ai_operation_result_projection.py backend/tests/ai_infra/test_workspace_approvals.py -q`

Expected: PASS; duplicate requests never repeat compensation, permanent conflicts survive refresh, and temporary failures leave the Operation retryable.

- [ ] **Step 5: Commit the generic revert foundation**

```bash
git add backend/app/services/ai_revert backend/app/repos/ai_operations.py backend/app/api/ai_auto_execution.py backend/app/api/router.py backend/app/schemas/ai_auto_execution.py backend/app/services/ai_operations/result_projection.py backend/app/services/ai_operations/messages.py backend/tests/ai_infra/test_ai_revert_coordinator.py
git commit -m "feat: add AI operation revert coordinator"
```

### Task 11: Favorite, rating, shopping and simple-plan revert adapters

**Files:**
- Create: `backend/app/services/ai_revert/adapters/__init__.py`
- Create: `backend/app/services/ai_revert/adapters/food_favorite.py`
- Create: `backend/app/services/ai_revert/adapters/meal_rating.py`
- Create: `backend/app/services/ai_revert/adapters/shopping_safe_write.py`
- Create: `backend/app/services/ai_revert/adapters/simple_plan.py`
- Create: `backend/tests/ai_infra/test_ai_revert_low_risk_adapters.py`
- Modify: `backend/app/services/ai_revert/registry.py`
- Modify: `backend/app/services/ai_operations/foods.py`
- Modify: `backend/app/services/ai_operations/meal_logs.py`
- Modify: `backend/app/services/ai_operations/shopping.py`
- Modify: `backend/app/services/ai_operations/meal_plans.py`
- Modify: `backend/app/services/ai_operations/registry_specs.py`

**Interfaces:**
- Consumes: Task 10 `AIRevertAdapter` protocol/coordinator, Task 6 receipts, current domain lock/version helpers and Task 5 action allowlists.
- Produces: registered `food.favorite.v1`, `meal_log.rating.v1`, `shopping_list.safe_write.v1`, `meal_plan.simple_create.v1`; exact action handlers attach versioned minimal contexts to `DraftExecutionReceipt`.

- [ ] **Step 1: Write failing receipt-context and compensation tests**

For every adapter, execute the real AI handler, inspect the receipt context, then revert through `AIRevertCoordinator`. Do not seed a context directly in success tests.

```python
@pytest.mark.parametrize(
    ("fixture_name", "adapter_key"),
    [
        ("favorite", "food.favorite.v1"),
        ("rating_batch", "meal_log.rating.v1"),
        ("shopping_add", "shopping_list.safe_write.v1"),
        ("shopping_update", "shopping_list.safe_write.v1"),
        ("shopping_restore", "shopping_list.safe_write.v1"),
        ("simple_plan", "meal_plan.simple_create.v1"),
    ],
)
def test_handler_receipt_can_be_reverted_atomically(
    operation_fixture, fixture_name, adapter_key
):
    committed = operation_fixture.commit(fixture_name)
    assert committed.receipt.revert_adapter_key == adapter_key
    assert committed.receipt.revert_context["schema_version"] == 1
    reverted = operation_fixture.revert(committed.operation_id)
    assert reverted.projection.result_status == "reverted"
    operation_fixture.assert_domain_state_restored(fixture_name)

def test_shopping_batch_conflict_restores_nothing(operation_fixture):
    committed = operation_fixture.commit("shopping_add_three")
    operation_fixture.edit_shopping_item(committed.receipt.entity_ids[1])
    with pytest.raises(AIRevertError, match="revert_target_changed"):
        operation_fixture.revert(committed.operation_id)
    operation_fixture.assert_all_three_items_still_exist()
```

Cover original actor and Owner through the coordinator; for each adapter separately cover row-version/current-value changes, missing targets, dependency changes and stable ID lock order. Shopping tests cover all three modes and ensure created items used for inventory cannot be deleted. Plan tests require every item to remain `planned`, `meal_log_id=None`, unchanged and dependency-free. Rating tests verify all old ratings, including `None`, are restored and the MealLog parent version is bumped exactly once.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_revert_low_risk_adapters.py -q`

Expected: FAIL because handlers do not capture pre/post versions and the adapters are not registered.

- [ ] **Step 3: Capture minimal contexts and implement conditional compensation**

Use these exact private context shapes:

```python
FavoriteContext = {
    "schema_version": 1,
    "food_id": food.id,
    "before_favorite": before_favorite,
    "after_favorite": food.favorite,
    "after_row_version": food.row_version,
}

RatingContext = {
    "schema_version": 1,
    "meal_log_id": meal_log.id,
    "after_meal_log_row_version": meal_log.row_version,
    "entries": [
        {
            "meal_log_food_id": entry.id,
            "before_rating": before_rating,
            "after_rating": entry.rating,
        }
        for entry, before_rating in changed_entries
    ],
}

ShoppingContext = {
    "schema_version": 1,
    "mode": "add" | "update" | "restore",
    "items": [
        {
            "shopping_item_id": item.id,
            "before": before_allowed_fields_or_none,
            "after": after_allowed_fields,
            "after_row_version": item.row_version,
        }
        for item in changed_items
    ],
}

SimplePlanContext = {
    "schema_version": 1,
    "items": [
        {
            "food_plan_item_id": item.id,
            "after_row_version": item.row_version,
        }
        for item in created_items
    ],
}
```

All lists are sorted by entity ID before persistence and locking. Context contains no display text, authorization, arbitrary submitted payload or unrelated entity fields.

Each handler reads the before state after acquiring its existing domain locks, performs the normal write, flushes to obtain server versions, and returns:

```python
DraftExecutionReceipt(
    business_entity=serialized_result,
    entity_ids=tuple(sorted(changed_ids)),
    cache_scopes=("food", "ai_conversation"),
    revert_adapter_key="food.favorite.v1",
    revert_context=FavoriteContext,
)
```

Use the corresponding scopes for rating `("meal_log", "ai_conversation")`, shopping `("shopping_list", "ai_conversation")`, and plans `("meal_plan", "ai_conversation")`. Only exact eligible actions receive an adapter; mixed/complex manual Drafts keep `None`.

Adapter rules:

- Favorite: lock family Food, compare row version and current favorite with both after values, then restore the before value through the normal version/activity path.
- Rating: lock Food targets then MealLog using the existing ordering, verify parent version and each entry ownership/current rating, restore all ratings, then bump the MealLog collection exactly once.
- Shopping add: verify every created row is unchanged, pending and not referenced by intake; delete all only after every check passes.
- Shopping update: restore only quantity, unit and notes after exact version/value checks.
- Shopping restore: require current `done=false`, then restore `done=true`.
- Simple plan: lock all rows by ID, require unchanged version, `status=planned`, `meal_log_id=None` and no downstream references; delete as one unit and enqueue the existing search-index cleanup/update.

Map a changed/missing/version mismatch to `revert_target_changed`; map intake, completed plan or other downstream use to `revert_dependency_exists`. Never mutate before every row in the batch has passed validation. Add all four adapters to one `build_ai_revert_adapter_registry()` bootstrap and assert unique keys.

- [ ] **Step 4: Run adapter, domain and coordinator tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_revert_low_risk_adapters.py backend/tests/ai_infra/test_ai_revert_coordinator.py backend/tests/shopping/test_shopping_list_api.py backend/tests/meal_logs/test_meal_logs.py -q`

Expected: PASS; all four adapter families compensate atomically and unrelated manual Draft shapes remain explicitly unsupported.

- [ ] **Step 5: Commit low-risk domain adapters**

```bash
git add backend/app/services/ai_revert/adapters backend/app/services/ai_revert/registry.py backend/app/services/ai_operations/foods.py backend/app/services/ai_operations/meal_logs.py backend/app/services/ai_operations/shopping.py backend/app/services/ai_operations/meal_plans.py backend/app/services/ai_operations/registry_specs.py backend/tests/ai_infra/test_ai_revert_low_risk_adapters.py
git commit -m "feat: add low risk AI revert adapters"
```

### Task 12: Simple meal creation through MealLogRecordOperation

**Files:**
- Create: `backend/app/services/ai_revert/adapters/simple_meal.py`
- Create: `backend/tests/ai_infra/test_ai_simple_meal_operation.py`
- Modify: `backend/app/schemas/meal_recording.py`
- Modify: `backend/app/services/meal_recording.py`
- Modify: `backend/app/repos/meal_log_record_operations.py`
- Modify: `backend/app/services/meal_log_record_history.py`
- Modify: `backend/app/services/ai_operations/meal_logs.py`
- Modify: `backend/app/services/ai_revert/registry.py`
- Modify: `backend/tests/meal_logs/test_meal_recording.py`
- Modify: `backend/tests/meal_logs/test_meal_record_revert.py`

**Interfaces:**
- Consumes: existing `record_meal`/`revert_record_operation`, Task 10 adapter protocol and the Task 5 `meal_log.simple_create` shape.
- Produces: `record_meal(..., revertible_until: datetime | None = None)`, a backward-compatible richer `RecordMealRequest`, and registered `meal_log.simple_create.v1` whose context references only the domain ledger ID.

- [ ] **Step 1: Write failing simple-meal ledger and deadline tests**

Prove the AI path uses the existing domain operation instead of parallel JSON snapshots, preserves explicitly supplied optional fields, and does not change page defaults.

```python
def test_simple_ai_meal_uses_one_hour_record_operation(self) -> None:
    committed_at = datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc)
    result = execute_simple_meal(
        notes="和家人一起吃",
        mood="开心",
        entries=[
            {"foodId": self.food.id, "servings": "1.5", "note": "少糖", "rating": "4.5"}
        ],
        committed_at=committed_at,
    )
    receipt = result.receipt
    self.assertEqual(receipt.revert_adapter_key, "meal_log.simple_create.v1")
    ledger = load_record_operation(receipt.revert_context["meal_log_record_operation_id"])
    self.assertEqual(ledger.revertible_until, committed_at + timedelta(hours=1))
    self.assertEqual(result.meal_log.notes, "和家人一起吃")
    self.assertEqual(result.meal_log.mood, "开心")
    self.assertEqual(result.meal_log.food_entries[0].rating, Decimal("4.5"))

def test_normal_quick_record_keeps_fifteen_minute_deadline(self) -> None:
    operation = record_from_page(now=self.now).operation
    self.assertEqual(operation.revertible_until, self.now + timedelta(minutes=15))
```

Also assert deterministic replay from the AI Draft idempotency key, no inline Food creation, no plan completion, no inventory deduction, current actor as sole participant, exact deadline boundary, parent/entry dependency conflicts and all-or-nothing revert.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_simple_meal_operation.py backend/tests/meal_logs/test_meal_recording.py -q`

Expected: FAIL because the current AI handler bypasses `MealLogRecordOperation`, and the quick-record schema cannot carry notes, mood or entry rating/note.

- [ ] **Step 3: Extend the domain ledger without changing existing callers**

Add bounded optional fields with empty defaults:

```python
class RecordMealEntryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    food_id: str | None = None
    client_food_id: str | None = None
    servings: Decimal = Field(gt=0)
    note: str = Field(default="", max_length=255)
    rating: Decimal | None = Field(default=None, ge=Decimal("0.5"), le=Decimal("5"))

class RecordMealRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_request_id: str = Field(min_length=1, max_length=120)
    date: date_type
    meal_type: MealType
    target: RecordMealTarget
    new_foods: list[RecordMealNewFoodIn] = Field(default_factory=list)
    entries: list[RecordMealEntryIn] = Field(min_length=1)
    plan_item_completions: list[RecordMealPlanCompletionIn] = Field(default_factory=list)
    notes: str = Field(default="", max_length=2000)
    mood: str = Field(default="", max_length=120)
```

Include these values in `canonical_record_request_hash`, build `MealEntryWrite(note, rating)`, and pass notes/mood to `create_meal_log_with_entries`. Existing page payloads validate to the same empty values.

Make the deadline explicit but optional:

```python
def claim_record_operation(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    client_request_id: str,
    request_hash: str,
    target_kind: MealLogRecordTargetKind | str,
    meal_log_id: str,
    now: datetime,
    revertible_until: datetime | None = None,
) -> tuple[MealLogRecordOperation, bool]:
    deadline = revertible_until or now + RECORD_REVERT_WINDOW
    if _as_aware(deadline) < _as_aware(now):
        raise ValueError("revertible_until 不能早于 applied_at")
    # Persist deadline on the newly claimed row; replay retains the original row.

def record_meal(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    request: RecordMealRequest,
    now: datetime,
    revertible_until: datetime | None = None,
) -> RecordMealResponse: ...
```

In the AI handler, route only the confirmed simple-create shape to `record_meal`: existing Foods only, at most five entries, new target, no plan completion, no stock/media/new Food, sole actor participant. Use `client_request_id=f"ai:{context.operation_idempotency_key}"`, `now=context.committed_at`, and `revertible_until=context.revertible_until`. Return:

```python
DraftExecutionReceipt(
    business_entity=response.meal_log.model_dump(mode="json"),
    entity_ids=(response.meal_log.id,),
    cache_scopes=("meal_log", "ai_conversation"),
    revert_adapter_key="meal_log.simple_create.v1",
    revert_context={
        "schema_version": 1,
        "meal_log_record_operation_id": response.operation.id,
    },
)
```

The adapter validates its schema and family, then delegates compensation to `revert_record_operation` using coordinator actor/role/time. Translate modified rows into `revert_target_changed` and completed-plan/media/inventory/downstream use into `revert_dependency_exists`; return the domain response entities and `("meal_log", "ai_conversation")`. Complex meal Drafts continue through their current handler with no adapter.

- [ ] **Step 4: Run simple meal, ledger and adapter tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_simple_meal_operation.py backend/tests/meal_logs/test_meal_recording.py backend/tests/meal_logs/test_meal_record_revert.py backend/tests/ai_infra/test_ai_revert_coordinator.py -q`

Expected: PASS; AI simple create has a one-hour domain ledger, normal quick record remains fifteen minutes, and richer explicit fields round-trip and revert.

- [ ] **Step 5: Commit the simple meal ledger integration**

```bash
git add backend/app/schemas/meal_recording.py backend/app/services/meal_recording.py backend/app/repos/meal_log_record_operations.py backend/app/services/meal_log_record_history.py backend/app/services/ai_operations/meal_logs.py backend/app/services/ai_revert/adapters/simple_meal.py backend/app/services/ai_revert/registry.py backend/tests/ai_infra/test_ai_simple_meal_operation.py backend/tests/meal_logs/test_meal_recording.py backend/tests/meal_logs/test_meal_record_revert.py
git commit -m "feat: ledger simple AI meal creation"
```

### Task 13: Inventory snapshot ledgers and `inventory.operation_ref.v1`

**Files:**
- Create: `backend/app/services/ai_revert/adapters/inventory_operation_ref.py`
- Create: `backend/tests/ai_infra/test_ai_inventory_operation_revert.py`
- Modify: `backend/app/repos/inventory_operations.py`
- Modify: `backend/app/services/inventory_operation_history.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/app/services/inventory_intake.py`
- Modify: `backend/app/services/inventory_reconciliation.py`
- Modify: `backend/app/services/ai_operations/inventory.py`
- Modify: `backend/app/services/ai_operations/inventory_intake.py`
- Modify: `backend/app/services/ai_revert/registry.py`
- Modify: `backend/tests/inventory/test_inventory_operation_history.py`
- Modify: `backend/tests/inventory/test_inventory_operation_revert.py`

**Interfaces:**
- Consumes: existing `InventoryOperation`, `InventoryOperationLine`, snapshot reverter, Task 6 receipt deadline and Task 10 adapter protocol.
- Produces: `apply_inventory_quantity_operation(...) -> InventoryOperation`, optional explicit `applied_at/revertible_until` on inventory claims, and registered `inventory.operation_ref.v1`.

- [ ] **Step 1: Write failing four-operation ledger and deadline tests**

Exercise the real AI manual-approval handlers for intake, reconciliation, direct consume and direct dispose. Each receipt must point to a domain ledger rather than embedding inventory snapshots in `AIOperation`.

```python
@pytest.mark.parametrize(
    "draft_fixture",
    ["inventory_intake", "inventory_reconciliation", "inventory_consume", "inventory_dispose"],
)
def test_confirmed_ai_inventory_write_uses_one_hour_snapshot_ledger(
    inventory_ai_fixture, draft_fixture
):
    committed_at = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
    result = inventory_ai_fixture.approve(draft_fixture, committed_at=committed_at)
    assert result.receipt.revert_adapter_key == "inventory.operation_ref.v1"
    operation_id = result.receipt.revert_context["inventory_operation_id"]
    ledger = inventory_ai_fixture.load_inventory_operation(operation_id)
    assert ledger.revertible_until == committed_at + timedelta(hours=1)
    assert ledger.operation_type.value in {"intake", "reconcile", "consume", "dispose"}
    assert ledger.lines

def test_page_inventory_operation_still_uses_fifteen_minutes(inventory_page_fixture):
    now = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
    operation = inventory_page_fixture.consume(now=now)
    assert operation.revertible_until == now + timedelta(minutes=15)
```

Also cover tracked and presence-only inventory, partial quantities, before/after snapshots, original actor/Owner, exact one-hour boundary, stale row version, downstream conflicts, batch atomicity, request replay, and normal-page 15-minute behavior for all four operation types.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_inventory_operation_revert.py backend/tests/inventory/test_inventory_operation_history.py backend/tests/inventory/test_inventory_operation_revert.py -q`

Expected: FAIL because direct consume/dispose do not consistently create snapshot ledgers and claims always derive a fifteen-minute deadline internally.

- [ ] **Step 3: Add explicit timing, snapshot-backed quantity mutations and the reference adapter**

Extend the existing claim without changing page callers:

```python
def claim_inventory_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    operation_type: InventoryOperationType,
    client_request_id: str,
    request_hash: str,
    summary: InventoryOperationDisplaySummary,
    applied_at: datetime | None = None,
    revertible_until: datetime | None = None,
) -> tuple[InventoryOperation, bool]:
    effective_applied_at = applied_at or utcnow()
    deadline = revertible_until or effective_applied_at + timedelta(minutes=15)
    if _as_aware(deadline) < _as_aware(effective_applied_at):
        raise ValueError("revertible_until 不能早于 applied_at")
    # Persist the supplied timing only for a newly claimed row.
```

Intake and reconciliation accept the same two optional keyword arguments and pass them to the claim. Replays retain the original timing. Add one quantity-mutation entry point:

```python
def apply_inventory_quantity_operation(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    operation_type: Literal["consume", "dispose"],
    ingredient_id: str,
    inventory_item_id: str | None,
    quantity: Decimal | None,
    unit: str | None,
    client_request_id: str,
    now: datetime,
    revertible_until: datetime | None = None,
) -> InventoryOperation:
    request_hash = hash_inventory_quantity_request(
        operation_type=operation_type,
        ingredient_id=ingredient_id,
        inventory_item_id=inventory_item_id,
        quantity=quantity,
        unit=unit,
    )
    operation, created = claim_inventory_operation(
        db,
        family_id=family_id,
        actor_id=actor_user_id,
        operation_type=InventoryOperationType(operation_type),
        client_request_id=client_request_id,
        request_hash=request_hash,
        summary=build_quantity_operation_summary(operation_type, quantity, unit),
        applied_at=now,
        revertible_until=revertible_until,
    )
    if not created:
        return operation
    return _apply_quantity_change_and_record_lines(
        db,
        operation=operation,
        family_id=family_id,
        actor_user_id=actor_user_id,
        ingredient_id=ingredient_id,
        inventory_item_id=inventory_item_id,
        quantity=quantity,
        unit=unit,
        now=now,
    )
```

`_apply_quantity_change_and_record_lines` uses the existing inventory lock order. It captures every affected Ingredient, InventoryItem, presence state and Food before mutation; applies the current consume/dispose service; flushes; then records after snapshots and row versions through `record_operation_line`. Sort line targets before locks and assign stable sequence numbers. Replay returns the saved result without a second mutation.

For each AI intake, reconciliation, standalone consume or standalone dispose handler, pass `context.committed_at` and `context.revertible_until`, then return:

```python
DraftExecutionReceipt(
    business_entity=serialized_inventory_result,
    entity_ids=tuple(sorted(affected_entity_ids)),
    cache_scopes=("inventory", "ai_conversation"),
    revert_adapter_key="inventory.operation_ref.v1",
    revert_context={
        "schema_version": 1,
        "inventory_operation_id": inventory_operation.id,
    },
)
```

Do not attach this adapter to recipe cooking, composite operations, hard deletion or a continuation. These four Draft paths remain `draft_then_confirm`; this task adds undo after genuine confirmation, not automatic execution.

`InventoryOperationRefAdapter` validates schema/family and delegates to `revert_inventory_operation` using coordinator actor, role and time. Translate modified/missing snapshots to `revert_target_changed`, and later consumption, disposal, intake use or other dependent records to `revert_dependency_exists`. Return the serialized restored entities and scopes `("inventory", "ai_conversation")`.

- [ ] **Step 4: Run inventory ledger, AI adapter and existing page tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_inventory_operation_revert.py backend/tests/inventory/test_inventory_operation_history.py backend/tests/inventory/test_inventory_operation_revert.py backend/tests/inventory/test_inventory_intake_service.py backend/tests/inventory/test_inventory_reconciliation_api.py backend/tests/ai_infra/test_ai_inventory_intake.py -q`

Expected: PASS; all four AI-confirmed inventory operations have one-hour atomic compensation, while normal page operations keep fifteen minutes.

- [ ] **Step 5: Commit inventory ledger integration**

```bash
git add backend/app/repos/inventory_operations.py backend/app/services/inventory_operation_history.py backend/app/services/inventory_operations.py backend/app/services/inventory_intake.py backend/app/services/inventory_reconciliation.py backend/app/services/ai_operations/inventory.py backend/app/services/ai_operations/inventory_intake.py backend/app/services/ai_revert/adapters/inventory_operation_ref.py backend/app/services/ai_revert/registry.py backend/tests/ai_infra/test_ai_inventory_operation_revert.py backend/tests/inventory/test_inventory_operation_history.py backend/tests/inventory/test_inventory_operation_revert.py
git commit -m "feat: link AI inventory writes to snapshot ledgers"
```

### Task 14: `draft_then_policy` Skill contract and controlled activation

**Files:**
- Create: `backend/tests/ai_infra/test_ai_draft_then_policy_contract.py`
- Modify: `backend/app/ai/skills/base.py`
- Modify: `backend/app/ai/skills/loader.py`
- Modify: `backend/app/ai/skills/catalog/food-profile/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/food-profile/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/meal-record/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/meal-record/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/meal-planning/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/meal-planning/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/shopping-list/skill.yaml`
- Modify: `backend/app/ai/skills/catalog/shopping-list/SKILL.md`
- Modify: `backend/tests/ai_infra/test_skill_loader.py`
- Modify: `backend/tests/ai_infra/test_skill_contract_v3.py`
- Modify: `backend/tests/ai_infra/test_tool_registry.py`
- Modify: `backend/tests/ai_infra/_support.py`
- Modify: `backend/app/ai/evals/models.py`
- Modify: `backend/app/ai/evals/scoring.py`
- Modify: `backend/tests/ai_evals/cases/core.jsonl`
- Modify: `backend/tests/ai_evals/test_eval_dataset.py`
- Modify: `backend/tests/ai_evals/test_eval_scoring.py`

**Interfaces:**
- Consumes: fully registered policy and revert registries from Tasks 4–13, existing Skill draft contracts and Draft Tools whose `requires_confirmation=True`.
- Produces: approval policy enum `none | draft_then_confirm | draft_then_policy`; loader rejects policy routing unless the server registry supports every declared Draft type.

- [ ] **Step 1: Write failing loader, Tool and default-off routing tests**

```python
POLICY_SKILLS = {
    "food_profile": "food_profile",
    "meal_log": "meal_log",
    "meal_plan": "meal_plan",
    "shopping_list": "shopping_list",
}

def test_policy_skills_keep_draft_tools_at_commit_gate(skill_registry, tool_registry):
    for skill_key, draft_type in POLICY_SKILLS.items():
        skill = skill_registry.get(skill_key)
        assert skill.manifest.approval_policy == "draft_then_policy"
        assert skill.manifest.draft_types == (draft_type,)
        draft_tools = [
            tool_registry.get(name)
            for name in skill.manifest.tools
            if tool_registry.get(name).draft_type == draft_type
        ]
        assert draft_tools
        assert all(tool.requires_confirmation for tool in draft_tools)

def test_loader_rejects_policy_skill_without_registered_server_policy(tmp_path):
    write_skill_manifest(
        tmp_path,
        approval_policy="draft_then_policy",
        draft_type="unregistered_draft",
    )
    with pytest.raises(ValueError, match="no registered auto-execution policy"):
        load_skill_catalog(tmp_path, auto_execution_policy_registry=empty_policy_registry())

def test_policy_skill_still_waits_when_member_authorization_is_absent(runtime_fixture):
    result = runtime_fixture.run_explicit_favorite(member_preference=None)
    assert result.status == "waiting_approval"
    assert result.approval_count == 1
    assert result.business_write_count == 0
```

Also assert `none` still forbids Drafts, `draft_then_confirm` behavior is unchanged, a `draft_then_policy` manifest without a draft contract fails, a policy Draft Tool with `requires_confirmation=False` fails, and no formal write Tool enters the model registry. Render each selected Skill with its Draft Tool schema and assert the model-visible text contains all four clarity definitions, the distinction between a factual statement and an explicit write request, and the instruction to populate `intentEvidence` without inventing missing facts.

- [ ] **Step 2: Run tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_then_policy_contract.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_tool_registry.py -q`

Expected: FAIL because the loader only accepts `none | draft_then_confirm` and the four manifests still use universal confirmation.

- [ ] **Step 3: Extend the manifest contract and activate only four Skills**

Update the manifest projection without weakening the Tool gate:

```python
SkillApprovalPolicy = Literal["none", "draft_then_confirm", "draft_then_policy"]

@property
def requires_approval(self) -> bool:
    return self.approval_policy in {"draft_then_confirm", "draft_then_policy"}

def validate_policy_manifest(
    manifest: SkillManifest,
    *,
    auto_execution_policy_registry: AutoExecutionPolicyRegistry,
    tool_registry: ToolRegistry,
) -> None:
    if manifest.approval_policy != "draft_then_policy":
        return
    if not manifest.draft_types or not manifest.draft_contract:
        raise ValueError(f"Skill {manifest.key} policy routing requires a draft contract")
    for draft_type in manifest.draft_types:
        if not auto_execution_policy_registry.supports_draft_type(draft_type):
            raise ValueError(
                f"Skill {manifest.key} has no registered auto-execution policy for {draft_type}"
            )
    draft_tools = [
        tool_registry.get(name)
        for name in manifest.tools
        if tool_registry.get(name).draft_type in manifest.draft_types
    ]
    if not draft_tools or any(not definition.requires_confirmation for definition in draft_tools):
        raise ValueError(f"Skill {manifest.key} policy Draft Tools must require confirmation")
```

`BaseSkill.to_public_dict()` sets `requiresApproval=True` for both Draft policies and includes the exact `approvalPolicy`. Wire the registry into `load_skill_catalog`; production startup uses the complete immutable registry, while tests can inject an empty or partial registry.

Change these manifest values:

```yaml
# food-profile/skill.yaml
approval_policy: draft_then_policy
# meal-record/skill.yaml
approval_policy: draft_then_policy
# meal-planning/skill.yaml
approval_policy: draft_then_policy
# shopping-list/skill.yaml
approval_policy: draft_then_policy
```

Update the corresponding four `SKILL.md` files with a short shared contract: when calling the Draft Tool, populate optional `intentEvidence` using the four definitions exposed in the Tool schema; quote only the current user message; use `resolutionSources` only for the current UI, this run's Tool output or a successfully read Artifact; put ambiguity/defaults in their explicit arrays; never label a factual statement, praise or possible plan as an execution request. Do not duplicate a divergent definition table in each Skill—the exact definitions remain owned by `INTENT_CLARITY_MODEL_DESCRIPTION` in Task 3 and are rendered with the Tool schema.

All other Skills remain unchanged. Routing still sends non-whitelisted actions, unauthorized members, Composite and Continuation to manual confirmation.

Because evidence no longer lives inside the normalized business Draft, extend the eval contract instead of putting it back into `draftPayload`: `SkillEvalCase.expectedIntentEvidenceValues` and `SkillEvalObservation.intentEvidence` are optional dictionaries, `_support.py` reads the latter from the persisted `AITaskDraft.intent_evidence_json`, and scoring compares those paths separately from `expectedDraftValues`. Existing eval JSON remains valid through empty defaults.

```python
class SkillEvalCase(BaseModel):
    expectedIntentEvidenceValues: dict[str, Any] = Field(default_factory=dict)

class SkillEvalObservation(BaseModel):
    intentEvidence: dict[str, Any] = Field(default_factory=dict)
```

Extend `core.jsonl` with explicit evidence cases for favorite, rating, shopping add, simple meal and simple plan, plus one inferred-language rejection. Each case asserts the exact `intentClarity` and source quote through `expectedIntentEvidenceValues`; because test fixtures have no preferences, all six still end at `waiting_approval`. Update the dataset count and required IDs:

```python
AUTO_EXECUTION_EVAL_IDS = {
    "food.favorite_explicit",
    "meal.rating_explicit",
    "shopping.safe_add_explicit",
    "meal.simple_create_explicit",
    "meal_plan.simple_create_explicit",
    "food.favorite_inferred",
}

def test_core_dataset_has_auto_execution_intent_coverage():
    cases = load_eval_cases(CORE_CASES)
    by_id = {case.id: case for case in cases}
    assert AUTO_EXECUTION_EVAL_IDS <= set(by_id)
    assert all(by_id[case_id].expectedTerminalStatus == "waiting_approval"
               for case_id in AUTO_EXECUTION_EVAL_IDS)
    assert by_id["food.favorite_inferred"].expectedIntentEvidenceValues[
        "normalized_evidence.intentClarity"
    ] == "inferred"
```

The explicit cases use `explicit_complete`, except the unique current-card favorite case uses `explicit_context_resolved`. The inferred case must never become an auto candidate.

- [ ] **Step 4: Run loader, Runtime contract and eval tests**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_draft_then_policy_contract.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_evals/test_eval_dataset.py backend/tests/ai_evals/test_eval_scoring.py backend/tests/ai_evals/test_skill_scenarios.py -q`

Expected: PASS; the four Skills can reach server policy routing, authorization remains default-off, and every Draft Tool still stops at the server commit gate.

- [ ] **Step 5: Commit the controlled activation**

```bash
git add backend/app/ai/skills/base.py backend/app/ai/skills/loader.py backend/app/ai/skills/catalog/food-profile/skill.yaml backend/app/ai/skills/catalog/food-profile/SKILL.md backend/app/ai/skills/catalog/meal-record/skill.yaml backend/app/ai/skills/catalog/meal-record/SKILL.md backend/app/ai/skills/catalog/meal-planning/skill.yaml backend/app/ai/skills/catalog/meal-planning/SKILL.md backend/app/ai/skills/catalog/shopping-list/skill.yaml backend/app/ai/skills/catalog/shopping-list/SKILL.md backend/app/ai/evals/models.py backend/app/ai/evals/scoring.py backend/tests/ai_infra/_support.py backend/tests/ai_infra/test_ai_draft_then_policy_contract.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_skill_contract_v3.py backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_evals/cases/core.jsonl backend/tests/ai_evals/test_eval_dataset.py backend/tests/ai_evals/test_eval_scoring.py
git commit -m "feat: enable server policy routing for selected AI skills"
```

### Task 15: Frontend contracts, API methods, query keys and scope-driven invalidation

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/aiApi.ts`
- Modify: `frontend/src/api/aiApi.test.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`

**Interfaces:**
- Consumes: exact Task 2 settings DTOs, Task 9 `AIOperationResultProjection` fields and Task 10 revert response.
- Produces: typed settings/revert API methods, `queryKeys.aiAutoExecutionSettings(familyId)`, and `invalidateAfterAiOperationSettled(queryClient, input)`.

- [ ] **Step 1: Write failing API and cache-scope tests**

```typescript
it('sends current row version and receives the complete settings envelope', async () => {
  mockFetchOnce(settingsResponse());
  const response = await aiApi.updateAiAutoExecutionPreference('food.set_favorite', {
    enabled: true,
    expected_row_version: 2,
    consent_notice_version: 'auto-execution-consent.v1',
  });
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/ai/auto-execution/preferences/food.set_favorite'),
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        expected_row_version: 2,
        consent_notice_version: 'auto-execution-consent.v1',
      }),
    }),
  );
  expect(response.member_preferences).toHaveLength(5);
  expect(response.consent_notice.version).toBe('auto-execution-consent.v1');
});

it('posts an idempotent operation revert request', async () => {
  mockFetchOnce(revertResponse());
  await aiApi.revertAiOperation('operation-1', { client_request_id: 'request-1' });
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/ai/operations/operation-1/revert'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ client_request_id: 'request-1' }),
    }),
  );
});

it('no-change scopes invalidate only AI conversation data', async () => {
  await invalidateAfterAiOperationSettled(queryClient, {
    conversationId: 'conversation-1',
    cacheScopes: ['ai_conversation'],
  });
  expect(invalidatedKeys()).toEqual(expect.arrayContaining([
    queryKeys.aiMessages('conversation-1'),
    queryKeys.aiConversations,
  ]));
  expect(invalidatedKeys()).not.toContainEqual(queryKeys.foods);
  expect(invalidatedKeys()).not.toContainEqual(queryKeys.mealLogs);
});
```

Parameterize all six cache scopes; verify deduplication, inventory uses the complete inventory-operation invalidation set, and business scopes never omit the AI message/conversation refresh supplied by `ai_conversation`. Assert `queryKeys.aiAutoExecutionSettings('family-a')` and `queryKeys.aiAutoExecutionSettings('family-b')` differ. Mock a permanent 409 whose `detail` contains the latest blocked projection/card/scopes and assert the typed conflict parser accepts it while rejecting incomplete/transient payloads. Feed a persisted `operation_result` part through a streamed `message_part` fixture and assert the existing `onMessagePart` callback receives it; no new top-level operation event parser is added.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm --prefix frontend test -- --run src/api/aiApi.test.ts src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts`

Expected: FAIL because the settings/revert methods, query key and scope-driven invalidator do not exist.

- [ ] **Step 3: Add strict cross-end types and API calls**

Add the fixed result types from Stable Cross-Task Interfaces plus settings:

```typescript
export interface AiAutoExecutionSettingRow {
  action_key: AiAutoExecutionActionKey;
  enabled: boolean;
  effective_enabled: boolean;
  row_version: number;
  consent_notice_version: string | null;
  requires_reconsent: boolean;
}

export interface AiAutoExecutionSettings {
  catalog_version: string;
  consent_notice: {
    version: string;
    acknowledged: boolean;
  };
  member_preferences: AiAutoExecutionSettingRow[];
  family_policies: AiAutoExecutionSettingRow[];
  limits: Record<string, Record<string, number>>;
  server_now: string;
}

export interface AiAutoExecutionUpdate {
  enabled: boolean;
  expected_row_version: number;
  consent_notice_version?: string;
}

export interface AiOperationRevertResponse {
  projection: AiOperationResultProjection;
  result_card: AiResultCard;
  cache_scopes: AiCacheScope[];
  server_now: string;
  replayed: boolean;
}

export interface AiOperationRevertConflict extends AiOperationRevertResponse {
  code:
    | 'revert_target_changed'
    | 'revert_dependency_exists'
    | 'revert_adapter_version_unsupported';
  message: string;
}
```

Make `AiResultCard.data` include the projection fields directly for `type=operation_result`; do not introduce a second renamed projection. Keep legacy optional display keys during migration, but all state decisions use `result_status`, `execution_mode`, `revert_availability`, `revertible_until`, `revert_blocked_code` and `server_now`.

Add exact API methods:

```typescript
getAiAutoExecutionSettings: () =>
  aiRequest<AiAutoExecutionSettings>('/api/ai/auto-execution/settings'),
updateAiAutoExecutionPreference: (
  actionKey: AiAutoExecutionActionKey,
  payload: AiAutoExecutionUpdate,
) => aiRequest<AiAutoExecutionSettings>(
  `/api/ai/auto-execution/preferences/${encodeURIComponent(actionKey)}`,
  { method: 'PUT', body: JSON.stringify(payload) },
),
updateAiAutoExecutionFamilyPolicy: (
  actionKey: AiAutoExecutionActionKey,
  payload: AiAutoExecutionUpdate,
) => aiRequest<AiAutoExecutionSettings>(
  `/api/ai/auto-execution/family-policies/${encodeURIComponent(actionKey)}`,
  { method: 'PUT', body: JSON.stringify(payload) },
),
revertAiOperation: (
  operationId: string,
  payload: { client_request_id: string },
) => aiRequest<AiOperationRevertResponse>(
  `/api/ai/operations/${encodeURIComponent(operationId)}/revert`,
  { method: 'POST', body: JSON.stringify(payload) },
),
```

Add `queryKeys.aiAutoExecutionSettings = (familyId: string) => ['ai-auto-execution-settings', familyId] as const`; an empty or implicit family key is not allowed. Add a narrow `aiOperationRevertConflictFromError(error)` parser that accepts only a 409 `ApiError.payload.detail` with one of the three permanent codes and a complete public projection/card/scopes payload. Implement one invalidator with explicit scope mappings:

```typescript
export async function invalidateAfterAiOperationSettled(
  queryClient: QueryClient,
  input: { conversationId: string; cacheScopes: AiCacheScope[] },
) {
  const scopes = new Set(input.cacheScopes);
  const tasks: Promise<unknown>[] = [];
  if (scopes.has('food')) tasks.push(invalidateAfterFoodChanged(queryClient));
  if (scopes.has('meal_log')) tasks.push(invalidateAfterMealLogChanged(queryClient));
  if (scopes.has('meal_plan')) tasks.push(invalidateAfterFoodPlanChanged(queryClient));
  if (scopes.has('shopping_list')) tasks.push(invalidateAfterShoppingChanged(queryClient));
  if (scopes.has('inventory')) tasks.push(invalidateAfterInventoryOperation(queryClient));
  if (scopes.has('ai_conversation')) {
    tasks.push(invalidateMany(queryClient, [
      queryKeys.aiMessages(input.conversationId),
      queryKeys.aiPendingApprovals(input.conversationId),
      queryKeys.aiConversations,
      queryKeys.aiQualityMetrics,
    ]));
  }
  await Promise.all(tasks);
}
```

Do not infer scopes from entity labels or Draft types. Callers must use the server-returned scopes; `policy_no_change` therefore invalidates only AI data. The stream API continues to consume result updates through its existing `message_part` branch; tests lock this transport contract so adding new unhandled top-level SSE names is not an implementation option.

- [ ] **Step 4: Run API, query-key and invalidation tests**

Run: `npm --prefix frontend test -- --run src/api/aiApi.test.ts src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts`

Expected: PASS with exact URLs/bodies and no unrelated invalidation for `ai_conversation`-only results.

- [ ] **Step 5: Commit frontend contracts**

```bash
git add frontend/src/api/types.ts frontend/src/api/aiApi.ts frontend/src/api/aiApi.test.ts frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts
git commit -m "feat: add frontend AI execution contracts"
```

### Task 16: Auto-execution settings feature, navigation and responsive surfaces

**Files:**
- Create: `frontend/src/features/ai-auto-execution/aiAutoExecutionModel.ts`
- Create: `frontend/src/features/ai-auto-execution/aiAutoExecutionModel.test.ts`
- Create: `frontend/src/features/ai-auto-execution/useAiAutoExecutionSettings.ts`
- Create: `frontend/src/features/ai-auto-execution/useAiAutoExecutionSettings.test.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionSwitchRow.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionConsentDialog.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionSettingsView.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionSettingsView.test.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionDesktopPanel.tsx`
- Create: `frontend/src/features/ai-auto-execution/AiAutoExecutionMobilePage.tsx`
- Modify: `frontend/src/app/appNavigationModel.ts`
- Modify: `frontend/src/app/appNavigationModel.test.ts`
- Modify: `frontend/src/app/useAppNavigationState.ts`
- Modify: `frontend/src/app/useAppNavigationState.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Modify: `frontend/src/components/ai/AiMobilePage.tsx`
- Modify: `frontend/src/components/ai/AiMobilePage.test.tsx`
- Modify: `frontend/src/components/ai/AiMobileChrome.tsx`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Modify: `frontend/src/features/family/FamilySettings.test.tsx`
- Modify: `frontend/src/features/family/FamilyMobileView.tsx`
- Modify: `frontend/src/styles/09-ai-workspace.css`
- Modify: `frontend/src/styles/02-family-settings.css`

**Interfaces:**
- Consumes: Task 15 API/types/family-scoped query key, current `familyId` and membership role.
- Produces: `AiView = 'conversation' | 'autoExecution'`, `{ workspace: 'ai'; view?: AiView }`, settings state/actions and accessible desktop/mobile settings views.

Before editing UI, read `.agents/skills/frontend-ui-style/SKILL.md` and `.agents/skills/frontend-ui-engineering/SKILL.md` plus their routed references. Apply the existing token/component/responsive rules verbatim.

- [ ] **Step 1: Write failing navigation, settings and consent-flow tests**

```typescript
it('navigates the family shortcut to the AI settings view', () => {
  const next = reduceNavigation(initialNavigationState, {
    type: 'navigate',
    target: { workspace: 'ai', view: 'autoExecution' },
  });
  expect(next.primaryTab).toBe('ai');
  expect(next.ai.view).toBe('autoExecution');
});

it('requires consent before first enable and does not update optimistically', async () => {
  const user = userEvent.setup();
  const request = deferredPromise<AiAutoExecutionSettings>();
  api.updateAiAutoExecutionPreference.mockReturnValue(request.promise);
  renderSettings({ acknowledged: false });
  const control = screen.getByRole('switch', { name: '收藏状态' });
  await user.click(control);
  expect(screen.getByRole('dialog', { name: '开启自动执行' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '同意并开启' }));
  expect(control).toHaveAttribute('aria-checked', 'false');
  request.resolve(settingsResponse({ favoriteEnabled: true }));
  expect(await screen.findByRole('switch', { name: '收藏状态' }))
    .toHaveAttribute('aria-checked', 'true');
});

it('shows family shopping policy as read-only for members', () => {
  renderSettings({ isOwner: false, familyShoppingEnabled: false });
  const familySwitch = screen.getByRole('switch', {
    name: '允许家庭成员在规则内自动维护购物清单',
  });
  expect(familySwitch).toBeDisabled();
  expect(screen.getByText('需要家庭 Owner 先开放此能力')).toBeVisible();
});
```

Also cover: Owner editability, member shopping row disabled while family policy is off, re-consent on notice version change, immediate disable without dialog, only the active row disabled during PUT, 409 refetch/message, loading/error/retry, desktop panel, phone full-screen back behavior, persisted `ai.view`, keyboard activation, `role=switch`, `aria-checked`, description linkage and a minimum 44px hit target class. Switch from family A to family B and assert the hook uses a distinct query key and never renders or writes family A's cached settings for family B.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm --prefix frontend test -- --run src/app/appNavigationModel.test.ts src/app/useAppNavigationState.test.tsx src/features/ai-auto-execution/aiAutoExecutionModel.test.ts src/features/ai-auto-execution/useAiAutoExecutionSettings.test.tsx src/features/ai-auto-execution/AiAutoExecutionSettingsView.test.tsx src/components/ai/AiWorkspace.test.tsx src/components/ai/AiMobilePage.test.tsx src/features/family/FamilySettings.test.tsx`

Expected: FAIL because the AI subview, settings feature and family shortcut do not exist.

- [ ] **Step 3: Implement navigation, settings state and responsive views**

Extend navigation exactly:

```typescript
export type AiView = 'conversation' | 'autoExecution';

export type AppNavigationState = {
  primaryTab: PrimaryTabKey;
  eat: { baseView: EatBaseView; task: EatTask | null; discoverSection: 'all' | 'selfMade' };
  ai: { view: AiView };
  family: { view: FamilyView; period: string | null };
};

export type AppNavigationTarget =
  | { workspace: 'home' | 'ingredients' }
  | { workspace: 'ai'; view?: AiView }
  | { workspace: 'family'; view?: FamilyView; period?: string | null }
  | EatNavigationTarget;
```

Every reducer branch preserves `state.ai`; navigating to AI uses `target.view ?? 'conversation'`. Persist `aiView?: AiView` in the existing V2 record so old records default safely without a storage migration. `App.tsx` passes `navigation.state.ai.view` into `AiWorkspace`.

Define the catalog copy in one model:

```typescript
export const AI_AUTO_EXECUTION_ACTIONS = [
  {
    key: 'food.set_favorite',
    label: '收藏状态',
    description: '只切换现有食物的收藏状态，不修改其他资料。',
  },
  {
    key: 'meal_log.rate_food',
    label: '餐食评分',
    description: '单次最多 5 项，只修改或取消食物评分。',
  },
  {
    key: 'meal_log.simple_create',
    label: '简单餐食记录',
    description: '最多 5 个现有食物；不扣库存、不带媒体或计划联动。',
  },
  {
    key: 'meal_plan.simple_create',
    label: '简单餐食计划',
    description: '最多新增 5 项；不更新状态或联动购物清单。',
  },
  {
    key: 'shopping_list.safe_write',
    label: '购物清单安全操作',
    description: '仅限量新增、改单项数量/单位/备注，或恢复待买。',
  },
] as const satisfies readonly AiAutoExecutionActionDefinition[];
```

`useAiAutoExecutionSettings(familyId)` queries and writes only `queryKeys.aiAutoExecutionSettings(familyId)`. A family change resets row-local pending/error state and resolves against the new key; it never copies or shows the previous family's settings. The hook keeps `pendingActionKey` and pending scope (`member | family`) local, but never mutates cached enabled state before success. On success, replace that family-scoped settings query with the complete server envelope. On structured 409, invalidate/refetch the same family-scoped query and expose “设置已在其他页面更新，请重新确认”。Other errors keep the current value and expose a row-level retry message.

When enabling, always send the current notice version. Show `AiAutoExecutionConsentDialog` only when the aggregate notice is unacknowledged or the row requires re-consent. The dialog text is fixed:

> 只有在你明确要求、目标唯一且符合已开启的低风险规则时才会直接执行；其他情况仍会请你确认。支持撤销的操作可在 1 小时内恢复。

Disabling sends `{ enabled: false, expected_row_version }` immediately without a dialog. Member shopping is interactable only when the family policy is effectively enabled.

`AiAutoExecutionSettingsView` renders:

- “我的自动执行” with all five member rows;
- “家庭共享操作” with the shopping family policy;
- Owner gets an editable family switch, Member gets the same row read-only;
- loading/error states use `StateBlock`, effective/reauthorization state uses `StatusBadge`;
- each `AiAutoExecutionSwitchRow` is a native button with `role="switch"`, `aria-checked`, `aria-describedby`, and the project 44px control class.

Desktop `AiAutoExecutionDesktopPanel` stays inside the AI workspace frame. Phone `AiAutoExecutionMobilePage` is a full-screen child with its own heading and back button. Add a settings button to the desktop AI header and `AiMobileChrome`; both navigate through `{ workspace: 'ai', view: 'autoExecution' }`. Returning uses `{ workspace: 'ai', view: 'conversation' }`.

Add the family shortcut in both `FamilySettings` and `FamilyMobileView`:

```typescript
onNavigate({ workspace: 'ai', view: 'autoExecution' })
```

Label it “AI 自动执行”; do not place personal controls inside the Owner-only family AI services workspace.

Use only existing CSS custom properties, button classes, radii, shadows and breakpoint conventions in `09-ai-workspace.css` and `02-family-settings.css`. Desktop settings use the existing workspace content width; phone rows stack label/description/control without horizontal scrolling. The switch hit area is at least `min-height: 44px`; no arbitrary color, spacing, radius or shadow literal is introduced.

- [ ] **Step 4: Run settings, navigation, style-token and build checks**

Run: `npm --prefix frontend test -- --run src/app/appNavigationModel.test.ts src/app/useAppNavigationState.test.tsx src/features/ai-auto-execution/aiAutoExecutionModel.test.ts src/features/ai-auto-execution/useAiAutoExecutionSettings.test.tsx src/features/ai-auto-execution/AiAutoExecutionSettingsView.test.tsx src/components/ai/AiWorkspace.test.tsx src/components/ai/AiMobilePage.test.tsx src/features/family/FamilySettings.test.tsx`

Expected: PASS for Owner/Member, consent, concurrency and responsive surface behavior.

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run check:style-tokens`

Expected: PASS; manually inspect the token report and confirm no new arbitrary visual values.

- [ ] **Step 5: Commit the settings experience**

```bash
git add frontend/src/features/ai-auto-execution frontend/src/app/appNavigationModel.ts frontend/src/app/appNavigationModel.test.ts frontend/src/app/useAppNavigationState.ts frontend/src/app/useAppNavigationState.test.tsx frontend/src/App.tsx frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspace.test.tsx frontend/src/components/ai/AiMobilePage.tsx frontend/src/components/ai/AiMobilePage.test.tsx frontend/src/components/ai/AiMobileChrome.tsx frontend/src/features/family/FamilySettings.tsx frontend/src/features/family/FamilySettings.test.tsx frontend/src/features/family/FamilyMobileView.tsx frontend/src/styles/09-ai-workspace.css frontend/src/styles/02-family-settings.css
git commit -m "feat: add AI auto execution settings"
```

### Task 17: Result Card revert states, mutation and persisted synchronization

**Files:**
- Create: `frontend/src/features/ai-auto-execution/useAiOperationRevert.ts`
- Create: `frontend/src/features/ai-auto-execution/useAiOperationRevert.test.tsx`
- Modify: `frontend/src/components/ai/AiResultCardModel.ts`
- Modify: `frontend/src/components/ai/AiResultCards.tsx`
- Modify: `frontend/src/components/ai/AiResultCards.test.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.test.tsx`
- Modify: `frontend/src/components/ai/AiWorkspace.tsx`
- Modify: `frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx`
- Modify: `frontend/src/styles/09-ai-workspace.css`

**Interfaces:**
- Consumes: Task 15 `AiOperationResultProjection`, revert API and invalidator; Task 16 AI settings navigation target.
- Produces: `operationResultProjection(card)`, `operationResultViewModel(projection, now)`, `useAiOperationRevert(...)`, direct revert UI, HTTP-response replacement for revert and existing `message_part` replacement for active chat results.

- [ ] **Step 1: Write failing state, mutation, accessibility and live-sync tests**

```typescript
it.each([
  ['manual_approval', 'completed', '已按你的确认执行'],
  ['policy_auto', 'completed', '已自动执行'],
  ['policy_no_change', 'no_change', '已是目标状态'],
  ['policy_auto', 'failed', '未完成操作'],
  ['policy_auto', 'reverted', '已撤销'],
] as const)('renders the controlled eyebrow', (executionMode, resultStatus, eyebrow) => {
  renderOperationCard(operationCard({ executionMode, resultStatus }));
  expect(screen.getByText(eyebrow)).toBeVisible();
});

it('reverts directly without a confirm dialog or optimistic success', async () => {
  const user = userEvent.setup();
  const request = deferredPromise<AiOperationRevertResponse>();
  api.revertAiOperation.mockReturnValue(request.promise);
  renderOperationCard(availableCard());
  await user.click(screen.getByRole('button', { name: '撤销' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('已自动执行')).toBeVisible();
  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  request.resolve(revertedResponse());
  expect(await screen.findByText('已撤销')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('操作已撤销');
});

it('does not queue revert while offline', async () => {
  mockNavigatorOnline(false);
  renderOperationCard(availableCard());
  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  expect(screen.getByText('联网后可重试撤销')).toBeVisible();
  expect(api.revertAiOperation).not.toHaveBeenCalled();
});

it('treats no-change as satisfied, not as an unsupported write', () => {
  renderOperationCard(noChangeCard());
  expect(screen.getByText('相关内容已经是你要求的状态。')).toBeVisible();
  expect(screen.queryByText('此操作需要前往页面修正')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
});
```

Also cover available inclusive boundary, client-side expiry after the deadline, absolute “可撤销至 15:42”, unsupported, target-changed blocked, dependency blocked, expired, reverted, temporary network retry, permanent conflict replacement, minute-level clock updates, settings link navigation, wrapping at phone widths, keyboard activation, focus not being programmatically moved, `aria-live=polite`, response-driven cache scopes, active-chat SSE replacement and refresh hydration. Add a delayed-refresh fixture whose persisted card was created at 10:00 but whose messages response hydrates `server_now=10:30`; assert the remaining window is 30 minutes, not reset to one hour. Add the just-after-deadline variant and assert the button is hidden immediately.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm --prefix frontend test -- --run src/features/ai-auto-execution/useAiOperationRevert.test.tsx src/components/ai/AiResultCards.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx`

Expected: FAIL because operation cards know only the legacy approval result and have no revert state/mutation.

- [ ] **Step 3: Implement controlled rendering, direct mutation and persisted replacement**

Validate card data before rendering:

```typescript
export function operationResultProjection(
  card: AiResultCard,
): AiOperationResultProjection | null {
  if (card.type !== 'operation_result') return null;
  const data = card.data;
  if (
    typeof data.draft_id !== 'string'
    || !isResultStatus(data.result_status)
    || !isExecutionMode(data.execution_mode)
    || !isRevertAvailability(data.revert_availability)
    || !Array.isArray(data.entities)
    || !Array.isArray(data.cache_scopes)
  ) return null;
  return data as unknown as AiOperationResultProjection;
}
```

Build a pure view model:

```typescript
const EYEBROWS = {
  manual_approval: '已按你的确认执行',
  policy_auto: '已自动执行',
  policy_no_change: '已是目标状态',
} as const;

export function operationResultViewModel(
  projection: AiOperationResultProjection,
  effectiveNowMs: number,
): AiOperationResultViewModel {
  if (projection.result_status === 'no_change') {
    return {
      eyebrow: '已是目标状态',
      canRevert: false,
      statusText: projection.execution_explanation,
    };
  }
  if (projection.result_status === 'failed') {
    return { eyebrow: '未完成操作', canRevert: false, statusText: '本次操作未完成' };
  }
  if (projection.result_status === 'reverted') {
    return { eyebrow: '已撤销', canRevert: false, statusText: '操作已撤销' };
  }
  const deadlineMs = projection.revertible_until
    ? Date.parse(projection.revertible_until)
    : null;
  const locallyExpired = deadlineMs !== null && effectiveNowMs > deadlineMs;
  return {
    eyebrow: EYEBROWS[projection.execution_mode],
    canRevert:
      Boolean(projection.operation_id)
      && projection.revert_availability === 'available'
      && !locallyExpired,
    statusText: revertStatusText(projection, locallyExpired),
  };
}
```

`revertStatusText` returns exact product copy:

- available: “可在 1 小时内撤销” plus absolute local deadline;
- expired: “撤销时间已过，可前往页面修改”;
- blocked target: “相关内容后来被修改，无法安全撤销”;
- blocked dependency: “该内容已被后续操作使用”;
- unsupported: “此操作需要前往页面修正”;
- reverted: “操作已撤销”.

Use `projection.server_now` to compute a server/client offset when the card arrives, but only after validating that it came from the current SSE/HTTP/messages response contract in Task 9. Refresh hydration replaces any historical persisted value before the card reaches this model. Update effective time once per minute, not once per second. The client may hide an expired button early, but never overrides a server success; the server remains authoritative.

Implement the hook without optimistic updates:

```typescript
export function useAiOperationRevert(input: {
  conversationId: string;
  onResultCard: (card: AiResultCard) => void;
}) {
  const queryClient = useQueryClient();
  const requestIds = useRef(new Map<string, string>());
  return useMutation({
    networkMode: 'online',
    mutationFn: async (operationId: string) => {
      const requestId = requestIds.current.get(operationId) ?? crypto.randomUUID();
      requestIds.current.set(operationId, requestId);
      return aiApi.revertAiOperation(operationId, { client_request_id: requestId });
    },
    onSuccess: async (response, operationId) => {
      requestIds.current.delete(operationId);
      input.onResultCard(response.result_card);
      await invalidateAfterAiOperationSettled(queryClient, {
        conversationId: input.conversationId,
        cacheScopes: response.cache_scopes,
      });
    },
  });
}
```

Retain the same request ID after a temporary network/database failure so an uncertain response can be replayed safely. In `onError`, parse only Task 15's structured permanent 409: immediately call `onResultCard(conflict.result_card)`, invalidate with `conflict.cache_scopes`, announce the server message and clear the request ID. This replaces the available card with the persisted blocked card and removes the stale button. Other 409s and transient errors do not synthesize card state and retain the request ID for safe retry. Do not register an offline mutation queue or persist revert requests to storage.

`AiResultCards` renders the server explanation, entities and status model. Available cards show “撤销”, “查看详情” and “管理自动执行设置”; the settings action calls `{ workspace: 'ai', view: 'autoExecution' }`. The revert button calls the hook immediately, shows a pending label while disabled, and does not open a dialog. A visually appropriate `role="status" aria-live="polite"` region announces success/error without moving focus.

`AiConversationThread` passes conversation ID, navigation and result replacement callbacks. `AiWorkspace` replaces the matching local/React Query message part by stable card ID after the revert HTTP response, then invalidates AI queries. Automatic completion/no-change/failure results produced by an active chat use the already-supported `aiApi.streamAiResponse.onMessagePart -> AiWorkspace.applyStreamPart -> messagePartKey(card.id)` chain; `AiWorkspaceLiveSync.test.tsx` proves replacement through that real path. Revert does not register an SSE handler or pretend a separate POST can yield into the chat stream. Other clients observe the persisted reverted card on their next refetch/reconnect; refresh never calls the mutation or Coordinator.

Use existing card/button/status tokens. On narrow screens the status, deadline and actions wrap into multiple rows; no action strip has horizontal overflow. Permanent blocked/reverted/expired states do not render an enabled undo button. Temporary errors keep it available when the server projection still says available.

- [ ] **Step 4: Run result-card, hook, live-sync and style tests**

Run: `npm --prefix frontend test -- --run src/features/ai-auto-execution/useAiOperationRevert.test.tsx src/components/ai/AiResultCards.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx`

Expected: PASS across all execution/revert states, with no optimistic success and no reconnect re-execution.

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run check:style-tokens`

Expected: PASS; manually inspect new token hits and confirm mobile actions wrap without arbitrary values.

- [ ] **Step 5: Commit Result Card undo**

```bash
git add frontend/src/features/ai-auto-execution/useAiOperationRevert.ts frontend/src/features/ai-auto-execution/useAiOperationRevert.test.tsx frontend/src/components/ai/AiResultCardModel.ts frontend/src/components/ai/AiResultCards.tsx frontend/src/components/ai/AiResultCards.test.tsx frontend/src/components/ai/AiConversationThread.tsx frontend/src/components/ai/AiConversationThread.test.tsx frontend/src/components/ai/AiWorkspace.tsx frontend/src/components/ai/AiWorkspaceLiveSync.test.tsx frontend/src/styles/09-ai-workspace.css
git commit -m "feat: add AI operation result undo"
```

### Task 18: AI standards, end-to-end coverage and final verification

**Files:**
- Modify: `docs/ai-assistant-standards.md`
- Modify: `backend/tests/ai_infra/test_skill_loader.py`
- Modify: `frontend/e2e/p0-critical-journeys.spec.mjs`

**Interfaces:**
- Consumes: all backend/frontend contracts from Tasks 1–17 and the confirmed design specification.
- Produces: normative documentation matching the implementation, responsive P0 smoke coverage and fresh full-suite evidence.

- [ ] **Step 1: Write failing standards-contract and P0 journey assertions**

Extend the existing standards test:

```python
def test_ai_standards_document_policy_commit_gate_and_revert_contract() -> None:
    text = (ROOT_DIR / "docs" / "ai-assistant-standards.md").read_text(encoding="utf-8")
    assert "draft_then_policy" in text
    assert "requires_confirmation=True" in text
    assert "模型不获得正式 Write Tool" in text
    assert "每条用户消息最多一个免确认 Draft" in text
    assert "逐值验证" in text
    assert "pending_retry 不重新调用模型" in text
    assert "撤销通过 HTTP 响应" in text
    assert "1 小时" in text
    assert "原执行人或当前 Owner" in text
    assert "inventory.operation_ref.v1" in text
    assert "Composite 与 Continuation 始终人工确认" in text
```

Add P0 smoke paths that use deterministic API fixtures:

```javascript
test('AI automatic execution settings and revert card are responsive', async ({ page }) => {
  await seedSignedInFamily(page, { role: 'Owner' });
  await mockAiAutoExecutionSettings(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 自动执行' }).click();
  await expect(page.getByRole('heading', { name: '我的自动执行' })).toBeVisible();
  await expect(page.getByRole('switch', { name: '收藏状态' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await openMockConversationWithAvailableOperation(page);
  await expect(page.getByText('可在 1 小时内撤销')).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销' })).toBeInViewport();
});
```

Repeat the settings surface at desktop width and assert the AI workspace frame remains visible. Add a Member fixture that sees the family shopping switch disabled, and a mocked successful revert whose original card changes in place to “已撤销”.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `backend/.venv/bin/pytest backend/tests/ai_infra/test_skill_loader.py -q`

Expected: FAIL because the standards document still states universal user approval.

Run: `npm --prefix frontend run e2e:p0 -- --grep "AI automatic execution settings and revert card"`

Expected: FAIL because the new P0 fixture/journey has not been added.

- [ ] **Step 3: Update the normative standard and complete E2E fixtures**

Replace the universal `draft -> approval -> service commit` wording with:

```text
模型始终只生成 Draft，并且不获得正式 Write Tool。requires_confirmation=True
表示 Draft 必须进入服务端 commit gate：draft_then_confirm 始终等待真实用户决定；
draft_then_policy 只有在离散意图证据、当前成员/家庭授权、动作白名单、版本、限制和
已注册撤销适配器全部通过时，才由服务端策略直接提交。其他情况降级人工确认。
```

Document all four intent clarity levels and their model-visible definitions, evidence separation from normalized business payload, server-side canonical value comparison, five action keys and their limits, mode-specific shopping evidence fields, member opt-in plus shopping Owner policy, one-per-message guard, immutable Approval facts, shared `DraftCommitCoordinator`, the no-model same-Draft `pending_retry` branch, safe public result fields, fresh response-level `server_now`, one-hour inclusive revert boundary, actor/Owner permission, seven stable errors, six adapter keys, cache scopes, and excluded cook/delete/media/Composite/Continuation undo. State explicitly that normal page domain undo remains fifteen minutes and that ordinary approval/revert mutations update the caller through HTTP rather than a cross-request SSE broadcast.

Complete the E2E route fixtures with strict JSON matching the frontend types. The revert route must assert the client request ID, return `replayed=false` with a fresh `server_now`, and replace the same Draft-keyed result card ID through the HTTP response. Add a messages fixture whose stored card clock is old but hydrated response clock is current, and assert refresh does not reset the countdown. Capture no screenshot baselines unless the existing P0 helper already requires one.

- [ ] **Step 4: Run full verification and manual responsive acceptance**

Run the focused backend suites first:

```bash
backend/.venv/bin/pytest backend/tests/ai_infra/test_ai_auto_execution_migration.py backend/tests/ai_infra/test_ai_auto_execution_settings.py backend/tests/ai_infra/test_ai_intent_evidence.py backend/tests/ai_infra/test_ai_auto_execution_policy_registry.py backend/tests/ai_infra/test_ai_auto_execution_action_policies.py backend/tests/ai_infra/test_ai_draft_execution_receipts.py backend/tests/ai_infra/test_ai_draft_commit_coordinator.py backend/tests/ai_infra/test_ai_draft_routing.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_ai_operation_result_projection.py backend/tests/ai_infra/test_ai_revert_coordinator.py backend/tests/ai_infra/test_ai_revert_low_risk_adapters.py backend/tests/ai_infra/test_ai_simple_meal_operation.py backend/tests/ai_infra/test_ai_inventory_operation_revert.py backend/tests/ai_infra/test_ai_draft_then_policy_contract.py -q
```

Expected: PASS.

Then run:

```bash
npm run backend:quality
(cd backend && .venv/bin/alembic heads)
npm run backend:migrate
npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens
npm run frontend:e2e:p0
```

Expected: all commands PASS; Alembic reports the single head `7c8d9e0f1a2b`. Run a real MySQL `7b8c9d0e1f2a -> 7c8d9e0f1a2b -> 7b8c9d0e1f2a -> 7c8d9e0f1a2b` round trip with `CULINA_TEST_MYSQL_URL`; a skipped MySQL case is not migration acceptance.

Manually inspect `375×812`, `390×844`, `430×932`, `768×1024`, `1024×768` and `1440×900`. Record:

- desktop settings remain inside the AI workspace and phone settings are full-screen;
- every switch is keyboard reachable, 44px or larger and correctly announced;
- Owner/Member shopping differences and consent dialog copy;
- automatic, manual, no-change, failed, available, expired, blocked and reverted cards;
- phone actions wrap without horizontal scrolling;
- style-token report has no unexplained new arbitrary values.

- [ ] **Step 5: Commit standards and acceptance coverage**

```bash
git add docs/ai-assistant-standards.md backend/tests/ai_infra/test_skill_loader.py frontend/e2e/p0-critical-journeys.spec.mjs
git commit -m "docs: finalize AI execution and undo contract"
```
