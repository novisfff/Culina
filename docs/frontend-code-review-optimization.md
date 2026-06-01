# 前端代码优化与重构审查

更新时间：2026-06-01

## 审查范围

本次主要检查 `frontend` 下的 React/Vite 前端代码，包括：

- 应用入口：`frontend/src/main.tsx`、`frontend/src/App.tsx`
- API 与鉴权：`frontend/src/api/client.ts`、`frontend/src/auth/AuthContext.tsx`
- 业务工作台：`frontend/src/components/foods`、`frontend/src/components/recipes`、`frontend/src/components/ingredients`、`frontend/src/components/ai`
- 公共工具与 UI：`frontend/src/lib`、`frontend/src/components/ui-kit.tsx`
- 全局样式：`frontend/src/styles.css`
- 测试与构建配置：`frontend/package.json`、`frontend/vite.config.ts`、`frontend/tsconfig.json`

验证结果：

- `npm --prefix frontend run test` 通过：`12 passed`，`75 passed`。
- `npm --prefix frontend run build` 通过。
- `npm --prefix frontend run smoke` 通过：登录页、桌面首页、食物/食材/菜谱 tab、`390x844` 与 `768x1024` 视口横向溢出检查。
- 构建产物：主 JS `index-ClT7Jjzf.js` 约 `330.74 kB`，主 CSS `index-00xKl57G.css` 约 `563.64 kB`。
- 工作台/家庭设置已拆为懒加载 chunk：`AiWorkspace` 约 `18.15 kB`、`FamilySettings` 约 `29.00 kB`、`FoodWorkspace` 约 `78.09 kB`、`RecipeWorkspace` 约 `103.66 kB`、`IngredientWorkspace` 约 `119.61 kB`。
- Vite 主 chunk 超过 500KB 的警告已消除；CSS 仍是后续体积优化重点。

## 已完成优化记录

| 状态 | 优化项 | 完成内容 | 相关文件 | 验证 |
| --- | --- | --- | --- | --- |
| 已完成 | React Query key 集中管理 | 新增集中 query key，并替换 `App.tsx`、`AuthContext.tsx`、`AiWorkspace.tsx` 中的裸字符串 query key | `frontend/src/api/queryKeys.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | Mutation 缓存失效规则集中管理 | 新增按业务动作划分的缓存失效函数，并替换 `App.tsx`、`AiWorkspace.tsx` 中重复 `invalidateQueries` | `frontend/src/api/cacheInvalidation.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 工作台级 code splitting | 使用 `React.lazy` 和 `Suspense` 懒加载 AI、家庭设置、食物、菜谱、食材，主 JS 从约 658KB 降至约 322KB | `frontend/src/App.tsx`、`frontend/src/features/family/FamilySettings.tsx` | `npm --prefix frontend run build` |
| 已完成 | 图片生成/上传 hook 第一阶段 | 新增 `useImageComposer`，统一参考图上传、直接上传、文本生成、参考图重试、失败保留参考图和重置状态 | `frontend/src/hooks/useImageComposer.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 食物图片入口接入统一 hook | `FoodWorkspace` 食物资料卡图片入口不再直接调用底层 AI 生图函数 | `frontend/src/components/foods/FoodWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 食材图片入口接入统一 hook | `IngredientWorkspace` 食材资料卡图片入口不再直接调用底层 AI 生图函数 | `frontend/src/components/ingredients/IngredientWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | `App.tsx` 图片入口接入统一 hook | 餐食照片、个人头像、家庭头像已接入 `useImageComposer`，并移除 `App.tsx` 内重复图片状态机函数 | `frontend/src/App.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 菜谱图片入口接入统一 hook | `RecipeWorkspace` 菜谱封面上传、参考图重试、文本生成已接入 `useImageComposer`，移除菜谱封面重复图片状态机 | `frontend/src/components/recipes/RecipeWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 日期、资源 URL、localStorage 工具第一阶段 | 新增 `lib/date.ts`、`lib/assets.ts`、`lib/storage.ts`，并迁移日期周范围、食材工作台缓存、菜谱做菜会话缓存、工作台/首页/AI/UI kit 资源 URL 解析等低风险入口 | `frontend/src/lib/date.ts`、`frontend/src/lib/assets.ts`、`frontend/src/lib/storage.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 拆薄 `App.tsx` | 已完成数据 key/失效规则抽离、工作台懒加载、图片状态机抽离、应用壳 `AppShell` 与壳层图标抽离、首页 `HomeDashboard` 展示层抽离、首页 view model 构造抽离、首页 UI state hook 第一阶段、首页计划/详情/补货/过期处理 action hook 第一阶段、餐食记录表单与状态/提交 hook 抽离、食物创建遗留死代码清理、家庭设置展示容器与弹窗抽离、家庭设置 state hook 与 submit 行为下沉 | `frontend/src/App.tsx`、`frontend/src/app/AppShell.tsx`、`frontend/src/app/shellIcons.tsx`、`frontend/src/features/home/HomeDashboard.tsx`、`frontend/src/features/home/homeDashboardModel.ts`、`frontend/src/features/home/useHomeDashboardState.ts`、`frontend/src/features/home/useHomeDashboardActions.ts`、`frontend/src/features/meals/MealLogComposer.tsx`、`frontend/src/features/meals/useMealLogComposerState.ts`、`frontend/src/features/family/FamilySettings.tsx`、`frontend/src/features/family/FamilySettingsModals.tsx`、`frontend/src/features/family/useFamilySettingsState.ts` | `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build`、`npm --prefix frontend run smoke` |
| 部分完成 | `FoodWorkspace` 内部拆分第一阶段 | 抽出食物工作台纯 UI primitives、工作台配置常量、食物表单 model/helper、菜单计划 hook、场景管理 hook、详情抽屉组件和编辑表单组件，保留 `FoodWorkspace` 兼容导出，主文件从约 3,218 行降到约 2,061 行 | `frontend/src/components/foods/FoodWorkspace.tsx`、`frontend/src/components/foods/FoodEditorForm.tsx`、`frontend/src/components/foods/FoodWorkspacePrimitives.tsx`、`frontend/src/components/foods/FoodWorkspaceOptions.ts`、`frontend/src/components/foods/FoodWorkspaceModel.ts`、`frontend/src/components/foods/useFoodPlanState.ts`、`frontend/src/components/foods/useFoodSceneState.ts`、`frontend/src/components/foods/FoodDetailDrawer.tsx` | `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build`、`npm --prefix frontend run smoke` |
| 部分完成 | `RecipeWorkspace` 内部拆分第二阶段 | 抽出菜谱工作台静态配置、表单/payload/做菜 session/购物草稿/AI 草稿等 model helper，封面/卡片等展示组件，AI 草稿、菜单计划、购物确认、做菜完成确认和场景管理弹窗，以及新增/编辑、详情、做菜、library/移动端首页视图；主文件从约 5,161 行降到约 2,109 行 | `frontend/src/components/recipes/RecipeWorkspace.tsx`、`frontend/src/components/recipes/RecipeWorkspaceOptions.ts`、`frontend/src/components/recipes/RecipeWorkspaceModel.ts`、`frontend/src/components/recipes/RecipeWorkspaceCards.tsx`、`frontend/src/components/recipes/RecipeLibraryView.tsx`、`frontend/src/components/recipes/RecipeEditorView.tsx`、`frontend/src/components/recipes/RecipeDetailView.tsx`、`frontend/src/components/recipes/RecipeCookView.tsx`、`frontend/src/components/recipes/RecipeDraftDialog.tsx`、`frontend/src/components/recipes/RecipePlanDialogs.tsx`、`frontend/src/components/recipes/RecipeShoppingDialog.tsx`、`frontend/src/components/recipes/RecipeCookFinishDialog.tsx`、`frontend/src/components/recipes/RecipeSceneManagerDialog.tsx` | `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 菜谱图片入口统一化 | `RecipeWorkspace` 的菜谱封面已接入统一 hook；AI 草稿封面、场景封面仍保留独立业务流程 | `frontend/src/components/recipes/RecipeWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 文件体量预算检查 | 新增无外部依赖的 `check:size`，限制新增 React 文件超过 1000 行，并为现有超大文件建立收敛预算；`App.tsx` 预算已随应用壳抽离从 5500 收紧到 5000 行 | `frontend/scripts/check-file-budgets.mjs`、`frontend/package.json` | `npm --prefix frontend run check:size` |
| 已完成 | API client 按资源拆分与错误边界第一阶段 | 新增 `request.ts` 承载 request/token/`ApiError`，按资源拆出 `authApi`、`familyApi`、`ingredientsApi`、`foodsApi`、`recipesApi`、`aiApi`、`mediaApi`，聚合 `api` 保持兼容；request 失败时携带 `status`、`detail`、`path`、`payload`，401 自动清理 token | `frontend/src/api/request.ts`、`frontend/src/api/*Api.ts`、`frontend/src/api/client.ts`、`frontend/src/api/client.test.ts` | `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 表单错误提示层第一阶段 | 新增 `useNotice`，并将 `App.tsx`、`FoodWorkspace`、`RecipeWorkspace`、`IngredientWorkspace` 中的直接 `window.alert` 迁移为非阻塞 notice toast | `frontend/src/hooks/useNotice.ts`、`frontend/src/App.tsx`、`frontend/src/components/foods/FoodWorkspace.tsx`、`frontend/src/components/recipes/RecipeWorkspace.tsx`、`frontend/src/components/ingredients/IngredientWorkspace.tsx` | `npm --prefix frontend run check:size`、`npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 端到端 smoke test 第一阶段 | 新增 Playwright smoke，启动 Vite preview 构建产物并 mock 后端 API，覆盖登录页、桌面首页、食物/食材/菜谱 tab 切换、`390x844` 与 `768x1024` 横向溢出检查；同步修复 768px 首页周菜单横向溢出，并屏蔽外部字体请求避免网络抖动导致 `domcontentloaded` 超时 | `frontend/scripts/smoke.mjs`、`frontend/package.json`、`frontend/src/styles.css` | `npm --prefix frontend run build`、`npm --prefix frontend run smoke` |
| 待处理 | 全局 CSS 拆分 | `styles.css` 仍为单一大文件，CSS 体积仍约 563KB | `frontend/src/styles.css` | 待拆分后验证 |

## 总体判断

当前前端已经具备较完整的业务能力，类型检查开启了 `strict`，并且核心 view model、AI 工作台、菜谱/食物/食材部分逻辑已有单测覆盖。主要风险不是功能不可用，而是复杂度已经集中到少数文件，后续迭代会越来越容易出现回归。

最高优先级问题集中在四个方向：

- `App.tsx` 是应用壳、首页、查询层、mutation 层、弹窗层和多个表单状态的混合体。
- 业务工作台组件过大，单文件承载 view model、交互状态、表单、异步动作和渲染。
- 全局 CSS 体量过大且缺少模块边界，样式修改的影响范围难以判断。
- React Query 的 query key、失效策略和业务 hook 还没有集中管理，重复失效和过度请求会随着功能增长放大。

## 代码体量快照

当前最需要拆分的文件：

- `frontend/src/styles.css`：约 34,073 行。
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`：约 5,937 行。
- `frontend/src/components/recipes/RecipeWorkspace.tsx`：约 2,109 行。
- `frontend/src/components/recipes/RecipeWorkspaceModel.ts`：约 824 行。
- `frontend/src/components/recipes/RecipeEditorView.tsx`：约 600 行。
- `frontend/src/components/recipes/RecipeLibraryView.tsx`：约 552 行。
- `frontend/src/components/recipes/RecipeWorkspaceCards.tsx`：约 514 行。
- `frontend/src/components/recipes/RecipeCookView.tsx`：约 383 行。
- `frontend/src/components/recipes/RecipeDetailView.tsx`：约 288 行。
- `frontend/src/components/recipes/RecipePlanDialogs.tsx`：约 279 行。
- `frontend/src/components/recipes/RecipeShoppingDialog.tsx`：约 248 行。
- `frontend/src/components/recipes/RecipeSceneManagerDialog.tsx`：约 155 行。
- `frontend/src/components/recipes/RecipeCookFinishDialog.tsx`：约 119 行。
- `frontend/src/components/recipes/RecipeDraftDialog.tsx`：约 102 行。
- `frontend/src/App.tsx`：约 1,939 行。
- `frontend/src/features/home/HomeDashboard.tsx`：约 896 行。
- `frontend/src/app/shellIcons.tsx`：约 390 行。
- `frontend/src/app/AppShell.tsx`：约 211 行。
- `frontend/src/features/meals/MealLogComposer.tsx`：约 187 行。
- `frontend/src/features/meals/useMealLogComposerState.ts`：约 145 行。
- `frontend/src/features/family/FamilySettings.tsx`：约 633 行。
- `frontend/src/features/family/FamilySettingsModals.tsx`：约 567 行。
- `frontend/src/features/family/useFamilySettingsState.ts`：约 335 行。
- `frontend/src/features/home/homeDashboardModel.ts`：约 356 行。
- `frontend/src/features/home/useHomeDashboardState.ts`：约 166 行。
- `frontend/src/features/home/useHomeDashboardActions.ts`：约 211 行。
- `frontend/src/components/foods/FoodWorkspace.tsx`：约 2,061 行。
- `frontend/src/components/foods/FoodEditorForm.tsx`：约 356 行。
- `frontend/src/components/foods/FoodDetailDrawer.tsx`：约 247 行。
- `frontend/src/components/foods/FoodWorkspaceModel.ts`：约 165 行。
- `frontend/src/components/foods/useFoodPlanState.ts`：约 247 行。
- `frontend/src/components/foods/useFoodSceneState.ts`：约 201 行。
- `frontend/src/components/foods/FoodWorkspacePrimitives.tsx`：约 290 行。
- `frontend/src/components/foods/FoodWorkspaceOptions.ts`：约 88 行。
- `frontend/src/components/recipes/RecipeWorkspaceOptions.ts`：约 99 行。
- `frontend/src/api/client.ts`：约 19 行，已收敛为 API 聚合入口。

这几个文件不是单纯“行数多”，而是职责跨度过大。例如 `App.tsx` 在 `frontend/src/App.tsx:799` 之后同时维护 30 多个本地状态、16 个 query 和 20 多个 mutation；食物、菜谱、食材工作台也各自维护大量页面状态和异步提交逻辑。

## 优先级 P0：近期应先处理

### 1. 拆薄 `App.tsx`，建立应用壳和首页边界

处理状态：部分完成（2026-06-01）。

已完成：

- React Query key 和 mutation 缓存失效规则已从 `App.tsx` 抽离。
- 四个大工作台已从 `App.tsx` 静态 import 改为 `React.lazy` 懒加载。
- 餐食照片、个人头像、家庭头像的图片状态机已从 `App.tsx` 抽到 `useImageComposer`。
- 侧边栏、桌面 tabbar、移动端底部导航和壳层用户卡已抽到 `frontend/src/app/AppShell.tsx`。
- 壳层 SVG 图标已抽到 `frontend/src/app/shellIcons.tsx`，供 `AppShell` 与现有家庭/首页页面复用。
- 餐食记录表单已抽到 `frontend/src/features/meals/MealLogComposer.tsx`，餐食条目、参与人、照片生成和提交重置流程已抽到 `frontend/src/features/meals/useMealLogComposerState.ts`。
- 首页 dashboard 展示层已抽到 `frontend/src/features/home/HomeDashboard.tsx`。
- 首页 dashboard view model、到期天数、临期 badge、周菜单范围、首页补货默认值、采购项匹配、正数解析等纯逻辑已抽到 `frontend/src/features/home/homeDashboardModel.ts`，并新增单测。
- 首页推荐分页、周菜单选中日期、首页菜单弹窗、临期/补货/餐食详情弹窗 id 与表单状态已抽到 `frontend/src/features/home/useHomeDashboardState.ts`。
- 首页计划新增、计划详情、补货和过期处理 action 流程已抽到 `frontend/src/features/home/useHomeDashboardActions.ts`。
- 家庭设置 overlay、成员/个人/密码/家庭表单、个人头像/家庭图 prompt、图片 composer 和创建/更新提交行为已抽到 `frontend/src/features/family/useFamilySettingsState.ts`。
- 家庭设置展示容器已抽到 `frontend/src/features/family/FamilySettings.tsx`，并作为独立 lazy chunk 加载。
- 家庭设置里的创建成员、修改成员信息、修改密码、个人资料编辑、家庭资料编辑弹窗已抽到 `frontend/src/features/family/FamilySettingsModals.tsx`。
- 食物创建已迁移到 `FoodWorkspace` 后，`App.tsx` 中遗留的食物创建表单状态、图片状态和 submit 死代码已清理。
- `App.tsx` 从约 5,133 行降到约 1,939 行，`check:size` 中 `App.tsx` 收敛预算从 5500 行收紧到 5000 行。

待处理：

- 剩余 App submit/workflow state 主要集中在 AI 入口状态和跨工作台编排。
- 三大工作台内部拆分、全局 CSS 拆分仍待继续推进。

位置：

- `frontend/src/App.tsx:799`
- `frontend/src/App.tsx:933`
- `frontend/src/App.tsx:1027`
- `frontend/src/App.tsx:1320`

问题：

- `App.tsx` 同时负责登录后 boot loading、首页 dashboard、AI 入口和跨工作台导航，仍承担较多组合与编排职责。
- 查询和 mutation 全部写在组件内，导致首页任何改动都可能触碰全局数据流。
- 大量本地 UI 状态互相交织，例如 `familyOverlayMode`、`homePlanDetailItemId`、`homeRestockForm`、`pendingRecipeCookId` 都在同一层。

建议：

- 新增 `frontend/src/app/AppShell.tsx`：承接侧边栏、tab 路由、移动端底部导航和应用壳布局。
- 新增 `frontend/src/features/home/HomeDashboard.tsx`：承接首页 dashboard、今日计划、临期、采购和近期餐食。
- 新增 `frontend/src/features/family/FamilySettings.tsx`：承接家庭资料、成员管理、个人资料和密码修改弹窗。
- 新增 `frontend/src/features/meals/MealLogComposer.tsx`：承接首页餐食记录表单和图片生成。
- `App.tsx` 最终收敛为组合层，目标控制在 300-500 行。

落地顺序：

1. 先抽纯展示组件，不改变数据来源。
2. 再抽 `useHomeDashboardState`、`useFamilySettingsState` 这类局部 hook。
3. 最后把 query/mutation 移到 domain hook 中。

验收标准：

- `App.tsx` 不直接包含业务表单 submit 逻辑。
- `App.tsx` 不直接维护首页弹窗内部 form state。
- 首页相关单测可以绕过完整 `App` 渲染，直接测 dashboard view model 或交互组件。

### 2. 集中 React Query key 和 mutation 失效规则

处理状态：已完成第一阶段（2026-06-01）。

位置：

- `frontend/src/App.tsx:933`
- `frontend/src/App.tsx:1027`
- `frontend/src/components/ai/AiWorkspace.tsx:149`
- `frontend/src/components/ai/AiWorkspace.tsx:377`

问题：

- query key 以字符串散落在多个文件中，例如 `['foods']`、`['food-plan']`、`['activity-logs']`。
- mutation 的 `invalidateQueries` 重复且手写，新增字段或接口时容易漏失效。
- 存在“全页面都要用”的查询和“当前工作台才需要”的查询混在 `App.tsx` 中，首屏加载成本偏高。

建议：

- 新增 `frontend/src/api/queryKeys.ts`，集中定义：

```ts
export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  foods: ['foods'] as const,
  foodPlan: (start: string, end: string) => ['food-plan', start, end] as const,
  aiMessages: (conversationId: string) => ['ai-messages', conversationId] as const,
};
```

- 新增 `frontend/src/api/cacheInvalidation.ts`，按业务动作维护失效集合，例如 `invalidateAfterFoodChanged(queryClient)`。
- 新增 domain hook：`useFoodsData`、`useRecipesData`、`useIngredientsData`、`useFamilyData`。
- 工作台内部自己拉取非首屏必要数据，或使用 `enabled: activeTab === 'recipes'` 延迟加载。

验收标准：

- 业务组件不再手写裸字符串 query key。（已完成）
- 同一业务动作的失效范围只定义一次。（已完成第一阶段）
- 首页首屏不必等待 AI conversations、菜谱 discovery、非当前 tab 的全部数据。

落地：

- 新增 `frontend/src/api/queryKeys.ts`，集中维护 React Query key。
- 新增 `frontend/src/api/cacheInvalidation.ts`，集中维护成员、家庭、食材、库存、购物清单、菜谱、食物、菜单计划、AI 会话等 mutation 成功后的缓存失效规则。
- `App.tsx`、`AuthContext.tsx`、`AiWorkspace.tsx` 已改为使用集中 key 与失效函数。

### 3. 拆分三大业务工作台

处理状态：部分完成（2026-06-01）。

已完成：

- 四个大工作台已在应用层懒加载，减少首屏主包体积。
- `FoodWorkspace` 和 `IngredientWorkspace` 的资料卡图片生成逻辑已抽到 `useImageComposer`。
- `FoodWorkspace` 的图标、评分输入等纯 UI primitives 已抽到 `frontend/src/components/foods/FoodWorkspacePrimitives.tsx`。
- `FoodWorkspace` 的类型/餐别选项、治理 issue 配置和 lens copy 已抽到 `frontend/src/components/foods/FoodWorkspaceOptions.ts`。
- `FoodWorkspace` 的表单状态类型、空表单/编辑表单转换、图片 payload、完成度检查和提交 payload 构造已抽到 `frontend/src/components/foods/FoodWorkspaceModel.ts`。
- `FoodWorkspace` 的菜单计划弹窗、计划详情、周视图 view model 和新增/更新/删除/完成动作已抽到 `frontend/src/components/foods/useFoodPlanState.ts`。
- `FoodWorkspace` 的场景 manager/form 弹窗、场景列表 view model、封面生成和场景创建/更新/删除动作已抽到 `frontend/src/components/foods/useFoodSceneState.ts`。
- `FoodWorkspace` 的详情抽屉 JSX 已抽到 `frontend/src/components/foods/FoodDetailDrawer.tsx`。
- `FoodWorkspace` 的新增/编辑表单 JSX 已抽到 `frontend/src/components/foods/FoodEditorForm.tsx`。
- `RecipeWorkspace` 的筛选、排序、餐别、购物单位、场景、AI 草稿和计时器静态配置已抽到 `frontend/src/components/recipes/RecipeWorkspaceOptions.ts`。
- `RecipeWorkspace` 的表单状态类型、payload 构造、AI 草稿校验/回填、做菜 session localStorage、购物草稿和场景图片 payload 已抽到 `frontend/src/components/recipes/RecipeWorkspaceModel.ts`。
- `RecipeWorkspace` 的通用图标、菜谱封面、桌面/移动端菜谱卡片、发现卡片、缩略图和侧栏卡片已抽到 `frontend/src/components/recipes/RecipeWorkspaceCards.tsx`。
- `RecipeWorkspace` 的 AI 草稿弹窗、菜单计划新增/详情弹窗、购物确认弹窗、做菜完成确认弹窗和场景管理弹窗已分别抽到独立组件。
- `RecipeWorkspace` 的新增/编辑表单视图、详情视图和完整做菜页面视图已分别抽到独立组件，主文件继续承接数据计算、状态和业务动作编排。
- `RecipeWorkspace` 的 library 首页和移动端首页视图已抽到 `frontend/src/components/recipes/RecipeLibraryView.tsx`。

待处理：

- 三大工作台内部仍需继续拆为更完整的 `components`、`hooks`、`model`、`storage` 等目录；`FoodWorkspace` 已完成第一阶段拆分但移动端/列表展示、计划弹窗 JSX 和场景弹窗 JSX 仍在主文件内；`RecipeWorkspace` 已完成 model、主要视图和弹窗拆分，但大量 state/effect/action 仍在主文件内。

位置：

- `frontend/src/components/ingredients/IngredientWorkspace.tsx:2040`
- `frontend/src/components/recipes/RecipeWorkspace.tsx:1556`
- `frontend/src/components/foods/FoodWorkspace.tsx:1201`

问题：

- `IngredientWorkspace`、`RecipeWorkspace`、`FoodWorkspace` 都在组件内维护大量 `useState`、`useMemo`、`useEffect` 和 submit 函数。
- 同一文件里同时包含 icon、card、dialog、view model、表单转换、localStorage、图片生成、异步保存。
- 文件过大后 review 成本很高，局部改动容易被无关 JSX 和样式噪音淹没。

建议拆分目录：

```text
frontend/src/features/recipes/
  RecipeWorkspace.tsx
  components/
    RecipeCard.tsx
    RecipeEditor.tsx
    RecipeCookDialog.tsx
    RecipePlanPanel.tsx
    RecipeSceneManager.tsx
  hooks/
    useRecipeWorkspaceState.ts
    useRecipeCookSession.ts
    useRecipeDraftGeneration.ts
  model/
    recipePayload.ts
    recipeShoppingDrafts.ts
    recipeFilters.ts
```

食物和食材也按相同模式拆：

- `components`：只放渲染组件。
- `hooks`：放本地状态和副作用。
- `model`：放纯函数、payload 构造、排序筛选。
- `storage`：放 localStorage key、读写、迁移。

验收标准：

- 单个 React 组件文件目标不超过 600-900 行。
- 提交函数和 payload 构造函数分离，payload 构造函数有单测。
- dialog/drawer 能独立渲染和测试，不依赖整个工作台。

### 4. 拆分全局 CSS，降低样式回归风险

处理状态：部分完成（2026-06-01）。

位置：

- `frontend/src/styles.css`

问题：

- 单文件约 34,048 行，选择器约 4,327 个。
- 全局 class 命名覆盖所有页面，修改一个 `.card`、`.workspace-*` 或响应式规则时影响范围很难评估。
- 构建 CSS 约 563KB，首屏会加载所有工作台样式。

建议：

- 第一阶段按领域拆文件，但仍保持全局 CSS 导入，降低迁移成本：

```text
frontend/src/styles/
  tokens.css
  base.css
  layout.css
  components.css
  home.css
  foods.css
  recipes.css
  ingredients.css
  ai.css
  mobile.css
```

- 第二阶段为新拆出的组件引入 CSS Modules 或按 feature scoped class 前缀。
- 把颜色、阴影、间距、断点集中到 `tokens.css`，减少同类值漂移。
- 在迁移前用截图或 Playwright smoke test 固定几个关键视口，避免移动端布局回归。

验收标准：

- `styles.css` 只作为聚合入口或被移除。
- 任一业务样式修改只触碰对应 feature 样式文件。
- CSS 构建体积有明确预算，例如 gzip 后控制在 70KB 以内，超过需要说明原因。

## 优先级 P1：中期重构

### 1. 统一图片生成和上传状态

处理状态：已完成第一阶段（2026-06-01）。

位置：

- `frontend/src/App.tsx:1458`
- `frontend/src/components/foods/FoodWorkspace.tsx:1533`
- `frontend/src/components/recipes/RecipeWorkspace.tsx:2824`
- `frontend/src/components/ingredients/IngredientWorkspace.tsx:2354`

问题：

- 图片上传、参考图生成、纯文本生成、错误兜底在多个组件中重复实现。
- 每个组件都维护自己的 `ImageGenerationUiState`，错误文案和参考图保留策略不完全一致。

建议：

- 新增 `frontend/src/hooks/useImageComposer.ts`。
- 输入为 `buildPayload`、`onChange`、默认错误文案。
- 输出统一的 `state`、`uploadReference`、`generateFromText`、`regenerateFromReference`、`reset`。
- `ImageComposer` 组件只接收 hook 输出，不再承载业务差异。

验收标准：

- `App.tsx` 中餐食照片、个人头像、家庭头像，以及食物/食材资料卡组件不直接调用 `uploadReferenceAndGenerateImage`、`regenerateImageFromReference`、`generateImageFromText`。（已完成）
- 失败时参考图保留、错误展示、按钮 pending 状态一致。（餐食、头像、家庭图、食物与食材资料卡已完成）

落地：

- 新增 `frontend/src/hooks/useImageComposer.ts`，统一封装上传参考图、直接上传、参考图重试、文本生成、失败保留参考图、重置状态。
- `FoodWorkspace` 的食物图片入口已接入该 hook。
- `IngredientWorkspace` 的食材图片入口已接入该 hook。
- `App.tsx` 中餐食照片、个人头像、家庭头像已接入该 hook。
- `RecipeWorkspace` 中菜谱封面上传、参考图重试、文本生成已接入该 hook；食物/菜谱场景封面生成目前保留独立逻辑。

### 2. 建立表单校验与错误提示层

处理状态：已完成第一阶段（2026-06-01）。

位置：

- `frontend/src/App.tsx:1554`
- `frontend/src/components/foods/FoodWorkspace.tsx:1615`
- `frontend/src/components/recipes/RecipeWorkspace.tsx:2500`
- `frontend/src/components/ingredients/IngredientWorkspace.tsx:2611`

问题：

- 大量校验直接 `window.alert`，不利于移动端体验，也不利于测试。
- 提交错误处理分散，无法统一展示后端错误、网络错误、权限错误。

建议：

- 新增轻量 `ToastProvider` 或 `NoticeProvider`，统一 `success/error/warning`。
- 表单校验函数返回结构化结果：`{ ok: false, field?: string, message: string }`。
- 优先把创建/编辑类表单迁移为字段内错误，而不是全局 alert。

落地：

- 新增 `frontend/src/hooks/useNotice.ts`，提供轻量 `success/warning/danger` notice 状态与自动关闭能力。
- `FoodWorkspace` 中菜单计划新增、更新、删除、完成相关 `window.alert` 已迁移为非阻塞 notice toast。
- `RecipeWorkspace` 中菜谱保存/删除、收藏、场景管理、菜单计划相关 `window.alert` 已迁移为现有 `recipeNotice` toast。
- `IngredientWorkspace` 中食材、库存、采购、消费和过期处理相关 `window.alert` 已迁移为非阻塞 notice toast。
- `App.tsx` 中食物、餐食、AI、家庭设置、首页菜单计划、首页补货和过期处理相关 `window.alert` 已迁移为非阻塞 notice toast。
- `App.tsx`、`FoodWorkspace`、`RecipeWorkspace`、`IngredientWorkspace` 内已无直接 `window.alert` 调用。

验收标准：

- 新代码不再新增 `window.alert`。（已完成第一阶段，主要业务组件无直接 `window.alert`）
- 核心表单有 payload 构造和校验单测。（部分完成，既有 model 单测覆盖部分 payload/model）
- 后端错误消息能以非阻塞方式展示。（已完成第一阶段，App 与三大工作台核心流程已迁移）

### 3. 统一日期、URL、localStorage 工具

处理状态：部分完成（2026-06-01）。

位置：

- `frontend/src/lib/ui.ts:28`
- `frontend/src/App.tsx:739`
- `frontend/src/components/foods/FoodWorkspace.tsx:222`
- `frontend/src/components/ingredients/IngredientWorkspace.tsx:687`
- `frontend/src/components/recipes/RecipeWorkspace.tsx:930`

问题：

- 日期偏移、今日 key、资源 URL 解析、localStorage 读写在多个文件重复。
- localStorage 没有统一 schema version 和异常隔离策略，未来结构调整容易留下旧缓存问题。

建议：

- 新增 `frontend/src/lib/date.ts`：`todayKey`、`addDateKeyDays`、`getWeekRange`、`formatDateKey`。
- 新增 `frontend/src/lib/assets.ts`：统一 `resolveAssetUrl`、placeholder 策略。
- 新增 `frontend/src/lib/storage.ts`：封装 `readJsonStorage`、`writeJsonStorage`、版本迁移和过期清理。

落地：

- 新增 `frontend/src/lib/date.ts`，集中 `todayKey`、日期 key 偏移、周范围和日期 key 差值计算。
- 新增 `frontend/src/lib/assets.ts`，集中后端媒体相对路径、绝对 URL、data URL 的解析，并支持首页 `/images/` 这类静态资源透传。
- 新增 `frontend/src/lib/storage.ts`，封装 JSON 与字符串缓存读写，并在 JSON 解析失败时清理坏缓存。
- `App.tsx`、`AiWorkspace`、`FoodWorkspace`、`RecipeWorkspace`、`IngredientWorkspace`、`ui-kit` 已迁移到统一 `resolveAssetUrl`。
- `workspaceModel` 的菜谱周范围计算、`App.tsx` 与 `IngredientWorkspace` 的日期偏移已迁移到 `lib/date.ts`，`ui.ts`、`helpers.ts` 的 `todayKey` 已统一复用。
- `IngredientWorkspace` 持久化工作台状态、`RecipeWorkspace` 做菜会话缓存、`App.tsx` 活跃 tab 和侧边栏折叠状态已迁移到 `readJsonStorage`、`writeJsonStorage`、`readStringStorage`、`writeStringStorage`、`removeStorage`。
- `frontend/src/lib/store.ts` 仍是旧本地 mock store，保留待后续判断是否继续使用或移除。

验收标准：

- 业务组件不直接调用 `localStorage.getItem/setItem`。（部分完成）
- 日期逻辑只从 `lib/date.ts` 导入。（部分完成）
- 旧缓存解析失败时有清理或默认值，不影响页面启动。（食材工作台已完成）

### 4. API client 按资源拆分，并补响应边界

处理状态：已完成第一阶段（2026-06-01）。

位置：

- `frontend/src/api/client.ts`
- `frontend/src/api/types.ts`

问题：

- `api` 对象集中维护所有资源，文件持续增长。
- 运行时完全信任后端响应，类型只在编译期生效。
- 错误类型只有 `Error(message)`，无法区分 401、403、422、5xx 和网络错误。

建议：

- 拆分为 `authApi`、`foodsApi`、`recipesApi`、`ingredientsApi`、`mediaApi`、`aiApi`。
- `request` 返回统一错误类型 `ApiError`，包含 `status`、`detail`、`path`。
- 对关键响应增加轻量 runtime guard，至少覆盖登录态、媒体上传、生图任务、AI conversation。
- 401 时由 request 层触发 token 清理事件，减少业务组件各自兜底。

落地：

- 新增 `ApiError` 与 `isApiError`，`request` 失败时抛出结构化错误。
- `ApiError` 继承 `Error`，保留现有 `reason instanceof Error ? reason.message : ...` 兼容性。
- JSON `detail` 支持字符串、FastAPI validation error 数组和其他可字符串化值。
- 401 响应会在 request 层清理 access token。
- 新增 `frontend/src/api/client.test.ts` 覆盖 422 detail 解析和 401 token 清理。
- 新增 `frontend/src/api/request.ts`，从巨型 `client.ts` 中抽离 request、token 读写、`ApiError`。
- 新增 `frontend/src/api/authApi.ts`、`familyApi.ts`、`ingredientsApi.ts`、`foodsApi.ts`、`recipesApi.ts`、`aiApi.ts`、`mediaApi.ts`，`client.ts` 继续聚合导出 `api`，保持现有调用方兼容。
- `frontend/src/api/client.ts` 已收敛为约 19 行聚合入口。

验收标准：

- 新增 API 不再修改单一巨型 `client.ts`。（已完成第一阶段）
- UI 层可以根据 `ApiError.status` 做权限、登录过期和字段错误提示。（API 边界已完成，UI 分支使用待迁移）

## 优先级 P2：性能与工程化

### 1. 引入工作台级 code splitting

处理状态：已完成第一阶段（2026-06-01）。

问题：

- 当前 JS 主包约 658KB，CSS 主包约 563KB。
- `App.tsx` 静态 import 所有工作台，登录后首屏会加载完整业务面。

建议：

- 对 `FoodWorkspace`、`RecipeWorkspace`、`IngredientWorkspace`、`AiWorkspace` 使用 `React.lazy`。
- tab 切换时加载对应工作台，首页保持轻量。
- 结合 query 延迟加载，避免首屏同时请求所有业务数据。

验收标准：

- 主 JS chunk 小于 350KB，工作台拆为独立 chunk。（已完成）
- 首屏只加载首页和全局壳必要代码。

落地：

- `App.tsx` 已使用 `React.lazy` 和 `Suspense` 懒加载 `AiWorkspace`、`FoodWorkspace`、`RecipeWorkspace`、`IngredientWorkspace`。
- 构建后主 JS 从约 `658 kB` 降到约 `330.74 kB`，AI、家庭设置和四个工作台已独立成 chunk。

### 2. 补端到端 smoke test

处理状态：部分完成（2026-06-01）。

问题：

- 当前单测覆盖了部分 model 和组件逻辑，但缺少真实浏览器层面的布局和关键流程验证。
- 全局 CSS 迁移、工作台拆分和 code splitting 都需要更强的回归保护。

建议：

- 使用 Playwright 增加 smoke：
  - 登录页可渲染。
  - 首页 boot 后关键卡片存在。
  - 食材/食物/菜谱 tab 能切换。
  - 移动端宽度下主要导航和列表不重叠。
- 如后端依赖较重，可先用 mock API 或静态 fixture。

落地：

- 新增 `frontend/scripts/smoke.mjs`，使用 Playwright 启动 Vite preview 的 `frontend/dist` 产物。
- smoke 在浏览器层 mock `/api/**`，不依赖本地后端服务。
- smoke 屏蔽 `fonts.googleapis.com` 与 `fonts.gstatic.com`，避免外部字体网络状态影响本地 smoke 结果。
- 已覆盖登录页渲染、认证后首页渲染、食物/食材/菜谱 tab 切换。
- 已覆盖 `390x844` 与 `768x1024` 视口，并检查页面不出现横向溢出。
- smoke 捕获到 `768x1024` 下首页周菜单网格横向溢出，已通过窄平板 CSS 规则修复。

验收标准：

- CSS 拆分或大组件拆分 PR 必须跑 smoke。（第一阶段命令已完成）
- 关键移动端视口至少覆盖 `390x844` 和 `768x1024`。（已完成）

### 3. 增加 lint、格式化和复杂度预算

处理状态：部分完成（2026-06-01）。

问题：

- `package.json` 当前只有 `dev`、`build`、`preview`、`test`，缺少 lint/format。
- 没有文件行数、组件复杂度、bundle size 的工程约束，复杂度会自然回流。

建议：

- 增加 ESLint，启用 React Hooks 规则和 import 顺序检查。
- 增加 Prettier 或保持现有格式但提供检查命令。
- 增加 `size-limit` 或自定义脚本检查 build 产物大小。
- 增加简单文件体量预算：超过 1,000 行的新/改 React 文件需要拆分说明。

落地：

- 新增 `frontend/scripts/check-file-budgets.mjs`，无外部依赖扫描 `src` 下 TS/TSX 文件。
- 新增 `npm --prefix frontend run check:size`。
- 新增 React 文件默认超过 `1000` 行会失败。
- 对现有超大文件设置逐步收敛预算：`App.tsx` 5000 行、`FoodWorkspace.tsx` 3400 行、`RecipeWorkspace.tsx` 2200 行、`IngredientWorkspace.tsx` 6200 行。

验收标准：

- CI 至少运行 `npm run build`、`npm run test`、`npm run lint`。（未完成，当前新增 `check:size` 可接入 CI）
- bundle size 超预算时 CI 给出明确失败信息。（文件体量预算已完成，bundle size 预算待补）

## 建议迁移路线

### 第 1 周：建立边界，不改业务行为

- 新增 `queryKeys` 和 cache invalidation 工具。
- 抽 `lib/date.ts`、`lib/assets.ts`、`lib/storage.ts`。
- 抽 `useImageComposer`，先接入一个低风险入口，例如食物场景封面。
- 给新增工具补单测。

### 第 2-3 周：拆 `App.tsx`

- 抽 `AppShell`、`HomeDashboard`、`FamilySettings`。
- 首页 view model 提到 `features/home/model`。
- 把首页相关 mutation 移到 `features/home/hooks`。
- 保持 UI 文案和 DOM 结构尽量不变，降低 CSS 回归。

### 第 4-6 周：拆业务工作台

- 优先拆 `FoodWorkspace`，因为体量相对小且已有较多纯函数可复用。
- 然后拆 `RecipeWorkspace` 的做菜、计划、购物补货、AI 草稿四块。
- 最后拆 `IngredientWorkspace`，先抽 overlay 和表单，再抽库存货架和购物清单。

### 第 7 周：样式和性能收尾

- 按 feature 拆 CSS。
- 引入 `React.lazy` 做工作台级 code splitting。
- 增加 Playwright smoke 和 bundle size 检查。

## 推荐目标结构

```text
frontend/src/
  app/
    AppShell.tsx
    queryClient.ts
    routes.ts
  api/
    request.ts
    queryKeys.ts
    cacheInvalidation.ts
    authApi.ts
    foodsApi.ts
    recipesApi.ts
    ingredientsApi.ts
    mediaApi.ts
    aiApi.ts
  features/
    home/
    family/
    meals/
    foods/
    recipes/
    ingredients/
    ai/
  components/
    ui/
  hooks/
    useImageComposer.ts
    useToast.ts
  lib/
    date.ts
    assets.ts
    storage.ts
    ui.ts
  styles/
    tokens.css
    base.css
    layout.css
    components.css
```

## 风险控制

- 每次只迁移一个业务切面，避免“大搬家”式 PR。
- 保留旧文件 re-export，减少 import 改动噪音。
- 先抽纯函数和 hook，再抽 JSX 组件。
- 每个拆分 PR 都跑 `npm --prefix frontend run test` 和 `npm --prefix frontend run build`。
- 样式拆分前后至少人工检查桌面和移动端首页、食物、菜谱、食材四个入口。

## 本次不建议立刻做的事

- 不建议立刻引入大型状态库。当前主要问题是职责边界和文件体量，React Query 加局部 hook 足够先解决。
- 不建议一次性改设计系统。`ui-kit.tsx` 可以逐步收敛，但大规模替换会和业务拆分互相干扰。
- 不建议先做细粒度性能微优化。当前最大的性能收益来自 code splitting、延迟查询和 CSS 拆分。
