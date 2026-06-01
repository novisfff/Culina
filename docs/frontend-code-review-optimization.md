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

- `npm --prefix frontend run test` 通过：`10 passed`，`69 passed`。
- `npm --prefix frontend run build` 通过。
- 构建产物：主 JS `index-B_QjmBPX.js` 约 `343.07 kB`，主 CSS `index-B_df6Uxp.css` 约 `563.34 kB`。
- 工作台已拆为懒加载 chunk：`AiWorkspace` 约 `18.23 kB`、`FoodWorkspace` 约 `72.44 kB`、`RecipeWorkspace` 约 `104.36 kB`、`IngredientWorkspace` 约 `118.90 kB`。
- Vite 主 chunk 超过 500KB 的警告已消除；CSS 仍是后续体积优化重点。

## 已完成优化记录

| 状态 | 优化项 | 完成内容 | 相关文件 | 验证 |
| --- | --- | --- | --- | --- |
| 已完成 | React Query key 集中管理 | 新增集中 query key，并替换 `App.tsx`、`AuthContext.tsx`、`AiWorkspace.tsx` 中的裸字符串 query key | `frontend/src/api/queryKeys.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | Mutation 缓存失效规则集中管理 | 新增按业务动作划分的缓存失效函数，并替换 `App.tsx`、`AiWorkspace.tsx` 中重复 `invalidateQueries` | `frontend/src/api/cacheInvalidation.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 工作台级 code splitting | 使用 `React.lazy` 和 `Suspense` 懒加载 AI、食物、菜谱、食材四个大工作台，主 JS 从约 658KB 降至约 343KB | `frontend/src/App.tsx` | `npm --prefix frontend run build` |
| 已完成 | 图片生成/上传 hook 第一阶段 | 新增 `useImageComposer`，统一参考图上传、直接上传、文本生成、参考图重试、失败保留参考图和重置状态 | `frontend/src/hooks/useImageComposer.ts` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 食物图片入口接入统一 hook | `FoodWorkspace` 食物资料卡图片入口不再直接调用底层 AI 生图函数 | `frontend/src/components/foods/FoodWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | 食材图片入口接入统一 hook | `IngredientWorkspace` 食材资料卡图片入口不再直接调用底层 AI 生图函数 | `frontend/src/components/ingredients/IngredientWorkspace.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 已完成 | `App.tsx` 图片入口接入统一 hook | 餐食照片、个人头像、家庭头像已接入 `useImageComposer`，并移除 `App.tsx` 内重复图片状态机函数 | `frontend/src/App.tsx` | `npm --prefix frontend run test`、`npm --prefix frontend run build` |
| 部分完成 | 拆薄 `App.tsx` | 已完成数据 key/失效规则抽离、工作台懒加载、图片状态机抽离；首页/家庭设置/餐食记录组件边界仍待拆分 | `frontend/src/App.tsx` | 当前测试和构建通过 |
| 待处理 | 菜谱图片入口统一化 | `RecipeWorkspace` 的菜谱图片、AI 草稿配图仍直接调用底层生图函数 | `frontend/src/components/recipes/RecipeWorkspace.tsx` | 待迁移后验证 |
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

- `frontend/src/styles.css`：约 34,048 行。
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`：约 6,023 行。
- `frontend/src/components/recipes/RecipeWorkspace.tsx`：约 5,287 行。
- `frontend/src/App.tsx`：约 5,275 行。
- `frontend/src/components/foods/FoodWorkspace.tsx`：约 3,223 行。
- `frontend/src/api/client.ts`：约 406 行，集中维护所有 API 方法。

这几个文件不是单纯“行数多”，而是职责跨度过大。例如 `App.tsx` 在 `frontend/src/App.tsx:799` 之后同时维护 30 多个本地状态、16 个 query 和 20 多个 mutation；食物、菜谱、食材工作台也各自维护大量页面状态和异步提交逻辑。

## 优先级 P0：近期应先处理

### 1. 拆薄 `App.tsx`，建立应用壳和首页边界

处理状态：部分完成（2026-06-01）。

已完成：

- React Query key 和 mutation 缓存失效规则已从 `App.tsx` 抽离。
- 四个大工作台已从 `App.tsx` 静态 import 改为 `React.lazy` 懒加载。
- 餐食照片、个人头像、家庭头像的图片状态机已从 `App.tsx` 抽到 `useImageComposer`。

待处理：

- 首页 dashboard、家庭设置弹窗、餐食记录表单仍在 `App.tsx` 内。
- `AppShell`、`HomeDashboard`、`FamilySettings`、`MealLogComposer` 仍待新建。

位置：

- `frontend/src/App.tsx:799`
- `frontend/src/App.tsx:933`
- `frontend/src/App.tsx:1027`
- `frontend/src/App.tsx:1320`

问题：

- `App.tsx` 同时负责侧边栏、登录后 boot loading、首页 dashboard、家庭资料弹窗、餐食记录、食物创建、AI 入口、跨工作台导航。
- 查询和 mutation 全部写在组件内，导致首页任何改动都可能触碰全局数据流。
- 大量本地 UI 状态互相交织，例如 `familyOverlayMode`、`homePlanDetailItemId`、`homeRestockForm`、`pendingRecipeCookId` 都在同一层。

建议：

- 新增 `frontend/src/app/AppShell.tsx`：只保留登录态判断、侧边栏、tab 路由和全局 loading。
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

待处理：

- 三大工作台内部仍是大组件文件，尚未拆为 `components`、`hooks`、`model`、`storage` 等目录。

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

处理状态：未开始。

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
- `RecipeWorkspace` 中菜谱图仍待后续迁移；食物/菜谱场景封面生成目前保留独立逻辑。

### 2. 建立表单校验与错误提示层

处理状态：未开始。

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

验收标准：

- 新代码不再新增 `window.alert`。
- 核心表单有 payload 构造和校验单测。
- 后端错误消息能以非阻塞方式展示。

### 3. 统一日期、URL、localStorage 工具

处理状态：未开始。

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

验收标准：

- 业务组件不直接调用 `localStorage.getItem/setItem`。
- 日期逻辑只从 `lib/date.ts` 导入。
- 旧缓存解析失败时有清理或默认值，不影响页面启动。

### 4. API client 按资源拆分，并补响应边界

处理状态：未开始。

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

验收标准：

- 新增 API 不再修改单一巨型 `client.ts`。
- UI 层可以根据 `ApiError.status` 做权限、登录过期和字段错误提示。

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
- 构建后主 JS 从约 `658 kB` 降到约 `343 kB`，四个工作台已独立成 chunk。

### 2. 补端到端 smoke test

处理状态：未开始。

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

验收标准：

- CSS 拆分或大组件拆分 PR 必须跑 smoke。
- 关键移动端视口至少覆盖 `390x844` 和 `768x1024`。

### 3. 增加 lint、格式化和复杂度预算

处理状态：未开始。

问题：

- `package.json` 当前只有 `dev`、`build`、`preview`、`test`，缺少 lint/format。
- 没有文件行数、组件复杂度、bundle size 的工程约束，复杂度会自然回流。

建议：

- 增加 ESLint，启用 React Hooks 规则和 import 顺序检查。
- 增加 Prettier 或保持现有格式但提供检查命令。
- 增加 `size-limit` 或自定义脚本检查 build 产物大小。
- 增加简单文件体量预算：超过 1,000 行的新/改 React 文件需要拆分说明。

验收标准：

- CI 至少运行 `npm run build`、`npm run test`、`npm run lint`。
- bundle size 超预算时 CI 给出明确失败信息。

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
