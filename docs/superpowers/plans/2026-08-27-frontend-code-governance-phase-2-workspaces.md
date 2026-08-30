# Phase 2/3：应用组合层与工作台拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 先把 App 的查询、mutation、导航和跨域 overlay 组合变成 typed port，再按同一边界拆 Ingredient、Food、Eat、Inventory dialog 和 API 类型，降低复杂度而不改变请求、缓存、导航或业务状态语义。

**Architecture:** app 层保留旧 facade 作为短期兼容适配器，但每个 query/mutation 只有一个域 owner；AppWorkspaceRouter、AppOverlayHost 和 controller 负责组合，不拼 payload。各工作台以 Data、State、Actions、ViewModel、View 分层，桌面与手机共享 model/action、拥有独立 View；迁移先补 contract/behavior 测试，再逐文件替换，最后删除 facade 内部实现。

**Tech Stack:** React 18、TypeScript 5、TanStack React Query 5、Vitest/Testing Library、Playwright、现有 queryKeys/cacheInvalidation、Culina frontend-code-standards。

**Spec:** [2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)

## 实施状态（2026-08-28）

Phase 2/3 已完成 query/mutation、App consumer、domain type barrel、Eat task body、reconciliation dialog、Ingredient/Food ViewModel 与 overlay 的真实迁移，并保留独立回滚提交。App 路由组合也已移出 `App.tsx`；这些迁移已通过对应定向测试、全量 quality、build 和 P0。预算与部分发布证据仍由 Phase 4/5 追踪；以下 checklist 不将 facade 或 re-export 视为真实拆分。

2026-08-29 增量：`api/types.ts` 已收敛为 11 行纯 type barrel，AI、inventory、recipe、food、meal、search、shell、media、model-usage 合约已物理迁出；App 提取了错误、路由和壳布局模型；Ingredient 提取了策略/表单模型。Ingredient/Food 主 workspace 的 View 组合仍需继续迁移。

2026-08-30 增量：Ingredient 新增 `IngredientWorkspaceHubRoute` 与 `IngredientWorkspaceMobileDetailPopover`，将库存 context、hub route 和移动详情 overlay 的组合边界移出主 Workspace；`IngredientWorkspace.tsx` 当前 998 行。最新 typecheck、定向 Ingredient 契约测试、全量 quality 与 production build 均通过。主 Workspace 尚未达到 ≤900 行，Food/App 仍需继续拆分。

后续增量：`IngredientWorkspaceProps`/mutation port 已迁至 `IngredientWorkspaceTypes.ts`，主 Workspace 当前 867 行，达到阶段目标 ≤900；Ingredient 目录定向测试 28 个文件、138 项通过，typecheck 通过。View/data/action 组合仍需继续做最终集成审计。

最新校准（2026-08-30）：FoodWorkspace 当前 880 行、IngredientWorkspace 当前 867 行、App.tsx 当前 854 行，均已达到本阶段的大文件行数目标；Food discover/editor、Ingredient overlay 和 App route composition 已完成独立 projection/port/host 拆分。全量 `frontend:quality` 已补齐 308 个测试文件、2033 个测试的稳定退出证据；剩余工作转入 Phase 4/5 的 hard bundle target 与 target rollout。

同日 Food 增量：新增 `FoodWorkspaceQuickMealDialog` 与 `FoodWorkspaceNotice`，将 quick-meal confirmation 和 workspace notice 的可见 View 从主 Workspace 移出；dialog/usage 定向测试通过，`FoodWorkspace.tsx` 当前 1365 行。该拆分不改变 mutation、busy 或关闭语义。

继续增量：新增 `FoodWorkspaceRecipeEditorOverlay`，将 recipe editor dialog 与 `RecipeEditorView` 组合移出主 Workspace；editor/usage 定向测试 14/14 通过，typecheck 通过。当前 Food workspace 仍需继续拆 discover、plan 和 editor state/controller，尚未达到阶段目标。

继续增量：新增 `FoodWorkspacePlanSurfaceModel`，将周计划 surface props 的组装和回调边界收敛到独立 projection；按 frontend 项目脚本运行的 plan/view/usage 定向测试 18/18 通过，typecheck 通过。主文件仍需继续拆 discover 与 dialog controller。

继续增量：新增 `buildFoodMobileFilterTabs` 纯 projection，并补充 mutually-exclusive/reset 行为测试；按 frontend 项目脚本定向测试 9/9 通过，typecheck 通过。mobile filter 的筛选组合不再直接堆在 Workspace JSX 中。

继续增量：新增 `buildFoodGovernanceSummary` projection，集中管理待完善去重、下一项摘要和 filters 状态；新增行为测试后定向测试 10/10 通过，typecheck 通过。

继续增量：`FoodWorkspaceProps` 及其跨域 mutation/navigation typed port 已迁至 `FoodWorkspaceTypes.ts`，主 Workspace 当前 1213 行；Food usage/plan/view 定向测试 21/21 通过，typecheck 通过。Food 仍需继续拆 discover/editor controller。

## Global Constraints

- 只能在 Phase 0 ratchet 和 Phase 1 CSS layer 已通过的分支上执行；每个 task 独立提交、可回滚。
- frontend/src/api/queryKeys.ts 是唯一 query key 来源；frontend/src/api/cacheInvalidation.ts 是 mutation 成功失效的唯一入口。
- View 不导入 api/client、useQuery、useMutation、QueryClient，不接受整个 api 对象、Record<string, unknown> 或 any。
- 所有请求的 family scope 来自当前 membership/context，不从 port 或请求 payload 接受可伪造 family/user id。
- loading 与后台 refresh 分离；已有数据和草稿在 refresh/error/conflict 时保留，失败不得发布假成功。
- 不创建跨域大 Context；Context 仅可用于单工作区只读 view model 或 overlay controller，并有 provider 边界测试。
- 保持 AppNavigationState/Target、task close/focus restore、storage key/version、React Query placeholderData、AI conversation/run/approval、库存 OCC 和 free-text 显式绑定语义。
- 手机/平板/桌面共享 data/actions/model，不共享大段 JSX；工作台相关任务验收六个固定视口和 reduced-motion。
- 新增业务文件优先放 frontend/src/features/home、eat、ingredients、foods、inventory、ai 等明确域目录；既有 components 目录只做渐进拆分，不做无收益全仓搬迁。
- 每个任务先写失败测试并记录失败原因；完成后运行 focused tests、typecheck、quality/build（按风险补 P0）、git diff --check。

---

## 2.0 预检、依赖图和 port 迁移清单

**Files:**

- Create: frontend/src/app/appWorkspacePorts.ts
- Create: frontend/src/app/appQueryOwnership.ts
- Create: frontend/src/app/appMutationOwnership.ts
- Create: frontend/src/app/appPortContracts.test.ts
- Modify: frontend/src/app/useAppWorkspaceQueries.test.tsx
- Modify: frontend/src/app/useAppMutations.test.tsx

**Interfaces:**

- AsyncState<T> = { data: T; isLoading: boolean; isFetching: boolean; error: unknown | null; retry: () => void }
- WorkspacePort<Data, Actions> = { data: Data; actions: Actions; navigation: AppNavigationService }
- assertUniqueOwner(names: string[]) => void
- query/mutation ownership maps are source-of-truth for migration; no new facade field is allowed.

- [ ] **Step 1: 记录 B0 依赖和调用方**

Run:

~~~bash
wc -l frontend/src/App.tsx frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppMutations.ts
rg -n "useAppWorkspaceQueries|useAppMutations|queryKeys\\.|invalidateAfter" frontend/src --glob '*.ts' --glob '*.tsx'
~~~

Expected: report includes App 1,914 lines, 21 query registrations and 37 mutation registrations; each registration has a consumer path.

- [ ] **Step 2: 写 port/ownership 失败测试**

测试名称：

~~~ts
it("rejects duplicate query owners", () => {});
it("rejects a view port containing api or query client", () => {});
it("preserves AsyncState loading versus fetching", () => {});
it("requires navigation target to use AppNavigationTarget", () => {});
~~~

Run: npm --prefix frontend run test -- src/app/appPortContracts.test.ts

Expected: FAIL，因为新类型和 owner maps 尚不存在。

- [ ] **Step 3: 实现最小类型和静态边界检查**

建立 WorkspaceId 联合类型：home、eat、ingredients、food、ai、family。在测试中读取 View 文件 import 清单，发现 api/client、@tanstack/react-query 或 QueryClient 即失败。

- [ ] **Step 4: Commit**

~~~bash
git add frontend/src/app/appWorkspacePorts.ts frontend/src/app/appQueryOwnership.ts frontend/src/app/appMutationOwnership.ts frontend/src/app/appPortContracts.test.ts frontend/src/app/useAppWorkspaceQueries.test.tsx frontend/src/app/useAppMutations.test.tsx
git commit -m "refactor(app): define workspace port ownership"
~~~

Rollback: 只回滚类型/测试提交；旧 facade 仍可运行。

## Task 2.1：拆分 21 个 query 并保留兼容 facade

**Files:**

- Create: frontend/src/app/useAppShellQueries.ts
- Create: frontend/src/app/useHomeQueries.ts
- Create: frontend/src/app/useFoodPlanQueries.ts
- Create: frontend/src/app/useIngredientQueries.ts
- Create: frontend/src/app/useEatQueries.ts
- Create: frontend/src/app/useFamilyQueries.ts
- Create: frontend/src/app/useAiQueries.ts
- Modify: frontend/src/app/useAppWorkspaceQueries.ts
- Create: frontend/src/app/domainQueryContracts.test.tsx
- Modify: frontend/src/app/useAppWorkspaceQueries.test.tsx

**Interfaces:**

- useAppShellQueries({ isAuthenticated }) owns family, members and activityHighlights.
- useHomeQueries({ isActive, foodPlan }) owns home-only activeMealRecordOperations projection.
- useFoodPlanQueries({ isAuthenticated, enabled, weekRange, planDetailId }) owns foodPlan, foodPlanDetail, foodScenes, foodRecommendations and is shared by Home/Eat.
- useIngredientQueries({ isAuthenticated, enabled, includeOperations }) owns ingredients, inventory, inventoryStates, shoppingList and inventoryOperationList(20).
- useEatQueries({ isAuthenticated, enabled, baseView, taskKind }) owns recipes, recipeDiscovery, recipeStats, foods, mealLogs, mealInsights and shared activeMealRecordOperations adapter.
- useFamilyQueries({ isAuthenticated, enabled }) owns activityLogs.
- useAiQueries({ isAuthenticated, enabled }) owns aiConversations and its 2-second active-route polling.
- useAppWorkspaceQueries(args) remains a compatibility return shape only; it calls the domain hooks and cannot add a field.

| Hook | Current query owner | enabled rule |
| --- | --- | --- |
| useAppShellQueries | family, members, activityHighlights | authenticated; shell data does not block local task |
| useHomeQueries | activeMealRecordOperations projection | primaryTab home |
| useIngredientQueries | ingredients, inventory, inventoryStates, shoppingList, inventoryOperationList(20) | ingredients tab; operation list only when overlay needs it |
| useFoodPlanQueries | foodPlan, foodPlanDetail, foodScenes, foodRecommendations | active Home/Eat view; plan detail task only |
| useEatQueries | recipes, recipeDiscovery, recipeStats, foods, mealLogs, mealInsights | Eat baseView/task kind |
| useFamilyQueries | activityLogs | family activity page/overlay |
| useAiQueries | aiConversations | AI tab; refetchInterval 2000, false after leave |

- [ ] **Step 1: 写失败 domain query tests**

覆盖 family/members always-on、未激活域不请求、placeholderData 保留旧 plan、foodPlanDetail 不进入 isBootLoading、AI 离开后停止轮询、后台 refresh 不清空已有 data。

Run: npm --prefix frontend run test -- src/app/domainQueryContracts.test.tsx

Expected: FAIL；测试先证明目标行为，再移动现有 query。

- [ ] **Step 2: 实现 shell 和 shared food-plan hooks**

只复制 query options，不改 queryKeys、queryFn、retry 或 refetchInterval；Home 与 Eat 通过 useFoodPlanQueries 共享同一 query key，禁止各自声明 foodPlan/scenes/foodRecommendations。

- [ ] **Step 3: 实现 ingredients/eat/family/AI hooks**

将 enabled 条件从 deriveAppQueryScope 映射到 hook 参数；保留 isBootLoading 只包含首次必要数据，明确 isFetching、error、retry 字段。

- [ ] **Step 4: 把旧 facade 改成委托**

useAppWorkspaceQueries 仅组装 hooks 并返回旧字段；新增测试枚举 ReturnType 的 key，任何新增字段使测试失败。调用方按 shell → home → ingredients → eat → family → AI 顺序迁移。

- [ ] **Step 5: 验证请求数量和缓存语义**

~~~bash
npm --prefix frontend run test -- src/app/domainQueryContracts.test.tsx src/app/useAppWorkspaceQueries.test.tsx src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
~~~

Expected: 当前启动和首次激活 route 的 query 次数不增加；food plan/scenes/recommendations 没有重复 query owner；manifest initial/routeTotal 不变差。

- [ ] **Step 6: Commit**

~~~bash
git add frontend/src/app/useAppShellQueries.ts frontend/src/app/useHomeQueries.ts frontend/src/app/useFoodPlanQueries.ts frontend/src/app/useIngredientQueries.ts frontend/src/app/useEatQueries.ts frontend/src/app/useFamilyQueries.ts frontend/src/app/useAiQueries.ts frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/domainQueryContracts.test.tsx frontend/src/app/useAppWorkspaceQueries.test.tsx
git commit -m "refactor(app): split domain query hooks"
~~~

Rollback: 恢复 facade 的委托实现；不删除 query key 或缓存数据。

## Task 2.2：拆分 37 个 mutation 和复合 action

**Files:**

- Create: frontend/src/app/mutations/useIngredientMutations.ts
- Create: frontend/src/app/mutations/useInventoryMutations.ts
- Create: frontend/src/app/mutations/useShoppingMutations.ts
- Create: frontend/src/app/mutations/useRecipeMutations.ts
- Create: frontend/src/app/mutations/useFoodPlanMutations.ts
- Create: frontend/src/app/mutations/useFoodMutations.ts
- Create: frontend/src/app/mutations/useMealMutations.ts
- Create: frontend/src/app/mutations/useAiConversationMutations.ts
- Create: frontend/src/app/mutations/domainMutationContracts.test.tsx
- Modify: frontend/src/app/useAppMutations.ts
- Modify: frontend/src/app/useAppMutations.test.tsx

**Interfaces:**

| Hook | Exact mutation set |
| --- | --- |
| useIngredientMutations | createIngredient, updateIngredient, transitionIngredientTrackingMode |
| useInventoryMutations | createInventory, consumeInventory, disposeExpiredInventory, snoozeInventoryExpiryAlerts, correctInventoryExpiryDate, upsertInventoryState, snoozeStateExpiryAlert, correctStateExpiryDate, setInventoryStateAbsent, submitShoppingIntake, submitInventoryReconciliation, revertInventoryOperation |
| useShoppingMutations | createShopping, updateShopping, deleteShopping |
| useRecipeMutations | createRecipe, updateRecipe, deleteRecipe, cookRecipe, previewCookRecipe |
| useFoodPlanMutations | createFoodPlanItem, updateFoodPlanItem, deleteFoodPlanItem, createFoodScene, updateFoodScene, deleteFoodScene |
| useFoodMutations | createFood, updateFood, toggleFavorite |
| useMealMutations | updateMeal, recordMeal, updateMealComposition, revertMealRecord, completeFoodPlanItem |
| useAiConversationMutations | visibility/delete only; stream stays in AI controller |

- [ ] **Step 1: 写失败 mutation contract tests**

测试每个 action 调用正确 api 函数和 cacheInvalidation；transition tracking mode 不提前 invalidate；recordMeal 按 created_foods 选择失效；revert meal 按 removed_food_ids；库存/购物 intake 失败保留 draft；所有 action 暴露稳定 busy/error，而不是原始 mutation map。

Run: npm --prefix frontend run test -- src/app/mutations/domainMutationContracts.test.tsx

Expected: FAIL，因为 domain hooks 尚不存在。

- [ ] **Step 2: 实现 domain hooks**

每个 hook 内部调用 useQueryClient/useMutation；onSuccess 只能调用现有 cacheInvalidation 函数。定义示例：

~~~ts
type InventoryActions = {
  create: (payload: CreateInventoryPayload) => Promise<InventoryItem>;
  reconcile: (payload: InventoryReconciliationRequest) => Promise<InventoryOperationResult>;
  revert: (operationId: string) => Promise<InventoryOperationResult>;
  busy: { reconcile: boolean; revert: boolean };
  error: string | null;
};
~~~

- [ ] **Step 3: 更新 facade 并禁止新字段**

useAppMutations 委托全部 domain hooks，返回原字段名以迁移调用方；测试固定 37 个 mutation key。删除一个字段前先证明无消费者并更新兼容测试。

- [ ] **Step 4: 迁移复合动作的边界**

新增 frontend/src/app/useAppInventoryOperations.ts、useAppHomeController.ts、useAppNavigationEffects.ts。将 refreshInventoryActions、loadOperationDetail、handleRevertInventoryOperation、submitHomeShopping 和 free-text link resolution 移入对应 controller；controller 不直接散落 fetchQuery。

成功路径必须先等待 canonical inventory/shopping refetch 再计算下一项；409/stale 保留历史 dialog 和恢复按钮；失败不清空表单；busy 锁定重复点击。

- [ ] **Step 5: 运行定向和全局验证**

~~~bash
npm --prefix frontend run test -- src/app/mutations src/app/useAppMutations.test.tsx src/api/cacheInvalidation.test.ts src/features/inventory src/features/home
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
~~~

- [ ] **Step 6: Commit**

~~~bash
git add frontend/src/app/mutations frontend/src/app/useAppMutations.ts frontend/src/app/useAppMutations.test.tsx frontend/src/app/useAppInventoryOperations.ts frontend/src/app/useAppHomeController.ts frontend/src/app/useAppNavigationEffects.ts
git commit -m "refactor(app): split domain mutations and controllers"
~~~

Rollback: 以 facade 为开关恢复旧 action；不改变服务端事务或 cacheInvalidation 实现。

## Task 2.3：提取 Router、OverlayHost 和 App 组合

**Files:**

- Create: frontend/src/app/AppWorkspaceRouter.tsx
- Create: frontend/src/app/AppOverlayHost.tsx
- Create: frontend/src/app/appRouteEntries.ts
- Create: frontend/src/app/appOverlayState.ts
- Create: frontend/src/app/AppWorkspaceRouter.test.tsx
- Create: frontend/src/app/AppOverlayHost.test.tsx
- Modify: frontend/src/App.tsx

**Interfaces:**

~~~ts
type AppOverlayState =
  | { kind: "none" }
  | { kind: "global-search" }
  | { kind: "home-dialogs"; dialog: HomeDialogState }
  | { kind: "inventory-operation-history"; operationId?: string }
  | { kind: "ingredient-shopping"; ingredientId: string };
~~~

AppWorkspaceRouter consumes navigation state/service, shell data, typed route ports, lazy entries and WorkspaceLoadingFallback；AppOverlayHost consumes AppOverlayState and controller output，不能调用 API。

- [ ] **Step 1: 写失败 router/overlay contract**

断言 primary tab、Eat task、Family 子页面都选择唯一 route；Suspense 只遮挡当前 route；overlay state 不能同时出现互相矛盾的 boolean；busy 时 backdrop/Escape 不关闭；关闭后 focus 回到触发按钮。

Run: npm --prefix frontend run test -- src/app/AppWorkspaceRouter.test.tsx src/app/AppOverlayHost.test.tsx

Expected: FAIL，因为组件尚不存在。

- [ ] **Step 2: 实现 Router 和 route entry map**

route map 使用 source module 与逻辑 id 对应，不把工作区完整 View 静态导入 main；未激活域不得提前执行 query hook。保留当前 navigation union 和 task close semantics。

- [ ] **Step 3: 实现 OverlayHost**

承载 GlobalSearchOverlay、HomeDashboardDialogs、InventoryMaintenanceDialogs、操作历史/详情、Home 触发的 IngredientShoppingDialog、通知 toast；工作区 detail/editor overlay 留在域内。Host 只接收 typed callbacks。

- [ ] **Step 4: 缩减 App.tsx**

按认证 → AppShell → shell queries → navigation → ports → Router → OverlayHost 顺序重排；删除业务 JSX、payload 组装、localStorage 读取和 API 调用。每次删除一组函数后运行 typecheck。

- [ ] **Step 5: 运行应用组合验证**

~~~bash
npm --prefix frontend run test -- src/app/AppWorkspaceRouter.test.tsx src/app/AppOverlayHost.test.tsx src/app/AppShell.test.tsx src/app/useAppNavigationState.test.tsx
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
~~~

Expected: App 不新增业务 JSX/API/QueryClient；启动与工作区切换请求数不增加；App 行数趋势向 850 以下移动。

- [ ] **Step 6: Commit**

~~~bash
git add frontend/src/app/AppWorkspaceRouter.tsx frontend/src/app/AppOverlayHost.tsx frontend/src/app/appRouteEntries.ts frontend/src/app/appOverlayState.ts frontend/src/app/AppWorkspaceRouter.test.tsx frontend/src/app/AppOverlayHost.test.tsx frontend/src/App.tsx
git commit -m "refactor(app): extract router overlay host and composition"
~~~

Rollback: 恢复 App.tsx 与 route map 同一提交；保留 domain hooks 以便再次迁移。

## Task 3.1：拆 Ingredient workspace 的 Data/State/Actions/View

**Files:**

- Create: frontend/src/components/ingredients/IngredientWorkspaceRoute.tsx
- Create: frontend/src/components/ingredients/IngredientWorkspaceData.ts
- Create: frontend/src/components/ingredients/IngredientWorkspaceActions.ts
- Create: frontend/src/components/ingredients/IngredientWorkspaceDesktopView.tsx
- Create: frontend/src/components/ingredients/IngredientWorkspaceMobileView.tsx
- Create: frontend/src/components/ingredients/IngredientWorkspaceOverlaysView.tsx
- Create: frontend/src/components/ingredients/useIngredientWorkspaceViewModel.ts
- Modify: frontend/src/components/ingredients/useIngredientWorkspaceState.ts
- Modify: frontend/src/components/ingredients/IngredientWorkspace.tsx
- Modify: frontend/src/components/ingredients/IngredientWorkspaceUsage.test.ts
- Create: frontend/src/components/ingredients/IngredientWorkspaceBehavior.test.tsx

**Interfaces:**

~~~ts
type IngredientWorkspaceData = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  inventoryStates: IngredientInventoryState[];
  shoppingItems: ShoppingListItem[];
  selectedId: string | null;
  queryState: AsyncState<unknown>;
};

type IngredientWorkspaceActions = {
  select: (ingredientId: string) => void;
  create: () => void;
  edit: (ingredientId: string) => void;
  consume: (input: ConsumeInput) => Promise<void>;
  restock: (input: RestockInput) => Promise<void>;
  openShopping: (ingredientId: string) => void;
};
~~~

- [ ] **Step 1: 写 model/view-model 失败测试**

覆盖搜索/空列表/过期排序/tracking mode、quantity 与 presence 单位不互换、inventory state 与 batch 冲突、图片失败占位和 selectedId 不存在。

Run: npm --prefix frontend run test -- src/components/ingredients/IngredientWorkspaceBehavior.test.tsx src/components/ingredients/workspaceModel.test.ts

Expected: 新 behavior tests FAIL；现有 model tests 保持 PASS。

- [ ] **Step 2: 提取纯 model 和 view model**

从 useIngredientWorkspaceData、workspaceModel、inventoryOverviewModel 提取过滤/分组/统计；日期和资源 URL 继续使用 lib/date、lib/assets；不在 View new Date 或拼 URL。

- [ ] **Step 3: 提取 actions 和 discriminated overlay state**

create/update/consume/restock/shopping payload、busy/error/conflict 放入 action hook；detail/editor/consume/inventory/shopping 状态使用 kind union，接入现有 IngredientWorkspaceOverlays。

- [ ] **Step 4: 接入独立 desktop/mobile View**

两种 View 只接收 Data/Actions/ViewModel；不导入 api/client 或 React Query，不共享大段 JSX。手机主操作 48px、关闭/返回 hit area 44px，保持 focus restore 和 safe-area。

- [ ] **Step 5: 迁移 Route 并保留一个周期兼容 export**

IngredientWorkspace.tsx 只组合 Route + Frame + View；旧 import 通过 re-export 保留两个稳定版本，Usage test 改为行为/契约断言。

- [ ] **Step 6: 运行验证和提交**

~~~bash
npm --prefix frontend run test -- src/components/ingredients
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
git add frontend/src/components/ingredients
git commit -m "refactor(ingredients): split workspace ports and views"
~~~

Expected: family scope、cache invalidation、tracking mode、overlay focus 和六视口行为不变；主文件趋势 ≤900 行。

Rollback: 恢复旧 Workspace export；不删除新 model/action 测试。

## Task 3.2：拆 Food workspace 的筛选、计划、场景和 dialog

**Files:**

- Create: frontend/src/components/foods/FoodWorkspaceRoute.tsx
- Create: frontend/src/components/foods/FoodWorkspaceData.ts
- Create: frontend/src/components/foods/FoodWorkspaceActions.ts
- Create: frontend/src/components/foods/FoodWorkspaceViewModel.ts
- Create: frontend/src/components/foods/FoodWorkspaceDesktopView.tsx
- Create: frontend/src/components/foods/FoodWorkspaceMobileView.tsx
- Create: frontend/src/components/foods/FoodWorkspaceDialogController.ts
- Create: frontend/src/components/foods/FoodWorkspaceBehavior.test.tsx
- Modify: frontend/src/components/foods/FoodWorkspace.tsx
- Modify: frontend/src/components/foods/FoodWorkspaceUsage.test.ts

**Interfaces:**

- libraryFilter、plan、scene、dialog 是四个互斥 state/reducer 片段；不能共用一个 mutable state object。
- Data 投影 foods、recipes、ingredients、inventory、mealLogs、food plan/scenes/recommendations。
- Actions 覆盖 food create/update/favorite、plan CRUD/complete、scene CRUD、recipe relation、quick meal record 和 stock/shopping shortcut。

- [ ] **Step 1: 写失败 ViewModel 和 dialog tests**

覆盖搜索/筛选/排序/空态、selfMade 与 recipe relation exactly-one、plan 日期切换、scene tag、打开/取消/保存失败保留草稿、row version 和重复提交。

Run: npm --prefix frontend run test -- src/components/foods/FoodWorkspaceBehavior.test.tsx src/components/foods/FoodWorkspace.test.ts src/components/foods/FoodPlanSurface.test.tsx src/components/foods/useFoodPlanState.test.tsx

Expected: 新测试 FAIL，现有 FoodWorkspaceHelpers/Model/Options tests PASS。

- [ ] **Step 2: 提取 Data/Actions/ViewModel**

复用 FoodWorkspaceHelpers、FoodWorkspaceModel、FoodWorkspaceOptions、useFoodPlanState、useFoodSceneState；日期统一使用 foodPlanDateOptions 和 lib/date。

- [ ] **Step 3: 接入 desktop/mobile views 和 dialogs**

Route 组装同一 typed port，桌面/手机使用不同信息架构；FoodPlanDetail、FoodScene、RecipeEditor、QuickMeal dialog 的 open/close/busy/error 由 controller 提供。

- [ ] **Step 4: 用旧 Workspace 做行为 oracle**

相同 fixture 渲染旧/新 route，比较标题、主操作、状态文案、关系错误、plan completion 和导航 target；不以 class 字符串作为唯一断言。

- [ ] **Step 5: 验证并提交**

~~~bash
npm --prefix frontend run test -- src/components/foods
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
git add frontend/src/components/foods
git commit -m "refactor(foods): split workspace state and views"
~~~

Expected: FoodWorkspace 趋势 ≤900 行；favorite、plan completion、meal record invalidation 和六视口 dialog 行为不变。

Rollback: 只回滚 Food route commit，保留共享 food-plan query/action hooks。

## Task 3.3：按 task kind 拆 EatTaskBodies

**Files:**

- Create: frontend/src/features/eat/taskBodies/EatFoodTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatPlanTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatRecipeTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatCookTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatMealTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatMealCreateTaskBody.tsx
- Create: frontend/src/features/eat/taskBodies/EatTaskRelationError.tsx
- Create: frontend/src/features/eat/taskBodies/eatTaskPorts.ts
- Modify: frontend/src/features/eat/EatTaskBodies.tsx
- Create: frontend/src/features/eat/EatTaskBodiesBehavior.test.tsx
- Modify: frontend/src/App.tsx

**Interfaces:**

~~~ts
type EatTaskPort = {
  close: () => void;
  navigate: (target: AppNavigationTarget) => void;
  showNotice: (notice: NoticeInput) => void;
  actions: {
    updateFood: (id: string, payload: UpdateFoodPayload) => Promise<unknown>;
    completePlan: (id: string, payload: CompleteFoodPlanItemPayload) => Promise<unknown>;
    recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
    cook: (id: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  };
};
~~~

- [ ] **Step 1: 写每种 kind 的失败 behavior tests**

覆盖 food、plan、recipe、cook、meal、meal-create、builder 的 loading/load-error/not-found、missing/ambiguous recipe-food relation、updated_at OCC、cook finish、meal candidate resolution、record failure 保留 draft 和 close/focus。

Run: npm --prefix frontend run test -- src/features/eat/EatTaskBodiesBehavior.test.tsx src/features/eat/EatTaskBodies.test.tsx

Expected: 新 behavior tests FAIL；旧 tests PASS。

- [ ] **Step 2: 先建立兼容 adapter**

EatTaskBodies.tsx 继续导出 buildEatTaskBodies，但内部根据 discriminated task.kind 选择新 body；旧 builder 与新 builder 同一 fixture 输出相同可见状态。

- [ ] **Step 3: 移动各 body 和私有 composer**

将 EatRecipeEditTaskBody、EatFreeMealComposerBody、EatPrefixedMealCreateBody 放到对应 task 文件；port 只传准备好的 data/actions，禁止 body 直接调 API。

- [ ] **Step 4: 迁移 App 调用并删除旧实现**

App 只传 EatTaskPort；确认 task close、view return、mobile bottom sheet 和 focus restore 不变后，旧文件只保留 adapter/re-export。

- [ ] **Step 5: 验证和提交**

~~~bash
npm --prefix frontend run test -- src/features/eat src/app
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
git add frontend/src/features/eat frontend/src/App.tsx
git commit -m "refactor(eat): split task bodies by kind"
~~~

Expected: EatTaskBodies 主文件只做 adapter，趋势 ≤900 行；所有 task 状态和 navigation contract 通过。

Rollback: 恢复 adapter 指向旧实现；不改 task union。

## Task 3.4：拆 Inventory reconciliation dialog 和 api/types.ts

**Files:**

- Create: frontend/src/features/inventory/InventoryReconciliationScopeStep.tsx
- Create: frontend/src/features/inventory/InventoryReconciliationReviewStep.tsx
- Create: frontend/src/features/inventory/InventoryReconciliationSummaryStep.tsx
- Create: frontend/src/features/inventory/InventoryReconciliationResultStep.tsx
- Create: frontend/src/features/inventory/inventoryReconciliationDialogModel.ts
- Create: frontend/src/features/inventory/InventoryReconciliationDialogBehavior.test.tsx
- Modify: frontend/src/features/inventory/InventoryReconciliationDialog.tsx
- Create: frontend/src/api/types/primitives.ts
- Create: frontend/src/api/types/shell.ts
- Create: frontend/src/api/types/media.ts
- Create: frontend/src/api/types/inventory.ts
- Create: frontend/src/api/types/recipe.ts
- Create: frontend/src/api/types/food.ts
- Create: frontend/src/api/types/meal.ts
- Create: frontend/src/api/types/search.ts
- Create: frontend/src/api/types/ai.ts
- Create: frontend/src/api/types/modelUsage.ts
- Create: frontend/src/api/types/index.ts
- Modify: frontend/src/api/types.ts

**Interfaces:**

- Dialog ViewModel contains step, field errors, touched intents, focusFieldKey, conflict/result and read-only values; reducer/actions stay outside JSX.
- types/index.ts exports type only; api/types.ts re-exports type only for one migration cycle.

- [ ] **Step 1: 写 reconciliation behavior tests**

覆盖 loading 不锁死 overlay、write busy 禁止关闭、focusFieldKey 聚焦非 hidden、field errors 按 targetKey/field 排序、stale version/conflict/retry/revert/result detail、未触碰项不写入 summary、失败保留草稿。

Run: npm --prefix frontend run test -- src/features/inventory/InventoryReconciliationDialogBehavior.test.tsx src/features/inventory/InventoryReconciliationDialog.test.tsx src/features/inventory/useInventoryReconciliationState.test.tsx src/features/inventory/useInventoryReconciliationActions.test.tsx

Expected: 新 behavior tests FAIL；现有 OCC tests PASS。

- [ ] **Step 2: 拆四个 step View**

InventoryReconciliationDialog.tsx 只保留 dialog aria/header/body/footer、step switch 和 action callbacks；每个 step 不导入 QueryClient/API。

- [ ] **Step 3: 按反向依赖拓扑拆类型**

先 primitives/shell/media，再 inventory/recipe/food/meal/search，最后 ai/modelUsage；循环类型抽到 primitives；所有消费者使用 import type/export type。

- [ ] **Step 4: 验证无 runtime chunk**

~~~bash
npm --prefix frontend run test -- src/features/inventory src/api
npm --prefix frontend run typecheck
npm run frontend:build
rg -n "from ['\\\"].*/api/types['\\\"]" frontend/src --glob '*.ts' --glob '*.tsx'
~~~

Expected: api/types.ts 只有 type re-export；manifest 中 runtime asset 不因类型拆分增加；dialog 趋势 ≤800 行。

- [ ] **Step 5: Commit**

~~~bash
git diff --check
git add frontend/src/features/inventory frontend/src/api/types frontend/src/api/types.ts
git commit -m "refactor(frontend): split reconciliation dialog and api types"
~~~

Rollback: 保留 types.ts barrel 和旧 dialog export；类型拆分回滚不触碰 API。

## Task 3.5：Phase 2/3 集成验收

**Files:**

- Modify: frontend/src/app/*.test.ts*
- Modify: frontend/src/components/ingredients/*test*
- Modify: frontend/src/components/foods/*test*
- Modify: frontend/src/features/eat/*test*
- Modify: frontend/src/features/inventory/*test*
- Modify: docs/plans/2026-08-27-frontend-code-governance-assessment.md
- Modify: docs/superpowers/plans/2026-08-27-frontend-code-governance.md

**Interfaces:**

- Produces: query/mutation ownership report, port dependency report, request-count comparison, six-viewport evidence and rollback commit list.

- [ ] **Step 1: 运行 focused contract/behavior tests**

~~~bash
npm --prefix frontend run test -- src/app src/components/ingredients src/components/foods src/features/eat src/features/inventory src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
~~~

Expected: 所有旧/新 contract 和 behavior tests PASS；失败草稿、OCC、focus、family scope 均有断言。

- [ ] **Step 2: 运行类型、质量、构建和 P0**

~~~bash
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
~~~

- [ ] **Step 3: 比较 health/manifest 和请求拓扑**

记录 App、Ingredient、Food、Eat、Inventory dialog 行数；比较 main/route gzip、静态/动态边、首次激活请求数；发现新增 facade 字段、循环依赖、未登记 chunk 或 routeTotal 增长即停止。

- [ ] **Step 4: 更新文档并提交**

~~~bash
git add docs/plans/2026-08-27-frontend-code-governance-assessment.md docs/superpowers/plans/2026-08-27-frontend-code-governance.md frontend/src/app frontend/src/components/ingredients frontend/src/components/foods frontend/src/features/eat frontend/src/features/inventory frontend/src/api/types frontend/src/api/types.ts
git commit -m "governance(frontend): verify phases 2 and 3"
~~~

Rollback: 按最后一个失败域回滚，不恢复或删除用户 localStorage、AI 草稿、cook session、缓存或服务端数据；保留已通过的 domain hook 与 contract tests。

## Phase 2/3 Definition of Done

- [x] App 只负责认证、壳、导航、route 选择和 typed port；不再新增业务 JSX/API/QueryClient。
- [x] 21 个 query、37 个 mutation 各有唯一 owner；useFoodPlanQueries 是 Home/Eat 共享 food-plan/scenes/recommendations 的唯一 owner；facade 不增字段。
- [x] Router、OverlayHost、inventory/home/navigation controller 的副作用边界和关闭/focus 语义有测试。
- [x] Ingredient、Food、Eat task、reconciliation dialog 的 Data/State/Actions/ViewModel/View 可从依赖图解释，桌面/手机不共享大段 JSX。
- [x] api/types.ts 仅 type re-export，生产 bundle 无新增运行时代码；关键文件达到 App ≤850、Ingredient/Food ≤900、EatTaskBodies ≤900、Inventory dialog ≤800。
- [x] loading/refresh/error/conflict/duplicate submit、family scope、OCC、AI/meal approval 和失败保留语义均通过测试。
- [x] 六固定视口、reduced-motion、focus、safe-area、横向溢出和 route request/manifest diff 有实际记录。

停止条件：任一行为 contract、请求数量、家庭隔离、OCC、焦点或 manifest ratchet 失败时，停止当前域并回滚最近提交；不得用删除测试、扩大 facade 或新增全局 Context 继续推进。
