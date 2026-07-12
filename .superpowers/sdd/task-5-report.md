# Task 5 Report: Shared Inventory Action Model and Business-Date Projection

## Status
Completed.

## Commit
`e4424bbf` — `feat(frontend): group household inventory actions`

## What landed
- Pure shared model: `frontend/src/features/inventory/inventoryActionModel.ts`
- Shanghai business date + UTC calendar helpers: `frontend/src/lib/date.ts`
- Home consumes prepared groups / unique available ingredients: `homeDashboardModel.ts`, `useAppHomeViewModel.ts`
- Ingredient workspace reuses shared action rules: `workspaceModel.ts`, `useIngredientWorkspaceData.ts`
- Shopping resolve hardened to id-first / exact-name only: `findShoppingIngredient`

## Tests
```bash
npm --prefix frontend run test -- inventoryActionModel.test.ts homeDashboardModel.test.ts workspaceModel.test.ts useAppHomeViewModel date.test.ts
```
7 files / 67 tests passed.

## Concerns
- Pre-Task-7 UI still has legacy todo/expiry panels; model returns empty todos and a temporary `inventoryAlerts` projection from home-eligible groups.
- `DASHBOARD_TODO_PAGE_SIZE` / `DashboardTodoItem` remain for existing hooks until Task 7.

## Review fix notes (Critical / Important)

### Critical — TDZ crash
- `useIngredientWorkspaceData.ts`: declare `priorityActionCount` before `workspaceMetrics` so metrics no longer read the const in the temporal dead zone.

### Important — catalog expired filter
- Stop matching Chinese title substrings (`已经过期`).
- Expiry alerts now carry `severity` from shared action groups.
- Catalog expired/expiring filters and card status use `severity === 'expired'` vs other expiry severities.
- Filter helpers exported from `workspaceModel.ts` for reuse/tests: `filterIngredientSummariesByCatalogStatus`.

### Important — actionableIngredientIds
- Wired into inventory quick filter `alerted` and mobile catalog `alerted` filter.
- Still returned from the hook for consumers.

### Verification
```bash
npm --prefix frontend run test -- inventoryActionModel.test.ts homeDashboardModel.test.ts workspaceModel.test.ts useAppHomeViewModel date.test.ts
npm --prefix frontend run typecheck
```
7 files / 69 tests passed; typecheck clean.

### Follow-up commit
`fix(ingredients): wire shared action groups without TDZ crash`

