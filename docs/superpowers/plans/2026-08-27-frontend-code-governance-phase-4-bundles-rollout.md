# Phase 4/5：AI 边界、route 资源与硬预算发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 先隔离 AI conversation/run/stream/approval/composer 的状态与渲染边界，再将大型 renderer、route CSS 和动态入口纳入可追踪 manifest，最后按连续证据逐 entry 启用硬预算和可回滚发布。

**Architecture:** AI route 由 selection/data/controller/state reducer 和轻量 shell 组成；Message、Markdown、approval、human-input、debug 等重渲染面使用明确的二级入口，所有事件以 conversation key + run id 双重隔离。Vite manifest 记录逻辑入口及静态/动态传递依赖，route-owned CSS 只由对应 entry 加载；budget checker 同时比较 entryCritical 与去重 routeTotal，CI 以 fail-closed 聚合结果决定成功。

**Tech Stack:** React 18、TypeScript 5、TanStack React Query 5、SSE/AbortController、react-markdown 10、remark-gfm 4、Vite 5/Rollup、Vitest/Testing Library、Playwright、GitHub Actions。

**Spec:** [2026-08-27-frontend-code-governance-design.md](../specs/2026-08-27-frontend-code-governance-design.md)

## Global Constraints

- 不修改后端 AI runtime、API schema、草稿/审批协议、导航 union 或产品交互语义；AI workspace 只做前端边界重组。
- 任何 callback、stream event、approval result 都必须校验 conversation key 和 run id；旧 run 不能覆盖新选择。
- 404 inaccessible 必须清理本地 message/approval/cache scope 并安全切换；partial failure 保留已显示内容且可 retry。
- approval/human-input/cancel 不能显示假成功；settled 结果在服务端可见后才 invalidate 相关 query，不自动推进下一草稿。
- View 不持有 QueryClient、AbortController 或 API client；controller/action 层负责副作用，reducer/model 保持纯函数。
- 首屏 shell 不能静态引入 react-markdown、remark-gfm、大型 approval editor、debug drawer、voice 或图片生成非首屏逻辑。
- routeTotal 必须覆盖所有可达 dynamic import；不得以拆出未登记 chunk、prefix 匹配或重复 shared asset 规避预算。
- route CSS 迁移期间保留 VITE_LEGACY_GLOBAL_STYLES=1 回滚开关，但生产不得同时加载新旧两套样式。
- 固定视口为 375×812、390×844、430×932、768×1024、1024×768、1440×900，并在 reduced-motion 下验证键盘、safe-area、焦点和横向溢出。
- 每个任务先写失败测试，结束后运行 focused test/typecheck/build/manifest diff/git diff --check，并按任务独立提交。

---

## 4.0 预检和 AI 状态矩阵

**Files:**

- Create: frontend/src/components/ai/aiStateMatrix.ts
- Create: frontend/src/components/ai/aiStateMatrix.test.ts
- Modify: frontend/src/components/ai/aiWorkspaceTestFixtures.ts
- Modify: frontend/src/lib/aiWorkspaceContracts.test.ts

**Interfaces:**

- AiConversationKey = string
- AiRunViewState = idle | requesting | running | waiting-approval | waiting-human-input | cancelling | cancelled | failed | partial
- isEventForActiveRun(event, activeKey, activeRunId) => boolean
- deriveAiStatus(state) => { isRunning, isWaiting, isCancellable, canRetry }

- [ ] **Step 1: 写状态矩阵失败测试**

逐行锁定 pending migration、active run、approval pending/settled、human input、cancel、404、partial failure、unknown part；每行断言 visible status、composer enabled、cache action 和 retry action。

Run: npm --prefix frontend run test -- src/components/ai/aiStateMatrix.test.ts src/lib/aiWorkspaceContracts.test.ts

Expected: FAIL，因为新状态矩阵和 selector 尚不存在。

- [ ] **Step 2: 实现纯状态 selector**

只接受已规范化 state/event，不读 React 或 API；unknown status/part 返回安全的 neutral/partial 状态，不抛异常。

- [ ] **Step 3: 建立 fixtures 与旧行为 oracle**

在 aiWorkspaceTestFixtures.ts 为每种状态提供最小 conversation、run、message、approval、human-input fixture；保留旧 AiWorkspace 测试作为 oracle。

- [ ] **Step 4: 运行并提交**

~~~bash
npm --prefix frontend run test -- src/components/ai/aiStateMatrix.test.ts src/lib/aiWorkspaceContracts.test.ts
git diff --check
git add frontend/src/components/ai/aiStateMatrix.ts frontend/src/components/ai/aiStateMatrix.test.ts frontend/src/components/ai/aiWorkspaceTestFixtures.ts frontend/src/lib/aiWorkspaceContracts.test.ts
git commit -m "refactor(ai): define conversation and run state matrix"
~~~

Rollback: 回滚纯 selector/fixture 不影响当前 AI runtime。

## Task 4.1：隔离 conversation selection 和 local migration

**Files:**

- Create: frontend/src/components/ai/state/aiConversationSelection.ts
- Create: frontend/src/components/ai/state/aiConversationLocalStore.ts
- Create: frontend/src/components/ai/hooks/useAiConversationData.ts
- Create: frontend/src/components/ai/aiConversationSelection.test.ts
- Create: frontend/src/components/ai/aiConversationMigration.test.ts
- Modify: frontend/src/components/ai/useAiConversationLiveSync.ts
- Modify: frontend/src/components/ai/AiWorkspace.tsx

**Interfaces:**

- selectConversation(state, key) => SelectionState
- migratePendingConversation({ localKey, serverConversation, localMessages, composer, attachments }) => MigrationResult
- clearInaccessibleConversation({ key, cache, localStore }) => void
- AiConversationData = { history, active, messages, pendingApprovals, pendingHumanInputs, loading, fetching, error, retry }

- [ ] **Step 1: 写失败 selection/migration tests**

断言本地 pending conversation 成为 server conversation 时 message、composer、attachment scope 原子迁移且不重复；切换 conversation 时旧 local scope 不泄漏；404 清理 message/approval/cache/local scope；后台 refresh 不清空已显示消息。

Run: npm --prefix frontend run test -- src/components/ai/aiConversationSelection.test.ts src/components/ai/aiConversationMigration.test.ts src/components/ai/AiWorkspaceLiveSync.test.tsx

Expected: 新测试 FAIL；当前逻辑分散在 AiWorkspace/useAiConversationLiveSync。

- [ ] **Step 2: 提取纯 selection/store**

localStorage 读写继续经过 lib/storage；store key/version 不变。selection 只返回 key/id，不直接修改 React state。

- [ ] **Step 3: 接入 data hook**

useAiConversationData 组合 history/messages/approval/human-input query，区分 initial loading 与 background fetching，暴露 retry 而不暴露 QueryClient。

- [ ] **Step 4: 迁移 live sync**

useAiConversationLiveSync 只调用 clear/migrate selector 并派发 controller action；事件先校验 key/run id。

- [ ] **Step 5: 验证和提交**

~~~bash
npm --prefix frontend run test -- src/components/ai/aiConversationSelection.test.ts src/components/ai/aiConversationMigration.test.ts src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiWorkspaceAttachments.test.tsx
npm --prefix frontend run typecheck
npm run frontend:quality
git diff --check
git add frontend/src/components/ai/state frontend/src/components/ai/hooks/useAiConversationData.ts frontend/src/components/ai/aiConversationSelection.test.ts frontend/src/components/ai/aiConversationMigration.test.ts frontend/src/components/ai/useAiConversationLiveSync.ts frontend/src/components/ai/AiWorkspace.tsx
git commit -m "refactor(ai): isolate conversation selection and migration"
~~~

Rollback: 保留旧 selection adapter；回滚不删除 localStorage 或服务器会话。

## Task 4.2：把 SSE/run 事件变成纯 reducer

**Files:**

- Create: frontend/src/components/ai/state/aiStreamReducer.ts
- Create: frontend/src/components/ai/state/aiRunStateModel.ts
- Create: frontend/src/components/ai/aiStreamReducer.test.ts
- Create: frontend/src/components/ai/aiRunStateModel.test.ts
- Modify: frontend/src/components/ai/useAiConversationStreams.ts
- Modify: frontend/src/components/ai/aiWorkspaceHelpers.tsx

**Interfaces:**

~~~ts
type AiStreamAction =
  | { type: "run-started"; conversationKey: string; runId: string }
  | { type: "progress"; conversationKey: string; event: AiRunEvent }
  | { type: "message-delta"; conversationKey: string; messageId?: string; runId?: string; partId?: string; delta: string }
  | { type: "message-part"; conversationKey: string; messageId?: string; runId?: string; part: AiMessagePart }
  | { type: "response"; conversationKey: string; response: AiChatResponse }
  | { type: "stream-failed"; conversationKey: string; runId?: string; message: string }
  | { type: "run-cancelled"; conversationKey: string; runId: string };
~~~

- [ ] **Step 1: 写失败 reducer tests**

覆盖 delta 合并、part 顺序、旧 run 丢弃、unknown part 安全降级、stream failure 保留内容、cancelled 不显示错误、response 不重复 message、thinking/status 派生。

Run: npm --prefix frontend run test -- src/components/ai/aiStreamReducer.test.ts src/components/ai/aiRunStateModel.test.ts

Expected: FAIL，因为 reducer 尚不存在。

- [ ] **Step 2: 迁移纯 helper**

把 mergeMessagePart、mergeRemoteAndLocalMessage、appendDeltaToMessageParts、preferredRunActivityEvent 移入 state；保留原函数名的 re-export，避免一次性改所有测试。

- [ ] **Step 3: 实现事件适配器**

useAiConversationStreams 只负责 SSE/AbortController 到规范化 action 的转换；每个 callback 绑定 conversation key/run id，AbortError 映射为 cancelled。

- [ ] **Step 4: 对照旧 route**

用同一 fixtures 运行旧 helper 与 reducer，比较 message ids、part order、status 和 error；任何差异先停止，不进入 lazy chunk。

- [ ] **Step 5: 验证和提交**

~~~bash
npm --prefix frontend run test -- src/components/ai/aiStreamReducer.test.ts src/components/ai/aiRunStateModel.test.ts src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx
npm --prefix frontend run typecheck
git diff --check
git add frontend/src/components/ai/state frontend/src/components/ai/aiStreamReducer.test.ts frontend/src/components/ai/aiRunStateModel.test.ts frontend/src/components/ai/useAiConversationStreams.ts frontend/src/components/ai/aiWorkspaceHelpers.tsx
git commit -m "refactor(ai): move stream events into pure run reducer"
~~~

Rollback: controller 可继续适配旧 callback；不改服务端 SSE 协议。

## Task 4.3：拆 approval、human-input、cancel 和 composer controllers

**Files:**

- Create: frontend/src/components/ai/state/aiApprovalState.ts
- Create: frontend/src/components/ai/state/aiComposerState.ts
- Create: frontend/src/components/ai/hooks/useAiConversationActions.ts
- Create: frontend/src/components/ai/hooks/useAiComposerController.ts
- Create: frontend/src/components/ai/hooks/useAiRunCancellationController.ts
- Create: frontend/src/components/ai/aiApprovalState.test.ts
- Create: frontend/src/components/ai/aiComposerController.test.tsx
- Modify: frontend/src/components/ai/useAiRunCancellation.ts
- Modify: frontend/src/components/ai/useAiConversationComposerState.ts
- Modify: frontend/src/components/ai/useAiInventoryDraftAction.ts

**Interfaces:**

- AiConversationActions = { select, startNew, send, decideApproval, answerHumanInput, cancel, retry, delete }
- AiApprovalState = { pending: AiApprovalRequest[]; settled: Set<string>; busy: boolean; error: string | null }
- AiComposerState = { text, attachments, disabledReason, canSubmit, busy }
- cancellation transitions are requesting → cancelling → cancelled | failed; expected AbortError never becomes user error.

- [ ] **Step 1: 写失败 contract tests**

断言 approval busy 禁止重复提交/关闭；settled result 可见后才 refresh；human-input 前后 message 顺序不变；cancel/retry 只作用于同一 run；inventory draft action 失败保留草稿；composer/attachment scope 按 conversation key 隔离。

Run: npm --prefix frontend run test -- src/components/ai/aiApprovalState.test.ts src/components/ai/aiComposerController.test.tsx src/components/ai/AiInventoryIntakeApproval.test.tsx src/components/ai/AiInventoryOperationApproval.test.tsx

Expected: FAIL；新 state/controller 尚不存在。

- [ ] **Step 2: 实现 approval/composer reducer**

纯 state 只处理 action 和 selector；不在 View 内判断多个布尔值。settled approval id 去重并保留未知 approval 为 pending-safe。

- [ ] **Step 3: 实现 actions/cancellation controller**

controller 持有 QueryClient、AbortController 和 API 调用；成功/失败映射为稳定业务状态；只在服务端结果可读后调用对应 cacheInvalidation。

- [ ] **Step 4: 迁移现有 hooks**

保留 useAiConversationComposerState/useAiRunCancellation 的 export，内部委托新 controller；删除 AiWorkspace 内重复 busy/isRunning/waiting 判断。

- [ ] **Step 5: 验证和提交**

~~~bash
npm --prefix frontend run test -- src/components/ai src/lib/aiWorkspaceContracts.test.ts
npm --prefix frontend run typecheck
npm run frontend:quality
git diff --check
git add frontend/src/components/ai/state frontend/src/components/ai/hooks frontend/src/components/ai/useAiRunCancellation.ts frontend/src/components/ai/useAiConversationComposerState.ts frontend/src/components/ai/useAiInventoryDraftAction.ts
git commit -m "refactor(ai): isolate approval composer and cancellation controllers"
~~~

Rollback: 通过旧 hook adapter 恢复状态转换；不自动重试或推进草稿。

## Task 4.4：拆 AI shell、message views 和 overlay hosts

**Files:**

- Create: frontend/src/components/ai/AiWorkspaceRoute.tsx
- Create: frontend/src/components/ai/AiWorkspaceShell.tsx
- Create: frontend/src/components/ai/views/AiConversationHistoryView.tsx
- Create: frontend/src/components/ai/views/AiThreadView.tsx
- Create: frontend/src/components/ai/views/AiMessagePartRenderer.tsx
- Create: frontend/src/components/ai/views/AiComposerView.tsx
- Create: frontend/src/components/ai/views/AiApprovalHost.tsx
- Create: frontend/src/components/ai/views/AiHumanInputHost.tsx
- Create: frontend/src/components/ai/views/AiDebugHost.tsx
- Create: frontend/src/components/ai/AiWorkspaceBehavior.test.tsx
- Modify: frontend/src/components/ai/AiWorkspace.tsx

**Interfaces:**

- AiWorkspaceShell props only contain AiConversationState, AiConversationActions, loading/error and shell notice APIs.
- MessagePartRenderer receives one normalized AiMessagePart and an onAction port; it cannot import API, QueryClient or stream hook.
- AiWorkspace.tsx becomes compatibility entry that composes Route + Shell and exports old symbol for two stable versions.

- [ ] **Step 1: 写失败 behavior tests**

断言已有消息在 pending/refresh/error 时仍可读；history selection、composer submit、attachment error、approval/human-input/debug overlay、mobile/desktop view 的标题和主操作保持一致；未知 part 显示可理解降级。

Run: npm --prefix frontend run test -- src/components/ai/AiWorkspaceBehavior.test.tsx src/components/ai/AiWorkspace.test.tsx src/components/ai/AiConversationThread.test.tsx src/components/ai/AiMobilePage.test.tsx

Expected: FAIL，因为新 Route/View 尚不存在。

- [ ] **Step 2: 实现 shell 和 views**

共享 state/actions/model，桌面 history 与手机 chrome 可有不同 View；不复制 stream logic 或大段 JSX。

- [ ] **Step 3: 接入 overlay hosts**

approval、human-input、debug、quality diagnostics、delete conversation 由 host 接收 discriminated state；busy 时禁止 backdrop/Escape 关闭，局部错误不清空 thread。

- [ ] **Step 4: 迁移并删除重复逻辑**

AiWorkspace 只做 route port 组合；移除已迁出的 merge/status/approval/composer helper，保留兼容 re-export。

- [ ] **Step 5: 验证和提交**

~~~bash
npm --prefix frontend run test -- src/components/ai
npm --prefix frontend run typecheck
npm run frontend:quality
npm run frontend:build
npm run frontend:e2e:p0
git diff --check
git add frontend/src/components/ai
git commit -m "refactor(ai): split workspace shell message and overlay views"
~~~

Expected: AiWorkspace 趋势 ≤800 行；AI contract、P0 路径和六视口行为不变。

Rollback: Route 可切回旧 AiWorkspace export；不删除旧测试 fixture。

## Task 4.5：将 Markdown、approval 和诊断迁移为二级入口

**Files:**

- Create: frontend/src/components/ai/entries/AiMarkdownEntry.tsx
- Create: frontend/src/components/ai/entries/AiApprovalEntry.tsx
- Create: frontend/src/components/ai/entries/AiHumanInputEntry.tsx
- Create: frontend/src/components/ai/entries/AiDebugEntry.tsx
- Modify: frontend/src/components/ai/MarkdownMessage.tsx
- Modify: frontend/src/components/ai/AiApprovalFields.tsx
- Modify: frontend/src/components/ai/AiSpecializedApprovalEditors.tsx
- Modify: frontend/src/components/ai/AiQualityDiagnosticsModal.tsx
- Modify: frontend/src/components/ai/AiRunDebugDrawer.tsx
- Create: frontend/src/components/ai/aiSecondaryEntries.test.tsx
- Modify: frontend/src/components/ai/views/AiMessagePartRenderer.tsx

**Interfaces:**

- loadAiMarkdown() => Promise<{ default: React.ComponentType<MarkdownProps> }>
- loadAiApproval() => Promise<{ default: React.ComponentType<ApprovalProps> }>
- each entry exports one default View and one error fallback; loading fallback never covers composer or existing messages.

- [ ] **Step 1: 写失败 lazy loading tests**

断言纯 text/image/result-card 不加载 react-markdown；markdown part 才加载 Markdown entry；approval/editor/debug 加载失败显示局部重试且保留 thread；manifest 能识别每个 logical entry。

Run: npm --prefix frontend run test -- src/components/ai/aiSecondaryEntries.test.tsx

Expected: FAIL；当前 AiWorkspace 静态导入所有 renderer。

- [ ] **Step 2: 加入显式 dynamic import**

用 React.lazy 或 route loader 显式指向 entries；不要用字符串拼接 import 路径。加载边界只包对应 part/overlay。

- [ ] **Step 3: 移除首屏静态重依赖**

确认 AiWorkspaceRoute/AiWorkspaceShell 不再 import react-markdown、remark-gfm、大型 approval editor、debug drawer 或 voice/image-generation 非首屏模块。

- [ ] **Step 4: 运行 build/manifest 检查**

~~~bash
npm --prefix frontend run test -- src/components/ai/aiSecondaryEntries.test.tsx
npm --prefix frontend run typecheck
npm run frontend:build
node frontend/scripts/bundle-manifest.mjs --check frontend/dist/.vite/frontend-health-manifest.json
~~~

Expected: manifest 有 markdown、ai-approval、ai-human-input、ai-debug entry；AI entryCritical 只含 shell/orchestrator，routeTotal 列出可达二级资源且去重。

- [ ] **Step 5: Commit**

~~~bash
git diff --check
git add frontend/src/components/ai
git commit -m "perf(ai): add lazy markdown approval and diagnostics entries"
~~~

Rollback: 将 lazy loader 指回同步 View；保留 manifest entry 和失败 fallback。

## Task 5.1：将全局 CSS 迁移为 route-owned CSS

**Files:**

- Create: frontend/src/styles/foundation.css
- Create: frontend/src/styles/primitives.css
- Create: frontend/src/styles/shell.css
- Create: frontend/src/styles/routes/home.css
- Create: frontend/src/styles/routes/eat.css
- Create: frontend/src/styles/routes/ingredients.css
- Create: frontend/src/styles/routes/food.css
- Create: frontend/src/styles/routes/ai.css
- Create: frontend/src/styles/routes/family.css
- Create: frontend/src/styles/routes/model-usage.css
- Create: frontend/src/styles/routes/inventory-maintenance.css
- Modify: frontend/src/main.tsx
- Modify: frontend/src/styles.css
- Modify: frontend/src/styles/07-mobile.css
- Modify: frontend/vite.config.ts
- Create: frontend/src/styles/route-style-loader.ts
- Create: frontend/src/styles/route-style-loader.test.ts

**Interfaces:**

- main.tsx synchronously loads foundation, primitives and shell only.
- route-style-loader maps logical route id to one CSS import; it rejects loading both legacy and route-owned styles in production.
- compatibility switch: VITE_LEGACY_GLOBAL_STYLES=1 loads styles.css only for rollback.

- [ ] **Step 1: 写失败 route CSS tests**

断言 main 不导入全量 styles.css；Home/Eat/Ingredients/Food/AI/Family/Model Usage/Inventory maintenance route 各自加载 owner CSS；shared shell 不引用 route class；同一 CSS 不注入两次。

Run: npm --prefix frontend run test -- src/styles/route-style-loader.test.ts

Expected: FAIL，因为当前 main/static styles.css 加载 19 个文件。

- [ ] **Step 2: 拆 foundation/primitives/shell**

从 00-foundation.css、00-ui-kit.css 和 styles.css 聚合入口提取规则，保持 Phase 1 layer 顺序和 canonical token；不复制 token 或 ui-kit。

- [ ] **Step 3: 建立 route CSS imports**

每个 route entry 显式 import 对应 routes/*.css；07-mobile.css 中的业务规则先按 Phase 1 owner map 迁回，再删除旧 global import。

- [ ] **Step 4: 保留本地回滚开关**

生产默认 route-owned；VITE_LEGACY_GLOBAL_STYLES=1 仅用于回归比对和紧急回退，测试断言两种模式不会同时加载。

- [ ] **Step 5: 验证视口和资源**

~~~bash
npm --prefix frontend run test -- src/styles/route-style-loader.test.ts
npm --prefix frontend run check:style-tokens
npm --prefix frontend run typecheck
npm run frontend:build
npm run frontend:e2e:p0
~~~

Expected: main CSS initial 只含 foundation/primitives/shell；route CSS 切换后复用缓存，不出现双份 style tag；六视口无 P0 回归。

- [ ] **Step 6: Commit**

~~~bash
git diff --check
git add frontend/src/styles frontend/src/main.tsx frontend/src/styles.css frontend/src/styles/07-mobile.css frontend/src/styles/route-style-loader.ts frontend/src/styles/route-style-loader.test.ts frontend/vite.config.ts
git commit -m "perf(frontend): move route styles behind explicit entries"
~~~

Rollback: 设置 VITE_LEGACY_GLOBAL_STYLES=1 并回滚 route loader；不删除旧 CSS 直到两次发布验证完成。

## Task 5.2：完善 Vite manifest、预算配置和重复传输报告

**Files:**

- Modify: frontend/scripts/bundle-entrypoints.json
- Modify: frontend/scripts/bundle-budgets.json
- Modify: frontend/scripts/bundle-manifest.mjs
- Modify: frontend/scripts/bundle-manifest.test.mjs
- Modify: frontend/vite.config.ts
- Create: frontend/scripts/route-transfer-report.mjs
- Create: frontend/scripts/route-transfer-report.test.mjs

**Interfaces:**

- logical entries: main, home, eat, ingredients, food, ai, family-profile, family-model-settings, model-usage, model-usage-requests, markdown, ai-approval, ai-human-input, ai-debug, inventory-operation, home-dialogs.
- each entry has source, js, css, imports, dynamicImports, initial, entryCritical, routeTotal, shared.
- createRouteTransferReport(manifest) => { initial, routes, duplicateBytes, unregistered }.

- [ ] **Step 1: 写失败 manifest/report tests**

断言共享 vendor 只计一次、dynamic markdown/approval 出现在 routeTotal、未登记 dynamic import 非零、孤儿 chunk 非零、同一 logical id 多 facade 非零；代码从 entry 移到 dynamic chunk 时 routeTotal 增加。

Run: npm --prefix frontend run test -- scripts/bundle-manifest.test.mjs scripts/route-transfer-report.test.mjs

Expected: FAIL；当前 manifest 不包含完整 logical entry 和 transitive totals。

- [ ] **Step 2: 用 facadeModuleId 建立映射**

从 Rollup module graph 映射 source→logical id；禁止 prefix-first、find-first 或 hashed filename 推断。CSS asset reference 无法解析时加入 manifestErrors。

- [ ] **Step 3: 计算 raw/gzip/hash/来源**

每个资源记录 raw bytes、gzip bytes、sha256、sourceModules；gzip 选项固定 level 9、mtime 0；报告同时显示 bytes 和 KiB。

- [ ] **Step 4: 生成 route transfer report**

对静态/动态可达集合去重，列出 shared asset、重复字节、首屏请求数和未登记入口；输出按 entry/asset 排序。

- [ ] **Step 5: 运行和提交**

~~~bash
npm --prefix frontend run test -- scripts/bundle-manifest.test.mjs scripts/route-transfer-report.test.mjs
npm --prefix frontend run build:manifest
node frontend/scripts/route-transfer-report.mjs frontend/dist/.vite/frontend-health-manifest.json
git diff --check
git add frontend/scripts/bundle-entrypoints.json frontend/scripts/bundle-budgets.json frontend/scripts/bundle-manifest.mjs frontend/scripts/bundle-manifest.test.mjs frontend/scripts/route-transfer-report.mjs frontend/scripts/route-transfer-report.test.mjs frontend/vite.config.ts
git commit -m "governance(bundle): report transitive route transfer"
~~~

Rollback: 保留标准 Vite manifest；报告脚本失败不改变运行时加载。

## Task 5.3：按证据逐 entry 启用 ratchet 和 hard target

**Files:**

- Modify: frontend/scripts/bundle-budgets.json
- Modify: frontend/scripts/check-bundle-budgets.mjs
- Create: frontend/scripts/budget-rollout-state.json
- Create: frontend/scripts/budget-rollout-state.test.mjs
- Modify: .github/workflows/quality-gates.yml
- Modify: frontend/scripts/check-frontend-governance.mjs

**Interfaces:**

- budget entry fields: criticalGzipBudget, routeTotalGzipBudget, cssBudget, phase, owner, evidence.
- rollout state: { entry, consecutiveTargetBuilds, viewportEvidence, manifestComplete, enabledMode }.
- canEnableTarget(state) => boolean requires two consecutive builds, six viewports, complete manifest and no open exception.

目标 bytes：

| Entry | entryCritical gzip | routeTotal gzip |
| --- | ---: | ---: |
| main JS | 112,640 | 由 manifest 记录 |
| main CSS | 102,400 | 由 manifest 记录 |
| ai | 10,752 | 56,320 |
| markdown | 32,768 | 32,768 |
| ingredients | 37,888 | 由 manifest 记录 |
| food | 26,624 | 由 manifest 记录 |
| family-profile | 7,168 | 由 manifest 记录 |
| family-model-settings | 20,480 | 由 manifest 记录 |

- [ ] **Step 1: 写 rollout 失败测试**

断言历史 gap 无增量时 ratchet 通过；513-byte 增量失败；未完成两次 build/六视口/manifest 的 entry 自动回落 ratchet；target 超限非零；warnings 不影响 report 但不能让 CI 误绿。

Run: npm --prefix frontend run test -- scripts/budget-rollout-state.test.mjs scripts/check-bundle-budgets.test.mjs

Expected: FAIL，当前 checker 只有 warning 和 prefix matching。

- [ ] **Step 2: 实现 entry 配置和 rollout state**

预算使用逻辑 id，不使用 prefix；每 entry 记录 owner、phase、evidence 路径和最近两次 build/viewport commit。target 只能逐 entry 开启。

- [ ] **Step 3: 修改 CI 聚合**

governance job 先运行 ratchet；读取 rollout state 后对满足条件的 entry 运行 target；任意 manifestErrors/violations exit 1。artifact 永远上传，aggregate job 对缺失/非 success 结果 exit 1。

- [ ] **Step 4: 运行三态和 B0 模拟**

~~~bash
node frontend/scripts/check-bundle-budgets.mjs --mode=report
node frontend/scripts/check-bundle-budgets.mjs --mode=ratchet --baseline frontend/scripts/frontend-health-baseline.json
node frontend/scripts/check-bundle-budgets.mjs --mode=target --config frontend/scripts/bundle-budgets.json
npm --prefix frontend run test -- scripts/budget-rollout-state.test.mjs scripts/check-bundle-budgets.test.mjs
~~~

Expected: B0 ratchet 通过；未满足证据的 entries 只显示 targetGap；target 超限输出 entry/metric/current/target/delta/source asset 并 exit 1。

- [ ] **Step 5: Commit**

~~~bash
git diff --check
git add frontend/scripts/bundle-budgets.json frontend/scripts/check-bundle-budgets.mjs frontend/scripts/budget-rollout-state.json frontend/scripts/budget-rollout-state.test.mjs frontend/scripts/check-bundle-budgets.test.mjs .github/workflows/quality-gates.yml frontend/scripts/check-frontend-governance.mjs
git commit -m "governance(bundle): enable evidence-based hard budgets"
~~~

Rollback: 单 entry 将 enabledMode 设为 ratchet；不允许全局关闭 governance job 或删除 manifest errors。

## Task 5.4：发布验证、人工证据和回滚演练

**Files:**

- Create: frontend/scripts/release-governance-check.mjs
- Create: frontend/scripts/release-governance-check.test.mjs
- Modify: .github/workflows/quality-gates.yml
- Modify: docs/plans/2026-08-27-frontend-code-governance-assessment.md
- Modify: docs/superpowers/plans/2026-08-27-frontend-code-governance.md

**Interfaces:**

- checkReleaseEvidence({ manifest, budgetResult, viewportReport, requestReport }) => { ok, missing, violations }
- release evidence contains build commit, Node/Vite versions, initial/routeTotal gzip/raw, request count, long-task sample, cache reuse, six viewport result and rollback command.

- [ ] **Step 1: 写失败 evidence tests**

缺任一 viewport、manifest entry、budget result、request count 或 rollback command 时非零；浏览器未运行不能被 Vitest/build 结果替代。

Run: npm --prefix frontend run test -- scripts/release-governance-check.test.mjs

Expected: FAIL，因为 release evidence checker 尚不存在。

- [ ] **Step 2: 运行真实构建和 manifest**

~~~bash
npm --prefix frontend run typecheck
npm --prefix frontend run build
node frontend/scripts/route-transfer-report.mjs frontend/dist/.vite/frontend-health-manifest.json
~~~

- [ ] **Step 3: 运行六视口和 AI 状态路径**

~~~bash
PLAYWRIGHT_REDUCED_MOTION=reduce npm run frontend:e2e:p0
npm --prefix frontend exec playwright test frontend/e2e --project=chromium --grep "@ai|@route|@overlay"
~~~

检查 Home → Eat → Ingredients → AI → Family 切换、AI stream/approval/human-input/cancel/retry/404、Markdown/approval lazy failure、mobile composer/keyboard/safe-area、desktop history/debug drawer、scrollWidth 和 44px hit area。

- [ ] **Step 4: 做回滚演练**

在 staging/本地分别设置 VITE_LEGACY_GLOBAL_STYLES=1、关闭一个 entry target、恢复上一 manifest，确认不删除 localStorage、AI draft、run、cook session 或服务端数据；记录恢复时间和命令。

- [ ] **Step 5: 更新报告并提交**

~~~bash
npm --prefix frontend run test -- scripts/release-governance-check.test.mjs
git diff --check
git add frontend/scripts/release-governance-check.mjs frontend/scripts/release-governance-check.test.mjs .github/workflows/quality-gates.yml docs/plans/2026-08-27-frontend-code-governance-assessment.md docs/superpowers/plans/2026-08-27-frontend-code-governance.md
git commit -m "governance(release): verify frontend rollout evidence"
~~~

Rollback: 逐 entry 将 target 降回 ratchet，必要时启用 VITE_LEGACY_GLOBAL_STYLES=1 并恢复上一份 manifest；不删除用户状态或服务端数据。

## Phase 4/5 Definition of Done

- [ ] AiWorkspace 只做 route/port 组合；selection、local migration、stream reducer、approval、human-input、cancel、composer、message View 和 debug host 职责可从依赖图解释。
- [ ] conversation key + run id 隔离、404 清理、partial failure、cancel/retry、approval settled refresh、未知 part 降级和失败保留均有 contract/behavior tests。
- [ ] AI shell entryCritical ≤10.5 KiB gzip、AI routeTotal ≤55 KiB、Markdown ≤32 KiB；Ingredient ≤37 KiB、Food ≤26 KiB、Family profile ≤7 KiB，均以 manifest 真实去重数据为准。
- [ ] main 只同步 foundation/primitives/shell CSS；route-owned CSS、compatibility 开关和双份加载检测可验证。
- [ ] 所有 logical entry（含 Family Model Settings、Model Usage、Markdown、AI approval/human-input/debug、Inventory operation、Home dialogs）进入 manifest 和 budget config。
- [ ] ratchet/target fail-closed；target 只对连续两次构建、六视口、manifest complete 且无开放 exception 的 entry 启用；routeTotal 不因转移代码而绕过。
- [ ] 发布证据包含实际命令、commit、工具链、六视口、请求数、资源 gzip/raw、cache reuse 和可执行回滚命令；未运行浏览器 smoke 明确标注。

停止条件：任一 AI contract、家庭/会话隔离、P0 视口、routeTotal、manifest 完整性或 rollback rehearsal 失败时，停止 rollout，逐 entry 回到 ratchet 或恢复 legacy CSS，不删除用户状态。
