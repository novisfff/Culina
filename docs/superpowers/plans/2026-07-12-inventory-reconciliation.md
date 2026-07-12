# Inventory Reconciliation and Atomic Shopping Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep the approved design open and stop if implementation would change a confirmed product decision.

**Goal:** Make non-quantity-tracked ingredients use one household state, replace shopping-to-stock double writes with one idempotent transaction, add fast scope-based inventory reconciliation, and provide safe operation history and 15-minute whole-operation undo.

**Architecture:** Keep three inventory adapters behind shared orchestration boundaries: `InventoryItem` batches for precise ingredients, `IngredientInventoryState` for household-level presence ingredients, and aggregate stock fields on `Food`. All multi-entity writes use stable parent-first locks, integer row versions, structured operation snapshots, one commit, and structured 409/422 errors; React consumes discriminated contracts through pure models, focused state/action hooks, and separate mobile/desktop views.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, Pydantic, MySQL, pytest, React 18, TypeScript 5.7, React Query 5, Vitest, Vite, Playwright smoke checks.

**Approved design:** `docs/superpowers/specs/2026-07-11-inventory-reconciliation-design.md`

## Global Constraints

- Task 0 is a hard prerequisite: implement and verify `docs/superpowers/plans/2026-07-11-home-action-center.md` first. This plan extends its `InventoryItem.row_version`, expiry service, `inventoryActionModel`, and `InventoryActionDialog`; it must not create replacements.
- Work on a project-native branch such as `feature/inventory-reconciliation`; do not use a `codex/` prefix.
- At plan-writing time `main` is at Alembic head `1d2e3f4a5b6c`, while the P0.1 plan expects to create `2e3f4a5b6c7d`. Re-run `alembic heads` after P0.1 and set the P0.2 migration parent to the one real head; never create a migration fork.
- Treat `Asia/Shanghai` as the fixed household business timezone in this phase. Do not add `Family.timezone`.
- `IngredientInventoryState` is the only current fact source for `not_track_quantity`. No new path may create a `quantity = 1` placeholder `InventoryItem`.
- Historical presence placeholders remain in the database but must not affect current overview, home, recipe readiness, search, AI, storage scope, or expiry actions.
- State is household-level, not batch-level or location-partitioned. It stores one availability, status, purchase date, expiry date, location, and note.
- State availability levels are exactly `present_unknown | low | sufficient | absent`. Only `not_track_quantity` ingredients may own a State.
- First-version confirmation freshness is exactly `never_confirmed | current | stale`; do not expose `changed_since_confirmation`.
- Fixed re-confirm intervals are Food 7 days, refrigerated Ingredient 14 days, frozen Ingredient 30 days, room-temperature Ingredient 30 days, and presence Ingredient 30 days.
- A scope's observed precise batches are all rows in that scope with `remaining_quantity > 0`, including expired rows; zero-remaining and out-of-scope rows are excluded.
- For `scope=suggested`, an included precise Ingredient submits all of its current physical batches across locations; “suggested” filters which groups need confirmation, not which batches inside the group are observed.
- Out-of-scope child changes still bump `Ingredient.row_version`, so a stale scoped reconciliation fails conservatively with 409.
- Use integer `row_version`, not `updated_at`, as the concurrency token. Every old and new write path must participate.
- Lock in this global order: `InventoryOperation`, sorted `Ingredient`, sorted `Food`, sorted `IngredientInventoryState`, sorted `InventoryItem`, sorted `ShoppingListItem`.
- A reconciliation or shopping intake request has one transaction and one commit. Any error rolls back inventory/state, shopping rows, operation lines, and activity log together.
- `client_request_id` is unique per family. Same ID plus same canonical request hash returns the original result; same ID plus different hash returns 409.
- Operation snapshots are whitelist-only, schema-versioned, and contain no token, password, full user record, or AI conversation.
- Undo is whole-operation only, within 15 minutes, by the original actor or Owner, and only when every entity and Ingredient collection guard remains at the operation's after version.
- Members and Owners may reconcile, intake, and view family operations. Members may undo only their own operation; cross-family resources return 404.
- Low-state shopping deduplication uses `target_type === 'ingredient' && ingredient_id === ingredient.id`. Legacy title-only rows may use normalized exact-name fallback only; substring matching is forbidden.
- Shopping-source inventory changes always use the intake endpoint. Remove `createInventory -> updateShopping(done)` and `restockFoodStock -> updateShopping(done)` chains and their partial-success notices.
- A ShoppingListItem may bind to at most one Ingredient/Food; two null target IDs are an intentional `free_text` row, not an invalid or implicit Ingredient target. Free-text rows may complete without inventory or bind explicitly during intake.
- Food shopping intake merges expiry as earliest non-null when old stock remains, and uses the incoming date when prior stock is zero. Ordinary manual Food restock keeps its existing supplied-date overwrite behavior.
- Pure frontend models receive an explicit `referenceDate`; they do not call device-local `todayKey()` internally.
- React Query keys live in `frontend/src/api/queryKeys.ts`; mutation invalidation lives in `frontend/src/api/cacheInvalidation.ts`; local drafts use `frontend/src/lib/storage.ts`.
- Mobile is the primary experience. Reconciliation uses a task sheet and `MobileActionBar`; desktop uses a two-region layout. Do not use a dense admin table.
- Reuse P0.1 `InventoryActionDialog` for State expiry actions using a discriminated target. Do not add a second presence-expiry dialog.
- Preserve unrelated dirty worktree files. Do not edit or stage the existing product assessment or P0.1 documents as part of this plan.
- Each phase ends with a deployable checkpoint and its focused/full verification. Do not begin the next phase while the current checkpoint has unresolved P0/P1 review findings.
- Each phase's release sequence is: back up the database, stop old-backend writes, run Alembic upgrade, deploy the new backend, run authenticated API smoke checks on a disposable family, then deploy/enable the matching frontend. Do not run old and new write instances together because the old backend does not maintain the new row versions.
- Rollback means hide the new entry points, retain the additive tables/columns, roll back application code without an immediate Alembic downgrade, and reopen only after the fix passes the phase gate. Never restore the old shopping double-mutation flow after atomic intake becomes the write boundary.
- Final delivery must report every validation command actually executed, including failures and whether each failure was pre-existing.

---

## Delivery Phases and Dependency Order

```text
P0.1 prerequisite
  Task 0
    ↓
Phase 1 — consistency foundation and atomic shopping intake
  1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
    ↓
Phase 2 — fast reconciliation
  11 → 12 → 13 → 14
    ↓
Phase 3 — undo and maintenance experience
  15 → 16 → 17 → 18 → 19
```

- Tasks touching `backend/app/models/domain.py`, `backend/app/core/enums.py`, `frontend/src/api/types.ts`, `queryKeys.ts`, `cacheInvalidation.ts`, `App.tsx`, or `IngredientWorkspace.tsx` execute sequentially.
- Tasks 1–4 are one truth-source cutover. Do not deploy after creating State but before every current presence read/write path has moved away from historical placeholders.
- Task 5 creates complete operation snapshots, and Task 6 enables explicit free-text rows, before Task 7 writes shopping intake operations. History/revert UI is intentionally deferred to Phase 3.
- Tasks 2, 3, and 10 are mandatory independent review/commit boundaries; never combine or skip their version-path, truth-source, or integration gates to shorten Phase 1.
- Task 10 is the Phase 1 deploy gate. Task 14 is the Phase 2 deploy gate. Task 19 is the Phase 3/final gate.
- Each task gets one implementation review and one spec-compliance review. Fix findings before committing that task; cap any audit/fix loop at three passes and report unresolved blockers with evidence.

## File Responsibility Map

### Create: backend

- `backend/alembic/versions/3f4a5b6c7d8e_add_inventory_reconciliation.py` — P0.2 schema and deterministic presence-placeholder backfill; rename revision/parent only if Task 0 finds a different single head.
- `backend/app/api/inventory_states.py` — authenticated State list/upsert HTTP boundary.
- `backend/app/api/inventory_reconciliation.py` — reconciliation read/submit HTTP boundary.
- `backend/app/api/inventory_operations.py` — operation list/detail/revert HTTP boundary.
- `backend/app/api/shopping_intake.py` — atomic shopping intake HTTP boundary.
- `backend/app/schemas/inventory_states.py` — State request/response contracts.
- `backend/app/schemas/inventory_operations.py` — operation, reconciliation, intake, and structured error contracts.
- `backend/app/repos/inventory_operations.py` — family-scoped operation/idempotency queries and line persistence.
- `backend/app/services/ingredient_inventory_state.py` — only presence-State read/write/default/serialization service.
- `backend/app/services/inventory_confirmation.py` — freshness status and confirmation timestamp rules.
- `backend/app/services/inventory_operation_locking.py` — one global stable lock order.
- `backend/app/services/inventory_operation_history.py` — canonical hash, snapshot lines, display detail, and revert.
- `backend/app/services/inventory_versions.py` — shared expected-version checks, collection guards, and structured conflicts.
- `backend/app/services/shopping_intake.py` — exact ingredient, presence ingredient, Food, and complete-only adapters in one transaction.
- `backend/app/services/inventory_reconciliation.py` — scoped reconciliation projections and three write adapters.
- `backend/tests/inventory/test_ingredient_inventory_state.py` — State truth-source and migration-facing behavior.
- `backend/tests/inventory/test_inventory_versions.py` — old/new version boundary coverage.
- `backend/tests/inventory/test_inventory_reconciliation_api.py` — scope, adapter, error, and transaction API tests.
- `backend/tests/inventory/test_inventory_operation_history.py` — list/detail/snapshot presentation tests.
- `backend/tests/inventory/test_inventory_operation_revert.py` — permission/time/version/whole-operation undo tests.
- `backend/tests/inventory/test_inventory_mysql_concurrency.py` — real MySQL barrier tests.
- `backend/tests/shopping/test_shopping_intake_api.py` — all intake branches, idempotency, and rollback.

### Modify: backend

- `backend/app/core/enums.py` — operation, availability, and confirmation enums.
- `backend/app/models/domain.py` — State, operation models, row versions, confirmation fields, and relationships.
- `backend/app/api/router.py` — include four new routers.
- `backend/app/api/inventory.py` — precise-only list/create and versioned child writes.
- `backend/app/api/ingredients.py` — tracking-mode transition transaction.
- `backend/app/api/shopping_list.py` — versioned Ingredient/Food/free-text shopping writes; no stock orchestration.
- `backend/app/api/foods.py` — version-aware Food writes and shared stock service.
- `backend/app/api/meal_logs.py`, `backend/app/api/recipes.py` — preserve versions on stock/batch deductions.
- `backend/app/schemas/inventory.py`, `backend/app/schemas/domain.py`, `backend/app/schemas/ingredients.py`, `backend/app/schemas/shopping.py` — row-version and transition contracts.
- `backend/app/services/serializers.py` — expose row versions/confirmation and never disguise State as InventoryItem.
- `backend/app/services/inventory_operations.py`, `backend/app/services/inventory_usage.py`, `backend/app/services/inventory_overview.py`, `backend/app/services/food_stock.py` — exact/presence/Food truth and version participation.
- `backend/app/services/search/documents.py`, `backend/app/services/search/hybrid.py`, `backend/app/services/search/indexing.py` — index current State, ignore legacy presence rows.
- `backend/app/ai/tools/catalog/inventory.py`, `backend/app/ai/tools/catalog/meal_ideas.py` — read presence State.
- `backend/app/services/ai_operations/inventory.py`, `backend/app/services/ai_operations/shopping.py`, `backend/app/services/ai_operations/foods.py`, `backend/app/services/ai_operations/recipe_cook.py`, `backend/app/services/ai_operations/ingredients.py` — reuse State/intake/version services for approved writes.
- `backend/tests/inventory/test_inventory_api.py`, `backend/tests/inventory/test_inventory_overview.py`, `backend/tests/recipes/test_recipe_cooking.py`, `backend/tests/recipes/test_food_stock_operations.py`, `backend/tests/search/test_inventory_search.py`, `backend/tests/search/test_hybrid_search.py`, `backend/tests/ai_infra/test_inventory_operations.py`, `backend/tests/ai_infra/test_workspace_approvals.py` — exact regression targets.

### Create: frontend

- `frontend/src/api/inventoryStatesApi.ts`, `frontend/src/api/inventoryStatesApi.test.ts` — State list/upsert transport.
- `frontend/src/api/ingredientsApi.test.ts` — ordinary bound/free-text shopping transport and later tracking-transition transport tests.
- `frontend/src/api/inventoryOperationsApi.ts`, `frontend/src/api/inventoryOperationsApi.test.ts` — reconciliation, intake, operation transport.
- `frontend/src/features/inventory/inventoryReconciliationModel.ts`, `frontend/src/features/inventory/inventoryReconciliationModel.test.ts` — pure group/draft/payload/conflict logic.
- `frontend/src/features/inventory/useInventoryReconciliationState.ts`, `frontend/src/features/inventory/useInventoryReconciliationState.test.ts` — overlay step/scope/selection/draft state.
- `frontend/src/features/inventory/useInventoryReconciliationActions.ts`, `frontend/src/features/inventory/useInventoryReconciliationActions.test.ts` — load/replay/submit/conflict orchestration.
- `frontend/src/features/inventory/InventoryReconciliationDialog.tsx`, `frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx` — mobile/desktop reconciliation task UI.
- `frontend/src/features/inventory/shoppingIntakeModel.ts`, `frontend/src/features/inventory/shoppingIntakeModel.test.ts` — selection/default/partial/free-text payload logic.
- `frontend/src/features/inventory/useShoppingIntakeState.ts`, `frontend/src/features/inventory/useShoppingIntakeState.test.ts` — three-step draft state.
- `frontend/src/features/inventory/useShoppingIntakeActions.ts`, `frontend/src/features/inventory/useShoppingIntakeActions.test.ts` — intake submit/error/result orchestration.
- `frontend/src/features/inventory/ShoppingIntakeDialog.tsx`, `frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx` — explicit multi-select purchase UI.
- `frontend/src/features/inventory/InventoryOperationBanner.tsx`, `frontend/src/features/inventory/InventoryOperationBanner.test.tsx` — recent safe undo result/banner.
- `frontend/src/features/inventory/InventoryOperationHistoryDialog.tsx`, `frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx` — family-safe operation list/detail/revert UI.
- `frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx` — one composition boundary for reconciliation/intake/undo overlays.
- `frontend/src/styles/11-inventory-maintenance.css` — `.inventory-maintenance-*` responsive styles.

### Modify: frontend

- `frontend/src/features/inventory/inventoryActionModel.ts`, `frontend/src/features/inventory/inventoryActionModel.test.ts`, `frontend/src/features/inventory/InventoryActionDialog.tsx`, `frontend/src/features/inventory/InventoryActionDialog.test.tsx` — extend the P0.1 target union and dialog with State expiry actions.
- `frontend/src/api/types.ts`, `frontend/src/api/client.ts`, `frontend/src/api/queryKeys.ts`, `frontend/src/api/queryKeys.test.ts`, `frontend/src/api/cacheInvalidation.ts`, `frontend/src/api/cacheInvalidation.test.ts` — cross-stack contracts/cache.
- `frontend/src/app/useAppWorkspaceQueries.ts`, `frontend/src/app/useAppMutations.ts`, `frontend/src/app/useAppHomeHandlers.ts`, `frontend/src/app/useAppHomeViewModel.ts`, `frontend/src/App.tsx` — State/intake/reconciliation/operation composition.
- `frontend/src/features/home/useHomeDashboardState.ts`, `frontend/src/features/home/useHomeDashboardActions.ts`, `frontend/src/features/home/useHomeDashboardActions.test.ts`, `frontend/src/features/home/HomeDashboardDialogs.tsx` — intake navigation and State expiry actions.
- `frontend/src/components/ingredients/useIngredientActionState.ts`, `frontend/src/components/ingredients/useIngredientOverlayState.ts`, `frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts`, `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`, `frontend/src/components/ingredients/IngredientWorkspace.tsx`, `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`, `frontend/src/components/ingredients/IngredientHubPage.tsx`, `frontend/src/components/ingredients/IngredientMobileView.tsx`, `frontend/src/components/ingredients/useIngredientEditorState.ts`, `frontend/src/components/ingredients/IngredientEditorView.tsx`, `frontend/src/components/ingredients/workspaceModel.ts` — State source, intake, reconciliation, and transition guard.
- `frontend/src/components/foods/FoodWorkspace.tsx`, `frontend/src/components/foods/FoodWorkspace.test.ts` — shopping-source restock to intake; ordinary restock remains Food stock API.
- `frontend/src/components/ui-kit/WorkspaceOverlay.tsx`, `frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx`, `frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx` — dialog semantics/focus/Escape/busy close/drag guard.
- `frontend/src/lib/storage.ts`, `frontend/src/lib/date.ts` — draft persistence and explicit business-date helpers.
- `frontend/src/styles.css`, `frontend/scripts/smoke.mjs` — style import and acceptance path.

---

## Task 0: Complete P0.1 and Establish the Executable Baseline

**Files:** No P0.2 product file changes.

**Interfaces:**

- Consumes: completed `docs/superpowers/plans/2026-07-11-home-action-center.md`.
- Produces: one safe feature branch/worktree with P0.1 `InventoryItem.row_version`, expiry action service, `inventoryActionModel.ts`, and `InventoryActionDialog.tsx` present and green.

- [ ] **Step 1: Inspect worktree and create isolation at execution time**

Use `superpowers:using-git-worktrees` before implementation. Record, but do not stage or alter, all pre-existing paths:

```bash
git status --short
git branch --show-current
git rev-parse --git-dir
git rev-parse --git-common-dir
```

Create/switch to `feature/inventory-reconciliation` only through the selected worktree workflow. Never develop this epic directly on `main`.

- [ ] **Step 2: Enforce the P0.1 prerequisite**

Run:

```bash
test -f frontend/src/features/inventory/inventoryActionModel.ts
test -f frontend/src/features/inventory/InventoryActionDialog.tsx
rg -n "row_version|expiry_alert_snoozed_until|expiry_reviewed_at" backend/app/models/domain.py
cd backend && .venv/bin/alembic heads
```

Expected after P0.1: both frontend files exist, `InventoryItem` owns the four P0.1 fields, and there is exactly one migration head descended from `1d2e3f4a5b6c`. If any prerequisite is missing, stop P0.2 and execute the approved P0.1 plan first; do not recreate its files inside this plan.

- [ ] **Step 3: Capture baseline tests**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_inventory_api.py \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_inventory_operations.py -q
npm --prefix frontend run test -- inventoryActionModel InventoryActionDialog workspaceModel homeDashboardModel
npm --prefix frontend run typecheck
```

Expected: PASS. Record any pre-existing failure verbatim and resolve whether it belongs to P0.1 before proceeding.

- [ ] **Step 4: Record the real migration parent in the plan execution notes**

```bash
cd backend && .venv/bin/alembic heads
```

Expected at plan-writing assumptions: `2e3f4a5b6c7d (head)`. If the actual single head differs, rename the Task 1 migration revision/file before creating it and use that actual head as `down_revision`.

## Phase 1 — Consistency Foundation and Atomic Shopping Intake

## Task 1: Add Persistent State, Operation Models, and Deterministic Backfill

**Files:**

- Create: `backend/alembic/versions/3f4a5b6c7d8e_add_inventory_reconciliation.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/models/domain.py`
- Test: `backend/tests/inventory/test_ingredient_inventory_state.py`

**Interfaces:**

- Consumes: P0.1 `InventoryItem.row_version` and expiry fields.
- Produces: ORM types `IngredientInventoryState`, `InventoryOperation`, `InventoryOperationLine`; enums `InventoryAvailabilityLevel`, `InventoryConfirmationSource`, `InventoryOperationType`, `InventoryOperationStatus`, `InventoryOperationEntityType`, `InventoryOperationChangeType`; row versions/confirmation fields on Ingredient, Food, ShoppingListItem.

- [ ] **Step 1: Write failing model-contract tests**

Create `test_ingredient_inventory_state.py` with a minimal family/user/ingredient fixture and assertions equivalent to:

```python
def test_presence_state_is_unique_per_family_ingredient(db):
    first = IngredientInventoryState(
        id="inventory-state-1",
        family_id="family-1",
        ingredient_id="ingredient-salt",
        availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
        inventory_status=InventoryStatus.FRESH,
        storage_location="常温",
        notes="",
        row_version=1,
    )
    db.add(first)
    db.commit()
    db.add(IngredientInventoryState(
        id="inventory-state-2",
        family_id="family-1",
        ingredient_id="ingredient-salt",
        availability_level=InventoryAvailabilityLevel.LOW,
        inventory_status=InventoryStatus.OPENED,
        storage_location="常温",
        notes="",
        row_version=1,
    ))
    with pytest.raises(IntegrityError):
        db.commit()
```

Also assert default row versions are `1`, State reviewer/confirmation fields are nullable, operation `(family_id, client_request_id)` is unique, and one operation cannot contain two lines with the same `(entity_type, entity_id)`.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_ingredient_inventory_state.py -q
```

Expected: collection fails because the new models/enums do not exist.

- [ ] **Step 3: Add exact enums**

In `backend/app/core/enums.py` add:

```python
class InventoryAvailabilityLevel(str, Enum):
    PRESENT_UNKNOWN = "present_unknown"
    LOW = "low"
    SUFFICIENT = "sufficient"
    ABSENT = "absent"

class InventoryConfirmationSource(str, Enum):
    MANUAL_ENTRY = "manual_entry"
    RECONCILIATION = "reconciliation"
    SHOPPING_INTAKE = "shopping_intake"

class InventoryOperationType(str, Enum):
    RECONCILIATION = "reconciliation"
    SHOPPING_INTAKE = "shopping_intake"

class InventoryOperationStatus(str, Enum):
    APPLIED = "applied"
    REVERTED = "reverted"

class InventoryOperationEntityType(str, Enum):
    INGREDIENT = "ingredient"
    INVENTORY_ITEM = "inventory_item"
    NON_TRACKED_INGREDIENT_STATE = "non_tracked_ingredient_state"
    FOOD = "food"
    SHOPPING_LIST_ITEM = "shopping_list_item"

class InventoryOperationChangeType(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
```

Add `REVERT = "revert"` to `ActivityAction`.

- [ ] **Step 4: Add ORM fields and models with mapper versioning**

Use existing `AuditMixin`, `create_id`, `SqlEnum(..., native_enum=False)`, and relationships. The exact public model shapes are:

```python
class IngredientInventoryState(AuditMixin, Base):
    __tablename__ = "ingredient_inventory_states"
    __table_args__ = (
        UniqueConstraint("family_id", "ingredient_id", name="uq_ingredient_inventory_states_family_ingredient"),
        Index("ix_ingredient_inventory_states_family_availability", "family_id", "availability_level"),
        Index("ix_ingredient_inventory_states_family_storage_availability", "family_id", "storage_location", "availability_level"),
        Index("ix_ingredient_inventory_states_family_expiry", "family_id", "expiry_date"),
        Index("ix_ingredient_inventory_states_family_confirmed", "family_id", "last_confirmed_at"),
    )
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    availability_level: Mapped[InventoryAvailabilityLevel] = mapped_column(SqlEnum(InventoryAvailabilityLevel, native_enum=False), nullable=False)
    inventory_status: Mapped[InventoryStatus] = mapped_column(SqlEnum(InventoryStatus, native_enum=False), default=InventoryStatus.FRESH, nullable=False)
    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    storage_location: Mapped[str | None] = mapped_column(String(120), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expiry_alert_snoozed_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiry_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expiry_reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_confirmed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_confirmation_source: Mapped[InventoryConfirmationSource | None] = mapped_column(SqlEnum(InventoryConfirmationSource, native_enum=False), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    __mapper_args__ = {"version_id_col": row_version}

class InventoryOperation(Base):
    __tablename__ = "inventory_operations"
    __table_args__ = (
        UniqueConstraint("family_id", "client_request_id", name="uq_inventory_operations_family_request"),
        Index("ix_inventory_operations_family_applied", "family_id", "applied_at"),
        Index("ix_inventory_operations_family_status_revertible", "family_id", "status", "revertible_until"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory-operation"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False)
    operation_type: Mapped[InventoryOperationType] = mapped_column(SqlEnum(InventoryOperationType, native_enum=False), nullable=False)
    status: Mapped[InventoryOperationStatus] = mapped_column(SqlEnum(InventoryOperationStatus, native_enum=False), nullable=False)
    client_request_id: Mapped[str] = mapped_column(String(120), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revertible_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reverted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    summary_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

class InventoryOperationLine(Base):
    __tablename__ = "inventory_operation_lines"
    __table_args__ = (
        UniqueConstraint("operation_id", "sequence", name="uq_inventory_operation_lines_sequence"),
        UniqueConstraint("operation_id", "entity_type", "entity_id", name="uq_inventory_operation_lines_entity"),
    )
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("inventory-operation-line"))
    operation_id: Mapped[str] = mapped_column(ForeignKey("inventory_operations.id", ondelete="CASCADE"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    entity_type: Mapped[InventoryOperationEntityType] = mapped_column(SqlEnum(InventoryOperationEntityType, native_enum=False), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    change_type: Mapped[InventoryOperationChangeType] = mapped_column(SqlEnum(InventoryOperationChangeType, native_enum=False), nullable=False)
    before_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    after_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    before_row_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    after_row_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    change_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    snapshot_schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
```

Add `row_version` mapper columns to `Ingredient`, `Food`, and `ShoppingListItem`, and set each model's `__mapper_args__ = {"version_id_col": row_version}` exactly as for State/P0.1 InventoryItem. Add the confirmed confirmation fields to `InventoryItem`/Food while reusing P0.1 columns if present. Reviewer/confirming-user foreign keys are nullable and use `ON DELETE SET NULL`.

- [ ] **Step 5: Write the migration against the one actual head**

The migration must:

1. add only columns absent after P0.1;
2. create the three new tables, indexes, and foreign keys;
3. initialize all new row versions to `1` with non-null server default;
4. select only legacy presence rows whose `quantity - disposed_quantity > 0`;
5. group by `(family_id, ingredient_id)`;
6. choose one representative row by earliest non-null `expiry_date`, then newest `updated_at`, then stable `id`;
7. insert `present_unknown`, copy all context from that one row, and leave `last_confirmed_*` null;
8. copy P0.1 snooze/review fields only when those source columns exist on the actual head.

Use SQLAlchemy Core tables/bind parameters in the migration; do not import application ORM models. The selection order must be encoded explicitly:

```python
representative_key = (
    row.expiry_date is None,
    row.expiry_date or date.max,
    -row.updated_at.timestamp(),
    row.id,
)
```

Do not create an `absent` State when there is no physical-presence evidence, and do not delete legacy rows.

- [ ] **Step 6: Verify migration and deterministic backfill on MySQL**

```bash
npm run db:up
npm run backend:migrate
cd backend && .venv/bin/alembic current
```

Seed a disposable test family with duplicate presence rows covering earliest expiry, no expiry, consumed-but-not-disposed, and fully disposed. Run `alembic downgrade <P0.1-head>` then `alembic upgrade head` only against that disposable local test database. Expected: one State per physically present ingredient, no State for fully disposed history, `last_confirmed_at IS NULL`, and all legacy rows remain.

- [ ] **Step 7: Run model tests and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_ingredient_inventory_state.py -q
git diff --check
git add backend/app/core/enums.py backend/app/models/domain.py backend/alembic/versions/3f4a5b6c7d8e_add_inventory_reconciliation.py backend/tests/inventory/test_ingredient_inventory_state.py
git commit -m "feat: add inventory reconciliation persistence"
```

Expected: focused tests PASS and one migration head remains.

## Task 2: Centralize Version Checks, Collection Guards, and Stable Locking

**Files:**

- Create: `backend/app/services/inventory_versions.py`
- Create: `backend/app/services/inventory_operation_locking.py`
- Create: `backend/tests/inventory/test_inventory_versions.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/app/services/food_stock.py`
- Modify: `backend/app/api/inventory.py`
- Modify: `backend/app/api/shopping_list.py`
- Modify: `backend/app/api/foods.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/services/ai_operations/inventory.py`
- Modify: `backend/app/services/ai_operations/shopping.py`
- Modify: `backend/app/services/ai_operations/foods.py`
- Modify: `backend/app/services/ai_operations/recipe_cook.py`
- Test: `backend/tests/inventory/test_inventory_api.py`
- Test: `backend/tests/recipes/test_recipe_cooking.py`
- Test: `backend/tests/recipes/test_food_stock_operations.py`
- Test: `backend/tests/shopping/test_shopping_list_api.py`
- Test: `backend/tests/ai_infra/test_inventory_operations.py`
- Test: `backend/tests/ai_infra/test_workspace_approvals.py`
- Test: `backend/tests/ai_infra/test_composite_operations.py`

**Interfaces:**

- Produces:

```python
class InventoryConflictError(ValueError):
    code: str
    conflicts: list[dict[str, object]]

@dataclass(slots=True)
class LockedInventoryTargets:
    ingredients: dict[str, Ingredient]
    foods: dict[str, Food]
    states_by_ingredient_id: dict[str, IngredientInventoryState]
    inventory_items: dict[str, InventoryItem]
    shopping_items: dict[str, ShoppingListItem]

def require_expected_version(entity: object, expected: int, *, entity_type: str, entity_id: str) -> None: ...
def bump_ingredient_collection(ingredient: Ingredient, *, user_id: str) -> None: ...
def lock_inventory_targets(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str] = (),
    food_ids: Iterable[str] = (),
    state_ingredient_ids: Iterable[str] = (),
    inventory_item_ids: Iterable[str] = (),
    shopping_item_ids: Iterable[str] = (),
) -> LockedInventoryTargets: ...
```

- [ ] **Step 1: Write failing version-propagation tests**

Cover direct create/consume/dispose, recipe cook, AI inventory write, Food restock/consume/dispose, and shopping edit. The key regression is:

```python
before = ingredient.row_version
consume_ingredient_inventory(...)
db.flush()
assert ingredient.row_version == before + 1
assert changed_item.row_version == item_before + 1
```

Also assert a stale `expected_row_version` produces `InventoryConflictError(code="stale_version")` before any mutation.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_inventory_versions.py \
  tests/inventory/test_inventory_api.py \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_food_stock_operations.py \
  tests/ai_infra/test_inventory_operations.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_composite_operations.py -q
```

Expected: new propagation assertions fail because parent Ingredient/Food/Shopping version handling is incomplete.

- [ ] **Step 3: Implement structured version helpers**

`require_expected_version` compares integers and raises a conflict containing only safe IDs/current versions. `bump_ingredient_collection` explicitly advances the parent collection token and audit actor; normal `InventoryItem`, Food, and Shopping ORM updates continue to use mapper versioning.

```python
def bump_ingredient_collection(ingredient: Ingredient, *, user_id: str) -> None:
    ingredient.row_version += 1
    ingredient.updated_by = user_id
```

Catch SQLAlchemy `StaleDataError` only at transaction/HTTP boundaries, rollback, and translate it to the same structured 409. Do not convert unrelated `IntegrityError` or database failures to stale conflicts.

- [ ] **Step 4: Implement one stable lock helper**

For each non-empty ID set, issue a family-scoped, sorted `SELECT ... FOR UPDATE`. Lock parents before children exactly as specified. Return maps keyed by ID/ingredient ID and raise a family-safe not-found error when the locked count differs from the requested unique count.

```python
ingredient_ids = sorted(set(ingredient_ids))
ingredients = list(db.scalars(
    select(Ingredient)
    .where(Ingredient.family_id == family_id, Ingredient.id.in_(ingredient_ids))
    .order_by(Ingredient.id)
    .with_for_update()
))
```

Repeat the explicit query for Food, State, InventoryItem, and ShoppingListItem in global order; do not construct dynamic unreviewable ORM magic.

- [ ] **Step 5: Retrofit every existing write path**

Before any InventoryItem create/update/delete, lock its Ingredient and bump the parent collection token. Ensure this includes direct inventory routes, P0.1 expiry actions, recipe cook, meal-log deduction, AI-approved inventory/recipe-cook actions, consume, dispose, and dispose-expired. Ensure ordinary and AI-approved Food/Shopping mutations use their mapper versions, including `ai_operations/foods.py`, `shopping.py`, and `recipe_cook.py`. Add expected-version request fields wherever the user acts on a previously viewed existing row.

- [ ] **Step 6: Run focused and service suites**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_inventory_versions.py \
  tests/inventory/test_inventory_api.py \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_food_stock_operations.py \
  tests/shopping/test_shopping_list_api.py \
  tests/ai_infra/test_inventory_operations.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_composite_operations.py -q
npm run backend:typecheck
```

Expected: all PASS; inserts start at 1 and each successful update advances exactly once.

- [ ] **Step 7: Commit the version boundary**

```bash
git add backend/app/services/inventory_versions.py backend/app/services/inventory_operation_locking.py backend/app/services/inventory_operations.py backend/app/services/food_stock.py backend/app/api/inventory.py backend/app/api/shopping_list.py backend/app/api/foods.py backend/app/api/meal_logs.py backend/app/api/recipes.py backend/app/services/ai_operations/inventory.py backend/app/services/ai_operations/shopping.py backend/app/services/ai_operations/foods.py backend/app/services/ai_operations/recipe_cook.py backend/tests/inventory/test_inventory_versions.py backend/tests/inventory/test_inventory_api.py backend/tests/recipes/test_recipe_cooking.py backend/tests/recipes/test_food_stock_operations.py backend/tests/shopping/test_shopping_list_api.py backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_composite_operations.py
git commit -m "feat: enforce inventory version boundaries"
```

## Task 3: Make IngredientInventoryState the Only Presence Truth

**Files:**

- Create: `backend/app/schemas/inventory_states.py`
- Create: `backend/app/services/ingredient_inventory_state.py`
- Create: `backend/app/api/inventory_states.py`
- Modify: `backend/app/api/router.py`
- Modify: `backend/app/api/inventory.py`
- Modify: `backend/app/schemas/inventory.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/services/inventory_usage.py`
- Modify: `backend/app/services/inventory_overview.py`
- Modify: `backend/app/services/search/documents.py`
- Modify: `backend/app/services/search/hybrid.py`
- Modify: `backend/app/services/search/indexing.py`
- Modify: `backend/app/ai/tools/catalog/inventory.py`
- Modify: `backend/app/ai/tools/catalog/meal_ideas.py`
- Modify: `backend/app/services/ai_operations/inventory.py`
- Test: `backend/tests/inventory/test_ingredient_inventory_state.py`
- Test: `backend/tests/inventory/test_inventory_api.py`
- Test: `backend/tests/inventory/test_inventory_overview.py`
- Test: `backend/tests/recipes/test_recipe_cooking.py`
- Test: `backend/tests/search/test_inventory_search.py`
- Test: `backend/tests/search/test_search_documents.py`
- Test: `backend/tests/search/test_rebuild_search_index.py`
- Test: `backend/tests/ai_infra/test_inventory_operations.py`
- Test: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**

```python
class UpsertIngredientInventoryStateRequest(BaseModel):
    expected_ingredient_row_version: int = Field(ge=1)
    state_id: str | None = None
    expected_state_row_version: int | None = Field(default=None, ge=1)
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""

class IngredientInventoryStateOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None
    expiry_date: date | None
    storage_location: str | None
    notes: str
    expiry_alert_snoozed_until: date | None
    expiry_reviewed_at: datetime | None
    expiry_reviewed_by: str | None
    last_confirmed_at: datetime | None
    last_confirmed_by: str | None
    last_confirmation_source: InventoryConfirmationSource | None
    row_version: int
    created_at: datetime
    updated_at: datetime

def list_inventory_states(db: Session, *, family_id: str, ingredient_ids: Iterable[str] | None = None) -> list[IngredientInventoryState]: ...
def upsert_inventory_state(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient: Ingredient,
    expected_ingredient_row_version: int,
    state_id: str | None,
    expected_state_row_version: int | None,
    availability_level: InventoryAvailabilityLevel,
    inventory_status: InventoryStatus,
    purchase_date: date | None,
    expiry_date: date | None,
    storage_location: str | None,
    notes: str,
    confirmation_source: InventoryConfirmationSource | None,
) -> IngredientInventoryState: ...
def state_is_physically_present(state: IngredientInventoryState) -> bool: ...
def state_is_usable(state: IngredientInventoryState, *, business_date: date) -> bool: ...
```

The request validator pairs `state_id` with `expected_state_row_version`, requires a non-empty location for present levels, and rejects current date/location metadata for `absent`. `confirmation_source=None` is reserved for expiry actions and tracking-mode transitions that must not claim a fresh human inventory confirmation; manual entry, reconciliation, and shopping intake always pass their corresponding enum value.

- [ ] **Step 1: Write failing API and truth-source regressions**

Add tests proving:

```python
assert client.get("/api/inventory").json() == []  # legacy salt placeholder excluded
assert client.get("/api/inventory/states").json()[0]["availability_level"] == "present_unknown"
assert recipe_preview_for_salt_has_no_shortage_when_state_is_current
assert recipe_preview_for_salt_has_presence_shortage_when_state_is_absent_or_expired
```

Also test cross-family 404, absent clears purchase/expiry/location/review/snooze, repeat upsert updates one State, and `POST /api/inventory` with a presence ingredient returns 422 `presence_state_required` without creating a row.

- [ ] **Step 2: Run the focused matrix and verify failure**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_ingredient_inventory_state.py \
  tests/inventory/test_inventory_overview.py \
  tests/recipes/test_recipe_cooking.py \
  tests/search/test_inventory_search.py \
  tests/search/test_search_documents.py \
  tests/ai_infra/test_inventory_operations.py -q
```

Expected: legacy placeholders are still treated as current and State endpoints do not exist.

- [ ] **Step 3: Define strict State schemas**

Use the exact `IngredientInventoryStateOut`, `UpsertIngredientInventoryStateRequest`, and structured error contract above. Required request fields include both expected versions; `state_id` and `expected_state_row_version` are null only for first creation. `purchase_date` and `expiry_date` may remain null when Ingredient defaults permit it, but a physically present State must resolve a non-empty `storage_location`; validate date order and default resolution in the service where Ingredient defaults are available.

- [ ] **Step 4: Implement the single State service**

The service locks Ingredient then State, verifies `not_track_quantity`, checks the paired State identity/version, normalizes defaults, clears expiry/review/snooze on absent or changed expiry, updates confirmation fields only when `confirmation_source` is non-null, bumps State and Ingredient versions, and never commits.

```python
if availability_level is InventoryAvailabilityLevel.ABSENT:
    purchase_date = None
    expiry_date = None
    storage_location = None
    state.expiry_alert_snoozed_until = None
    state.expiry_reviewed_at = None
    state.expiry_reviewed_by = None
elif not storage_location:
    storage_location = ingredient.default_storage or "常温"
```

- [ ] **Step 5: Add State routes and precise-only Inventory routes**

Register `inventory_states.router`. `GET /api/inventory/states` is family-scoped and optionally filters `ingredient_ids`. `PUT /api/inventory/states/{ingredient_id}` calls the service with source `manual_entry`, logs one understandable activity, commits once, refreshes, and returns State. Modify GET/POST inventory so historical presence rows never appear and new presence writes are rejected with structured 422. Existing inventory update/consume/dispose/expiry routes must also reject a legacy `not_track_quantity` InventoryItem as `presence_state_required`; only migration, audit, and the Task 17 transition service may read those rows.

- [ ] **Step 6: Cut every current read to State**

Replace presence branches in inventory usage/overview, recipe readiness, search documents/hybrid ranking, AI inventory summary, and meal ideas. Preserve physical versus usable semantics:

```python
physically_present = state.availability_level != InventoryAvailabilityLevel.ABSENT
usable = physically_present and (state.expiry_date is None or state.expiry_date >= business_date)
```

Overview/search may display expired State with danger tone; recipe and meal ideas must treat it as unavailable. Never synthesize an InventoryItem ID for State.

- [ ] **Step 7: Switch AI-approved presence restock to the State service**

The approval executor passes current auth, expected versions from the approved draft, `manual_entry` source, and the approved metadata to `upsert_inventory_state`. Remove the `quantity=1` branch from `create_inventory_batch`; make that helper reject presence ingredients so future callers cannot regress silently.

- [ ] **Step 8: Run all affected back-end suites and commit**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory \
  tests/recipes/test_recipe_cooking.py \
  tests/search/test_inventory_search.py \
  tests/search/test_search_documents.py \
  tests/search/test_hybrid_search.py \
  tests/search/test_rebuild_search_index.py \
  tests/ai_infra/test_inventory_operations.py \
  tests/ai_infra/test_workspace_approvals.py -q
rg -n 'normalized_quantity = Decimal\("1"\)' app
```

Expected: tests PASS and the final `rg` returns no presence-placeholder creation branch.

```bash
git add backend/app/schemas/inventory_states.py backend/app/services/ingredient_inventory_state.py backend/app/api/inventory_states.py backend/app/api/router.py backend/app/api/inventory.py backend/app/schemas/inventory.py backend/app/services/serializers.py backend/app/services/inventory_usage.py backend/app/services/inventory_overview.py backend/app/services/search/documents.py backend/app/services/search/hybrid.py backend/app/services/search/indexing.py backend/app/ai/tools/catalog/inventory.py backend/app/ai/tools/catalog/meal_ideas.py backend/app/services/ai_operations/inventory.py backend/tests/inventory/test_ingredient_inventory_state.py backend/tests/inventory/test_inventory_overview.py backend/tests/inventory/test_inventory_api.py backend/tests/recipes/test_recipe_cooking.py backend/tests/search/test_inventory_search.py backend/tests/search/test_search_documents.py backend/tests/search/test_rebuild_search_index.py backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_workspace_approvals.py
git commit -m "feat: make presence state canonical"
```

## Task 4: Extend the P0.1 Expiry Action Center to State Targets

**Files:**

- Modify: `backend/app/api/inventory_states.py`
- Modify: `backend/app/services/inventory_expiry_actions.py` (created by the P0.1 prerequisite)
- Modify: `backend/app/schemas/inventory_states.py`
- Modify: `backend/tests/inventory/test_inventory_api.py`
- Modify: `backend/tests/inventory/test_ingredient_inventory_state.py`
- Modify: `frontend/src/features/inventory/inventoryActionModel.ts` (created by the P0.1 prerequisite)
- Modify: `frontend/src/features/inventory/inventoryActionModel.test.ts` (created by the P0.1 prerequisite)
- Modify: `frontend/src/features/inventory/InventoryActionDialog.tsx` (created by the P0.1 prerequisite)
- Modify: `frontend/src/features/inventory/InventoryActionDialog.test.tsx` (created by the P0.1 prerequisite)
- Create: `frontend/src/api/inventoryStatesApi.ts`
- Create: `frontend/src/api/inventoryStatesApi.test.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`

**Interfaces:**

```ts
type InventoryExpiryTarget =
  | { targetKind: 'inventory_item'; inventoryItemId: string; expectedRowVersion: number }
  | { targetKind: 'ingredient_inventory_state'; ingredientId: string; stateId: string; expectedRowVersion: number };

type InventoryAvailabilityLevel = 'present_unknown' | 'low' | 'sufficient' | 'absent';
interface IngredientInventoryState {
  id: string;
  family_id: string;
  ingredient_id: string;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date: string | null;
  expiry_date: string | null;
  storage_location: string | null;
  notes: string;
  expiry_alert_snoozed_until: string | null;
  expiry_reviewed_at: string | null;
  expiry_reviewed_by: string | null;
  last_confirmed_at: string | null;
  last_confirmed_by: string | null;
  last_confirmation_source: 'manual_entry' | 'reconciliation' | 'shopping_intake' | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}
```

State API paths are fixed:

```text
POST  /api/inventory/states/{ingredient_id}/snooze-expiry-alert
PATCH /api/inventory/states/{ingredient_id}/expiry-date
POST  /api/inventory/states/{ingredient_id}/set-absent
```

- [ ] **Step 1: Add failing backend State-expiry tests**

Cover expired retain, upcoming snooze, date correction, setting absent, stale version, cross-family, and atomic field clearing. Assert reconciliation confirmation does not modify expiry review fields.

```python
response = client.post(
    "/api/inventory/states/ingredient-salt/set-absent",
    json={"state_id": state.id, "expected_row_version": state.row_version},
)
assert response.status_code == 200
assert response.json()["availability_level"] == "absent"
assert response.json()["expiry_date"] is None
```

- [ ] **Step 2: Add failing frontend union/model tests**

Prove an expired State creates one `expiry` group with a State target, never an invented InventoryItem ID; prove an absent/expired-snoozed State is excluded by the same reference-date rules as P0.1.

- [ ] **Step 3: Implement State expiry services by reusing P0.1 validation**

Extract only target-independent date/action validation from `inventory_expiry_actions.py`. Lock Ingredient then State, verify expected versions, preserve original expiry on retain, write review attribution only for expired retain, clear review/snooze on correction, and set absent through `upsert_inventory_state` semantics. Every successful action bumps State and Ingredient versions.

- [ ] **Step 4: Extend the shared frontend action model/dialog**

Keep `ExpiryInventoryActionGroup` discriminated by target kind. State renders as one household-level row with copy such as `只记录整体有无 · 常温`; disposal confirmation says it will mark the ingredient as no longer present. The dialog routes callbacks by the union and keeps all P0.1 selection/snooze/date constraints.

- [ ] **Step 5: Create the focused State API client and cache contract**

Add the exact State types above to `api/types.ts`. Implement and transport-test `listInventoryStates`, `upsertInventoryState`, `snoozeStateExpiryAlert`, `correctStateExpiryDate`, and `setInventoryStateAbsent` against the exact Task 3/4 paths. Reuse the existing request client and preserve structured error detail. Add `queryKeys.inventoryStates = ['inventory', 'states'] as const` and include State/home/overview in the centralized inventory-action invalidation set; keep query keys and invalidation out of the transport module.

- [ ] **Step 6: Load State before any Phase 1 frontend projection**

Load `IngredientInventoryState[]` in `useAppWorkspaceQueries`, pass it through `App.tsx` and `useAppHomeViewModel`, and feed the shared P0.1 action model both precise batches and States with the same explicit `referenceDate`. Loading/error handling follows the existing inventory query pattern. The home projection must not infer State from a legacy InventoryItem while the State query is pending; show the existing loading state until both sources settle.

- [ ] **Step 7: Wire home actions without adding hooks or dialogs**

Modify existing `useHomeDashboardActions.ts` and `HomeDashboardDialogs.tsx` to call State API methods for State targets. Continue to call P0.1 InventoryItem endpoints for batch targets. Success awaits both inventory and State refetch before calculating the next action.

- [ ] **Step 8: Run focused tests and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_api.py tests/inventory/test_ingredient_inventory_state.py -q
npm --prefix frontend run test -- inventoryStatesApi queryKeys cacheInvalidation inventoryActionModel InventoryActionDialog homeDashboardModel useHomeDashboardActions
git add backend/app/api/inventory_states.py backend/app/services/inventory_expiry_actions.py backend/app/schemas/inventory_states.py backend/tests/inventory/test_inventory_api.py backend/tests/inventory/test_ingredient_inventory_state.py frontend/src/features/inventory/inventoryActionModel.ts frontend/src/features/inventory/inventoryActionModel.test.ts frontend/src/features/inventory/InventoryActionDialog.tsx frontend/src/features/inventory/InventoryActionDialog.test.tsx frontend/src/api/inventoryStatesApi.ts frontend/src/api/inventoryStatesApi.test.ts frontend/src/api/types.ts frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppHomeViewModel.ts frontend/src/App.tsx frontend/src/features/home/useHomeDashboardActions.ts frontend/src/features/home/HomeDashboardDialogs.tsx
git commit -m "feat: support presence expiry actions"
```

## Task 5: Build Idempotent Operation Recording and Complete Snapshot Guards

**Files:**

- Create: `backend/app/repos/inventory_operations.py`
- Create: `backend/app/services/inventory_operation_history.py`
- Create: `backend/app/schemas/inventory_operations.py`
- Create: `backend/tests/inventory/test_inventory_operation_history.py`

**Interfaces:**

```python
SNAPSHOT_SCHEMA_VERSION = 1

class InventoryOperationDisplaySummary(BaseModel):
    title: str
    description: str
    confirmed_count: int = 0
    adjusted_count: int = 0
    completed_count: int = 0
    partial_count: int = 0

class InventoryOperationResult(BaseModel):
    operation_id: str
    operation_type: InventoryOperationType
    status: InventoryOperationStatus
    applied_at: datetime
    revertible_until: datetime
    can_revert: bool
    summary: InventoryOperationDisplaySummary

def canonical_request_hash(payload: BaseModel) -> str: ...
def snapshot_ingredient_collection_guard(ingredient: Ingredient) -> dict[str, object]: ...
def snapshot_inventory_item(item: InventoryItem) -> dict[str, object]: ...
def snapshot_inventory_state(state: IngredientInventoryState) -> dict[str, object]: ...
def snapshot_food_inventory(food: Food) -> dict[str, object]: ...
def snapshot_shopping_item(item: ShoppingListItem) -> dict[str, object]: ...
def find_idempotent_operation(
    db: Session,
    *,
    family_id: str,
    client_request_id: str,
    request_hash: str,
) -> InventoryOperation | None: ...
def claim_inventory_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    operation_type: InventoryOperationType,
    client_request_id: str,
    request_hash: str,
    summary: InventoryOperationDisplaySummary,
) -> tuple[InventoryOperation, bool]: ...  # bool is created_by_this_request
def start_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    operation_type: InventoryOperationType,
    client_request_id: str,
    request_hash: str,
    summary: InventoryOperationDisplaySummary,
) -> InventoryOperation: ...
def record_operation_line(
    db: Session,
    *,
    operation: InventoryOperation,
    sequence: int,
    entity_type: InventoryOperationEntityType,
    entity_id: str,
    change_type: InventoryOperationChangeType,
    before_snapshot: dict[str, object] | None,
    after_snapshot: dict[str, object] | None,
    before_row_version: int | None,
    after_row_version: int | None,
    change_metadata: dict[str, object] | None = None,
) -> InventoryOperationLine: ...
def record_ingredient_collection_guard(
    db: Session,
    *,
    operation: InventoryOperation,
    sequence: int,
    ingredient: Ingredient,
    before_row_version: int,
    after_row_version: int,
) -> InventoryOperationLine: ...
```

- [ ] **Step 1: Write failing canonicalization, claim, and line tests**

Assert field order does not change hash, `Decimal("1.0")` and the normalized business value hash identically, same request ID/same hash returns `(existing_operation, false)`, same request ID/different hash raises `idempotency_key_reused`, and snapshots exclude arbitrary ORM fields.

```python
assert canonical_request_hash(Model(a=Decimal("1.0"), b="x")) == canonical_request_hash(Model(b="x", a=Decimal("1.00")))
assert "password_hash" not in json.dumps(snapshot_inventory_item(item))
```

- [ ] **Step 2: Run and verify failure**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_operation_history.py -q
```

Expected: imports/functions are absent.

- [ ] **Step 3: Implement canonical payload hashing**

Normalize Pydantic data to JSON primitives with sorted keys, stable compact separators, ISO dates/times, and decimal strings without exponent drift. Hash UTF-8 bytes with SHA-256. Include action, expected versions, and every business field; exclude transport-only ordering differences but do not exclude user intent.

```python
canonical = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

- [ ] **Step 4: Implement whitelist snapshot serializers**

Create explicit functions for Ingredient collection guard, InventoryItem, State, Food inventory fields, and ShoppingListItem. Do not serialize `__dict__` or generic ORM columns. Include before/after row versions and `snapshot_schema_version=1` on every line.

- [ ] **Step 5: Implement race-safe repository idempotency behavior**

Family-scope every query. `claim_inventory_operation` first checks for an existing family/request pair, then attempts the unique insert inside `db.begin_nested()` and flushes before any target mutation. If another transaction wins the unique race, roll back only the savepoint, re-query the committed winner, and compare hashes; same hash returns `(winner, false)`, different hash raises structured 409 `idempotency_key_reused`. Do not catch unrelated integrity failures. `start_operation` sets `applied_at=utcnow()`, `revertible_until=applied_at + timedelta(minutes=15)`, `status=applied`, and persists `summary.model_dump(mode="json")` to `summary_json`, but does not commit. Operation services serialize their public response through the shared `InventoryOperationResult`; adapter-specific responses may extend it with typed `items`.

- [ ] **Step 6: Require Ingredient collection guard lines**

Whenever an operation changes any InventoryItem or State for an Ingredient, record exactly one `entity_type=ingredient` guard containing pre/post parent versions and `change_metadata={"role":"collection_version_guard"}`. A test with two changed batches of one Ingredient must still produce one guard line.

- [ ] **Step 7: Run tests and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_operation_history.py -q
git add backend/app/repos/inventory_operations.py backend/app/services/inventory_operation_history.py backend/app/schemas/inventory_operations.py backend/tests/inventory/test_inventory_operation_history.py
git commit -m "feat: record inventory operations safely"
```

## Task 6: Allow Explicitly Unbound Free-Text Shopping Items

**Files:**

- Modify: `backend/app/schemas/shopping.py`
- Modify: `backend/app/api/shopping_list.py`
- Modify: `backend/app/services/serializers.py`
- Test: `backend/tests/shopping/test_shopping_list_api.py`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/ingredientsApi.ts`
- Create: `frontend/src/api/ingredientsApi.test.ts`
- Modify: `frontend/src/components/ingredients/ingredientWorkspaceForms.ts`
- Modify: `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- Modify: `frontend/src/components/ingredients/useIngredientActionState.ts`
- Modify: `frontend/src/components/ingredients/useIngredientOverlayState.ts`
- Test: `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts`
- Test: `frontend/src/components/ingredients/IngredientWorkspaceOverlaysUsage.test.ts`

**Interfaces:**

```python
ShoppingTargetType = Literal["ingredient", "food", "free_text"]

def _resolve_shopping_target(
    *,
    ingredient_id: str | None,
    food_id: str | None,
    family_id: str,
    db: Session,
) -> tuple[Ingredient | None, Food | None]: ...
```

```ts
type ShoppingTargetType = 'ingredient' | 'food' | 'free_text';

type ShoppingDialogFormState = {
  targetType: ShoppingTargetType;
  ingredientId: string;
  foodId: string;
  title: string;
  quantity: string;
  unit: string;
  reason: string;
};
```

The database already permits both foreign keys to be null, so this task adds no migration. The exact invariant becomes “at most one target”: both IDs non-null is invalid; exactly one means a bound Ingredient/Food row; both null means an intentional free-text row. Serialized `target_type` is `ingredient`, `food`, or `free_text` and is never inferred as Ingredient merely because `food_id` is null.

- [ ] **Step 1: Write failing backend create/update/serialization tests**

Add cases proving that title-only create succeeds with `ingredient_id=null`, `food_id=null`, server defaults `quantity=1` and `unit="份"`, and response `target_type="free_text"`. Prove an existing bound item can be explicitly unbound by PATCHing both IDs to null while preserving the submitted title; a free-text item can later bind to a family Ingredient/Food; both IDs non-null remains 422; cross-family target remains 404; ordinary bound behavior is unchanged.

- [ ] **Step 2: Run backend tests and confirm the current XOR failure**

```bash
cd backend && .venv/bin/python -m pytest tests/shopping/test_shopping_list_api.py -q
```

Expected: the new unbound cases fail with the current `采购项必须且只能选择一个采购对象` response or incorrect `target_type`.

- [ ] **Step 3: Implement the three-state backend target contract**

Change `_resolve_shopping_target` to reject only the both-non-null case and return `(None, None)` for an unbound item. `CreateShoppingListItemRequest` accepts omitted quantity/unit for free text and normalizes them to `1`/`份`; bound target defaults continue to come from the target. PATCH distinguishes omitted target fields from two explicit nulls, allows intentional unbinding, and never silently preserves an old target when both nulls were submitted. `serialize_shopping_item` returns `free_text` only when both IDs are null. Do not add a `target_type` database column.

- [ ] **Step 4: Write failing frontend form/API tests**

Assert a blank shopping form starts in `free_text`, title-only submit sends both IDs as null, editing an unbound row stays free-text, the user can explicitly switch to Ingredient/Food binding, and the old `先选择采购对象` guard is gone. Bound Ingredient/Food tests must remain green.

- [ ] **Step 5: Implement explicit free-text creation UI**

Extend `ShoppingDialogFormState.targetType` and `IngredientShoppingOverlay` with a clearly labelled `其他采购` option. `buildShoppingFormFromItem` maps two null IDs to `free_text`. `submitShopping` accepts a non-empty title without a target, sends null IDs and optional quantity/unit defaults, but does not use title matching to auto-bind. Selecting Ingredient/Food remains explicit and overwrites the display title from the selected target as today.

- [ ] **Step 6: Run focused cross-stack checks and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/shopping/test_shopping_list_api.py -q
cd .. && npm --prefix frontend run test -- ingredientsApi IngredientWorkspaceUsage IngredientWorkspaceOverlaysUsage
npm --prefix frontend run typecheck
git add backend/app/schemas/shopping.py backend/app/api/shopping_list.py backend/app/services/serializers.py backend/tests/shopping/test_shopping_list_api.py frontend/src/api/types.ts frontend/src/api/ingredientsApi.ts frontend/src/api/ingredientsApi.test.ts frontend/src/components/ingredients/ingredientWorkspaceForms.ts frontend/src/components/ingredients/IngredientShoppingOverlay.tsx frontend/src/components/ingredients/useIngredientActionState.ts frontend/src/components/ingredients/useIngredientOverlayState.ts frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts frontend/src/components/ingredients/IngredientWorkspaceOverlaysUsage.test.ts
git commit -m "feat: support free-text shopping items"
```

## Task 7: Implement the Atomic Shopping Intake Backend

**Files:**

- Create: `backend/app/services/shopping_intake.py`
- Create: `backend/app/api/shopping_intake.py`
- Create: `backend/tests/shopping/test_shopping_intake_api.py`
- Modify: `backend/app/schemas/inventory_operations.py`
- Modify: `backend/app/api/router.py`
- Modify: `backend/app/services/food_stock.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/app/services/ingredient_inventory_state.py`
- Test: `backend/tests/shopping/test_shopping_list_api.py`
- Test: `backend/tests/recipes/test_food_stock_operations.py`
- Test: `backend/tests/inventory/test_inventory_api.py`

**Interfaces:**

```python
class ExactIngredientShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["exact_ingredient"]
    target_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    actual_quantity: Decimal = Field(gt=0)
    unit: str
    inventory_status: InventoryStatus
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

class PresenceIngredientShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["presence_ingredient"]
    target_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    state_id: str | None = None
    expected_state_row_version: int | None = Field(default=None, ge=1)
    resulting_availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

class FoodShoppingIntakeItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["stock_and_fulfill"]
    target_kind: Literal["food"]
    target_id: str
    expected_food_row_version: int = Field(ge=1)
    actual_quantity: Decimal = Field(gt=0)
    unit: str
    expiry_date: date | None = None
    storage_location: str

class CompleteWithoutInventoryItemRequest(BaseModel):
    shopping_item_id: str
    expected_shopping_item_row_version: int = Field(ge=1)
    action: Literal["complete_without_inventory"]
    target_kind: Literal["none"]
    target_id: None = None

ShoppingIntakeItemRequest = Annotated[
    ExactIngredientShoppingIntakeItemRequest
    | PresenceIngredientShoppingIntakeItemRequest
    | FoodShoppingIntakeItemRequest
    | CompleteWithoutInventoryItemRequest,
    Field(discriminator="target_kind"),
]

class ShoppingIntakeRequest(BaseModel):
    client_request_id: str
    purchase_date: date
    items: list[ShoppingIntakeItemRequest] = Field(min_length=1)

class ShoppingIntakeItemResult(BaseModel):
    shopping_item_id: str
    result: Literal["completed", "partial", "stocked", "completed_without_inventory"]
    remaining_planned_quantity: Decimal | None = None
    inventory_item_id: str | None = None
    state_id: str | None = None
    food_id: str | None = None

class ShoppingIntakeResult(InventoryOperationResult):
    items: list[ShoppingIntakeItemResult]

def merge_food_intake_expiry(
    *,
    current_quantity: Decimal,
    current_expiry: date | None,
    incoming_expiry: date | None,
) -> date | None: ...

def apply_food_stock_intake(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str,
    expiry_date: date | None,
    storage_location: str,
    note: str = "",
) -> Food: ...
```

Schema validators reject duplicate `shopping_item_id`, pair `state_id` with `expected_state_row_version`, reject `absent` as a purchase result, require non-empty unit/location fields, and reject target fields on `complete_without_inventory`. Target versions are required because an atomic intake must not overwrite a Food/State/Ingredient changed after the review screen loaded; the shopping-row version alone cannot protect those targets.

```python
def apply_shopping_intake(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: ShoppingIntakeRequest,
    business_date: date,
) -> ShoppingIntakeResult:
    """Validate and mutate the full intake; never commit."""
```

- [ ] **Step 1: Write the failing intake matrix**

Tests must cover:

- exact Ingredient full purchase creates one batch and completes shopping;
- partial purchase creates actual stock, reduces planned quantity in the original shopping unit, and leaves it open;
- over-purchase stocks the full actual amount and completes shopping;
- actual zero is rejected as `empty_operation`/invalid selection;
- presence purchase updates/creates one State and creates no InventoryItem;
- Food purchase adds aggregate stock in the existing `stock_unit`, applies the explicitly confirmed global location, and merges expiry by the intake-only earliest-date rule;
- Food expiry cases cover current stock zero (use incoming), both dates present (use `min(current, incoming)`), only one date present (keep the non-null date), and both null; ordinary `apply_food_stock_restock` continues to overwrite with a supplied date;
- free text can complete without inventory or link to a real family Ingredient/Food in the same transaction;
- cross-family/mismatched target, incompatible unit, missing manual expiry, duplicate shopping item, stale version, and second concurrent completion all fail atomically;
- same request ID/hash returns the first result without duplicate stock; same ID/different payload returns 409;
- forced commit failure leaves no inventory/state/Food/shopping/operation/activity partial write.

- [ ] **Step 2: Run the new tests and verify failure**

```bash
cd backend && .venv/bin/python -m pytest tests/shopping/test_shopping_intake_api.py -q
```

Expected: endpoint and service absent.

- [ ] **Step 3: Add discriminated schemas and structured errors**

Reject duplicate `shopping_item_id` at schema/service validation. Define response summaries with `operation_id`, `status`, `revertible_until`, per-item `result` (`completed | partial | stocked | completed_without_inventory`), remaining planned quantity, and created/updated entity references. Use detail objects containing `code`, `message`, `conflicts`, and `field_errors`.

- [ ] **Step 4: Claim idempotency, then lock and validate the entire request**

Canonicalize the full request and call `claim_inventory_operation` before target mutation. If it returns `created_by_this_request=false`, serialize and return that operation's original result immediately. Otherwise resolve family-owned shopping rows and targets, collect IDs, and call the global lock helper. Verify every expected shopping/target version, target binding/tracking mode, unit conversion, date, and action before applying any adapter. A free-text row may acquire a target only from explicit `target_id`; never infer from title.

- [ ] **Step 5: Implement four adapters without committing**

Exact Ingredient calls `create_inventory_batch` only after ensuring it now accepts exact ingredients exclusively. Presence Ingredient calls `upsert_inventory_state` with source `shopping_intake`. Food calls the new no-commit `apply_food_stock_intake`; ordinary manual Food restock continues to call `apply_food_stock_restock` and retains its current supplied-date overwrite semantics. Complete-only changes only the shopping row.

`apply_food_stock_intake` captures the pre-intake quantity before adding stock and sets:

```python
if current_quantity <= 0:
    merged_expiry = incoming_expiry
elif current_expiry is None:
    merged_expiry = incoming_expiry
elif incoming_expiry is None:
    merged_expiry = current_expiry
else:
    merged_expiry = min(current_expiry, incoming_expiry)
```

It validates the existing Food unit contract, adds the actual purchase, writes the explicitly confirmed global location, and never commits. Do not change `apply_food_stock_restock` to earliest-date behavior, because that would silently alter ordinary manual-restock semantics outside this workflow.

When a `free_text` ShoppingListItem uses `stock_and_fulfill`, the same transaction first validates the explicit family target, then writes the canonical `ingredient_id` or `food_id`, canonical target title, quantity mode/unit metadata, and completion state before recording its ShoppingListItem snapshot. `complete_without_inventory` leaves both target IDs null. No intake branch binds from title text.

For partial exact purchases:

```python
actual_in_planned_unit = convert_actual_to_planned_unit(...)
if actual_in_planned_unit < shopping.quantity:
    shopping.quantity -= actual_in_planned_unit
    shopping.done = False
else:
    shopping.done = True
```

Never change a presence item's fake numeric quantity because presence shopping uses `quantity_mode`/`display_label`, not a stock number.

- [ ] **Step 6: Record snapshots and one aggregate activity**

Use the operation claimed in Step 4. Record every changed/created entity plus Ingredient guards using final flushed versions. On each ShoppingListItem line, store only the typed replay metadata `{"result": ..., "remaining_planned_quantity": ..., "inventory_item_id": ..., "state_id": ..., "food_id": ...}` in `change_metadata`; this lets a same-hash replay reconstruct the exact `ShoppingIntakeResult` without re-running adapters. Write one activity such as `登记了本次购买：完成 5 项，部分买到 2 项`; do not emit one activity per line from lower helpers—add `record_activity=False` parameters where required while preserving default behavior for ordinary calls.

- [ ] **Step 7: Add route and transaction boundary**

`POST /api/shopping-list/intakes` authenticates, calls the service, invokes `commit_session` once, catches structured conflicts/StaleDataError, rolls back, and returns the original operation result for idempotent replay. Register the router.

- [ ] **Step 8: Run focused backend suites and commit**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/shopping/test_shopping_intake_api.py \
  tests/shopping/test_shopping_list_api.py \
  tests/inventory/test_inventory_api.py \
  tests/recipes/test_food_stock_operations.py -q
git add backend/app/api/shopping_intake.py backend/app/api/router.py backend/app/services/shopping_intake.py backend/app/schemas/inventory_operations.py backend/app/services/food_stock.py backend/app/services/inventory_operations.py backend/app/services/ingredient_inventory_state.py backend/tests/shopping/test_shopping_intake_api.py backend/tests/shopping/test_shopping_list_api.py backend/tests/recipes/test_food_stock_operations.py backend/tests/inventory/test_inventory_api.py
git commit -m "feat: add atomic shopping intake"
```

## Task 8: Add Frontend State, Intake, Operation, and Cache Contracts

**Files:**

- Modify: `frontend/src/api/inventoryStatesApi.ts`
- Modify: `frontend/src/api/inventoryStatesApi.test.ts`
- Create: `frontend/src/api/inventoryOperationsApi.ts`
- Create: `frontend/src/api/inventoryOperationsApi.test.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppMutations.ts`

**Interfaces:**

```ts
export type InventoryAvailabilityLevel = 'present_unknown' | 'low' | 'sufficient' | 'absent';
export type InventoryConfirmationStatus = 'never_confirmed' | 'current' | 'stale';
export interface IngredientInventoryState {
  id: string;
  family_id: string;
  ingredient_id: string;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date: string | null;
  expiry_date: string | null;
  storage_location: string | null;
  notes: string;
  expiry_alert_snoozed_until: string | null;
  expiry_reviewed_at: string | null;
  expiry_reviewed_by: string | null;
  last_confirmed_at: string | null;
  last_confirmed_by: string | null;
  last_confirmation_source: 'manual_entry' | 'reconciliation' | 'shopping_intake' | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}
type ShoppingIntakeItemRequest =
  | { shopping_item_id: string; expected_shopping_item_row_version: number; action: 'stock_and_fulfill'; target_kind: 'exact_ingredient'; target_id: string; expected_ingredient_row_version: number; actual_quantity: number; unit: string; inventory_status: InventoryStatus; expiry_date: string | null; storage_location: string; notes: string }
  | { shopping_item_id: string; expected_shopping_item_row_version: number; action: 'stock_and_fulfill'; target_kind: 'presence_ingredient'; target_id: string; expected_ingredient_row_version: number; state_id: string | null; expected_state_row_version: number | null; resulting_availability_level: Exclude<InventoryAvailabilityLevel, 'absent'>; inventory_status: InventoryStatus; expiry_date: string | null; storage_location: string; notes: string }
  | { shopping_item_id: string; expected_shopping_item_row_version: number; action: 'stock_and_fulfill'; target_kind: 'food'; target_id: string; expected_food_row_version: number; actual_quantity: number; unit: string; expiry_date: string | null; storage_location: string }
  | { shopping_item_id: string; expected_shopping_item_row_version: number; action: 'complete_without_inventory'; target_kind: 'none'; target_id: null };
export interface ShoppingIntakeRequest { client_request_id: string; purchase_date: string; items: ShoppingIntakeItemRequest[] }
export interface ShoppingIntakeItemResult { shopping_item_id: string; result: 'completed' | 'partial' | 'stocked' | 'completed_without_inventory'; remaining_planned_quantity: number | null; inventory_item_id: string | null; state_id: string | null; food_id: string | null }
export interface InventoryOperationDisplaySummary { title: string; description: string; confirmed_count: number; adjusted_count: number; completed_count: number; partial_count: number }
export interface InventoryOperationResult { operation_id: string; operation_type: 'reconciliation' | 'shopping_intake'; status: 'applied' | 'reverted'; applied_at: string; revertible_until: string; can_revert: boolean; summary: InventoryOperationDisplaySummary }
export interface ShoppingIntakeResult extends InventoryOperationResult { items: ShoppingIntakeItemResult[] }
export interface ReconciliationSummary { total_groups: number; never_confirmed: number; stale: number; expired_physical_batches: number }
export interface ReconciliationBatch { inventory_item_id: string; row_version: number; remaining_quantity: number; unit: string; status: InventoryStatus; purchase_date: string; expiry_date: string | null; storage_location: string; notes: string; confirmation_status: InventoryConfirmationStatus; last_confirmed_at: string | null }
export interface ExactIngredientReconciliationGroup { kind: 'exact_ingredient'; ingredient_id: string; ingredient_name: string; ingredient_row_version: number; confirmation_status: InventoryConfirmationStatus; last_confirmed_at: string | null; batches: ReconciliationBatch[]; pending_shopping_item_id: string | null }
export interface PresenceIngredientReconciliationGroup { kind: 'presence_ingredient'; ingredient_id: string; ingredient_name: string; ingredient_row_version: number; state: IngredientInventoryState; confirmation_status: InventoryConfirmationStatus; pending_shopping_item_id: string | null }
export interface FoodReconciliationGroup { kind: 'food'; food_id: string; food_name: string; row_version: number; stock_quantity: number; stock_unit: string; expiry_date: string | null; storage_location: string | null; confirmation_status: InventoryConfirmationStatus; last_confirmed_at: string | null }
export type InventoryReconciliationGroup = ExactIngredientReconciliationGroup | PresenceIngredientReconciliationGroup | FoodReconciliationGroup;
export interface InventoryReconciliationResponse { business_date: string; business_timezone: 'Asia/Shanghai'; generated_at: string; summary: ReconciliationSummary; groups: InventoryReconciliationGroup[] }
export interface VersionedObservedBatchRequest { inventory_item_id: string; expected_row_version: number }
export interface InventoryBatchUpdateRequest { inventory_item_id: string; expected_row_version: number; actual_remaining_quantity: number; inventory_status: InventoryStatus; purchase_date: string; expiry_date: string | null; storage_location: string; notes: string }
export interface InventoryBatchCreateRequest { client_line_id: string; actual_remaining_quantity: number; unit: string; inventory_status: InventoryStatus; purchase_date: string; expiry_date: string | null; storage_location: string; notes: string }
export type InventoryReconciliationGroupRequest =
  | { kind: 'exact_ingredient'; ingredient_id: string; expected_ingredient_row_version: number; action: 'confirm_all' | 'set_absent' | 'adjust_batches'; observed_batches: VersionedObservedBatchRequest[]; updates: InventoryBatchUpdateRequest[]; creates: InventoryBatchCreateRequest[] }
  | { kind: 'presence_ingredient'; ingredient_id: string; state_id: string | null; expected_ingredient_row_version: number; expected_state_row_version: number | null; availability_level: InventoryAvailabilityLevel; inventory_status: InventoryStatus; purchase_date: string | null; expiry_date: string | null; storage_location: string | null; notes: string }
  | { kind: 'food'; food_id: string; expected_row_version: number; action: 'confirm' | 'set_stock'; stock_quantity: number | null; stock_unit: string | null; expiry_date: string | null; storage_location: string | null };
export interface InventoryReconciliationRequest { client_request_id: string; scope: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all'; storage_location: string | null; groups: InventoryReconciliationGroupRequest[] }
```

- [ ] **Step 1: Write failing transport tests**

Mock the existing request layer and assert exact methods, paths, payloads, and preservation of structured `ApiError.detail` for 409/422:

```ts
expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/inventory/states'), expect.anything());
expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/shopping-list/intakes'), expect.objectContaining({ method: 'POST' }));
```

- [ ] **Step 2: Add cross-stack types**

Extend Ingredient, InventoryItem, Food, and ShoppingListItem with required `row_version` and confirmation fields exactly matching backend JSON. Define State and intake unions with discriminants; do not use optional-field bags that allow invalid exact/presence/Food combinations.

- [ ] **Step 3: Extend API modules without duplicating State transport**

Keep Task 4 `listInventoryStates`, `upsertInventoryState`, and State expiry methods in `inventoryStatesApi.ts`. Add `submitShoppingIntake` plus the typed reconciliation/operation methods to `inventoryOperationsApi.ts`, and re-export through the current client aggregation style without moving unrelated APIs.

- [ ] **Step 4: Add centralized keys/invalidation**

Keep Task 4 `inventoryStates` and add:

```ts
inventoryReconciliation: (scope: string, storageLocation?: string) => ['inventory', 'reconciliation', scope, storageLocation ?? ''] as const,
inventoryOperations: ['inventory', 'operations'] as const,
```

`invalidateAfterInventoryOperation` awaits invalidation/refetch for inventory, State, overview, ingredients, foods, shopping, home projections, operations, search, and AI-relevant inventory consumers. Do not duplicate this set in hooks.

- [ ] **Step 5: Compose queries/mutations**

Load States alongside current inventory in `useAppWorkspaceQueries`. Add mutations for State and intake in `useAppMutations`; on success await the centralized invalidation. Do not add automatic mutation retry for non-idempotent calls; intake replay uses the same `client_request_id` only when the draft intentionally retries.

- [ ] **Step 6: Run tests/typecheck and commit**

```bash
npm --prefix frontend run test -- inventoryStatesApi inventoryOperationsApi queryKeys cacheInvalidation
npm --prefix frontend run typecheck
git add frontend/src/api/inventoryStatesApi.ts frontend/src/api/inventoryStatesApi.test.ts frontend/src/api/inventoryOperationsApi.ts frontend/src/api/inventoryOperationsApi.test.ts frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppMutations.ts
git commit -m "feat: add inventory maintenance contracts"
```

## Task 9: Build the Three-Step Shopping Intake Experience

**Files:**

- Create: `frontend/src/features/inventory/shoppingIntakeModel.ts`
- Create: `frontend/src/features/inventory/shoppingIntakeModel.test.ts`
- Create: `frontend/src/features/inventory/useShoppingIntakeState.ts`
- Create: `frontend/src/features/inventory/useShoppingIntakeState.test.ts`
- Create: `frontend/src/features/inventory/useShoppingIntakeActions.ts`
- Create: `frontend/src/features/inventory/useShoppingIntakeActions.test.ts`
- Create: `frontend/src/features/inventory/ShoppingIntakeDialog.tsx`
- Create: `frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx`
- Create: `frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx`
- Modify: `frontend/src/styles/11-inventory-maintenance.css`
- Modify: `frontend/src/styles.css`

**Interfaces:**

```ts
type ShoppingIntakeStep = 'select' | 'review' | 'result';

interface ShoppingIntakeDraftBase {
  shoppingItemId: string;
  expectedShoppingItemRowVersion: number;
  title: string;
  selected: boolean;
}
interface ExactIngredientDraft extends ShoppingIntakeDraftBase {
  kind: 'exact_ingredient';
  targetId: string;
  expectedIngredientRowVersion: number;
  actualQuantity: string;
  unit: string;
  inventoryStatus: InventoryStatus;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}
interface PresenceIngredientDraft extends ShoppingIntakeDraftBase {
  kind: 'presence_ingredient';
  targetId: string;
  expectedIngredientRowVersion: number;
  stateId: string | null;
  expectedStateRowVersion: number | null;
  resultingAvailabilityLevel: Exclude<InventoryAvailabilityLevel, 'absent'>;
  inventoryStatus: InventoryStatus;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}
interface FoodDraft extends ShoppingIntakeDraftBase {
  kind: 'food';
  targetId: string;
  expectedFoodRowVersion: number;
  actualQuantity: string;
  unit: string;
  expiryDate: string | null;
  storageLocation: string;
}
interface FreeTextDraft extends ShoppingIntakeDraftBase {
  kind: 'free_text';
  resolution: 'unresolved' | 'complete_without_inventory';
}
type ShoppingIntakeDraftItem = ExactIngredientDraft | PresenceIngredientDraft | FoodDraft | FreeTextDraft;
interface ShoppingIntakeDraft {
  clientRequestId: string;
  purchaseDate: string;
  createdAt: string;
  items: ShoppingIntakeDraftItem[];
}
function buildShoppingIntakeDraft(args: { shoppingItems: ShoppingListItem[]; ingredients: Ingredient[]; foods: Food[]; selectedItemId?: string; referenceDate: string }): ShoppingIntakeDraft;
function buildShoppingIntakePayload(draft: ShoppingIntakeDraft): ShoppingIntakeRequest;
```

Linking a free-text row replaces its `FreeTextDraft` with the corresponding exact/presence/Food draft populated from the explicitly selected family target and its current row versions; title matching may suggest candidates but never performs the replacement or submission automatically.

- [ ] **Step 1: Write pure-model failures first**

Test: batch entry starts with nothing selected; single-row entry selects only that row; exact quantities default to planned; presence defaults to `sufficient`; Food uses current stock unit/location; manual expiry blocks review; partial/over-purchase summaries are exact; free text has only explicit complete/link actions; `牛奶` never matches `牛奶麦片` and `油` never matches `酱油`.

- [ ] **Step 2: Implement pure defaults/validation/payload functions**

Inject `referenceDate`. Generate `client_request_id` once when the draft is created. Use ingredient ID/food ID binding first and normalized exact title only for a legacy row with no stable target. Preserve decimal strings in form state and convert only in payload construction.

- [ ] **Step 3: Write and implement state/action hook tests**

State owns step, selected IDs, per-row drafts, expanded exceptions, result, busy, and field errors. Actions submit one request, keep dialog/draft open on 409/422, focus the first field error, and move to result only after awaited invalidation/refetch. A network retry reuses the draft request ID; starting a new intake creates a new ID.

- [ ] **Step 4: Build mobile and desktop dialog layouts**

Step 1 is explicit multi-select, Step 2 shows only differences/exceptions, Step 3 shows applied/partial counts and `revertible_until`. Use existing `WorkspaceOverlay`, `ChipGroup`, `QuantityUnitField`, `ActionButton`, status blocks, and `MobileActionBar`. Include loading, empty, field-error, conflict, busy, and result states; no API calls inside the component. Create `InventoryMaintenanceDialogs.tsx` as the single composition shell that initially renders `ShoppingIntakeDialog`; Tasks 13 and 16 extend the same shell with reconciliation and operation history.

- [ ] **Step 5: Add scoped styles and accessibility assertions**

Import `11-inventory-maintenance.css` from `styles.css`. Use only `.inventory-maintenance-*` selectors, minimum ~44px touch targets, safe-area bottom padding, warm Culina tokens, no horizontal overflow at 375/390/430px, and `aria-live` for remaining errors/result.

- [ ] **Step 6: Run focused frontend tests and commit**

```bash
npm --prefix frontend run test -- shoppingIntakeModel useShoppingIntakeState useShoppingIntakeActions ShoppingIntakeDialog
npm --prefix frontend run typecheck
git add frontend/src/features/inventory/shoppingIntakeModel.ts frontend/src/features/inventory/shoppingIntakeModel.test.ts frontend/src/features/inventory/useShoppingIntakeState.ts frontend/src/features/inventory/useShoppingIntakeState.test.ts frontend/src/features/inventory/useShoppingIntakeActions.ts frontend/src/features/inventory/useShoppingIntakeActions.test.ts frontend/src/features/inventory/ShoppingIntakeDialog.tsx frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx frontend/src/styles/11-inventory-maintenance.css frontend/src/styles.css
git commit -m "feat: add shopping intake workflow"
```

## Task 10: Replace Every Shopping Double Mutation and Pass the Phase 1 Gate

**Files:**

- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/features/home/useHomeDashboardState.ts`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/features/home/homeDashboardModel.ts`
- Modify: `frontend/src/features/home/homeDashboardModel.test.ts`
- Modify: `frontend/src/components/ingredients/useIngredientActionState.ts`
- Modify: `frontend/src/components/ingredients/useIngredientOverlayState.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/components/ingredients/IngredientMobileView.tsx`
- Modify: `frontend/src/components/ingredients/workspaceModel.ts`
- Modify: `frontend/src/components/ingredients/workspaceModel.test.ts`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/app/useAppHomeHandlers.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/features/home/useHomeDashboardActions.test.ts` (created or updated by the P0.1 prerequisite)
- Test: `frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts`
- Test: `frontend/src/components/ingredients/IngredientWorkspaceOverlaysUsage.test.ts`
- Test: `frontend/src/components/foods/FoodWorkspace.test.ts`

**Interfaces:**

- Consumes: the free-text shopping contract from Task 6 plus `openShoppingIntake({ selectedItemId? })`, `submitShoppingIntake`, and `ShoppingIntakeDialog` from Tasks 8–9.
- Produces: no shopping-origin path calls `createInventory`/`restockFoodStock` followed by `updateShoppingItem`.

- [ ] **Step 1: Add failing source and interaction regressions**

Assert home `买到了`, Ingredient quick restock, Food shopping restock, and batch `登记本次购买` all open the shared intake workflow. Add a State truth-source fixture where a legacy presence row says available but State says `absent`, and another where no current InventoryItem exists but State says `low`; workspace cards, storage groups, expiry display, and mobile summaries must follow State. Add a source-level guard that fails while `pendingShoppingToComplete` or the partial-success copy remains.

```ts
expect(homeActionsSource).not.toContain('库存已登记');
expect(ingredientSource).not.toContain('pendingShoppingToComplete');
expect(ingredientSource).not.toMatch(/createInventory[\s\S]*updateShoppingItem/);
```

- [ ] **Step 2: Replace home orchestration**

Keep existing home hooks. Replace the restock form submit chain with `openShoppingIntake({selectedItemId})`. In `homeDashboardModel.ts`, resolve ingredient shopping targets by `target_type='ingredient'` plus `ingredient_id`; only legacy rows without an ID may use normalized exact-name equality, never `includes`. Remove only obsolete restock state/props after all callers compile; do not disturb menu planning, meal details, or P0.1 expiry state.

- [ ] **Step 3: Replace Ingredient and Food orchestration**

Delete `pendingShoppingToComplete` and its overlay plumbing. Shopping-origin Ingredient and Food actions open the shared intake. Ordinary manual Ingredient restock continues precise POST or State PUT based on tracking mode; ordinary Food restock continues its stock API. Pass `IngredientInventoryState[]` and an explicit `referenceDate` into `workspaceModel.ts`; remove internal `todayKey()` defaults from the affected presence/expiry projection helpers. Presence branches derive availability, storage, purchase/expiry metadata, action labels, and mobile summaries only from State; exact ingredients remain batch-derived. Legacy presence InventoryItems are ignored even when injected by a stale cache or test fixture.

- [ ] **Step 4: Compose the shared dialog once**

Render through `InventoryMaintenanceDialogs` from the app/workspace composition boundary so desktop/mobile entry points share state/actions without duplicating the dialog. Pass current family/user IDs only to draft storage keys, never to backend request bodies.

- [ ] **Step 5: Run proof searches**

```bash
rg -n "pendingShoppingToComplete|库存已登记.*采购项|待买项仍未标记" frontend/src
rg -n "createInventory|restockFoodStock|updateShoppingItem" frontend/src/features/home frontend/src/components/ingredients frontend/src/components/foods
```

Expected: first command has no hits. Manually inspect remaining calls from the second command and confirm no shopping-source double mutation survives.

- [ ] **Step 6: Run the Phase 1 verification gate**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory \
  tests/shopping \
  tests/recipes/test_food_stock_operations.py \
  tests/recipes/test_recipe_cooking.py \
  tests/search/test_inventory_search.py \
  tests/ai_infra/test_inventory_operations.py \
  tests/ai_infra/test_workspace_approvals.py -q
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run check:style-tokens
```

Expected: PASS. Perform an authenticated test-family walkthrough for exact full/partial/over purchase, presence purchase, Food purchase, free-text complete/link, idempotent retry, and State expiry action.

- [ ] **Step 7: Review, commit, and mark Phase 1 deployable**

Run `backend-code-audit` and `frontend-code-audit` against the Phase 1 diff. A P0/P1 finding in Tasks 1–9 returns to that owning task's exact file/test/commit boundary before this gate restarts; Task 10 integration findings are fixed here. After the affected gates pass, commit only the Task 10 integration files:

```bash
git add frontend/src/features/home/useHomeDashboardActions.ts frontend/src/features/home/useHomeDashboardState.ts frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/features/home/homeDashboardModel.ts frontend/src/features/home/homeDashboardModel.test.ts frontend/src/components/ingredients/useIngredientActionState.ts frontend/src/components/ingredients/useIngredientOverlayState.ts frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx frontend/src/components/ingredients/IngredientWorkspace.tsx frontend/src/components/ingredients/IngredientMobileView.tsx frontend/src/components/ingredients/workspaceModel.ts frontend/src/components/ingredients/workspaceModel.test.ts frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts frontend/src/components/ingredients/IngredientWorkspaceOverlaysUsage.test.ts frontend/src/components/foods/FoodWorkspace.tsx frontend/src/components/foods/FoodWorkspace.test.ts frontend/src/app/useAppHomeHandlers.ts frontend/src/App.tsx
git commit -m "feat: complete atomic inventory intake foundation"
```

Phase 1 is deployable only if ordinary manual restock still works, no presence placeholder can be created, every current frontend/backend presence projection reads State, and all shopping-source writes are atomic.

## Phase 2 — Fast Inventory Reconciliation

## Task 11: Implement Scoped Reconciliation Read and Atomic Submit

**Files:**

- Create: `backend/app/services/inventory_confirmation.py`
- Create: `backend/app/services/inventory_reconciliation.py`
- Create: `backend/app/api/inventory_reconciliation.py`
- Create: `backend/tests/inventory/test_inventory_reconciliation_api.py`
- Modify: `backend/app/schemas/inventory_operations.py`
- Modify: `backend/app/api/router.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/app/services/ingredient_inventory_state.py`
- Modify: `backend/app/services/food_stock.py`

**Interfaces:**

```python
ReconciliationScope = Literal["all", "refrigerated", "frozen", "room_temperature", "suggested"]
ConfirmationStatus = Literal["never_confirmed", "current", "stale"]
FOOD_STALE_AFTER_DAYS = 7
REFRIGERATED_INGREDIENT_STALE_AFTER_DAYS = 14
FROZEN_INGREDIENT_STALE_AFTER_DAYS = 30
ROOM_TEMPERATURE_INGREDIENT_STALE_AFTER_DAYS = 30
PRESENCE_INGREDIENT_STALE_AFTER_DAYS = 30

class ReconciliationSummaryOut(BaseModel):
    total_groups: int
    never_confirmed: int
    stale: int
    expired_physical_batches: int

class ReconciliationBatchOut(BaseModel):
    inventory_item_id: str
    row_version: int
    remaining_quantity: Decimal
    unit: str
    status: InventoryStatus
    purchase_date: date
    expiry_date: date | None
    storage_location: str
    notes: str
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None

class ExactIngredientReconciliationGroupOut(BaseModel):
    kind: Literal["exact_ingredient"]
    ingredient_id: str
    ingredient_name: str
    ingredient_row_version: int
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None
    batches: list[ReconciliationBatchOut]
    pending_shopping_item_id: str | None

class PresenceIngredientReconciliationGroupOut(BaseModel):
    kind: Literal["presence_ingredient"]
    ingredient_id: str
    ingredient_name: str
    ingredient_row_version: int
    state: IngredientInventoryStateOut
    confirmation_status: ConfirmationStatus
    pending_shopping_item_id: str | None

class FoodReconciliationGroupOut(BaseModel):
    kind: Literal["food"]
    food_id: str
    food_name: str
    row_version: int
    stock_quantity: Decimal
    stock_unit: str
    expiry_date: date | None
    storage_location: str | None
    confirmation_status: ConfirmationStatus
    last_confirmed_at: datetime | None

InventoryReconciliationGroupOut = Annotated[
    ExactIngredientReconciliationGroupOut
    | PresenceIngredientReconciliationGroupOut
    | FoodReconciliationGroupOut,
    Field(discriminator="kind"),
]

class InventoryReconciliationOut(BaseModel):
    business_date: date
    business_timezone: Literal["Asia/Shanghai"]
    generated_at: datetime
    summary: ReconciliationSummaryOut
    groups: list[InventoryReconciliationGroupOut]

def build_inventory_reconciliation(
    db: Session,
    *,
    family_id: str,
    scope: ReconciliationScope,
    storage_location: str | None,
    business_date: date,
    generated_at: datetime,
) -> InventoryReconciliationOut: ...
def apply_inventory_reconciliation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    request: InventoryReconciliationRequest,
    business_date: date,
) -> InventoryOperationResult: ...
```

Submit group union:

```python
class VersionedObservedBatch(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)

class InventoryBatchUpdate(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)
    actual_remaining_quantity: Decimal = Field(ge=0)
    inventory_status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

class InventoryBatchCreate(BaseModel):
    client_line_id: str
    actual_remaining_quantity: Decimal = Field(gt=0)
    unit: str
    inventory_status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""

class ExactIngredientReconciliationRequest(BaseModel):
    kind: Literal["exact_ingredient"]
    ingredient_id: str
    expected_ingredient_row_version: int = Field(ge=1)
    action: Literal["confirm_all", "set_absent", "adjust_batches"]
    observed_batches: list[VersionedObservedBatch]
    updates: list[InventoryBatchUpdate] = Field(default_factory=list)
    creates: list[InventoryBatchCreate] = Field(default_factory=list)

class PresenceIngredientReconciliationRequest(BaseModel):
    kind: Literal["presence_ingredient"]
    ingredient_id: str
    state_id: str | None = None
    expected_ingredient_row_version: int = Field(ge=1)
    expected_state_row_version: int | None = Field(default=None, ge=1)
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""

class FoodReconciliationRequest(BaseModel):
    kind: Literal["food"]
    food_id: str
    expected_row_version: int = Field(ge=1)
    action: Literal["confirm", "set_stock"]
    stock_quantity: Decimal | None = None
    stock_unit: str | None = None
    expiry_date: date | None = None
    storage_location: str | None = None

ReconciliationGroupRequest = Annotated[
    ExactIngredientReconciliationRequest
    | PresenceIngredientReconciliationRequest
    | FoodReconciliationRequest,
    Field(discriminator="kind"),
]

class InventoryReconciliationRequest(BaseModel):
    client_request_id: str
    scope: ReconciliationScope
    storage_location: str | None = None
    groups: list[ReconciliationGroupRequest] = Field(min_length=1)
```

Schema validators enforce all of the following before locks are acquired: `observed_batches`, `updates`, and `creates` contain unique IDs; every update ID exists in `observed_batches` with the same expected version; `confirm_all` and `set_absent` have empty updates/creates; `adjust_batches` contains at least one update or create; State `state_id` and `expected_state_row_version` are both null or both non-null; present State levels require a non-empty location while `absent` rejects current date/location metadata; Food `confirm` rejects stock edits, while `set_stock` requires non-negative quantity and a unit/location when quantity is positive; `storage_location` must be null for `all`/`suggested`, and for the three location scopes it may be null (use the fixed canonical label) or exactly equal that scope's canonical Chinese label; and duplicate target groups return structured 422 `duplicate_request_item`.

- [ ] **Step 1: Write the failing read-scope matrix**

Use a fixture containing precise refrigerated normal/expired/zero rows, a room-temperature row of the same Ingredient, present/absent States, and stocked/empty Foods. Assert:

- `refrigerated` includes all refrigerated `remaining > 0` rows including expired, but not room-temperature/zero rows;
- one exact Ingredient group contains only the scope's observed batch IDs plus the parent Ingredient version;
- an out-of-scope row is not in `observed_batches` but still shares the parent version;
- State enters exactly one location by `state.storage_location`; absent/no-State entries are excluded;
- Food enters its one global location when stock > 0;
- `suggested` contains only current inventory groups whose confirmation is never/stale;
- a precise Ingredient included by `suggested` returns all of its physical remaining batches across locations, including current and expired batches;
- response business timezone is `Asia/Shanghai` and business date comes from `today_for_family`, not device/client input.

- [ ] **Step 2: Write the failing submit matrix**

Cover exact confirm, scoped set-absent including expired, batch quantity/date/location correction, new `client_line_id` batch, presence level update, Food confirm/set-stock, untouched rows unchanged, one aggregate operation/activity, and forced rollback. Cover 409 cases: stale child, stale parent from out-of-scope change, new in-scope batch (`scope_changed`), tracking-mode change, and missing/deleted entity.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_reconciliation_api.py -q
```

Expected: endpoint/service absent.

- [ ] **Step 4: Implement confirmation status without change inference**

```python
def confirmation_status(last_confirmed_at: datetime | None, *, generated_at: datetime, stale_after_days: int) -> str:
    if last_confirmed_at is None:
        return "never_confirmed"
    return "stale" if last_confirmed_at < generated_at - timedelta(days=stale_after_days) else "current"
```

Use the exact constants in the interface: Food 7 days, refrigerated Ingredient 14 days, frozen Ingredient 30 days, room-temperature Ingredient 30 days, and presence Ingredient 30 days. Do not inspect `updated_at`/`row_version` and do not define `changed_since_confirmation`.

- [ ] **Step 5: Build discriminated read groups**

Query family data in bounded sets, preload relationships/media needed by the UI, and adapt exact/State/Food separately. For exact groups compute remaining as `quantity - consumed_quantity - disposed_quantity`; include expired physical rows. For State use physical presence, not recipe usability. For Food use positive aggregate stock. Return pending-shopping dedup by stable target IDs.

- [ ] **Step 6: Validate the complete observed set under locks**

For each exact group, lock Ingredient then submitted/current scope rows. Rebuild the current in-scope ID set with the exact same scope predicate and compare to submitted IDs before mutation. Then compare every child version and parent version. Return `scope_changed` for ID-set differences and `stale_version` for version differences.

- [ ] **Step 7: Implement exact adjustments**

For an existing batch:

```python
item.quantity = item.consumed_quantity + item.disposed_quantity + actual_remaining_quantity
```

Leave `consumed_quantity`, `disposed_quantity`, `entered_quantity`, `entered_unit`, and the existing batch `unit` unchanged. Changing an existing batch's unit is outside the approved reconciliation UI because it would require converting historical consumed/disposed values; the member may correct dates/location/status/notes or create a missing batch with the intended unit. New batches use server IDs plus unique request-local `client_line_id`, and write entered values. `set_absent` applies actual remaining zero to every current in-scope physical row, including expired. `confirm_all` changes only confirmation/audit/version fields.

- [ ] **Step 8: Implement State and Food adapters**

State reuses `upsert_inventory_state` with source `reconciliation`; low does not create shopping. Food `confirm` changes only inventory confirmation/version; `set_stock` sets the approved total, consistent unit, global location, and expiry. Zero means absent. Food expiry merging is not used for reconciliation because the user is explicitly confirming the total/date.

- [ ] **Step 9: Record operation/idempotency/activity and add routes**

Hash the complete request and call `claim_inventory_operation` before locking/mutating reconciliation targets; return the existing result immediately when the claim is not new. Record all entity lines/Ingredient guards after flush, and write one aggregate activity. `POST /api/inventory/reconciliations` commits once. `GET /api/inventory/reconciliation` is read-only and accepts only `scope` plus optional `storage_location`.

- [ ] **Step 10: Run focused tests and commit**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_inventory_reconciliation_api.py \
  tests/inventory/test_inventory_versions.py \
  tests/inventory/test_inventory_operation_history.py -q
git add backend/app/services/inventory_confirmation.py backend/app/services/inventory_reconciliation.py backend/app/api/inventory_reconciliation.py backend/app/api/router.py backend/app/schemas/inventory_operations.py backend/tests/inventory/test_inventory_reconciliation_api.py
git commit -m "feat: add atomic inventory reconciliation"
```

## Task 12: Build Pure Reconciliation Models and 24-Hour Local Draft Recovery

**Files:**

- Create: `frontend/src/features/inventory/inventoryReconciliationModel.ts`
- Create: `frontend/src/features/inventory/inventoryReconciliationModel.test.ts`
- Create: `frontend/src/features/inventory/useInventoryReconciliationState.ts`
- Create: `frontend/src/features/inventory/useInventoryReconciliationState.test.ts`
- Modify: `frontend/src/lib/storage.ts`
- Modify: `frontend/src/lib/date.ts`

**Interfaces:**

```ts
export type InventoryReconciliationScope = 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all';

export interface ExactBatchUpdateIntent {
  inventoryItemId: string;
  expectedRowVersion: number;
  actualRemainingQuantity: string;
  inventoryStatus: InventoryStatus;
  purchaseDate: string;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}
export interface ExactBatchCreateIntent {
  clientLineId: string;
  actualRemainingQuantity: string;
  unit: string;
  inventoryStatus: InventoryStatus;
  purchaseDate: string;
  expiryDate: string | null;
  storageLocation: string;
  notes: string;
}
export interface ExactIngredientIntent {
  kind: 'exact_ingredient';
  ingredientId: string;
  expectedIngredientRowVersion: number;
  action: 'confirm_all' | 'set_absent' | 'adjust_batches';
  observedBatches: VersionedObservedBatchRequest[];
  updates: ExactBatchUpdateIntent[];
  creates: ExactBatchCreateIntent[];
}
export interface PresenceIngredientIntent {
  kind: 'presence_ingredient';
  ingredientId: string;
  stateId: string | null;
  expectedIngredientRowVersion: number;
  expectedStateRowVersion: number | null;
  availabilityLevel: InventoryAvailabilityLevel;
  inventoryStatus: InventoryStatus;
  purchaseDate: string | null;
  expiryDate: string | null;
  storageLocation: string | null;
  notes: string;
}
export interface FoodIntent {
  kind: 'food';
  foodId: string;
  expectedRowVersion: number;
  action: 'confirm' | 'set_stock';
  stockQuantity: string | null;
  stockUnit: string | null;
  expiryDate: string | null;
  storageLocation: string | null;
}
export type ReconciliationIntent = ExactIngredientIntent | PresenceIngredientIntent | FoodIntent;
export interface InventoryReconciliationDraft {
  schemaVersion: 1;
  familyId: string;
  userId: string;
  clientRequestId: string;
  scope: InventoryReconciliationScope;
  createdAt: string;
  savedAt: string;
  intents: ReconciliationIntent[];
}
export interface DraftReplayConflict {
  targetKey: string;
  code: 'stale_version' | 'scope_changed' | 'missing_target' | 'tracking_mode_changed';
  message: string;
}
export interface DraftReplayResult {
  restoredDraft: InventoryReconciliationDraft | null;
  conflicts: DraftReplayConflict[];
  newlyDiscoveredTargetKeys: string[];
  discardedReason: 'expired' | 'family_mismatch' | 'user_mismatch' | 'schema_mismatch' | null;
}
export function replayReconciliationDraft(args: { draft: InventoryReconciliationDraft; latest: InventoryReconciliationResponse; referenceDate: string; now: string }): DraftReplayResult;
```

- [ ] **Step 1: Write failing pure-model tests**

Test grouping labels, physical expired inclusion, exact remaining calculations, State/Food branches, explicit reference-date freshness, payload construction, unique `client_line_id`, and summary counts. Test no intent for untouched groups.

- [ ] **Step 2: Write failing draft replay tests**

Cover: valid same-version intent preserved; version-changed intent marked conflict; deleted entity removed with explanation; new entity added to view but not auto-confirmed; tracking-mode-changed intent invalidated; expired draft older than 24 hours discarded; family/user/schema mismatch discarded; client request ID preserved only for a valid restored draft.

- [ ] **Step 3: Implement pure model helpers**

No helper may call `todayKey()`, localStorage, APIs, or React. Use discriminated switches with exhaustive `never` checks. Keep business quantities as strings in drafts and validate/convert during payload creation.

- [ ] **Step 4: Implement storage key and safe persistence**

```ts
export const reconciliationDraftKey = (familyId: string, userId: string) =>
  `culina:inventory-reconciliation-draft:${familyId}:${userId}`;
```

Use `readJsonStorage`, `writeJsonStorage`, and `removeStorage`. Save after meaningful intent changes, not on every render. Never store auth tokens, full member records, or server response caches.

- [ ] **Step 5: Implement the state hook**

The hook owns open, scope, focused group, expanded batch details, intents, summary confirmation, busy/result/conflict state, and restored-draft prompt. Opening does not mark anything confirmed. Closing while not busy preserves the draft; successful submit clears it only after result is stored.

- [ ] **Step 6: Run tests and commit**

```bash
npm --prefix frontend run test -- inventoryReconciliationModel useInventoryReconciliationState
npm --prefix frontend run typecheck
git add frontend/src/features/inventory/inventoryReconciliationModel.ts frontend/src/features/inventory/inventoryReconciliationModel.test.ts frontend/src/features/inventory/useInventoryReconciliationState.ts frontend/src/features/inventory/useInventoryReconciliationState.test.ts frontend/src/lib/storage.ts frontend/src/lib/date.ts
git commit -m "feat: add recoverable reconciliation drafts"
```

## Task 13: Add Reconciliation Actions and Mobile/Desktop Task UI

**Files:**

- Create: `frontend/src/features/inventory/useInventoryReconciliationActions.ts`
- Create: `frontend/src/features/inventory/useInventoryReconciliationActions.test.ts`
- Create: `frontend/src/features/inventory/InventoryReconciliationDialog.tsx`
- Create: `frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx`
- Modify: `frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx`
- Modify: `frontend/src/features/inventory/inventoryReconciliationModel.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/components/ingredients/IngredientHubPage.tsx`
- Modify: `frontend/src/components/ingredients/IngredientMobileView.tsx`
- Modify: `frontend/src/app/useAppMutations.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/11-inventory-maintenance.css`

**Interfaces:**

```ts
interface UseInventoryReconciliationActionsArgs {
  familyId: string;
  userId: string;
  referenceDate: string;
  state: ReturnType<typeof useInventoryReconciliationState>;
  fetchReconciliation: (args: { scope: InventoryReconciliationScope; storageLocation: string | null }) => Promise<InventoryReconciliationResponse>;
  submitReconciliation: (request: InventoryReconciliationRequest) => Promise<InventoryOperationResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice: (notice: { tone: 'success' | 'warning' | 'danger'; title: string; message: string }) => void;
}
interface InventoryReconciliationActions {
  openReconciliation: (scope: InventoryReconciliationScope, storageLocation?: string | null) => Promise<void>;
  submitDraft: () => Promise<void>;
  retryLatest: () => Promise<void>;
}
function useInventoryReconciliationActions(args: UseInventoryReconciliationActionsArgs): InventoryReconciliationActions;
```

- [ ] **Step 1: Write failing action-hook tests**

Assert open fetches the selected scope; restored drafts fetch latest then replay; submit sends only touched intents; 409 refreshes latest, preserves non-conflicting intents, places conflicts first, and keeps dialog open; 422 maps `field_errors` to group controls; network errors preserve draft; success clears draft after awaited invalidation and shows result/revert deadline.

- [ ] **Step 2: Implement action orchestration**

Keep request/refetch logic out of the component. Prevent duplicate submits and close/drag while busy. Treat legacy string `detail` and structured detail objects. Never optimistically mutate canonical inventory caches.

- [ ] **Step 3: Write failing UI interaction tests**

Cover scope chips, progress, exact `确认无误/调整数量/没有了`, presence four-state chips, Food aggregate warning, expired physical row visibility, batch create/edit, submit summary, empty/loading/error/conflict/result states, keyboard close, and mobile action bar.

- [ ] **Step 4: Implement separate mobile/desktop presentations**

Use one component contract and pure models, but render a near-full-height task sheet under mobile CSS and a left-list/right-summary desktop layout. Default collapsed cards show household concepts; batch rows appear only after adjustment/detail expansion. Never render a dense table.

- [ ] **Step 5: Integrate entry points**

Add `快速盘点` to the inventory workspace desktop action area and mobile inventory page. A P0.1 long-unconfirmed home action may navigate to this entry with `scope=suggested`; reconciliation remains usable directly without home. Compose through `InventoryMaintenanceDialogs` and do not add new home state/action hook files.

- [ ] **Step 6: Apply Culina styles and accessibility**

Use `.inventory-maintenance-*`, warm surfaces, clear text labels in addition to color, ~44px controls, safe-area bottom padding, reduced-motion rules, and no horizontal overflow. Provide `aria-live` for progress/errors and explicit labels for quantity/date/location fields.

- [ ] **Step 7: Run focused tests/build and commit**

```bash
npm --prefix frontend run test -- inventoryReconciliationModel useInventoryReconciliationState useInventoryReconciliationActions InventoryReconciliationDialog IngredientMobile IngredientWorkspace
npm --prefix frontend run build
npm --prefix frontend run check:style-tokens
git add frontend/src/features/inventory/useInventoryReconciliationActions.ts frontend/src/features/inventory/useInventoryReconciliationActions.test.ts frontend/src/features/inventory/InventoryReconciliationDialog.tsx frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx frontend/src/features/inventory/inventoryReconciliationModel.ts frontend/src/components/ingredients/IngredientWorkspace.tsx frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/components/ingredients/IngredientHubPage.tsx frontend/src/components/ingredients/IngredientMobileView.tsx frontend/src/app/useAppMutations.ts frontend/src/App.tsx frontend/src/styles/11-inventory-maintenance.css
git commit -m "feat: add fast inventory reconciliation UI"
```

## Task 14: Pass the Phase 2 Conflict, Responsive, and Smoke Gate

**Files:**

- Modify: `frontend/scripts/smoke.mjs`
- Test: `frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx`
- Test: `frontend/src/features/inventory/useInventoryReconciliationActions.test.ts`

- [ ] **Step 1: Extend smoke fixtures with all three inventory adapters**

Include two exact batches for one Ingredient, one expired batch, one out-of-scope batch, one presence State, one stocked Food, never/current/stale confirmation timestamps, a pending ingredient-bound shopping item, and stable row versions. Do not use production household data.

- [ ] **Step 2: Add responsive task assertions**

At 375, 390, 430, and desktop widths: open quick reconciliation, switch scope, confirm one row, adjust one batch, set one presence item low, reach summary, and assert no horizontal overflow. Verify bottom action bar respects safe area.

- [ ] **Step 3: Add a two-client API conflict walkthrough**

Using the dedicated test family, have client A load refrigerator reconciliation; client B modify an out-of-scope batch of the same Ingredient; client A submits and must receive 409 with preserved draft. Repeat with an in-scope newly added batch and expect `scope_changed`.

- [ ] **Step 4: Run the Phase 2 gate**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_reconciliation_api.py tests/inventory/test_inventory_versions.py -q
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

Expected: PASS.

- [ ] **Step 5: Audit, fix, and commit the deployable checkpoint**

Run backend/frontend audit skills against the Phase 2 diff. A P0/P1 finding returns to its owning Task 11–13 file/test/commit boundary before this gate restarts. Once the gate is clean, commit only the smoke path added by this task:

```bash
git add frontend/scripts/smoke.mjs
git commit -m "test: verify inventory reconciliation flows"
```

Phase 2 is deployable only when expired physical rows can be cleared, untouched rows remain untouched, and every stale/scope conflict is recoverable without losing the local draft.

## Phase 3 — Safe Undo and Maintenance Experience

## Task 15: Implement Family Operation History, Detail, and Whole-Operation Revert

**Files:**

- Create: `backend/app/api/inventory_operations.py`
- Create: `backend/tests/inventory/test_inventory_operation_revert.py`
- Modify: `backend/app/api/router.py`
- Modify: `backend/app/services/inventory_operation_history.py`
- Modify: `backend/app/repos/inventory_operations.py`
- Modify: `backend/app/schemas/inventory_operations.py`
- Modify: `backend/tests/inventory/test_inventory_operation_history.py`

**Interfaces:**

```python
class InventoryOperationLineDisplayOut(BaseModel):
    sequence: int
    entity_type: InventoryOperationEntityType
    change_type: InventoryOperationChangeType
    title: str
    description: str

class InventoryOperationSummaryOut(InventoryOperationResult):
    actor_display_name: str

class InventoryOperationDetailOut(InventoryOperationSummaryOut):
    lines: list[InventoryOperationLineDisplayOut]

def list_inventory_operations(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    now: datetime,
    limit: int = 20,
) -> list[InventoryOperationSummaryOut]: ...
def get_inventory_operation_detail(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    operation_id: str,
    now: datetime,
) -> InventoryOperationDetailOut: ...
def revert_inventory_operation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    operation_id: str,
    now: datetime,
) -> InventoryOperationResult: ...
```

- [ ] **Step 1: Write failing list/detail tests**

Assert family scope, newest-first default 20, max 50 validation, safe member display names, operation type/status, understandable summaries, revert deadline, and human-readable line changes. `can_revert` is computed from the requesting member, role, status, deadline, and ownership; the list/detail service therefore receives `user_id`, `user_role`, and `now`. Detail must not expose raw snapshot JSON, internal actor IDs, or Ingredient `collection_version_guard` lines as display copy; guard lines remain available only to the revert validator.

- [ ] **Step 2: Write the complete failing revert matrix**

Cover:

- original Member reverts within 15 minutes;
- Owner reverts another member's operation;
- Member cannot revert another member's operation;
- cross-family operation is 404;
- expired deadline, modified entity, changed Ingredient collection guard, consumed/disposed new batch, and already-deleted target reject atomically;
- repeated revert returns current `reverted` result without another write;
- exact batch create is deleted only when safe;
- State create is deleted only when safe; State update restores whitelist values;
- Food and Shopping values restore together;
- restored versions increase beyond after versions instead of reverting integers;
- forced commit failure leaves the operation applied and all entities unchanged.

- [ ] **Step 3: Lock the operation and reconstruct target lock sets**

Lock the family-owned operation first with `FOR UPDATE`, then read lines, derive IDs, and invoke the global target lock helper in its fixed order. Check status, permission, deadline, every after version, and create-specific consumption/disposal invariants before changing any entity.

- [ ] **Step 4: Restore only snapshot whitelists**

For `update`, copy approved business fields from `before_snapshot` but never copy the old row version or audit timestamps. For safe `create`, delete the created entity. Ingredient guard lines validate and then bump the parent version; they do not restore Ingredient profile fields. Reject unknown `snapshot_schema_version` as `operation_not_revertible`.

- [ ] **Step 5: Finalize status and activity in the same transaction**

Set operation `status=reverted`, `reverted_at`, `reverted_by`; write one aggregate `ActivityAction.REVERT`; flush to obtain final versions; commit only in the route. A replay sees `reverted` and returns without applying again.

- [ ] **Step 6: Add authenticated routes**

```text
GET  /api/inventory/operations?limit=20
GET  /api/inventory/operations/{operation_id}
POST /api/inventory/operations/{operation_id}/revert
```

Map known conditions to the exact design codes: `operation_expired`, `operation_not_revertible`, `operation_modified_after_apply`; preserve family-safe 404 and same-family 403.

- [ ] **Step 7: Run focused tests and commit**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_inventory_operation_history.py \
  tests/inventory/test_inventory_operation_revert.py \
  tests/shopping/test_shopping_intake_api.py \
  tests/inventory/test_inventory_reconciliation_api.py -q
git add backend/app/api/inventory_operations.py backend/app/api/router.py backend/app/services/inventory_operation_history.py backend/app/repos/inventory_operations.py backend/app/schemas/inventory_operations.py backend/tests/inventory/test_inventory_operation_revert.py backend/tests/inventory/test_inventory_operation_history.py
git commit -m "feat: add safe inventory operation undo"
```

## Task 16: Add Operation Result, History, and Revert UI

**Files:**

- Create: `frontend/src/features/inventory/InventoryOperationBanner.tsx`
- Create: `frontend/src/features/inventory/InventoryOperationBanner.test.tsx`
- Create: `frontend/src/features/inventory/InventoryOperationHistoryDialog.tsx`
- Create: `frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx`
- Modify: `frontend/src/api/inventoryOperationsApi.ts`
- Modify: `frontend/src/api/inventoryOperationsApi.test.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppMutations.ts`
- Modify: `frontend/src/features/inventory/useShoppingIntakeActions.ts`
- Modify: `frontend/src/features/inventory/useInventoryReconciliationActions.ts`
- Modify: `frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/styles/11-inventory-maintenance.css`

**Interfaces:**

```ts
interface InventoryOperationSummary extends InventoryOperationResult {
  actor_display_name: string;
}

interface InventoryOperationLineDisplay {
  sequence: number;
  entity_type: 'ingredient' | 'inventory_item' | 'non_tracked_ingredient_state' | 'food' | 'shopping_list_item';
  change_type: 'create' | 'update' | 'delete';
  title: string;
  description: string;
}

interface InventoryOperationDetail extends InventoryOperationSummary {
  lines: InventoryOperationLineDisplay[];
}
```

- [ ] **Step 1: Write failing API and component tests**

Assert list/detail/revert methods and structured 409 behavior. Component tests cover live countdown copy, eligible/ineligible actions, newest 20, detail expansion, immediate result undo, Member/Owner server-provided `can_revert`, successful reverted state, and conflict/expired notices without closing the dialog.

- [ ] **Step 2: Add operation queries/mutation**

Load recent operations only when the inventory/shopping maintenance surface is active or history is opened. Revert mutation awaits centralized inventory-operation invalidation before replacing the banner/result state. Do not place operation records in the background-task notification center.

- [ ] **Step 3: Implement the recent-operation banner**

Show the most recent applied, still-revertible operation with household copy such as `本次购买已登记 · 可在 14:32 前撤销`. Buttons are `查看` and `撤销本次操作`; once expired or reverted, remove the destructive affordance while keeping history detail available.

- [ ] **Step 4: Implement history/detail dialog**

Render understandable line summaries returned by the backend; do not inspect raw snapshot JSON. Provide loading, empty, error, applied, reverted, expired, and conflict states. Keep destructive confirmation explicit and show that undo applies to the whole operation.

- [ ] **Step 5: Connect success results and inventory workspace**

Shopping intake and reconciliation success views expose the same operation result/revert callback. Closing the result may leave the recent banner in inventory or shopping panels. Compose history/revert through `InventoryMaintenanceDialogs`.

- [ ] **Step 6: Run tests/build and commit**

```bash
npm --prefix frontend run test -- inventoryOperationsApi InventoryOperationBanner InventoryOperationHistoryDialog useShoppingIntakeActions useInventoryReconciliationActions
npm --prefix frontend run build
git add frontend/src/features/inventory/InventoryOperationBanner.tsx frontend/src/features/inventory/InventoryOperationBanner.test.tsx frontend/src/features/inventory/InventoryOperationHistoryDialog.tsx frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx frontend/src/api/inventoryOperationsApi.ts frontend/src/api/inventoryOperationsApi.test.ts frontend/src/api/queryKeys.ts frontend/src/api/cacheInvalidation.ts frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppMutations.ts frontend/src/features/inventory/useShoppingIntakeActions.ts frontend/src/features/inventory/useInventoryReconciliationActions.ts frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/styles/11-inventory-maintenance.css
git commit -m "feat: add inventory operation history and undo"
```

## Task 17: Add Transactional Tracking-Mode Transition Guards

**Files:**

- Modify: `backend/app/schemas/ingredients.py`
- Modify: `backend/app/api/ingredients.py`
- Modify: `backend/app/services/ingredient_inventory_state.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/tests/inventory/test_inventory_api.py`
- Modify: `backend/tests/inventory/test_ingredient_inventory_state.py`
- Modify: `frontend/src/api/ingredientsApi.ts`
- Modify: `frontend/src/api/ingredientsApi.test.ts`
- Modify: `frontend/src/components/ingredients/useIngredientEditorState.ts`
- Modify: `frontend/src/components/ingredients/IngredientEditorView.tsx`
- Modify: `frontend/src/components/ingredients/IngredientEditorViewUsage.test.ts`

**Interfaces:**

```text
PATCH /api/ingredients/{ingredient_id}/tracking-mode
```

```python
class VersionedInventoryItemRef(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)

class PresenceTransitionResolution(BaseModel):
    availability_level: InventoryAvailabilityLevel
    inventory_status: InventoryStatus
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""
    mark_inventory_confirmed: bool = False

class ExactTransitionResolution(BaseModel):
    confirm_absent: bool
    quantity: Decimal | None = None
    unit: str | None = None
    inventory_status: InventoryStatus | None = None
    purchase_date: date | None = None
    expiry_date: date | None = None
    storage_location: str | None = None
    notes: str = ""

class IngredientTrackingModeTransitionRequest(BaseModel):
    expected_ingredient_row_version: int
    target_mode: IngredientQuantityTrackingMode
    expected_state_row_version: int | None = None
    observed_batches: list[VersionedInventoryItemRef] = Field(default_factory=list)
    presence_resolution: PresenceTransitionResolution | None = None
    exact_resolution: ExactTransitionResolution | None = None
```

The request validator requires exactly one resolution matching the requested transition. For exact→presence, `presence_resolution` is required, observed batch IDs/versions must be unique and complete, a present level requires non-empty `storage_location`, and `absent` requires null purchase/expiry/location. `mark_inventory_confirmed=false` preserves null/existing `last_confirmed_*`; the UI sets it true only after the member explicitly chooses a presence level, never merely because a suggested default was displayed. For presence→exact, `exact_resolution` is required and `observed_batches` is empty: `confirm_absent=true` requires quantity/unit/status/purchase/expiry/location to be null, while `confirm_absent=false` requires `quantity > 0`, non-empty unit/location, status, and purchase date. The service verifies whether `expected_state_row_version` must be present from the locked current State and returns structured 409 on a stale/missing State.

- [ ] **Step 1: Write failing transition tests**

Cover exact→presence with/without physical rows, explicit `present_unknown/low/sufficient/absent`, context metadata, old exact rows retained but excluded after transition, and no false confirmation from a mode-only edit. Cover presence→exact with explicit no stock or a real initial batch, State cleared to absent, old placeholder quantity never reused, stale parent/State/batch versions, and rollback.

- [ ] **Step 2: Prevent generic profile update from changing mode**

If the ordinary Ingredient update payload changes `quantity_tracking_mode`, return structured 422 `tracking_transition_required`. Name/category/default changes continue through the existing endpoint.

- [ ] **Step 3: Implement exact→presence transaction**

Lock Ingredient then all current physical batches, verify the complete observed set/versions, require the user's household-level resolution, update mode, create/update State, and leave exact rows untouched as history. Only an explicit user status decision may set confirmation source; a server-derived default alone leaves `last_confirmed_*` null.

- [ ] **Step 4: Implement presence→exact transaction**

Lock Ingredient then State. Require either explicit zero inventory or an actual positive quantity/unit/status/date/location. Update mode and, when positive, create a real exact batch through unit conversion; set State absent and clear its current metadata. The transition is one transaction and is not entered into the 15-minute operation history.

- [ ] **Step 5: Add editor confirmation UI**

When mode changes, present a blocking explanation and the correct resolution fields. Never silently submit the generic edit first. Use current row versions, preserve the editor on 409/422, and refresh the Ingredient/inventory/State only after success.

- [ ] **Step 6: Run focused tests and commit**

```bash
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_api.py tests/inventory/test_ingredient_inventory_state.py -q
npm --prefix frontend run test -- ingredientsApi IngredientEditorView
npm --prefix frontend run typecheck
git add backend/app/schemas/ingredients.py backend/app/api/ingredients.py backend/app/services/ingredient_inventory_state.py backend/app/services/inventory_operations.py backend/tests/inventory/test_inventory_api.py backend/tests/inventory/test_ingredient_inventory_state.py frontend/src/api/ingredientsApi.ts frontend/src/api/ingredientsApi.test.ts frontend/src/components/ingredients/useIngredientEditorState.ts frontend/src/components/ingredients/IngredientEditorView.tsx frontend/src/components/ingredients/IngredientEditorViewUsage.test.ts
git commit -m "feat: guard ingredient tracking transitions"
```

## Task 18: Finish Freshness Presentation and Overlay Accessibility

**Files:**

- Modify: `frontend/src/components/ui-kit/WorkspaceOverlay.tsx`
- Modify: `frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx`
- Modify: `frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx`
- Modify: `frontend/src/features/inventory/InventoryReconciliationDialog.tsx`
- Modify: `frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx`
- Modify: `frontend/src/features/inventory/ShoppingIntakeDialog.tsx`
- Modify: `frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx`
- Modify: `frontend/src/features/inventory/InventoryOperationHistoryDialog.tsx`
- Modify: `frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx`
- Modify: `frontend/src/components/ingredients/workspaceModel.ts`
- Modify: `frontend/src/components/ingredients/workspaceModel.test.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/components/ingredients/IngredientMobileView.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/styles/11-inventory-maintenance.css`

**Interfaces:**

```ts
type WorkspaceOverlayFrameProps = {
  children: ReactNode;
  onClose: () => void;
  labelledBy: string;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  restoreFocusTo?: HTMLElement | null;
  closeOnBackdrop?: boolean;
};
```

- [ ] **Step 1: Write failing accessibility tests**

Assert `role=dialog`, `aria-modal=true`, `aria-labelledby`, initial focus, Escape close, focus restoration, busy-state close/backdrop/Escape/drag prevention, and `aria-live` errors. Assert background content is not reached by normal tab order while the overlay is active using the existing overlay mounting pattern.

- [ ] **Step 2: Implement backward-compatible overlay semantics**

Add optional props with safe defaults so existing overlays continue to work. Put dialog semantics on the panel, restore focus on unmount/close, handle Escape at the frame boundary, and make mobile drag consult `busy` before starting/finishing. Do not put inventory business rules in the UI kit.

- [ ] **Step 3: Display only the three approved freshness states**

In Ingredient/Food inventory cards and reconciliation suggestions, render `从未确认`, `刚确认过`, or `建议再确认` with text plus neutral/green/amber status treatment. Do not calculate freshness from `updated_at` or expose `changed_since_confirmation`. P0.1 home long-unconfirmed actions navigate to reconciliation `scope=suggested`.

- [ ] **Step 4: Add freshness to the Phase 1 State projections**

Extend the State-aware `workspaceModel.ts` contract completed in Task 10 with the three confirmation labels and timestamps. Exact Ingredient behavior remains batch-based and Food remains aggregate. Keep the Phase 1 disagreement regression (legacy presence rows disagree with State and State wins) while adding never/current/stale assertions; do not reintroduce a second presence projection path.

- [ ] **Step 5: Run UI tests/build and commit**

```bash
npm --prefix frontend run test -- WorkspaceOverlayFrame InventoryReconciliationDialog ShoppingIntakeDialog InventoryOperationHistoryDialog workspaceModel IngredientMobile FoodWorkspace
npm --prefix frontend run build
npm --prefix frontend run check:style-tokens
git add frontend/src/components/ui-kit/WorkspaceOverlay.tsx frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx frontend/src/features/inventory/InventoryReconciliationDialog.tsx frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx frontend/src/features/inventory/ShoppingIntakeDialog.tsx frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx frontend/src/features/inventory/InventoryOperationHistoryDialog.tsx frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx frontend/src/components/ingredients/workspaceModel.ts frontend/src/components/ingredients/workspaceModel.test.ts frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/components/ingredients/IngredientMobileView.tsx frontend/src/components/foods/FoodWorkspace.tsx frontend/src/features/home/useHomeDashboardActions.ts frontend/src/styles/00-ui-kit.css frontend/src/styles/11-inventory-maintenance.css
git commit -m "feat: finish inventory maintenance accessibility"
```

## Task 19: Prove MySQL Concurrency, Run Full Acceptance, and Close the Epic

**Files:**

- Create: `backend/tests/inventory/test_inventory_mysql_concurrency.py`
- Modify: `frontend/scripts/smoke.mjs`
- Test: `backend/tests/inventory/test_inventory_reconciliation_api.py`
- Test: `backend/tests/inventory/test_inventory_operation_revert.py`
- Test: `backend/tests/shopping/test_shopping_intake_api.py`
- Test: `frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx`
- Test: `frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx`
- Test: `frontend/src/features/inventory/InventoryOperationHistoryDialog.test.tsx`

- [ ] **Step 1: Write real MySQL barrier tests**

Use two independent SQLAlchemy Sessions and a thread barrier. Do not use SQLite/mock. Cover:

1. reconciliation versus consume;
2. two members intaking the same shopping item;
3. partial intake versus shopping edit;
4. revert versus consume;
5. reverse request ordering across the same entity set without stable deadlock;
6. concurrent first creation of one State produces one row;
7. State manual upsert versus State reconciliation returns one stale conflict;
8. out-of-scope child change invalidates a scoped reconciliation.
9. two sessions submit the same `client_request_id` and identical payload concurrently, producing one stock mutation, one operation, and the same operation result in both responses.

Each test must assert final database values, operation count, activity count, and absence of partial writes—not only status codes.

- [ ] **Step 2: Run the MySQL suite repeatedly**

```bash
npm run db:up
npm run backend:migrate
cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py -q --count=3
```

If `pytest-repeat` is not installed, run the same command three times without `--count`; do not add a dependency solely for repetition. Expected: all runs PASS with no hang/deadlock.

- [ ] **Step 3: Complete authenticated product acceptance**

Using only a disposable representative family, verify:

- exact full/partial/over purchase and free-text complete/link;
- presence intake updates one State and creates no placeholder;
- State expired action/review/correction/absent;
- refrigerator reconciliation includes expired physical rows and excludes room-temperature rows;
- stale and scope-changed submissions keep/replay drafts;
- Food location warning and aggregate adjustment;
- 15-minute Member/Owner revert rules;
- tracking-mode transitions;
- mobile 375/390/430px and desktop layouts, keyboard focus, reduced motion, safe area, and no overflow;
- home/Ingredient/Food shopping entry points all reach the same intake workflow.

Do not inspect or modify irreplaceable family data.

- [ ] **Step 4: Run the final automated gates**

```bash
cd backend && .venv/bin/python -m pytest \
  tests/inventory/test_ingredient_inventory_state.py \
  tests/inventory/test_inventory_reconciliation_api.py \
  tests/inventory/test_inventory_operation_history.py \
  tests/inventory/test_inventory_operation_revert.py \
  tests/inventory/test_inventory_versions.py \
  tests/shopping/test_shopping_intake_api.py \
  tests/recipes/test_food_stock_operations.py \
  tests/recipes/test_recipe_cooking.py -q
cd .. && npm run backend:typecheck
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run check:style-tokens
npm --prefix frontend run smoke
git diff --check
```

Expected: all PASS. If a command fails, record exact output and whether it is introduced by this branch; do not label the epic complete while an introduced failure remains.

- [ ] **Step 5: Run final proof searches and manual call-chain review**

```bash
rg -n "pendingShoppingToComplete|库存已登记.*采购项|待买项仍未标记" frontend/src
rg -n 'normalized_quantity = Decimal\("1"\)' backend/app
rg -n "changed_since_confirmation" backend/app frontend/src
rg -n "title\.includes\(ingredient\.name|ingredient\.name\.includes\(title" frontend/src backend/app
```

Expected: no obsolete double-mutation copy/state, no placeholder creation, no unsupported freshness state, and no bidirectional substring shopping-target fallback. Manually inspect remaining `not_track_quantity`, `createInventory`, `restockFoodStock`, and `updateShoppingItem` callers because absence of one regex is not full proof.

- [ ] **Step 6: Run final backend/frontend audits and request review**

Use `backend-code-audit`, `frontend-code-audit`, and `superpowers:requesting-code-review`. For any P0/P1 finding, return to the owning Task 1–18, apply its exact file/test/commit boundary, then restart Task 19's full gate; do not accumulate unknown product files in the final verification commit. Record the audit scope and resolution. For this cross-stack implementation, use the requested subagent review/fix/re-audit loop during execution; do not self-certify the final diff after local green only.

- [ ] **Step 7: Commit final verification artifacts**

```bash
git add backend/tests/inventory/test_inventory_mysql_concurrency.py frontend/scripts/smoke.mjs
git commit -m "test: verify inventory maintenance concurrency"
git status --short
```

Expected: no unintended unstaged feature files. Do not stage unrelated user files.

---

## Spec Coverage Matrix

| Approved requirement | Implemented by |
|---|---|
| Presence State unique truth, deterministic legacy backfill, and frontend projection cutover | Tasks 1, 3, 8, 10 |
| P0.1 State expiry/review/snooze integration | Task 4 |
| Integer row versions and global lock order | Tasks 1, 2 |
| Idempotency, snapshots, Ingredient guards | Task 5 |
| Explicit unbound free-text shopping create/edit/serialize contract | Task 6 |
| Exact/presence/Food/free-text atomic intake | Tasks 6–10 |
| Full/partial/over purchase and no double mutation | Tasks 7, 9, 10 |
| Scope-based exact/State/Food reconciliation including expired physical rows | Tasks 11–14 |
| Local 24-hour draft, replay, structured 409/422 recovery | Tasks 12–14 |
| Three-state confirmation freshness | Tasks 11, 18 |
| Operation list/detail and 15-minute whole-operation undo | Tasks 15–16 |
| Tracking-mode transition guard | Task 17 |
| Mobile/desktop UI and overlay accessibility | Tasks 9, 13, 14, 18 |
| MySQL concurrency, full tests, smoke, audit | Task 19 |
| Single-instance phase deployment and additive rollback | Tasks 10, 14, 19 plus Global Constraints |

## Completion Checklist

- [ ] P0.1 prerequisite is implemented and reused; there are no duplicate action models/dialogs/version fields.
- [ ] One Alembic head exists and migration/backfill succeeds on MySQL.
- [ ] State is the only current fact for presence ingredients; no new placeholder can be created.
- [ ] Historical presence rows cannot revive an absent State or affect overview/home/recipe/search/AI.
- [ ] All old writes participate in row versions and Ingredient collection guards.
- [ ] Shopping intake is one idempotent transaction for exact, presence, Food, and free text.
- [ ] Bound and unbound shopping create/edit/serialize contracts are explicit; free text never auto-binds by substring.
- [ ] Food intake keeps the earliest relevant expiry while ordinary manual restock retains overwrite semantics.
- [ ] Home, Ingredient, and Food shopping-source double mutations are gone.
- [ ] Reconciliation covers all three adapters, explicit scopes, expired physical rows, untouched-item semantics, and recoverable conflicts.
- [ ] Drafts are family/user/schema scoped, expire after 24 hours, and never auto-confirm new entities.
- [ ] Freshness exposes only `never_confirmed/current/stale`.
- [ ] Operation snapshots are whitelist-only and undo is safe, whole, permissioned, time-bounded, and version-bounded.
- [ ] Tracking-mode transitions never reuse fake quantity and cannot partially apply.
- [ ] Mobile/desktop/accessibility/safe-area/reduced-motion acceptance passes.
- [ ] Real MySQL concurrency tests, backend full suite, frontend tests/typecheck/build/style/smoke all pass.
- [ ] Final audits have no unresolved P0/P1 finding.
- [ ] No real household data or unrelated dirty worktree file was modified.
- [ ] Delivery notes list every command actually run and its result.
