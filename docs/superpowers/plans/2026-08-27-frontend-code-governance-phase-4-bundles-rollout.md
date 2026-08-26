# Phase 4/5：AI 边界、route 资源与硬预算发布

状态：执行计划（Phase 4 先稳定 AI 状态和渲染边界，Phase 5 再切换 route-owned CSS 与硬预算）。

关联文档：

- 体检：[前端代码治理体检](../../plans/2026-08-27-frontend-code-governance-assessment.md)
- 设计规格：[前端代码治理设计规格](../specs/2026-08-27-frontend-code-governance-design.md)
- 总计划：[前端代码治理总执行计划](2026-08-27-frontend-code-governance.md)
- Phase 0：[度量、manifest 与 fail-closed ratchet](2026-08-27-frontend-code-governance-phase-0-gates.md)
- Phase 1：[CSS、token、cascade 与响应式治理](2026-08-27-frontend-code-governance-phase-1-css.md)
- Phase 2/3：[应用组合层与工作台拆分](2026-08-27-frontend-code-governance-phase-2-workspaces.md)
- AI 契约：[frontend/src/lib/aiWorkspaceContracts.ts](../../../frontend/src/lib/aiWorkspaceContracts.ts)

本阶段不修改后端 AI runtime、API schema、草稿/审批协议或产品交互语义。资源优化必须建立在状态边界稳定之后；entryCritical 变小不能以把完整路径藏进未登记 dynamic chunk 为代价。

## 1. B0、目标与资源定义

### 1.1 B0 信号

| 指标 | B0 |
| --- | ---: |
| AiWorkspace.tsx | 1,740 行 |
| AI entry gzip | 85.84 kB |
| MarkdownMessage chunk gzip | 48.08 kB（当前未纳入预算） |
| 主 JS / 主 CSS gzip | 263.20 / 189.83 kB |
| route CSS | styles.css 同步加载全部 19 个样式文件 |

### 1.2 目标

| 入口/指标 | Phase 0 ratchet | 迁移后 hard target |
| --- | ---: | ---: |
| main JS initial | 不增加（允许 512 bytes 压缩误差） | ≤110 kB gzip |
| main CSS initial | 不增加（允许 512 bytes 压缩误差） | ≤100 kB gzip |
| AI entryCritical（shell/orchestrator） | 不增加 | ≤10.5 kB gzip |
| AI routeTotal（完整可达依赖） | 报告、不增加 | ≤55 kB gzip |
| AI Markdown renderer | 报告 | ≤32 kB gzip，独立二级入口 |
| Ingredient entryCritical | 不增加 | ≤37 kB gzip |
| Food entryCritical | 不增加 | ≤26 kB gzip |
| Family profile entryCritical | 不增加 | ≤7 kB gzip |

entryCritical 是 route 自己的首个 chunk，不代表用户完成该任务所需的全部资源；routeTotal 是该 route 静态和动态传递依赖去重后的总量。两者必须同时记录，避免仅拆 dynamic import 就“通过”。

## 2. Phase 4A：AI 状态分层

### 2.1 当前耦合

AiWorkspace.tsx 同时持有：

- conversation 选择、pending conversation migration、local message store 和 composer/attachment scope；
- messages/status/quality/pending approval queries；
- SSE chat、approval、human-input stream 与 run event polling；
- message/part 合并、delta、thinking、cancel 和 404 inaccessible 清理；
- conversation delete/visibility、recommendation plan、inventory draft；
- desktop/mobile history、Markdown/message bubble、debug drawer、voice、attachments 和多个 overlay。

先拆状态和副作用，再拆 View；不得通过全局 Context 把这些依赖重新隐匿。

### 2.2 建议目录

~~~
frontend/src/components/ai/
  AiWorkspace.tsx                 # 兼容入口，最终只组装 route port
  AiWorkspaceRoute.tsx
  AiWorkspaceShell.tsx
  state/
    aiConversationSelection.ts
    aiConversationLocalStore.ts
    aiRunStateModel.ts
    aiStreamReducer.ts
    aiApprovalState.ts
    aiComposerState.ts
  hooks/
    useAiConversationData.ts
    useAiConversationStreamController.ts
    useAiConversationActions.ts
    useAiComposerController.ts
  views/
    AiConversationHistoryView.tsx
    AiThreadView.tsx
    AiMessagePartRenderer.tsx
    AiComposerView.tsx
    AiApprovalHost.tsx
    AiHumanInputHost.tsx
    AiDebugHost.tsx
  entries/
    AiMarkdownEntry.tsx
    AiApprovalEntry.tsx
    AiHumanInputEntry.tsx
~~~

现有 aiWorkspaceHelpers.tsx、useAiConversationStreams.ts、useAiConversationLiveSync.ts、useAiConversationComposerState.ts、useAiAttachmentState.ts 和 useAiRunCancellation.ts 是迁移来源。先保留旧 export，再把逻辑逐块移动。

### 2.3 Typed state port

~~~
export type AiConversationState = {
  activeKey: string | null;
  activeId: string | null;
  history: AiConversation[];
  messages: AiMessage[];
  pendingApprovals: AiApprovalRequest[];
  pendingHumanInputs: AiHumanInputRequest[];
  run: AiRunViewState;
};

export type AiConversationActions = {
  select: (key: string) => void;
  startNew: () => void;
  send: (input: ChatStreamPayload) => Promise<void>;
  decideApproval: (input: ApprovalStreamPayload) => Promise<void>;
  answerHumanInput: (input: HumanInputStreamPayload) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  retry: () => Promise<void>;
  delete: (conversationId: string) => Promise<void>;
};
~~~

View 只接收 state/actions 和加载状态；stream controller 内部才持有 AbortController、run/message target ref 和 QueryClient。任何 callback 都必须以 conversation key + run id 做双重隔离。

## 3. Phase 4B：stream/run reducer 与状态表

### 3.1 reducer 输入输出

aiStreamReducer 接受规范化的 event：

~~~
type AiStreamAction =
  | { type: 'run-started'; conversationKey: string; runId: string }
  | { type: 'progress'; conversationKey: string; event: AiRunEvent }
  | { type: 'message-delta'; conversationKey: string; messageId?: string; runId?: string; partId?: string; delta: string }
  | { type: 'message-part'; conversationKey: string; messageId?: string; runId?: string; part: AiMessagePart }
  | { type: 'response'; conversationKey: string; response: AiChatResponse }
  | { type: 'stream-failed'; conversationKey: string; runId?: string; message: string }
  | { type: 'run-cancelled'; conversationKey: string; runId: string };
~~~

reducer 必须是纯函数，输出不可变，未知 part/status 安全降级。把现有 mergeMessagePart、mergeRemoteAndLocalMessage、appendDeltaToMessageParts、preferredRunActivityEvent 等纯函数迁入 state/，并保留现有测试。

### 3.2 必须保持的状态语义

| 场景 | 不变量 | 测试证据 |
| --- | --- | --- |
| pending → server conversation | local message、composer、attachment scope 按 run id 原子迁移，不重复消息 | migration fixture |
| active run | 只更新相同 conversation key/run id，旧 run 不能覆盖新选择 | reducer + live sync |
| approval pending | composer 暂停，busy 时不能重复提交/关闭；settled part 到达后才恢复 | approval contract |
| human input | 输入前后消息顺序不变，后续输出追加到同一 run | human-input contract |
| cancel | requesting/cancelling/cancelled/failed 可区分；预期 abort 不显示错误 | cancellation state |
| 404 inaccessible | 清理 message/approval/cache/local scope，切换到安全 conversation，不重新 hydrate | live sync test |
| partial stream failure | 已显示内容保留，assistant 标记停止并可 retry；不伪造 completed | stream failure test |
| approval settled | 只在服务端结果可见后 invalidate 相关 query；不推进下一草稿 | approval refresh test |

isActiveConversationServerRunning、waiting keys、settled approval ids 和 thinking status 应由 model selector 派生，禁止在多个 View 里各自判断。

### 3.3 TDD 顺序

1. 先为 reducer、selection migration、run cancellation 和 approval state 写失败测试；
2. 把现有 stream callback 适配成 reducer action，保持 API 调用时序；
3. 用旧 AiWorkspace 与新 route 在同一 fixtures 下做消息/状态快照对照；
4. 再拆 MessagePartRenderer、approval/human-input host 和 composer View；
5. 最后删除 AiWorkspace 内已迁出的 helper 和重复 state。

定向命令：

~~~
npm --prefix frontend run test -- src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiWorkspace.test.tsx src/components/ai/AiWorkspaceLiveSync.test.tsx src/components/ai/AiWorkspaceAttachments.test.tsx
npm --prefix frontend run typecheck
~~~

推荐提交：

- refactor(ai): isolate conversation selection and local migration
- refactor(ai): move stream events into pure run reducer
- refactor(ai): split approval human-input and cancellation controllers
- refactor(ai): split AI thread composer and message views

## 4. Phase 4C：AI 二级渲染入口

### 4.1 Shell 与二级入口

AI 首屏 shell 只包含：

- conversation history 的最小框架；
- 已存在消息的轻量 text/image/result-card renderer；
- composer 的输入、附件状态和 loading；
- pending 状态占位，不阻塞已显示消息。

以下内容必须按需加载，并在 manifest 中单独登记：

- MarkdownMessage 及 react-markdown/remark-gfm；
- 大型 approval field/editor、specialized inventory operation editor；
- quality diagnostics modal 和 debug trace drawer；
- voice input 与图片生成相关的非首屏逻辑（若可由用户动作触发）。

二级入口加载失败要显示局部错误和重试，不清空已显示消息；加载中不能覆盖 composer 或把已有 thread 变成全屏 blank。

### 4.2 AI bundle 验证

- 构建后确认 AI entryCritical 只含 shell/orchestrator；
- routeTotal 列出 Markdown、approval、debug 等可达分支并去重；
- 对比 react-markdown 只在需要渲染 markdown 时加载；
- 记录首屏网络 waterfall、首次交互时间和 gzip/raw，不能只看文件名。

## 5. Phase 5A：route-owned CSS

### 5.1 同步/异步 CSS 边界

main.tsx 迁移后只同步加载：

- foundation/reset/token；
- ui-kit primitives；
- AppShell、全局通知和 overlay frame shell。

Home、Eat、Ingredients、Food、AI、Family、Model Usage 和 Inventory maintenance 的 domain CSS 由各 route entry 负责加载；不能在 main.tsx 静态 import 整个 styles.css。迁移期保留 styles.css 兼容入口和 VITE_LEGACY_GLOBAL_STYLES=1 回滚开关，但生产不能同时加载新旧两套 CSS。

建议入口：

~~~
frontend/src/styles/
  foundation.css
  primitives.css
  shell.css
  routes/
    home.css
    eat.css
    ingredients.css
    food.css
    ai.css
    family.css
    model-usage.css
    inventory-maintenance.css
~~~

如果暂时不能拆物理文件，先用 layer + route import 明确所有权，再逐个删除旧 global import；不能把 07-mobile.css 改名后继续全局加载。

### 5.2 CSS 重复与缓存

- 同一基础 token/primitives 只进入 initial 一次；
- route CSS 只包含对应 owner 的 domain/responsive 规则；
- shared shell 不能引用任一 route 的 class 或业务图片；
- manifest 记录 CSS 传递依赖和重复字节；
- route 切换返回时复用已缓存 CSS，不再次注入双份 style tag。

## 6. Phase 5B：Vite manifest 与预算实现

### 6.1 逻辑 entry 清单

预算配置必须显式覆盖：

main、home、eat、ingredients、food、ai、family-profile、family-model-settings、model-usage、model-usage-requests、markdown、ai-approval、inventory-operation、home-dialogs。

Vite 使用 build.manifest 和 generateBundle 插件生成固定路径 frontend-health-manifest.json。entry 通过源模块或 Rollup chunk facadeModuleId 映射，禁止按 hashed filename prefix 找第一个文件。

每个 entry 至少记录：

~~~
{
  "source": "src/components/ai/AiWorkspaceRoute.tsx",
  "js": ["assets/ai-shell-<hash>.js"],
  "css": ["assets/ai-<hash>.css"],
  "imports": ["shell"],
  "dynamicImports": ["markdown", "ai-approval"],
  "entryCritical": { "rawBytes": 0, "gzipBytes": 0 },
  "routeTotal": { "rawBytes": 0, "gzipBytes": 0 },
  "shared": ["assets/vendor-react-<hash>.js"]
}
~~~

gzip 使用固定 Node gzipSync 选项，报告同时保留 bytes 和 KiB。routeTotal 对 static/dynamic 传递依赖去重；共享资产只计一次并列在 shared。缺失 entry、孤儿 chunk、未解析 CSS/import、重复逻辑 entry 和未登记 dynamic import 都是 manifest error。

### 6.2 manualChunks 决策

先用显式 dynamic import 和 manifest 测量，再决定 manualChunks：

1. 若共享依赖在三个以上 route 且 initial 会重复，抽稳定 vendor chunk；
2. 若 vendor chunk 让所有 route 都下载大型库，宁可保留 route-local chunk；
3. react、react-dom、React Query 等稳定基础依赖可共享；react-markdown、remark-gfm、图表和 debug 依赖保持按需；
4. 每次 manualChunks 变更必须比较 initial、每个 routeTotal、缓存命中边界和重复传输，不能只看单 chunk 变小。

## 7. Phase 5C：三态预算和 CI rollout

### 7.1 三阶段开关

1. report：本地输出完整报告，始终 0；warning/error 分开。
2. ratchet：所有 entry 立即启用；相对 B0 不得增加超过 512 bytes，新增或未登记入口非零退出。
3. target：某 route 连续两个版本达到目标、六视口通过且 owner 已迁移后启用 hard target；未迁移 route 自动回落 ratchet。

预算配置字段：

~~~
{
  "main": {
    "phase": 0,
    "criticalGzipBudget": 112640,
    "routeTotalGzipBudget": null,
    "owner": "frontend-platform"
  },
  "ai": {
    "phase": 5,
    "criticalGzipBudget": 10752,
    "routeTotalGzipBudget": 56320,
    "owner": "ai-ui"
  }
}
~~~

单位在配置中用 bytes；报告另显示 KiB。预算检查只依据 violations 和 manifestErrors 设置退出码，warnings 不能让 CI 误绿，也不能因历史 gap 让 B0 立即全红。

### 7.2 CI 顺序与 artifact

新增/保留的前端治理 job：

1. npm ci --prefix frontend；
2. health:report 输出 frontend-health.json；
3. 一次 Vite build 生成 dist manifest；
4. check:governance --mode=ratchet（已完成 route 再用 target）；
5. 上传 health、manifest、budget diff、Playwright screenshot/trace，使用 if: always()；
6. 聚合 job 读取所有子结果，任何非 success 都退出 1。

保留现有 Vitest shards、Frontend Build、style drift 和 frontend-e2e-p0 required checks。工作流契约测试必须断言 job 名、命令、artifact 路径和 if: always()，不能只人工阅读 YAML。

## 8. Phase 5D：发布验证、回滚与停止条件

### 8.1 固定视口和真实路径

AI、route CSS、overlay 或 chunk 相关提交至少跑：

- 375×812、390×844、430×932；
- 768×1024、1024×768；
- 1440×900。

在 reduced motion 下验证：

- Home → Eat → Ingredients → AI → Family 切换时 shell 不 blank、未激活域不提前请求；
- AI stream、approval、human-input、cancel、retry、inaccessible conversation；
- Markdown/approval 二级 chunk 加载失败恢复；
- mobile composer/keyboard/safe-area、desktop history/debug drawer；
- document scrollWidth 不超过视口，主操作 hit area ≥44×44。

资源报告同时记录首次导航的请求数、initial gzip、routeTotal、长任务和 chunk 缓存命中；浏览器 smoke 未运行时必须在交付记录中明确。

### 8.2 回滚策略

- Phase 4 每个状态边界一个提交；Phase 5 CSS、Vite、预算和 CI 分开提交；
- route CSS 迁移期用 VITE_LEGACY_GLOBAL_STYLES=1 回到旧聚合入口；
- bundle 回退超过 10%、任一 P0 视口横向溢出、AI contract/家庭隔离失败、manifest 不完整或 approval settled 语义变化时，停止 rollout 并回滚最近阶段提交；
- 回滚只恢复已验证的代码/资源版本，不删除 localStorage、AI 草稿、run、cook session 或服务端数据；
- hard target 只能逐 entry 关闭，不允许全局关闭治理 job；临时放宽需独立治理提交和 expiry。

### 8.3 推荐提交边界

- perf(ai): add lazy markdown and approval entries
- perf(frontend): move route CSS behind explicit entries
- perf(frontend): add Vite health manifest and transitive totals
- governance(bundle): enforce ratchet mode in CI
- governance(bundle): enable hard budgets for migrated routes
- chore(frontend): remove legacy global styles and prefix matching

每个提交必附 focused test、typecheck、build、manifest diff；涉及 UI 还要附六视口结果。

## 9. 完成定义

- [ ] AI workspace 的 selection、stream/run、message merge、approval、human-input、composer、cancel 和 debug 职责可从依赖图解释；AiWorkspace 只做组合。
- [ ] AI contract 状态矩阵和现有 P0 行为测试全部通过，未知 part/失败/404 不丢数据。
- [ ] main 同步 CSS 不再包含所有 route；route-owned CSS 和 compatibility 回滚入口均可验证。
- [ ] 所有逻辑 entry（含 Markdown、Family Model Settings、Model Usage、Inventory operation）都有 manifest 和预算。
- [ ] main JS/CSS、AI/Ingredient/Food/Family 目标达到后才切 target hard failure；routeTotal 没有转移超限。
- [ ] CI 对 manifest error、未登记 entry 和 target 超限非零退出，并保留失败 artifact。
- [ ] 六个固定视口、reduced motion、键盘/触控和 P0 路径均有新鲜证据；未执行项明确列出。
