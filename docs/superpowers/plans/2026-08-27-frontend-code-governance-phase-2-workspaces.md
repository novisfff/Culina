# Phase 2/3：应用组合层与工作台拆分

状态：执行计划（依赖 Phase 0 的健康门禁；Phase 2 先于 Phase 3，本文同时描述两阶段）。

关联文档：

- 体检：[前端代码治理体检](../../plans/2026-08-27-frontend-code-governance-assessment.md)
- 设计规格：[前端代码治理设计规格](../specs/2026-08-27-frontend-code-governance-design.md)
- 总计划：[前端代码治理总执行计划](2026-08-27-frontend-code-governance.md)
- Phase 0：[度量、manifest 与 fail-closed ratchet](2026-08-27-frontend-code-governance-phase-0-gates.md)
- Phase 1：[CSS、token、cascade 与响应式治理](2026-08-27-frontend-code-governance-phase-1-css.md)

本文不改变 API、导航联合类型、React Query key、缓存失效、AI contract 或库存 OCC 语义。目标是让依赖边界可读、可测、可回滚，而不是单纯把代码搬到更多文件。

## 1. 基线、目标和不可破坏边界

### 1.1 需要处理的组合热点

| 文件/模块 | B0 信号 | 目标职责 |
| --- | ---: | --- |
| frontend/src/App.tsx | 1,914 行、51 个顶层 import | 认证分支、应用壳、导航、route 选择和 typed port 组装 |
| app/useAppWorkspaceQueries.ts | 21 个 query | 兼容 facade，内部只委托域 query hook，不再增加字段 |
| app/useAppMutations.ts | 37 个 mutation | 兼容 facade，内部只委托域 action，不再增加 mutation |
| components/ingredients/IngredientWorkspace.tsx | 3,639 行 | route 组合，数据/状态/action/View 分层 |
| components/foods/FoodWorkspace.tsx | 2,493 行 | route 组合，筛选/计划/场景/编辑/记录分层 |
| features/eat/EatTaskBodies.tsx | 1,957 行 | task kind adapter；每种任务 body 独立 |
| features/inventory/InventoryReconciliationDialog.tsx | 1,755 行 | 纯 View + reducer/action port，OCC 仍在 state/action 层 |
| api/types.ts | 2,575 行、219 个生产引用 | 按域 type module，保留 type-only 兼容 barrel |

阶段目标（不是机械行数 KPI）：

- Phase 2 结束：App 不再直接新增业务 JSX、api 调用或 QueryClient 操作；query/mutation facade 的字段和失效语义有域测试。
- Phase 3 结束：Eat 的各 task kind、Ingredient 和 Food 的组合不再集中在单文件；关键文件达到设计规格建议的约 900 行（Inventory dialog 约 800 行）或有书面例外。
- 应用启动、工作区切换和首次激活 route 的请求数量不增加；未激活域不会因顶层组合提前请求。

### 1.2 不可破坏契约

1. query key 只能来自 frontend/src/api/queryKeys.ts；失效只能通过 frontend/src/api/cacheInvalidation.ts。
2. 所有家庭读写从当前 membership 的 family scope 得出，不从 port 或请求 payload 接受可伪造 family/user id。
3. loading 与 refresh 必须区分：已有数据时后台刷新不清空 View；失败时保留旧数据和草稿。
4. 多表动作维持当前事务边界：购物入库、盘点、撤销、餐食记录、计划完成和 AI approval 失败不得发布假成功。
5. AppNavigationState、AppNavigationTarget、task close/focus restore、storage version 和 localStorage key 保持兼容。
6. View 不导入 api/client、useQuery、useMutation 或 QueryClient；这些只在 query/action/controller 层出现。
7. 不创建囊括所有域的全局 Context。需要 Context 时只限单一工作区的只读 view model 或 overlay controller，并提供 provider 边界测试。

## 2. 目标目录与接口

### 2.1 应用组合层

建议新增以下文件；迁移期间旧 facade 保留在原路径，避免一次性改动所有调用方：

~~~
frontend/src/app/
  AppWorkspaceRouter.tsx
  AppOverlayHost.tsx
  appWorkspacePorts.ts
  appRouteEntries.ts
  useAppShellQueries.ts
  useHomeQueries.ts
  useEatQueries.ts
  useIngredientQueries.ts
  useFamilyQueries.ts
  useAiQueries.ts
  useAppInventoryOperations.ts
  useAppHomeController.ts
  useAppNavigationEffects.ts
  mutations/
    useIngredientMutations.ts
    useInventoryMutations.ts
    useRecipeMutations.ts
    useFoodMutations.ts
    useMealMutations.ts
    useAiConversationMutations.ts
~~~

Workspace port 的最小公共形状：

~~~
export type AsyncState<T> = {
  data: T;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown | null;
  retry: () => void;
};

export type WorkspacePort<Data, Actions> = {
  data: Data;
  actions: Actions;
  navigation: AppNavigationService;
};

export type IngredientWorkspacePort =
  WorkspacePort<IngredientWorkspaceData, IngredientWorkspaceActions> & {
    shell: { showNotice: NoticeApi; notificationCenter: ReactNode };
  };
~~~

Data 只能是该工作区已准备好的实体、view model 和 AsyncState；Actions 只能是业务动词、busy/error/conflict 和重试动作。禁止 Record<string, unknown>、any、整个 api 对象、整个 QueryClient 或跨域 mutation map。

### 2.2 AppWorkspaceRouter

AppWorkspaceRouter 只接收：

- navigation state/service；
- shell 已加载的 family、member、notice 和全局通知；
- 各 route 的 typed port；
- route lazy entry 和统一 WorkspaceLoadingFallback。

它负责 primary tab、Eat task 和 Family 子页面选择，不负责拼 mutation payload、计算库存分组、读取 localStorage 或决定 query enabled。每个 route 的 Suspense 边界独立，路由切换不遮挡已经显示的 shell。

### 2.3 AppOverlayHost

AppOverlayHost 只承载跨 route 的 overlay frame 与 controller 输出：

- GlobalSearchOverlay；
- HomeDashboardDialogs；
- InventoryMaintenanceDialogs、操作历史和详情；
- Home 触发的 IngredientShoppingDialog；
- AppNotificationCenter 和 notice toast。

工作区内部的 detail/editor overlay 留在对应 workspace。Host 接受 discriminated union 的 overlay state，不接受多个互相矛盾的 boolean：

~~~
type AppOverlayState =
  | { kind: 'none' }
  | { kind: 'global-search' }
  | { kind: 'home-dialogs'; dialog: HomeDialogState }
  | { kind: 'inventory-operation-history'; operationId?: string }
  | { kind: 'ingredient-shopping'; ingredientId: string };
~~~

busy、close、Escape、focus restore 由 overlay controller 提供；Host 不直接调用 API。

## 3. Phase 2A：query facade 分组

### 3.1 21 个 query 的归属

| 新 hook | 当前 query | enabled/refresh 责任 |
| --- | --- | --- |
| useAppShellQueries | family、members、activityHighlights | 认证后加载；通知/壳数据不阻塞局部 task |
| useHomeQueries | activeMealRecordOperations、必要的 inventory projection | 仅 home 激活时请求；保留后台 refresh；计划/推荐通过共享 food-plan adapter 读取 |
| useIngredientQueries | ingredients、inventory、inventoryStates、shoppingList、inventoryOperationList(20) | ingredients route 激活时请求；盘点/库存操作按 overlay 需要启用 |
| useFoodPlanQueries | foodPlan、foodPlanDetail、foodScenes、foodRecommendations | 由 Home/Eat route 以同一 query key 调用；按 active view/task 精确 enabled，保留 placeholderData |
| useEatQueries | recipes、recipeDiscovery、recipeStats、foods、mealLogs、mealInsights、activeMealRecordOperations | 根据 baseView/task kind 精确 enabled；plan detail 不进入全局 boot blank |
| useFamilyQueries | activityLogs | Family activity overlay/page 激活时请求，保留旧数据后刷新 |
| useAiQueries | aiConversations | AI route 激活时 2 秒轮询；离开 route 停止轮询 |

一个实体可能被两个 route 使用，但 query owner 只有一个；food plan/scenes/recommendations 的 owner 是 useFoodPlanQueries，Home 与 Eat 共享其输出而不各自声明 useQuery。另一个 route 通过已加载的 port data 或共享只读 adapter 读取。Home 的库存 projection 只能使用 ingredient/inventory query 输出，不在 Home 再造 API 请求。

### 3.2 facade 迁移步骤

1. 先为每个新 hook 写 query key、enabled、loading、fetching、error 和 refetch 行为测试；fixture 使用现有 api mocks。
2. 将 useAppWorkspaceQueries 改为组合这些 hook，返回字段名暂时不变，添加 deprecated 注释和禁止新增字段的测试。
3. App 先替换 shell/home，再替换 ingredient/eat/family/AI；每完成一个域，删除 facade 内对应的 useQuery。
4. 迁移所有调用方后删除 facade 字段，而不是长期增加第二个 facade。
5. 对 useAppWorkspaceQueries.test.tsx 保留一个兼容契约测试，验证旧返回形状直到最后消费者消失。

定向测试：

~~~
npm --prefix frontend run test -- src/app/useAppWorkspaceQueries.test.tsx src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
npm --prefix frontend run typecheck
~~~

## 4. Phase 2B：mutation/action 分组

### 4.1 37 个 mutation 的归属

| 新 hook | mutation |
| --- | --- |
| useIngredientMutations | createIngredient、updateIngredient、transitionIngredientTrackingMode |
| useInventoryMutations | createInventory、consumeInventory、disposeExpiredInventory、snoozeInventoryExpiryAlerts、correctInventoryExpiryDate、upsertInventoryState、snoozeStateExpiryAlert、correctStateExpiryDate、setInventoryStateAbsent、submitShoppingIntake、submitInventoryReconciliation、revertInventoryOperation |
| useRecipeMutations | createRecipe、updateRecipe、deleteRecipe、cookRecipe、previewCookRecipe |
| useFoodMutations | createFood、updateFood、toggleFavorite |
| useMealMutations | updateMeal、recordMeal、updateMealComposition、revertMealRecord、completeFoodPlanItem |
| useFoodPlanMutations（可与 useFoodMutations 同文件，接口仍分组） | createFoodPlanItem、updateFoodPlanItem、deleteFoodPlanItem、createFoodScene、updateFoodScene、deleteFoodScene |
| useAiConversationMutations | 仅承载会话 visibility/delete 等非 stream mutation；stream 仍由 AI controller 管理 |
| 兼容 inventory/meal action adapter | 跨域复合动作的编排，不重新定义底层 mutation |

每个 mutation hook 内部拿 QueryClient 并调用对应 cacheInvalidation 函数；View 只接收：

~~~
type InventoryActions = {
  create: (payload: CreateInventoryPayload) => Promise<InventoryItem>;
  reconcile: (payload: InventoryReconciliationRequest) => Promise<InventoryOperationResult>;
  revert: (operationId: string) => Promise<InventoryOperationResult>;
  busy: { reconcile: boolean; revert: boolean };
  error: string | null;
};
~~~

不要把所有 mutation 返回成原始 React Query 对象。需要保留 mutation error/status 时，action adapter 负责把它投影成稳定业务状态。

### 4.2 复合动作与副作用

- useAppInventoryOperations：持有 operation history open/selected/detail/loading/error/conflict/revert，读取 inventoryOperation query，调用 inventory action；成功后更新 banner 和当前 result，失败保留 dialog。
- useAppHomeController：持有 home plan add/detail、inventory action group completion、meal enrichment 和 shopping shortcut；所有 refresh 通过域 action/query adapter，禁止在 controller 里散落 fetchQuery。
- useAppNavigationEffects：集中 reset scroll、task close focus、sidebar storage 和 deep-link 周期；不触碰业务 API。
- useAppHomeHandlers：继续作为纯导航/打开请求 adapter；不能因拆分重新引入全局 state。

当前 App 中的 refreshInventoryActions、loadOperationDetail、handleRevertInventoryOperation、submitHomeShopping 和 free-text link resolution 必须迁入上述 controller。迁移时保留：

1. 盘点/购物入库成功后等待 canonical inventory/shopping refetch，再计算下一项；
2. 409/过期撤销时保留历史 dialog、冲突文案和可恢复按钮；
3. 首页计划完成不发布普通餐食撤销结果；
4. 失败时不清空用户表单，重复点击由 action busy 锁定。

### 4.3 Phase 2 测试与提交边界

每一小步遵循“测试先行—最小迁移—验证—提交”：

1. 新增 port/action contract 测试，先运行并确认失败；
2. 实现 hook/adapter，不改业务文案和 API payload；
3. 运行 focused tests、typecheck、quality、build；
4. 生成 health/manifest diff，确认请求数量和主 chunk 不变差；
5. 单独提交。

推荐提交：

- refactor(app): add typed workspace ports
- refactor(app): split shell and home queries
- refactor(app): split ingredient and inventory actions
- refactor(app): split eat, food and meal actions
- refactor(app): extract inventory operation controller
- refactor(app): extract workspace router and overlay host
- refactor(app): retire app query and mutation facade fields

Phase 2 必跑：

~~~
npm --prefix frontend run test -- src/app src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
~~~

## 5. Phase 3A：Ingredient workspace

### 5.1 建议文件与职责

现有 IngredientWorkspaceFrame、Panels、Overlays 和 state hooks 尽量复用；新增文件只承载单一边界：

~~~
frontend/src/components/ingredients/
  IngredientWorkspaceRoute.tsx       # port 组合和 route boundary
  IngredientWorkspaceData.ts          # typed data/view model
  IngredientWorkspaceActions.ts       # domain action port
  IngredientWorkspaceDesktopView.tsx # 桌面信息架构
  IngredientWorkspaceMobileView.tsx  # 手机信息架构（复用现有 primitives）
  IngredientWorkspaceOverlays.tsx    # 只做 overlay view
  useIngredientWorkspaceViewModel.ts
  useIngredientWorkspaceActions.ts
  useIngredientWorkspaceState.ts     # 现有 state，缩小输入输出
  ingredientWorkspaceModel.ts        # 过滤、分组、默认值、校验
~~~

IngredientWorkspaceRoute 的输入/输出：

~~~
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

迁移顺序：

1. 从现有 useIngredientWorkspaceData/useIngredientWorkspaceState 提取纯 filter/group model，补空列表、搜索、过期、tracking mode 测试。
2. 把 create/update/consume/restock/shopping payload 和 busy/error 放入 action hook；View 不再调用 api。
3. 将 detail/editor/consume/inventory/shopping overlay 的 open state 变成 discriminated union，接入现有 IngredientWorkspaceOverlays。
4. 先替换 desktop view，再替换 mobile view；两者共享 data/actions/model，不共享大段 JSX。
5. 最后把 IngredientWorkspace.tsx 缩为 Route + Frame + View，保留旧 export 的兼容 re-export 一个迁移周期。

保留的行为断言：

- quantity tracking 与 presence tracking 的字段/单位转换不互换；
- inventory state 与 batch 数据不一致时显示冲突而不是静默覆盖；
- 图片上传仍经 useImageComposer，资源 URL 仍经 lib/assets；
- 关闭 overlay 后焦点回到触发按钮，busy 时禁止重复提交和误关闭；
- 家庭 scope 和 cache invalidation 不变。

## 6. Phase 3B：Food workspace

### 6.1 建议文件与职责

~~~
frontend/src/components/foods/
  FoodWorkspaceRoute.tsx
  FoodWorkspaceData.ts
  FoodWorkspaceActions.ts
  FoodWorkspaceViewModel.ts
  FoodWorkspaceDesktopView.tsx
  FoodWorkspaceMobileView.tsx
  FoodWorkspaceDialogController.ts
  FoodWorkspaceDialogs.tsx
  useFoodWorkspaceQueries.ts
  useFoodWorkspaceState.ts
~~~

现有 FoodWorkspaceHelpers、FoodWorkspaceModel、FoodWorkspaceOptions、FoodPlan/Scene state 和各 dialog 作为底层模块；Route 不重复实现它们。

Data 负责 foods、recipes、ingredients、inventory、mealLogs、food plan/scenes/recommendations 的只读投影；Actions 负责：

- food create/update/favorite；
- plan create/update/delete/complete；
- scene create/update/delete；
- recipe relation/edit；
- quick meal record 和 shopping/stock shortcut。

不得让筛选、计划日期、场景标签、编辑表单、quick record dialog 共用一个可变 state object。建议四个互斥 reducer/状态片段：libraryFilter、plan、scene、dialog。所有日期使用现有 date helper，不在 View 直接 new Date 拼 key。

### 6.2 TDD 与迁移

1. 为 FoodWorkspaceViewModel 写搜索/筛选/排序/关系和空状态测试；
2. 为 plan/scene/dialog controller 写打开、切换、取消、保存失败保留草稿和重复提交测试；
3. 将 desktop/mobile View 接到同一 port，先用旧 Workspace 作为 oracle 做行为对照；
4. 移除 App 传入的散乱 callback，改为 FoodWorkspacePort；
5. 删除旧大组件中的 dead branch，保留必要 re-export。

关键回归：

- selfMade 与 recipe relation 仍要求 exactly-one，0 或多条时走明确错误路径；
- favorite、plan completion、meal record 的 invalidation 和 row version 语义不变；
- 复杂 dialog 在 375/390/430 与 768/1024/1440 视口均可操作，不用缩小触控目标。

## 7. Phase 3C：Eat task bodies

### 7.1 按 task kind 拆分

当前 EatTaskBodies.tsx 同时包含 food、plan、recipe、cook、meal、meal-create 和 builder。建议保留兼容入口并拆成：

~~~
frontend/src/features/eat/
  taskBodies/
    EatFoodTaskBody.tsx
    EatPlanTaskBody.tsx
    EatRecipeTaskBody.tsx
    EatCookTaskBody.tsx
    EatMealTaskBody.tsx
    EatMealCreateTaskBody.tsx
    EatTaskRelationError.tsx
    eatTaskPorts.ts
  EatTaskBodies.tsx       # 只做 discriminated-union adapter/re-export
~~~

eatTaskPorts.ts 只定义业务动作和已准备数据：

~~~
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

EatRecipeEditTaskBody、EatFreeMealComposerBody、EatPrefixedMealCreateBody 作为对应 task 文件的私有子视图，不再让所有任务共享模块级 mutable helper。

### 7.2 迁移和测试

1. 先把现有测试 imports 改为新文件的兼容 export，保证测试能识别迁移边界；
2. 为每个 task kind 写最小渲染/状态测试，再逐个移动 JSX；
3. 用旧 builder 和新 builder 做同一 fixture 的 kind/output 对照；
4. 迁移 App 的 buildEatTaskBodies 调用到 EatTaskPort；
5. 删除旧文件中已空的实现，只保留 adapter。

保留：

- loading、load-error、not-found、missing/ambiguous recipe-food relation；
- plan cook 的 updated_at OCC 前置检查；
- cook finish、meal candidate resolution、record failure 草稿；
- task 关闭/返回 view/focus 和 mobile bottom sheet 语义。

## 8. Phase 3D：InventoryReconciliationDialog 与类型模块

### 8.1 盘点 dialog

现有 useInventoryReconciliationState、useInventoryReconciliationActions 和 inventoryReconciliationModel 已提供良好边界；只把 1,755 行 View 再按责任拆开：

~~~
frontend/src/features/inventory/
  InventoryReconciliationDialog.tsx      # shell、step switch、aria
  InventoryReconciliationScopeStep.tsx
  InventoryReconciliationReviewStep.tsx
  InventoryReconciliationSummaryStep.tsx
  InventoryReconciliationResultStep.tsx
  inventoryReconciliationDialogModel.ts  # field error/summary projection
~~~

Dialog props 变为一个只读 ViewModel 和 typed callbacks，步骤 reducer/action 不放进 JSX。必须保留：

- loading 不锁死 overlay；只有 write busy 阻止关闭；
- focusFieldKey 自动聚焦非 hidden 字段；
- field errors 按 targetKey/field 稳定排序；
- stale version/conflict、retry、revert 和 result detail 不丢；
- submit summary 只显示 touched intents，未触碰项不写入。

先新增每个 step 的行为测试，再移动 JSX；运行现有 InventoryReconciliationDialog.test.tsx、useInventoryReconciliation* 测试和六视口 P0。

### 8.2 api/types.ts 拆分

建议新建 type-only modules：

~~~
frontend/src/api/types/
  shell.ts          # User、Member、Family、Auth
  media.ts
  inventory.ts      # Ingredient、Inventory、Shopping、Reconciliation、Operation
  recipe.ts
  food.ts
  meal.ts
  search.ts
  ai.ts
  modelUsage.ts
  index.ts          # 兼容 barrel，仅 export type
frontend/src/api/types.ts  # 迁移期 re-export type ./types/index
~~~

规则：

1. 先按依赖反向拓扑拆：shell/media → inventory/recipe/food/meal/search → ai/modelUsage；
2. 只使用 export type/import type，确保不产生 runtime chunk；
3. 循环类型用 type-only 前向引用或抽到 primitives.ts，禁止互相运行时 import；
4. 每次移动保留 api/types.ts 的旧路径，更新一小批消费者后再删内部重复定义；
5. 用 TypeScript 编译和 bundle manifest 验证类型拆分没有改变运行时资源。

## 9. 统一测试、指标和回滚

### 9.1 每个工作包命令

~~~
npm --prefix frontend run test -- <focused-tests>
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
~~~

Focused tests 至少覆盖对应 model、state/action、workspace behavior、cache invalidation 和 navigation contract；不要只运行 Usage 字符串测试。

### 9.2 视口和网络证据

涉及 workspace/overlay 的提交固定验证 375×812、390×844、430×932、768×1024、1024×768、1440×900，记录截图/trace 和横向溢出断言。构建后比较：

- main JS/CSS initial；
- route entryCritical 与 routeTotal；
- 新旧静态/动态依赖边；
- 激活 Home/Eat/Ingredients/AI/Family 时的请求数量。

App facade 拆分不应改变请求时序；若改变，先解释 enabled/placeholderData/后台 refresh 的意图并补测试。

### 9.3 停止条件与回滚

遇到以下任一情况，停止当前域迁移，恢复最近一个已验证提交：

- port/View 行为测试失败，或 App/Ingredient 仍只能靠隐式全局 Context 工作；
- 家庭隔离、row version、OCC、AI/meal approval 或失败保留语义变化；
- routeTotal 增长超过 ratchet 容差，或把代码移到未登记 chunk；
- 任一固定视口主操作不可达、横向溢出、焦点恢复失败；
- 只移动文件但 import graph 没有变薄，出现新增循环或 facade 字段继续增加。

回滚不清理用户 localStorage、AI 草稿、cook session 或服务端数据。每个域的最后一个兼容 re-export 保留到两个稳定版本后再删除。

### 9.4 Phase 3 Definition of Done

- [ ] App 只做认证/壳/导航/route/port 组合；业务 API 与复合副作用已移出。
- [ ] 21 个 query、37 个 mutation 均有唯一 owner；旧 facade 不再增加字段。
- [ ] Ingredient、Food、Eat task、盘点 dialog 的 data/state/action/view 边界可从依赖图解释。
- [ ] api/types.ts 兼容 barrel 只做 type re-export，生产 bundle 无新增运行时代码。
- [ ] 关键桌面/手机行为、错误/冲突/重复提交、导航 focus 和六视口证据齐全。
- [ ] 生产构建和 health ratchet 没有因拆分产生隐藏 chunk 或请求回归。
