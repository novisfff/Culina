# Unified Eating Information Architecture and Cook Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep the approved design open and stop if implementation would change a confirmed product decision.

**Goal:** Replace the split Food/Recipe/MealLog navigation with one five-entry, mobile-first “吃什么” workspace and make every successful REST or AI recipe completion atomically and idempotently create the exact MealLog, RecipeCookLog, inventory, plan, and activity results promised to the family.

**Architecture:** Introduce a pure navigation model plus a lightweight `EatWorkspace` composition boundary that reuses focused Food, Recipe, plan, Cook, and MealLog task surfaces without merging their domain models. On the backend, serialize every reference-changing path with the shared parent-first lock order, route REST and AI recipe completion through one canonical command/idempotency service, and deploy AI v2 through separate reader/executor, client capability, projection, compatible-frontend, and generator gates.

**Tech Stack:** React 18, TypeScript 5.7, React Query 5, Vitest, React Testing Library 16.3, user-event 14.6, jest-dom 6.6, Vite, Playwright smoke checks, FastAPI, Pydantic, SQLAlchemy 2, Alembic, MySQL, pytest, Culina AI tools/skills/workflow runtime.

**Approved design:** `docs/superpowers/specs/2026-07-12-unified-eating-information-architecture-design.md`

**Approved design SHA-256 at plan-writing time:** `5f2918e2990d461a8a97b5b91b75da570e47d9aca76c87d893df2d285d217144`

## Global Constraints

- PR 72 (`8d094f087f25a2661a15dc2dbab4b2d2761d9150`) and PR 73 (`81c4cb1e981004d2e159675d5f63dfa7127dff31`) were verified merged into `main` with every required check green on 2026-07-13. Task 0 still revalidates ancestry, checks, the merged PR 73 lock helper, and the migration head from the execution worktree so implementation never relies only on this plan-writing snapshot.
- The P0 third-item implementation is `docs/superpowers/plans/2026-07-12-home-household-highlights.md`. The two complete plans overlap 36 declared paths, including `frontend/src/App.tsx`, Home/query/cache contracts, Food/Family surfaces, Recipe/Meal APIs, AI operation contracts, shared tests, smoke, and responsive styles. Separate worktrees isolate uncommitted files but do not make those contracts independently mergeable.
- The only pre-agreed parallel window is Unified PR A Tasks 1–10 alongside Home Highlights Backend Tasks 1–3. Unified PR A must merge first; the Home branch then rebases onto that merged main, reruns its baseline plus affected navigation/Home tests, completes Home Tasks 4–15, and merges. Unified B1 must not start until the complete Home branch is merged.
- Execute PR A, merged Home Highlights, PR B1, PR B2-compatible-frontend, PR B2-generator, and PR C in that order. Each unit starts from the merged and green predecessor; do not keep long-lived parallel implementations of App/Home/Cook contracts. If the teams cannot stop exactly at the stated task boundaries, execute the two plans sequentially instead.
- Use project-native branches such as `feature/unified-eating-navigation`, `feature/cook-completion-backend`, `feature/cook-completion-experience`, and `chore/unified-eating-legacy-cleanup`; do not use a `codex/` prefix.
- Use `superpowers:using-git-worktrees` at execution time. Preserve every unrelated dirty or untracked file and never stage the approved spec or the existing inventory-reconciliation plan unless the user explicitly includes it in a later handoff.
- Do not introduce React Router, URL deep links, a generic navigation stack, MealLog history backfill, MealLog auto-merge, cross-device Cook Session synchronization, or an archive model in this phase.
- Desktop and mobile have exactly the same primary entries, labels, and order: `首页 / 吃什么 / 食材 / AI / 家庭`; internal keys are `home / eat / ingredients / ai / family`.
- “吃什么” has exactly three stable base views: `discover / plan / history`, shown to users as `发现 / 菜单 / 吃过的`.
- Food detail, Recipe target/detail/editor, plan detail, Cook, Meal create, and Meal detail are tasks inside `eat`; they are not primary workspaces and are never persisted as navigation snapshots.
- Navigation and Cook storage persist IDs and scalar state only. They never persist Food, Recipe, FoodPlanItem, MealLog, User, or Membership snapshots.
- Unknown, corrupt, or future navigation values must fall back safely. Unknown future Cook Session versions must be preserved and marked incompatible, not deleted.
- Recipe search always emits the same `recipe-target` on desktop and mobile. Resolution waits for Foods and Recipes queries and never picks an arbitrary relation or writes from a GET fallback.
- Food, Recipe, FoodPlanItem, and MealLog remain separate domain models. Food is the discover/plan/record object; Recipe is a self-made Food capability; MealLog is an already occurred meal.
- Only an explicit “加入菜单” or plan-create action creates a FoodPlanItem. Direct Cook from Discover, Food detail, Home, search, or AI never creates a plan item.
- Every successful recipe Cook creates a MealLog, one MealLogFood, and a RecipeCookLog. A plan-origin Cook also updates the same FoodPlanItem to `cooked` with the exact MealLog ID.
- Inventory deduction, MealLog, MealLogFood, RecipeCookLog, optional FoodPlanItem, ActivityLog, and completion result snapshot commit in one transaction; every failure rolls all of them back.
- Keep `create_meal_log` as a deprecated nullable compatibility field in B1/B2, ignore its value for REST completion semantics, and have the compatible frontend fixed-send `true`. Remove it only in PR C after the old-backend rollback window is closed.
- Keep `recipe_plan_item_id` as an input alias in B1/B2. New code sends only `food_plan_item_id`; remove the alias and `/api/recipe-plan` only in PR C after observed calls and pending clients are zero.
- B1 adds exactly one additive RecipeCookLog migration: nullable `completion_request_id`, `completion_request_hash`, `completion_result_json`, plus a family/request unique constraint. Do not backfill historical CookLogs and do not make historical `meal_log_id` non-null.
- New Cook Sessions and AI v2 always carry a stable completion request ID. Same ID plus same canonical command replays the first response; same ID plus different command returns `409 idempotency_key_reused`.
- Canonical completion hashing uses sorted-key compact JSON, UTF-8, ISO dates, normalized decimal strings, and sorted/deduplicated participant IDs. Deprecated aliases, transport-only values, and `replayed` never enter the hash.
- Persist completion results as `{ "version": 1, "response": { "recipe_id": "recipe-1", "consumed_items": [], "shortages": [], "meal_log_id": "meal-log-1", "cook_log_id": "cook-log-1" } }`; `replayed` is response-only and is not stored. Unknown result versions return `409 completion_result_version_unsupported` and never rerun side effects.
- The authoritative cross-type lock order is optional sorted Recipe, then sorted Ingredient, Food, IngredientInventoryState, InventoryItem, ShoppingListItem, and finally sorted FoodPlanItem. No path may acquire Food after FoodPlanItem, Ingredient after Food, or Recipe after an inventory/plan row.
- Recipe completion locks Recipe first, discovers candidates, calls merged PR 73 `lock_inventory_targets(...)` once for the complete inventory/Food set, validates the locked set, claims RecipeCookLog as the first write, then locks the optional plan item.
- All MealLogFood creation/replacement paths lock the complete sorted Food parent set before writing references. All participant IDs must resolve to active Memberships in the current family and active Users.
- All FoodPlanItem creation or Food rebind paths, including REST aliases and AI batch operations, pre-read the complete candidate set, lock all sorted Foods, then lock all sorted plan rows and revalidate the candidate set.
- AI batch plan operations never interleave locks in model-provided order. A changed candidate set returns `409 food_plan_targets_changed`; retry begins in a new transaction.
- Recipe deletion and its linked Food deletion first lock Recipe and sorted Food parents, then recheck RecipeCookLog, MealLogFood, and FoodPlanItem references. A reference returns `409 recipe_has_history` before media, search, or ORM deletion.
- Every family resource read/write is constrained by the current membership `family_id`; FoodPlanItem detail and mutations also require the current `user_id`. Cross-family and cross-user resources use the existing non-enumerating 404 style.
- Automatic MealLogs with valid date, meal type, and at least one valid Food are complete records. Photos, rating, notes, mood, and extra participants are optional enrichment and must not create “待处理/欠账” UI.
- Cook Session v3 and the active descriptor are namespaced by authenticated `user_id + family_id`; user/family switching never reads, overwrites, scans, or deletes another namespace.
- The v3 Cook keys are distinct from old v1/v2 keys. Migration is one-way only after Recipe/Food/optional plan ownership is verified, never overwrites an existing v3 session, and preserves the generated completion request ID across retry and compatible rollback.
- A namespace has at most one active Cook descriptor. Starting another Cook requires the explicit choice to continue the existing session or abandon it; stale-tab cleanup uses compare-before-delete so it cannot remove a newer descriptor.
- Direct sessions expire after 24 hours; plan sessions expire after 7 days. Completion failure preserves session and descriptor. Cleanup occurs only after success or safe replay with both MealLog and CookLog IDs present.
- AI B1 is an indivisible deploy baseline: persisted v1/v2 reader, normalizer, executor, generation gate, viewer gate, REST/SSE/history projector, public conversation-context projector, and message-metadata projector must be on every serving instance while generation remains v1.
- AI v1 with `createMealLog=true` enters the shared completion service. AI v1 with `createMealLog=false` returns a recoverable conflict and remains unexecuted. AI v2 has no `createMealLog` field anywhere.
- Generation capability is request/run scoped; viewer capability is current-request scoped. Never reuse the original creator’s capability when another household member reads a shared conversation.
- Compatible AI clients send `X-Culina-AI-Draft-Contracts: recipe_cook_operation.v1,recipe_cook_operation.v2` on chat, streams, history, conversation list/visibility, direct message mutations, pending approvals, retry, regenerate, human-input resume, and approval decision/continuation.
- Old viewers never receive editable canonical v2 commands from message parts, included drafts/approvals, message metadata, conversation context, pending responses, decision responses, run events, progressive SSE, or final SSE. Projection deep-copies response data and never changes canonical ORM JSON, hashes, or idempotency keys.
- `AIConversationOut.context` exposes only the explicit public allowlist used by the frontend, initially `activeRunId`. `fastApprovalDecisions` and all internal workflow payloads are private for every viewer.
- Client-aware normal responses use `Cache-Control: private, no-store` and `Vary: X-Culina-AI-Draft-Contracts`; SSE remains non-cacheable and each reconnect resends capability.
- B2 has two mandatory release units. First deploy a frontend that understands v1/v2 and sends capability while generation remains v1. Only after production verification may the generator manifest/tool/default/fixtures/eval switch to v2.
- If the deployment platform cannot promote frontend and generator independently, implement B2 as stacked PRs or independently promotable artifacts. Never enable v2 generation in the same unverified rollout that first introduces the compatible client.
- React Query keys stay in `frontend/src/api/queryKeys.ts`; mutation invalidation stays in `frontend/src/api/cacheInvalidation.ts`; APIs use the existing request client; storage uses `frontend/src/lib/storage.ts`.
- PR A adds `@testing-library/react@16.3.0`, `@testing-library/user-event@14.6.1`, and `@testing-library/jest-dom@6.6.3` as dev dependencies with one Vitest setup file. New or modified interaction tests in this plan use semantic queries and user-level events; do not bulk-migrate unrelated existing tests.
- UI work follows `frontend-ui-style` first and `frontend-ui-engineering` second: reuse current cards, drawers, `WorkspaceModal`, Cook UI, warm photo-driven styling, safe-area behavior, and at least 44px touch targets; do not redesign Culina.
- Add business-domain CSS under the existing style aggregation entry with an `eat-*` prefix. Do not add large inline style blocks or global unprefixed selectors.
- Every code task follows TDD: add a focused failing test, run it and observe the expected failure, make the smallest coherent implementation, rerun the focused test, run the task regression set, then commit only that task’s files.
- Each PR gets a spec-compliance review and a code-quality review before its release gate. Fix P0/P1 findings before proceeding; unresolved findings block the next PR.
- Final delivery reports every command actually run, including failures and whether each failure was pre-existing.

---

## Delivery Phases, Dependency Order, and Review Gates

```text
Merged PR 72 + merged PR 73
  Task 0
    ↓
Parallel window only:
  PR A — unified information architecture: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
  Home Highlights backend-only: Tasks 1 → 2 → 3
    ↓
Merge PR A; rebase Home Highlights; complete Home Tasks 4–15; merge Home Highlights
    ↓
PR B1 — compatible consistency and completion foundation; generator stays v1
  11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21
    ↓
PR B2 release unit 1 — compatible Cook/AI frontend
  22 → 23 → 24 → 25 → production client gate
    ↓
PR B2 release unit 2 — AI v2 generation
  26 → production generator gate
    ↓
Compatibility observation window
    ↓
PR C — bounded legacy cleanup
  27 → 28
```

- Across both plans, tasks that modify `frontend/src/App.tsx`, `frontend/src/app/useAppWorkspaceQueries.ts`, `frontend/src/api/types.ts`, `frontend/src/api/queryKeys.ts`, `frontend/src/api/cacheInvalidation.ts`, Home/Food/Family surfaces, shared responsive styles, `backend/app/models/domain.py`, Recipe/Meal APIs, AI operation contracts, or shared test fixtures execute sequentially after the bounded parallel window.
- Task 10 is the PR A release gate. Task 21 is the complete B1 deployment gate. Task 25 is the compatible-client gate. Task 26 is the generator gate. Task 28 is the final release gate.
- B1 may contain small reviewable commits, but no B1 commit is production-complete until Tasks 11–21 are together. In particular, reader/executor without generation/projection gates is not deployable.
- During B1 production cutover, pause REST Recipe deletion and AI `recipe.delete` approval execution, drain old instances, migrate, deploy the complete B1 baseline everywhere, verify parent-lock protocols, then reopen deletion.
- During B2, deploy Task 25’s compatible frontend and verify Service Worker adoption before promoting Task 26’s generator. Turning the generator flag/version back to v1 never removes the B1 reader/executor/projector baseline.

## File Responsibility Map

### Create: frontend

- `frontend/src/app/appNavigationModel.ts` — navigation types, semantic target reduction, persistence parser/migration, and query-scope derivation.
- `frontend/src/app/appNavigationModel.test.ts` — reducer, old-storage migration, corrupt input, target, and query-scope matrix.
- `frontend/src/app/useAppNavigationState.ts` — React lifecycle, persistence, semantic navigation, close/select actions, and focus restoration registration.
- `frontend/src/app/useAppNavigationState.test.tsx` — hook persistence, non-persisted task, close, and trigger-focus behavior.
- `frontend/src/test/setup.ts` — shared React Testing Library cleanup and `jest-dom` matchers for Vitest.
- `frontend/src/app/useAppHomeHandlers.test.ts` — semantic Home action coverage introduced when PR 72 handlers are migrated to the navigation service.
- `frontend/src/features/eat/EatWorkspaceViewModel.ts` — ID-only Recipe/plan/meal task resolution and loading/not-found/relation-error states.
- `frontend/src/features/eat/EatWorkspaceViewModel.test.ts` — Recipe relation, plan detail, exact MealLog, and conflict resolution cases.
- `frontend/src/features/eat/EatWorkspace.tsx` — `发现 / 菜单 / 吃过的` composition, task rendering, state boundaries, focus target, and responsive shell.
- `frontend/src/features/eat/EatWorkspace.test.tsx` — tab semantics, task close/return, loading/error/empty states, and active Cook resume entry.
- `frontend/src/components/foods/FoodDiscoverSurface.tsx` — shell-free Food discovery presentation extracted from FoodWorkspace.
- `frontend/src/components/foods/FoodPlanSurface.tsx` — shell-free weekly FoodPlan presentation and task launch callbacks.
- `frontend/src/api/foodsApi.test.ts` — FoodPlanItem detail transport coverage for the new scoped endpoint.
- `frontend/src/components/recipes/RecipeTaskSurface.tsx` — Recipe read/edit/Cook task composition without a primary Recipe library shell.
- `frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts` — source-boundary coverage proving task surfaces do not restore the legacy Recipe library shell.
- `frontend/src/features/meals/MealHistorySurface.tsx` — shell-free valid-meal timeline, detail, create, and optional enrichment presentation.
- `frontend/src/components/recipes/recipeCookSessionStorage.ts` — scoped v3 key builders, parser, descriptor, TTL, compare-delete, and verified legacy migration.
- `frontend/src/components/recipes/recipeCookSessionStorage.test.ts` — cross-user/family, migration, future version, expiry, and stale-tab cleanup coverage.
- `frontend/src/features/eat/ActiveCookResumeCard.tsx` — compact current-namespace “继续做菜” entry.
- `frontend/src/features/eat/ActiveCookResumeCard.test.tsx` — resume, abandon, missing entity, and accessible action coverage.
- `frontend/src/styles/12-eat-workspace.css` — `eat-*` workspace/task/responsive styling.

### Modify: frontend

- `frontend/src/app/AppShell.tsx`, `frontend/src/app/AppShell.test.tsx` — one shared five-entry primary navigation source for desktop/mobile.
- `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts` — React Testing Library, user-event, jest-dom, and the shared Vitest setup file.
- `frontend/src/App.tsx` — replace active-tab/request-ID eating orchestration with navigation service and one EatWorkspace render branch.
- `frontend/src/app/useAppWorkspaceQueries.ts` — use `AppQueryScope` and add scoped FoodPlan detail query.
- `frontend/src/app/useAppGlobalSearchNavigation.ts`, `frontend/src/app/useAppGlobalSearchNavigation.test.tsx` — device-independent semantic targets.
- `frontend/src/app/useAppHomeHandlers.ts`, `frontend/src/app/useAppHomeViewModel.ts`, `frontend/src/app/useAppHomeViewModel.test.ts` — PR 72 action-center semantic targets and direct/plan Cook contexts.
- `frontend/src/components/foods/FoodWorkspace.tsx`, `frontend/src/components/foods/FoodWorkspace.test.ts`, `frontend/src/components/foods/FoodWorkspaceUsage.test.ts`, `frontend/src/components/foods/FoodWorkspaceModel.ts`, `frontend/src/components/foods/useFoodWorkspaceState.ts` — extract discovery/plan/task surfaces and remove implicit plan creation for direct Cook.
- `frontend/src/components/foods/FoodHubView.tsx`, `frontend/src/components/foods/FoodMobileView.tsx` — embedded “发现” copy/layout without a second primary shell.
- `frontend/src/components/foods/FoodQuickMealDialog.tsx`, `frontend/src/components/foods/FoodQuickMealDialog.test.tsx` — Cook date, meal type, servings, and direct launch context.
- `frontend/src/components/recipes/RecipeWorkspace.tsx`, `frontend/src/components/recipes/RecipeWorkspace.test.ts`, `frontend/src/components/recipes/useRecipeWorkspaceData.ts`, `frontend/src/components/recipes/workspaceModel.ts`, `frontend/src/components/recipes/workspaceModel.test.ts` — retain task abilities while deleting the independent Recipe primary shell and legacy plan UI reachability.
- `frontend/src/components/recipes/RecipeWorkspaceModel.ts`, `frontend/src/components/recipes/useRecipeCookState.ts`, `frontend/src/components/recipes/workspaceModel.test.ts` — v3 session state, stable completion ID, explicit source, and safe persistence.
- `frontend/src/components/recipes/RecipeCookFinishDialog.tsx`, `frontend/src/components/recipes/RecipeCookFinishDialog.test.tsx` — remove record toggle and enforce exact success semantics.
- `frontend/src/components/recipes/RecipeCookView.tsx` — active descriptor synchronization, non-blocking errors, exact MealLog success action, and live-region status.
- `frontend/src/features/meals/MealLogWorkspace.tsx`, `frontend/src/features/meals/MealLogMobileView.tsx`, `frontend/src/features/meals/MealLogWorkspaceModel.ts`, `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`, `frontend/src/features/meals/MealLogWorkspaceUsage.test.ts` — valid-record-first language and task surfaces.
- `frontend/src/features/family/FamilySettings.tsx`, `frontend/src/features/family/FamilySettings.test.tsx` — history semantic target.
- `frontend/src/components/ai/AiResultCards.tsx`, `frontend/src/components/ai/AiResultCards.test.tsx`, `frontend/src/components/ai/AiApprovalPanel.tsx`, `frontend/src/components/ai/AiApprovalPanel.test.tsx` — semantic Food/Recipe/plan/Meal targets and v1/v2-safe recipe-cook approval display.
- `frontend/src/api/foodsApi.ts` — FoodPlanItem detail transport.
- `frontend/src/api/recipesApi.ts`, `frontend/src/api/client.test.ts` — compatible Cook completion payload/response and bounded Recipe-plan alias removal.
- `frontend/src/api/aiApi.ts`, `frontend/src/api/aiApi.test.ts` — one AI capability header wrapper for normal and streaming calls.
- `frontend/src/api/types.ts`, `frontend/src/api/queryKeys.ts`, `frontend/src/api/queryKeys.test.ts`, `frontend/src/api/cacheInvalidation.ts`, `frontend/src/api/cacheInvalidation.test.ts` — cross-stack navigation, plan detail, Cook, and AI contracts/cache.
- `frontend/src/styles.css`, `frontend/src/styles/03-recipe-workspace.css`, `frontend/src/styles/04-ingredients-workspace.css`, `frontend/src/styles/05-workspace-overlays.css`, `frontend/src/styles/06-food-workspace.css`, `frontend/src/styles/07-mobile.css`, `frontend/src/styles/08-meal-log.css` — aggregate the new sheet and remove only source-scan-proven obsolete shell rules in PR C.
- `frontend/scripts/smoke.mjs`, `frontend/scripts/ai-skill-manual-smoke.mjs` — desktop/mobile/tablet acceptance paths, old storage, direct/plan Cook, resume, exact MealLog, search targets, and final AI v2 smoke payloads.

### Delete: frontend in PR C

- `frontend/src/components/recipes/RecipePlanDialogs.tsx`, `frontend/src/components/recipes/RecipePlanDialogs.test.tsx`, `frontend/src/components/recipes/useRecipePlanState.ts` — remove the expired Recipe-plan alias UI only after the zero-use gate.
- `frontend/src/components/recipes/RecipeLibraryView.tsx`, `frontend/src/components/recipes/RecipeMobileLibraryView.tsx` — remove the unreachable legacy Recipe primary library views after EatWorkspace is the only supported entry.

### Create: backend

- `backend/alembic/versions/4f5a6b7c8d9e_add_recipe_cook_completion_idempotency.py` — additive nullable completion fields and unique family/request constraint; `down_revision` is set to Task 0’s actual single head.
- `backend/app/services/meal_log_references.py` — sorted Food parent locks, duplicate/non-empty Food validation, and active family participant validation.
- `backend/app/services/food_plan_locking.py` — whole-request FoodPlan candidate discovery, `Food → FoodPlanItem` locking, stale/completed conflicts, and post-lock revalidation.
- `backend/app/services/recipe_deletion.py` — shared Recipe/Food parent locks, history guard, and post-guard delete orchestration for REST/AI.
- `backend/app/services/recipe_cook_completion.py` — canonical command/hash, claim/replay, global locks, inventory application, MealLog/CookLog/plan/activity transaction, and result envelope.
- `backend/app/ai/draft_contracts.py` — accepted/generated recipe-cook versions, capability parsing, generation selection, and upgrade errors.
- `backend/app/api/ai_contracts.py` — FastAPI header dependency, request-scoped capabilities, cache headers, and decision/pending gates.
- `backend/app/services/ai_client_projection.py` — deep-copy public projection for conversations, messages, metadata, chat responses, approvals, events, and SSE data.
- `backend/tests/meal_logs/__init__.py` — MealLog test package marker.
- `backend/tests/meal_logs/test_meal_logs.py` — shared reference, plan-origin completion, exact ID, and atomic rollback tests.
- `backend/tests/ai_infra/test_ai_draft_contracts.py` — v1/v2 normalization/execution/generation gate and rollout-probe tests.
- `backend/tests/ai_infra/test_ai_client_projection.py` — old/new viewer coverage for every public DTO and stream boundary.

### Modify: backend

- `backend/app/models/domain.py`, `backend/app/schemas/recipes.py`, `backend/app/services/serializers.py` — RecipeCookLog completion fields and compatible request/response shape.
- `backend/app/api/recipe_meta.py`, `backend/app/schemas/recipes.py` — scoped FoodPlanItem detail and shared plan parent locks for REST and alias endpoints.
- `backend/app/api/meal_logs.py`, `backend/app/schemas/meal_logs.py` — shared reference validation and atomic non-Recipe plan completion fields.
- `backend/app/services/ai_operations/meal_logs.py` — shared Food/participant references for AI MealLog writes.
- `backend/app/services/ai_operations/meal_plans.py` — whole-batch candidate discovery and stable parent-first locks.
- `backend/app/api/recipes.py`, `backend/app/services/ai_operations/recipe_cook.py` — thin REST/AI completion adapters.
- `backend/app/services/ai_operations/recipes.py` — shared Recipe deletion guard.
- `backend/app/services/ai_operations/registry_types.py`, `backend/app/services/ai_operations/executor.py`, `backend/app/services/ai_operations/approval_decisions.py`, `backend/app/services/ai_operations/draft_specs/recipes.py`, `backend/app/services/ai_operations/draft_specs/common.py`, `backend/app/services/ai_operations/draft_specs/composite.py` — operation idempotency context, retry/child key reuse, dual-version routing, and always-record approval copy.
- `backend/app/ai/tools/base.py`, `backend/app/ai/tools/draft_validation.py`, `backend/app/ai/tools/schemas.py`, `backend/app/ai/tools/catalog/recipe.py` — request-scoped generation capability, separated persisted/generator schemas, and version-aware normalization.
- `backend/app/ai/workspace_service.py`, `backend/app/ai/workflows/state.py`, `backend/app/ai/workflows/runner.py`, `backend/app/ai/workflows/runner_support/graph_state_builder.py`, `backend/app/ai/workflows/runner_support/orchestrator_context.py` — generation capability propagation for initial, retry, regenerate, human-input, and approval-continuation execution.
- `backend/app/api/ai.py`, `backend/app/schemas/ai.py` — capability dependency, public projection, structured upgrade conflicts, and cache headers for normal/SSE routes.
- `backend/app/ai/skills/catalog/recipe-cook/SKILL.md`, `backend/app/ai/skills/catalog/recipe-cook/skill.yaml` — v2 generation semantics only at Task 26.
- `backend/tests/ai_evals/cases/core.jsonl`, `backend/tests/ai_evals/test_eval_dataset.py`, `backend/tests/ai_evals/test_skill_scenarios.py`, `backend/tests/ai_infra/_support.py`, `backend/tests/ai_infra/test_foundation.py`, `backend/tests/ai_infra/test_inventory_operations.py` — v2 eval cases and exact fake/scripted provider fixtures used during generator cutover and PR C cleanup.
- `backend/tests/recipes/test_recipe_cooking.py`, `backend/tests/recipes/test_recipe_crud.py`, `backend/tests/recipes/test_recipe_discovery.py`, `backend/tests/recipes/test_food_workspace.py` — REST completion, deletion lifecycle, plan detail/locks, and compatibility.
- `backend/tests/inventory/test_inventory_mysql_concurrency.py` — real two-connection Cook/inventory/plan/delete races using the merged PR 73 barrier fixture.
- `backend/tests/ai_infra/test_workspace_approvals.py`, `backend/tests/ai_infra/test_workspace_chat.py`, `backend/tests/ai_infra/test_workspace_streaming.py`, `backend/tests/ai_infra/test_registry_and_metrics.py` — B1/B2 mixed-version and public projection regressions.
- `docs/plans/ai-skill-optimization-notes.md` — remove the old optional MealLog rule when Task 26 switches generation to v2.

---


## Task 0: Establish the Merged Baseline and Implementation Order

**Files:** No product-file changes.

**Interfaces:**

- Consumes: merged PR 72, merged PR 73, the approved design hash above, and the current Home Highlights branch/task status.
- Produces: revalidated merge/check evidence, one real Alembic head, the merged `lock_inventory_targets(...)` signature/order, the bounded Home/Unified execution schedule, green baseline commands, and an isolated `feature/unified-eating-navigation` worktree.

- [ ] **Step 1: Re-read execution instructions and inspect all existing worktree state**

Use `superpowers:using-git-worktrees` before creating the implementation worktree. From the original checkout run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git worktree list --porcelain
```

Expected: all pre-existing modified/untracked paths are recorded verbatim; no file is staged or changed by this step. Do not reuse the plan-writing checkout for product implementation.

- [ ] **Step 2: Prove PR 72 and PR 73 are merged and green**

```bash
gh pr view 72 --json number,state,mergedAt,mergeCommit,statusCheckRollup,baseRefName,headRefName
gh pr view 73 --json number,state,mergedAt,mergeCommit,statusCheckRollup,baseRefName,headRefName
git fetch origin --prune
git merge-base --is-ancestor "$(gh pr view 72 --json mergeCommit --jq .mergeCommit.oid)" origin/main
git merge-base --is-ancestor "$(gh pr view 73 --json mergeCommit --jq .mergeCommit.oid)" origin/main
```

Expected: both PRs report `state=MERGED`; merge commits are respectively `8d094f087f25a2661a15dc2dbab4b2d2761d9150` and `81c4cb1e981004d2e159675d5f63dfa7127dff31`; every required check is successful; and both ancestry checks exit 0. These values were verified on 2026-07-13 but must still be refreshed at execution time. Any failure blocks Task 1; do not reconstruct PR 72/73 changes inside this feature.

- [ ] **Step 3: Verify the approved spec has not changed silently**

```bash
shasum -a 256 docs/superpowers/specs/2026-07-12-unified-eating-information-architecture-design.md
```

Expected: `5f2918e2990d461a8a97b5b91b75da570e47d9aca76c87d893df2d285d217144`. If it differs, review the diff against this plan and update the plan/spec mapping before implementation.

- [ ] **Step 4: Inspect Home execution state and create the PR A worktree from current main**

First inspect the sibling plan and worktree without editing them:

```bash
git worktree list --porcelain
git log --oneline origin/main..feature/home-household-highlights
git diff --name-only origin/main...feature/home-household-highlights
```

Expected at plan revision time: Home Task 1 has commit `39c2f57d`; refresh this evidence because that branch may have advanced. If Home has moved beyond Task 3, or has begun any frontend work, do not start PR A concurrently: wait for Home to merge, then create PR A from the new main.

Otherwise use the worktree skill to create `feature/unified-eating-navigation` from freshly fast-forwarded `origin/main`. Then run:

```bash
git branch --show-current
git merge-base --is-ancestor origin/main HEAD
git status --short
```

Expected: branch is `feature/unified-eating-navigation`, `origin/main` is an ancestor, and the new worktree is clean. The Home worktree remains untouched.

- [ ] **Step 5: Record the bounded Home/Unified ownership and merge order**

Write the following fixed coordination contract into both PR descriptions before editing overlapping contracts:

```text
Parallel work is limited to Unified Tasks 1–10 and Home Backend Tasks 1–3.
PR A merges first.
Home rebases onto merged PR A, reruns baseline/navigation/Home tests, completes Tasks 4–15, and merges.
Unified B1 starts from main only after Home is merged.
```

Expected: task ownership is visible to both implementers. Home does not start Task 4 while PR A is unmerged; Unified does not start Task 11 while Home is unmerged. If either boundary has already been crossed, stop parallel execution and serialize by merging/rebasing one complete branch before continuing the other.

- [ ] **Step 6: Capture the merged lock and migration contracts**

```bash
rg -n "def lock_inventory_targets|Order: Ingredient|food_ids|state_ingredient_ids|inventory_item_ids|shopping_item_ids" backend/app/services/inventory_operation_locking.py
cd backend && ./.venv/bin/alembic heads
```

Expected: one Alembic head and one helper whose current order is `Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem`. If the merged signature/order differs, update Tasks 12–21 consistently before any lock-path code is written.

- [ ] **Step 7: Run the cross-stack baseline**

```bash
npm --prefix frontend run test
npm --prefix frontend run build
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_food_workspace.py \
  tests/inventory/test_inventory_versions.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py -q
```

Expected: PASS. Record any failure verbatim and resolve it on the owning prerequisite branch before Task 1; do not classify an unexplained red baseline as this feature’s acceptable starting state.

## PR A — Unified Information Architecture

## Task 1: Add the Pure Navigation, Persistence, and Query-Scope Model

**Files:**

- Create: `frontend/src/app/appNavigationModel.ts`
- Create: `frontend/src/app/appNavigationModel.test.ts`

**Interfaces:**

- Consumes: `MealType` from `frontend/src/api/types.ts`; the confirmed five primary keys, three Eat base views, and task/target types from the design.
- Produces: `PrimaryTabKey`, `EatBaseView`, `CookLaunchContext`, `MealCreateSource`, `EatTask`, `AppNavigationState`, `AppNavigationTarget`, `AppQueryScope`, `initialNavigationState`, `reduceNavigation`, `parsePersistedNavigation`, `migrateLegacyNavigation`, `persistedNavigationFromState`, and `deriveAppQueryScope`.

- [ ] **Step 1: Write failing navigation and migration tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveAppQueryScope,
  migrateLegacyNavigation,
  parsePersistedNavigation,
  reduceNavigation,
} from './appNavigationModel';

describe('appNavigationModel', () => {
  it.each([
    ['foods', 'discover', 'all'],
    ['recipes', 'discover', 'selfMade'],
    ['logs', 'history', 'all'],
  ] as const)('migrates %s without restoring a task', (legacy, baseView, discoverSection) => {
    expect(migrateLegacyNavigation(legacy)).toMatchObject({
      primaryTab: 'eat',
      eat: { baseView, discoverSection, task: null },
    });
  });

  it('falls back to home for corrupt v2 input', () => {
    expect(parsePersistedNavigation('{bad json')).toMatchObject({ primaryTab: 'home' });
  });

  it('opens and closes a direct Cook task with its explicit launch context', () => {
    const opened = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: {
        workspace: 'eat',
        view: 'cook',
        foodId: 'food-1',
        recipeId: 'recipe-1',
        launchContext: {
          date: '2026-07-13',
          mealType: 'lunch',
          servings: 3,
          source: { kind: 'direct' },
        },
      },
    });
    expect(opened.eat.task).toMatchObject({ kind: 'cook', returnTo: 'discover' });
    expect(reduceNavigation(opened, { type: 'close-task' }).eat.task).toBeNull();
  });

  it('derives plan-detail queries without enabling discovery recommendations', () => {
    const state = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'plan', foodPlanItemId: 'plan-1' },
    });
    expect(deriveAppQueryScope(state)).toMatchObject({
      needsFoodPlan: true,
      needsFoodPlanDetail: true,
      needsFoods: true,
      needsRecipes: true,
      needsMealLogs: true,
      needsFoodRecommendations: false,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

```bash
npm --prefix frontend run test -- appNavigationModel
```

Expected: FAIL because `./appNavigationModel` does not exist.

- [ ] **Step 3: Implement the exact public navigation contracts**

```ts
import type { MealType } from '../api/types';

export type PrimaryTabKey = 'home' | 'eat' | 'ingredients' | 'ai' | 'family';
export type EatBaseView = 'discover' | 'plan' | 'history';

export type CookLaunchContext = {
  date: string;
  mealType: MealType;
  servings: number;
  source:
    | { kind: 'direct' }
    | { kind: 'plan'; foodPlanItemId: string; planItemBaseUpdatedAt: string };
};

export type MealCreateSource =
  | { kind: 'direct' }
  | { kind: 'plan'; foodPlanItemId: string; planItemBaseUpdatedAt: string };

export type EatTask =
  | { kind: 'food-detail'; foodId: string; returnTo: EatBaseView }
  | { kind: 'recipe-target'; recipeId: string; mode: 'view' | 'edit'; returnTo: EatBaseView }
  | { kind: 'recipe'; foodId: string; recipeId: string; mode: 'view' | 'edit'; returnTo: EatBaseView }
  | { kind: 'plan-detail'; foodPlanItemId: string; returnTo: 'plan' }
  | { kind: 'cook'; foodId: string; recipeId: string; launchContext: CookLaunchContext; returnTo: EatBaseView }
  | { kind: 'meal-create'; source: MealCreateSource; foodId?: string; date?: string; mealType?: MealType; returnTo: EatBaseView }
  | { kind: 'meal-detail'; mealLogId: string; returnTo: EatBaseView };

export type AppNavigationState = {
  primaryTab: PrimaryTabKey;
  eat: { baseView: EatBaseView; task: EatTask | null; discoverSection: 'all' | 'selfMade' };
};

export type AppNavigationTarget =
  | { workspace: 'home' | 'ingredients' | 'ai' | 'family' }
  | { workspace: 'eat'; view: 'discover'; section?: 'all' | 'selfMade' }
  | { workspace: 'eat'; view: 'food'; foodId: string }
  | { workspace: 'eat'; view: 'recipe'; recipeId: string; mode?: 'view' | 'edit' }
  | { workspace: 'eat'; view: 'plan'; foodPlanItemId?: string }
  | { workspace: 'eat'; view: 'history'; mealLogId?: string }
  | { workspace: 'eat'; view: 'cook'; foodId: string; recipeId: string; launchContext: CookLaunchContext }
  | { workspace: 'eat'; view: 'meal-create'; source: MealCreateSource; foodId?: string; date?: string; mealType?: MealType };
```

Add an exhaustive reducer that closes the current task on primary/base-view changes, stores the current base view as `returnTo`, and never creates a generic stack. Add a runtime validator for `culina-navigation-v2` with this persisted shape:

```ts
export type PersistedNavigationV2 = {
  version: 2;
  primaryTab: PrimaryTabKey;
  eatBaseView: EatBaseView;
  discoverSection?: 'all' | 'selfMade';
};

export const initialNavigationState: AppNavigationState = {
  primaryTab: 'home',
  eat: { baseView: 'discover', task: null, discoverSection: 'all' },
};
```

Implement `AppQueryScope` with all fields named in the design and one exhaustive target matrix. Its derivation is pure and must not inspect viewport width.

- [ ] **Step 4: Run focused model tests**

```bash
npm --prefix frontend run test -- appNavigationModel
```

Expected: PASS, including legacy `foods/recipes/logs`, corrupt/unknown fallback, task close, direct/plan sources, persistence without task IDs, and every query-scope row.

- [ ] **Step 5: Commit the pure model**

```bash
git add frontend/src/app/appNavigationModel.ts frontend/src/app/appNavigationModel.test.ts
git commit -m "feat: add unified eating navigation model"
```

## Task 2: Add React Interaction Test Infrastructure and Connect Navigation Safely

**Files:**

- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/app/useAppNavigationState.ts`
- Create: `frontend/src/app/useAppNavigationState.test.tsx`

**Interfaces:**

- Consumes: Task 1 `AppNavigationState`, `AppNavigationTarget`, reducer/parser, and `PersistedNavigationV2`.
- Produces: the shared Vitest React Testing Library setup; `AppNavigationService` with `state`, `navigate(target, trigger?)`, `selectEatView(view, trigger?)`, `closeTask()`, `registerTaskHeading(element)`, and `registerBaseViewFocusTarget(element)`; storage keys `culina-navigation-v2` and legacy `culina-active-tab`.

- [ ] **Step 1: Install and configure the shared interaction-test stack**

```bash
npm --prefix frontend install --save-dev \
  @testing-library/react@16.3.0 \
  @testing-library/user-event@14.6.1 \
  @testing-library/jest-dom@6.6.3
```

Add the setup file:

```ts
// frontend/src/test/setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

Register it once in `frontend/vite.config.ts` while preserving the current coverage policy:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts'],
    },
  },
});
```

Do not migrate unrelated existing tests in this task. New or modified interaction tests in this plan use `render`, `renderHook`, semantic queries, `userEvent`, and `jest-dom`; pure model tests remain plain Vitest.

- [ ] **Step 2: Write failing hook tests for migration, persistence, and post-commit focus**

```tsx
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

it('migrates a legacy recipe tab but persists no task', () => {
  writeStringStorage('culina-active-tab', 'recipes');
  const { result } = renderHook(() => useAppNavigationState());
  expect(result.current.state.eat).toMatchObject({ baseView: 'discover', discoverSection: 'selfMade', task: null });
  act(() => result.current.navigate({ workspace: 'eat', view: 'recipe', recipeId: 'recipe-1' }));
  expect(JSON.parse(readStringStorage('culina-navigation-v2', '{}'))).toEqual({
    version: 2,
    primaryTab: 'eat',
    eatBaseView: 'discover',
    discoverSection: 'selfMade',
  });
});

function NavigationFocusHarness({ detachTriggerOnOpen = false }: { detachTriggerOnOpen?: boolean }) {
  const navigation = useAppNavigationState();
  return (
    <>
      {!detachTriggerOnOpen || !navigation.state.eat.task ? (
        <button
          type="button"
          onClick={(event) => navigation.navigate(
            { workspace: 'eat', view: 'food', foodId: 'food-1' },
            event.currentTarget,
          )}
        >
          打开家常菜
        </button>
      ) : null}
      <section
        ref={navigation.registerBaseViewFocusTarget}
        tabIndex={-1}
        aria-label="发现列表"
      >
        发现
      </section>
      {navigation.state.eat.task ? (
        <section role="dialog" aria-label="家常菜任务">
          <h2 ref={navigation.registerTaskHeading} tabIndex={-1}>家常菜详情</h2>
          <button type="button" onClick={navigation.closeTask}>关闭任务</button>
        </section>
      ) : null}
    </>
  );
}

it('focuses the committed task heading and restores the trigger after close', async () => {
  const user = userEvent.setup();
  render(<NavigationFocusHarness />);
  const trigger = screen.getByRole('button', { name: '打开家常菜' });

  await user.click(trigger);
  expect(screen.getByRole('heading', { name: '家常菜详情' })).toHaveFocus();

  await user.click(screen.getByRole('button', { name: '关闭任务' }));
  expect(trigger).toHaveFocus();
});

it('restores the base view when an overlay trigger has unmounted', async () => {
  const user = userEvent.setup();
  render(<NavigationFocusHarness detachTriggerOnOpen />);
  await user.click(screen.getByRole('button', { name: '打开家常菜' }));
  await user.click(screen.getByRole('button', { name: '关闭任务' }));
  expect(screen.getByRole('region', { name: '发现列表' })).toHaveFocus();
});
```

- [ ] **Step 3: Run the hook test and verify the missing-export failure**

```bash
npm --prefix frontend run test -- useAppNavigationState
```

Expected: FAIL because `useAppNavigationState` is not defined.

- [ ] **Step 4: Implement lifecycle, persistence, and commit-aware focus without task snapshots**

```ts
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

export type AppNavigationService = {
  state: AppNavigationState;
  navigate: (target: AppNavigationTarget, trigger?: HTMLElement | null) => void;
  selectEatView: (view: EatBaseView, trigger?: HTMLElement | null) => void;
  closeTask: () => void;
  registerTaskHeading: (element: HTMLElement | null) => void;
  registerBaseViewFocusTarget: (element: HTMLElement | null) => void;
};

type FocusIntent = 'task' | 'restore' | null;

function targetOpensEatTask(target: AppNavigationTarget): boolean {
  if (target.workspace !== 'eat') return false;
  if (target.view === 'food' || target.view === 'recipe' || target.view === 'cook' || target.view === 'meal-create') {
    return true;
  }
  if (target.view === 'plan') return Boolean(target.foodPlanItemId);
  if (target.view === 'history') return Boolean(target.mealLogId);
  return false;
}

function focusWithoutScroll(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

export function useAppNavigationState(): AppNavigationService {
  const triggerRef = useRef<HTMLElement | null>(null);
  const taskHeadingRef = useRef<HTMLElement | null>(null);
  const baseViewFocusTargetRef = useRef<HTMLElement | null>(null);
  const focusIntentRef = useRef<FocusIntent>(null);
  const [state, dispatch] = useReducer(reduceNavigation, undefined, restoreNavigationState);

  useEffect(() => {
    writeJsonStorage('culina-navigation-v2', persistedNavigationFromState(state));
  }, [state.primaryTab, state.eat.baseView, state.eat.discoverSection]);

  const navigate = useCallback((target: AppNavigationTarget, trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null;
    focusIntentRef.current = targetOpensEatTask(target) ? 'task' : null;
    dispatch({ type: 'navigate', target });
  }, []);

  const closeTask = useCallback(() => {
    focusIntentRef.current = 'restore';
    dispatch({ type: 'close-task' });
  }, []);

  const selectEatView = useCallback((view: EatBaseView, trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null;
    focusIntentRef.current = state.eat.task ? 'restore' : null;
    dispatch({ type: 'select-eat-view', view });
  }, [state.eat.task]);

  const registerTaskHeading = useCallback((element: HTMLElement | null) => {
    taskHeadingRef.current = element;
    if (element && focusIntentRef.current === 'task') {
      focusWithoutScroll(element);
      focusIntentRef.current = null;
    }
  }, []);

  const registerBaseViewFocusTarget = useCallback((element: HTMLElement | null) => {
    baseViewFocusTargetRef.current = element;
    if (element && focusIntentRef.current === 'restore' && !triggerRef.current?.isConnected) {
      focusWithoutScroll(element);
      triggerRef.current = null;
      focusIntentRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (focusIntentRef.current === 'task' && state.eat.task && taskHeadingRef.current) {
      focusWithoutScroll(taskHeadingRef.current);
      focusIntentRef.current = null;
      return;
    }
    if (focusIntentRef.current !== 'restore' || state.eat.task) return;
    const trigger = triggerRef.current;
    const target = trigger?.isConnected ? trigger : baseViewFocusTargetRef.current;
    if (!target) return;
    focusWithoutScroll(target);
    triggerRef.current = null;
    focusIntentRef.current = null;
  }, [state.eat.task]);

  return {
    state,
    navigate,
    selectEatView,
    closeTask,
    registerTaskHeading,
    registerBaseViewFocusTarget,
  };
}
```

Use the existing `readJsonStorage`, `writeJsonStorage`, `readStringStorage`, and `writeStringStorage` wrappers from `frontend/src/lib/storage.ts`; no storage-helper change is required. Do not remove or overwrite the legacy key in PR A.

The callback ref handles a task heading that appears after a loading state; the layout effect handles a heading already attached in the same commit. Closing focuses the still-connected trigger, otherwise the registered base-view container. Do not use `queueMicrotask`, a fixed timeout, or a document-wide selector for this protocol.

- [ ] **Step 5: Run hook, setup, and storage regressions**

```bash
npm --prefix frontend run test -- useAppNavigationState storage appNavigationModel
npm --prefix frontend run typecheck
```

Expected: PASS. Vitest loads the shared matcher setup, TypeScript sees the matcher augmentation, a remount restores only primary/base/discover section, never a task, and an old key remains available for rollback.

- [ ] **Step 6: Commit the test and hook boundary**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/test/setup.ts \
  frontend/src/app/useAppNavigationState.ts frontend/src/app/useAppNavigationState.test.tsx
git commit -m "feat: add persisted app navigation state"
```

## Task 3: Make AppShell Render One Shared Five-Entry Navigation

**Files:**

- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/app/AppShell.test.tsx`

**Interfaces:**

- Consumes: Task 1 `PrimaryTabKey`; existing visual viewport, orientation, notification-center, and keyboard behavior.
- Produces: exported `PRIMARY_NAV_ITEMS` used by both desktop and mobile and `AppShellProps.activeTab/onTabChange` typed with `PrimaryTabKey`.

- [ ] **Step 1: Replace old navigation assertions with a failing shared-list contract**

```tsx
it('renders the same five primary entries on desktop and mobile', () => {
  renderAppShell(<div>内容</div>, 'eat');
  const expected = ['首页', '吃什么', '食材', 'AI', '家庭'];
  for (const name of ['大屏主导航', '顶部主导航', '手机主导航']) {
    expect(
      within(screen.getByRole('navigation', { name }))
        .getAllByRole('button')
        .map((node) => node.textContent?.trim()),
    ).toEqual(expected);
  }
  expect(screen.queryByRole('button', { name: '菜谱' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '记录' })).not.toBeInTheDocument();
});
```

Update the existing local `renderAppShell` test helper to accept `activeTab: PrimaryTabKey` as its second argument; do not introduce a second shell fixture.

- [ ] **Step 2: Run AppShell tests and verify the old seven-entry failure**

```bash
npm --prefix frontend run test -- AppShell
```

Expected: FAIL because the existing desktop/mobile arrays differ and expose `foods/recipes/logs`.

- [ ] **Step 3: Use one shared navigation data source**

```ts
export const PRIMARY_NAV_ITEMS: ReadonlyArray<{
  key: PrimaryTabKey;
  label: string;
  icon: ShellIconName;
}> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'eat', label: '吃什么', icon: 'food' },
  { key: 'ingredients', label: '食材', icon: 'ingredient' },
  { key: 'ai', label: 'AI', icon: 'ai' },
  { key: 'family', label: '家庭', icon: 'family' },
];
```

Render `PRIMARY_NAV_ITEMS` in the existing sidebar, top tabbar, and mobile-bottom navigation regions. Give the top tabbar `aria-label="顶部主导航"`. Preserve existing viewport CSS variables, orientation lock, notification center, safe-area padding, and keyboard-open behavior. Set `aria-current="page"` on the active entry in all three regions.

- [ ] **Step 4: Run AppShell regressions**

```bash
npm --prefix frontend run test -- AppShell
```

Expected: PASS for five-entry order/active state and all existing orientation/visual-viewport tests.

- [ ] **Step 5: Commit the shell change**

```bash
git add frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx
git commit -m "feat: unify primary navigation entries"
```

## Task 4: Add Family/User-Scoped FoodPlanItem Detail Transport and Cache

**Files:**

- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/tests/recipes/test_food_workspace.py`
- Modify: `frontend/src/api/foodsApi.ts`
- Create: `frontend/src/api/foodsApi.test.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`

**Interfaces:**

- Consumes: existing `FoodPlanItemOut`, `_load_plan_item(...)`, `serialize_food_plan_item(...)`, request client, and `foodPlanRoot` invalidation.
- Produces: `GET /api/food-plan/{item_id}`, `foodsApi.getFoodPlanItem(itemId): Promise<FoodPlanItem>`, and `queryKeys.foodPlanDetail(itemId)` under `foodPlanRoot`.

- [ ] **Step 1: Write failing backend ownership/detail tests**

```py
def test_get_food_plan_item_by_id_is_scoped_to_current_user(client, auth_headers, food_plan_item):
    response = client.get(f"/api/food-plan/{food_plan_item.id}", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["id"] == food_plan_item.id
    assert response.json()["updated_at"]

def test_get_food_plan_item_hides_other_user(client, other_user_headers, food_plan_item):
    response = client.get(f"/api/food-plan/{food_plan_item.id}", headers=other_user_headers)
    assert response.status_code == 404
```

- [ ] **Step 2: Run the backend test and verify 405/404 before the route exists**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_food_workspace.py -k "get_food_plan_item_by_id" -q
```

Expected: FAIL because there is no GET detail route.

- [ ] **Step 3: Add the scoped detail route**

```py
@router.get("/api/food-plan/{item_id}", response_model=FoodPlanItemOut)
def get_food_plan_item(
    item_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    item = _load_plan_item(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        item_id=item_id,
    )
    return serialize_food_plan_item(item)
```

Ensure `_load_plan_item` eagerly loads `FoodPlanItem.food.recipe` so the existing response contains Food/Recipe fields without lazy-loading after session boundaries.

- [ ] **Step 4: Add failing frontend transport/cache tests**

```ts
it('loads one FoodPlanItem by ID', async () => {
  mockFetchJson({ id: 'plan-1', food_id: 'food-1', updated_at: '2026-07-12T08:00:00Z' });
  await expect(foodsApi.getFoodPlanItem('plan-1')).resolves.toMatchObject({ id: 'plan-1' });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/food-plan/plan-1'), expect.anything());
});

it('nests detail under the FoodPlan root', () => {
  expect(queryKeys.foodPlanDetail('plan-1')).toEqual(['food-plan', 'detail', 'plan-1']);
});
```

- [ ] **Step 5: Implement frontend API, key, and invalidation**

```ts
foodPlanDetail: (itemId: string) => [...foodPlanRoot, 'detail', itemId] as const,
```

```ts
getFoodPlanItem: (itemId: string) =>
  request<FoodPlanItem>(`/api/food-plan/${itemId}`),
```

Keep `invalidateAfterFoodPlanChanged`, `invalidateAfterQuickMealAdded`, `invalidateAfterRecipeCooked`, and `invalidateAfterAiApprovalSettled` invalidating `queryKeys.foodPlanRoot`, which now covers both week lists and detail entries.

- [ ] **Step 6: Run cross-stack focused tests**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_food_workspace.py -k "food_plan_item" -q
cd .. && npm --prefix frontend run test -- foodsApi queryKeys cacheInvalidation
```

Expected: PASS; other-user/cross-family/missing detail all return the same 404 style.

- [ ] **Step 7: Commit the detail contract**

```bash
git add backend/app/api/recipe_meta.py backend/tests/recipes/test_food_workspace.py \
  frontend/src/api/foodsApi.ts frontend/src/api/foodsApi.test.ts \
  frontend/src/api/queryKeys.ts frontend/src/api/queryKeys.test.ts \
  frontend/src/api/cacheInvalidation.ts frontend/src/api/cacheInvalidation.test.ts
git commit -m "feat: add scoped food plan detail query"
```

## Task 5: Resolve ID-Only Eat Targets and Drive Query Scope

**Files:**

- Create: `frontend/src/features/eat/EatWorkspaceViewModel.ts`
- Create: `frontend/src/features/eat/EatWorkspaceViewModel.test.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/appNavigationModel.test.ts`

**Interfaces:**

- Consumes: Task 1 `AppNavigationState/AppQueryScope`, Task 4 `foodPlanDetail`, query statuses, `Food[]`, `Recipe[]`, `MealLog[]`.
- Produces: `ResolvedEatTask` discriminated union, `resolveEatTask(...)`, `weekContaining(date)`, and `useAppWorkspaceQueries({ navigationState, ... })` returning `foodPlanDetailQuery` plus existing data.

- [ ] **Step 1: Write failing resolver tests for every Recipe relation state**

```ts
it('resolves one Recipe to its unique selfMade Food after both queries succeed', () => {
  expect(resolveEatTask({
    task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
    recipes: [{ id: 'recipe-1' } as Recipe],
    foods: [{ id: 'food-1', recipe_id: 'recipe-1', type: 'selfMade' } as Food],
    recipesStatus: 'success',
    foodsStatus: 'success',
    planDetail: null,
    planDetailStatus: 'idle',
    mealLogs: [],
  })).toMatchObject({ kind: 'ready-recipe', foodId: 'food-1', recipeId: 'recipe-1' });
});

it.each([
  [[], [{ id: 'food-1', recipe_id: 'recipe-1' }], 'recipe-not-found'],
  [[{ id: 'recipe-1' }], [], 'recipe-food-missing'],
  [[{ id: 'recipe-1' }], [{ id: 'food-1', recipe_id: 'recipe-1' }, { id: 'food-2', recipe_id: 'recipe-1' }], 'recipe-food-ambiguous'],
] as const)('returns a recoverable relation state', (recipes, foods, expected) => {
  expect(resolveRecipeTargetForTest(recipes, foods).kind).toBe(expected);
});
```

- [ ] **Step 2: Run the resolver test and verify the missing-module failure**

```bash
npm --prefix frontend run test -- EatWorkspaceViewModel
```

Expected: FAIL because the view model does not exist.

- [ ] **Step 3: Implement an exhaustive task resolver**

```ts
export type ResolvedEatTask =
  | { kind: 'none' }
  | { kind: 'loading'; label: string }
  | { kind: 'food'; food: Food }
  | { kind: 'ready-recipe'; foodId: string; recipeId: string; mode: 'view' | 'edit' }
  | { kind: 'recipe-not-found'; recipeId: string }
  | { kind: 'recipe-food-missing'; recipe: Recipe }
  | { kind: 'recipe-food-ambiguous'; recipe: Recipe; foodIds: string[] }
  | { kind: 'plan'; item: FoodPlanItem; week: { start: string; end: string } }
  | { kind: 'plan-not-found'; foodPlanItemId: string }
  | { kind: 'cook'; food: Food; recipe: Recipe; launchContext: CookLaunchContext }
  | { kind: 'meal-create'; task: Extract<EatTask, { kind: 'meal-create' }>; planItem: FoodPlanItem | null }
  | { kind: 'meal'; mealLog: MealLog }
  | { kind: 'meal-not-found'; mealLogId: string };
```

Return `loading` until all required queries have settled. Never call `ensure_food_for_recipe`, never choose the first relation when count is not exactly one, and never retain a server entity inside navigation state.

- [ ] **Step 4: Replace TabKey query windows with pure scope input**

```ts
export function useAppWorkspaceQueries(args: {
  navigationState: AppNavigationState;
  isAuthenticated: boolean;
  foodPlanWeekRange: WeekRange;
}) {
  const scope = deriveAppQueryScope(args.navigationState);
  const planDetailId = args.navigationState.eat.task?.kind === 'plan-detail'
    ? args.navigationState.eat.task.foodPlanItemId
    : null;
  const foodPlanDetailQuery = useQuery({
    queryKey: queryKeys.foodPlanDetail(planDetailId ?? ''),
    queryFn: () => api.getFoodPlanItem(planDetailId as string),
    enabled: args.isAuthenticated && scope.needsFoodPlanDetail && Boolean(planDetailId),
  });
```

Apply every `AppQueryScope` boolean to its existing query and include `foodPlanDetailQuery` in `isBootLoading` only as a local task loading state, not a global application blank screen.

- [ ] **Step 5: Run model/query-scope regressions**

```bash
npm --prefix frontend run test -- EatWorkspaceViewModel appNavigationModel useAppWorkspaceQueries
```

Expected: PASS for discover, plan, cross-week plan-detail, history, food, recipe target, direct/plan Cook, meal create/detail, Home, Ingredients, and AI scope rows.

- [ ] **Step 6: Commit resolver and query changes**

```bash
git add frontend/src/features/eat/EatWorkspaceViewModel.ts frontend/src/features/eat/EatWorkspaceViewModel.test.ts \
  frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/appNavigationModel.test.ts
git commit -m "feat: resolve eating targets from query state"
```

## Task 6: Extract Food Discovery and Plan Surfaces Without Changing UI

**Files:**

- Create: `frontend/src/components/foods/FoodDiscoverSurface.tsx`
- Create: `frontend/src/components/foods/FoodPlanSurface.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodHubView.tsx`
- Modify: `frontend/src/components/foods/FoodMobileView.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Modify: `frontend/src/components/foods/FoodWorkspaceUsage.test.ts`

**Interfaces:**

- Consumes: existing FoodWorkspace models/state/action hooks, `FoodHubView`, mobile Food cards, Food plan week/detail components, and current Culina markup/classes.
- Produces: `FoodDiscoverSurfaceProps` and `FoodPlanSurfaceProps` whose callbacks emit entity/action intent (`onOpenFood`, `onStartDirectCook`, `onOpenPlanItem`, `onCreatePlan`) without owning primary navigation.

- [ ] **Step 1: Add failing usage tests that reject nested workspace shells**

```ts
it('exports focused Food surfaces and keeps the compatibility workspace as an adapter', async () => {
  const discoverSource = await readSource('FoodDiscoverSurface.tsx');
  const planSource = await readSource('FoodPlanSurface.tsx');
  const workspaceSource = await readSource('FoodWorkspace.tsx');
  expect(discoverSource).toContain('export function FoodDiscoverSurface');
  expect(planSource).toContain('export function FoodPlanSurface');
  expect(workspaceSource).toContain('<FoodDiscoverSurface');
  expect(discoverSource).not.toContain('<AppShell');
  expect(planSource).not.toContain('<AppShell');
});
```

- [ ] **Step 2: Run focused Food tests and verify missing surface files**

```bash
npm --prefix frontend run test -- FoodWorkspace FoodWorkspaceUsage
```

Expected: FAIL because the two surface modules do not exist.

- [ ] **Step 3: Define narrow shell-free presentation contracts**

```ts
export type FoodDiscoverSurfaceProps = {
  desktopContent: ReactNode;
  mobileContent: ReactNode;
  loading: boolean;
  errorMessage: string | null;
  isEmpty: boolean;
  onCreateFood: () => void;
};

export function FoodDiscoverSurface(props: FoodDiscoverSurfaceProps) {
  if (props.loading) return <StateBlock status="loading" title="正在准备家庭食物" />;
  return (
    <section className="eat-discover-surface" aria-label="发现">
      {props.errorMessage ? <StateBlock status="error" title="部分推荐暂不可用" description={props.errorMessage} /> : null}
      {props.isEmpty ? <EmptyState title="还没有可选的食物" description="先添加一道家常菜、外卖或成品。" actionLabel="添加食物" onAction={props.onCreateFood} /> : null}
      <div className="food-desktop-view">{props.desktopContent}</div>
      <div className="food-mobile-view">{props.mobileContent}</div>
    </section>
  );
}
```

`FoodPlanSurface` accepts the existing week toolbar/list/detail launch content plus `onOpenPlanItem(item)` and `onStartPlanItem(item)`. Move markup and event wiring intact; do not copy state or mutations into either surface.

- [ ] **Step 4: Make FoodWorkspace a temporary compatibility adapter**

Keep current hooks and action behavior in `FoodWorkspace` while it constructs focused surface props. Remove duplicate standalone “食物” primary headers from embedded surfaces, but preserve cards, photos, filters, scene controls, plan dialogs, mobile touch targets, and current CSS classes. The adapter shape is:

```tsx
return props.surface === 'plan'
  ? <FoodPlanSurface {...planSurfaceProps} />
  : <FoodDiscoverSurface {...discoverSurfaceProps} />;
```

Add `surface?: 'discover' | 'plan'` with default `discover` only for the PR A transition. Task 9 removes the old primary render path.

- [ ] **Step 5: Run Food component and usage regressions**

```bash
npm --prefix frontend run test -- FoodWorkspace FoodWorkspaceUsage FoodHubView FoodMobileView
```

Expected: PASS; existing card actions and plan behavior remain, and snapshots/queries show no new primary shell or visual redesign.

- [ ] **Step 6: Commit the extraction**

```bash
git add frontend/src/components/foods/FoodDiscoverSurface.tsx frontend/src/components/foods/FoodPlanSurface.tsx \
  frontend/src/components/foods/FoodWorkspace.tsx frontend/src/components/foods/FoodHubView.tsx \
  frontend/src/components/foods/FoodMobileView.tsx frontend/src/components/foods/FoodWorkspace.test.ts \
  frontend/src/components/foods/FoodWorkspaceUsage.test.ts
git commit -m "refactor: extract food discovery and plan surfaces"
```

## Task 7: Extract Recipe Tasks and Make Meal History Valid-Record-First

**Files:**

- Create: `frontend/src/components/recipes/RecipeTaskSurface.tsx`
- Create: `frontend/src/features/meals/MealHistorySurface.tsx`
- Create: `frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.tsx`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.test.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Modify: `frontend/src/features/meals/MealLogMobileView.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`
- Modify: `frontend/src/features/meals/MealLogWorkspaceUsage.test.ts`

**Interfaces:**

- Consumes: existing Recipe detail/editor/Cook views and MealLog timeline/detail/enrichment components.
- Produces: `RecipeTaskSurface` for `view/edit/cook`, `MealHistorySurface` for timeline/create/detail/enrich, and `getMealRecordPresentation(meal)` that never labels a valid minimal MealLog pending/invalid.

- [ ] **Step 1: Write failing minimal-record and surface usage tests**

```ts
it('treats a minimal MealLog as a complete valid record', () => {
  const meal = makeMealLog({ photos: [], notes: '', mood: '', participant_user_ids: [] });
  expect(getMealRecordPresentation(meal)).toEqual({
    validity: 'valid',
    enrichment: 'basic',
    actionLabel: '补充这餐',
  });
});

it('does not select a pending record ahead of a newer valid record', () => {
  const olderWithNoPhoto = makeMealLog({ id: 'old', date: '2026-07-11' });
  const newer = makeMealLog({ id: 'new', date: '2026-07-12' });
  expect(selectInitialMeal([olderWithNoPhoto, newer])?.id).toBe('new');
});
```

Add usage assertions that `RecipeTaskSurface` imports Recipe detail/editor/Cook components but not `RecipeLibraryView`, and `MealHistorySurface` contains no user-visible `待补充`, `未完成`, `欠缺资料`, or `记录任务`.

- [ ] **Step 2: Run Recipe/Meal tests and observe semantic failures**

```bash
npm --prefix frontend run test -- RecipeWorkspace MealLogWorkspace
```

Expected: FAIL because Recipe has no task surface and MealLog status prioritizes “待补充”.

- [ ] **Step 3: Build the Recipe task discriminant**

```ts
export type RecipeTaskSurfaceProps =
  | { mode: 'view'; recipe: Recipe; food: Food; onEdit: () => void; onCook: (context: CookLaunchContext) => void; onClose: () => void; relationWritable: boolean }
  | { mode: 'edit'; recipe: Recipe; food: Food; onSaved: (recipe: Recipe) => void; onClose: () => void; relationWritable: boolean }
  | { mode: 'cook'; recipe: Recipe; food: Food; launchContext: CookLaunchContext; onCompleted: (result: CookRecipeResponse) => void; onClose: () => void };
```

Compose existing `RecipeDetailView/Drawer`, `RecipeEditorView`, and `RecipeCookView` according to the discriminant. For missing/ambiguous Food relation, render read-only Recipe detail with an explanatory error and disable Cook/plan writes.

- [ ] **Step 4: Replace task-language MealLog presentation**

```ts
export function getMealRecordPresentation(meal: MealLog) {
  const hasEnrichment = Boolean(
    meal.photos.length ||
    meal.notes.trim() ||
    meal.mood.trim() ||
    meal.food_entries.some((entry) => entry.rating != null),
  );
  return {
    validity: 'valid' as const,
    enrichment: hasEnrichment ? 'enriched' as const : 'basic' as const,
    actionLabel: hasEnrichment ? '查看这餐' : '补充这餐',
  };
}
```

Use newest date/created-at for initial selection. Replace mobile stats with neutral record/enrichment counts, keep optional enrichment actions, and preserve the existing timeline/detail visuals.

- [ ] **Step 5: Run Recipe/Meal regressions**

```bash
npm --prefix frontend run test -- RecipeWorkspace RecipeWorkspaceUsage MealLogWorkspace MealLogWorkspaceModel MealLogWorkspaceUsage MealEnrichmentModal
```

Expected: PASS; Recipe task abilities remain usable and a photo-less/rating-less MealLog is normal history, not an error or debt.

- [ ] **Step 6: Commit the task surfaces**

```bash
git add frontend/src/components/recipes/RecipeTaskSurface.tsx frontend/src/components/recipes/RecipeWorkspace.tsx \
  frontend/src/components/recipes/RecipeWorkspace.test.ts frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts \
  frontend/src/features/meals/MealHistorySurface.tsx frontend/src/features/meals/MealLogWorkspace.tsx \
  frontend/src/features/meals/MealLogMobileView.tsx frontend/src/features/meals/MealLogWorkspaceModel.ts \
  frontend/src/features/meals/MealLogWorkspaceModel.test.ts frontend/src/features/meals/MealLogWorkspaceUsage.test.ts
git commit -m "refactor: extract recipe and meal task surfaces"
```

## Task 8: Compose the Accessible Responsive EatWorkspace

**Files:**

- Create: `frontend/src/features/eat/EatWorkspace.tsx`
- Create: `frontend/src/features/eat/EatWorkspace.test.tsx`
- Create: `frontend/src/styles/12-eat-workspace.css`
- Modify: `frontend/src/styles.css`

**Interfaces:**

- Consumes: navigation service, Task 5 resolver/query results, Task 6 Food surfaces, Task 7 Recipe/Meal surfaces, current modals/drawers, and notification center.
- Produces: `EatWorkspaceProps`, one `tablist` for `发现/菜单/吃过的`, task rendering, `aria-live` notices, and desktop/mobile layouts backed by the same business state.

- [ ] **Step 1: Write failing composition and accessibility tests**

```tsx
it('switches base views through tab semantics and closes the current task', async () => {
  const user = userEvent.setup();
  const navigation = createNavigationServiceWithFoodTask();
  render(<EatWorkspace {...makeEatProps({ navigation })} />);
  expect(screen.getByRole('tab', { name: '发现' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('tab', { name: '菜单' }));
  expect(navigation.selectEatView).toHaveBeenCalledWith('plan', expect.anything());
});

it('shows a recoverable relation error without a write action', () => {
  render(<EatWorkspace {...makeEatProps({ resolvedTask: { kind: 'recipe-food-missing', recipe: makeRecipe() } })} />);
  expect(screen.getByText('这份做法与家常菜的关联需要修复')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '开始做' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '返回发现' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify the missing-component failure**

```bash
npm --prefix frontend run test -- EatWorkspace
```

Expected: FAIL because `EatWorkspace` does not exist.

- [ ] **Step 3: Implement a lightweight composition boundary**

```tsx
const EAT_TABS: ReadonlyArray<{ key: EatBaseView; label: string }> = [
  { key: 'discover', label: '发现' },
  { key: 'plan', label: '菜单' },
  { key: 'history', label: '吃过的' },
];

export function EatWorkspace(props: EatWorkspaceProps) {
  const { state } = props.navigation;
  return (
    <main className="eat-workspace">
      <header className="eat-workspace-header">
        <h1>吃什么</h1>
        <div role="tablist" aria-label="吃什么视图" className="eat-workspace-tabs">
          {EAT_TABS.map((item) => (
            <button
              key={item.key}
              role="tab"
              type="button"
              aria-selected={state.eat.baseView === item.key}
              onClick={(event) => props.navigation.selectEatView(item.key, event.currentTarget)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <section
        ref={props.navigation.registerBaseViewFocusTarget}
        className="eat-workspace-base"
        tabIndex={-1}
        aria-label="当前吃什么列表"
      >
        {renderBaseView(props)}
      </section>
      {renderResolvedTask(props, { headingRef: props.navigation.registerTaskHeading })}
      <div className="sr-only" aria-live="polite">{props.liveMessage}</div>
    </main>
  );
}
```

Use one close callback for drawer close, mobile back, and Escape. Block backdrop/Escape closure while completion mutation is pending. Every task renderer accepts the shared `headingRef`, places it on its visible heading with `tabIndex={-1}`, and never focuses itself in an effect. Task 2 owns entry/return focus; the base section is its connected fallback when the original trigger came from an overlay that has unmounted.

- [ ] **Step 4: Add scoped responsive styles**

Add `@import './styles/12-eat-workspace.css';` to the style entry. Define `eat-workspace-*` rules for the desktop two-region composition, mobile task sheet, safe-area action bar, 44px controls, and a non-wrapping 375px tab row. Do not change card colors, radii, typography tokens, or image behavior owned by existing components.

- [ ] **Step 5: Run focused UI and style checks**

```bash
npm --prefix frontend run test -- EatWorkspace AppShell FoodWorkspace RecipeWorkspace MealLogWorkspace
npm --prefix frontend run check:style-tokens
```

Expected: PASS; no horizontal overflow is introduced by the Eat tab row and no global style token drift is reported.

- [ ] **Step 6: Commit EatWorkspace**

```bash
git add frontend/src/features/eat/EatWorkspace.tsx frontend/src/features/eat/EatWorkspace.test.tsx \
  frontend/src/styles/12-eat-workspace.css frontend/src/styles.css
git commit -m "feat: compose unified eating workspace"
```

## Task 9: Replace App Eating Request IDs and Device-Specific Search Navigation

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppGlobalSearchNavigation.ts`
- Modify: `frontend/src/app/useAppGlobalSearchNavigation.test.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspaceUsage.test.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts`

**Interfaces:**

- Consumes: Task 2 `AppNavigationService`, Task 5 queries/resolver, Task 8 `EatWorkspace`.
- Produces: one `eat` App render branch; semantic Food/Recipe/meal-plan search targets; the existing discriminated Ingredient request for IngredientWorkspace; no Food/Recipe/plan request-ID refs and no eating-target viewport branch.

- [ ] **Step 1: Write failing search tests for device-independent semantic targets**

```tsx
it('opens a Recipe through recipe-target without accepting viewport state', () => {
  const navigate = vi.fn();
  const { result } = renderHook(() => useAppGlobalSearchNavigation({ navigate }));
  act(() => result.current.handleGlobalSearchSelect(makeSearchSelection('recipe', 'recipe-1')));
  expect(navigate).toHaveBeenCalledWith({ workspace: 'eat', view: 'recipe', recipeId: 'recipe-1' });
});

it('opens an unloaded plan by ID without trusting the search snapshot date', () => {
  const navigate = vi.fn();
  const { result } = renderHook(() => useAppGlobalSearchNavigation({ navigate }));
  act(() => result.current.handleGlobalSearchSelect(makeSearchSelection('meal_plan', 'plan-outside-week')));
  expect(navigate).toHaveBeenCalledWith({ workspace: 'eat', view: 'plan', foodPlanItemId: 'plan-outside-week' });
});

it('keeps Ingredient detail as a discriminated IngredientWorkspace request', () => {
  const navigate = vi.fn();
  const { result } = renderHook(() => useAppGlobalSearchNavigation({ navigate }));
  act(() => result.current.handleGlobalSearchSelect(makeSearchSelection('ingredient', 'ingredient-1')));
  expect(result.current.ingredientNavigationRequest).toMatchObject({
    target: 'detail',
    ingredientId: 'ingredient-1',
  });
  expect(navigate).toHaveBeenCalledWith({ workspace: 'ingredients' });
});
```

- [ ] **Step 2: Run search/App usage tests and observe old request-ID behavior**

```bash
npm --prefix frontend run test -- useAppGlobalSearchNavigation FoodWorkspaceUsage RecipeWorkspaceUsage
```

Expected: FAIL because the hook still accepts Foods/setActiveTab and branches on viewport.

- [ ] **Step 3: Reduce search selection to semantic targets**

```ts
export function useAppGlobalSearchNavigation(args: {
  navigate: AppNavigationService['navigate'];
}) {
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [ingredientNavigationRequest, setIngredientNavigationRequest] = useState<IngredientNavigationRequest | null>(null);
  const ingredientNavigationRequestIdRef = useRef(0);

  const handleGlobalSearchSelect = useCallback((selection: GlobalSearchSelection) => {
    setGlobalSearchOpen(false);
    if (selection.entityType === 'ingredient') {
      ingredientNavigationRequestIdRef.current += 1;
      setIngredientNavigationRequest({
        target: 'detail',
        ingredientId: selection.entityId,
        requestId: ingredientNavigationRequestIdRef.current,
      });
      args.navigate({ workspace: 'ingredients' });
    } else if (selection.entityType === 'food') {
      args.navigate({ workspace: 'eat', view: 'food', foodId: selection.entityId });
    } else if (selection.entityType === 'recipe') {
      args.navigate({ workspace: 'eat', view: 'recipe', recipeId: selection.entityId });
    } else if (selection.entityType === 'meal_plan') {
      args.navigate({ workspace: 'eat', view: 'plan', foodPlanItemId: selection.entityId });
    }
  }, [args.navigate]);

  return {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    globalSearchOpen,
    setGlobalSearchOpen,
    handleGlobalSearchSelect,
  };
}
```

Delete `foods`, `isPhoneViewport`, `setActiveTab`, and `setSelectedRecipePlanDate` from the hook arguments in the same change. Keep only the Ingredient request state/ref because IngredientWorkspace still consumes that separate discriminated boundary in PR A.

- [ ] **Step 4: Recompose App with one navigation source**

Instantiate `useAppNavigationState()` once, pass `navigation.state` to `useAppWorkspaceQueries`, pass `navigation.state.primaryTab` to `AppShell`, and render only one eating branch:

```tsx
{navigation.state.primaryTab === 'eat' ? (
  <EatWorkspace
    navigation={navigation}
    queries={workspaceQueries}
    mutations={workspaceMutations}
    foodPlanWeekRange={foodPlanWeekRange}
    onFoodPlanWeekRangeChange={setFoodPlanWeekRange}
  />
) : null}
```

Delete `pendingRecipeCookId`, `pendingFoodPlanCookItemId`, `pendingRecipeCookReturnTarget`, Food/Recipe/plan request-ID refs, independent `FoodWorkspace`, `RecipeWorkspace`, and `MealLogWorkspace` primary branches, and every `setActiveTab('foods'|'recipes'|'logs')` eating jump. Preserve ingredient navigation requests until their own architecture changes.

- [ ] **Step 5: Run App/search/query regressions**

```bash
npm --prefix frontend run test -- AppShell useAppGlobalSearchNavigation appNavigationModel EatWorkspace FoodWorkspaceUsage RecipeWorkspaceUsage
npm --prefix frontend run typecheck
```

Expected: PASS; TypeScript finds no legacy eating `TabKey`, request-ID prop, or viewport-dependent Recipe target.

- [ ] **Step 6: Commit App integration**

```bash
git add frontend/src/App.tsx frontend/src/app/useAppWorkspaceQueries.ts \
  frontend/src/app/useAppGlobalSearchNavigation.ts frontend/src/app/useAppGlobalSearchNavigation.test.tsx \
  frontend/src/components/foods/FoodWorkspaceUsage.test.ts frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts
git commit -m "feat: route eating actions through semantic navigation"
```

## Task 10: Migrate Home, Family, and AI Targets and Pass the PR A Gate

**Files:**

- Modify: `frontend/src/app/useAppHomeHandlers.ts`
- Create: `frontend/src/app/useAppHomeHandlers.test.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.test.ts`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.test.tsx`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Modify: `frontend/src/features/family/FamilySettings.test.tsx`
- Modify: `frontend/src/components/ai/AiResultCards.tsx`
- Modify: `frontend/src/components/ai/AiResultCards.test.tsx`
- Modify: `frontend/scripts/smoke.mjs`

**Interfaces:**

- Consumes: PR 72 Home action-center outputs, `AppNavigationService.navigate`, and Task 1 Cook/meal targets.
- Produces: semantic Home direct/plan/history actions, Family history, AI Food/Recipe/plan/Meal targets, and PR A desktop/mobile/tablet smoke coverage.

- [ ] **Step 1: Write failing cross-entry target tests**

```ts
it('maps a Home direct Cook recommendation to a complete launch context', () => {
  const navigate = vi.fn();
  const handlers = buildHomeHandlers({ navigate });
  handlers.startRecommendedRecipe({
    foodId: 'food-1',
    recipeId: 'recipe-1',
    date: '2026-07-14',
    mealType: 'lunch',
    servings: 3.5,
  });
  expect(navigate).toHaveBeenCalledWith({
    workspace: 'eat',
    view: 'cook',
    foodId: 'food-1',
    recipeId: 'recipe-1',
    launchContext: {
      date: '2026-07-14',
      mealType: 'lunch',
      servings: 3.5,
      source: { kind: 'direct' },
    },
  });
});

it('maps AI entities without setting a tab directly', () => {
  expect(targetForAiEntity({ type: 'meal_log', id: 'meal-1' })).toEqual({
    workspace: 'eat',
    view: 'history',
    mealLogId: 'meal-1',
  });
});
```

- [ ] **Step 2: Run cross-entry tests and verify legacy TabKey failures**

```bash
npm --prefix frontend run test -- useAppHomeHandlers useAppHomeViewModel HomeDashboard FamilySettings AiResultCards
```

Expected: FAIL where handlers/components still expose `setActiveTab`, Recipe/Logs tabs, or incomplete Cook IDs.

- [ ] **Step 3: Implement the complete semantic mapping**

Use these exact mappings:

```ts
const homeTargets = {
  food: (foodId: string): AppNavigationTarget => ({ workspace: 'eat', view: 'food', foodId }),
  plan: (foodPlanItemId: string): AppNavigationTarget => ({ workspace: 'eat', view: 'plan', foodPlanItemId }),
  history: (mealLogId?: string): AppNavigationTarget => ({ workspace: 'eat', view: 'history', mealLogId }),
  mealCreate: (source: MealCreateSource, foodId?: string): AppNavigationTarget => ({ workspace: 'eat', view: 'meal-create', source, foodId }),
};
```

Home plan Cook reads the latest plan detail and builds `source: { kind: 'plan', foodPlanItemId, planItemBaseUpdatedAt: updated_at }`. Family MealLog links emit history targets. AI result cards emit Food detail, Recipe target, plan detail, or exact MealLog detail; no AI component calls a tab setter.

- [ ] **Step 4: Extend smoke fixtures and assertions for PR A**

Add fixture routes for `GET /api/food-plan/{id}` and these browser paths:

```text
desktop: 首页 → 推荐 Food → 吃什么/发现/Food detail
desktop: 搜索 Recipe → recipe-target → linked Food Recipe detail
mobile: 吃什么 → 发现 → 菜单 → 吃过的
plan search: non-current-week result → detail fetch → selected week
storage: foods/recipes/logs/unknown/corrupt → safe visible workspace
viewports: 375x812, 390x844, 430x932, 768x1024, 1024x744, 1112x834, 1180x820, desktop
```

- [ ] **Step 5: Run the complete PR A verification gate**

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_food_workspace.py -q
cd .. && git diff --check
```

Expected: every command PASS. Manually inspect 375px mobile, 768px tablet, 1024px touch landscape, and desktop: no tab overflow, bottom-nav overlap, focus loss, duplicate primary header, or desktop/mobile target divergence.

- [ ] **Step 6: Run PR A reviews and commit fixes separately**

Use `superpowers:requesting-code-review` for spec compliance and code quality. Fix all P0/P1 findings with focused tests. Each fix receives its own commit with only the reviewed paths.

- [ ] **Step 7: Commit the cross-entry migration**

```bash
git add frontend/src/app/useAppHomeHandlers.ts frontend/src/app/useAppHomeHandlers.test.ts \
  frontend/src/app/useAppHomeViewModel.ts frontend/src/app/useAppHomeViewModel.test.ts \
  frontend/src/features/home/HomeDashboard.tsx frontend/src/features/home/HomeDashboard.test.tsx \
  frontend/src/features/family/FamilySettings.tsx frontend/src/features/family/FamilySettings.test.tsx \
  frontend/src/components/ai/AiResultCards.tsx frontend/src/components/ai/AiResultCards.test.tsx \
  frontend/scripts/smoke.mjs
git commit -m "feat: migrate global eating entry points"
```

- [ ] **Step 8: Finish PR A, then pass the Home Highlights merge gate before B1**

Use `superpowers:finishing-a-development-branch` to push and open/review PR A. Merge only after checks are green. Then pause this plan while the Home Highlights branch rebases onto merged PR A, reruns its baseline plus affected navigation/Home tests, completes Tasks 4–15, passes its full review/gate, and merges.

Refresh main and verify both merge commits are ancestors before opening B1:

```bash
git fetch origin --prune
test -n "$PR_A_NUMBER"
test -n "$HOME_HIGHLIGHTS_PR_NUMBER"
PR_A_MERGE_SHA="$(gh pr view "$PR_A_NUMBER" --repo novisfff/Culina --json mergeCommit --jq .mergeCommit.oid)"
HOME_HIGHLIGHTS_MERGE_SHA="$(gh pr view "$HOME_HIGHLIGHTS_PR_NUMBER" --repo novisfff/Culina --json mergeCommit --jq .mergeCommit.oid)"
git merge-base --is-ancestor "$PR_A_MERGE_SHA" origin/main
git merge-base --is-ancestor "$HOME_HIGHLIGHTS_MERGE_SHA" origin/main
cd backend && ./.venv/bin/alembic heads
```

Expected: both ancestry checks exit 0 and Alembic reports exactly one Home Highlights descendant head. Only then create `feature/cook-completion-backend` from the new merged `main`; never stack B1 on an unmerged PR A or Home commit.

## PR B1 — Compatible Consistency and Completion Foundation

## Task 11: Add Additive RecipeCookLog Completion Persistence

**Files:**

- Create: `backend/alembic/versions/4f5a6b7c8d9e_add_recipe_cook_completion_idempotency.py`
- Modify: `backend/app/models/domain.py`
- Modify: `backend/app/schemas/recipes.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`

**Interfaces:**

- Consumes: Task 0’s one real Alembic head and existing `RecipeCookLog`/`CookRecipeResponse`.
- Produces: nullable `RecipeCookLog.completion_request_id`, `RecipeCookLog.completion_request_hash`, `RecipeCookLog.completion_result_json`, unique `(family_id, completion_request_id)`, and `CookRecipeResponse.replayed: bool = False`.

- [ ] **Step 1: Write failing model/schema tests**

```py
def test_recipe_cook_log_completion_fields_are_nullable_for_history(db):
    historical = make_recipe_cook_log(
        completion_request_id=None,
        completion_request_hash=None,
        completion_result_json=None,
    )
    db.add(historical)
    db.flush()
    assert historical.completion_request_id is None

def test_cook_response_defaults_replayed_false():
    response = CookRecipeResponse(
        recipe_id="recipe-1",
        consumed_items=[],
        shortages=[],
        meal_log_id="meal-1",
        cook_log_id="cook-1",
    )
    assert response.replayed is False
```

- [ ] **Step 2: Run the focused test and verify missing fields**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "completion_fields or replayed" -q
```

Expected: FAIL because the model fields and `replayed` field do not exist.

- [ ] **Step 3: Create the additive migration**

The pre-Home baseline head is `3f4a5b6c7d8e`. Under the required execution order, Home Highlights adds `4a5b6c7d8e9f` on top of it, so Task 11 should normally use `down_revision = "4a5b6c7d8e9f"`. Never create a sibling migration from `3f4a5b6c7d8e`; if the post-Home Task 10 gate reports another single descendant head, change only `down_revision` to that exact verified head before running the migration.

```py
revision: str = "4f5a6b7c8d9e"
down_revision: str | None = "4a5b6c7d8e9f"

def upgrade() -> None:
    op.add_column("recipe_cook_logs", sa.Column("completion_request_id", sa.String(length=120), nullable=True))
    op.add_column("recipe_cook_logs", sa.Column("completion_request_hash", sa.String(length=64), nullable=True))
    op.add_column("recipe_cook_logs", sa.Column("completion_result_json", sa.JSON(), nullable=True))
    op.create_unique_constraint(
        "uq_recipe_cook_logs_family_completion_request",
        "recipe_cook_logs",
        ["family_id", "completion_request_id"],
    )

def downgrade() -> None:
    op.drop_constraint(
        "uq_recipe_cook_logs_family_completion_request",
        "recipe_cook_logs",
        type_="unique",
    )
    op.drop_column("recipe_cook_logs", "completion_result_json")
    op.drop_column("recipe_cook_logs", "completion_request_hash")
    op.drop_column("recipe_cook_logs", "completion_request_id")
```

- [ ] **Step 4: Add model and compatible response fields**

```py
completion_request_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
completion_request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
completion_result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

Add the same named `UniqueConstraint` to `RecipeCookLog.__table_args__`. Add `replayed: bool = False` to `CookRecipeResponse`. Keep completion internals out of `serialize_recipe_cook_log`; they are server idempotency data, not a family-facing CookLog DTO.

- [ ] **Step 5: Verify migration shape and focused tests**

```bash
npm run backend:migrate
cd backend && ./.venv/bin/alembic current
./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "completion_fields or replayed" -q
```

Expected: Alembic current is `4f5a6b7c8d9e (head)` and tests PASS. Existing historical rows remain with three null columns.

- [ ] **Step 6: Commit schema persistence**

```bash
git add backend/alembic/versions/4f5a6b7c8d9e_add_recipe_cook_completion_idempotency.py \
  backend/app/models/domain.py backend/app/schemas/recipes.py backend/app/services/serializers.py \
  backend/tests/recipes/test_recipe_cooking.py
git commit -m "feat: persist recipe cook completion identity"
```

## Task 12: Centralize MealLog Food and Participant References

**Files:**

- Create: `backend/app/services/meal_log_references.py`
- Create: `backend/tests/meal_logs/__init__.py`
- Create: `backend/tests/meal_logs/test_meal_logs.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/services/ai_operations/meal_logs.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**

- Consumes: merged PR 73 `lock_inventory_targets(..., food_ids=...)`, current `Food`, `Membership`, `User`, and MealLog create/update/quick-add/AI writers.
- Produces: `ValidatedMealLogReferences`, `MealLogReferenceError`, and `lock_and_validate_meal_log_references(db, *, family_id, actor_user_id, food_ids, participant_user_ids, prelocked_foods=None)`.

- [ ] **Step 1: Write failing shared-boundary tests**

```py
@pytest.mark.parametrize("food_ids", [[], ["food-1", "food-1"], ["food-other-family"]])
def test_meal_log_references_reject_invalid_food_sets(db, family, user, food_ids):
    with pytest.raises(MealLogReferenceError):
        lock_and_validate_meal_log_references(
            db,
            family_id=family.id,
            actor_user_id=user.id,
            food_ids=food_ids,
            participant_user_ids=[],
        )

@pytest.mark.parametrize("participant_kind", ["unknown", "inactive_membership", "inactive_user", "other_family"])
def test_meal_log_references_reject_inactive_or_cross_family_participants(
    db, family, user, food, participant_for_kind, participant_kind,
):
    participant_id = participant_for_kind(participant_kind)
    with pytest.raises(MealLogReferenceError):
        lock_and_validate_meal_log_references(
            db,
            family_id=family.id,
            actor_user_id=user.id,
            food_ids=[food.id],
            participant_user_ids=[participant_id],
        )
```

Add API tests proving REST create, update participants, quick-add, AI MealLog, and AI recipe-cook call the same helper; monkeypatch the helper and assert each route/executor crosses it once.

- [ ] **Step 2: Run the new test and verify the missing-service failure**

```bash
cd backend && ./.venv/bin/python -m pytest tests/meal_logs/test_meal_logs.py -q
```

Expected: FAIL because `app.services.meal_log_references` does not exist.

- [ ] **Step 3: Implement sorted Food locks and active participant validation**

```py
@dataclass(frozen=True, slots=True)
class ValidatedMealLogReferences:
    foods_by_id: dict[str, Food]
    participant_user_ids: tuple[str, ...]

class MealLogReferenceError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

def lock_and_validate_meal_log_references(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    food_ids: Sequence[str],
    participant_user_ids: Sequence[str],
    prelocked_foods: Mapping[str, Food] | None = None,
) -> ValidatedMealLogReferences:
    requested_food_ids = [str(value).strip() for value in food_ids if str(value).strip()]
    if not requested_food_ids:
        raise MealLogReferenceError("meal_log_food_required", "餐食记录至少需要一个食物")
    if len(requested_food_ids) != len(set(requested_food_ids)):
        raise MealLogReferenceError("duplicate_meal_log_food", "同一食物不能重复加入一餐")

    ordered_food_ids = sorted(requested_food_ids)
    if prelocked_foods is None:
        try:
            foods_by_id = lock_inventory_targets(
                db,
                family_id=family_id,
                food_ids=ordered_food_ids,
            ).foods
        except InventoryTargetNotFoundError as exc:
            raise MealLogReferenceError("meal_log_food_not_found", "食物不存在或不属于当前家庭") from exc
    else:
        foods_by_id = {food_id: prelocked_foods[food_id] for food_id in ordered_food_ids if food_id in prelocked_foods}
        if len(foods_by_id) != len(ordered_food_ids) or any(food.family_id != family_id for food in foods_by_id.values()):
            raise MealLogReferenceError("meal_log_food_not_found", "食物不存在或不属于当前家庭")

    normalized_participants = tuple(sorted({str(value).strip() for value in participant_user_ids if str(value).strip()}))
    if not normalized_participants:
        normalized_participants = (actor_user_id,)
    active_ids = set(db.scalars(
        select(Membership.user_id)
        .join(User, User.id == Membership.user_id)
        .where(
            Membership.family_id == family_id,
            Membership.user_id.in_(normalized_participants),
            Membership.status == MembershipStatus.ACTIVE,
            User.is_active.is_(True),
        )
    ))
    if active_ids != set(normalized_participants):
        raise MealLogReferenceError("meal_log_participant_not_found", "参与成员不存在或不属于当前家庭")
    return ValidatedMealLogReferences(foods_by_id=foods_by_id, participant_user_ids=normalized_participants)
```

The `prelocked_foods` branch is mandatory for Cook completion because Cook has already acquired Food through the full Ingredient-first lock helper and must not reacquire it through a second partial lock call.

- [ ] **Step 4: Route every existing MealLog writer through the helper**

For REST create, collect all payload Food IDs and validate before constructing `MealLog`. For quick-add, validate the one Food before a MealLog/entry write. For update, validate participant IDs and the existing entry Food IDs before changing participants/ratings. For AI create/update, call the same helper before writing. Map `MealLogReferenceError` to the project’s current 404/422 style without exposing another family’s existence.

Use normalized participants when persisting:

```py
references = lock_and_validate_meal_log_references(
    db,
    family_id=membership.family_id,
    actor_user_id=user.id,
    food_ids=[entry.food_id for entry in payload.food_entries],
    participant_user_ids=payload.participant_user_ids,
)
meal_log.participant_user_ids = list(references.participant_user_ids)
```

- [ ] **Step 5: Run focused MealLog and AI tests**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py \
  tests/recipes/test_recipe_cooking.py \
  tests/ai_infra/test_workspace_approvals.py -k "meal_log or recipe_cook" -q
```

Expected: PASS for empty/duplicate/cross-family Food, default/current participant, inactive Membership/User, REST, quick-add, Cook helper injection, and AI writes.

- [ ] **Step 6: Commit the reference boundary**

```bash
git add backend/app/services/meal_log_references.py backend/tests/meal_logs/__init__.py \
  backend/tests/meal_logs/test_meal_logs.py backend/app/api/meal_logs.py \
  backend/app/services/ai_operations/meal_logs.py backend/tests/ai_infra/test_workspace_approvals.py
git commit -m "fix: enforce meal log reference boundaries"
```

## Task 13: Enforce Food-to-Plan Locks and Atomic Non-Recipe Plan Completion

**Files:**

- Create: `backend/app/services/food_plan_locking.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/app/services/ai_operations/meal_plans.py`
- Modify: `backend/tests/meal_logs/test_meal_logs.py`
- Modify: `backend/tests/recipes/test_food_workspace.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**

- Consumes: Task 12 MealLog references, merged `lock_inventory_targets(food_ids=...)`, current FoodPlan REST/recipe aliases/AI operation payloads.
- Produces: `FoodPlanWriteIntent`, `LockedFoodPlanTargets`, `FoodPlanConflict`, `discover_food_plan_write_intents(...)`, `lock_food_plan_write_intents(...)`, and `lock_plan_item_after_food(...)`; quick-add plan fields `food_plan_item_id` and `food_plan_item_base_updated_at`.

- [ ] **Step 1: Write failing lock-order and plan-completion tests**

```py
def test_plan_origin_quick_add_completes_one_plan_and_meal_atomically(client, auth_headers, planned_item):
    response = client.post(
        "/api/meal-logs/quick-add",
        headers=auth_headers,
        json={
            "food_id": planned_item.food_id,
            "date": planned_item.plan_date.isoformat(),
            "meal_type": planned_item.meal_type.value,
            "servings": 1.5,
            "food_plan_item_id": planned_item.id,
            "food_plan_item_base_updated_at": planned_item.updated_at.isoformat(),
        },
    )
    assert response.status_code == 201
    refreshed = load_plan_item(planned_item.id)
    assert refreshed.status == "cooked"
    assert refreshed.meal_log_id == response.json()["id"]

def test_completed_plan_returns_existing_meal_id_without_second_meal(client, auth_headers, cooked_item):
    response = post_quick_add_for_plan(client, auth_headers, cooked_item)
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "food_plan_item_already_completed",
        "message": "该菜单项已经记录完成",
        "meal_log_id": cooked_item.meal_log_id,
    }
```

Add a unit test that records SQL/helper calls for REST rebind and AI mixed create/update/delete/set-status operations and asserts all candidate Food IDs are locked once before any sorted FoodPlanItem ID.

- [ ] **Step 2: Run focused tests and observe missing base field/lock service**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py \
  tests/recipes/test_food_workspace.py \
  tests/ai_infra/test_workspace_approvals.py -k "food_plan and (lock or complete or target)" -q
```

Expected: FAIL because the base timestamp and whole-request parent lock protocol do not exist.

- [ ] **Step 3: Implement the plan intent and conflict contracts**

```py
@dataclass(frozen=True, slots=True)
class FoodPlanWriteIntent:
    action: Literal["create", "update", "delete", "set_status"]
    item_id: str | None
    target_food_id: str | None
    base_updated_at: datetime | None

@dataclass(frozen=True, slots=True)
class LockedFoodPlanTargets:
    foods_by_id: dict[str, Food]
    items_by_id: dict[str, FoodPlanItem]

class FoodPlanConflict(ValueError):
    def __init__(self, code: str, message: str, *, meal_log_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.meal_log_id = meal_log_id
```

`discover_food_plan_write_intents` performs no locking and records each existing item’s current Food. `lock_food_plan_write_intents` unions current/target Food IDs and item IDs, calls `lock_inventory_targets` once with sorted Food IDs, locks all plan rows in one sorted `SELECT ... FOR UPDATE`, then revalidates family, user, original Food, target Food, action, and base timestamp. If the locked set differs from discovery, raise `food_plan_targets_changed` and let the caller roll back/retry in a new transaction.

- [ ] **Step 4: Migrate every REST and AI FoodPlan writer**

Map `create_food_plan_item`, `update_food_plan_item`, `create_recipe_plan_item`, and `update_recipe_plan_item` into `FoodPlanWriteIntent` lists. Recipe aliases resolve their target Food before the lock set, then use the same service. For `_apply_meal_plan_operations`, pre-read every operation before applying any operation:

```py
intents = discover_food_plan_write_intents(
    db,
    family_id=family_id,
    user_id=user_id,
    operations=operations,
)
locked = lock_food_plan_write_intents(
    db,
    family_id=family_id,
    user_id=user_id,
    intents=intents,
)
for operation in operations:
    apply_locked_food_plan_operation(
        db,
        operation=operation,
        locked=locked,
        family_id=family_id,
        user_id=user_id,
    )
```

Do not lock by operation order and do not query a new Food after plan rows are locked.

- [ ] **Step 5: Add atomic non-Recipe plan completion**

Add to `QuickAddMealLogRequest`:

```py
food_plan_item_base_updated_at: datetime | None = None
```

For a plan source, pre-read candidate plan Food without a lock, lock that Food through Task 12, then call:

```py
plan_item = lock_plan_item_after_food(
    db,
    family_id=membership.family_id,
    user_id=user.id,
    item_id=payload.food_plan_item_id,
    expected_food_id=payload.food_id,
    base_updated_at=payload.food_plan_item_base_updated_at,
    require_planned=True,
)
```

Create a new exact MealLog and MealLogFood, set `status="cooked"`, `completed_at=utcnow()`, `meal_log_id=meal_log.id`, and commit once. If the item is already cooked, return the structured conflict with its existing MealLog ID and create nothing.

- [ ] **Step 6: Run plan and AI regressions**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/meal_logs/test_meal_logs.py \
  tests/recipes/test_food_workspace.py \
  tests/ai_infra/test_workspace_approvals.py -k "food_plan or meal_plan" -q
```

Expected: PASS for REST/alias/AI create/rebind, stale base timestamp, already completed, cross-user/cross-family, target-set changes, and atomic plan-origin MealLog.

- [ ] **Step 7: Commit the parent-lock protocol**

```bash
git add backend/app/services/food_plan_locking.py backend/app/schemas/meal_logs.py \
  backend/app/api/meal_logs.py backend/app/api/recipe_meta.py \
  backend/app/services/ai_operations/meal_plans.py backend/tests/meal_logs/test_meal_logs.py \
  backend/tests/recipes/test_food_workspace.py backend/tests/ai_infra/test_workspace_approvals.py
git commit -m "fix: serialize food plan references parent first"
```

## Task 14: Guard Recipe and Linked Food Deletion Against History Loss

**Files:**

- Create: `backend/app/services/recipe_deletion.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/services/ai_operations/recipes.py`
- Modify: `backend/tests/recipes/test_recipe_crud.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**

- Consumes: Recipe→Food relation, Task 12 Food parent lock boundary, Task 13 FoodPlan parent locks, current media/search cleanup.
- Produces: `RecipeHasHistoryError`, `lock_recipe_deletion_target(...)`, and `delete_recipe_with_guard(...)` shared by REST and AI.

- [ ] **Step 1: Write failing lifecycle tests**

```py
@pytest.mark.parametrize("reference_kind", ["cook_log", "meal_log_food", "food_plan_item"])
def test_recipe_delete_preserves_history_reference(client, auth_headers, referenced_recipe, reference_kind):
    attach_reference(referenced_recipe, reference_kind)
    response = client.delete(f"/api/recipes/{referenced_recipe.id}", headers=auth_headers)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "recipe_has_history"
    assert recipe_still_exists(referenced_recipe.id)
    assert linked_food_still_exists(referenced_recipe.id)

def test_blocked_delete_does_not_delete_media_or_search(client, auth_headers, referenced_recipe, spies):
    response = client.delete(f"/api/recipes/{referenced_recipe.id}", headers=auth_headers)
    assert response.status_code == 409
    spies.delete_media.assert_not_called()
    spies.delete_search.assert_not_called()
```

Add an AI approval test for `recipe.delete` with the same error and unchanged operation/reference state.

- [ ] **Step 2: Run deletion tests and observe current cascade loss**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_crud.py \
  tests/ai_infra/test_workspace_approvals.py -k "recipe and delete and history" -q
```

Expected: FAIL because REST/AI delete media/search and linked Food/Recipe without a locked reference guard.

- [ ] **Step 3: Implement Recipe→Food parent locks and locked recheck**

```py
class RecipeHasHistoryError(ValueError):
    code = "recipe_has_history"

    def __init__(self) -> None:
        super().__init__("这份做法已有菜单或餐食历史，暂时不能删除")

@dataclass(frozen=True, slots=True)
class LockedRecipeDeletionTarget:
    recipe: Recipe
    foods_by_id: dict[str, Food]

def lock_recipe_deletion_target(db: Session, *, family_id: str, recipe_id: str) -> LockedRecipeDeletionTarget:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == recipe_id)
        .options(selectinload(Recipe.foods))
        .with_for_update()
    )
    if recipe is None:
        raise LookupError("Recipe not found")
    food_ids = sorted(food.id for food in recipe.foods)
    foods_by_id = lock_inventory_targets(db, family_id=family_id, food_ids=food_ids).foods if food_ids else {}
    has_cook = db.scalar(select(RecipeCookLog.id).where(RecipeCookLog.recipe_id == recipe.id).limit(1)) is not None
    has_meal = bool(food_ids) and db.scalar(select(MealLogFood.id).where(MealLogFood.food_id.in_(food_ids)).limit(1)) is not None
    has_plan = bool(food_ids) and db.scalar(select(FoodPlanItem.id).where(FoodPlanItem.food_id.in_(food_ids)).limit(1)) is not None
    if has_cook or has_meal or has_plan:
        raise RecipeHasHistoryError()
    return LockedRecipeDeletionTarget(recipe=recipe, foods_by_id=foods_by_id)
```

The parent locks serialize with completion, MealLogFood creation, and FoodPlan creation/rebind. Reference queries happen after the locks. Do not use an unlocked precheck as the deciding guard.

- [ ] **Step 4: Move all delete side effects behind the guard**

`delete_recipe_with_guard` first calls `lock_recipe_deletion_target`, then clears media bindings/search documents for Recipe and linked Foods, deletes linked Foods and Recipe, records one activity, and leaves commit ownership with the REST/AI transaction boundary. Both current delete implementations call this function and remove their duplicated deletion loops.

- [ ] **Step 5: Run deletion and no-reference success tests**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_crud.py \
  tests/ai_infra/test_workspace_approvals.py -k "recipe and delete" -q
```

Expected: PASS; unreferenced Recipe deletion still works, all three history references block REST/AI, and blocked deletion leaves media/search/entities unchanged.

- [ ] **Step 6: Commit deletion safety**

```bash
git add backend/app/services/recipe_deletion.py backend/app/api/recipes.py \
  backend/app/services/ai_operations/recipes.py backend/tests/recipes/test_recipe_crud.py \
  backend/tests/ai_infra/test_workspace_approvals.py
git commit -m "fix: preserve recipe and food history on delete"
```

## Task 15: Define Canonical Completion Commands, Hashes, Claims, and Replay

**Files:**

- Create: `backend/app/services/recipe_cook_completion.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`

**Interfaces:**

- Consumes: Task 11 RecipeCookLog completion columns and response envelope.
- Produces: `RecipeCookCompletionCommand`, `RecipeCookInventoryExpectation`, `CompletionConflict`, `canonicalize_completion_command(...)`, `hash_completion_command(...)`, `load_completion_replay_if_present(...)`, `claim_completion(...)`, and `encode_completion_result(...)`.

- [ ] **Step 1: Write failing canonicalization/replay tests**

```py
def test_completion_hash_is_stable_for_participant_set_and_decimal_spelling():
    first = make_completion_command(servings=Decimal("2.00"), participant_user_ids=("user-b", "user-a", "user-a"))
    second = make_completion_command(servings=Decimal("2"), participant_user_ids=("user-a", "user-b"))
    assert hash_completion_command(first) == hash_completion_command(second)

def test_completion_hash_changes_for_business_inputs():
    base = make_completion_command(notes="少盐")
    assert hash_completion_command(base) != hash_completion_command(replace(base, notes="正常盐"))

def test_unknown_result_envelope_never_reexecutes(db, completed_cook_log):
    completed_cook_log.completion_result_json = {"version": 99, "response": {}}
    with pytest.raises(CompletionConflict) as raised:
        load_completion_replay_if_present(db, family_id=completed_cook_log.family_id, completion_request_id=completed_cook_log.completion_request_id, request_hash=completed_cook_log.completion_request_hash)
    assert raised.value.code == "completion_result_version_unsupported"
```

- [ ] **Step 2: Run focused tests and verify missing command functions**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "completion_hash or result_envelope" -q
```

Expected: FAIL because the completion module/functions do not exist.

- [ ] **Step 3: Define the canonical command and optional AI expectation**

```py
@dataclass(frozen=True, slots=True)
class RecipeCookInventoryExpectation:
    ingredient_boundaries: tuple[dict[str, Any], ...]
    preview_items: tuple[dict[str, Any], ...]
    shortages: tuple[dict[str, Any], ...]

@dataclass(frozen=True, slots=True)
class RecipeCookCompletionCommand:
    completion_request_id: str
    family_id: str
    actor_user_id: str
    recipe_id: str
    cook_date: date
    meal_type: MealType
    servings: Decimal
    participant_user_ids: tuple[str, ...]
    notes: str
    food_plan_item_id: str | None
    food_plan_item_base_updated_at: datetime | None
    result_note: str
    adjustments: str
    rating: int | None
    allow_partial_inventory_deduction: bool
    inventory_expectation: RecipeCookInventoryExpectation | None = None
```

REST uses `inventory_expectation=None`; AI maps its persisted boundary/preview snapshot into the expectation. `completion_request_id`, family, actor, Recipe, plan source/base version, feedback, and partial-deduction choice all enter the canonical business payload.

- [ ] **Step 4: Implement deterministic JSON and hash functions**

```py
def _decimal_string(value: Decimal) -> str:
    normalized = value.normalize()
    return "0" if normalized == 0 else format(normalized, "f")

def canonicalize_completion_command(command: RecipeCookCompletionCommand) -> dict[str, Any]:
    return {
        "family_id": command.family_id,
        "actor_user_id": command.actor_user_id,
        "recipe_id": command.recipe_id,
        "cook_date": command.cook_date.isoformat(),
        "meal_type": command.meal_type.value,
        "servings": _decimal_string(command.servings),
        "participant_user_ids": sorted(set(command.participant_user_ids)),
        "notes": command.notes,
        "food_plan_item_id": command.food_plan_item_id,
        "food_plan_item_base_updated_at": command.food_plan_item_base_updated_at.isoformat() if command.food_plan_item_base_updated_at else None,
        "result_note": command.result_note,
        "adjustments": command.adjustments,
        "rating": command.rating,
        "allow_partial_inventory_deduction": command.allow_partial_inventory_deduction,
        "inventory_expectation": jsonable_encoder(command.inventory_expectation),
    }

def hash_completion_command(command: RecipeCookCompletionCommand) -> str:
    encoded = json.dumps(
        canonicalize_completion_command(command),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
```

- [ ] **Step 5: Implement replay and first-write claim semantics**

`load_completion_replay_if_present` queries by family/request ID and returns `None` only when no claim exists. A hash mismatch raises `idempotency_key_reused`. Missing/invalid result data raises `completion_result_version_unsupported`; it never returns `None` for an existing claim. A valid v1 envelope reconstructs `CookRecipeResponse` with `replayed=True`.

`claim_completion` inserts a RecipeCookLog populated with command scalar fields, request ID/hash, null MealLog/result, and audit fields, then immediately flushes. It is called only after all read locks and before inventory/MealLog/plan/activity writes. On unique conflict, roll back the losing transaction and load the winner through `load_completion_replay_if_present`.

- [ ] **Step 6: Run canonicalization and duplicate-ID tests**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "completion_hash or idempotency or result_envelope" -q
```

Expected: PASS for stable equivalent hash, changed business input, valid replay, unknown envelope, same ID/different hash, and null historical fields.

- [ ] **Step 7: Commit the completion core**

```bash
git add backend/app/services/recipe_cook_completion.py backend/tests/recipes/test_recipe_cooking.py
git commit -m "feat: add canonical cook completion claims"
```

## Task 16: Implement the Shared Atomic Recipe Completion Transaction

**Files:**

- Modify: `backend/app/services/recipe_cook_completion.py`
- Modify: `backend/app/services/meal_log_references.py`
- Modify: `backend/app/services/food_plan_locking.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`

**Interfaces:**

- Consumes: Task 12 validated references, Task 13 plan locks, Task 15 command/claim/replay, PR 73 inventory locks/version helpers, current inventory plan/application functions, `ensure_food_for_recipe`, and activity logging.
- Produces: `complete_recipe_cook(db, command) -> CookRecipeResponse`, `normalize_and_validate_participant_user_ids(...)`, `lock_optional_completion_plan_item(...)`, and private candidate/revalidation/application helpers that enforce `Recipe → Ingredient → Food → State → Item → Shopping → Plan`.

- [ ] **Step 1: Write failing service-level completion tests**

```py
def test_complete_recipe_cook_creates_all_business_results(db, cooking_context):
    result = complete_recipe_cook(db, cooking_context.command)
    assert result.replayed is False
    assert result.meal_log_id is not None
    assert result.cook_log_id is not None
    assert db.get(RecipeCookLog, result.cook_log_id).meal_log_id == result.meal_log_id
    meal = db.get(MealLog, result.meal_log_id)
    assert meal.mood == ""
    assert meal.food_entries[0].note == ""
    assert meal.food_entries[0].servings == cooking_context.command.servings

def test_blocked_shortage_claims_nothing_and_writes_nothing(db, shortage_context):
    result = complete_recipe_cook(db, shortage_context.command)
    assert result.meal_log_id is None
    assert result.cook_log_id is None
    assert result.shortages
    assert count_rows(db, RecipeCookLog) == 0
    assert count_rows(db, MealLog) == 0

def test_plan_completion_updates_same_meal_id(db, planned_cooking_context):
    result = complete_recipe_cook(db, planned_cooking_context.command)
    plan = db.get(FoodPlanItem, planned_cooking_context.plan_item.id)
    assert plan.status == "cooked"
    assert plan.meal_log_id == result.meal_log_id
```

Add a forced-failure test after inventory mutation and assert inventory, MealLog, CookLog, plan, ActivityLog, and completion claim all roll back.

- [ ] **Step 2: Run service tests and verify incomplete completion behavior**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "complete_recipe_cook or blocked_shortage or plan_completion" -q
```

Expected: FAIL because `complete_recipe_cook` has not been implemented.

- [ ] **Step 3: Normalize participants before hashing and validate again at write boundary**

Extract this Task 12 primitive so REST/AI adapters and completion share one rule:

```py
def normalize_and_validate_participant_user_ids(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    participant_user_ids: Sequence[str],
) -> tuple[str, ...]:
    normalized = tuple(sorted({str(value).strip() for value in participant_user_ids if str(value).strip()}))
    if not normalized:
        normalized = (actor_user_id,)
    active_ids = set(db.scalars(active_family_participant_statement(family_id, normalized)))
    if active_ids != set(normalized):
        raise MealLogReferenceError("meal_log_participant_not_found", "参与成员不存在或不属于当前家庭")
    return normalized
```

`lock_and_validate_meal_log_references` calls this primitive rather than duplicating its query. The adapter replaces the command’s participant tuple with this normalized result before calculating the request hash.

- [ ] **Step 4: Implement the fixed completion sequence**

`discover_completion_inventory_candidates` also records `candidate_plan_food_id` when `food_plan_item_id` is present, and includes that Food in the one parent-lock call. Define the optional plan adapter exactly as:

```py
def lock_optional_completion_plan_item(
    db: Session,
    *,
    command: RecipeCookCompletionCommand,
    candidate_plan_food_id: str | None,
    locked_foods: Mapping[str, Food],
) -> FoodPlanItem | None:
    if command.food_plan_item_id is None:
        if command.food_plan_item_base_updated_at is not None:
            raise CompletionConflict("food_plan_source_invalid", "菜单版本不能脱离菜单项使用")
        return None
    if candidate_plan_food_id is None or candidate_plan_food_id not in locked_foods:
        raise CompletionConflict("food_plan_targets_changed", "菜单关联已变化，请刷新后重试")
    return lock_plan_item_after_food(
        db,
        family_id=command.family_id,
        user_id=command.actor_user_id,
        item_id=command.food_plan_item_id,
        expected_food_id=candidate_plan_food_id,
        base_updated_at=command.food_plan_item_base_updated_at,
        require_planned=True,
    )
```

Use this control-flow skeleton exactly; private helpers contain the existing detailed inventory plan/application logic and return typed values:

```py
def complete_recipe_cook(db: Session, command: RecipeCookCompletionCommand) -> CookRecipeResponse:
    normalized_participants = normalize_and_validate_participant_user_ids(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        participant_user_ids=command.participant_user_ids,
    )
    normalized_command = replace(command, participant_user_ids=normalized_participants)
    request_hash = hash_completion_command(normalized_command)
    replay = load_completion_replay_if_present(
        db,
        family_id=command.family_id,
        completion_request_id=command.completion_request_id,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay

    recipe = lock_recipe_for_completion(db, normalized_command)
    replay = load_completion_replay_if_present(
        db,
        family_id=command.family_id,
        completion_request_id=command.completion_request_id,
        request_hash=request_hash,
    )
    if replay is not None:
        return replay

    candidates = discover_completion_inventory_candidates(db, recipe=recipe, command=normalized_command)
    locked = lock_inventory_targets(
        db,
        family_id=command.family_id,
        ingredient_ids=candidates.ingredient_ids,
        food_ids=candidates.food_ids,
        state_ingredient_ids=candidates.required_state_ingredient_ids,
        optional_state_ingredient_ids=candidates.optional_state_ingredient_ids,
        inventory_item_ids=candidates.inventory_item_ids,
        shopping_item_ids=candidates.shopping_item_ids,
    )
    plan, shortages = rebuild_and_validate_completion_plan(
        db,
        recipe=recipe,
        command=normalized_command,
        candidates=candidates,
        locked=locked,
    )
    if shortages and not command.allow_partial_inventory_deduction:
        return blocked_shortage_response(recipe.id, shortages)

    cook_log = claim_completion(db, recipe=recipe, command=normalized_command, request_hash=request_hash)
    plan_item = lock_optional_completion_plan_item(
        db,
        command=normalized_command,
        candidate_plan_food_id=candidates.candidate_plan_food_id,
        locked_foods=locked.foods,
    )
    consumed_items = apply_locked_inventory_plan(
        db,
        plan=plan,
        locked=locked,
        actor_user_id=command.actor_user_id,
    )
    food = ensure_completion_food_after_claim(db, recipe=recipe, command=normalized_command, locked_foods=locked.foods)
    references = lock_and_validate_meal_log_references(
        db,
        family_id=command.family_id,
        actor_user_id=command.actor_user_id,
        food_ids=[food.id],
        participant_user_ids=normalized_participants,
        prelocked_foods={**locked.foods, food.id: food},
    )
    meal_log = create_completion_meal_log(db, command=normalized_command, food=food, references=references)
    finish_claimed_cook_log(cook_log, command=normalized_command, meal_log=meal_log)
    finish_optional_plan_item(plan_item, meal_log=meal_log, actor_user_id=command.actor_user_id)
    record_completion_activity(db, recipe=recipe, command=normalized_command, consumed_items=consumed_items)
    response = successful_completion_response(recipe.id, consumed_items, shortages, meal_log.id, cook_log.id)
    cook_log.completion_result_json = encode_completion_result(response)
    db.flush()
    return response
```

`discover_completion_inventory_candidates` performs no writes. `rebuild_and_validate_completion_plan` compares every locked target ID/version and raises `inventory_targets_changed` rather than acquiring a newly discovered parent after later locks. `claim_completion` remains the first write.

- [ ] **Step 5: Preserve exact minimal MealLog semantics**

`create_completion_meal_log` uses the command date/meal/servings/notes, normalized participants, `mood=""`, and one `MealLogFood(note="", rating=None)`. It never writes “已做菜谱” or “来自菜谱”. `RecipeCookLog` keeps result note, adjustments, and rating. A newly ensured Food is created only after the claim and while the Recipe lock is held.

- [ ] **Step 6: Run the full service regression set**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -q
```

Expected: PASS for exact/presence inventory, partial/no-partial shortage, missing relation ensure, direct/plan, stale/already-completed plan, participant/Food boundaries, rollback, replay, and ID/hash conflicts.

- [ ] **Step 7: Commit the atomic service**

```bash
git add backend/app/services/recipe_cook_completion.py backend/app/services/meal_log_references.py \
  backend/app/services/food_plan_locking.py backend/tests/recipes/test_recipe_cooking.py
git commit -m "feat: complete recipe cooking atomically"
```

## Task 17: Adapt the REST Cook Contract with Bounded Compatibility

**Files:**

- Modify: `backend/app/schemas/recipes.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`

**Interfaces:**

- Consumes: Task 16 completion service.
- Produces: deprecated nullable `create_meal_log`, optional B1 `completion_request_id`, optional `food_plan_item_base_updated_at`, `food_plan_item_id` preference over alias, structured 404/409 mapping, and compatibility usage logs.

- [ ] **Step 1: Write failing REST compatibility tests**

```py
@pytest.mark.parametrize("flag_payload", [{}, {"create_meal_log": True}, {"create_meal_log": False}])
def test_successful_rest_cook_always_records_meal(client, auth_headers, cook_payload, flag_payload):
    response = client.post(
        "/api/recipes/recipe-1/cook",
        headers=auth_headers,
        json={**cook_payload, **flag_payload, "completion_request_id": f"request-{len(flag_payload)}"},
    )
    assert response.status_code == 200
    assert response.json()["meal_log_id"]
    assert response.json()["cook_log_id"]

def test_response_loss_retry_returns_same_ids_and_replayed_true(client, auth_headers, cook_payload):
    payload = {**cook_payload, "completion_request_id": "stable-request-1"}
    first = client.post("/api/recipes/recipe-1/cook", headers=auth_headers, json=payload).json()
    second = client.post("/api/recipes/recipe-1/cook", headers=auth_headers, json=payload).json()
    assert second["meal_log_id"] == first["meal_log_id"]
    assert second["cook_log_id"] == first["cook_log_id"]
    assert second["replayed"] is True
```

Add tests for legacy missing completion ID, plan base timestamp, stale/already-completed plan, alias input, Recipe/plan mismatch, unknown result envelope, and same ID/different payload.

- [ ] **Step 2: Run REST tests and verify false/missing ID behavior fails**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "rest_cook or response_loss or legacy" -q
```

Expected: FAIL because the route still conditionally creates MealLog and has no replay contract.

- [ ] **Step 3: Change the compatible request/response schema**

```py
class CookRecipeRequest(BaseModel):
    servings: float = Field(gt=0)
    date: date_type | None = None
    meal_type: MealType | None = None
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    create_meal_log: bool | None = Field(default=None, deprecated=True)
    completion_request_id: str | None = Field(default=None, min_length=1, max_length=120)
    food_plan_item_id: str | None = None
    food_plan_item_base_updated_at: datetime | None = None
    recipe_plan_item_id: str | None = None
    result_note: str = ""
    adjustments: str = ""
    rating: int | None = Field(default=None, ge=1, le=5)
    allow_partial_inventory_deduction: bool = False
```

Keep preview using this parse shape but do not construct a completion command, claim a request ID, or write data.

- [ ] **Step 4: Replace route business logic with a thin adapter**

```py
completion_request_id = payload.completion_request_id or create_id("legacy-cook")
plan_item_id = payload.food_plan_item_id or payload.recipe_plan_item_id
command = RecipeCookCompletionCommand(
    completion_request_id=completion_request_id,
    family_id=membership.family_id,
    actor_user_id=user.id,
    recipe_id=recipe_id,
    cook_date=payload.date or today_for_family(membership.family_id),
    meal_type=payload.meal_type or MealType.DINNER,
    servings=Decimal(str(payload.servings)),
    participant_user_ids=tuple(payload.participant_user_ids),
    notes=payload.notes,
    food_plan_item_id=plan_item_id,
    food_plan_item_base_updated_at=payload.food_plan_item_base_updated_at,
    result_note=payload.result_note.strip(),
    adjustments=payload.adjustments.strip(),
    rating=payload.rating,
    allow_partial_inventory_deduction=payload.allow_partial_inventory_deduction,
)
result = complete_recipe_cook(db, command)
commit_session(db)
return result.model_dump(mode="json")
```

Map `CompletionConflict`, `FoodPlanConflict`, `MealLogReferenceError`, missing Recipe/plan, inventory conflict, and unit conversion to structured project-consistent errors. Do not inspect `create_meal_log` when building the command.

- [ ] **Step 5: Add bounded compatibility observability**

Emit structured, ID-redacted counters/log fields for `legacy_missing_completion_request_id`, `deprecated_create_meal_log_false`, `deprecated_recipe_plan_item_id`, and `legacy_missing_plan_base_updated_at`. Do not log participant IDs, notes, request IDs, or complete payloads.

- [ ] **Step 6: Run REST Cook and transaction tests**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -q
```

Expected: PASS; every successful completion has both IDs, shortage-blocked response has neither, false cannot bypass MealLog, and replay returns the first result.

- [ ] **Step 7: Commit the REST adapter**

```bash
git add backend/app/schemas/recipes.py backend/app/api/recipes.py backend/tests/recipes/test_recipe_cooking.py
git commit -m "feat: make REST cook completion replayable"
```

## Task 18: Add AI v1/v2 Readers and Route Execution Through Shared Completion

**Files:**

- Modify: `backend/app/services/ai_operations/registry_types.py`
- Modify: `backend/app/services/ai_operations/executor.py`
- Modify: `backend/app/services/ai_operations/approval_decisions.py`
- Modify: `backend/app/services/ai_operations/draft_specs/recipes.py`
- Modify: `backend/app/services/ai_operations/draft_specs/common.py`
- Modify: `backend/app/services/ai_operations/draft_specs/composite.py`
- Modify: `backend/app/services/ai_operations/recipe_cook.py`
- Modify: `backend/app/ai/tools/draft_validation.py`
- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/ai/tools/catalog/recipe.py`
- Create: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`

**Interfaces:**

- Consumes: Task 16 completion service and persisted `AIOperation.idempotency_key`.
- Produces: `RECIPE_COOK_ACCEPTED_VERSIONS={v1,v2}`, B1 `RECIPE_COOK_GENERATED_VERSION=v1`, version-aware `normalize_recipe_cook_draft`, `DraftExecuteContext.operation_idempotency_key`, `derive_child_operation_idempotency_key(...)`, stable retry operation reuse, and v1/v2 dispatch.

- [ ] **Step 1: Write failing dual-version behavior tests**

```py
def test_b1_accepts_v1_and_v2_but_generates_v1():
    assert accepted_recipe_cook_versions() == {
        "recipe_cook_operation.v1",
        "recipe_cook_operation.v2",
    }
    assert generated_recipe_cook_version() == "recipe_cook_operation.v1"

def test_v1_true_executes_shared_completion(db, ai_context):
    result, ids = execute_recipe_cook_draft(
        db,
        family_id=ai_context.family_id,
        user_id=ai_context.user_id,
        payload={**ai_context.v1_payload, "createMealLog": True},
        operation_idempotency_key="approval-1:recipe.cook:v1",
    )
    assert result["meal_log_id"]
    assert result["cook_log_id"] in ids

def test_v1_false_is_recoverable_and_has_no_side_effect(db, ai_context):
    with pytest.raises(AIConflictError, match="做菜完成规则已更新"):
        execute_recipe_cook_draft(
            db,
            family_id=ai_context.family_id,
            user_id=ai_context.user_id,
            payload={**ai_context.v1_payload, "createMealLog": False},
            operation_idempotency_key="approval-2:recipe.cook:v1",
        )
    assert count_recipe_cook_side_effects(db) == 0

def test_v2_rejects_create_meal_log_field(db, ai_context):
    with pytest.raises(ValueError):
        normalize_recipe_cook_draft(db, family_id=ai_context.family_id, user_id=ai_context.user_id, payload={**ai_context.v2_payload, "createMealLog": True})

def test_recipe_cook_retry_reuses_failed_operation_completion_key(db, ai_context, fail_after_business_write):
    first = decide_recipe_cook_approval(ai_context.approval, fail_after=fail_after_business_write)
    failed_operation = load_operation(first["operation"]["id"])
    retry = decide_recipe_cook_approval(first["retry_approval"])
    assert retry["operation"]["id"] == failed_operation.id
    assert load_completion_ids(failed_operation.idempotency_key) == (
        retry["business_entity"]["meal_log_id"],
        retry["business_entity"]["cook_log_id"],
    )
    assert count_recipe_cook_side_effects(db) == 1
```

Run the retry test for both a direct `recipe_cook` draft and a `composite_operation` fixture whose persisted child has `operationId="cook-step-1"`; both retries must reuse the same top-level operation and child completion key.

- [ ] **Step 2: Run the dual-version tests and observe v1-only/duplicated execution failures**

```bash
cd backend && ./.venv/bin/python -m pytest tests/ai_infra/test_ai_draft_contracts.py -q
```

Expected: FAIL because accepted/generated versions are not separated, AI still writes inventory/MealLog/CookLog itself, and retry approvals create a new operation key.

- [ ] **Step 3: Carry operation idempotency into executor context**

```py
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
```

Make the central executor require and transport the key explicitly:

```py
def execute_ai_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    draft_type: str,
    payload: dict[str, Any],
    assert_updated_at_matches: AssertUpdatedAt,
    operation_idempotency_key: str,
) -> tuple[dict[str, Any], list[str]]:
    return draft_operation_registry.execute(
        DraftExecuteContext(
            db=db,
            family_id=family_id,
            user_id=user_id,
            draft_type=draft_type,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
            operation_idempotency_key=operation_idempotency_key,
        )
    )
```

`apply_ai_approval_decision` passes the locked `AIOperation.idempotency_key`. For a `recipe_cook` retry approval, or a composite retry whose persisted steps contain `recipe_cook`, select the latest failed operation by current `family_id + draft_id + operation_type`, ordered by `created_at DESC, id DESC`, with `FOR UPDATE`. Reuse that row, reset `status="running"`, `error_message=None`, and `completed_at=None`, and preserve its ID/key; do not insert a second operation. This covers the case where completion committed but a later artifact/post-execute step failed and the outer decision recorded `pending_retry`: replay must repair the operation state without a second MealLog. Keep existing retry-row behavior unchanged for drafts with no recipe-cook effect.

Composite nested execution derives a bounded stable child key from the parent key and the persisted child operation ID; it never generates a fresh key on retry:

```py
def derive_child_operation_idempotency_key(parent_key: str, child_operation_id: str) -> str:
    digest = hashlib.sha256(f"{parent_key}\0{child_operation_id}".encode("utf-8")).hexdigest()
    return f"ai-child:{digest}"

child_context = replace(
    context,
    draft_type=step_draft_type,
    payload=step_payload,
    operation_idempotency_key=derive_child_operation_idempotency_key(
        context.operation_idempotency_key,
        step_operation_id,
    ),
)
```

Reject a composite recipe-cook step without a persisted `operationId`; list position is not an idempotency identity. Other operation semantics remain unchanged except that their context now receives the operation key.

- [ ] **Step 4: Separate persisted acceptance from generator-facing schema**

```py
RECIPE_COOK_V1 = "recipe_cook_operation.v1"
RECIPE_COOK_V2 = "recipe_cook_operation.v2"
RECIPE_COOK_ACCEPTED_VERSIONS = frozenset({RECIPE_COOK_V1, RECIPE_COOK_V2})
RECIPE_COOK_GENERATED_VERSION = RECIPE_COOK_V1
```

Create separate Pydantic/tool schema branches. v1 requires a boolean `createMealLog`; v2 forbids that field and always returns normalized data without it. In B1, tool output schema, skill manifest, and default normalizer remain v1 even though persisted v2 is readable/executable.

- [ ] **Step 5: Replace the duplicated AI executor**

```py
def execute_recipe_cook_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    operation_idempotency_key: str,
) -> tuple[dict[str, Any], list[str]]:
    schema_version = require_recipe_cook_schema_version(payload)
    if schema_version == RECIPE_COOK_V1 and payload.get("createMealLog") is not True:
        raise AIConflictError("做菜完成规则已更新，请刷新草稿并重新确认；完成后会自动记录餐食。")
    command = recipe_cook_command_from_ai_payload(
        family_id=family_id,
        user_id=user_id,
        payload=payload,
        completion_request_id=operation_idempotency_key,
    )
    result = complete_recipe_cook(db, command)
    if not result.meal_log_id or not result.cook_log_id:
        raise AIConflictError("当前库存不足，不能直接完成做菜，请刷新预览或先补采购")
    response = result.model_dump(mode="json")
    response["title"] = str(payload.get("title") or "")
    response["plan_item_id"] = command.food_plan_item_id
    response["cook_log"] = serialize_recipe_cook_log(db.get(RecipeCookLog, result.cook_log_id))
    return response, [result.cook_log_id]
```

Keep AI inventory expectation/version/preview data in the command so the shared service validates locked boundaries. Remove duplicated inventory mutation, MealLog, plan, CookLog, and activity writes from the AI module.

- [ ] **Step 6: Update B1 approval copy without switching the generator**

Change the base instruction to: `确认后会按当前预览扣减库存，并自动记录这餐；有关联菜单时会同时完成菜单项。` Keep the manifest and tool default on v1. Add redacted version counters for generated/normalized/executed v1/v2 and v1-false conflict.

- [ ] **Step 7: Run AI dual-version and shared-service tests**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/recipes/test_recipe_cooking.py -k "recipe_cook or completion" -q
```

Expected: PASS; B1 generates only v1, reads/normalizes/executes a persisted v2 fixture, v1 true records, v1 false conflicts before operation side effects, and operation retries reuse one completion ID.

- [ ] **Step 8: Commit the dual reader/executor**

```bash
git add backend/app/services/ai_operations/registry_types.py backend/app/services/ai_operations/executor.py \
  backend/app/services/ai_operations/approval_decisions.py backend/app/services/ai_operations/draft_specs/recipes.py \
  backend/app/services/ai_operations/draft_specs/common.py backend/app/services/ai_operations/draft_specs/composite.py \
  backend/app/services/ai_operations/recipe_cook.py \
  backend/app/ai/tools/draft_validation.py backend/app/ai/tools/schemas.py backend/app/ai/tools/catalog/recipe.py \
  backend/tests/ai_infra/test_ai_draft_contracts.py backend/tests/ai_infra/test_workspace_approvals.py
git commit -m "feat: accept AI recipe cook v1 and v2 safely"
```

## Task 19: Parse Client Capabilities and Gate Every Generation/Resume Path

**Files:**

- Create: `backend/app/ai/draft_contracts.py`
- Create: `backend/app/api/ai_contracts.py`
- Modify: `backend/app/schemas/ai.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/app/ai/tools/base.py`
- Modify: `backend/app/ai/tools/catalog/recipe.py`
- Modify: `backend/app/ai/workflows/state.py`
- Modify: `backend/app/ai/workflows/runner.py`
- Modify: `backend/app/ai/workflows/runner_support/graph_state_builder.py`
- Modify: `backend/app/ai/workflows/runner_support/orchestrator_context.py`
- Modify: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/test_workspace_chat.py`
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**

- Consumes: Task 18 accepted/generated constants.
- Produces: `AI_DRAFT_CONTRACTS_HEADER`, `DraftContractCapabilities`, `parse_draft_contract_capabilities(...)`, `select_recipe_cook_generation_version(...)`, `ClientContractUpgradeRequired`, FastAPI capability dependency, and request/run-scoped generation capability in workflow state.

- [ ] **Step 1: Write failing parser and end-to-end propagation tests**

```py
def test_capability_parser_accepts_known_tokens_only():
    capabilities = parse_draft_contract_capabilities(
        " recipe_cook_operation.v2,unknown.v9,recipe_cook_operation.v1 "
    )
    assert capabilities.recipe_cook_versions == frozenset({
        "recipe_cook_operation.v1",
        "recipe_cook_operation.v2",
    })

@pytest.mark.parametrize("entrypoint", [
    "chat", "chat_stream", "retry", "regenerate", "human_input", "human_input_stream", "approval", "approval_stream",
])
def test_generation_entrypoint_propagates_current_request_capability(entrypoint, ai_client, capability_spy):
    invoke_generation_entrypoint(ai_client, entrypoint, header="recipe_cook_operation.v1,recipe_cook_operation.v2")
    assert capability_spy.last_versions == {"recipe_cook_operation.v1", "recipe_cook_operation.v2"}
```

- [ ] **Step 2: Run generation-gate tests and observe missing dependency/state**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -k "capability or generation_entrypoint" -q
```

Expected: FAIL because the header is not parsed or propagated.

- [ ] **Step 3: Implement a generic contract parser and selector**

```py
AI_DRAFT_CONTRACTS_HEADER = "X-Culina-AI-Draft-Contracts"

@dataclass(frozen=True, slots=True)
class DraftContractCapabilities:
    values: frozenset[str]

    @property
    def recipe_cook_versions(self) -> frozenset[str]:
        return frozenset(value for value in self.values if value in RECIPE_COOK_ACCEPTED_VERSIONS)

def parse_draft_contract_capabilities(raw: str | None) -> DraftContractCapabilities:
    values = frozenset(
        token.strip()
        for token in (raw or "").split(",")
        if token.strip() in KNOWN_DRAFT_CONTRACTS
    )
    return DraftContractCapabilities(values=values)

def select_recipe_cook_generation_version(
    capabilities: DraftContractCapabilities,
    *,
    generated_version: str,
) -> str:
    if generated_version == RECIPE_COOK_V1:
        return RECIPE_COOK_V1
    if RECIPE_COOK_V2 in capabilities.recipe_cook_versions:
        return RECIPE_COOK_V2
    raise ClientContractUpgradeRequired()
```

This generic module registers known contract families and must not put `if draft_type == "recipe_cook"` special cases in the orchestrator runner.

- [ ] **Step 4: Add current-request capability to every route and run state**

Use a FastAPI header dependency:

```py
def get_ai_draft_contract_capabilities(
    value: Annotated[str | None, Header(alias=AI_DRAFT_CONTRACTS_HEADER)] = None,
) -> DraftContractCapabilities:
    return parse_draft_contract_capabilities(value)
```

Pass `generation_contracts=capabilities.values` into `AIApplicationService` for chat/stream, retry, regenerate, human-input normal/stream, and approval decision normal/stream. Add the values to the new run’s workflow state and provider/tool context. A continuation uses the current request’s capabilities, not values persisted by the original creator.

Use checkpoint-safe sorted strings in graph state and an immutable set at the tool boundary:

```py
class WorkspaceGraphState(TypedDict, total=False):
    generation_contracts: list[str]

# Add to ToolContext after current_message_attachments:
generation_contracts: frozenset[str] = field(default_factory=frozenset)

# GraphStateBuilder.build_initial_state(...)
"generation_contracts": sorted(generation_contracts),

# Add to the existing ToolContext(...) call in OrchestratorContextBuilder.build(...):
generation_contracts=frozenset(state.get("generation_contracts") or []),
```

Also update the direct `ToolContext(...)` constructor in `backend/app/ai/workspace_service.py` to receive `frozenset(generation_contracts)` from the current service call. These are the only two production `ToolContext` construction boundaries; the tests must fail if either drops the capability.

For human-input and approval resumes, do not trust the checkpoint’s original value. `WorkspaceGraphRunner` must use the current header value in the same LangGraph command that resumes execution:

```py
def _resume_command(
    *,
    resume_payload: dict[str, Any],
    generation_contracts: frozenset[str],
) -> Command:
    return Command(
        update={"generation_contracts": sorted(generation_contracts)},
        resume=resume_payload,
    )
```

`retry_run` and `regenerate_part` forward the current set into their delegated `chat(...)` call. `recipe_create_cook_draft` constructs `DraftContractCapabilities(context.generation_contracts)` and calls `select_recipe_cook_generation_version(...)` before returning a draft, so an unsupported v2 request fails before progressive draft persistence.

- [ ] **Step 5: Add an instance-level rollout probe**

Extend authenticated AI status/registry data with non-secret effective fields:

```json
{
  "recipe_cook_contracts": {
    "accepted_versions": ["recipe_cook_operation.v1", "recipe_cook_operation.v2"],
    "generated_version": "recipe_cook_operation.v1",
    "projection_version": 1
  }
}
```

The deployment probe must call each backend instance directly, not only the load balancer. Do not expose provider credentials or internal operation data.

- [ ] **Step 6: Run all generation/resume entrypoint tests**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -k "capability or retry or regenerate or human_input or approval" -q
```

Expected: PASS; B1 still generates v1, every route transports capabilities, and the selector can reject a future v2 generation attempt for an old client before draft persistence.

- [ ] **Step 7: Commit the generation gate**

```bash
git add backend/app/ai/draft_contracts.py backend/app/api/ai_contracts.py backend/app/schemas/ai.py \
  backend/app/api/ai.py backend/app/ai/workspace_service.py backend/app/ai/tools/base.py \
  backend/app/ai/tools/catalog/recipe.py backend/app/ai/workflows/state.py \
  backend/app/ai/workflows/runner.py backend/app/ai/workflows/runner_support/graph_state_builder.py \
  backend/app/ai/workflows/runner_support/orchestrator_context.py \
  backend/tests/ai_infra/test_ai_draft_contracts.py backend/tests/ai_infra/test_workspace_chat.py \
  backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "feat: gate AI draft generation by client contract"
```

## Task 20: Project Every Public AI DTO and Stream for the Current Viewer

**Files:**

- Create: `backend/app/services/ai_client_projection.py`
- Create: `backend/tests/ai_infra/test_ai_client_projection.py`
- Modify: `backend/app/services/serializers.py`
- Modify: `backend/app/api/ai_contracts.py`
- Modify: `backend/app/api/ai.py`
- Modify: `backend/app/ai/workspace_service.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/ai_infra/test_workspace_chat.py`
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**

- Consumes: Task 19 current viewer capabilities and all existing AI serializers/response assemblies.
- Produces: `project_ai_conversation`, `project_ai_message`, `project_ai_chat_response`, `project_ai_approval`, `project_ai_decision_response`, `project_ai_run_event`, `project_ai_sse_event`, `require_viewer_contract`, and `set_ai_client_aware_headers`.

- [ ] **Step 1: Write failing canonical-vs-projected response tests**

```py
def test_old_viewer_gets_upgrade_part_and_canonical_message_is_unchanged(v2_message):
    canonical = copy.deepcopy(v2_message.parts)
    projected = project_ai_message(serialize_ai_message(v2_message), old_capabilities())
    assert projected["parts"][0]["type"] == "error_recovery"
    assert projected["parts"][0].get("draft") is None
    assert projected["parts"][0].get("approval") is None
    assert v2_message.parts == canonical

def test_conversation_context_is_public_allowlist_for_every_viewer(conversation):
    conversation.context = {"activeRunId": "run-1", "fastApprovalDecisions": {"approval-1": {"draft": {}}}, "internal": "secret"}
    projected = project_ai_conversation(serialize_ai_conversation(conversation), new_capabilities())
    assert projected["context"] == {"activeRunId": "run-1"}

def test_old_viewer_metadata_drops_nested_v2_command_only(v2_message):
    projected = project_ai_message(serialize_ai_message(v2_message), old_capabilities())
    assert all(not artifact_contains_v2_command(item) for item in projected["metadata"]["artifacts"])
    assert v2_message.message_metadata["unrelatedMetric"] == 7
```

Add parameterized route tests for conversation list/visibility, history, recommendation selection, inventory-operation draft, chat, retry, regenerate, human-input, pending, decision, decision stream, progressive part, final SSE response, and any run event that contains a draft/approval payload.

- [ ] **Step 2: Run projector tests and expose current leaks**

```bash
cd backend && ./.venv/bin/python -m pytest tests/ai_infra/test_ai_client_projection.py -q
```

Expected: FAIL because context, metadata, message parts, and included DTOs are returned canonically to every viewer.

- [ ] **Step 3: Implement explicit deep-copy projection**

```py
UPGRADE_TEXT = "当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。"
PUBLIC_CONVERSATION_CONTEXT_KEYS = frozenset({"activeRunId"})

def project_ai_conversation(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    source = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    projected["context"] = {
        key: copy.deepcopy(source[key])
        for key in PUBLIC_CONVERSATION_CONTEXT_KEYS
        if key in source
    }
    return projected

def upgrade_message_part(part_id: str) -> dict[str, Any]:
    return {
        "id": part_id,
        "type": "error_recovery",
        "status": "blocked",
        "text": UPGRADE_TEXT,
    }

def project_ai_message(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    projected["parts"] = [project_message_part(part, capabilities) for part in projected.get("parts") or []]
    projected["metadata"] = project_message_metadata(projected.get("metadata") or {}, capabilities)
    return projected
```

Keep these exact contracts for the remaining public functions:

- `project_ai_chat_response(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]`
- `project_ai_approval(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]`
- `project_ai_decision_response(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]`
- `project_ai_run_event(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]`
- `project_ai_sse_event(event_name: str, data: dict[str, Any], *, viewer_capabilities: DraftContractCapabilities) -> tuple[str, dict[str, Any]]`
- `require_viewer_contract(schema_version: str | None, capabilities: DraftContractCapabilities) -> None`

`project_message_part` recognizes contract-bearing draft/approval structures by registered draft-contract extractors. Old viewers receive the upgrade part with no command. `project_ai_chat_response` applies the same rule to `message`, filters incompatible entries from `included.drafts/approvals`, and preserves unrelated cards/events. `project_ai_approval` projects one approval DTO, `project_ai_decision_response` projects its nested approval/draft/business response, and `project_ai_run_event` projects every message/artifact field using the same primitives. None mutates its input.

- [ ] **Step 4: Make serializers require projection context at public boundaries**

Stop returning raw `item.context` and `item.message_metadata` from public route assemblies. Keep canonical serializer helpers for internal workflow use, then require capabilities in public wrappers. All direct `AIMessageDTO` routes use the same `project_ai_message`; no route owns a local recursive key deletion.

- [ ] **Step 5: Gate pending/decision before mutation and stream output**

`require_viewer_contract` inspects the target approval/draft schema before approval status changes, operation claim, or the first stream event. An incompatible viewer receives:

```json
{
  "detail": {
    "code": "client_contract_upgrade_required",
    "message": "当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。"
  }
}
```

Return HTTP 409 for pending-list when any pending v2 cannot fit the list DTO, approval decision/detail/update/execute, and decision stream. Assert approval, draft, operation, and business tables are unchanged after rejection.

- [ ] **Step 6: Project progressive and final SSE through one function**

Before JSON encoding, call:

```py
event_name, projected_data = project_ai_sse_event(
    event_name,
    data,
    viewer_capabilities=capabilities,
)
yield encode(event_name, projected_data)
```

Apply this to chat, human-input continuation, and approval continuation. A progressive v2 `message_part` and final `response` must produce the same old-viewer upgrade semantics. Reconnect reads capabilities from the new request header.

- [ ] **Step 7: Add no-store and Vary headers**

```py
def set_ai_client_aware_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = AI_DRAFT_CONTRACTS_HEADER
```

Normal public AI DTO routes call this helper. SSE retains `no-cache, no-transform`, `X-Accel-Buffering: no`, and adds `Vary` for contract-aware intermediaries.

- [ ] **Step 8: Run all projection/route/stream tests**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_client_projection.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -q
```

Expected: PASS; old viewers cannot obtain an editable v2 command from any public DTO/REST/SSE/history path, new viewers receive permitted canonical response copies, and ORM JSON remains byte-for-byte unchanged.

- [ ] **Step 9: Commit the public projection boundary**

```bash
git add backend/app/services/ai_client_projection.py backend/tests/ai_infra/test_ai_client_projection.py \
  backend/app/services/serializers.py backend/app/api/ai_contracts.py backend/app/api/ai.py \
  backend/app/ai/workspace_service.py backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/ai_infra/test_workspace_chat.py backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "fix: project AI contracts for each viewer"
```

## Task 21: Prove MySQL Concurrency, Mixed-Version Safety, and the B1 Deployment Gate

**Files:**

- Modify: `backend/tests/inventory/test_inventory_mysql_concurrency.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`
- Modify: `backend/tests/recipes/test_recipe_crud.py`
- Modify: `backend/tests/meal_logs/test_meal_logs.py`
- Modify: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/test_ai_client_projection.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/ai_infra/test_workspace_chat.py`
- Modify: `backend/tests/ai_infra/test_workspace_streaming.py`

**Interfaces:**

- Consumes: Tasks 11–20 together and PR 73’s real MySQL `_run_barriered`/`mysql_concurrency_context` fixture.
- Produces: two-connection proofs for lock order/idempotency/reference deletion, full old/new client matrix, per-instance B1 probe evidence, and a deployable B1 branch whose generator remains v1.

- [ ] **Step 1: Extend the MySQL fixture with Recipe/Food/plan/Meal data**

Add deterministic Recipe, linked Food, ingredient state/batches, plan items, and command factories to the existing fixture. Keep `NullPool`, one Session per worker, the shared barrier, 30-second join timeout, and explicit final database assertions.

- [ ] **Step 2: Add the failing concurrent completion tests**

```py
def test_concurrent_identical_completion_request_replays_once(mysql_concurrency_context):
    ctx = mysql_concurrency_context
    command = ctx["completion_command"]("same-request")
    results = _run_barriered([
        lambda: ctx["complete_in_new_session"](command),
        lambda: ctx["complete_in_new_session"](command),
    ], timeout=30.0)
    assert {result.replayed for result in results} == {False, True}
    assert {result.meal_log_id for result in results} == {results[0].meal_log_id}
    assert ctx["count_completion_rows"]("same-request") == 1

def test_different_requests_complete_one_plan_once(mysql_concurrency_context):
    ctx = mysql_concurrency_context
    results = _run_barriered([
        lambda: ctx["complete_plan_in_new_session"]("request-a"),
        lambda: ctx["complete_plan_in_new_session"]("request-b"),
    ], timeout=30.0)
    assert sorted(result[0] for result in results) == ["conflict", "ok"]
    assert ctx["count_plan_meals"]() == 1
```

- [ ] **Step 3: Add all required parent-lock race tests**

Use two real connections for each pair and assert no thread hangs/deadlocks:

```text
Cook completion ↔ PR 73 reconciliation on the same Ingredient and Food
Cook completion ↔ shopping intake on the same Ingredient and Food
Cook completion ↔ inventory undo/history on the same Ingredient and Food
Recipe delete ↔ Cook completion
Recipe delete ↔ REST MealLogFood create
Recipe delete ↔ AI MealLogFood create
Recipe delete ↔ FoodPlanItem create
Recipe delete ↔ REST FoodPlanItem rebind
Recipe delete ↔ AI FoodPlanItem rebind
Cook completion ↔ AI plan rebind on the same Food and plan row
AI batch A ↔ AI batch B with reversed model operation order over the same Food/plan sets
```

Legal results are one committed side and one not-found/history/stale conflict, or one initial completion plus one replay for the same completion ID. Never accept two commits followed by cascaded history loss.

- [ ] **Step 4: Run MySQL races and verify they initially expose any reversed lock**

```bash
cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" \
  ./.venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py \
  -k "completion or recipe_delete or food_plan_targets" -q
```

Expected after implementation: PASS with no timeout/deadlock. Before fixing a discovered reversed path, retain its failing test and record the MySQL error/timeout evidence.

- [ ] **Step 5: Add and run the complete compatibility matrix**

Cover:

```text
old REST client true → B1 backend: records
old REST client false → B1 backend: records
compatible frontend true + extra fields → old backend fixture: parses and records
compatible frontend → B1 backend: replayable
pending AI v1 true → executes
pending AI v1 false → recoverable conflict/no mutation
persisted AI v2 → B1 reader/executor succeeds for v2 viewer
old viewer → every v2 output is upgrade projection or 409 gate
B1-only chat/tool generation → creates v1 only
```

Run:

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_recipe_crud.py \
  tests/recipes/test_food_workspace.py \
  tests/meal_logs/test_meal_logs.py \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_ai_client_projection.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -q
```

Expected: PASS.

- [ ] **Step 6: Run the full B1 verification**

```bash
npm run backend:test
cd backend && ./.venv/bin/alembic heads && ./.venv/bin/alembic current
cd .. && git diff --check
```

Expected: full backend PASS, exactly one `4f5a6b7c8d9e` migration head/current, and no whitespace errors. If merged prerequisites changed the head, expected output is the one verified descendant created in Task 11.

- [ ] **Step 7: Commit the MySQL and compatibility gate coverage**

```bash
git add backend/tests/inventory/test_inventory_mysql_concurrency.py \
  backend/tests/recipes/test_recipe_cooking.py backend/tests/recipes/test_recipe_crud.py \
  backend/tests/meal_logs/test_meal_logs.py backend/tests/ai_infra/test_ai_draft_contracts.py \
  backend/tests/ai_infra/test_ai_client_projection.py backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/ai_infra/test_workspace_chat.py backend/tests/ai_infra/test_workspace_streaming.py
git commit -m "test: prove cook completion concurrency and compatibility"
```

- [ ] **Step 8: Review B1 as one indivisible compatibility baseline**

Use `backend-code-audit` and `superpowers:requesting-code-review`. Review family/user scope, first-write claim, result replay, deletion/reference lock serialization, AI canonical JSON immutability, and every public route/stream. Fix all P0/P1 findings and rerun the focused race or projector test plus the full B1 suite.

- [ ] **Step 9: Execute the B1 production cutover gate**

Use this fixed sequence:

```text
back up database
pause REST Recipe deletion and AI recipe.delete approval execution
drain all old backend instances
run Alembic upgrade
deploy complete B1 build to every REST/AI/worker instance
probe every instance: accepted={v1,v2}, generated=v1, projector=1
run authenticated disposable-family Cook/replay/MealLog/plan/delete smoke
verify parent-lock and no-v2-leak probes
reopen deletion
```

If old instances cannot be drained while deletion is paused, use blue/green or a maintenance window. Do not perform an unguarded rolling deployment across this parent-lock boundary.

- [ ] **Step 10: Finish B1 before B2 work**

Use `superpowers:finishing-a-development-branch`, push/open/review/merge B1, and confirm production probes. Create `feature/cook-completion-experience` only from the merged B1 `main`.

## PR B2 Release Unit 1 — Compatible Cook and AI Frontend

## Task 22: Launch Direct and Plan Cook with Explicit Context

**Files:**

- Modify: `frontend/src/components/foods/FoodQuickMealDialog.tsx`
- Modify: `frontend/src/components/foods/FoodQuickMealDialog.test.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Modify: `frontend/src/components/foods/FoodWorkspaceModel.ts`
- Modify: `frontend/src/components/foods/useFoodWorkspaceState.ts`
- Modify: `frontend/src/app/useAppHomeHandlers.ts`
- Modify: `frontend/src/app/useAppHomeHandlers.test.ts`
- Modify: `frontend/src/features/eat/EatWorkspace.tsx`
- Modify: `frontend/src/features/eat/EatWorkspace.test.tsx`

**Interfaces:**

- Consumes: Task 1 `CookLaunchContext`, Task 4 plan detail, B1 plan base timestamp, existing `TouchStepperField` and `WorkspaceModal`.
- Produces: direct Cook target with confirmed date/meal/servings and `source.kind='direct'`; plan Cook target with loaded plan ID/base timestamp and `source.kind='plan'`; no implicit plan creation.

- [ ] **Step 1: Write failing direct/plan launch tests**

```tsx
it('launches direct Cook with the user-confirmed context and no plan mutation', async () => {
  const user = userEvent.setup();
  const createFoodPlanItem = vi.fn();
  const navigate = vi.fn();
  renderFoodQuickMeal({ action: 'cook', createFoodPlanItem, navigate, recipeServings: 2 });
  await user.click(within(screen.getByRole('listbox', { name: '选择日期' })).getByRole('button', { name: /7\/15/ }));
  await user.click(screen.getByRole('button', { name: '午餐' }));
  await user.click(screen.getByRole('button', { name: '份量增加' }));
  await user.click(screen.getByRole('button', { name: '开始做' }));
  expect(createFoodPlanItem).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
    workspace: 'eat',
    view: 'cook',
    launchContext: {
      date: '2026-07-15',
      mealType: 'lunch',
      servings: 2.5,
      source: { kind: 'direct' },
    },
  }));
});

it('launches plan Cook from the loaded detail version', async () => {
  const item = makeFoodPlanItem({ id: 'plan-1', updated_at: '2026-07-12T10:00:00Z' });
  expect(buildPlanCookLaunchContext(item, makeRecipe({ servings: 4 }))).toEqual({
    date: item.plan_date,
    mealType: item.meal_type,
    servings: 4,
    source: { kind: 'plan', foodPlanItemId: 'plan-1', planItemBaseUpdatedAt: item.updated_at },
  });
});
```

- [ ] **Step 2: Run focused tests and observe implicit plan creation/missing servings**

```bash
npm --prefix frontend run test -- FoodQuickMealDialog FoodWorkspace useAppHomeHandlers EatWorkspace
```

Expected: FAIL because Cook quick action creates a FoodPlanItem and the dialog has no servings field.

- [ ] **Step 3: Add Cook-only servings to the existing dialog**

```tsx
{props.action === 'cook' ? (
  <TouchStepperField
    label="份量"
    value={draft.servings}
    min={0.5}
    step={0.5}
    onChange={(servings) => setDraft((current) => ({ ...current, servings }))}
  />
) : null}
```

Initialize servings from `recipe.servings`; preserve the existing quick-add “eat” path and payload. Change Cook copy to `确认日期、餐次和份量后开始做`. Keep controls at least 44px and use existing modal/form classes plus scoped `eat-*` additions.

- [ ] **Step 4: Delete implicit plan creation from direct Cook**

Replace:

```text
createFoodPlanItem → onStartRecipe(recipeId, planItem.id)
```

with one semantic target:

```ts
props.navigate({
  workspace: 'eat',
  view: 'cook',
  foodId: food.id,
  recipeId: recipe.id,
  launchContext: {
    date: draft.date,
    mealType: draft.mealType,
    servings: draft.servings,
    source: { kind: 'direct' },
  },
});
```

Home direct recommendations use the same dialog/target, not a Recipe-ID-only shortcut. Plan actions load detail by ID, reject stale/deleted/non-Recipe plans visibly, and build the plan source from the response `updated_at`.

- [ ] **Step 5: Run direct/plan launch regressions**

```bash
npm --prefix frontend run test -- FoodQuickMealDialog FoodWorkspace useAppHomeHandlers EatWorkspace
```

Expected: PASS; direct Cook creates no plan, non-default Home date/meal/servings survive into the target, and plan Cook uses the exact loaded base timestamp.

- [ ] **Step 6: Commit launch semantics**

```bash
git add frontend/src/components/foods/FoodQuickMealDialog.tsx frontend/src/components/foods/FoodQuickMealDialog.test.tsx \
  frontend/src/components/foods/FoodWorkspace.tsx frontend/src/components/foods/FoodWorkspace.test.ts \
  frontend/src/components/foods/FoodWorkspaceModel.ts frontend/src/components/foods/useFoodWorkspaceState.ts \
  frontend/src/app/useAppHomeHandlers.ts frontend/src/app/useAppHomeHandlers.test.ts \
  frontend/src/features/eat/EatWorkspace.tsx frontend/src/features/eat/EatWorkspace.test.tsx
git commit -m "feat: launch cooking with explicit context"
```

## Task 23: Add Scoped Cook Session v3 and Active Resume Descriptor

**Files:**

- Create: `frontend/src/components/recipes/recipeCookSessionStorage.ts`
- Create: `frontend/src/components/recipes/recipeCookSessionStorage.test.ts`
- Create: `frontend/src/features/eat/ActiveCookResumeCard.tsx`
- Create: `frontend/src/features/eat/ActiveCookResumeCard.test.tsx`
- Modify: `frontend/src/components/recipes/RecipeWorkspaceModel.ts`
- Modify: `frontend/src/components/recipes/useRecipeCookState.ts`
- Modify: `frontend/src/components/recipes/workspaceModel.test.ts`
- Modify: `frontend/src/features/eat/EatWorkspace.tsx`
- Modify: `frontend/src/features/eat/EatWorkspace.test.tsx`
- Modify: `frontend/src/lib/storage.ts`

**Interfaces:**

- Consumes: authenticated `user.id`, current membership `family_id`, Task 22 launch context, existing timer/step/feedback session state, old exact v1/v2 key format.
- Produces: `RecipeCookSessionStateV3`, `PersistedRecipeCookSessionV3`, `ActiveCookDescriptor`, scoped key builders, parser result union, `loadOrMigrateCookSession`, `saveCookSessionV3`, `compareAndClearCookSession`, and one active descriptor per scope.

- [ ] **Step 1: Write failing scope/version/race tests**

```ts
it('builds distinct keys for users, families, direct, and plan sessions', () => {
  expect(buildCookSessionV3Key({ userId: 'u1', familyId: 'f1' }, 'r1', { kind: 'direct' }))
    .toBe('culina-recipe-cook-session-v3:u1:f1:r1:direct');
  expect(buildCookSessionV3Key({ userId: 'u1', familyId: 'f2' }, 'r1', { kind: 'plan', foodPlanItemId: 'p1' }))
    .toBe('culina-recipe-cook-session-v3:u1:f2:r1:plan:p1');
});

it('preserves an unknown future version without deleting storage', () => {
  const storage = memoryStorage({ [CURRENT_KEY]: JSON.stringify({ version: 4, savedAt: NOW }) });
  expect(readCookSessionV3(storage, CURRENT_KEY)).toEqual({ kind: 'incompatible', version: 4 });
  expect(storage.getItem(CURRENT_KEY)).not.toBeNull();
});

it('does not clear a newer descriptor from a stale tab', () => {
  const old = descriptor('recipe-old', null, '2026-07-12T08:00:00Z');
  const newer = descriptor('recipe-new', null, '2026-07-12T09:00:00Z');
  const storage = memoryStorage({ [DESCRIPTOR_KEY]: JSON.stringify(newer) });
  expect(compareAndClearActiveCook(storage, SCOPE, old)).toBe(false);
  expect(readActiveCook(storage, SCOPE)).toEqual(newer);
});

it('migrates only the exact verified legacy key once and creates a stable completion ID', () => {
  const migrated = loadOrMigrateCookSession(makeVerifiedMigrationInput());
  expect(migrated.session.completionRequestId).toMatch(/^cook-/);
  expect(loadOrMigrateCookSession(makeVerifiedMigrationInput()).session.completionRequestId)
    .toBe(migrated.session.completionRequestId);
});
```

Add tests for 24-hour direct expiry, 7-day plan expiry, other user/family preservation, existing v3 precedence, explicit abandon, current-scope 404 cleanup only, no descriptor auto-task restore, and raw old-key parser never seeing v3.

- [ ] **Step 2: Run storage tests and verify missing v3 module**

```bash
npm --prefix frontend run test -- recipeCookSessionStorage
```

Expected: FAIL because the scoped v3 module does not exist.

- [ ] **Step 3: Define v3 session and descriptor contracts**

```ts
export type RecipeCookSessionScope = { userId: string; familyId: string };

export type RecipeCookSessionStateV3 = Omit<RecipeCookSessionState, 'createMealLog'> & {
  completionRequestId: string;
  source: 'direct' | 'plan';
  planItemId: string | null;
  planItemBaseUpdatedAt: string | null;
};

export type PersistedRecipeCookSessionV3 = {
  version: 3;
  savedAt: string;
  source: 'direct' | 'plan';
  planItemId: string | null;
  session: RecipeCookSessionStateV3;
};

export type ActiveCookDescriptor = {
  version: 1;
  recipeId: string;
  foodPlanItemId: string | null;
  savedAt: string;
};
```

Key builders accept only a scope obtained from authenticated App state. They do not accept a scope embedded in navigation or storage payload.

- [ ] **Step 4: Implement explicit parser results and bounded migration**

```ts
export type CookSessionReadResult =
  | { kind: 'missing' }
  | { kind: 'ready'; bundle: PersistedRecipeCookSessionV3 }
  | { kind: 'expired'; bundle: PersistedRecipeCookSessionV3 }
  | { kind: 'invalid' }
  | { kind: 'incompatible'; version: number | null };
```

Invalid current v3 data may be removed only when it is provably malformed v3 for the current exact key. A future numeric version remains. Legacy migration receives verified Recipe, unique Food relation, and optional current-user plan detail from the caller; it reads only the exact old key, ignores legacy `createMealLog`, generates one `completionRequestId`, writes v3, and never enumerates storage.

- [ ] **Step 5: Connect v3 persistence to Cook state**

Initialize a new session from `CookLaunchContext`; if the same unexpired scoped session exists, restore it without overwriting date/meal/servings/timers/feedback/request ID. Save after meaningful state changes. On another descriptor in the same scope, show `继续上次` and `放弃并开始新的`; never overwrite silently.

Use compare-before-delete on success, abandon, expiry, and entity 404:

```ts
compareAndClearCookSession({
  storage,
  scope,
  expectedDescriptor: descriptorAtSessionStart,
  expectedSessionKey: sessionKeyAtStart,
});
```

- [ ] **Step 6: Add the compact Discover resume entry**

`ActiveCookResumeCard` appears only for a valid descriptor in the current scope. It uses current card/state components, not a hero. Clicking resolves Recipe, unique Food, and optional plan by ID before opening Cook. Missing/deleted/expired targets clear only the matching current-scope keys and show a recoverable toast.

- [ ] **Step 7: Run session/hook/workspace tests**

```bash
npm --prefix frontend run test -- recipeCookSessionStorage workspaceModel useRecipeCookState ActiveCookResumeCard EatWorkspace
```

Expected: PASS for isolation, TTLs, migration, future preservation, multi-tab compare-delete, explicit collision choice, refresh resume entry, and exact completion ID reuse.

- [ ] **Step 8: Commit scoped recovery**

```bash
git add frontend/src/components/recipes/recipeCookSessionStorage.ts \
  frontend/src/components/recipes/recipeCookSessionStorage.test.ts \
  frontend/src/features/eat/ActiveCookResumeCard.tsx frontend/src/features/eat/ActiveCookResumeCard.test.tsx \
  frontend/src/components/recipes/RecipeWorkspaceModel.ts frontend/src/components/recipes/useRecipeCookState.ts \
  frontend/src/components/recipes/workspaceModel.test.ts frontend/src/features/eat/EatWorkspace.tsx \
  frontend/src/features/eat/EatWorkspace.test.tsx frontend/src/lib/storage.ts
git commit -m "feat: persist scoped recoverable cook sessions"
```

## Task 24: Make Cook Finish Always Record and Navigate by Exact MealLog ID

**Files:**

- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/recipesApi.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspaceModel.ts`
- Modify: `frontend/src/components/recipes/useRecipeCookState.ts`
- Modify: `frontend/src/components/recipes/RecipeCookFinishDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipeCookFinishDialog.test.tsx`
- Modify: `frontend/src/components/recipes/RecipeCookView.tsx`
- Modify: `frontend/src/features/eat/EatWorkspace.tsx`
- Modify: `frontend/src/features/eat/EatWorkspace.test.tsx`

**Interfaces:**

- Consumes: Task 23 v3 session/request ID and B1 REST contract.
- Produces: compatible payload fixed to `create_meal_log: true`, stable request/base version, no UI toggle, exact success IDs, `replayed` parsing, session cleanup guard, and “查看这餐” semantic navigation.

- [ ] **Step 1: Write failing finish/payload/success tests**

```ts
it('builds a compatible always-record completion payload', () => {
  expect(buildCookPayload(makeV3Session({
    completionRequestId: 'cook-request-1',
    source: 'plan',
    planItemId: 'plan-1',
    planItemBaseUpdatedAt: '2026-07-12T10:00:00Z',
  }))).toMatchObject({
    create_meal_log: true,
    completion_request_id: 'cook-request-1',
    food_plan_item_id: 'plan-1',
    food_plan_item_base_updated_at: '2026-07-12T10:00:00Z',
  });
});

it('has no MealLog opt-out in the finish dialog', () => {
  renderCookFinishDialog();
  expect(screen.queryByRole('checkbox', { name: /餐食记录/ })).not.toBeInTheDocument();
  expect(screen.getByText('完成后会自动记入吃过的')).toBeInTheDocument();
  expect(screen.getByText('将生成 1 条餐食记录')).toBeInTheDocument();
});

it('keeps the session when a nominal response is missing either result ID', async () => {
  const clear = vi.fn();
  await handleCookResult({ recipe_id: 'r1', consumed_items: [], shortages: [], meal_log_id: null, cook_log_id: 'c1' }, { clear });
  expect(clear).not.toHaveBeenCalled();
  expect(screen.getByText('完成结果不完整，请重试')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused finish tests and observe old toggle/cleanup behavior**

```bash
npm --prefix frontend run test -- RecipeCookFinishDialog workspaceModel useRecipeCookState EatWorkspace cacheInvalidation
```

Expected: FAIL because session state/payload/UI still contain `createMealLog` and success cleanup is too eager.

- [ ] **Step 3: Update frontend transport types**

```ts
export interface CookRecipeRequest {
  servings: number;
  date?: string;
  meal_type?: MealType;
  participant_user_ids?: string[];
  notes?: string;
  create_meal_log: true;
  completion_request_id: string;
  food_plan_item_id?: string;
  food_plan_item_base_updated_at?: string;
  result_note?: string;
  adjustments?: string;
  rating?: number;
  allow_partial_inventory_deduction?: boolean;
}

export interface CookRecipeResponse {
  recipe_id: string;
  consumed_items: CookRecipeConsumedItem[];
  shortages: CookRecipeShortage[];
  meal_log_id: string | null;
  cook_log_id: string | null;
  replayed?: boolean;
}
```

Do not expose a caller parameter that can set `create_meal_log` false. Do not send `recipe_plan_item_id`.

- [ ] **Step 4: Remove the record choice from session and dialog**

Keep four steps with labels `库存核对 / 这餐的信息 / 本次反馈 / 确认完成`. Date, meal, and servings remain editable. Only feedback has a skip action. Summary is fixed:

```tsx
<strong>{`将处理 ${previewItems.length} 项库存`}</strong>
<strong>将生成 1 条餐食记录</strong>
<strong>{hasFeedback ? '本次反馈：已填写' : '本次反馈：未填写'}</strong>
```

Pending mutation blocks close/backdrop/Escape. Inventory/preview conflict keeps date, meal, servings, timers, and feedback.

- [ ] **Step 5: Enforce exact success and safe cleanup**

Treat first response or `replayed=true` as success only when both IDs are non-empty. Then invalidate inventory state/overview/operations, foods, recipes/discovery/stats, meal logs, FoodPlan root/detail, Home action-center queries from merged PR 72, shopping/maintenance freshness identified in Task 0, and activity logs. Compare-and-clear the v3 session/descriptor after invalidation is scheduled.

Render:

```text
烹饪完成
已更新库存，并把番茄炒蛋记到今天的晚餐。
[完成并返回] [查看这餐]
```

`查看这餐` calls `navigate({ workspace: 'eat', view: 'history', mealLogId: result.meal_log_id })`; it never searches by date/meal.

- [ ] **Step 6: Run Cook/UI/cache regressions**

```bash
npm --prefix frontend run test -- RecipeCookFinishDialog workspaceModel useRecipeCookState EatWorkspace cacheInvalidation
npm --prefix frontend run typecheck
```

Expected: PASS; no `createMealLog` exists in v3/UI business state, the compatibility transport is literal true, failures retain recovery state, and success uses exact IDs.

- [ ] **Step 7: Commit finish semantics**

```bash
git add frontend/src/api/types.ts frontend/src/api/recipesApi.ts frontend/src/api/cacheInvalidation.ts \
  frontend/src/api/cacheInvalidation.test.ts frontend/src/components/recipes/RecipeWorkspaceModel.ts \
  frontend/src/components/recipes/useRecipeCookState.ts frontend/src/components/recipes/RecipeCookFinishDialog.tsx \
  frontend/src/components/recipes/RecipeCookFinishDialog.test.tsx frontend/src/components/recipes/RecipeCookView.tsx \
  frontend/src/features/eat/EatWorkspace.tsx frontend/src/features/eat/EatWorkspace.test.tsx
git commit -m "feat: always record completed cooking"
```

## Task 25: Ship a v1/v2-Safe AI Client and Pass the Compatible-Frontend Gate

**Files:**

- Modify: `frontend/src/api/aiApi.ts`
- Modify: `frontend/src/api/aiApi.test.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/ai/AiApprovalPanel.tsx`
- Modify: `frontend/src/components/ai/AiApprovalPanel.test.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.tsx`
- Modify: `frontend/src/components/ai/AiConversationThread.test.tsx`
- Modify: `frontend/src/components/ai/useAiConversationStreams.ts`
- Modify: `frontend/src/components/ai/AiWorkspace.test.tsx`
- Modify: `frontend/scripts/smoke.mjs`

**Interfaces:**

- Consumes: B1 capability header/projector, v1/v2 DTOs, current request/stream helpers.
- Produces: `AI_DRAFT_CONTRACT_CAPABILITIES`, `aiContractHeaders()`, one contract-aware normal request wrapper, stream headers on every reconnect, read-only v1 record semantic, v2 UI with no record field, and production evidence while generator remains v1.

- [ ] **Step 1: Write failing request-header coverage tests**

```ts
it.each([
  'getAiConversations',
  'updateAiConversationVisibility',
  'chatAi',
  'retryAiRun',
  'getAiMessages',
  'recordAiRecommendationSelection',
  'createAiInventoryOperationDraft',
  'getPendingAiApprovals',
  'decideAiApproval',
  'respondAiHumanInput',
] as const)('%s sends both recipe-cook capabilities', async (method) => {
  await invokeAiMethod(method);
  expect(lastFetchHeaders().get('X-Culina-AI-Draft-Contracts'))
    .toBe('recipe_cook_operation.v1,recipe_cook_operation.v2');
});

it.each(['streamChatAi', 'streamAiApprovalDecision', 'streamAiHumanInputResponse'] as const)(
  '%s sends capability on every stream connection',
  async (method) => {
    await invokeAiStream(method);
    expect(lastFetchHeaders().get('X-Culina-AI-Draft-Contracts'))
      .toBe('recipe_cook_operation.v1,recipe_cook_operation.v2');
  },
);
```

- [ ] **Step 2: Write failing approval-panel version tests**

```tsx
it('shows v1 createMealLog as read-only legacy meaning', () => {
  renderApproval(makeRecipeCookApproval('recipe_cook_operation.v1', { createMealLog: true }));
  expect(screen.getByText('完成后会记录这餐')).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: /记录/ })).not.toBeInTheDocument();
});

it('never renders or submits createMealLog for v2', async () => {
  const user = userEvent.setup();
  const onDecision = vi.fn();
  renderApproval(makeRecipeCookApproval('recipe_cook_operation.v2', {}), onDecision);
  expect(screen.queryByText(/createMealLog|只扣库存|不同步/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '确认做菜' }));
  expect(onDecision.mock.calls[0][0].values.draft).not.toHaveProperty('createMealLog');
});

it('marks v1 false as requiring regeneration instead of making it editable', () => {
  renderApproval(makeRecipeCookApproval('recipe_cook_operation.v1', { createMealLog: false }));
  expect(screen.getByText('这份旧草稿需要刷新后重新确认')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认做菜' })).toBeDisabled();
});
```

- [ ] **Step 3: Run frontend AI tests and observe missing headers/unsafe false default**

```bash
npm --prefix frontend run test -- aiApi AiApprovalPanel AiConversationThread AiWorkspace
```

Expected: FAIL because requests omit the header and absent v2 fields are interpreted as false/editable.

- [ ] **Step 4: Implement one normal/stream capability source**

```ts
export const AI_DRAFT_CONTRACT_CAPABILITIES = [
  'recipe_cook_operation.v1',
  'recipe_cook_operation.v2',
] as const;

function aiContractHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  headers.set('X-Culina-AI-Draft-Contracts', AI_DRAFT_CONTRACT_CAPABILITIES.join(','));
  return headers;
}

function aiRequest<T>(path: string, init: RequestInit = {}) {
  return request<T>(path, { ...init, headers: aiContractHeaders(init.headers) });
}
```

Use `aiRequest` for every workspace/conversation/message/pending/decision method named in the design. In `streamAiResponse`, construct headers through `aiContractHeaders` before adding auth/content type. A reconnect calls the function again rather than reusing a response-derived capability.

- [ ] **Step 5: Make Recipe Cook approval version-explicit**

Read `approval.draft_schema_version`/draft `schemaVersion` and use an exhaustive version branch. v1 true is read-only “会记录”; v1 false is non-submittable with regenerate/refresh guidance; v2 contains no control/value for `createMealLog`. Before submit, build a new response copy and strip the field for v2 even if malformed server data contains it.

- [ ] **Step 6: Extend smoke for compatible Cook/AI client**

Add:

```text
direct: choose tomorrow/lunch/3.5 servings → Cook → finish → no plan created → exact MealLog
plan: load detail/version → Cook → plan cooked → same MealLog ID
resume: refresh → Discover “继续做菜” → same step/timer/completion ID
failure: completion 409 → dialog/session remains
replay: same completion ID response → one success and one MealLog
AI v1 true approval → automatic MealLog
AI v1 false fixture → disabled/regeneration copy
AI v2 fixture → no record switch/field and capability header present
```

- [ ] **Step 7: Run the compatible frontend gate**

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
npm --prefix frontend run check:style-tokens
git diff --check
```

Expected: PASS. Manually verify 375x812, 430x932, 768x1024, 1024x744 touch landscape, 1112x834, 1180x820, and desktop for safe-area, no horizontal overflow, focus trap/return, 44px controls, and no duplicate shells.

- [ ] **Step 8: Review and commit the compatible client**

Use `frontend-code-audit` plus `superpowers:requesting-code-review`. Fix all P0/P1 findings and rerun focused tests plus the full gate.

```bash
git add frontend/src/api/aiApi.ts frontend/src/api/aiApi.test.ts frontend/src/api/types.ts \
  frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx \
  frontend/src/components/ai/AiConversationThread.tsx frontend/src/components/ai/AiConversationThread.test.tsx \
  frontend/src/components/ai/useAiConversationStreams.ts frontend/src/components/ai/AiWorkspace.test.tsx \
  frontend/scripts/smoke.mjs
git commit -m "feat: support AI recipe cook v1 and v2"
```

- [ ] **Step 9: Deploy and prove the compatible frontend before generator work**

Promote only the Task 22–25 frontend artifact while every backend instance still reports `generated_version=recipe_cook_operation.v1`. Verify Service Worker update behavior, all header-bearing calls, v1 approval, Cook completion/replay, and rollback build retention of v3 keys. If repository deployment is atomic, merge this as the first stacked B2 PR and begin Task 26 only after production evidence is recorded.

## PR B2 Release Unit 2 — AI v2 Generation

## Task 26: Switch the Generator, Manifest, Tool Schema, Fixtures, and Eval to v2

**Files:**

- Modify: `backend/app/ai/skills/catalog/recipe-cook/SKILL.md`
- Modify: `backend/app/ai/skills/catalog/recipe-cook/skill.yaml`
- Modify: `backend/app/ai/tools/catalog/recipe.py`
- Modify: `backend/app/ai/tools/draft_validation.py`
- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/ai/draft_contracts.py`
- Modify: `backend/app/services/ai_operations/draft_specs/recipes.py`
- Modify: `backend/app/services/ai_operations/draft_specs/common.py`
- Modify: `backend/tests/ai_infra/_support.py`
- Modify: `backend/tests/ai_infra/test_foundation.py`
- Modify: `backend/tests/ai_infra/test_inventory_operations.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/ai_evals/cases/core.jsonl`
- Modify: `backend/tests/ai_evals/test_eval_dataset.py`
- Modify: `backend/tests/ai_evals/test_skill_scenarios.py`
- Modify: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Modify: `docs/plans/ai-skill-optimization-notes.md`

**Interfaces:**

- Consumes: complete production B1 baseline and Task 25 compatible-client evidence.
- Produces: generated version v2 for v2-capable requests, accepted versions still `{v1,v2}`, no generated `createMealLog`, matching manifest/tool/default/approval version, and green AI evaluation gates.

- [ ] **Step 1: Write the failing generated-contract equality test**

```py
def test_effective_recipe_cook_generator_contract_is_v2_and_cross_layer_consistent(registry):
    skill = registry.skill("recipe-cook")
    tool = registry.tool("recipe.cook_prepare")
    assert skill.draft_contract["schema_version"] == "recipe_cook_operation.v2"
    assert tool.output_schema["properties"]["draft"]["properties"]["schemaVersion"]["const"] == "recipe_cook_operation.v2"
    assert generated_recipe_cook_version() == "recipe_cook_operation.v2"
    assert normalize_generated_recipe_cook_fixture()["schemaVersion"] == "recipe_cook_operation.v2"
    assert "createMealLog" not in tool.output_schema["properties"]["draft"]["properties"]
    assert accepted_recipe_cook_versions() == {
        "recipe_cook_operation.v1",
        "recipe_cook_operation.v2",
    }
```

Add a test that a request without v2 capability receives `client_contract_upgrade_required` before a v2 draft/approval is persisted, while a capable request generates v2.

- [ ] **Step 2: Run contract tests and verify B1 still generates v1**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_registry_and_metrics.py -k "recipe_cook and (generator or contract)" -q
```

Expected: FAIL because the B1 generator/manifest/default are intentionally v1.

- [ ] **Step 3: Change the generated version and all generation surfaces together**

Set:

```py
RECIPE_COOK_GENERATED_VERSION = RECIPE_COOK_V2
```

Set `skill.yaml` `draft_contract.schema_version` to `recipe_cook_operation.v2`; remove `createMealLog` from the tool output JSON schema, Skill examples/rules, generated normalized draft, approval editable fields, preview/summary fixtures, and fake provider output. Keep the persisted v1 schema/normalizer/executor for pending compatibility.

- [ ] **Step 4: Update user-facing AI semantics**

The Skill and approval copy must state:

```text
预览做菜只展示预计扣减与短缺，不写数据。
完成做菜会扣减库存、自动记录这餐，并在有关联菜单时完成菜单项。
若用户只想调整库存，应使用明确的库存调整能力。
```

No generated/normalized v2 object contains `createMealLog`, even as `true`.

- [ ] **Step 5: Add reviewed v2 eval cases**

Update `core.jsonl` with deterministic scenarios for v2 always-record, no opt-out field, plan completion, preview no-write, family isolation, v1 false conflict, and v2-capability gate. Keep every real Ingredient/Food ID invariant required by current eval standards. Update dataset coverage assertions; do not lower thresholds.

- [ ] **Step 6: Run focused AI and evaluation gates**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_registry_and_metrics.py \
  tests/ai_infra/test_workspace_approvals.py -q
cd .. && CULINA_AI_EVAL_REPORT_PATH=.artifacts/ai-skill-eval-report.json npm run backend:test:ai-evals
npm run backend:check:ai-evals
```

Expected: PASS; the report meets committed thresholds with zero invalid identity writes and the cross-layer generated version is v2.

- [ ] **Step 7: Prove mixed-instance execution and rollback**

Run integration fixtures showing:

```text
B2 generator instance creates v2 → B1 instance executes it successfully
B2 generator rolls back to v1 → existing pending v2 remains readable/approvable/executable
old viewer reads shared v2 conversation → projector returns upgrade only
new viewer reads/approves v2 → exact MealLog/CookLog and no createMealLog value
```

Run:

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_ai_client_projection.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -q
```

Expected: PASS.

- [ ] **Step 8: Commit the generator cutover**

```bash
git add backend/app/ai/skills/catalog/recipe-cook/SKILL.md \
  backend/app/ai/skills/catalog/recipe-cook/skill.yaml backend/app/ai/tools/catalog/recipe.py \
  backend/app/ai/tools/draft_validation.py backend/app/ai/tools/schemas.py backend/app/ai/draft_contracts.py \
  backend/app/services/ai_operations/draft_specs/recipes.py backend/app/services/ai_operations/draft_specs/common.py \
  backend/tests/ai_infra/_support.py backend/tests/ai_infra/test_foundation.py \
  backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_workspace_approvals.py \
  backend/tests/ai_evals/cases/core.jsonl backend/tests/ai_evals/test_eval_dataset.py \
  backend/tests/ai_evals/test_skill_scenarios.py backend/tests/ai_infra/test_ai_draft_contracts.py \
  backend/tests/ai_infra/test_registry_and_metrics.py docs/plans/ai-skill-optimization-notes.md
git commit -m "feat: generate AI recipe cook v2 drafts"
```

- [ ] **Step 9: Review, promote, and monitor the generator gate**

Use `backend-code-audit` and `superpowers:requesting-code-review`; fix all P0/P1 findings. Promote only after every production instance still passes the B1 probe and compatible-client evidence remains healthy. During rollout, verify generated v2 counts, old-client upgrade conflicts, v1/v2 execution, idempotent completion, and projector leak counters. Rollback changes generated version to v1 only; it never removes B1 readers/executors/projectors or scoped v3 frontend support.

## PR C — Bounded Legacy Cleanup

## Task 27: Prove Legacy Calls Are Zero and Remove Only Expired Compatibility

**Files:**

- Modify: `backend/app/schemas/recipes.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/schemas/meal_logs.py`
- Modify: `backend/app/ai/draft_contracts.py`
- Modify: `backend/app/ai/tools/draft_validation.py`
- Modify: `backend/app/ai/tools/schemas.py`
- Modify: `backend/app/ai/tools/catalog/recipe.py`
- Modify: `backend/app/services/ai_operations/draft_specs/recipes.py`
- Modify: `backend/app/services/ai_operations/draft_specs/common.py`
- Modify: `backend/app/services/ai_operations/recipe_cook.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`
- Modify: `backend/tests/recipes/test_recipe_crud.py`
- Modify: `backend/tests/recipes/test_recipe_discovery.py`
- Modify: `backend/tests/recipes/test_food_workspace.py`
- Modify: `backend/tests/ai_infra/test_ai_draft_contracts.py`
- Modify: `backend/tests/ai_infra/_support.py`
- Modify: `backend/tests/ai_infra/test_foundation.py`
- Modify: `backend/tests/ai_infra/test_inventory_operations.py`
- Modify: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `frontend/src/app/appNavigationModel.ts`
- Modify: `frontend/src/app/appNavigationModel.test.ts`
- Modify: `frontend/src/app/useAppNavigationState.ts`
- Modify: `frontend/src/app/useAppNavigationState.test.tsx`
- Modify: `frontend/src/components/recipes/recipeCookSessionStorage.ts`
- Modify: `frontend/src/components/recipes/recipeCookSessionStorage.test.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/recipesApi.ts`
- Modify: `frontend/src/api/foodsApi.ts`
- Modify: `frontend/src/api/client.test.ts`
- Modify: `frontend/src/components/ai/AiApprovalPanel.tsx`
- Modify: `frontend/src/components/ai/AiApprovalPanel.test.tsx`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.tsx`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.test.ts`
- Modify: `frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts`
- Modify: `frontend/src/components/recipes/useRecipeWorkspaceData.ts`
- Modify: `frontend/src/components/recipes/workspaceModel.ts`
- Modify: `frontend/src/components/recipes/workspaceModel.test.ts`
- Delete: `frontend/src/components/recipes/RecipePlanDialogs.tsx`
- Delete: `frontend/src/components/recipes/RecipePlanDialogs.test.tsx`
- Delete: `frontend/src/components/recipes/useRecipePlanState.ts`
- Delete: `frontend/src/components/recipes/RecipeLibraryView.tsx`
- Delete: `frontend/src/components/recipes/RecipeMobileLibraryView.tsx`
- Modify: `frontend/src/components/recipes/RecipeLegacyStylesUsage.test.ts`
- Modify: `frontend/src/styles/03-recipe-workspace.css`
- Modify: `frontend/src/styles/04-ingredients-workspace.css`
- Modify: `frontend/src/styles/05-workspace-overlays.css`
- Modify: `frontend/src/styles/06-food-workspace.css`
- Modify: `frontend/src/styles/07-mobile.css`
- Modify: `frontend/scripts/ai-skill-manual-smoke.mjs`
- Modify: `frontend/scripts/smoke.mjs`

**Interfaces:**

- Consumes: completed compatibility observation window, production redacted counters from Tasks 17/18, Service Worker/client adoption evidence, and a database count of pending v1 approvals/drafts.
- Produces: required completion ID, conditionally required plan base timestamp, no deprecated REST flag/alias/recipe-plan endpoint, v2-only generated/persisted AI after pending v1 reaches zero, and removal of only confirmed old storage compatibility.

- [ ] **Step 1: Establish a written zero-use cleanup gate**

Collect and attach these exact observations to PR C:

```text
legacy_missing_completion_request_id = 0 for the full agreed observation window
deprecated_create_meal_log_false = 0 for the full agreed observation window
deprecated_recipe_plan_item_id = 0 for the full agreed observation window
legacy_missing_plan_base_updated_at = 0 for the full agreed observation window
generated recipe_cook_operation.v1 = 0 after v2 cutover stabilization
pending recipe_cook_operation.v1 drafts/approvals = 0
all serving instances accepted/generated/projector probe healthy
supported frontend/Service Worker adoption meets the release policy
```

Use this read-only database check through the project’s authenticated production query procedure:

```sql
SELECT COUNT(*) AS pending_v1_recipe_cook
FROM ai_task_drafts AS d
LEFT JOIN ai_approval_requests AS a ON a.draft_id = d.id
WHERE d.draft_type = 'recipe_cook'
  AND d.schema_version = 'recipe_cook_operation.v1'
  AND (d.status IN ('pending', 'ready') OR a.status IN ('pending', 'pending_retry'));
```

Expected: `pending_v1_recipe_cook = 0`. Any non-zero counter blocks the corresponding deletion; extend the observation window rather than changing old canonical rows.

- [ ] **Step 2: Write failing final-contract tests**

```py
def test_final_cook_request_requires_completion_id():
    with pytest.raises(ValidationError):
        CookRecipeRequest(servings=2)

def test_final_plan_cook_requires_base_updated_at():
    with pytest.raises(ValidationError):
        CookRecipeRequest(
            servings=2,
            completion_request_id="request-1",
            food_plan_item_id="plan-1",
        )

def test_final_request_rejects_removed_aliases():
    with pytest.raises(ValidationError):
        CookRecipeRequest.model_validate({
            "servings": 2,
            "completion_request_id": "request-1",
            "create_meal_log": False,
            "recipe_plan_item_id": "plan-1",
        })
```

Configure final request models with `extra="forbid"` only after auditing existing project-wide extra-field behavior; if global API policy intentionally ignores extras, assert the removed fields are absent from OpenAPI and no server logic reads them instead of introducing a one-route policy inconsistency.

- [ ] **Step 3: Run final-contract tests and verify compatibility still accepts old inputs**

```bash
cd backend && ./.venv/bin/python -m pytest tests/recipes/test_recipe_cooking.py -k "final_cook_request or removed_aliases" -q
```

Expected before cleanup: FAIL because B1/B2 compatibility still allows missing IDs and old fields.

- [ ] **Step 4: Make completion and plan base versions final**

```py
class CookRecipeRequest(BaseModel):
    servings: float = Field(gt=0)
    date: date_type | None = None
    meal_type: MealType | None = None
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    completion_request_id: str = Field(min_length=1, max_length=120)
    food_plan_item_id: str | None = None
    food_plan_item_base_updated_at: datetime | None = None
    result_note: str = ""
    adjustments: str = ""
    rating: int | None = Field(default=None, ge=1, le=5)
    allow_partial_inventory_deduction: bool = False

    @model_validator(mode="after")
    def require_plan_base_timestamp(self) -> "CookRecipeRequest":
        if self.food_plan_item_id and self.food_plan_item_base_updated_at is None:
            raise ValueError("计划来源完成请求必须提供 food_plan_item_base_updated_at")
        return self
```

Remove legacy ID generation/logging, `create_meal_log`, `recipe_plan_item_id`, and missing-plan-base branches. Preview receives a dedicated preview schema or supplies a non-claiming request shape so it does not require a completion ID.

- [ ] **Step 5: Remove recipe-plan aliases and v1 AI only after zero-use proof**

Delete `/api/recipe-plan` list/create/update/delete endpoints from `backend/app/api/recipe_meta.py`; delete `RecipePlanItemOut`, `CreateRecipePlanItemRequest`, and `UpdateRecipePlanItemRequest` from `backend/app/schemas/recipes.py`; and remove their assertions from `backend/tests/recipes/test_recipe_cooking.py`, `backend/tests/recipes/test_recipe_crud.py`, and `backend/tests/recipes/test_recipe_discovery.py`. Delete the three explicitly listed legacy Recipe-plan modules and the two unreachable Recipe library views, then remove their imports/state/model branches and only CSS selectors proven ownerless by `RecipeLegacyStylesUsage.test.ts` plus the runtime scan in Step 7.

Remove `RecipePlanItem`, `CreateRecipePlanItemPayload`, and `UpdateRecipePlanItemPayload` from `frontend/src/api/types.ts`; remove `getRecipePlan`, `createRecipePlanItem`, `updateRecipePlanItem`, and `deleteRecipePlanItem` from `frontend/src/api/recipesApi.ts`; and update `frontend/src/api/client.test.ts` to assert only the FoodPlan APIs remain. Set the AI accepted/generated recipe-cook set to v2 only, remove v1 normalizer/executor/UI/fake-provider fixtures from the explicitly listed AI files, and keep canonical historical operation/result rows readable through generic audit serializers.

- [ ] **Step 6: Remove bounded navigation/Cook storage compatibility safely**

Stop reading `culina-active-tab` and remove it only after a valid `culina-navigation-v2` write. Remove v1/v2 Cook migration logic after the supported-client window; cleanup may delete only the exact legacy key derived from a currently verified Recipe/source. Never enumerate storage, delete scoped v3, or delete an unknown future version.

Keep the v3 parser, key builders, active descriptor, compare-delete, completion payload, and compatible rollback safeguards permanently until a separately designed v4 migration replaces them.

- [ ] **Step 7: Prove old code paths are absent**

```bash
rg -n "create_meal_log|createMealLog|recipe_plan_item_id|/api/recipe-plan|culina-active-tab|culina-recipe-cook-session:" \
  backend/app frontend/src frontend/scripts \
  -g '!**/*.test.*'
```

Expected: no runtime hits for removed compatibility. Allowed historical documentation/spec references are outside this runtime scan; v3 keys contain `culina-recipe-cook-session-v3` and therefore remain.

- [ ] **Step 8: Run cleanup regressions**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_food_workspace.py \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_ai_client_projection.py \
  tests/ai_infra/test_workspace_approvals.py -q
cd .. && npm --prefix frontend run test -- appNavigationModel useAppNavigationState recipeCookSessionStorage recipesApi foodsApi AiApprovalPanel
```

Expected: PASS with final contract requirements, v2-only AI, v3 recovery, and no old endpoint/storage dependency.

- [ ] **Step 9: Commit bounded cleanup**

```bash
git add backend/app/schemas/recipes.py backend/app/api/recipes.py backend/app/api/recipe_meta.py \
  backend/app/api/meal_logs.py backend/app/schemas/meal_logs.py backend/app/ai/draft_contracts.py \
  backend/app/ai/tools/draft_validation.py backend/app/ai/tools/schemas.py backend/app/ai/tools/catalog/recipe.py \
  backend/app/services/ai_operations/draft_specs/recipes.py backend/app/services/ai_operations/draft_specs/common.py \
  backend/app/services/ai_operations/recipe_cook.py backend/tests/recipes/test_recipe_cooking.py \
  backend/tests/recipes/test_recipe_crud.py backend/tests/recipes/test_recipe_discovery.py \
  backend/tests/recipes/test_food_workspace.py backend/tests/ai_infra/test_ai_draft_contracts.py \
  backend/tests/ai_infra/_support.py backend/tests/ai_infra/test_foundation.py \
  backend/tests/ai_infra/test_inventory_operations.py backend/tests/ai_infra/test_registry_and_metrics.py \
  backend/tests/ai_infra/test_workspace_approvals.py \
  frontend/src/app/appNavigationModel.ts frontend/src/app/appNavigationModel.test.ts \
  frontend/src/app/useAppNavigationState.ts frontend/src/app/useAppNavigationState.test.tsx \
  frontend/src/components/recipes/recipeCookSessionStorage.ts \
  frontend/src/components/recipes/recipeCookSessionStorage.test.ts frontend/src/api/types.ts \
  frontend/src/api/recipesApi.ts frontend/src/api/foodsApi.ts frontend/src/api/client.test.ts \
  frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx \
  frontend/src/components/recipes/RecipeWorkspace.tsx frontend/src/components/recipes/RecipeWorkspace.test.ts \
  frontend/src/components/recipes/RecipeWorkspaceUsage.test.ts frontend/src/components/recipes/useRecipeWorkspaceData.ts \
  frontend/src/components/recipes/workspaceModel.ts frontend/src/components/recipes/workspaceModel.test.ts \
  frontend/src/components/recipes/RecipePlanDialogs.tsx frontend/src/components/recipes/RecipePlanDialogs.test.tsx \
  frontend/src/components/recipes/useRecipePlanState.ts frontend/src/components/recipes/RecipeLibraryView.tsx \
  frontend/src/components/recipes/RecipeMobileLibraryView.tsx frontend/src/components/recipes/RecipeLegacyStylesUsage.test.ts \
  frontend/src/styles/03-recipe-workspace.css frontend/src/styles/04-ingredients-workspace.css \
  frontend/src/styles/05-workspace-overlays.css frontend/src/styles/06-food-workspace.css \
  frontend/src/styles/07-mobile.css frontend/scripts/ai-skill-manual-smoke.mjs frontend/scripts/smoke.mjs
git commit -m "chore: remove expired eating compatibility"
```

## Task 28: Run Final Acceptance, Data-Safety, Rollback, and Release Gates

**Files:**

- No planned file changes. This task gathers fresh evidence from the exact files produced by Tasks 1–27.
- If any gate exposes a defect or a missing acceptance case, stop Task 28, return to the owning task and its listed files for a focused failing-test/fix cycle, commit there, then restart Task 28 from Step 1. Do not patch production behavior or tests opportunistically inside this gate.

**Interfaces:**

- Consumes: merged green PR A/B1/B2, observed PR C cleanup preconditions, current migration, and all tests/rollout probes.
- Produces: final evidence that the P0 fourth item is implemented without history loss, cross-family leakage, duplicate completion, reversed locks, client-contract leakage, or responsive regression.

- [ ] **Step 1: Verify repository and migration topology before tests**

```bash
git status --short
git branch --show-current
git log --oneline --decorate -12
cd backend && ./.venv/bin/alembic heads && ./.venv/bin/alembic current
```

Expected: only intentional PR C files are changed, branch is `chore/unified-eating-legacy-cleanup`, and exactly one additive completion migration head/current exists. Do not run a destructive production downgrade.

- [ ] **Step 2: Run complete frontend verification**

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
npm --prefix frontend run check:style-tokens
```

Expected: PASS.

- [ ] **Step 3: Run focused backend domain/AI verification**

```bash
cd backend && ./.venv/bin/python -m pytest \
  tests/recipes/test_recipe_cooking.py \
  tests/recipes/test_recipe_crud.py \
  tests/recipes/test_food_workspace.py \
  tests/meal_logs/test_meal_logs.py \
  tests/ai_infra/test_ai_draft_contracts.py \
  tests/ai_infra/test_ai_client_projection.py \
  tests/ai_infra/test_workspace_approvals.py \
  tests/ai_infra/test_workspace_chat.py \
  tests/ai_infra/test_workspace_streaming.py -q
```

Expected: PASS.

- [ ] **Step 4: Run real MySQL concurrency verification**

```bash
cd backend && CULINA_TEST_MYSQL_URL="$CULINA_TEST_MYSQL_URL" \
  ./.venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py -q
```

Expected: PASS with no barrier timeout/deadlock and exactly the allowed one-winner/replay outcomes.

- [ ] **Step 5: Run full backend and AI evaluation gates**

```bash
cd .. && npm run backend:test
CULINA_AI_EVAL_REPORT_PATH=.artifacts/ai-skill-eval-report.json npm run backend:test:ai-evals
npm run backend:check:ai-evals
```

Expected: PASS; evaluation report meets committed thresholds and no threshold is lowered for this feature.

- [ ] **Step 6: Execute the complete manual acceptance matrix**

Verify with authenticated disposable-family data:

```text
desktop: 发现 → 自做菜 → 做法 → 开始做 → 完成 → 查看精确这餐
mobile: 吃什么 → 发现/菜单/吃过的, same target semantics
plan: 加入菜单 → 从计划做 → cooked → same MealLog ID
direct: 开始做 → no new plan → MealLog
direct context: tomorrow/lunch/non-default servings survive Session/request/MealLog/CookLog
resume: refresh → compact continue card → same step/timer/completion ID
search Recipe: linked Food on desktop/mobile
search plan: outside current week → detail by ID → correct week
storage: old/unknown/corrupt navigation and v3/future Cook versions never white-screen or cross scope
MealLog: minimal automatic record is valid and optional enrichment remains available
delete: referenced Recipe returns history conflict with media/search/history intact
AI: capable v2 generation/approval records; old viewer sees upgrade only; v1 is absent after PR C gate
rollback drill: generator v2→v1 keeps pending v2 executable; compatible frontend rollback keeps scoped v3
```

Test viewports: `375x812`, `390x844`, `430x932`, `768x1024`, `1024x744 touch landscape`, `1112x834`, `1180x820`, and regular desktop. Check safe area, focus trap/return, live status, 44px controls, tab overflow, task back behavior, and bottom-nav overlap.

- [ ] **Step 7: Run static contract and whitespace scans**

```bash
rg -n "setActiveTab\('(foods|recipes|logs)'\)|primaryTab: '(foods|recipes|logs)'|createMealLog|create_meal_log|recipe_plan_item_id|/api/recipe-plan" \
  frontend/src backend/app
rg -n "fastApprovalDecisions|\"context\": item\.context|\"metadata\": item\.message_metadata" backend/app/services backend/app/api
git diff --check
git status --short
```

Expected after PR C: no deprecated runtime navigation/Cook/API hits; `fastApprovalDecisions` may remain only in private workflow persistence/resume logic, never a public serializer; no whitespace errors; status contains only intentional files.

- [ ] **Step 8: Run final dual review and verification-before-completion**

Use `frontend-code-audit`, `backend-code-audit`, `superpowers:requesting-code-review`, then `superpowers:verification-before-completion`. Fix every P0/P1 issue through its owning focused test and rerun the relevant full gate. Do not claim completion from an earlier green run after subsequent edits.

- [ ] **Step 9: Finish PR C and publish release evidence**

Use `superpowers:finishing-a-development-branch`. The PR/release notes must include actual commands/results, migration head, MySQL race result, AI eval report summary, per-instance B1/B2 probe, compatible-client/generator ordering, zero-use evidence, manual viewport matrix, remaining deferred items, and rollback procedure.

---

## Spec Coverage Matrix

| Approved design section | Implemented by tasks | Verification evidence |
|---|---|---|
| 1–2 conclusion and confirmed decisions | 0–28 | Every hard decision is repeated in Global Constraints and final acceptance |
| 3 current problems | 1–10, 17–25 | Legacy navigation/request IDs, implicit plan, optional record, device fork, storage risk, and task language tests |
| 4 baseline/P0 boundaries | 0, 10, 21 | PR ancestry/checks, bounded Home parallel window, PR A/Home/B1 gates |
| 5 goals/non-goals | Global Constraints, 28 | Static scope scan and release notes |
| 6 domain language/lifecycle | 7, 12–14, 16, 22–24 | Meal validity, reference validation, deletion guard, direct/plan semantics |
| 7 target information architecture | 3, 6–10 | AppShell/EatWorkspace/search/smoke |
| 8 navigation state | 1, 2, 5, 8–10 | Pure reducer, hook, resolver, focus, semantic targets |
| 9 local persistence/migration | 1, 2, 23, 27 | Old navigation migration, scoped v3, descriptor, cleanup gate |
| 10 frontend responsibilities | 5–9 | Focused surfaces, one composition layer, App integration |
| 11 core user flows | 8–10, 22–25, 28 | Desktop/mobile/direct/plan/search/history smoke |
| 12 plan/direct data semantics | 4, 13, 22 | Detail API, parent locks, direct no-plan, plan base version |
| 13 completion backend contract | 11, 12, 15–17, 21 | Migration, canonical hash/claim/replay, atomic service, MySQL tests |
| 14 REST compatibility | 11, 17, 21, 24, 27 | Old/new matrix, fixed true, final cleanup |
| 15 Cook Finish UI | 23, 24 | v3 state, no toggle, exact success IDs, safe cleanup |
| 16 AI recipe-cook contract | 18–21, 25, 26, 27 | Dual reader/executor, gate/projector, compatible client, v2 generation/eval |
| 17 global entry mapping | 9, 10, 22, 24, 25 | Search/Home/Family/AI semantic target tests |
| 18 Recipe/Food relation errors | 5, 7, 8 | Resolver states and read-only recoverable UI |
| 19 query scope/freshness | 1, 4, 5, 24 | Matrix tests, detail query, root invalidation |
| 20 loading/empty/error | 5, 6, 8, 23, 24 | Surface state and recovery tests |
| 21 MealLog validity | 7, 12, 16 | Minimal record UI and shared reference service |
| 22 responsive/accessibility | 3, 8, 22–25, 28 | Component tests, style token gate, viewport matrix |
| 23 security/family boundary | 4, 12–14, 16–21, 23 | Scoped 404, active participants, parent locks, projector, session namespace |
| 24 phased release/rollback | 0, 10, 21, 25–28 | Separate PR/artifact gates and rollback drill |
| 25 test design | Every task, especially 10, 21, 25, 26, 28 | Focused TDD, full suites, smoke, MySQL, eval |
| 26 acceptance criteria | 28 | Complete automated/manual release matrix |
| 27 risks/mitigations | Global Constraints, 0, 14–28 | Explicit dependency, lock, idempotency, storage, rollout, and projection gates |
| 28 deferred items | Global Constraints, release notes | Static scope review; no deferred feature is added implicitly |
| 29 final design judgment | 28 | Final dual review and verified release evidence |

## Completion Checklist

- [ ] PR 72 and PR 73 merge/check ancestry was proven from current GitHub state.
- [ ] Unified PR A and Home Backend Tasks 1–3 used at most the bounded parallel window; Home rebased after PR A and merged before B1.
- [ ] PR A, B1, compatible frontend, generator, and PR C were executed in order from merged predecessors.
- [ ] Desktop/mobile share five primary entries and semantic targets.
- [ ] EatWorkspace uses focused surfaces and no nested legacy workspace shells.
- [ ] Direct Cook creates no plan; plan Cook reuses and versions the existing item.
- [ ] Every successful REST/AI Cook returns one MealLog ID and one CookLog ID.
- [ ] Same completion request replays without duplicate side effects; different payload conflicts.
- [ ] Food/participant references are active and family-scoped across REST/quick-add/Cook/AI.
- [ ] FoodPlan create/rebind uses complete `Food → FoodPlanItem` locks across REST/AI aliases/batches.
- [ ] Recipe deletion cannot race a new Cook/MealLog/plan reference into history loss.
- [ ] Real MySQL tests prove global lock order against PR 73 paths.
- [ ] Minimal MealLogs are valid history, not pending work.
- [ ] Scoped v3 Cook state survives refresh/retry/compatible rollback without cross-user/family deletion.
- [ ] Old AI viewers cannot obtain editable v2 commands from any public DTO/REST/SSE/history path.
- [ ] Compatible frontend was deployed and verified while generation remained v1.
- [ ] v2 generator was enabled only after every instance passed the full B1 probe.
- [ ] PR C removed compatibility only after counters, pending data, and client adoption reached the agreed gate.
- [ ] Frontend test/build/smoke/style, backend full suite, MySQL concurrency, migration, and AI eval gates all passed after final edits.
- [ ] Final response lists commands actually run, failures, review findings/fixes, migration head, and remaining deferred items.

## Execution Handoff

Choose one execution mode only after Task 0 prerequisites are satisfied:

1. **Subagent-driven (recommended):** use `superpowers:subagent-driven-development`; dispatch one fresh implementation subagent per task, never run more than one subagent concurrently, then perform spec-compliance and code-quality review before advancing.
2. **Inline execution:** use `superpowers:executing-plans`; execute in small batches with explicit checkpoints at Tasks 10, 21, 25, 26, and 28.

In either mode, use `superpowers:test-driven-development` for each code task, `superpowers:systematic-debugging` for any unexpected failure, and `superpowers:verification-before-completion` before every completion claim.
