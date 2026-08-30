# 前端代码治理体检（2026-08-27）

状态：基线体检及治理实施跟踪；基线数字仍基于 `origin/main`，下方实施记录来自独立 worktree `codex/frontend-code-governance-implementation`。

## 0. 治理实施跟踪（2026-08-28）

已落地并独立提交的阶段性边界包括：Phase 0 度量/manifest/ratchet/fail-closed gates；Phase 1 CSS layer、token、selector ownership、响应式迁移；Phase 2 App query/mutation ownership、router/overlay/controller ports；Phase 3 Ingredient/Food/Eat 与 Inventory reconciliation 的部分 view-model/step 边界；Phase 4 AI selection/migration、run/stream/approval/composer/cancellation 状态模型、workspace shell/overlay hosts、secondary entry 与 manifest 注册。

最新验证证据：

- `npm run frontend:quality`：typecheck、全量 Vitest、style token gate 通过。
- `npm run frontend:build`：生产构建成功，bundle manifest 未报告 orphan/unregistered/missing entry。
- `node frontend/scripts/bundle-manifest.mjs --check frontend/dist/.vite/frontend-health-manifest.json`：14 entries。
- `npm run frontend:e2e:p0`：52/52 通过，覆盖固定移动/平板/桌面路径。

尚未达到最终规格的项目：App/Ingredient/Food workspace 仍保留大块组合文件；AI controller 虽已拆出 selection、stream、approval、human-input、composer 等边界，但 `AiWorkspace.tsx` 仍需进一步收敛；route-owned CSS 尚未完成；bundle rollout state 已接入，但所有入口仍保持 ratchet，尚未具备两次 build/viewport 证据，因此 target hard-failure 尚未启用。因此本跟踪记录不把当前阶段标记为最终验收。

## 1. 范围与基线

- 代码基线：`b559246669dd3fd9ec463658ce2ed4504df2a1ba`（`fix: improve media loading and mobile notifications (#118)`）。
- 原始 `main` 工作区当时有未提交改动，且本地 `main` 落后远端一提交；因此本体检只在干净 worktree `/Users/zyf/IdeaProjects/Culina/.worktrees/frontend-code-governance` 的 `codex/frontend-code-governance` 分支执行，不读取或覆盖原工作区改动。
- 统计范围：`frontend/src` 的 TypeScript/TSX/CSS、Vite 生产构建产物、Vitest/Playwright 配置和质量脚本。
- 这是一份治理输入，不是对某个 PR 的回归审计；数字用于建立可复现的 ratchet baseline，不能把行数本身当成质量目标。

### 已执行的基线命令

```bash
npm install
npm run frontend:quality
npm run frontend:build
npm run frontend:test:coverage
npm --prefix frontend audit --omit=dev --audit-level=high --json
```

`frontend:quality` 和 `frontend:build` 均退出 0；`frontend:test:coverage` 也退出 0。完整命令、退出码和局限在文末列出。

## 2. 结论摘要

P1 的根因不是单个“超长文件”，而是四个相互放大的结构问题：

1. 应用入口仍是跨域编排器。`App.tsx` 同时持有导航、认证启动、首页动作、库存维护/操作历史、家庭设置、餐食结果和近百个跨工作区回调；`useAppWorkspaceQueries.ts` 集中 21 个 query，`useAppMutations.ts` 集中 37 个 mutation。这样任何域的变化都容易触发入口、类型和整条 props 链的联动。
2. 现有 lazy import 只切出了少数组件文件，没有切断静态依赖。`App.tsx` 仍静态引入 Home/Eat/Inventory 的大块 JSX、模型和对话框；所有 CSS 通过一个同步入口加载。因此“工作台已 lazy”没有等价转化为首屏传输隔离。
3. CSS 是 append-only 级联。19 个文件共 73,489 行（不含 `styles.css` 的 22 行），`07-mobile.css` 是全局末端覆盖层，`09-ai-workspace.css` 已达 10,253 行。token 检查只覆盖三种模式，既不能验证 canonical 值，也不能解释运行时 CSS 变量，导致现有 50 个漂移命中长期 report-only。
4. 预算脚本把 bundle 超限放进 `warnings`，只有缺失产物和图片问题进入 `violations`。当前主 JS/CSS、AI、家庭设置和食材工作台均超预算却仍通过；脚本还没有覆盖 `FamilyModelSettingsWorkspace`、Model Usage、Markdown 等实际动态 chunk。

因此执行顺序应先建立可信度量和 fail-closed ratchet，再进行 CSS/入口拆分，最后才把历史预算改成硬目标。直接把现有 110 KiB/100 KiB 数字改成硬失败会让所有正常 PR 立即变红，反而无法持续迁移。

## 3. 可复现基线

### 3.1 源码拓扑

| 范围 | 数量/行数 | 说明 |
| --- | ---: | --- |
| TS/TSX/CSS 源文件 | 565 个 / 231,782 行 | 334 个生产 TS/TSX、211 个测试 TS/TSX、20 个 CSS |
| `frontend/src/styles` | 19 个 / 73,489 行 | `styles.css` 聚合入口另有 22 行 |
| `components/ai` | 28,900 行 | 目前最大的业务目录 |
| `components/ingredients` | 18,709 行 | 食材工作台及其视图/模型 |
| `features/inventory` | 16,348 行 | 入库、盘点、操作历史等 |
| `components/recipes` | 14,434 行 | 做菜、编辑、购物和助手 |
| `components/foods` | 11,879 行 | 食物工作台及计划/场景 |

最大的生产文件如下。数字是当前文件总行数，作为定位信号而非机械拆分阈值：

| 文件 | 行数 | 结构信号 |
| --- | ---: | --- |
| `frontend/src/components/ingredients/IngredientWorkspace.tsx` | 3,639 | 39 个 import、3 个 query；同时组合搜索、库存、采购、详情、编辑和成品库存操作 |
| `frontend/src/components/foods/FoodWorkspace.tsx` | 2,493 | 57 个 import、1 个 query；同时组合筛选、计划、场景、菜谱编辑和快速记录 |
| `frontend/src/api/types.ts` | 2,575 | 纯类型集中在一个跨域 barrel，219 个生产文件引用它 |
| `frontend/src/features/eat/EatTaskBodies.tsx` | 1,957 | 组合 discover/plan/recipe/cook/meal/history 多种任务 |
| `frontend/src/App.tsx` | 1,914 | 51 个顶层 import；包含应用壳和多个领域 workflow |
| `frontend/src/features/inventory/InventoryReconciliationDialog.tsx` | 1,755 | 复杂多步骤表单与状态流集中在单文件 |
| `frontend/src/components/ai/AiWorkspace.tsx` | 1,740 | 消息合并、SSE、审批、人类输入、取消、composer、桌面/移动呈现同文件 |

`App.tsx` 的静态依赖闭包（排除八个已声明 lazy entry）仍有 176 个 TS/TSX 文件、约 52,172 行；这解释了为什么只增加 `lazy()` 并没有显著压低主 chunk。

### 3.2 CSS 复杂度与 token

| 指标 | 当前值 |
| --- | ---: |
| CSS 行数（`src/styles`） | 73,489 |
| `!important` | 837 |
| `@media` 声明 | 214 |
| selector block（启发式） | 10,316 |
| declaration（启发式） | 39,038 |
| 含 raw hex/RGB 的行 | 约 4,639 |
| `border-radius` 声明 | 1,824 |
| `box-shadow` 声明 | 879 |
| baseline-gated token 命中 | 50（13px 18、17px 3、黑色 rgba 29） |

最大的 CSS 文件：

| 文件 | 行数 | `!important` | `@media` |
| --- | ---: | ---: | ---: |
| `09-ai-workspace.css` | 10,253 | 152 | 29 |
| `07-mobile.css` | 9,621 | 145 | 14 |
| `04-ingredients-workspace.css` | 8,771 | 175 | 15 |
| `03-recipe-workspace.css` | 6,016 | 92 | 15 |
| `06-food-workspace.css` | 5,472 | 35 | 16 |
| `05-workspace-overlays.css` | 4,760 | 1 | 40 |

媒体查询有 73 份 `(max-width: 767px)`，另有多套 420/520/560/600/680/720/900/980/1050/1100/1180/1199/1280 等断点。项目规范只定义 767、768–1023、1024+ 三个设备层；其余断点必须有内容重排理由。

变量扫描发现 24 个“被引用但未在 CSS 定义”的名字。并非全部都是 bug：`--model-usage-share`、`--ai-debug-depth` 等是运行时 inline 变量，应进入 allow-list；但 `--tap-large`、`--text-muted`、`--text-main`、`--ingredient-line`、`--ingredient-soft-surface`、`--shadow-xs`、`--input-height-lg`、`--font-mono` 以及无 fallback 的 `--brand` 需要逐项修复或明确别名。另有已知 canonical 冲突：`00-foundation.css:43` 的 `--brand-button-radius: 24px`，而规范 canonical `--radius-sm` 是 14px。

`09-ai-workspace.css` 在约 4,546、5,316、8,261、9,580 等位置出现 specificity override、refresh、legacy/mobile override 段落；`07-mobile.css` 则承担全站最终覆盖。它们是级联增长的证据，不应继续通过提高权重解决局部问题。

### 3.3 生产构建与实际依赖边界

`npm run frontend:build`（Vite 5.4.21，640 modules transformed）产物如下。现有脚本输出虽标为 kB，实际按 1024 进制计算；本治理文档统一将人类可读值标为 KiB，预算和 ratchet 始终比较整数 bytes。

| 逻辑/当前文件 | raw | gzip | 当前脚本预算 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 主 JS `index-DwWZ_wgr.js` | 920.83 KiB | 263.20 KiB | 110 KiB | warning，退出 0 |
| 主 CSS `index-t1_sx1i4.css` | 1,316.10 KiB | 189.83 KiB | 100 KiB | warning，退出 0 |
| `AiWorkspace` | 300.62 KiB | 85.84 KiB | 10.5 KiB | warning，退出 0 |
| `IngredientWorkspace` | 209.82 KiB | 52.44 KiB | 37 KiB | warning，退出 0 |
| `FamilySettings` | 44.27 KiB | 10.13 KiB | 7 KiB | warning，退出 0 |
| `FoodWorkspace` | 80.46 KiB | 25.21 KiB | 26 KiB | 当前通过 |
| `MarkdownMessage` | 158.43 KiB | 48.08 KiB | 未跟踪 | 未纳入预算 |
| `FamilyModelSettingsWorkspace` | 94.05 KiB | 24.95 KiB | 未跟踪 | 未纳入预算 |
| `ModelUsageWorkspace` | 42.11 KiB | 11.64 KiB | 未跟踪 | 未纳入预算 |
| `ModelUsageRequestLogsPage` | 14.82 KiB | 5.26 KiB | 未跟踪 | 未纳入预算 |

`frontend/src/styles.css` 同步 `@import` 19 个 CSS 文件，所以所有路由共享 189.83 KiB gzip 主 CSS；JS lazy 边界只覆盖部分工作台，Home、Eat、Inventory 对话框和 `EatTaskBodies` 仍在静态入口闭包。

`check-bundle-budgets.mjs:84-88` 把超限推入 `warnings`，`102-108` 只对 `violations` 退出 1。它按哈希文件名前缀取第一个匹配文件，不能表达入口的传递依赖，也不能防止把代码挪到未跟踪 chunk。

### 3.4 测试与覆盖盲区

- 全量 Vitest：214 个测试文件、1,786 个测试通过；本次覆盖运行耗时 120.13 秒（`fileParallelism: false` 是现有约束）。
- V8 覆盖率：行/语句 71.11%，分支 75.84%，函数 66.58%。这只是报告基线，不建议立即设全局硬阈值。
- `App.tsx` 和 `IngredientWorkspace.tsx` 在当前覆盖报告中均为 0%；大量行为通过上层 mock 或静态 Usage 测试间接保护。`components/ai` 行覆盖率约 88.43%，但 AI workspace 的跨状态行为仍需要分层测试。
- 211 个测试文件中约 38 个读取源码字符串，约 33 个直接读取 CSS；它们在迁移期间有价值，但对文件名、`@import` 顺序和 class 字符串高度敏感，不能替代真实用户行为测试。
- 已有 Playwright 配置包含多个专用视口项目，但普通 P0 项目仍使用 1180×820/1440×960；治理计划固定补齐 375×812、390×844、430×932、768×1024、1024×768、1440×900 六个视口。

### 3.5 依赖审计

`npm install` 的完整开发依赖图报告 12 个漏洞（1 low、3 moderate、6 high、2 critical）；`npm --prefix frontend audit --omit=dev --audit-level=high --json` 的生产依赖图为 0。依赖升级不是本 P1 的首要拆分手段，后续只在 bundle/安全工作包中单独处理并保持 lockfile 可复现。

## 4. Findings（按治理优先级）

### P1-A：应用组合层和跨域副作用集中

**触发场景：** 修改任一工作台的 query、mutation、导航或弹层，然后运行类型检查或构建。

**证据与影响：** `App.tsx` 从 `app/`、Home/Eat/Inventory/Ingredients/Food/AI/Family 等目录导入 51 个模块，并在 1,260 行以后向 Home、Eat、Ingredient、AI、Family 传递大块内联回调和状态。`useAppWorkspaceQueries.ts` 直接声明 21 个 query，`useAppMutations.ts` 直接声明 37 个 mutation。库存历史、盘点、购物入库和首页计划动作还在入口里直接读取 API。结果是局部变更需要理解全局缓存失效、props 形状和 boot loading；回归面随域数量线性扩大。

**修复方向：** 先保留 query key/cache invalidation 契约，拆出按域的 query/mutation hooks 和 typed workspace ports；再把 Home、Inventory operation、Eat task 和全局 overlay controller 从 `App.tsx` 移走。不要用一个无类型的全局 Context 重新隐藏依赖。

### P1-B：lazy boundary 与首屏资源边界不一致

**触发场景：** 用户只打开首页或家庭页，或只切换到 AI/食材工作台。

**证据与影响：** `styles.css` 同步导入全部 19 个 CSS；`App.tsx` 虽然 lazy 了八个组件，但静态导入 HomeDashboard、EatWorkspace、EatTaskBodies、MealLogWorkspace、InventoryMaintenanceDialogs 等大型闭包。主 JS 263.20 KiB gzip、主 CSS 189.83 KiB gzip，且 `MarkdownMessage`、Family Model Settings、Model Usage 等 chunk 未受当前预算覆盖。首屏网络、缓存失效和浏览器解析成本持续拖慢迭代与真实加载。

**修复方向：** 以 Home/Eat/Ingredients/AI/Family 为逻辑 route entry，查询和呈现按入口加载；为 AI 消息/Markdown/审批、Eat task kind 和 Family model usage 建立二级边界。用 manifest 计算去重后的 initial/route-total 传输，不按哈希前缀猜文件。

### P1-C：CSS 级联、token 和响应式规则缺少所有权

**触发场景：** 新增一个工作台样式、修复手机布局，或试图删除旧 selector。

**证据与影响：** `07-mobile.css` 是全局最终覆盖层，多个业务文件尾部有 polish/refresh/legacy override；837 个 `!important`、214 个媒体查询和 1,824 个 raw radius 声明让“最后一条规则”成为隐式 API。现有检查只匹配 13px、17px 和黑色 rgba，总共 50 个命中，无法发现 `--brand-button-radius: 24px` 与 canonical 14px 的冲突，也无法区分 runtime inline 变量和真正未定义变量。任意局部修复都可能改变另一工作台的级联。

**修复方向：** 建立 token contract、selector ownership、设备层级和例外 registry；把移动规则随业务域归属并用 CSS layer 固定顺序；新 `!important`、非 canonical 断点和未登记 raw token 直接失败，历史债务按 ratchet 逐步下降。

### P1-D：bundle budget 是 report-only，且存在漏报路径

**触发场景：** 某 chunk 超预算，或工程师通过新增动态 import 重新分配代码。

**证据与影响：** `check-bundle-budgets.mjs:84-88` 只记录 warning，只有 `violations` 才在 102-108 退出 1。当前主 JS/CSS、AI、家庭设置、食材均超预算但 CI 仍绿；Family Model Settings、Model Usage、Markdown 等实际 chunk没有预算。预算通过与资源真实加载体验脱钩，团队无法知道“移动代码”是否只是把超限隐藏到另一个文件。

**修复方向：** 先以当前产物建立不增量 ratchet（不让现状变红），再按逻辑入口启用阶段目标；manifest 必须列出所有 entry、静态/动态 import、CSS 和模块大小，缺少登记入口或新增大 chunk 直接失败。

### P2-E：测试保护偏向实现文本，关键组合层缺少行为证据

**触发场景：** 拆文件、重排 CSS import、替换 workspace props 或迁移 query hook。

**证据与影响：** 约 38 个测试读取源码字符串，约 33 个直接读取 CSS；`App.tsx` 与 `IngredientWorkspace.tsx` 行覆盖率为 0%。这类测试能防止误删迁移边界，但不能证明首次 loading、后台 refresh、失败保留草稿、路由切换、移动端触控或跨会话 AI 状态仍正确。若先机械拆分，很容易得到“测试全绿但主路径退化”的假安全感。

**修复方向：** 先为每个新 port/hook 写纯函数和状态行为测试，再替换关键 Usage 测试为 Testing Library/Playwright 用户路径；覆盖率先报告，待域边界稳定后设按域 floor，不设单一全局百分比。

## 5. 根因关系图

```text
App.tsx
 ├─ 21 queries + 37 mutations ──> 巨大 props/副作用面
 ├─ 静态 Home/Eat/Inventory ────> 主 JS 闭包过大
 └─ 同步 styles.css(19 files) ──> 主 CSS 包含所有工作台

CSS append-only + 07-mobile final override
 ├─ !important / 非 canonical breakpoint 增长
 ├─ token drift 只能 report-only
 └─ 删除/拆分缺少 ownership ────> 视觉回归风险

预算 warning-only + 未登记 chunk
 └─────────────────────────────> 资源退化不会阻断交付

静态 Usage 测试 + 组合层覆盖空洞
 └─────────────────────────────> 重构行为证据不足
```

## 6. 与既有计划的关系

- `docs/plans/code-quality-healthcheck-2026-06-28.md` 已提出 App、AI stream、token drift 等方向；本计划把它们升级为可度量的入口/域边界和 ratchet，不重复列低风险清单。
- `docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md` 和 `2026-07-07-frontend-overlay-deduplication.md` 已建立 ui-kit、overlay 和迁移边界。本治理不再新造 `CustomSelect`、确认弹窗或第二套 overlay；重点是清理 ownership、依赖和 payload 责任。
- 现有 query key、cache invalidation、AI workspace contract 和导航联合类型是稳定契约，拆分必须保持其外部语义。

## 7. 不纳入本轮的事项

- 不在这份体检中直接重写生产代码、删除 CSS 或修改 API contract。
- 不用全局行覆盖率、单一文件行数或一次性“格式化全仓”作为成功定义。
- 不为了满足目录形式把所有既有 `components/<domain>` 一次性搬到 `features/`；只有在职责拆分已触及时按边界迁移。
- 不在没有 manifest 和回滚开关前直接把当前历史预算改为硬失败。

## 8. 下一步入口

具体目标架构、指标定义和阶段门槛见：

- [前端代码治理设计规格](../superpowers/specs/2026-08-27-frontend-code-governance-design.md)
- [前端代码治理总执行计划](../superpowers/plans/2026-08-27-frontend-code-governance.md)

详细工作包按以下顺序执行：Phase 0 度量/门禁 → Phase 1 CSS/token/cascade → Phase 2 App/query/mutation → Phase 3 Ingredient/Food/Eat 拆分 → Phase 4 AI 状态与渲染 → Phase 5 route-owned CSS、bundle 和发布回归。

## 9. 验证记录与限制

实际执行：

- `npm install`：成功；完整开发依赖图报告 12 个漏洞，未写入凭据或 lockfile 以外的依赖变更。
- `npm run frontend:quality`：成功；typecheck、214 个测试文件/1,786 个测试和样式 token report 均通过。
- `npm run frontend:build`：成功；Vite 构建和当前 warning-only bundle 检查通过，超限详见 3.3。
- `npm run frontend:test:coverage`：成功；V8 71.11% 行、75.84% 分支、66.58% 函数，生成的 `frontend/coverage` 仅为本地诊断产物，不纳入治理提交。
- `npm --prefix frontend audit --omit=dev --audit-level=high --json`：成功；生产依赖无 high/critical 漏洞。

未执行：

- 没有运行浏览器/P0 smoke 或人工截图，因为本次交付是只含文档的治理基线；后续涉及 CSS、路由、弹层或响应式的每个工作包必须使用 375×812、390×844、430×932、768×1024、1024×768、1440×900 验证矩阵。
- 基线体检当时没有修改原始脏 `main` 工作区，也尚未在治理分支实现拆分代码；后续落地状态见第 10 节。

## 10. Phase 0 门禁落地记录（2026-08-28）

Phase 0 在独立 worktree `/Users/zyf/IdeaProjects/Culina/.worktrees/frontend-code-governance-implementation`、分支 `codex/frontend-code-governance-implementation` 完成。分支从 `59ea22b7` 创建，但 ratchet 真相源仍固定为 B0 `b559246669dd3fd9ec463658ce2ed4504df2a1ba`，不跟随 `origin/main` 移动。

独立回滚提交：

- `65a21ead`：共享 metric fixture。
- `92cb0e4e`：frontend health reporter。
- `e4781286`：固定 B0 baseline。
- `6e67bcbf`：逻辑入口 manifest。
- `2ea53eb7`：report/ratchet/target 三态 bundle checker。
- `f5280778`：fail-closed Frontend Governance CI job 和 canonical artifact。
- `0e54c5df`：coverage topology 只报告 artifact。
- `dab575e9`：把 health B0 comparator 接入 CI 聚合器。

### 实际验证

以下命令均退出 0：

```bash
npm --prefix frontend run test -- scripts/frontend-health-metrics.test.mjs scripts/frontend-health-baseline.test.mjs scripts/bundle-manifest.test.mjs scripts/check-bundle-budgets.test.mjs scripts/check-frontend-governance.test.mjs scripts/coverage-topology-report.test.mjs
npm --prefix frontend run typecheck
npm --prefix frontend run health:report -- --format json --output "$PWD/.artifacts/frontend-health.json"
npm --prefix frontend run build:manifest
cp frontend/dist/.vite/frontend-health-manifest.json .artifacts/frontend-health-manifest.json
npm --prefix frontend run check:governance -- --mode=ratchet --health="$PWD/.artifacts/frontend-health.json" --manifest="$PWD/.artifacts/frontend-health-manifest.json" --coverage="$PWD/.artifacts/frontend-coverage-topology.json" --result="$PWD/.artifacts/frontend-governance-result.json"
node frontend/scripts/check-frontend-governance.mjs --fixtures frontend/scripts/fixtures/governance-ci
npm run frontend:test:coverage
npm --prefix frontend run coverage:report
git diff --check
```

focused 集成集为 6 个文件、33 个测试。构建转换 640 modules；canonical manifest 包含 14 个逻辑入口：`main`、`home`、`eat`、`ingredients`、`food`、`ai`、`family-profile`、`family-model-settings`、`model-usage`、`model-usage-requests`、`markdown`、`ai-approval`、`inventory-operation`、`home-dialogs`。ratchet 聚合结果为 health/manifest/bundle/coverage 全部 `success`，0 violation、0 manifest error；28 条历史超目标均保留为 `targetGap` warning。

注入验证覆盖新增 `!important`、513-byte bundle 增量、未登记 dynamic import 和缺失逻辑 entry，失败路径均被 fixture/子进程测试锁定为非零；B0 历史 gap 无增量仍退出 0。coverage 没有设置全局 hard floor；当前治理分支采样为 221 个测试文件、1,823 个测试，行/分支/函数为 71.16%/75.84%/66.66%，与固定 B0 的 214/1,786 和 71.11%/75.84%/66.58% 分开记录。topology artifact 仍明确列出 `App.tsx`、`IngredientWorkspace.tsx` 等 8 个低覆盖组合层文件。

新 CSS tokenizer 在 B0 上得到 10,247 个 selector block、38,905 个 declaration；与原体检的启发式 10,316/39,038 不同，因为新口径跳过 keyframe 内部规则。当前 `59ea22b7` 后代源码采样为 10,255/38,944；B0 baseline 没有因此改写。`!important=837`、`@media=214` 与 B0 一致。

本阶段没有修改用户可见 UI，未运行 Playwright/P0 smoke、人工截图或 375×812、390×844、430×932、768×1024、1024×768、1440×900 六视口；Phase 0 结论不替代后续 CSS/响应式阶段的视觉验收。`.artifacts`、`frontend/dist`、`frontend/coverage` 均只作本地验证并在提交前删除。

## 11. Phase 1 CSS 与响应式落地记录（2026-08-28）

Phase 1 在同一独立 worktree 按 shell-foundation、home-family、eat-meal、ingredient-food-inventory、ai-search、compat-retire 批次完成。`07-mobile.css` 的规则已迁移至 `compatibility-responsive.css`，并保留固定 layer 顺序 `reset > tokens > primitives > shell > domain > responsive > compatibility`；旧文件不再作为生产入口。

当前 CSS 治理指标：legacy CSS 64,890 行、`!important` 648、`@media` 180、token drift 10、duplicate selectors 62、undefined variables 0、business specificity candidates 1,368、attribute selector candidates 150、noncanonical media 61（均在 registry 中有 owner/expiry）。CSS gzip 为 191,911 bytes，较 B0 增加 477 bytes；manifest `routeTotal` gzip 为 742,454 bytes，较 B0 减少 721 bytes。

新增 `frontend/e2e/css-governance.spec.mjs` 覆盖临时 fixture 的横向溢出、43px 触控目标与 busy overlay Escape 失败路径，以及 Home、Ingredients、Food、Eat、AI、Family 六个真实路径。测试在 375×812、390×844、430×932、768×1024、1024×768、1440×900 六视口循环，并以 reduced motion 模式运行，6/6 通过；`frontend:e2e:p0` 52/52 通过。Phase 1 focused contract tests 23/23 通过，完整 Vitest 1,852/1,852、build、style-token 与 CSS ratchet 均通过。

本阶段未执行人工截图 diff；CSS 治理 E2E 提供了布局、交互目标和 overlay 语义的自动化证据。`.artifacts`、`frontend/dist`、`frontend/coverage` 仍仅为本地验证产物，不纳入提交。

## 12. Phase 2/3 增量落地记录（2026-08-28）

在同一治理 worktree 中继续完成了 domain type barrel 消费者迁移，并将 Eat task body 与库存盘点步骤从聚合文件真实迁出。相关提交保持按批次独立：

- `6503e070`：Meal 类型消费者迁移。
- `c797069c`、`43361746`：Model Usage、Search 类型消费者迁移。
- `d6cc2d6b`、`fd465ac3`、`9bc59724`：Family Model Settings、Family、App 部分消费者迁移。
- `fa4d975d`、`5fca7c8f`、`5e07244d`、`7e35a643`、`d23bcb51`、`7ce31a79`：Eat 的 Food、Plan、Recipe、Cook、Meal/Meal-create body 迁移及 entry wrapper 接线；`EatTaskBodies.tsx` 从约 1,956 行降至 361 行。
- `c8bec2f4`、`1d0951aa`：库存盘点 Summary、Review View 真实迁出；Dialog 壳降至 432 行。

本增量实际验证：

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run test -- src/features/meals
npm --prefix frontend run test -- src/features/model-usage src/features/search
npm --prefix frontend run test -- src/features/family
npm --prefix frontend run test -- src/app
npm --prefix frontend run test -- src/features/eat
npm --prefix frontend run test -- src/features/inventory/InventoryReconciliationDialog.test.tsx src/features/inventory/InventoryReconciliationDialogBehavior.test.tsx
git diff --check
```

上述定向测试均通过。随后运行全量 `npm run frontend:quality && npm run frontend:build`：249 个测试文件、1,902 个测试通过，style-token gate 通过，Vite 转换 685 modules，build 与 bundle checker 退出 0（历史 targetGap 仍为 warning）。之后重新运行 `npm run frontend:e2e:p0`，固定路径 52/52 通过。后续又将 Markdown 专属依赖显式拆为 `ai-markdown-vendor` chunk，并重新 build：686 modules、manifest 无 error，Markdown entryCritical gzip 降至约 0.88 KiB，但 AI routeTotal 仍超过目标。一次 route-owned CSS 实验因 P0 首帧/cascade 回归撤回，并在恢复全局样式、重建 dist 后以 52/52 P0 通过确认回滚有效。新增 bundle rollout state 校验与 checker 集成测试（18 个脚本测试通过）；当前所有入口仍为 ratchet，target 仅在连续 build/viewport 证据完整后启用。人工截图与 route-owned CSS 仍未完成，因此 Phase 3/4/5 的最终验收仍保持未完成状态。

## 13. Phase 3 workspace model 增量（2026-08-29）

继续在同一治理 worktree 完成两批真实职责收敛：

- `36557051`：Ingredient 目录/库存摘要、状态、展开说明和采购原因迁入 `workspaceModel.ts`，并以 model 契约测试锁定展示结果；`IngredientWorkspace.tsx` 删除重复实现。
- `69c3e70a`：Food 日期投影、食物类型归一化、推荐餐别、卡片主操作、采购资格和库存文案迁入 `FoodWorkspaceModel.ts`，保留 Workspace 的兼容导出。
- `eeb1678d`：Ingredient 库存存储概览卡、图标和插图迁入独立 View，Workspace 仅传递数据与回调。
- `69e338df`、`0bdd0c34`：AI 与 Food domain CSS 从全局聚合移到各自 lazy route stylesheet，保留 `domain` layer；build 后主 CSS gzip 从约 194.9 KiB 降至约 150.3 KiB，AI/Food route CSS 由独立 chunk 承载。
- `31f4186e`：将 Food 样式中误放置的跨域 mobile 默认隐藏规则迁移到 compatibility responsive layer；修复后完整 P0 重新通过 52/52。
- `14b2e023`：Model Usage domain CSS 迁移到 lazy route stylesheet；主 CSS gzip 进一步降至约 138.9 KiB，Model Usage 相关定向 P0 15/15 通过。
- `d6966d10`：Family Model Settings domain CSS 迁移到独立 lazy route stylesheet；family-model-settings 定向 Vitest 100/100 通过，build 继续保持 ratchet。

本批验证：全量 Vitest 256 个文件 / 1,919 个测试通过；Vite 696 modules、manifest 无 error，bundle 历史超目标继续以 ratchet warning 输出；P0 固定路径 52/52 通过。构建后仍有未收敛的历史预算 gap，route-owned CSS、App/Ingredient/Food 大文件最终目标、连续 viewport 发布证据和 target hard-failure 尚未完成，不能据此勾选 Phase 3/5 最终验收。

## 14. Phase 3/5 增量记录（2026-08-29）

- `25ef12e6`：新增 `AppGlobalOverlays`，将全局搜索和首页食材采购弹层从 `App.tsx` 的 JSX 组合中提取为 typed overlay host；完成 typecheck 与 `src/app` 定向测试。
- 当前继续将 Home dashboard 主样式由全局 `styles.css` 移至 `features/home/home-route.css`，由 Home route 自有入口加载；responsive 与 compatibility 样式仍保持全局，避免跨域默认可见性回归。

本批验证：Home 定向 Vitest 98/98 通过；CSS layer contract 4/4 通过；typecheck 通过；Vite build 704 modules、manifest 无 error、bundle checker 退出 0；主 CSS gzip 约 133.83 KiB，历史 targetGap 继续按 ratchet warning 输出；`git diff --check` 通过。最新完整 P0 启动后在登录恢复、multitab 和部分 768px 导航场景出现可见性/超时失败，未取得完整通过结果；该失败证据不能替代 P0 通过。App/Ingredient/Food 大文件和其余 route CSS 迁移仍未完成。

## 15. Workspace renderer 增量记录（2026-08-29）

- `fe245a5f`：将 Food 计划详情中的候选餐食确认状态、候选查询和完成目标投影迁入 `FoodPlanDetailWithCandidates`，Workspace 保留 route 组合与 action wiring。
- `b0e6b196`：将 Ingredient 库存摘要卡的状态投影、媒体和库存动作渲染迁入 `IngredientInventoryCard`，Workspace 仅提供数据和回调。

本批定向 typecheck 与 Food/Ingredient 使用契约测试通过；全量 `frontend:quality` 已完成 typecheck 并运行 Vitest，未发现新增编译错误。Food workspace 约 2316 行，Ingredient workspace 约 3175 行，仍高于规格目标，后续必须继续按完整组件边界拆分。

- `ea356d84`：将采购历史行的媒体、标签和操作渲染迁入 `ShoppingHistoryRow`，进一步缩小 Ingredient workspace 的 View 组合范围。
- `07264fb5`：将 Eat workspace domain CSS 移至 lazy Eat route stylesheet，并同步更新 layer contract；主 CSS gzip 降至约 133.21 KiB，Eat route 获得独立 CSS chunk（约 1.06 KiB gzip）。

Eat/Food 定向测试 74/74、typecheck、build 与 diff check 通过；bundle 历史目标仍为 ratchet warning，未启用 target。

- `2b9878ee`：将 Ingredient 目录卡的 Quick Detail Popover（portal 定位、库存状态和快捷操作）迁入独立 View，并更新使用契约测试覆盖跨文件职责边界。

Ingredient overlay 定向测试 28/28、typecheck 与 `git diff --check` 通过；Ingredient workspace 约降至 2959 行，仍高于规格目标，目录卡本体和 App 组合层还需继续拆分。

- `7f8e830b`：将 Ingredient 目录卡本体（状态摘要、库存动作、Popover 接线）迁入 `IngredientCatalogCard`，Workspace 仅保留列表编排；文件约降至 2749 行。

本批 Ingredient overlay/usage 测试 28/28、typecheck、build（710 modules）和 bundle ratchet-report 通过；历史 target gap 继续保留。

- `490610e0`：将 InventoryMaintenanceDialogs 改为 lazy overlay entry，并修正 manifest routeTotal 图遍历：route entry 不再穿过共享 main chunk 的 sibling dynamic imports。新增回归测试锁定“只计算自身动态后代”的语义；manifest 现包含 17 个入口，routeTotal 从全站聚合值收敛为按入口图计算（例如 AI 约 528.6 KiB、Eat 约 407.4 KiB），主入口仍保留全站初始路由图。

该批 App/Inventory 定向测试 123/123、bundle-manifest 8/8 通过；typecheck、build 与 manifest 检查通过。历史 ratchet target gap 继续保留，尚未启用 target hard-failure。

- `841c3869`：为 `ai-human-input` 与 `ai-debug` 补齐 bundle budget 和 rollout state，使 17 个 logical entry 在 entrypoints、budget、rollout 三份配置中完全对齐。

bundle-manifest、budget checker、rollout state 相关测试 21/21 通过；构建和 manifest 检查通过。新增 AI 入口当前仍处于 ratchet，未伪造 target 资格。

- `fccda6c6`：将 Eat shell 与 MealLog workspace 从 App 首屏静态闭包改为显式 lazy route；新增 `meal-log` logical entry、预算和 rollout state，并把 `eat` 标记为 dynamic entry。构建后主 JS gzip 从约 267.18 KiB 降至约 258.95 KiB，生成独立 Eat（约 2.01 KiB gzip）与 MealLog（约 8.38 KiB gzip）chunk。

该批 App/Eat/Meal 定向测试 46 文件、364 个测试通过；bundle/manifest/rollout 脚本 20 个测试通过；Vite build 706 modules，manifest 检查通过并包含 17 个 logical entry，0 orphan/unregistered dynamic entry。历史 routeTotal 与主包目标差距仍保持 ratchet warning，未启用 target。

- `9aefd2a9`：新增 `release-governance-check.mjs` 与 10 个 fail-closed 测试，校验 manifest/budget、六固定视口浏览器证据、请求数、cache reuse、long-task、构建 commit、Node/Vite 版本和回滚命令；新增 `check:release-governance` npm script。

缺失任一 viewport、请求数据或 rollback command 时检查非零；`browserRun=false` 即使 build/unit tests 为真也不能通过。CI 接线和真实发布证据仍待完成。

- `5b24f452`：将 release evidence 接入 `.github/workflows/quality-gates.yml` 的独立 `Frontend Release Evidence` job，执行 build/manifest、Chromium、六视口请求证据、route transfer、budget result 和 release checker，并以 `if: always()` 上传全部证据。

CI 任务默认在每次 PR/push 运行；证据缺失、manifest/budget 不一致或 browser journey 失败都会使该 job 非零，同时保留 artifact 供回滚审阅。逐 entry target 开启和 rollback rehearsal 仍未完成。

在最新提交上重新执行 `npm --prefix frontend run build`、route transfer、budget report 与 `check:release-governance`：build 退出 0，release checker `ok=true`、missing=0、violations=0；target gap 仍仅作为 report/ratchet warning。

- `35f7e0a8`：新增 `route-transfer-report.mjs` 与 4 个测试，从 health manifest 生成按入口的 initial/routeTotal/entryCritical raw/gzip、asset hash、shared/cache 复用报告；新增 `route-transfer-report` npm script。真实构建后已生成本地报告（仅作验证产物，不提交）。

该批 release/transfer 测试 14/14 通过，实际 route transfer report 生成退出 0；六视口浏览器报告、请求计数和回滚演练仍未完成。

随后在 frontend 工作目录重新运行 CSS governance Playwright：`npx playwright test e2e/css-governance.spec.mjs --project=phone-375x812 --project=tablet-1180x820 --project=desktop-1440x960 --workers=1`，6/6 通过；每个真实路径循环覆盖 375×812、390×844、430×932、768×1024、1024×768、1440×900，共 6 个固定视口。报告写入本地 `frontend/.artifacts/viewport-report.json`，不纳入提交。该证据覆盖布局、横向溢出、44px 目标、Home→Ingredients→Eat→AI→Family 路径和 overlay 语义，但尚不包含完整 P0、请求计数或回滚演练。

在提交 `355b09b3` 后重新构建 manifest，并运行 `@release-evidence` Playwright（desktop 项目，测试内部循环六固定视口）：1/1 通过；采集到 requestCount=276、uniqueRequestCount=24、cacheReuse=true、longTaskMs=0。随后以同一 manifest commit 运行 `check:release-governance`，结果 `ok=true`、missing=0、violations=0。该证据链仍只覆盖 CSS governance 路径，完整 P0/AI 状态矩阵和 rollback rehearsal 尚未完成。

- `67d4ba13`：新增 `rollback:bundle-entry` CLI 与单测，按 logical entry 将 `enabledMode` 安全回落到 `ratchet`，拒绝 `all` 全局 sentinel，并保留目标 entry evidence、其他 entry 和输入对象不变。

在当前 worktree 完成真实 rollback rehearsal：临时复制 rollout state 并将 `ai` 设为 `target`，执行逐 entry rollback 后确认 `sourceUnchanged=true`、`evidencePreserved=true`、`otherEntriesPreserved=true`；随后验证 `--entry=all` 非零拒绝。该演练没有写入正式 rollout state，也未触碰 localStorage、AI draft/run、cook session 或服务端数据。完整 Step 4 仍未勾选，因为仓库尚未实现 `VITE_LEGACY_GLOBAL_STYLES=1` 兼容开关，也未进行上一 manifest 恢复演练。

随后重新运行完整 P0：在 `frontend/` 工作目录执行 `npx playwright test --grep @p0`，52/52 通过（39.1s）。这更新了此前 lazy/CSS 提交后的失败记录；release evidence、完整 P0 与 rollback CLI 演练均有真实命令和结果，但 App/Ingredient/Food 大文件、target budget 启用和 legacy CSS 开关仍未完成。

补充运行 `npm --prefix frontend audit --omit=dev --audit-level=high`，production dependency audit 退出 0，报告 `found 0 vulnerabilities`。审计日志仅保留在本地 `.artifacts/frontend-production-audit-20260829.log`，未纳入提交。

随后在当前提交 `fd91ca9163a3b373f62a0b79cd475e3fb9035245` 上重新执行 `npm --prefix frontend run build`，并运行 `npx playwright test e2e/release-governance-evidence.spec.mjs --project=desktop-1440x960 --workers=1`，1/1 通过（11.8s）。使用当前 manifest、budget、六视口、请求/cache/long-task 和 rollback command 运行 `release-governance-check.mjs`，结果 `ok=true`、`missing=[]`、`violations=[]`。该结果仅证明发布证据链完整，不代表 target budget 已达标；所有入口仍保持 ratchet。

在后续 App 组合收敛批次中，提交 `500544f8` 修正 Inventory reconciliation ownership 静态契约，提交 `2bab0a86` 将 Home dashboard dialog props 迁入 `useAppHomeDashboardDialogProps`，提交 `e7333ac9` 将 toast、移动通知中心和 overlay visibility 组合迁入 `useAppOverlayComposition`。本批定向测试 131/131 通过（含 Home、Inventory、App overlay contract），typecheck 通过；随后全量 `npm run frontend:quality` 为 302 个测试文件 / 2022 项测试通过，`npm run frontend:build` 转换 805 modules、manifest 无错误，`npm run frontend:e2e:p0` 为 52/52 通过。App 当前约 1278 行，仍未达到 ≤850 的阶段目标；Ingredient/Food 及 bundle target rollout 仍保持未完成，不以 facade 或 warning 代替验收。

随后提交 `b8ccb693` 将 Eat task body adapter 按 data/pending/actions 三类 typed port 组装，并提交 `1512b735` 修正 Ingredient workspace 的 App overlay ownership 断言。定向 Eat 测试 40/40 通过；全量 `npm run frontend:quality` 随后为 304 个测试文件 / 2024 项测试通过，typecheck 和 style-token gate 通过。该批仍未改变 API、导航或业务行为。

提交 `8ee9519d` 进一步将 Eat task resolution 的 query settle 状态映射迁入 `useAppEatTaskResolutionArgs`，与 task body adapter 分离。定向 Eat/App 测试 20/20 通过，typecheck 和 `git diff --check` 通过；该边界只转换查询状态，不增加请求或改变导航。

提交 `90b4ef6d` 将 Ingredient workspace 的 shopping/create/priority 一次性导航副作用迁入 `useIngredientWorkspaceNavigationEffects`，统一 requestId 去重、overlay 打开和 priority DOM focus/scroll。Ingredient 主文件从约 1180 行降至约 1133 行；Ingredient/Inventory 定向测试 28 个文件 / 159 项通过，typecheck 和 `git diff --check` 通过。
