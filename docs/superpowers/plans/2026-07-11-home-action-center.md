# Home Action Center and Reminder Fatigue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Keep the design spec open while executing and stop if a proposed code change would alter a confirmed product decision.

**Goal:** Replace the home dashboard's duplicated raw expiry/todo rows with a safe, ingredient-grouped `今天要处理` action center, persist expiry review/snooze decisions, and make the top-right background-task badge count only work that needs attention.

**Architecture:** Keep household actions as pure projections over existing inventory, ingredient, and shopping data; do not add a notification table. Add optimistic row versions and narrowly scoped expiry-action APIs on `InventoryItem`, centralize frontend grouping in `features/inventory`, and reuse the same model/dialog from home and the ingredient workspace. Keep desktop and mobile rendering independent while feeding both the same prepared union groups.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, Pydantic, MySQL, pytest, React 18, TypeScript, React Query, Vitest, Testing Library, Vite smoke checks.

**Approved design:** `docs/superpowers/specs/2026-07-11-home-action-center-design.md`

## Global Constraints

- Work on a project-native branch such as `feature/home-action-center`; do not use a `codex/` prefix.
- Treat `Asia/Shanghai` as this phase's fixed household business timezone. Do not add `Family.timezone` in this implementation.
- Do not create replacement copies of `useHomeDashboardState.ts` or `useHomeDashboardActions.ts`; modify the existing hooks.
- Do not introduce a household notification/read/unread table, push delivery, or cross-ingredient destructive action.
- Keep the original `expiry_date` when an expired batch is temporarily retained.
- A future alert snooze writes `expiry_alert_snoozed_until` only; it must not pretend an unexpired batch was reviewed as edible.
- Use integer `row_version`, not `updated_at`, as the stale-view token. Current MySQL `DATETIME` precision is insufficient for strict same-second conflict detection.
- Lock submitted inventory rows in stable ID order, compare every expected version, and fail the whole operation with `409 Conflict` before any write when one row is stale.
- Preserve the current family boundary on every inventory read/write and use the existing membership dependency, activity logger, serializers, transaction helper, query keys, cache invalidation, date helpers, notice system, and overlay primitives.
- Shopping deduplication uses `target_type === 'ingredient' && ingredient_id === ingredient.id` first. Only legacy rows without an ingredient ID may use normalized exact-name fallback; substring matching is forbidden.
- New low-stock actions use only `ingredient.default_low_stock_threshold` and positive non-expired available quantity. `InventoryItem.low_stock_threshold` is not an Action Center input.
- Home `需处理食材`, its visible first three rows, ingredient priority/action states, and the action count derive from one `InventoryActionGroup` projection. Remove the `buildInventoryAlerts -> inventoryAlertCount` home path.
- Home `在库食材` counts unique ingredients with positive non-expired inventory, not inventory rows.
- Compute one `businessDateKey` in the home composition layer and inject it into action groups, home meal/menu today-state, available-ingredient counts, and ingredient priority actions. Pure date-key differences use `Date.UTC` calendar arithmetic.
- Inventory mutation invalidation/refetch is awaitable. Do not calculate completion, conflicts, or `下一项` from stale React Query data.
- Existing shopping quick-restock resolution uses `ingredient_id`, then legacy normalized exact name, and never substring matching.
- Desktop and mobile must show the same first three eligible groups but retain separate JSX/layouts.
- The versioned disposal protocol is a single-repository atomic cutover; do not add dual request formats unless deployment requirements change.
- Final implementation verification must report the commands actually executed, including any failed command and whether it was pre-existing.

---

## Delivery Phases and Dependency Order

This epic has two independently testable delivery phases:

- **Phase A — household inventory Action Center:** Tasks 0–8C and the inventory portions of Task 10.
- **Phase B — background-task attention cleanup:** Task 9 and its portions of Task 10. It may be a separate PR/revert after Phase A.

Execute shared-file work sequentially in this order:

```text
0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7A -> 7B -> 7C -> 8A -> 8B -> 8C -> 9 -> 10
```

Tasks 2–4 are one atomic disposal/version cutover: Task 2 prepares the backend contract, Task 3 proves the global version behavior, and neither is committed/handed off until Task 4 updates the transport and every existing caller. Do not run Tasks 7/8 or any task touching `App.tsx`, home hooks, `workspaceModel.ts`, or ingredient workspace orchestration in parallel. Task 8 starts only after Tasks 5–7C pass their focused gates. Task 9 is logically independent but runs after Phase A because it also modifies `frontend/src/api/types.ts`.

Each audit/fix cycle is capped at three passes: initial audit plus at most two re-audits. Any unresolved P0/P1 blocker after that is reported with evidence instead of creating an unbounded loop.

---

## File Map

### Create

- `backend/alembic/versions/2e3f4a5b6c7d_add_inventory_expiry_actions.py`
- `backend/app/services/inventory_expiry_actions.py`
- `backend/tests/inventory/test_inventory_mysql_concurrency.py`
- `backend/tests/media/test_ai_image_job_api.py`
- `frontend/src/api/ingredientsApi.test.ts`
- `frontend/src/app/useAppHomeViewModel.test.ts`
- `frontend/src/app/useAppGlobalSearchNavigation.test.tsx`
- `frontend/src/features/inventory/inventoryActionModel.ts`
- `frontend/src/features/inventory/inventoryActionModel.test.ts`
- `frontend/src/features/inventory/InventoryActionDialog.tsx`
- `frontend/src/features/inventory/InventoryActionDialog.test.tsx`
- `frontend/src/features/home/useHomeDashboardState.test.tsx`
- `frontend/src/features/home/useHomeDashboardActions.test.ts`
- `frontend/src/features/home/HomeDashboard.test.tsx`
- `frontend/src/features/home/HomeMobileDashboard.test.tsx`
- `frontend/src/styles/10-inventory-actions.css`

### Modify: backend

- `backend/app/models/domain.py`
- `backend/app/schemas/inventory.py`
- `backend/app/services/serializers.py`
- `backend/app/services/inventory_operations.py`
- `backend/app/api/inventory.py`
- `backend/app/schemas/media.py`
- `backend/app/schemas/search.py`
- `backend/app/api/media.py`
- `backend/app/api/search.py`
- `backend/tests/inventory/test_inventory_api.py`
- `backend/tests/recipes/test_recipe_cooking.py`
- `backend/tests/ai_infra/test_inventory_operations.py`
- `backend/tests/search/test_search_index_jobs.py`

### Modify: frontend contracts and orchestration

- `frontend/src/api/types.ts`
- `frontend/src/api/ingredientsApi.ts`
- `frontend/src/app/useAppMutations.ts`
- `frontend/src/api/cacheInvalidation.ts`
- `frontend/src/api/cacheInvalidation.test.ts`
- `frontend/src/app/useAppHomeViewModel.ts`
- `frontend/src/app/useAppHomeHandlers.ts`
- `frontend/src/app/useAppGlobalSearchNavigation.ts`
- `frontend/src/App.tsx`

### Modify: home

- `frontend/src/features/home/homeDashboardModel.ts`
- `frontend/src/features/home/homeDashboardModel.test.ts`
- `frontend/src/features/home/useHomeDashboardState.ts`
- `frontend/src/features/home/useHomeDashboardActions.ts`
- `frontend/src/features/home/HomeDashboard.tsx`
- `frontend/src/features/home/HomeMobileDashboard.tsx`
- `frontend/src/features/home/HomeDashboardDialogs.tsx`
- `frontend/src/styles/01-home-dashboard.css`
- `frontend/src/styles/07-mobile.css`

### Modify: ingredient workspace

- `frontend/src/components/ingredients/workspaceModel.ts`
- `frontend/src/components/ingredients/workspaceModel.test.ts`
- `frontend/src/components/ingredients/useIngredientWorkspaceData.ts`
- `frontend/src/components/ingredients/useIngredientOverlayState.ts`
- `frontend/src/components/ingredients/useIngredientActionState.ts`
- `frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts`
- `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- `frontend/src/components/ingredients/IngredientHubPage.tsx`
- `frontend/src/components/ingredients/IngredientMobileView.tsx`
- `frontend/src/lib/date.ts`
- `frontend/src/lib/date.test.ts`

The existing `IngredientDestroyExpiredOverlay.tsx` and its focused tests may be deleted only after every caller has moved to `InventoryActionDialog` and `rg` proves it is unused. Do not delete it early.

### Modify: background tasks and styles

- `frontend/src/app/AppShell.tsx`
- `frontend/src/app/AppShell.test.tsx`
- `frontend/src/hooks/useAiImageJobMonitor.ts`
- `frontend/scripts/smoke.mjs`
- `frontend/src/styles.css`

---

## Task 0: Establish a Safe Baseline

**Files:** no product files should change in this task.

- [ ] **Step 1: Inspect and preserve the current worktree**

```bash
git status --short
git branch --show-current
```

Record every pre-existing modified/untracked path. Do not overwrite, delete, stage, or fold unrelated user changes into this feature.

- [ ] **Step 2: Create the feature branch only when branch state is safe**

```bash
git switch -c feature/home-action-center
```

If the branch already exists, inspect it instead of forcing recreation. If user changes overlap planned files, stop and agree on preservation before editing.

- [ ] **Step 3: Confirm repository paths and migration head**

```bash
test -f frontend/src/features/home/useHomeDashboardState.ts
test -f frontend/src/features/home/useHomeDashboardActions.ts
test -f frontend/scripts/smoke.mjs
cd backend && .venv/bin/alembic heads
```

Expected migration head at plan-writing time: `1d2e3f4a5b6c`. If it changed, choose a non-conflicting revision and update this plan's concrete migration commands.

- [ ] **Step 4: Capture baseline health before implementation**

```bash
npm --prefix frontend run typecheck
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py -q
```

Record any pre-existing failure verbatim. Do not change product code merely to hide a baseline failure outside this feature.

---

## Task 1: Add Inventory Row Versions and Expiry Review Persistence

**Files:**

- Create: `backend/alembic/versions/2e3f4a5b6c7d_add_inventory_expiry_actions.py`
- Modify: `backend/app/models/domain.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/schemas/inventory.py`
- Test: `backend/tests/inventory/test_inventory_api.py`

- [ ] **Step 1: Confirm the migration parent before writing anything**

Run:

```bash
cd backend && .venv/bin/alembic heads
```

Expected: `1d2e3f4a5b6c (head)`. If the head changed, choose a new revision ID and parent rather than creating a fork.

- [ ] **Step 2: Add a failing serialization/API contract test**

Extend the inventory fixture and list/create assertions so every returned inventory row contains:

```python
assert body[0]["row_version"] == 1
assert body[0]["expiry_alert_snoozed_until"] is None
assert body[0]["expiry_reviewed_at"] is None
assert body[0]["expiry_reviewed_by"] is None
```

Run:

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py -q
```

Expected: fail because the fields do not exist yet.

- [ ] **Step 3: Add the model fields and mapper version configuration**

In `InventoryItem`, add:

```python
row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
expiry_alert_snoozed_until: Mapped[date | None] = mapped_column(Date, nullable=True)
expiry_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
expiry_reviewed_by: Mapped[str | None] = mapped_column(
    String(64),
    ForeignKey("users.id", ondelete="SET NULL"),
    nullable=True,
)

__mapper_args__ = {"version_id_col": row_version}
```

Use the repository's actual SQLAlchemy annotation/import style and `utcnow()` for review timestamps. Do not manually increment `row_version` in normal ORM mutation code; SQLAlchemy owns it.

- [ ] **Step 4: Add the Alembic migration**

The upgrade must:

1. add `row_version` as non-null with server default `1`;
2. add the three nullable review/snooze columns;
3. add an explicitly named foreign key from `expiry_reviewed_by` to `users.id` with `ON DELETE SET NULL`.

The downgrade removes the foreign key before its column and then removes the remaining columns. Do not edit an existing migration.

- [ ] **Step 5: Extend the cross-end response schema and serializer**

Add the four fields to `InventoryItemOut` and return them from `serialize_inventory_item`. Serialize dates and datetimes using the current serializer conventions; do not leak ORM objects.

- [ ] **Step 6: Verify mapper behavior, schema, and migration structure**

Run:

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py -q
cd backend && .venv/bin/alembic upgrade head --sql > /tmp/culina-home-action-upgrade.sql
cd backend && .venv/bin/alembic downgrade 2e3f4a5b6c7d:1d2e3f4a5b6c --sql > /tmp/culina-home-action-downgrade.sql
```

Inspect both SQL files for column and foreign-key order. The offline SQL check does not replace the real MySQL migration in Task 10.

- [ ] **Step 7: Commit the persistence slice**

```bash
git add backend/alembic/versions/2e3f4a5b6c7d_add_inventory_expiry_actions.py backend/app/models/domain.py backend/app/schemas/inventory.py backend/app/services/serializers.py backend/tests/inventory/test_inventory_api.py
git commit -m "feat(inventory): persist expiry action reviews"
```

---

## Task 2: Implement Versioned, Atomic Expiry Actions

**Files:**

- Create: `backend/app/services/inventory_expiry_actions.py`
- Modify: `backend/app/schemas/inventory.py`
- Modify: `backend/app/services/inventory_operations.py`
- Modify: `backend/app/api/inventory.py`
- Test: `backend/tests/inventory/test_inventory_api.py`

- [ ] **Step 1: Write failing API tests for the complete safety matrix**

Add tests for:

- snoozing two expired batches writes one common snooze date and review timestamp/member;
- snoozing an unexpired batch writes the alert date but leaves review attribution null;
- mixed expired/upcoming rows are rejected atomically because one request expresses one action;
- `retain_expired` rejects every non-expired row and `snooze_upcoming` rejects every expired row;
- eight-days-away rows cannot be snoozed, seven-days-away rows can be snoozed, and a future-snoozed row cannot be snoozed again before its due date;
- a row becomes actionable again on its snooze date;
- reminder dates on/before today or more than 30 days after today are rejected;
- correction changes only one `expiry_date` and clears all previous review/snooze metadata;
- versioned expired disposal succeeds for selected expired rows;
- stale review, correction, and disposal each return `409` and do not partially write;
- mixed ingredient, missing row, other-family row, exhausted row, missing expiry date, non-expired disposal, duplicate item ID, and reminder date on/before today are rejected;
- a request with one valid and one invalid/stale row leaves both unchanged;
- expiry review writes one ingredient-level activity record with the acting user and future reminder date.

Use the fixed backend business date helper in assertions rather than the machine-local date.

Run:

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py -q
```

Expected: fail because the endpoints and versioned payload do not exist.

- [ ] **Step 2: Define versioned request schemas**

Use one shared item reference:

```python
class VersionedInventoryItemRef(BaseModel):
    inventory_item_id: str
    expected_row_version: int = Field(ge=1)

class DisposeExpiredInventoryRequest(BaseModel):
    ingredient_id: str
    items: list[VersionedInventoryItemRef] = Field(min_length=1)

class SnoozeExpiryAlertsRequest(BaseModel):
    action: Literal["retain_expired", "snooze_upcoming"]
    ingredient_id: str
    items: list[VersionedInventoryItemRef] = Field(min_length=1)
    snoozed_until: date_type

class CorrectInventoryExpiryDateRequest(BaseModel):
    expiry_date: date_type
    expected_row_version: int = Field(ge=1)
```

Add `SnoozeExpiryAlertsResponse` with `ingredient_id`, `snoozed_item_ids`, `snoozed_count`, `reviewed_expired_count`, and `snoozed_until`. Reject duplicate IDs explicitly instead of silently deduplicating versioned references.

The exact API paths are fixed:

```text
POST  /api/inventory/snooze-expiry-alerts
PATCH /api/inventory/{inventory_item_id}/expiry-date
POST  /api/inventory/dispose-expired
```

Date correction returns `InventoryItemOut`; disposal keeps `DisposeExpiredInventoryResponse`.

- [ ] **Step 3: Implement one stable lock-and-validate helper**

In `inventory_expiry_actions.py`, introduce a domain exception for stale rows and a helper that:

1. checks unique submitted IDs;
2. sorts IDs before querying;
3. selects only the authenticated `family_id` using `.with_for_update()`;
4. restores submitted order only for response/presentation purposes;
5. verifies every requested row was found;
6. verifies each row belongs to the submitted ingredient, has remaining quantity and expiry data;
7. compares every `row_version` before mutating anything.

The snooze/review service then applies action-specific eligibility after the common lock/validation and before any mutation: expiry no later than seven days from today, current snooze absent or due, and every row matching `retain_expired` or `snooze_upcoming`. Do not apply the snooze-visibility predicate to disposal; an already-snoozed expired batch may still be deliberately disposed from its inventory detail.

Keep HTTP status decisions in the API route. The service raises a distinct stale exception so the route can map it to `409`; business validation maps to the existing `400` style.

- [ ] **Step 4: Implement snooze/review semantics**

Use `today_for_family()` from the route and one `utcnow()` timestamp for the request. Validate `today < snoozed_until <= today + 30 days`. For each selected row:

- `retain_expired` sets `expiry_alert_snoozed_until`, `expiry_reviewed_at`, and `expiry_reviewed_by`;
- `snooze_upcoming` sets only `expiry_alert_snoozed_until` and must leave review attribution unchanged/null;
- both actions set `updated_by` and use the existing audit timestamp convention;
- leave the original expiry date and quantities unchanged.

Write one ingredient-level activity entry after all rows validate. Flush before building the response so row versions are incremented, but commit only through `commit_session` at the route boundary.

- [ ] **Step 5: Implement narrow expiry-date correction**

Lock one family-owned row, compare `expected_row_version`, update `expiry_date`, clear all three review/snooze fields, maintain audit fields, and log the old/new date. Return the refreshed `InventoryItemOut`.

- [ ] **Step 6: Harden existing expired disposal**

Change `/api/inventory/dispose-expired` from raw IDs to versioned refs. Lock and validate all rows before calling `dispose_inventory_quantity` for any row. Preserve same-ingredient and expired-only rules, but do not reject disposal merely because an alert is snoozed. Map stale state to `409` and never drop invalid rows to process a partial subset.

If per-batch disposal activity makes this user action excessively noisy, add a backwards-compatible `record_activity: bool = True` argument to `dispose_inventory_quantity`; call it with `False` for the batch route and write one ingredient-level disposal activity. Keep all other callers unchanged.

- [ ] **Step 7: Translate ORM stale writes at transaction boundaries**

Catch SQLAlchemy `StaleDataError` around the commit/flush of these inventory routes and translate it to the same `409` detail used for pre-write row-version mismatches. Roll back before raising the HTTP error. Do not broadly convert unrelated database failures into conflicts.

- [ ] **Step 8: Run focused backend tests**

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py -q
```

Expected: all inventory action tests pass.

- [ ] **Step 9: Hold the backend cutover for the atomic frontend slice**

Do not commit, hand off, deploy, or manually validate the application with the old frontend at this point. The backend focused tests may be green, but the changed disposal request is not an independently shippable checkpoint. Proceed through Task 3's backend mutation matrix and then directly to Task 4; Task 4 commits all Tasks 2–3 backend files together with every existing in-repository caller.

---

## Task 3: Prove Row Versions and Snooze Safety Across Existing Inventory Paths

**Files:**

- Modify: `backend/tests/inventory/test_inventory_api.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`
- Modify: `backend/tests/ai_infra/test_inventory_operations.py`
- Create: `backend/tests/inventory/test_inventory_mysql_concurrency.py`
- Modify: `backend/app/api/inventory.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/services/ai_operations/recipe_cook.py`
- Modify: `backend/app/services/ai_operations/inventory.py`

- [ ] **Step 1: Add regression assertions to existing mutation tests**

For an inventory row starting at version 1, verify version increases after:

- direct consume;
- direct dispose;
- recipe cooking deduction;
- an AI inventory write path that mutates a batch.

The assertions should reload the row in a fresh session/expired identity-map state. Do not add manual version increments merely to satisfy tests.

Before editing, produce and keep this mutation map in the task notes using `rg` over every `InventoryItem` mutation:

| Path | Required boundary |
| --- | --- |
| direct consume/dispose | HTTP conflict mapping |
| ordinary recipe cook | lock/version-safe inventory mutation plus HTTP conflict mapping |
| AI recipe cook | `StaleDataError -> AIConflictError` |
| AI inventory consume/dispose | `StaleDataError -> AIConflictError` |
| review/snooze/correct/versioned disposal | stable locks, expected version, HTTP conflict mapping |

Do not treat a generic `commit_session()` catch as sufficient unless each owning product boundary returns its documented conflict type.

- [ ] **Step 2: Prove snooze never restores expired inventory availability**

Add regression tests showing an expired row with a future `expiry_alert_snoozed_until`:

- is still rejected/excluded by normal consumption;
- is still excluded from recipe readiness and cook deduction;
- remains `expired` in AI inventory reads;
- is excluded from available quantity used by low-stock calculations.

Snooze is reminder-layer metadata only. Do not add it to `inventory_usage.py` availability predicates.

- [ ] **Step 3: Run the focused mutation suites**

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py tests/recipes -q
cd backend && .venv/bin/pytest tests/ai_infra/test_inventory_operations.py -q
```

Expected: every ORM update increments `row_version`; inserts begin at 1.

- [ ] **Step 4: Add a real MySQL two-session concurrency test**

In `backend/tests/inventory/test_inventory_mysql_concurrency.py`, require a dedicated `CULINA_TEST_MYSQL_URL` whose database name ends in `_test`; skip when absent and fail fast when it points at a non-test database. Against that disposable MySQL database, use two independent SQLAlchemy sessions:

1. session A loads version `N` as the dialog token;
2. session B performs an ordinary recipe cook or disposal and commits version `N + 1`;
3. session A submits the stale versioned action;
4. assert the owning HTTP boundary returns `409` (or the AI boundary raises `AIConflictError`), no partial write occurs, and the persisted row remains at B's state.

SQLite coverage remains useful for version increments but is not accepted as proof of `FOR UPDATE` behavior.

Run after exporting the secret-safe disposable test URL in the local shell:

```bash
cd backend && .venv/bin/pytest tests/inventory/test_inventory_mysql_concurrency.py -q
```

Expected: pass without printing the connection URL or credentials.

- [ ] **Step 5: Hold regression changes for the atomic cutover**

Do not commit or hand off these backend mutation-boundary changes separately. Proceed directly to Task 4, which adds the frontend protocol/caller changes, reruns both backend and frontend focused gates, and commits the full Tasks 2–4 vertical slice.

---

## Task 4: Atomically Cut Over the Disposal Contract and Frontend Mutations

**Files:**

- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/ingredientsApi.ts`
- Modify: `frontend/src/app/useAppMutations.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/components/ingredients/useIngredientActionState.ts`
- Modify: `frontend/src/components/ingredients/workspaceModel.ts`
- Create: `frontend/src/api/ingredientsApi.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Create: `frontend/src/features/home/useHomeDashboardActions.test.ts`
- Modify: `frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx`
- Modify: `frontend/src/components/ingredients/IngredientDestroyExpiredOverlayUsage.test.ts`
- Includes uncommitted backend files from Tasks 2–3

- [ ] **Step 1: Add failing API transport tests**

Mock `fetch` through the existing request layer and first assert the exact path, method, and JSON body for disposal, snooze, and date correction. Also assert a 409 response remains an `ApiError` with `status === 409`. Add focused tests proving the existing home and ingredient disposal paths construct `items` with each batch's actual `row_version`; no caller may synthesize version `1` or keep sending `inventory_item_ids`.

Change the expected disposal payload to versioned refs and add typed fixtures for snooze and correction. The intended TypeScript contract is:

```ts
export type VersionedInventoryItemRef = {
  inventory_item_id: string;
  expected_row_version: number;
};

export type DisposeExpiredInventoryRequest = {
  ingredient_id: string;
  items: VersionedInventoryItemRef[];
};
```

Extend `InventoryItem` with `row_version`, `expiry_alert_snoozed_until`, `expiry_reviewed_at`, and `expiry_reviewed_by`.

- [ ] **Step 2: Implement API methods**

Add:

```ts
snoozeInventoryExpiryAlerts(payload)
correctInventoryExpiryDate(inventoryItemId, payload)
```

and update `disposeExpiredInventory` to send `items`. Reuse the existing request client so `ApiError.status === 409` remains available to UI code.

- [ ] **Step 3: Add React Query mutations**

Expose all three actions through `useAppMutations.ts`. On success call the existing `invalidateAfterInventoryChanged(queryClient)` path; do not create new query keys for derived action groups.

Make the invalidation boundary awaitable:

```ts
function invalidateMany(queryClient: QueryClient, keys: QueryKey[]) {
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export async function invalidateAfterInventoryChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.inventory,
    queryKeys.inventoryOverviewRoot,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}
```

Adjust the other invalidation exports consistently so callers do not silently discard promises, and update `cacheInvalidation.test.ts` to prove completion waits for every key.

- [ ] **Step 4: Adapt every current disposal caller before typecheck**

Before the new shared dialog exists, update the current home and ingredient disposal paths as a compatibility adapter:

- carry `row_version` through the existing disposable-batch view model;
- submit `{inventory_item_id, expected_row_version}` for every selected row;
- keep current UI behavior unchanged until Tasks 7/8 replace it;
- use actual inventory IDs/bindings and preserve existing Notice error handling.

Run:

```bash
rg -n "inventory_item_ids|disposeExpiredInventory\(" frontend/src
```

Expected: no call to `/dispose-expired` uses the old payload. References in unrelated historical types/tests must be migrated or explained before continuing.

- [ ] **Step 5: Verify the atomic cutover**

```bash
npm --prefix frontend run test -- ingredientsApi cacheInvalidation useHomeDashboardActions DestroyExpiredInventoryDialog IngredientDestroyExpiredOverlayUsage
npm --prefix frontend run typecheck
cd backend && .venv/bin/pytest tests/inventory/test_inventory_api.py tests/recipes/test_recipe_cooking.py tests/ai_infra/test_inventory_operations.py -q
cd backend && .venv/bin/pytest tests/inventory/test_inventory_mysql_concurrency.py -q
```

If Vitest path filtering differs in this repository, run the discovered focused test file directly. The MySQL test requires the already exported disposable `CULINA_TEST_MYSQL_URL` and must not skip at this checkpoint. This is the first valid full-repository checkpoint after Task 2; backend mutation boundaries and every existing frontend disposal caller must agree on the versioned behavior.

- [ ] **Step 6: Commit the complete vertical slice**

```bash
git add backend/app/services/inventory_expiry_actions.py backend/app/schemas/inventory.py backend/app/services/inventory_operations.py backend/app/api/inventory.py backend/app/api/recipes.py backend/app/services/ai_operations/recipe_cook.py backend/app/services/ai_operations/inventory.py backend/tests/inventory/test_inventory_api.py backend/tests/inventory/test_inventory_mysql_concurrency.py backend/tests/recipes/test_recipe_cooking.py backend/tests/ai_infra/test_inventory_operations.py frontend/src/api/types.ts frontend/src/api/ingredientsApi.ts frontend/src/api/ingredientsApi.test.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts frontend/src/app/useAppMutations.ts frontend/src/features/home/useHomeDashboardActions.ts frontend/src/features/home/useHomeDashboardActions.test.ts frontend/src/components/ingredients/useIngredientActionState.ts frontend/src/components/ingredients/workspaceModel.ts frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx frontend/src/components/ingredients/IngredientDestroyExpiredOverlayUsage.test.ts
git commit -m "feat(inventory): cut over versioned expiry actions"
```

---

## Task 5: Build the Shared Inventory Action Model and Business-Date Projection

**Files:**

- Create: `frontend/src/features/inventory/inventoryActionModel.ts`
- Create: `frontend/src/features/inventory/inventoryActionModel.test.ts`
- Modify: `frontend/src/lib/date.ts` if no existing timezone-date helper can produce a `YYYY-MM-DD` key
- Modify: `frontend/src/lib/date.test.ts`
- Modify: `frontend/src/components/ingredients/workspaceModel.ts`
- Modify: `frontend/src/components/ingredients/workspaceModel.test.ts`
- Modify: `frontend/src/components/ingredients/useIngredientWorkspaceData.ts`
- Modify: `frontend/src/features/home/homeDashboardModel.ts`
- Modify: `frontend/src/features/home/homeDashboardModel.test.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Create: `frontend/src/app/useAppHomeViewModel.test.ts`

- [ ] **Step 1: Write model tests before implementation**

Cover at least:

- multiple batches of one ingredient become one expiry group;
- expired/today/1–3 day/4–7 day counts are correct inside a mixed group;
- snoozed rows are excluded before the snooze date and return on that date;
- consumed/disposed/exhausted/no-expiry/outside-seven-day rows are excluded;
- low stock is emitted only for quantity-tracked ingredients at/below threshold;
- low stock reads `ingredient.default_low_stock_threshold`, ignores `InventoryItem.low_stock_threshold`, and sums only positive non-expired available quantity;
- pending shopping dedupe prefers ingredient ID and rejects substring collisions such as `牛奶` versus `牛奶麦片`;
- legacy rows without an ingredient ID use normalized exact-name fallback only;
- expiry wins when the same ingredient is both expiring and low stock;
- deterministic ordering follows expired, today, soon, low stock, later, date, name, ID;
- home eligibility excludes `expires_later` and selects at most three groups;
- the same ingredient is counted once;
- exact boundary mapping is `<0 expired`, `0 today`, `1..3 soon`, `4..7 later`, and `>7 excluded`;
- UTC calendar-key arithmetic stays correct across a daylight-saving transition;
- quantity copy combines identical units but leaves unlike units separate;
- Chinese title/detail output matches the gold examples in the approved design.

Pass `referenceDate: '2026-07-11'` explicitly in every test. Include a test that would fail if the model called device-local `todayKey()` internally.

- [ ] **Step 2: Implement the discriminated union and pure builder**

Export generic shared types named `InventoryActionGroup`, `ExpiryInventoryActionGroup`, and `LowStockInventoryActionGroup` plus:

```ts
buildInventoryActionGroups({
  inventoryItems,
  ingredients,
  shoppingItems,
  referenceDate,
}): InventoryActionGroup[]

selectHomeEligibleInventoryActionGroups(groups): InventoryActionGroup[]
selectHomeInventoryActionGroups(groups, limit = 3): InventoryActionGroup[]
```

The unlimited selector is the count source; the limited selector returns its first `limit` rows for rendering. Build presentation-ready Chinese title/detail strings in the model so desktop and mobile cannot drift in semantics. Group quantities only by exact unit; never convert unlike units. Keep UI event handlers and React state out of this file.

- [ ] **Step 3: Add a tested Shanghai business-date provider**

If `frontend/src/lib/date.ts` lacks a timezone-key helper, add one using `Intl.DateTimeFormat` with `timeZone: 'Asia/Shanghai'` and stable `YYYY-MM-DD` parts. Add a pure calendar-day helper that parses `YYYY-MM-DD` and compares `Date.UTC(year, month - 1, day)` values; do not subtract device-local midnights. The app/view-model computes the key and passes it into the pure model.

Do not replace the repository-wide `todayKey()` in this phase. The home/action consistency boundary gets the injected `businessDateKey`; unrelated workspaces remain out of scope.

- [ ] **Step 4: Make home model consume prepared groups**

Remove raw expiry/todo pagination from `homeDashboardModel.ts`:

- remove `DASHBOARD_TODO_PAGE_SIZE` and raw `DashboardTodoItem` construction;
- remove shopping and completed-meal rows from `今天要处理`;
- accept prepared action groups; derive one unlimited home-eligible list, expose its first three rows and its unique count, and separately expose whether four-to-seven-day/full-list groups exist;
- remove the `buildInventoryAlerts -> inventoryAlertCount` home-stat path completely;
- compute `在库食材` as unique ingredient IDs with positive non-expired available inventory, not raw batch count;
- retain unrelated recommendation, plan, procurement, meal, and activity data.

Update the old test that expected `['expiry', 'expiry', 'shopping', 'meal']` to assert the new grouped contract. Add a regression where six home-eligible groups render three but the stat reads `6 种`, while a four-to-seven-day-only group affects only the full-list hint.

- [ ] **Step 5: Make ingredient workspace reuse the shared rules**

Refactor `workspaceModel.ts` and `useIngredientWorkspaceData.ts` so priority summaries, action counts, the `需处理` filter, and actionable card state derive from `buildInventoryActionGroups` or a lower-level exported predicate from that module. Do not keep a second two-day expiry window, snooze rule, or low-stock threshold implementation.

Ingredient catalog/inventory presentation that is unrelated to action priority may remain in `workspaceModel.ts`.

- [ ] **Step 6: Use one business date across the home consistency boundary**

In `useAppHomeViewModel.ts`, calculate `businessDateKey` once and inject it into:

- `buildInventoryActionGroups` and the unique available-ingredient count;
- today's meal selection;
- menu-plan/today status rendered on home;
- ingredient priority/action preparation passed from the home/app composition.

Delete the home import/use of `buildInventoryAlerts`. Do not call device-local `todayKey()` for these fields. Add `useAppHomeViewModel.test.ts` with a mocked instant that is a different calendar day in the device zone and `Asia/Shanghai`.

- [ ] **Step 7: Harden existing procurement ingredient resolution**

Change `findShoppingIngredient()` and the quick-restock payload builder to resolve:

1. exact `shoppingItem.ingredient_id`;
2. normalized exact name only when the legacy row has no ID;
3. no match when only a substring matches.

Add regressions for `牛奶`/`牛奶麦片` and `油`/`酱油`, including a bound row whose title has been edited but whose `ingredient_id` remains correct.

- [ ] **Step 8: Run focused model tests**

```bash
npm --prefix frontend run test -- inventoryActionModel.test.ts homeDashboardModel.test.ts workspaceModel.test.ts useAppHomeViewModel date.test.ts
```

Expected: all focused model/view-model tests pass without relying on the machine timezone.

- [ ] **Step 9: Commit the model slice**

```bash
git add frontend/src/features/inventory/inventoryActionModel.ts frontend/src/features/inventory/inventoryActionModel.test.ts frontend/src/lib/date.ts frontend/src/lib/date.test.ts frontend/src/features/home/homeDashboardModel.ts frontend/src/features/home/homeDashboardModel.test.ts frontend/src/app/useAppHomeViewModel.ts frontend/src/app/useAppHomeViewModel.test.ts frontend/src/components/ingredients/workspaceModel.ts frontend/src/components/ingredients/workspaceModel.test.ts frontend/src/components/ingredients/useIngredientWorkspaceData.ts
git commit -m "feat(frontend): group household inventory actions"
```

---

## Task 6: Build the Reusable One-Ingredient Action Dialog

**Files:**

- Create: `frontend/src/features/inventory/InventoryActionDialog.tsx`
- Create: `frontend/src/features/inventory/InventoryActionDialog.test.tsx`
- Create: `frontend/src/styles/10-inventory-actions.css`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Write interaction tests first**

Render mixed expired and upcoming batches and verify:

- rows are separated into `已过期批次` and `即将到期批次`;
- expired rows are initially selected when any exist;
- an all-upcoming group initially selects upcoming rows;
- switching between disposal, temporary retention, and future snooze resets selection to rows valid for that action;
- disposal cannot select unexpired rows;
- temporary retention cannot select unexpired rows;
- future snooze cannot select expired rows;
- date correction edits exactly one row and submits its row version;
- disposal confirmation includes ingredient, batch count, and quantity by unit;
- reminder presets are tomorrow, three days later, and custom date;
- custom date enforces `referenceDate < value <= referenceDate + 30 calendar days` in the control before submission;
- identical quantity units are summed while unlike units remain separate;
- original expiry dates remain visible during temporary retention;
- prior review state shows neutral member copy plus time and never renders raw `expiry_reviewed_by` IDs;
- `ApiError` 409 leaves the dialog open and presents the conflict/review-again state;
- busy actions disable close/duplicate submission without trapping keyboard focus.

- [ ] **Step 2: Define a narrow component contract**

The dialog receives one `ExpiryInventoryActionGroup`, explicit `referenceDate`, busy/error state, and callbacks carrying versioned item refs. It must not import home or ingredient workspace state.

Recommended callback shapes:

```ts
onDispose(items: VersionedInventoryItemRef[]): Promise<void>;
onSnooze(args: {
  action: 'retain_expired' | 'snooze_upcoming';
  items: VersionedInventoryItemRef[];
  snoozedUntil: string;
}): Promise<void>;
onCorrectExpiry(args: {
  inventoryItemId: string;
  expectedRowVersion: number;
  expiryDate: string;
}): Promise<void>;
```

- [ ] **Step 3: Implement explicit action state**

Use a state machine/discriminated state rather than several unrelated booleans:

```ts
type DialogMode =
  | { kind: 'review' }
  | { kind: 'dispose_confirm' }
  | { kind: 'snooze'; audience: 'expired' | 'upcoming' }
  | { kind: 'correct_date'; inventoryItemId: string };
```

Keep the second destructive confirmation inside the same shared overlay flow. Never auto-open the next ingredient.

Build tomorrow, three-days-later, custom `min`, and custom `max` with the same UTC-safe date-key helpers used by the pure model. Do not use `new Date('YYYY-MM-DD')` plus device-local setters.

- [ ] **Step 4: Implement responsive Culina styling**

Use existing UI-kit overlay primitives and semantic style tokens. Add `10-inventory-actions.css` to `styles.css` before the final mobile override layer. Requirements:

- warm surface and photo-friendly hierarchy rather than admin-table density;
- explicit text/icon status in addition to color;
- 44px minimum primary controls;
- safe-area padding and scrollable content on 375px mobile;
- no hard-coded raw colors when a current token exists;
- danger styling only on confirmed disposal.

- [ ] **Step 5: Run dialog and style checks**

```bash
npm --prefix frontend run test -- InventoryActionDialog.test.tsx
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
```

- [ ] **Step 6: Commit the shared dialog**

```bash
git add frontend/src/features/inventory/InventoryActionDialog.tsx frontend/src/features/inventory/InventoryActionDialog.test.tsx frontend/src/styles/10-inventory-actions.css frontend/src/styles.css
git commit -m "feat(frontend): add inventory action dialog"
```

---

## Task 7A: Rebuild Home Data, State, and Navigation Contracts

**Files:**

- Modify: `frontend/src/features/home/useHomeDashboardState.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Modify: `frontend/src/app/useAppHomeHandlers.ts`
- Modify: `frontend/src/app/useAppGlobalSearchNavigation.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/features/home/homeDashboardModel.test.ts`
- Create: `frontend/src/features/home/useHomeDashboardState.test.tsx`
- Create: `frontend/src/app/useAppGlobalSearchNavigation.test.tsx`

- [ ] **Step 1: Add failing home orchestration tests**

Cover:

- prepared home data contains at most three unique ingredient groups;
- home action count uses the complete home-eligible projection while rendering only its first three rows;
- after refreshed groups arrive, state offers but does not auto-open the next group;
- the next-item suggestion excludes `completedIngredientId` even when that ingredient reappears as low stock;
- low-stock primary action produces a valid ingredient shopping navigation request;
- `查看全部` produces a valid priority navigation request.

- [ ] **Step 2: Replace obsolete home state in the existing hook**

Remove:

- `visibleExpiryCount` and its reset function;
- `visibleDashboardTodoCount`;
- `homeExpiredDisposalIngredientId`;
- `homeExpiryReviewItemId`.

Add selected action-group ID, completion summary, `completedIngredientId`, and an optional next-group ID. Feed the hook the current ordered eligible groups so an effect can choose the next item only after query invalidation produces refreshed groups, always excluding the completed ingredient.

Do not disturb menu-plan, procurement restock, or meal-detail state.

- [ ] **Step 3: Expose the single prepared projection through app orchestration**

Reuse the projection already built in `useAppHomeViewModel.ts` by Task 5; do not rebuild it in `App.tsx`, handlers, or a component. Pass the unlimited home-eligible count, prepared top-three groups, later/full-list hint, and unique available-ingredient count through `App.tsx`; delete the remaining `buildInventoryAlerts`, `inventoryAlertCount`, raw expiry/todo visibility plumbing, and scroll handlers.

- [ ] **Step 4: Replace optional navigation fields with a discriminated union**

Use:

```ts
export type IngredientNavigationRequest =
  | { target: 'catalog'; requestId: number }
  | { target: 'detail'; ingredientId: string; requestId: number }
  | { target: 'shopping'; ingredientId: string; requestId: number }
  | { target: 'priority'; requestId: number };
```

Use `shopping` for a low-stock row and `priority` for `查看全部`. The ingredient workspace consumes the request once by `requestId`, opens its existing shopping overlay or priority surface, and does not duplicate shopping form state in home.

The destination contract is fixed:

| Target | Desktop | Mobile |
| --- | --- | --- |
| `priority` | activate the ingredient hub/catalog shared `需处理` filter and focus the complete priority list | scroll/focus the existing `今天先处理` section |
| `shopping` | resolve the supplied real ingredient ID and call the existing `openShoppingOverlay(ingredientId)` | same overlay behavior |

Add tests that invalid target/ingredient combinations are unrepresentable, each `requestId` is consumed once, and no priority navigation uses a synthetic search string.

- [ ] **Step 5: Verify and commit the data/state slice**

```bash
npm --prefix frontend run test -- homeDashboardModel.test.ts useHomeDashboardState useAppGlobalSearchNavigation
npm --prefix frontend run typecheck
git add frontend/src/features/home/homeDashboardModel.ts frontend/src/features/home/homeDashboardModel.test.ts frontend/src/features/home/useHomeDashboardState.ts frontend/src/features/home/useHomeDashboardState.test.tsx frontend/src/app/useAppHomeViewModel.ts frontend/src/app/useAppHomeHandlers.ts frontend/src/app/useAppGlobalSearchNavigation.ts frontend/src/app/useAppGlobalSearchNavigation.test.tsx frontend/src/App.tsx
git commit -m "refactor(home): prepare grouped inventory actions"
```

---

## Task 7B: Replace Desktop and Mobile Home Views

**Files:**

- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/home/HomeMobileDashboard.tsx`
- Modify: `frontend/src/styles/01-home-dashboard.css`
- Modify: `frontend/src/styles/07-mobile.css`
- Modify: `frontend/scripts/smoke.mjs`
- Create: `frontend/src/features/home/HomeDashboard.test.tsx`
- Create: `frontend/src/features/home/HomeMobileDashboard.test.tsx`

- [ ] **Step 1: Add failing desktop/mobile view tests**

Verify both views receive prepared groups, render at most three, render one ingredient only once, exclude shopping/completed meals, and show the approved empty states.

- [ ] **Step 2: Replace desktop UI**

In `HomeDashboard.tsx`:

- remove the standalone `临期优先处理` panel;
- replace mixed `今日待办` rendering with `今天要处理`;
- render at most three ingredient groups, one strong primary action per row, and the approved empty state;
- preserve procurement reminder, meal plan, recommendations, and recent activity;
- remove infinite-scroll sentinels/handlers tied to the old lists.

- [ ] **Step 3: Replace mobile UI independently**

In `HomeMobileDashboard.tsx`, replace the first four raw todos with the same first three prepared groups. Keep mobile card composition, safe areas, bottom navigation clearance, and touch target sizes independent from desktop JSX.

- [ ] **Step 4: Update smoke fixtures and structural assertions now, not at final cleanup**

In `frontend/scripts/smoke.mjs`:

- add `row_version`, `expiry_alert_snoozed_until`, `expiry_reviewed_at`, and `expiry_reviewed_by` to every inventory fixture;
- create at least two actionable batches for the same ingredient plus another action group;
- replace `.dashboard-expiry-*` and old todo-order assertions with one `今天要处理` assertion;
- assert the repeated ingredient renders as one group;
- navigate to/open the new inventory action dialog;
- exercise 375, 390, and 430px widths and assert no horizontal overflow.

- [ ] **Step 5: Verify and commit the view slice**

```bash
npm --prefix frontend run test -- HomeDashboard HomeMobileDashboard
npm --prefix frontend run typecheck
npm --prefix frontend run check:style-tokens
git add frontend/src/features/home/HomeDashboard.tsx frontend/src/features/home/HomeDashboard.test.tsx frontend/src/features/home/HomeMobileDashboard.tsx frontend/src/features/home/HomeMobileDashboard.test.tsx frontend/src/styles/01-home-dashboard.css frontend/src/styles/07-mobile.css frontend/scripts/smoke.mjs
git commit -m "feat(home): render grouped household actions"
```

---

## Task 7C: Wire Home Dialog Actions, Conflict Recovery, and Continuation

**Files:**

- Modify: `frontend/src/features/home/useHomeDashboardActions.ts`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/features/home/useHomeDashboardState.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/home/useHomeDashboardActions.test.ts`

- [ ] **Step 1: Add failing action-flow tests**

Cover opening the selected group, action-specific payloads, awaited success refresh, 409 refresh/review-again behavior when the group survives, 409 close/already-handled behavior when the group disappears, preserved network-error inputs, and the same-ingredient low-stock secondary action.

- [ ] **Step 2: Extend the existing home actions hook**

Replace the raw all-expired submit function with callbacks for versioned disposal, explicit-action snooze/review, and correction. Centralize conflict handling:

```ts
if (isApiError(reason) && reason.status === 409) {
  await refreshInventoryActions();
  // Re-read the selected ingredient from refreshed canonical groups.
  // Surviving group: replace rows, clear selection/confirmation, require review.
  // Missing group: close and show `这批库存已由家人处理`.
  return;
}
```

`refreshInventoryActions()` must await the canonical inventory refetch, not only fire `invalidateQueries`. Network/business errors preserve the current dialog inputs. Success shows `已处理{ingredientName}` and exposes `下一项：{differentIngredientName}` only after refreshed groups are known. If the completed ingredient is now low stock, expose `加入采购` separately.

- [ ] **Step 3: Replace home expiry dialogs**

Render `InventoryActionDialog` from `HomeDashboardDialogs.tsx` for the selected expiry group. Remove the old home-specific raw batch review and destroy-dialog props after all callers are updated.

- [ ] **Step 4: Verify focused home behavior**

```bash
npm --prefix frontend run test -- homeDashboardModel.test.ts HomeDashboard useHomeDashboard
npm --prefix frontend run typecheck
npm --prefix frontend run check:style-tokens
```

Also run `rg` to ensure the old home fields and raw todo types no longer cross `App.tsx`:

```bash
rg -n "visibleExpiryCount|visibleDashboardTodoCount|homeExpiredDisposalIngredientId|homeExpiryReviewItemId|DashboardTodoItem" frontend/src
```

Expected: no home-dashboard usage remains; any unrelated type must be reviewed explicitly.

- [ ] **Step 5: Commit the home dialog/action slice**

```bash
git add frontend/src/features/home/useHomeDashboardState.ts frontend/src/features/home/useHomeDashboardActions.ts frontend/src/features/home/useHomeDashboardActions.test.ts frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/App.tsx
git commit -m "feat(home): wire inventory action workflow"
```

---

## Task 8A: Move Ingredient Priority Surfaces to the Shared Model

**Files:**

- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/components/ingredients/IngredientHubPage.tsx`
- Modify: `frontend/src/components/ingredients/IngredientMobileView.tsx`
- Modify: `frontend/src/components/ingredients/workspaceModel.ts`
- Modify: existing priority/model tests

- [ ] **Step 1: Add failing ingredient workspace tests**

Verify:

- `今天先处理` uses the same severity/window/snooze logic as home;
- an ingredient appears once even with several batches;
- four-to-seven-day groups remain available in the full priority surface;
- low stock opens the existing shopping overlay with a stable ingredient binding;
- full priority rows consume `InventoryActionGroup`, not `Home*` types.
- the `需处理` filter and actionable card state use the same seven-day/snooze projection and do not keep the old two-day `buildIngredientAlerts` rule;
- a neutral/decorative date badge never overrides an actionable shared-group state.

- [ ] **Step 2: Replace priority presentation data**

Update desktop and mobile priority surfaces to consume shared generic groups. Drive priority counts, the `需处理` filter, and actionable card state from the same projection. Keep unrelated ingredient catalog presentation separate. Ensure four-to-seven-day groups remain visible only in the full priority surface, and remove the remaining two-day action predicate rather than preserving dual semantics.

- [ ] **Step 3: Verify and commit the priority slice**

```bash
npm --prefix frontend run test -- workspaceModel.test.ts IngredientHubPage IngredientMobileView
npm --prefix frontend run typecheck
git add frontend/src/components/ingredients/workspaceModel.ts frontend/src/components/ingredients/workspaceModel.test.ts frontend/src/components/ingredients/IngredientWorkspace.tsx frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/components/ingredients/IngredientHubPage.tsx frontend/src/components/ingredients/IngredientMobileView.tsx
git commit -m "refactor(ingredients): share inventory action groups"
```

---

## Task 8B: Migrate Ingredient Expiry Actions to the Shared Dialog

**Files:**

- Modify: `frontend/src/components/ingredients/useIngredientOverlayState.ts`
- Modify: `frontend/src/components/ingredients/useIngredientActionState.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: existing ingredient overlay tests

- [ ] **Step 1: Add failing shared-dialog workspace tests**

Verify opening an expiry group renders `InventoryActionDialog` with row versions, sends explicit snooze action types, and keeps the dialog open after a stale conflict until refreshed data is reviewed.

- [ ] **Step 2: Rename overlay state by responsibility**

Replace `destroyExpiredIngredientId`/`destroyExpired` naming with one inventory-action selection that can review, snooze, correct, or dispose. Keep `inventory`, `shopping`, and `consume` overlay modes unchanged.

- [ ] **Step 3: Replace the old destroy overlay with the shared dialog**

Build the selected `ExpiryInventoryActionGroup` from the shared model and render `InventoryActionDialog` in `IngredientWorkspaceOverlays.tsx`. Wire the same three mutations and 409 behavior used by home. Do not make the dialog depend on `IngredientSummaryViewModel`.

- [ ] **Step 4: Verify and commit the dialog migration**

```bash
npm --prefix frontend run test -- IngredientWorkspaceOverlays InventoryActionDialog
npm --prefix frontend run typecheck
git add frontend/src/components/ingredients/useIngredientOverlayState.ts frontend/src/components/ingredients/useIngredientActionState.ts frontend/src/components/ingredients/IngredientWorkspaceOverlayTypes.ts frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx frontend/src/components/ingredients/IngredientWorkspace.tsx
git commit -m "refactor(ingredients): reuse inventory action dialog"
```

---

## Task 8C: Consume Navigation Requests and Remove the Legacy Overlay

**Files:**

- Modify: `frontend/src/app/useAppGlobalSearchNavigation.ts`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Modify: navigation/usage tests
- Delete only when unused: `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx`
- Delete only when replaced: its focused tests

- [ ] **Step 1: Add failing navigation consumption tests**

Verify each discriminated request is consumed once by `requestId`, `shopping` always has a real ingredient ID, and `priority` requires none.

- [ ] **Step 2: Route low stock and priority navigation**

When the app requests `target: 'shopping'`, use the existing `openShoppingOverlay` with the real ingredient ID and `target_type: 'ingredient'`. When it requests `target: 'priority'`, desktop activates the shared `需处理` hub/catalog filter and focuses the complete priority list; mobile scrolls/focuses the existing `今天先处理` section. Do not fake a search string or merely switch to the ingredient tab and call that complete.

- [ ] **Step 3: Remove legacy code only after proving it unused**

Run:

```bash
rg -n "IngredientDestroyExpiredOverlay|DestroyExpiredInventoryDialog|destroyExpiredIngredientId|submitDestroyExpired" frontend/src
```

If no legitimate callers remain, delete the old component and update/delete its tests. If a caller remains, complete its migration instead of leaving two competing expiry dialogs.

- [ ] **Step 4: Run focused ingredient tests**

```bash
npm --prefix frontend run test -- workspaceModel.test.ts IngredientWorkspace IngredientMobile InventoryActionDialog
npm --prefix frontend run typecheck
```

- [ ] **Step 5: Commit navigation and cleanup**

```bash
git add frontend/src/app/useAppGlobalSearchNavigation.ts frontend/src/components/ingredients/IngredientWorkspace.tsx
git add -u -- frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx frontend/src/components/ingredients/IngredientDestroyExpiredOverlayUsage.test.ts
git commit -m "refactor(ingredients): finalize action navigation"
```

Run the second `git add` only after the `rg` proof confirms those files were deleted; otherwise omit it and finish the remaining migration first.

---

## Task 9: Make Background-Task Attention and Ordering Semantics Honest

**Delivery boundary:** This is Phase B, an independent commit/PR and revert boundary after the inventory Action Center. It has no runtime dependency on Tasks 1–8C. Execute it sequentially after those tasks in this plan because both phases edit `frontend/src/api/types.ts`; do not dispatch it in parallel on the shared worktree.

**Files:**

- Modify: `backend/app/schemas/media.py`
- Modify: `backend/app/schemas/search.py`
- Modify: `backend/app/api/media.py`
- Modify: `backend/app/api/search.py`
- Create: `backend/tests/media/test_ai_image_job_api.py`
- Modify: `backend/tests/search/test_search_index_jobs.py`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/app/AppShell.test.tsx`
- Modify: `frontend/src/hooks/useAiImageJobMonitor.ts`

- [ ] **Step 1: Add failing backend response-contract tests**

Assert image-generation and search-index active/get/retry responses expose `created_at` and nullable `completed_at` from their existing model columns. No migration is needed because both job models already persist these timestamps.

- [ ] **Step 2: Extend job response schemas and renderers**

Add timestamps to `AiRenderResponse` and `SearchIndexJobResponse`, return them from every response path—including initial image-job creation—through `_render_job_response`/`_render_search_index_job_response` or an equivalent single serializer, and update frontend API types.

- [ ] **Step 3: Add failing badge/list tests**

Cover:

- successful jobs alone render no numeric badge;
- queued/running and failed jobs contribute to the badge;
- badge value is `activeCount + failedCount`, not total rows;
- trigger accessible name is `查看后台任务`;
- popover title is `后台任务`;
- all active and failed rows remain visible;
- successful history is capped at five, newest first, if more are returned;
- image and search jobs are sorted together by `completed_at ?? created_at`, rather than source-array concatenation order;
- dismissed terminal jobs stay filtered by the existing local-storage behavior.

- [ ] **Step 4: Preserve timestamps in the notification projection**

Add `created_at` and `completed_at` to `AppNotificationJob` and map both response types in `useAiImageJobMonitor.ts`. Do not reconstruct timestamps on the client.

- [ ] **Step 5: Implement attention semantics**

Use:

```ts
const attentionCount = activeCount + failedCount;
```

Render a badge only when `attentionCount > 0`. Keep recent successes in the popover but never in attention count. Do not alter backend retention: image terminal jobs remain 10 minutes and search-index terminal jobs remain 24 hours.

- [ ] **Step 6: Keep ordering/capping pure and local**

Order failed, then active, then successful; within each bucket sort descending by `completed_at ?? created_at` with `notification_id` as a deterministic tie-breaker. Preserve all failed/active rows and cap only successful rows to five. Put the helper in `AppShell.tsx` unless extracting it materially improves testing; do not add another monitor hook for this small rule.

- [ ] **Step 7: Verify**

```bash
cd backend && .venv/bin/pytest tests/media/test_ai_image_job_api.py tests/search/test_search_index_jobs.py -q
npm --prefix frontend run test -- AppShell.test.tsx
npm --prefix frontend run typecheck
```

- [ ] **Step 8: Commit the task-center cleanup**

```bash
git add backend/app/schemas/media.py backend/app/schemas/search.py backend/app/api/media.py backend/app/api/search.py backend/tests/media/test_ai_image_job_api.py backend/tests/search/test_search_index_jobs.py frontend/src/api/types.ts frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/hooks/useAiImageJobMonitor.ts
git commit -m "fix(shell): count only background tasks needing attention"
```

---

## Task 10: Full Validation, Migration Smoke, and Design Audit

**Files:** all files changed by Tasks 0–9 and the approved design/plan documents.

- [ ] **Step 1: Inspect the full diff before broad tests**

```bash
git status --short
git diff --check
git diff --stat
git diff -- \
  backend/app \
  backend/alembic \
  backend/tests \
  frontend/src \
  frontend/scripts \
  docs/superpowers/specs/2026-07-11-home-action-center-design.md \
  docs/superpowers/plans/2026-07-11-home-action-center.md
```

Confirm no `.env`, credentials, generated bundles, screenshots, or unrelated user changes were added.

- [ ] **Step 2: Execute the migration against local MySQL**

Start only the required local services if they are not already running:

```bash
npm run db:up
cd backend && .venv/bin/alembic upgrade head
cd backend && .venv/bin/alembic current
```

Inspect the live table with the repository's configured MySQL connection and confirm:

- `row_version` is non-null/default 1;
- snooze/review columns exist with correct types;
- the reviewer foreign key has `ON DELETE SET NULL`.

Do not print database passwords or full connection URLs.

On a dedicated disposable local test database, also execute a real round trip:

```bash
cd backend && .venv/bin/alembic downgrade -1
cd backend && .venv/bin/alembic upgrade head
cd backend && .venv/bin/alembic current
```

Do not run the destructive downgrade on a shared, production-like, or user-data-bearing database. If no disposable database is available, retain the offline downgrade SQL inspection and record the verification gap explicitly.

On that disposable MySQL database, rerun the Task 3 two-session scenario and retain the focused test output as evidence. SQLite-only green tests do not close the concurrency acceptance criterion.

- [ ] **Step 3: Run all backend tests**

```bash
npm run backend:test
```

Expected: full pytest suite passes. Inventory contracts changed, so a focused green suite alone is insufficient.

- [ ] **Step 4: Run all frontend quality gates**

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run check:style-tokens
```

Expected: Vitest, TypeScript/Vite build, bundle budgets, and style-token checks pass.

- [ ] **Step 5: Run responsive smoke**

```bash
npm --prefix frontend run smoke
```

The smoke evidence must cover home and the action dialog at 375, 390, and 430px without horizontal overflow, plus the existing desktop breakpoint. Task 7B must already have added the new dialog path; do not defer this to a manual-only check.

- [ ] **Step 6: Perform an authenticated browser walkthrough**

Use a dedicated representative test family, not irreplaceable household data. Seed only test fixtures containing repeated same-ingredient batches, mixed expired/upcoming rows, a future-snoozed row, a legacy title-only shopping row, an ingredient-bound shopping row, and a substring-collision pair such as `牛奶`/`牛奶麦片`. This is acceptance data, not a migration or cleanup of the user's real family. Verify:

1. successful-only background jobs show no badge;
2. desktop has one `今天要处理` and no `临期优先处理`;
3. mobile shows at most three grouped rows;
4. mixed batches default to expired-only selection;
5. temporary retention keeps the old expiry date and hides the group until snooze date;
6. upcoming snooze does not write reviewer fields;
7. date correction clears prior review metadata;
8. stale two-session submission returns 409 and refreshes selection;
9. disposal never includes a future batch;
10. completion offers the next ingredient but does not auto-open it;
11. a just-processed ingredient is not immediately suggested again when it becomes low stock;
12. low-stock action opens ingredient-bound shopping;
13. `查看全部` reaches the complete priority area.
14. the stat count equals all unique home-eligible groups while only three rows render;
15. `在库食材` counts unique non-expired available ingredients rather than batches;
16. legacy quick restock never resolves by substring;
17. the complete priority area can work through the representative messy fixture without hiding later groups.

- [ ] **Step 7: Run backend and frontend audit skills**

Audit the final diff with the repository's `backend-code-audit` and `frontend-code-audit` instructions. Run one initial audit and at most two re-audits. For every real P0/P1/P2 finding:

1. add or adjust a reproducing test;
2. fix the implementation;
3. rerun the focused test;
4. rerun the affected full gate;
5. re-audit within the three-pass cap.

If a P0/P1 blocker remains after the final allowed pass, stop completion, report the exact evidence and affected acceptance criterion, and request a decision. Do not claim completion or loop indefinitely.

Explicitly check family isolation, transaction rollback, version conflicts, cache invalidation, mobile overflow, accessible names, and duplicate business rules.

- [ ] **Step 8: Update documentation if implementation names changed**

Only update the spec/plan for implementation-level names discovered from repo truth. Do not silently revise confirmed product decisions. Keep spec status `Approved design`.

- [ ] **Step 9: Final commit**

```bash
git add docs/superpowers/specs/2026-07-11-home-action-center-design.md docs/superpowers/plans/2026-07-11-home-action-center.md
# Then stage only the still-uncommitted files named in Tasks 1–9 after reviewing `git status --short`.
git commit -m "feat: ship household inventory action center"
```

If all implementation slices were already committed and only verification produced no file changes, do not create an empty final commit.

---

## Completion Checklist

- [ ] The approved design behavior is implemented without a notification table or timezone expansion.
- [ ] Home displays no duplicate expiry panel and no shopping/completed-meal rows in `今天要处理`.
- [ ] Home shows no more than three unique ingredient groups.
- [ ] Home count and visible rows derive from one unlimited home-eligible projection; 4–7 day groups stay out of the home count.
- [ ] `buildInventoryAlerts`/`inventoryAlertCount` no longer feed home, and `在库食材` counts unique non-expired available ingredients.
- [ ] Ingredient workspace and home share one grouping model and one expiry-action dialog.
- [ ] Ingredient priority, `需处理` filtering, and actionable card state no longer keep a separate two-day rule.
- [ ] Review, future snooze, correction, and disposal have distinct valid selections and semantics.
- [ ] Original expiry evidence is preserved for temporary retention.
- [ ] Snooze never changes expired-stock availability, recipe readiness, AI expired state, or low-stock quantity.
- [ ] Every safety-sensitive batch action uses stable locking plus expected `row_version` and returns 409 on stale state.
- [ ] Direct, recipe-cook, AI recipe-cook, AI inventory, and new expiry mutation boundaries translate `StaleDataError` to their documented HTTP/AI conflict type.
- [ ] A real MySQL two-session test covers a competing cook/dispose followed by a stale dialog submission.
- [ ] All-or-nothing family/ingredient validation is covered by tests.
- [ ] Inventory invalidation/refetch is awaitable, and next-item/conflict branches use refreshed canonical groups.
- [ ] Priority/shopping navigation lands on the documented desktop/mobile surface and consumes each request once.
- [ ] Low-stock thresholds and shopping quick-restock bindings use stable ingredient-level fields without substring matching.
- [ ] Home/action date consumers use one `Asia/Shanghai` business key and UTC-safe calendar differences.
- [ ] Background-task badge counts only active and failed work.
- [ ] Background jobs carry real persisted timestamps and sort correctly across image and search job types.
- [ ] Next-item continuation never immediately repeats the ingredient that was just processed.
- [ ] Full backend tests, frontend tests/build/style checks, migration smoke, responsive smoke, browser walkthrough, and code audits are complete.
