# 前端代码规范

更新时间：2026-06-01

本文档定义 Culina 前端日常开发的默认约定，用于新增页面、扩展业务能力、维护组件和提交代码 review。重点不是“如何拆文件”，而是让新代码有一致的归属、可读的边界和稳定的验证方式。

## 基本原则

### 代码按职责归属

新增代码前先判断它属于哪类职责，再决定放在哪里。

- 页面结构和用户可见 UI 放在 `*Page.tsx`、`*View.tsx` 或具体组件里。
- 页面状态、弹窗状态、选中项、草稿和步骤流放在 `use*State.ts`。
- 创建、更新、删除、确认、AI 生成等提交流程放在 `use*Actions.ts` 或 `use*ActionState.ts`。
- 筛选、排序、统计、分组和页面展示数据整理放在 `use*Data.ts` 或 `*ViewModel.ts`。
- 请求 payload、默认值、类型转换、业务规则和可测试计算放在 `*Model.ts`。
- 静态选项、枚举映射、状态文案和业务配置放在 `*Options.ts`。
- 通用能力优先使用 `src/lib`、`src/hooks`、`src/api` 中已有封装。

### 业务逻辑优先可测试

能写成纯函数的逻辑不要绑在 React 组件里。表单默认值、payload 构造、状态推导、日期计算、筛选排序这类逻辑应优先放到 model/helper 文件，并补对应单测。

### 组件负责表达界面

组件应该主要描述界面结构和交互入口，不应该同时承担数据请求、缓存失效、复杂状态机和 payload 组装。组件内部可以保留与展示强绑定的轻量状态，例如展开、hover、临时输入展示。

## 目录与文件职责

### `App.tsx`

`App.tsx` 是应用组合层。

应负责：

- 组合应用壳、登录态、顶层导航和主要工作区。
- 连接全局查询、跨业务 mutation contract 和顶层 loading/error 状态。
- 把必要数据和动作传给业务工作台。

不应负责：

- 具体业务页面的大段 JSX。
- 业务表单的完整提交流程。
- 弹窗内部表单状态。
- 重复定义 query key 或缓存失效规则。

相关文件：

- `frontend/src/App.tsx`
- `frontend/src/app/AppShell.tsx`
- `frontend/src/app/useAppWorkspaceQueries.ts`
- `frontend/src/app/useAppMutations.ts`
- `frontend/src/app/useAppHomeViewModel.ts`

### `Workspace.tsx`

`Workspace` 是单个业务域的组合层，例如食材、菜谱、食物。

应负责：

- 组合本业务域的数据 hook、状态 hook、action hook 和页面 view。
- 管理当前业务域的主导航状态，例如当前 tab、当前详情、当前编辑对象。
- 向 view 提供清晰的 props，而不是让 view 自己拼业务数据。

不应负责：

- 直接写大量页面 JSX。
- 直接维护多个弹窗的完整内部状态。
- 直接写复杂派生数据和请求 payload。
- 在多个位置重复实现同一种业务动作。

相关文件：

- `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- `frontend/src/components/recipes/RecipeWorkspace.tsx`
- `frontend/src/components/foods/FoodWorkspace.tsx`

### `*Page.tsx` / `*View.tsx`

`Page` / `View` 表达页面级界面。

规范：

- 接收已经准备好的数据、状态和回调。
- 按用户任务组织页面结构，例如列表、详情、编辑、做菜、移动端首页。
- 不直接调用 API，不直接写 React Query mutation。
- 不在 view 内重复实现筛选、排序、统计等派生数据。

相关文件：

- `IngredientCreatePage.tsx`、`IngredientDetailPage.tsx`、`IngredientHubPage.tsx`
- `RecipeLibraryView.tsx`、`RecipeEditorView.tsx`、`RecipeDetailView.tsx`、`RecipeCookView.tsx`
- `FoodHubView.tsx`、`FoodMobileView.tsx`

### 移动端页面

移动端页面按独立用户体验设计，不作为桌面页面的简单条件分支。

规范：

- 主要业务域应有独立移动端 view/page。
- 移动端和桌面端共享数据 hook、action hook、model helper，不共享大段 JSX。
- 移动端 view 应接收整理好的 view model，避免在组件里重新计算业务数据。
- 移动端可以拥有不同的信息架构、排序和操作入口，但业务规则必须与桌面端一致。

相关文件：

- `frontend/src/features/home/HomeMobileDashboard.tsx`
- `frontend/src/components/foods/FoodMobileView.tsx`
- `frontend/src/components/ingredients/IngredientMobileView.tsx`
- `frontend/src/components/recipes/RecipeMobileLibraryView.tsx`
- `frontend/src/features/family/FamilyMobileView.tsx`
- `frontend/src/features/meals/MealLogMobileView.tsx`
- `frontend/src/components/ai/AiMobilePage.tsx`

### State Hooks

`use*State.ts` 用于管理局部 UI 状态机。

适合：

- tab、选中项、搜索输入、分页、展开状态。
- 弹窗、抽屉、overlay 的打开关闭。
- 表单草稿、批量选择、步骤流、计时状态。

不适合：

- API 请求。
- 缓存失效。
- 大量数据派生。
- 与 React 无关的纯业务计算。

相关文件：

- `useIngredientWorkspaceState.ts`
- `useIngredientOverlayState.ts`
- `useRecipeCookState.ts`
- `useRecipePlanState.ts`
- `useRecipeShoppingState.ts`
- `useFoodPlanState.ts`
- `useFoodSceneState.ts`

### Action Hooks

`use*Actions.ts` / `use*ActionState.ts` 用于管理业务动作流程。

适合：

- 创建、更新、删除、确认、批量处理。
- AI 生成、图片生成、提交后重置。
- notice 提示和 mutation 成功后的统一收尾。

不适合：

- 页面渲染。
- 复杂纯计算。
- 静态配置。

相关文件：

- `useIngredientActionState.ts`
- `useHomeDashboardActions.ts`

### Data Hooks 与 ViewModel

`use*Data.ts` / `*ViewModel.ts` 用于把原始数据整理为页面直接可用的数据。

适合：

- 筛选、排序、分组、统计。
- 空态判断和展示字段组装。
- 根据当前状态生成页面 view model。

不适合：

- mutation。
- 弹窗表单状态。
- 浏览器副作用。

相关文件：

- `useIngredientWorkspaceData.ts`
- `useRecipeWorkspaceData.ts`
- `useAppHomeViewModel.ts`

### Model Files

`*Model.ts` 承载不依赖 React 的纯业务逻辑。

适合：

- 默认表单值。
- 编辑表单与 API payload 的互转。
- 状态推导、完成度判断、业务校验。
- 可单测的日期、统计和筛选规则。

不适合：

- React component、state、effect。
- API 调用。
- `window`、`document`、`localStorage` 等副作用。

相关文件：

- `homeDashboardModel.ts`
- `RecipeWorkspaceModel.ts`
- `FoodWorkspaceModel.ts`
- `ingredientWorkspaceForms.ts`
- `workspaceModel.ts`

### Options Files

`*Options.ts` 承载静态业务配置。

适合：

- tab 配置、筛选选项、餐别选项、分类选项。
- 状态文案、卡片文案、枚举映射。
- 不依赖用户数据的业务配置。

不适合：

- 会触发副作用的函数。
- 实时派生的用户数据。

相关文件：

- `RecipeWorkspaceOptions.ts`
- `FoodWorkspaceOptions.ts`

### Dialog / Drawer / Overlay

弹窗、抽屉和 overlay 是独立交互单元。

规范：

- 接收 `open`、`value`、`onSubmit`、`onClose` 等清晰 props。
- 可以维护与展示强绑定的轻量局部状态。
- 不直接决定全局缓存失效。
- 不自行拉取业务全量数据。
- 不隐藏复杂 submit workflow。

相关文件：

- `RecipePlanDialogs.tsx`
- `RecipeShoppingDialog.tsx`
- `RecipeDraftDialog.tsx`
- `RecipeSceneManagerDialog.tsx`
- `FoodDetailDrawer.tsx`
- `FoodPlanDialog.tsx`
- `IngredientWorkspaceOverlays.tsx`

## 数据请求与缓存

React Query 的 key 和缓存失效必须集中维护。

规范：

- query key 统一放在 `frontend/src/api/queryKeys.ts`。
- mutation 成功后的缓存失效统一放在 `frontend/src/api/cacheInvalidation.ts`。
- 组件和业务 hook 不手写裸字符串 query key，例如 `['foods']`。
- 同一业务动作的失效范围只定义一次。
- 非首屏必要数据应延迟到对应工作区或激活状态后加载。

业务组件可以使用封装后的查询和 mutation contract，但不应重复维护缓存规则。

## 图片、资源、日期和存储

通用能力优先复用已有封装。

规范：

- 图片上传、参考图生成、文本生成使用 `frontend/src/hooks/useImageComposer.ts`。
- 资源 URL 解析使用 `frontend/src/lib/assets.ts`。
- 日期格式化、周范围和日期比较使用 `frontend/src/lib/date.ts`。
- localStorage 读写使用 `frontend/src/lib/storage.ts`。
- 新增浏览器存储 key 时使用明确业务前缀。

## 样式规范

样式应按基础层、业务层和移动端层组织。

规范：

- `frontend/src/styles.css` 作为样式聚合入口。
- 业务样式放入 `frontend/src/styles/*`。
- 新增样式使用业务域前缀，避免跨业务的泛选择器。
- 不新增影响全站的裸标签选择器，除非它属于 foundation 层。
- 移动端样式优先放在移动端样式层或对应业务样式文件，不在组件中堆叠大量 inline style。

相关文件：

- `00-foundation.css`
- `01-home-dashboard.css`
- `03-recipe-workspace.css`
- `04-ingredients-workspace.css`
- `06-food-workspace.css`
- `07-mobile.css`

## 文件体量

文件体量是健康检查，不是开发目标。

规范：

- 新增 React TSX 文件默认不超过 1000 行。
- 已登记的大文件不应继续无边界扩张。
- 如果文件变大，优先检查职责是否仍然清晰。
- 如果文件较长但职责单一、调用清楚、测试明确，可以保留。

检查命令：

- `npm --prefix frontend run check:size`

## 测试与验证

推荐命令：

- `npm --prefix frontend run check:size`
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`
- `npm --prefix frontend run smoke`

执行标准：

- 文档或注释变更不要求跑完整前端测试。
- model/helper 变更至少跑对应单测。
- 页面结构、工作区编排或状态流变更至少跑 `check:size`、`test`、`build`。
- 响应式、移动端或导航变更应补跑 `smoke`。

## Code Review Checklist

提交前检查：

- 新代码是否放在对应职责层，而不是顺手写进当前文件？
- 组件是否主要表达 UI，而不是同时处理请求、缓存、状态机和 payload？
- 移动端主要页面是否有独立 view/page？
- 派生数据和业务规则是否可测试？
- query key 和缓存失效是否仍然集中维护？
- 图片、日期、资源 URL、localStorage 是否复用已有工具？
- 新增样式是否有业务前缀，是否避免污染其他页面？
- 文件增长是否仍然保持职责清晰？
- 本次变更的验证命令是否匹配风险范围？
