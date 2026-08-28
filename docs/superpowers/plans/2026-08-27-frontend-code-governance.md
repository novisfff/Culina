# Culina 前端代码治理总执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 以可重现的指标和小步可回滚提交，降低 Culina 前端复杂度、CSS 债务和首屏/路由资源体积，同时保持现有行为契约。

**Architecture:** Phase 0 先建立 health、manifest 和 fail-closed ratchet；Phase 1 固定 token、selector owner、cascade layer 与响应式边界；Phase 2/3 以 typed port 拆 App、query/mutation 和工作台；Phase 4/5 再拆 AI 二级入口、route-owned CSS 并逐 entry 启用硬预算。每个详细阶段文档都是可独立执行的 task runbook。

**Tech Stack:** React 18、TypeScript、Vite/Rollup、TanStack React Query、Vitest/Testing Library、Playwright、Node.js 20、GitHub Actions。

**Spec:** [2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)

## Global Constraints

- 基线为 b559246669dd3fd9ec463658ce2ed4504df2a1ba；工作区为 /Users/zyf/IdeaProjects/Culina/.worktrees/frontend-code-governance，原始 dirty main 不修改。
- 不改变 API、导航 union、React Query key/cache invalidation、家庭隔离、AI draft/approval/run/cancel、库存 OCC、localStorage key/version 或移动端行为。
- 每个 task 先写失败测试、运行最小失败命令、做最小实现、运行风险匹配的验证，然后独立提交；不 push、不创建 PR。
- 报告、单测、构建和浏览器视觉证据不可相互替代；未执行项必须在交付记录中明确。
- 所有新增 entry、exception、selector owner、baseline 更新和预算 phase 变更都必须有 owner、原因、测试、expiry 或可回滚提交。

---


关联文档：

- 体检：[2026-08-27-frontend-code-governance-assessment.md](../../plans/2026-08-27-frontend-code-governance-assessment.md)
- 设计规格：[2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)
- 详细 Phase 0：[2026-08-27-frontend-code-governance-phase-0-gates.md](2026-08-27-frontend-code-governance-phase-0-gates.md)
- 详细 Phase 1：[2026-08-27-frontend-code-governance-phase-1-css.md](2026-08-27-frontend-code-governance-phase-1-css.md)
- 详细 Phase 2/3：[2026-08-27-frontend-code-governance-phase-2-workspaces.md](2026-08-27-frontend-code-governance-phase-2-workspaces.md)
- 详细 Phase 4/5：[2026-08-27-frontend-code-governance-phase-4-bundles-rollout.md](2026-08-27-frontend-code-governance-phase-4-bundles-rollout.md)

## 0. 执行索引与检查点

| 顺序 | 任务卡 | 必须先有 | 独立出口 | 回滚边界 |
| --- | --- | --- | --- | --- |
| 1 | Phase 0: 0.0–0.2 | clean B0 checkout | health schema、B0 baseline、source/dynamic edge report | metrics/baseline 提交 |
| 2 | Phase 0: 0.3–0.5 | baseline 可读 | logical manifest、三态 checker、fail-closed CI artifact | manifest/checker/workflow 分开 |
| 3 | Phase 0: 0.6–0.7 | coverage reporter 可运行 | coverage topology、ratchet fixture、集成记录 | report 与文档提交 |
| 4 | Phase 1: 1.0–1.3 | Phase 0 ratchet | token/owner/layer contract | 每个 registry/layer 提交 |
| 5 | Phase 1: 1.4–1.6 | layer contract | 07-mobile 分批归属、debt ratchet、六视口证据 | 每个 CSS batch 提交 |
| 6 | Phase 2: 2.0–2.3 | query/cache contract | typed ports、query/mutation facade、Router/OverlayHost | 每个 domain/app 提交 |
| 7 | Phase 3: 3.1–3.5 | App ports | Ingredient/Food/Eat/Inventory/types 拆分 | 每个工作区提交 |
| 8 | Phase 4: 4.0–4.5 | AI state matrix | reducer、controllers、shell 和二级入口 | 每个 AI boundary 提交 |
| 9 | Phase 5: 5.1–5.4 | manifest 完整且 route CSS 可回滚 | route CSS、transfer report、hard target、发布演练 | CSS/Vite/budget/CI 分开 |

阶段切换规则：当前阶段的 Definition of Done、focused tests、typecheck/build、health/manifest diff 和必要的六视口证据全部完成后，才能勾选下一阶段；任何停止条件触发时保留失败 artifact，回滚最近一个阶段提交，不跨阶段“先做资源优化”。

## 1. 目标、基线与执行规则

### 目标

- 把复杂度、CSS/token 债务、依赖边界和 bundle 体积变成可重现的指标和 fail-closed ratchet。
- 先隔离变化面，再拆 `App.tsx`、query/mutation、Ingredient/Food/Eat/AI workspace，最后收紧 route CSS 和硬预算。
- 保留现有导航、React Query、缓存失效、AI contract、P0 路径和移动端独立体验。

### 固定基线

- Commit：`b559246669dd3fd9ec463658ce2ed4504df2a1ba`。
- Worktree：`/Users/zyf/IdeaProjects/Culina/.worktrees/frontend-code-governance`。
- Branch：`codex/frontend-code-governance`，跟踪 `origin/main`。
- B0 构建：主 JS 263.20 KiB gzip、主 CSS 189.83 KiB、AI 85.84 KiB、Ingredient 52.44 KiB、Food 25.21 KiB、FamilySettings 10.13 KiB；预算比较以整数 bytes 为准。
- B0 CSS：73,489 行、837 个 `!important`、214 个 `@media`、50 个 baseline-gated drift 命中。
- B0 测试：214 个文件、1,786 个测试；V8 行/分支/函数 71.11%/75.84%/66.58%。

### 不可破坏的边界

1. 不修改原始脏 `main` 工作区。
2. 不把大规模代码搬迁、视觉改版和 API contract 变化混在一个提交中。
3. 不删除测试来降低数字；先新增行为证据，再删除等价的 brittle Usage 测试。
4. 不把“报告通过”当作视觉通过；涉及 CSS、响应式、AI 状态或弹层必须检查固定视口。
5. 每个任务完成后执行 `git diff --check`，提交只包含任务声明的文件。

## 2. 阶段总览与依赖

```text
Phase 0 度量/manifest/ratchet
   ├─> Phase 1 CSS token/ownership/cascade
   ├─> Phase 2 App/query/mutation ports
   │      └─> Phase 3 Ingredient/Food/Eat workspace
   │              └─> Phase 4 AI state/rendering + route entries
   └──────────────────────────────────────────────> Phase 5 hard budgets/发布收紧
```

| 阶段 | 目的 | 主要交付 | 完成门槛 |
| --- | --- | --- | --- |
| 0（约 1 周） | 可信度量 | health report、manifest、ratchet gate、CI artifact | 新增债务和新增未登记 chunk 能失败；现状仍可通过 |
| 1（约 2–3 周） | CSS/token 治理 | canonical contract、ownership、layer、移动规则归属 | `!important≤650`、`@media≤180`、未分类变量为 0、固定视口无 P0 回归 |
| 2（约 2 周） | 应用组合解耦 | typed ports、域 query/mutation facade、App/overlay/controller 拆分 | App 只做组合；查询/失效语义测试通过 |
| 3（约 3–4 周） | 工作区降复杂度 | Ingredient/Food/Eat 状态、视图、action、model 分离 | 关键文件达到阶段目标；桌面/手机行为等价 |
| 4（约 2–3 周） | AI 边界与加载 | run reducer、message/approval/composer 拆分、Markdown 二级 chunk | conversation/run/approval/cancel contract 和 P0 通过 |
| 5（约 2 周） | 资源收口 | route-owned CSS、manual chunks、硬预算、发布/回滚 | main JS≤110、CSS≤100，所有 entry 纳入 manifest |

估时只用于排程，不是质量承诺；任何阶段若触发停止条件，应暂停而不是压缩验证。

## 3. 共用执行协议（每个工作包都遵守）

### 开始前

- 从当前阶段分支读取最新 `HEAD` 和 health baseline；确认没有未声明的工作区修改。
- 阅读目标模块、`docs/frontend-code-standards.md`、相关 `frontend-ui-style` reference、`queryKeys.ts`、`cacheInvalidation.ts` 和现有测试。
- 写出本工作包保留的用户路径、状态矩阵和预计新增/删除的依赖边。

### TDD 顺序

1. 先写会失败的 metric/contract/model/behavior 测试。
2. 运行最小定向命令，确认失败原因确实是待实现行为。
3. 做最小实现或移动，不顺手格式化无关文件。
4. 运行定向测试、typecheck、quality/build；涉及 UI 再跑固定视口。
5. 生成 health/manifest diff，确认没有通过移动代码隐藏债务。

### 提交格式

每个工作包一个可回滚提交，推荐：

```text
governance(metrics): add frontend health baseline and ratchet
governance(css): establish token and selector ownership
refactor(app): split workspace ports and domain query hooks
refactor(frontend): decompose ingredient and food workspaces
refactor(ai): isolate stream state and message rendering
perf(frontend): enforce route manifest budgets
```

不在本计划中自动 push、开 PR 或合并分支。

## 4. Phase 0：度量、manifest 与 ratchet

详细步骤见 [Phase 0](2026-08-27-frontend-code-governance-phase-0-gates.md)。主任务：

- [x] 建立包含 commit/toolchain 的 `frontend-health-baseline.json`，并以 TypeScript/CSS 扫描生成 JSON/Markdown 报告。
- [x] 为 Vite 输出所有 static/dynamic entry、CSS、imports、dynamicImports 和模块大小的 manifest。
- [x] 将 `check-bundle-budgets.mjs` 改为 report/ratchet/target 三态；ratchet 对新增债务和新增 entry fail-closed，target 逐域启用。
- [x] 在 CI 添加 required `Frontend Governance` 聚合检查，上传 health/manifest artifact；保留现有 `Frontend Build`、Vitest shard 和 P0 检查。
- [x] 覆盖率先作为 artifact，不立即增加全局阈值；为后续域 floor 记录 71.11/75.84/66.58 基线。

Phase 0 验收：对临时 fixture 增加一个 `!important`、超预算 chunk、未登记 dynamic import 时测试必须失败；在 B0 代码上 ratchet 仍通过。

## 5. Phase 1：CSS、token、cascade 与响应式

详细步骤见 [Phase 1](2026-08-27-frontend-code-governance-phase-1-css.md)。主任务：

- [x] 用 canonical token contract 校验 `00-foundation.css`，修正 `--brand-button-radius:24px` 和旧变量 alias。
- [x] 登记 runtime inline variables；将无 fallback、无 owner 的变量降为明确修复项，最终归零。
- [x] 建立 selector ownership、dead selector report 和例外 registry；先报告再删除，避免误删动态 class。
- [x] 用 `@layer` 固定 reset/token/ui/shell/domain/responsive/compatibility 顺序，把 `07-mobile.css` 的业务规则分配回 owner。
- [x] 合并同域重复 selector，按工作包删除 `!important`；canonical 设备层只保留 767、768–1023、1024+，其他断点写理由。
- [x] 把源码字符串 CSS Usage 测试逐步替换为真实行为/快照契约，但保留必要的迁移边界测试。

Phase 1 验收：legacy CSS 行数≤67,000、`!important≤650`、`@media≤180`、token drift≤25、无未分类 undefined variable；六个固定视口和 reduced-motion P0 路径通过。实际结果记录为 64,890 行、648 个 `!important`、180 个 `@media`、10 个 drift、0 个 undefined variable；六视口治理 E2E 与 P0 均通过。

## 6. Phase 2：App、query/mutation 与跨域 overlay

详细步骤见 [Phase 2/3](2026-08-27-frontend-code-governance-phase-2-workspaces.md) 的前半部分。主任务：

- [ ] 新增 WorkspacePort<Data, Actions> 及 Home/Eat/Ingredients/AI/Family 的明确 contract 测试。
- [ ] 将 21 个 app query 按 shell/home/eat/ingredients/family/AI 分组；保留 facade 兼容字段，禁止新增字段。
- [ ] 将 37 个 app mutation 按 ingredient/inventory/recipe/food/meal/AI 分组（含 shopping 和 food-plan）；缓存失效仍集中在 cacheInvalidation.ts。
- [ ] 提取 `AppWorkspaceRouter`、`AppOverlayHost`、`useAppInventoryOperations`、`useAppHomeController`，让 `App.tsx` 只负责组合。
- [ ] 将 Home、库存操作历史/盘点/购物入库和 Eat task adapter 的 payload/副作用从入口移到域 action/controller。
- [ ] 为首次 loading、后台 refresh、错误保留、冲突、重复提交和导航 focus 添加行为测试。

Phase 2 验收：`App.tsx` 不再新增业务 JSX/API；query/mutation facade 的域测试通过；应用启动和工作区切换的网络请求数量不增加。

## 7. Phase 3：Ingredient、Food 与 Eat workspace

详细步骤见 [Phase 2/3](2026-08-27-frontend-code-governance-phase-2-workspaces.md) 的后半部分。主任务：

- [ ] Ingredient：将搜索 query、catalog/inventory/shopping view model、food-stock action、detail/editor/overlay route 拆开；workspace 只做组合。
- [ ] Food：将 search/filter view model、plan/scene/editor/quick-record dialog state 和 desktop/mobile view 拆开；保持 recipe relation 与 plan completion contract。
- [ ] Eat：按 task kind 拆 `EatTaskBodies`，让 discover/plan/history/cook/meal-create 共享 typed action ports，不共享大段 JSX。
- [ ] 继续拆 `InventoryReconciliationDialog` 的步骤 reducer、字段校验和 View；保留 stale version/conflict/rollback 语义。
- [ ] 把 `api/types.ts` 按域拆为 type modules，保留兼容 barrel，确认 type-only import 不增加 runtime chunk。

Phase 3 验收：Ingredient/Food/Eat 关键文件达到设计规格阶段目标；每个桌面/手机路径有行为测试；没有因“只移动文件”留下双实现。

## 8. Phase 4：AI workspace 与状态/渲染边界

详细步骤见 [Phase 4/5](2026-08-27-frontend-code-governance-phase-4-bundles-rollout.md) 的前半部分。主任务：

- [ ] 把 conversation selection/local migration、run/stream reducer、query adapters、composer 和 overlay controllers 分离。
- [ ] `useAiConversationStreams` 只处理事件/状态转换；MessageBubble、Markdown、approval、human input 和 debug drawer 各自是 View/二级 entry。
- [ ] 保留 active conversation/run 隔离、404 inaccessible 清理、cancel/retry、approval settled refresh、未知 part 安全降级。
- [ ] 将 `react-markdown`/`remark-gfm` 及大型 approval editor 从 AI 首屏 shell 移到按需 chunk；加载态不能遮挡已显示消息。
- [ ] 对 AI run/approval/human-input/cancelled/partial-success 建立状态表和跨端 contract 测试。

Phase 4 验收：AI shell `entryCritical≤10.5 KiB` 的路径可解释，routeTotal 已进入 manifest；AI 现有测试和 P0 视口通过，覆盖率不靠降低阈值达标。

## 9. Phase 5：route-owned CSS、chunk 与硬预算

详细步骤见 [Phase 4/5](2026-08-27-frontend-code-governance-phase-4-bundles-rollout.md) 的后半部分。主任务：

- [ ] `main.tsx` 只同步加载 foundation/ui-kit/shell CSS；Home/Eat/Ingredients/AI/Family route 自己加载 domain CSS，旧 global import 仅保留回滚入口。
- [ ] 将 `07-mobile.css` 规则分配到 route CSS，保留固定 layer 顺序和 mobile/tablet/desktop 三层。
- [ ] 用 `manualChunks` 或显式 dynamic import 控制大型共享依赖；先看 manifest 的重复传输，再决定是否抽 vendor chunk。
- [ ] 让所有 entry（包括 FamilyModelSettings、ModelUsage、Markdown、InventoryAction、Home dialogs）进入 budget config；禁止 prefix-first 匹配。
- [ ] 当某 entry 连续两个版本达到目标并通过视口验证后，将其从 ratchet 切为 target hard failure；保留 routeTotal 防止转移超限。
- [ ] 完成发布前回归、artifact 保存、回滚构建和旧 alias 清理。

Phase 5 验收：主 JS≤110 KiB gzip、主 CSS≤100 KiB；AI/Ingredient/Family entry 达到目标；所有动态 entry 均有 manifest 记录，预算超限使 CI 非零退出。

## 10. 统一验证矩阵

### 每个代码工作包

```bash
npm --prefix frontend run test -- src/app src/components/ingredients src/components/foods src/features/eat src/features/inventory src/components/ai
npm --prefix frontend run typecheck
npm --prefix frontend run check:style-tokens
npm run frontend:quality
npm run frontend:build
git diff --check
```

按风险增补：

- CSS/token/响应式：`npm run frontend:e2e:p0`，视口 375×812、390×844、430×932、768×1024、1024×768、1440×900。
- AI message/draft/approval：对应 AI 测试 + `npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts`。
- route/chunk：构建后检查 `frontend-health-manifest.json`、gzip/routeTotal diff 和 lazy 首次加载；CI 统一从 `frontend/dist/.vite/frontend-health-manifest.json` 归档到 `.artifacts/frontend-health-manifest.json`，后续聚合只读 canonical artifact。
- 覆盖率基线：`npm run frontend:test:coverage`，只在阶段报告中比较域 floor。

### 最终门禁

```bash
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
npm run frontend:test:coverage
npm --prefix frontend audit --omit=dev --audit-level=high --json
git diff --check
```

最终回复/PR 必须分别列出实际运行的命令、固定视口和未执行项；静态扫描、单测、构建和视觉验收不能互相替代。

## 11. 风险登记与停止条件

| 风险 | 早期信号 | 处置 |
| --- | --- | --- |
| 只移动文件，依赖仍交叉 | manifest 主 chunk 不降、import graph 出现环 | 回到 port 设计，先拆 query/action，再移动 View |
| CSS 顺序变化导致隐性视觉回归 | 固定视口截图 diff、selector owner 变化 | 用 layer/compatibility 临时层，按域逐段迁移 |
| 预算通过但 routeTotal 上升 | entry 变小、传递依赖变大 | routeTotal hard check；禁止只看单文件 gzip |
| 全局覆盖率掩盖组合层空洞 | App/Ingredient 仍 0% | 按域行为测试和 floor，不提升全局数字 |
| AI 旧 run 串入新 conversation | run/approval contract 测试失败 | 保留 reducer 的 conversation key/run id 双重隔离，暂停 chunk 优化 |
| 例外 registry 无限增长 | `!important`/断点/alias 数量连续增加 | owner/expiry 审查；没有删除计划不得新增例外 |

任一固定视口 P0、家庭/会话隔离、AI approval 写入语义或 route manifest 完整性失败时，暂停后续阶段并回滚最近阶段提交。

## 12. 最终 Definition of Done

- [ ] `frontend-health-baseline.json`、每阶段报告和最终 manifest 可从干净 checkout 重现。
- [ ] ratchet/target 检查在 CI fail-closed，baseline 更新有独立审查记录。
- [ ] `App.tsx`、Ingredient/Food/AI/Eat 大文件职责和依赖边界符合规格，未留下兼容 facade 的无限增长点。
- [ ] CSS token、selector owner、media tier、`!important` 和 runtime variable 例外均有 owner/expiry。
- [ ] 所有动态 entry/chunk/CSS 被追踪，main/route hard budget 达标且不存在转移超限。
- [ ] 全量 Vitest、typecheck、build、style contract、P0 E2E、固定六视口和生产依赖审计均有新鲜证据。
- [ ] 只提交治理相关文档/代码，不包含 `.env`、密钥、家庭隐私、coverage/dist 或其他生成物。
