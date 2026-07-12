# Home Action Center and Reminder Fatigue Design

**Date:** 2026-07-11

**Status:** Approved design

## Goal

Reduce reminder fatigue on the Culina home dashboard without weakening inventory safety or creating a second source of truth.

The redesigned experience must:

- separate technical background-task status from household work;
- group repeated expiry batches by ingredient;
- show at most three genuinely actionable ingredient groups on the home dashboard;
- preserve original expiry evidence when a member decides an expired batch can remain temporarily;
- support safe batch handling within one ingredient and fast continuation to the next ingredient;
- make desktop and mobile use the same business rules while preserving their existing independent layouts.

## Confirmed Product Decisions

The following decisions were confirmed during design discussion:

1. The top-right center remains a technical background-task surface. It does not become a unified household notification inbox.
2. Expired inventory that a member judges temporarily usable keeps its original expiry date. The system records the review and a future reminder date instead of rewriting history.
3. Desktop removes the separate `临期优先处理` panel. Desktop and mobile both use one `今天要处理` section with at most three ingredient groups.
4. Shopping remains in the existing `采购提醒` section and completed meals remain in meal/activity history. Neither appears in `今天要处理`.
5. One operation handles multiple batches of one ingredient. Cross-ingredient one-click disposal is not allowed. After completion, the user may continue to the next ingredient.

## Current State

### Background-task center

`AppNotificationCenter` is currently fed only by AI image-generation and search-index jobs. It is not a household notification system.

The two backend job-list endpoints use different terminal-history windows:

- AI image jobs: the last 10 minutes, up to 100 rows;
- search-index jobs: the last 24 hours, up to 100 rows.

Both also return all queued/running jobs. The trigger already calculates active and failed counts, but its numeric badge uses the total returned row count. As a result, successful jobs can produce a large badge such as `45`, even when nothing requires attention.

Dismissal is browser-local through `localStorage`; there is no persisted read/unread notification model.

### Home expiry and todo calculations

The home dashboard currently has overlapping calculations:

- `buildInventoryAlerts` counts low-stock ingredients and each inventory batch expiring within two days.
- `buildHomeDashboardViewModel` separately selects each remaining inventory batch expiring within seven days.
- desktop renders those batches once in `临期优先处理` and again in `今日待办`;
- `今日待办` also includes pending shopping items and today's completed meals;
- mobile renders the first four raw todo rows, while desktop incrementally reveals raw rows on scroll.

The same ingredient can therefore occupy several positions, the dashboard count can disagree with the visible seven-day list, shopping is duplicated with `采购提醒`, and completed meals make a work queue look unfinished.

Two adjacent dashboard calculations also need to be corrected as part of the same source-of-truth cleanup:

- the current `临期提醒` stat is fed by `buildInventoryAlerts()` through `inventoryAlertCount`, so replacing only the visible list would leave the old two-day/raw-row count on screen;
- the current `在库食材` stat counts inventory rows while labeling them as ingredient kinds, and does not consistently exclude expired stock.

The existing shopping quick-restock resolver also matches names before stable IDs and permits substring matches. That can bind `牛奶` to `牛奶麦片`; the action-center rollout must remove this ambiguity rather than only using stable IDs when creating new shopping rows.

### Existing reusable capability

The ingredient workspace already builds `IngredientSummaryViewModel` rows grouped by ingredient. Its mobile `今天先处理` area can dispose all expired batches belonging to one ingredient. The existing backend `/api/inventory/dispose-expired` endpoint also validates that every submitted batch belongs to the current family and the same ingredient.

This design reuses that business boundary instead of adding a parallel household-notification table.

## Product Model

### Surface terminology

Use two distinct terms throughout the UI:

- **后台任务**: AI image generation and search indexing. This is technical progress or failure recovery.
- **今天要处理**: household inventory work a family member can act on now.

Do not label both surfaces `通知` or use the same count semantics.

### Inventory action group

Introduce a discriminated union representing one ingredient-level action:

```ts
type InventoryActionBatch = {
  inventoryItemId: string;
  rowVersion: number;
  remainingQuantity: number;
  unit: string;
  storageLocation: string;
  purchaseDate: string;
  expiryDate: string;
  daysLeft: number;
  expiryAlertSnoozedUntil: string | null;
  expiryReviewedAt: string | null;
  expiryReviewedBy: string | null;
};

type ExpiryInventoryActionGroup = {
  kind: 'expiry';
  id: string;
  ingredientId: string;
  ingredientName: string;
  severity: 'expired' | 'expires_today' | 'expires_soon' | 'expires_later';
  batches: InventoryActionBatch[];
  expiredBatchCount: number;
  todayBatchCount: number;
  soonBatchCount: number;
  laterBatchCount: number;
  totalBatchCount: number;
  quantityLabels: string[];
  storageLocations: string[];
  earliestExpiryDate: string | null;
  earliestDaysLeft: number | null;
  title: string;
  detail: string;
  primaryAction: 'manage_expiry';
};

type LowStockInventoryActionGroup = {
  kind: 'low_stock';
  id: string;
  ingredientId: string;
  ingredientName: string;
  availableQuantity: number;
  unit: string;
  threshold: number;
  title: string;
  detail: string;
  primaryAction: 'add_shopping';
};

type InventoryActionGroup = ExpiryInventoryActionGroup | LowStockInventoryActionGroup;
```

This is a derived view model, not a persisted notification entity.

The shared inventory model must not use `Home*` type names. Home-only eligibility/counting is expressed by `selectHomeEligibleInventoryActionGroups()`, its visible limit by `selectHomeInventoryActionGroups()`, and any small home summary remains local to the home feature; the ingredient workspace consumes the generic union directly.

### Actionable inventory predicate

An ingredient inventory batch participates in action grouping only when all conditions are true:

- it belongs to the current family data already returned by the authenticated API;
- it has remaining quantity;
- it has an `expiry_date` no later than seven days from the family-local current date;
- `expiry_alert_snoozed_until` is absent or is on/before the agreed business reference date.

A temporarily retained batch therefore remains visibly expired in its detail data but leaves the home action queue until its snooze date arrives.

### Low-stock predicate

A low-stock action is created only when:

- the ingredient tracks quantity;
- `ingredient.default_low_stock_threshold` is non-null;
- its available, non-expired quantity is at or below `ingredient.default_low_stock_threshold`;
- no pending ingredient-target shopping item already references that ingredient;
- the same ingredient does not already have a higher-priority expiry action.

`InventoryItem.low_stock_threshold` remains available to legacy/AI inventory paths but is not an input to the new household action projection. The action center has one ingredient-level threshold source.

When a shopping item already exists, the need is represented only in `采购提醒`.

Shopping deduplication uses the stable binding first:

```ts
pendingShoppingItems.some(
  (item) =>
    !item.done &&
    item.target_type === 'ingredient' &&
    item.ingredient_id === ingredient.id
)
```

Only legacy ingredient-target rows without `ingredient_id` may fall back to normalized exact-name matching. Substring matching such as `title.includes(ingredient.name)` is forbidden because it can confuse `牛奶` with `牛奶麦片` or `油` with `酱油`.

The same resolution order applies when the existing home procurement card performs quick restock:

1. exact `ingredient_id`;
2. normalized exact ingredient name only for legacy rows without an ID;
3. otherwise require the user to choose an ingredient instead of guessing.

### Grouping

All actionable batches for the same ingredient become one group. A group may contain a mixture of expired, today, soon, and later batches.

Example:

```text
番茄
3 个批次已过期，2 个批次 3 天内到期
冷藏 · 共 12 个
```

The group detail must expose batch counts rather than pretending every batch has the same date.

### Priority order

Sort groups deterministically by:

1. `expired`;
2. `expires_today`;
3. `expires_soon` for one to three days;
4. `low_stock` not already in the shopping list;
5. `expires_later` for four to seven days;
6. earliest expiry date;
7. ingredient name and ID as stable tie-breakers.

Only the first four severity categories are eligible for the home dashboard. `expires_later` appears after entering the complete ingredient processing view.

The home dashboard displays the first three eligible groups.

### Count semantics

The home stat changes from raw alert rows to unique, home-eligible ingredient groups. Define one unlimited `homeEligibleGroups` projection containing `expired`, `expires_today`, `expires_soon`, and `low_stock`, then derive both the count and the visible first three rows from it:

```ts
const homeEligibleGroups = selectHomeEligibleInventoryActionGroups(allGroups);
const homeVisibleGroups = homeEligibleGroups.slice(0, 3);
const homeActionCount = homeEligibleGroups.length;
```

`expires_later` groups remain in the complete ingredient priority area and do not inflate the home count. `buildInventoryAlerts()` and `inventoryAlertCount` must no longer feed any home action stat, title, or badge. The same prepared action groups drive the ingredient priority count and actionable card/filter state; a separate two-day action rule must not survive in `workspaceModel.ts`.

Recommended copy:

```text
需处理食材
6 种
过期、临期或待补货
```

The number never counts the same ingredient twice. Batch counts remain visible inside the group detail.

The separate `在库食材` stat means unique ingredients with positive, non-expired available inventory, not inventory-row count. Its value is derived from the same explicit business date used by the action model.

## Persistence Design

### InventoryItem review and version fields

Add these fields to `InventoryItem`:

- `row_version: int`, non-null, default `1`;
- `expiry_alert_snoozed_until: date | None`;
- `expiry_reviewed_at: datetime | None`, stored with the repository's `DateTime(timezone=True)` convention and populated with `utcnow()`;
- `expiry_reviewed_by: str | None`, `String(64)` foreign key to `users.id` with `SET NULL` on user deletion;

Existing inventory rows receive `row_version=1`; review and snooze fields default to null.

The original `expiry_date` remains unchanged when a member chooses `暂时保留`.

### Why `row_version` is required

The repository already uses `baseUpdatedAt` in AI write paths, so reusing `updated_at` would normally be attractive. However, the current MySQL compilation of `InventoryItem.updated_at` is plain `DATETIME`, without fractional-second precision. Two writes within one second can therefore retain the same timestamp and cannot strictly guarantee stale-view detection.

For this safety-sensitive batch flow, use an integer `row_version` instead of an unreliable timestamp token. Configure it as SQLAlchemy's `version_id_col` on `InventoryItem`, so every ORM mutation that changes an existing row increments and checks the version automatically, including consume, dispose, expiry review, expiry-date correction, recipe cooking deductions, and AI inventory operations. Convert `StaleDataError` at inventory transaction boundaries into the existing conflict response style rather than relying on individual routes to increment the field manually.

Because `version_id_col` changes every ORM update rather than only the three new routes, implementation must verify this mutation matrix explicitly:

| Mutation path | Concurrency behavior | Conflict translation |
| --- | --- | --- |
| direct inventory consume/dispose | preserve existing family checks and row locks; version increments automatically | HTTP `409 Conflict` |
| ordinary recipe cook deduction | add the missing lock/version-safe boundary before mutating inventory | HTTP `409 Conflict` |
| AI recipe cook | use the same inventory service boundary | `AIConflictError` |
| AI inventory consume/dispose | preserve the existing locked service path | `AIConflictError` |
| review, snooze, correction, versioned expired disposal | stable-ID row lock plus explicit expected-version comparison before any write | HTTP `409 Conflict` |

`commit_session()` may continue to roll back and re-raise internally, but the owning HTTP or AI boundary must translate only `StaleDataError`; unrelated database failures remain server errors. A real MySQL two-session test is required because SQLite cannot validate MySQL `FOR UPDATE` semantics.

### Review semantics

When one or more already-expired batches are temporarily retained:

- set the same `expiry_reviewed_at`, `expiry_reviewed_by`, and `expiry_alert_snoozed_until` on all selected rows;
- require the snooze date to be later than the family-local current date;
- keep the original inventory status, quantities, purchase date, and expiry date;
- set `updated_by` and `updated_at` through the existing audit pattern;
- increment `row_version`;
- write one ingredient-level activity record for the user action rather than one activity row per batch.

Suggested activity copy:

```text
林然确认番茄 3 个过期批次暂时保留，7月14日再次提醒
```

`expiry_reviewed_by` persists the user ID for audit integrity. The service obtains the acting member's display name through the current authenticated membership/user context when writing activity copy. The frontend must not render the raw ID; if no member lookup is available in the dialog, it shows neutral copy such as `此前已由家庭成员确认暂时保留` plus the review time.

When a not-yet-expired batch is merely postponed:

- set `expiry_alert_snoozed_until`;
- do not set `expiry_reviewed_at` or `expiry_reviewed_by`;
- record that the alert was postponed, not that expired food was reviewed as usable.

### Correcting an incorrect date

`日期录错了` is a data correction, not an expiry review.

Correcting a batch expiry date:

- updates that batch's `expiry_date`;
- clears `expiry_reviewed_at`, `expiry_reviewed_by`, and `expiry_alert_snoozed_until` because the previous review no longer applies;
- increments `row_version`;
- writes an activity record describing the correction;
- requires a fresh dashboard/ingredient query before calculating the next action group.

The UI must never describe `暂时保留` as changing the expiry date.

## API Design

### Batch expiry-alert snooze

Add:

```http
POST /api/inventory/snooze-expiry-alerts
Content-Type: application/json

{
  "action": "retain_expired",
  "ingredient_id": "ingredient-id",
  "items": [
    {"inventory_item_id": "inventory-id-1", "expected_row_version": 3},
    {"inventory_item_id": "inventory-id-2", "expected_row_version": 5}
  ],
  "snoozed_until": "2026-07-14"
}
```

Response:

```json
{
  "ingredient_id": "ingredient-id",
  "snoozed_item_ids": ["inventory-id-1", "inventory-id-2"],
  "snoozed_count": 2,
  "reviewed_expired_count": 2,
  "snoozed_until": "2026-07-14"
}
```

The request action is explicit:

- `retain_expired`: every selected row must have `expiry_date < today`; write review attribution and the snooze date;
- `snooze_upcoming`: every selected row must have `expiry_date >= today`; write only the snooze date.

One request cannot mix expired and upcoming rows. This keeps the server contract aligned with the dialog's action-specific selections and prevents one API call from expressing two different household decisions.

Backend validation must ensure, in one transaction, that:

- the ingredient belongs to the authenticated family;
- every requested batch belongs to the authenticated family and submitted ingredient;
- every batch still has remaining quantity;
- every batch has an expiry date;
- every batch is currently actionable: its expiry date is no later than seven days from the business date and its existing snooze is absent or due;
- the request action matches every selected batch's expired/upcoming state;
- the reminder date is after the family-local current date and no later than 30 days after it;
- every locked row's `row_version` equals `expected_row_version`;
- no partial update is committed if any row is invalid.

Rows are selected in stable ID order and locked with `with_for_update()` before comparison. If another family member changed a selected batch, return `409 Conflict` before any update so the client can refresh instead of silently acting on stale data.

### Correct one batch's expiry date

Add:

```http
PATCH /api/inventory/{inventory_item_id}/expiry-date
Content-Type: application/json

{
  "expiry_date": "2026-07-20",
  "expected_row_version": 3
}
```

The route resolves and locks the row under the authenticated family, compares `row_version`, validates a real date, clears review metadata, increments `row_version`, records activity, and returns the updated `InventoryItemOut`.

This endpoint is deliberately narrow. This phase does not introduce a generic inventory-batch editor.

### Existing disposal endpoint

Continue using `/api/inventory/dispose-expired` for destructive processing, but change its selected-item contract to the same `{inventory_item_id, expected_row_version}` shape. Lock rows in stable ID order, compare versions, and return `409 Conflict` for stale-state conflicts while preserving its all-or-nothing, same-family, same-ingredient behavior.

The exact route/response contract for this phase is:

- `POST /api/inventory/snooze-expiry-alerts` → `SnoozeExpiryAlertsResponse` containing ingredient ID, affected item IDs/count, reviewed-expired count, and snooze date;
- `PATCH /api/inventory/{inventory_item_id}/expiry-date` → updated `InventoryItemOut`;
- `POST /api/inventory/dispose-expired` → existing `DisposeExpiredInventoryResponse` with a versioned request body.

The snooze response deliberately returns identifiers rather than full inventory rows. Every successful mutation refreshes the canonical inventory queries before calculating the next group.

### Cross-end contract

Extend `InventoryItemOut` and the frontend `InventoryItem` type with:

```text
expiry_reviewed_at?: string | null
expiry_reviewed_by?: string | null
expiry_alert_snoozed_until?: string | null
row_version: number
```

The frontend mutation invalidates the existing inventory, inventory-overview, food-recommendation, and activity-log keys through `invalidateAfterInventoryChanged`.

That invalidation boundary must be awaitable. `invalidateMany()` returns the combined invalidation promises, and action flows wait for the canonical inventory query to refetch before calculating completion or the next group. A fulfilled `mutateAsync()` alone is not proof that the derived groups are fresh.

No new React Query key is necessary because action groups are derived from inventory, ingredients, and shopping-list queries.

## Background Task Center

This cleanup is Phase B of the same P0 epic but an independently testable and revertible delivery from the inventory Action Center (Phase A). It may be merged separately after Phase A. The two phases execute sequentially because both touch shared frontend API types; they are not parallel work on the same worktree.

### Badge behavior

Rename user-facing `通知` copy in this component to `后台任务`.

The component already calculates `activeCount` and `failedCount`. Introduce:

```ts
const attentionCount = activeCount + failedCount;
```

Render `attentionCount` in the trigger badge. Successful jobs never contribute to the badge.

### List behavior

The popover continues to receive browser-filtered rows from the current monitor and may show:

- all currently queued/running jobs;
- all currently returned failed jobs that the browser has not dismissed;
- at most the five most recent successful jobs.

Order rows by:

1. failed;
2. queued/running;
3. succeeded, newest first.

`AIImageGenerationJob` and `SearchIndexJob` already persist `created_at` and `completed_at`, but their current response schemas omit those fields. Add both timestamps to `AiRenderResponse`, `SearchIndexJobResponse`, and `AppNotificationJob`, then sort across job types by `completed_at ?? created_at`. This is a response-contract extension only; no migration or retention change is needed.

Successful rows remain informational, automatically leave their existing backend windows, and need no read/unread state. Failed rows keep retry and dismiss actions. Dismissal remains browser-local in this phase.

This phase does not change backend job-retention windows or introduce backend notification persistence. If the popover needs a shorter visual history, cap successful rows in the frontend while keeping all active and failed rows.

### Accessibility

- Trigger accessible name: `查看后台任务`.
- Popover dialog name: `后台任务`.
- Badge has a screen-reader description distinguishing failures from active jobs.
- A zero-attention state does not render a numeric badge even when recent successes are visible in the popover.

## Home Dashboard Design

### Desktop

Remove the standalone `临期优先处理` panel and replace the current mixed `今日待办` content with one `今天要处理` panel.

```text
┌ 今天要处理 ───────────────────── 查看全部 ┐
│ 番茄  3 批已过期、2 批临期  [集中处理]  │
│ 牛奶  今天到期 2 盒          [查看处理]  │
│ 鸡蛋  库存不足               [加入采购]  │
└─────────────────────────────────────────┘
```

The panel:

- displays at most three groups;
- has no infinite scroll;
- shows an empty state when nothing is currently actionable;
- sends `查看全部` to a defined ingredient-workspace priority landing point;
- does not render shopping items or completed meal rows.

The existing recent-activity panel and procurement reminder remain unchanged in this feature.

Cross-workspace destinations are concrete rather than symbolic:

| Request | Desktop destination | Mobile destination | Side effect |
| --- | --- | --- | --- |
| `priority` | ingredient hub/catalog with the shared `需处理` filter active and the priority list focused | scroll/focus the existing `今天先处理` section | no overlay |
| `shopping` | resolve the real ingredient, then open the existing ingredient shopping overlay | same ingredient-bound overlay | `openShoppingOverlay(ingredientId)` |

Each request is consumed once by `requestId`. `priority` must not be approximated with a search string, and `shopping` must never fall back to a title-only target.

### Mobile

Replace the current first-four raw todo rows with the same first-three grouped actions. The mobile component remains independently structured and uses the existing warm card treatment, 44-pixel touch targets, bottom safe-area spacing, and fixed bottom navigation.

The mobile action row keeps one clear primary action. Secondary batch details open through the processing dialog rather than adding several small buttons to the home card.

### Group presentation

Status tone follows current Culina semantics:

- expired: restrained danger red;
- expires today / within three days: warning amber;
- low stock: soft yellow;
- calm or empty states: soft green/warm neutral.

Only the primary action uses strong emphasis. The entire row may open details, but it must not contain nested ambiguous click targets.

## Processing Interaction

### One ingredient at a time

Opening an expiry group shows every included batch for that ingredient with:

- selection checkbox;
- remaining quantity and unit;
- storage location;
- purchase date;
- original expiry date;
- current review/snooze state, if any.

The dialog separates rows into `已过期批次` and `即将到期批次` and uses action-specific selection:

- when the group contains expired rows, only expired rows start selected;
- when the group contains no expired rows, the not-yet-expired rows start selected;
- changing action mode resets the selection to valid rows for that action;
- one shared selection set must never be reused across disposal, expired retention, and future-alert postponement.

The user may change the selection within the current action's valid rows.

The summary always states the selected batch count and total quantities grouped by unit.

Quantity confirmation groups exact display units without unsafe conversion. For example, `2 盒 + 1 盒` becomes `3 盒`, while `500 克 + 1 袋` remains `500 克、1 袋`. Do not sum unlike units or invent a conversion that is not already represented by the inventory data.

### Available actions

For selected expired batches:

- `销毁所选批次`: destructive action using the existing disposal flow;
- `暂时保留`: opens reminder-date selection;
- `日期录错了`: row-level correction entry.

Reminder-date presets are:

- 明天；
- 3 天后；
- 自定义日期。

Do not include a long default such as 30 days. The copy must state that the original expiry date remains visible and that the user, not the system, is deciding to keep the item.

For batches that are not yet expired:

- `稍后提醒` may update only `expiry_alert_snoozed_until`;
- `销毁所选批次` is unavailable;
- `暂时保留` is unavailable because no post-expiry usability review occurred;
- `日期录错了` remains a single-batch action.

The UI must not describe future-alert postponement as expired-food review.

### Confirmation rules

- Disposal requires a second confirmation containing ingredient name, selected batch count, and total quantities.
- Temporary retention requires one explicit confirmation after the reminder date is selected.
- Date correction requires saving the corrected date for one row.
- No cross-ingredient destructive action exists.

### Continuous processing

After a successful operation:

1. await invalidation and the canonical inventory refetch;
2. close the completed group's detail state;
3. calculate the next eligible group from refreshed data, excluding the ingredient that was just processed;
4. show `已处理番茄` and, when applicable, `下一项：牛奶`;
5. continue only after the user chooses `处理下一项`.

Do not auto-open the next destructive flow.

If the completed ingredient changes into low stock after disposal, show a secondary completion action such as `番茄库存已不足，加入采购`; do not immediately present the same ingredient as `下一项`.

### Concurrent family changes

When the backend returns `409 Conflict`:

- preserve the user's current dialog long enough to show a clear conflict message;
- refresh inventory and action groups;
- explain that another family member changed the batch;
- require the user to review the refreshed selection before resubmitting.

After the awaited refresh, conflict recovery has two explicit branches:

- if the ingredient group still exists, replace the dialog data with the refreshed batches, clear the old selection and confirmation state, and require a new review;
- if the group no longer exists because another member already handled it, close the dialog and show `这批库存已由家人处理`.

Never silently drop invalid rows and process the remainder.

## Shared Frontend Architecture

Create focused shared inventory files rather than expanding `App.tsx`, `HomeDashboard.tsx`, or the already large ingredient workspace model.

Recommended responsibility split:

- create `frontend/src/features/inventory/inventoryActionModel.ts`: predicates, grouping, counts, severity, sorting, and presentation-ready copy;
- create `frontend/src/features/inventory/InventoryActionDialog.tsx`: same-ingredient batch selection, action modes, confirmation, date correction, and responsive dialog UI;
- modify the existing `frontend/src/features/home/homeDashboardModel.ts`: home-specific selection of the first three eligible groups and unrelated dashboard data;
- modify the existing `frontend/src/features/home/useHomeDashboardState.ts`: replace obsolete raw-list visibility state with selected group/dialog/continuous-processing state;
- modify the existing `frontend/src/features/home/useHomeDashboardActions.ts`: add review, correction, versioned disposal, conflict recovery, and next-group orchestration to its current home action responsibilities;
- modify `HomeDashboard.tsx` and `HomeMobileDashboard.tsx`: render the prepared union groups;
- modify `frontend/src/components/ingredients/workspaceModel.ts`: consume the shared grouping/predicate rules instead of maintaining a second threshold implementation;
- desktop/mobile view components: render already prepared groups;
- API client/types/cache invalidation: transport and cross-end contract only.

The ingredient workspace should consume the same grouping rules for `今天先处理` so home and ingredient pages cannot drift back to different thresholds or counts.

The same rule also drives the workspace's `需处理` filter and actionable card state. Existing neutral inventory/date badges may remain presentation details, but they must not claim an ingredient is calm when the shared action projection includes it.

Cross-workspace navigation uses a discriminated union, not independent optional `view` and `target` fields. `catalog` and `priority` require no ingredient ID; `detail` and `shopping` require one. Invalid combinations must be rejected by TypeScript.

Do not create another `useHomeDashboardState.ts`, `useHomeDashboardActions.ts`, or similarly named parallel hook. Both files already exist and already own home dialogs and mutation orchestration.

## Business Date Policy

This phase does not add a configurable family timezone.

The current backend `today_for_family()` ignores `family_id` and resolves dates in `Asia/Shanghai`. The frontend's general `todayKey()` uses the device-local calendar. To prevent the action model and backend from disagreeing near midnight:

- define this feature's business reference date as the current date in `Asia/Shanghai`;
- compute it outside the pure action model using a small tested date helper;
- always call the pure model with an explicit `referenceDate`:

```ts
buildInventoryActionGroups({
  inventoryItems,
  ingredients,
  shoppingItems,
  referenceDate,
});
```

- never call `todayKey()` inside `inventoryActionModel.ts`;
- use backend `today_for_family()` for all review, correction, and disposal validation.

The home composition layer calculates one `businessDateKey` and injects it into:

- inventory action grouping and the `在库食材` unique-available count;
- today's meal selection and menu-plan `today` status shown on home;
- ingredient priority/action calculations reached from home.

This is not a repository-wide replacement of `todayKey()`. It is the consistency boundary for surfaces participating in this household action flow.

Pure date-key comparisons and `daysLeft` use calendar arithmetic based on parsed `YYYY-MM-DD` parts and `Date.UTC`, not local-midnight millisecond subtraction. This avoids 23/25-hour daylight-saving days on devices outside China.

A future `Family.timezone` field can replace the reference-date provider without changing the pure model contract.

## Loading, Empty, and Error States

### Loading

While inventory and ingredient data are boot-loading, retain the existing workspace loading state. Do not briefly show `0 种` before queries resolve.

### Empty

Recommended copy:

```text
今天没有急着处理的食材
4～7 天内的提醒仍可以在食材页查看。
```

If there are no later reminders either, use:

```text
当前库存状态平稳
```

### Errors

- Review/disposal errors keep the selection and chosen reminder date.
- Correction errors keep the entered date.
- Network failures do not optimistically remove the group.
- Conflict errors refresh before allowing retry.
- A conflict whose refreshed group disappeared closes the dialog with `这批库存已由家人处理`; a surviving group clears stale selection/confirmation state and requires review again.
- Success notices use the existing shared notice/toast system and remain below the mobile fixed header.

## Migration and Compatibility

- Add a new Alembic migration; do not modify older migrations.
- Existing rows receive `row_version=1` and null review/snooze fields and behave exactly as they do now until reviewed.
- Existing disposed or fully consumed rows remain excluded through remaining-quantity checks.
- Existing clients must receive the new non-null `row_version`; all in-repo inventory consumers and fixtures are updated together.
- The versioned `/dispose-expired` request is an atomic in-repository cutover. The backend schema, frontend client, existing home caller, existing ingredient caller, and row-version-bearing disposable view model must land in one verified slice. This phase does not add a temporary dual request protocol because no rolling multi-version client deployment is required.
- No household notification records are backfilled because no such entity is introduced.
- Existing browser-local dismissed background-task IDs remain valid.

## Scope

### Included

- ingredient inventory batches on the home action center;
- ingredient low-stock actions not already represented by shopping;
- ingredient-level grouping and top-three selection;
- expiry review/snooze persistence;
- strict versioned conflict detection for inventory batch actions;
- narrow expiry-date correction;
- same-ingredient batch disposal hardening;
- background-task badge/list cleanup;
- desktop and mobile home alignment;
- reuse of the same grouping rules in the ingredient priority area.

### Not included

- a unified household notification or read/unread table;
- email, SMS, WeChat, browser push, or scheduled push delivery;
- shopping due dates or shopping assignment;
- completed meal/activity cleanup;
- cross-ingredient one-click disposal;
- generic inventory-batch editing;
- AI-generated reminder text;
- ready-made `Food` stock expiry unification; that uses a different single-stock model and should be designed separately after this ingredient-batch rollout.
- persisted `已保留 N 次` counters, inventory cleanup, or a household stocktaking mode. Existing `expiry_reviewed_at` may communicate that a prior review occurred without adding another migration or reset rule.

## Copy and Boundary Contract

The shared model owns these representative strings so desktop and mobile do not invent separate meanings:

| Situation | Title | Detail example |
| --- | --- | --- |
| mixed expired/upcoming | `番茄需要处理` | `3 批已过期，2 批 3 天内到期` |
| today only | `牛奶今天到期` | `2 盒 · 冷藏` |
| low stock | `鸡蛋库存不足` | `现有 4 个，补货线 6 个` |
| prior retained review | `此前已确认暂时保留` | `原到期日仍保留，将于 7月14日再次提醒` |

Date buckets are exact:

| `daysLeft` | Bucket |
| --- | --- |
| `< 0` | `expired` |
| `0` | `expires_today` |
| `1..3` | `expires_soon` |
| `4..7` | `expires_later` |
| `> 7` | excluded |

Reminder controls and backend validation share `businessDate < snoozedUntil <= businessDate + 30 calendar days`. Custom-date `min` is tomorrow and `max` is the thirtieth day; presets use the same UTC-safe calendar-key helper.

## Acceptance Criteria

### Product behavior

- The top-right badge is zero when only successful background jobs exist.
- The top-right surface is labeled `后台任务` and contains no inventory or shopping reminders.
- Home renders no separate `临期优先处理` panel.
- Home renders at most three `今天要处理` ingredient groups.
- One ingredient appears at most once in the home action list.
- The home `需处理食材` stat equals the number of unique home-eligible action groups and never reads `inventoryAlertCount`/raw batch alerts.
- The home `在库食材` stat counts unique ingredients with positive, non-expired available inventory.
- Pending shopping and completed meals never appear in `今天要处理`.
- A low-stock ingredient already in the shopping list does not appear twice.
- Four-to-seven-day expiry groups do not take a top-three home slot but remain visible in the complete ingredient processing view.
- Temporarily retained batches keep their original expiry date, carry review attribution, and return when `expiry_alert_snoozed_until` arrives.
- Not-yet-expired postponed batches do not receive expired-food review attribution.
- Snooze changes reminder visibility only: expired batches remain excluded from normal consumption, recipe readiness, AI available-inventory summaries, and low-stock available quantity.
- Mixed expired/upcoming snooze requests are rejected without partial writes.
- Versioned review, correction, and disposal return 409 when any selected row changed after the dialog opened.
- Disposal and review reject mixed-family, mixed-ingredient, exhausted, or stale selections without partial writes.
- After success, the user may explicitly continue to the next different ingredient; a new low-stock state for the completed ingredient is offered separately.
- Quick restock resolves `ingredient_id` before any legacy exact-name fallback and never uses substring matching.
- Home action groups, today's meals/menu state, and ingredient priority actions use one injected `Asia/Shanghai` business date; pure day differences remain correct on devices in daylight-saving zones.
- After a 409 refresh, a surviving group requires a fresh selection; a disappeared group closes with an already-handled notice.

### Visual and accessibility behavior

- 375, 390, and 430 pixel mobile widths have no horizontal overflow.
- Mobile touch targets are at least 44 pixels for primary group actions and dialog controls.
- Expired, warning, low-stock, empty, and disabled states are distinguishable without relying only on color.
- Destructive confirmation clearly states scope and impact.
- The mobile processing dialog respects top/bottom safe areas and remains usable with long ingredient names.

### Verification expectations

- Backend API/service tests cover normal review, cross-family rejection, mixed-ingredient rejection, stale conflict, invalid date, activity logging, and transaction rollback.
- Migration upgrade/downgrade structure is inspected and upgrade is executed against the local MySQL database.
- Frontend pure-model tests cover grouping, snooze suppression, low-stock deduplication, ordering, top-three selection, and deterministic ties.
- Component tests cover background-task badge semantics and processing-dialog actions.
- Full frontend test and build pass.
- Mobile/responsive smoke covers the revised home action center and processing dialog.
- Smoke fixtures include the new inventory fields and at least two same-ingredient batches so grouping is exercised rather than only rendered.
- Full backend tests run because inventory contracts and activity logging change.
- A real MySQL two-session test proves that a stale dialog submission after a cook/dispose mutation returns a product conflict rather than a 500 or partial write.
- Acceptance fixtures include a representative messy test family with repeated batches, expired and upcoming rows for one ingredient, a future-snoozed row, legacy title-only shopping data, an ingredient-bound shopping row, and a substring-collision pair. Verification proves the complete priority area can process the data; it does not clean or rewrite real household data.

## Open Implementation Detail

The implementation plan fixes concrete file names against the current repository snapshot and chooses the migration revision after checking the Alembic head. If the repository moves before execution, update the plan explicitly rather than silently creating parallel hooks or services. Implementation must not change the confirmed product behavior or expand this feature into a general notification platform.
