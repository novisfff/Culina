# AI Run 取消状态机统一设计

日期：2026-07-23

状态：已确认，待书面复核
范围：主 AI 工作台、做菜页小灶文字/语音 SSE、做菜页实时语音 turn

## 1. 背景与目标

当前 AI 对话停止逻辑由“后端取消 run”和“前端中断 SSE”两部分组成，但不同路径的行为并不一致：

- 主工作台在取消 API 失败后仍会中断前端流并显示“已取消”，可能形成假成功；
- `waiting_input` 在 UI 上可以停止，但后端取消状态集合没有完整支持；
- 审批提交会锁 approval/draft，取消未使用一致的锁顺序和锁后复核，存在业务写入与取消状态互相覆盖的风险；
- 普通聊天、审批恢复和 human-input 恢复对 `AbortError` 的处理不同；
- message/event 将取消记录为 `failed`，导致刷新后显示为执行失败；
- 小灶文字流仅 abort 浏览器请求，实时语音 turn 仅取消异步 task，没有形成可审计的后端取消事实；
- 前端预生成 `client_run_id`，停止请求可能早于 run 建档请求到达后端，现有接口会返回 404。

本设计建立一套跨入口统一的取消命令、run 状态机、锁顺序和前端确认语义，满足以下目标：

1. 停止请求可以在 run 建档前持久化，并在 run 创建时生效；
2. 取消接口幂等，快速连点不会创建重复事件或重复副作用；
3. 审批正式业务写入一旦开始，不承诺回滚；写入完成后停止 continuation 和后续 AI 回复；
4. `waiting_approval` 与 `waiting_input` 能完整取消其 message part、上下文和恢复入口；
5. 前端只在后端确认 run 已为 `cancelled` 后显示“已取消”；
6. message、part、event、approval 和 draft 使用独立取消语义，不冒充失败或拒绝；
7. 主工作台、小灶文字/语音 SSE 和实时语音 turn 使用相同的后端取消服务。

## 2. 已确认的产品语义

### 2.1 审批正式写入期间的终止

当审批事务已经开始正式业务写入时，停止请求采用以下语义：

- 不尝试撤销或回滚已经开始的正式业务写入；
- 取消命令可以独立持久化，不需要等待审批事务完成；
- 审批事务完成业务写入后复核取消命令；
- 如果停止请求在业务写入期间到达，不启动 continuation 或模型后续回复；
- 前端保留真实 operation result，不将业务写入误报为已撤销；
- 如果停止请求在整个 run 已自然完成后才到达，则返回结构化 409，不改写终态。

### 2.2 小灶范围

本次统一包含：

- 小灶文字 SSE；
- 小灶带语音播报的 SSE；
- 小灶实时语音 WebSocket 的单个 turn；
- hangup 对当前活跃 turn 的收尾。

小灶继续使用 `persist_history=false`，不进入主 AI 历史与公开协作机制。临时 conversation、message 和 checkpoint 仍可在终态后清理，但 `AIAgentRun` 与取消审计记录保留。

## 3. 持久化模型

### 3.1 `ai_run_cancel_requests`

新增 `AIRunCancelRequest` 模型与 Alembic migration。建议字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 取消命令 ID |
| `family_id` | 当前家庭，所有查询和写入必须过滤 |
| `run_id` | 前端预生成或后端已有的 run ID；不设置 run 外键，以允许 run 创建前持久化 |
| `requested_by` | 发起停止的当前用户 |
| `status` | `requested`、`applied`、`rejected` |
| `outcome_code` | 机器可读结果，例如 `cancel_requested`、`cancelled`、`already_cancelled`、`run_not_cancellable` |
| `requested_at` | 首次请求时间 |
| `resolved_at` | 应用或拒绝时间 |

约束与索引：

- `family_id + run_id` 唯一；
- 为 `run_id`、`family_id + status` 建索引；
- 重放不得修改首次 `requested_by/requested_at`；
- 取消原因不写入 `AIAgentRun.error/error_code`。

`run_id` 不使用外键是刻意的：取消命令必须能够先于 run 存在。run 创建流程只读取当前家庭、当前 run ID 下状态为 `requested/applied` 的命令。

### 3.2 run 状态

活动状态统一为：

```text
pending
running
waiting_approval
waiting_input
cancelling
```

终态为：

```text
completed
failed
fallback
cancelled
```

`cancelling` 必须加入：

- 同一会话活动 run 判断；
- 前端 busy 判断；
- live overlay 未完成状态；
- worker 取消检查；
- serializer、TypeScript contract 和测试。

## 4. 状态迁移

### 4.1 run 尚未创建

```text
cancel request = requested
  -> 后续 run prepare 检查取消命令
  -> 创建必要的最小 run 记录并落为 cancelled
  -> 不调用 provider，不进入 LangGraph
  -> cancel request = applied
```

该路径确保快速停止不会依赖短暂重试窗口。创建流程必须保证同一个 `client_run_id` 的幂等重放仍返回同一个取消结果。

### 4.2 活跃执行

```text
pending/running
  -> cancelling
  -> worker 在安全检查点观察取消命令
  -> cancelled
```

在 `cancelling` 期间，会话保持 busy，不能开始第二个 run。worker 的 finalizer 必须锁定 run 并复核；发现 `cancelling/cancelled` 或有效取消命令时，只能收尾为 `cancelled`，不能写回 `completed/failed`。

### 4.3 等待审批或输入

```text
waiting_approval/waiting_input
  -> cancelling
  -> 同一事务完成关联对象与 checkpoint 收尾
  -> cancelled
```

等待态没有正在进行的 provider 调用，因此可以在取消事务中直接确认终态。

### 4.4 重放与不可取消终态

- `cancelling`：返回同一条已接受的取消命令；
- `cancelled`：200，`outcome=already_cancelled`；
- `completed/failed/fallback`：如果取消命令在终态之后才创建，命令标为 `rejected` 并返回 409；
- 任何重放都不得新增第二条 cancel event。

## 5. 事务与锁顺序

### 5.1 两阶段取消事务

取消接口分为两个明确阶段：

1. 使用短事务 upsert `AIRunCancelRequest` 并提交；
2. 在后续事务中锁定 run 和关联对象，执行状态迁移。

第一阶段独立提交使审批事务即使长期持有 run 锁，也能在业务写入后观察到停止意图。第二阶段失败时，持久化命令仍存在，worker 或恢复路径可以继续应用它。

### 5.2 全局相对锁顺序

共享对象的锁顺序固定为：

```text
AIAgentRun
  -> AIApprovalRequest（稳定 ID 顺序）
  -> AITaskDraft（稳定 ID 顺序）
  -> AIOperation
  -> AIMessage（稳定 ID 顺序）
  -> AIConversation
  -> 领域 service 自身已有锁顺序
```

路径不需要锁定无关对象，但只要同时涉及多个共享对象，就必须遵循该相对顺序。所有查询先使用 `family_id` 过滤；获得锁后重新读取并复核归属、状态、版本和关联 ID。

### 5.3 审批与取消竞争

审批提交调整为：

1. 预读 approval 以取得 run ID；
2. 锁定 run；
3. 锁后重新读取 approval 并确认仍指向同一 run；
4. 按顺序锁定 approval、draft、operation；
5. 复核 run 仍为 `waiting_approval` 且没有有效取消命令；
6. 执行正式业务写入；
7. 业务写入后使用当前读再次复核取消命令；
8. 若存在取消命令，保留业务结果，停止 continuation/模型恢复并将 run 收尾为 `cancelled`；否则进入正常恢复。

竞争结果：

- 取消先锁 run：审批锁后复核失败，不执行正式业务写入；
- 审批先锁 run：取消状态迁移等待审批提交，正式写入恰好一次；取消命令仍可先持久化；
- 取消在正式写入期间到达：审批提交业务结果，但不生成后续模型 round；
- 取消在 run 完全结束后到达：返回 409，不伪装为取消成功。

### 5.4 human-input 恢复与普通 finalizer

human-input 恢复同样先锁 run，确认仍为 `waiting_input` 且 pending request ID 与 checkpoint 一致。取消先获得 run 锁时，恢复不得更新 message、conversation 或 artifact。

普通聊天、审批恢复和 human-input 恢复的 finalizer 都必须锁 run 并在锁后复核取消状态，不能以先前内存状态覆盖数据库中的取消终态。

## 6. API 契约

### 6.1 提交取消

```text
POST /api/ai/runs/{run_id}/cancel
```

响应：

```ts
type AiRunCancellationOutcome =
  | 'cancel_requested'
  | 'cancelled'
  | 'already_cancelled';

interface AiRunCancellationResponse {
  outcome: AiRunCancellationOutcome;
  request: {
    run_id: string;
    status: 'requested' | 'applied';
    requested_at: string;
    resolved_at?: string | null;
  };
  run: AiRun | null;
  events: AiRunEvent[];
}
```

HTTP 语义：

- `200`：run 已确认 `cancelled`，或原本已经取消；
- `202`：取消命令已持久化，但 run 尚未创建或仍为 `cancelling`；
- `404`：已有 run/取消资源对当前家庭或用户不可见；
- `409`：取消到达前 run 已自然进入不可取消终态；
- `500`：取消命令未可靠持久化或后续处理发生内部错误。

对于合法、尚未落库的前端 `client_run_id`，返回 202，不返回 404。跨家庭已有 run 仍按不可见资源返回 404。

409 与错误响应沿用项目结构化错误约定，至少包含机器可读 code、真实 run status 和 refresh/recovery hint。

### 6.2 查询取消状态

```text
GET /api/ai/runs/{run_id}/cancellation
```

用于 202 后确认终态。主工作台可以同时使用会话 live sync；小灶没有持久化聊天历史，必须能够独立查询 run/cancellation 状态。

## 7. `waiting_input` 完整取消

取消 `waiting_input` 时，在同一事务内：

- `AIAgentRun.status = cancelled`；
- `AIMessage.status = cancelled`；
- `human_input_request` part 写入 `status=cancelled`、`cancelled_at` 和结构化 cancellation；
- 不创建 `response`，不创建 `human.input_result`，不写 `lastHumanInputResult`；
- 从 `run.context_summary` 删除 `pendingHumanInput`；
- 从 `conversation.context.taskState` 删除 `pendingHumanInput`；
- 从 conversation context 删除 `activeRunId`；
- 可以写入紧凑的 `lastHumanInputCancellation` 审计摘要；
- `conversation.last_run_status = cancelled`；
- 删除该活动 graph thread 的 checkpoint/write 行。

刷新后，卡片展示“任务已取消，未提交回答”，不再提供输入控件。

### 7.1 resume guard

审批恢复和 human-input 恢复都执行双重保护：

```text
读取 checkpoint 并取得 run_id/request_id
  -> FOR UPDATE 锁 run
  -> 锁后复核 family/conversation/run 和 waiting 状态
  -> 检查不存在 requested/applied cancel request
  -> 重新读取 checkpoint
  -> 复核 run_id/request_id 未变化
  -> 才允许恢复
```

进入 provider/graph 恢复前再执行一次轻量取消检查。删除 checkpoint 是状态清理，run/cancel guard 才是并发安全边界；不能只依赖 checkpoint 不存在。

## 8. 独立取消语义

取消不再写成失败或拒绝：

- `AIMessage.status = cancelled`；
- `AIRunEvent.status` 增加 `cancelled`；
- 新取消事件使用 `type=cancel`、`internal_code=user_cancel`、`status=cancelled`；
- run 中仍为 `pending/running/waiting` 的 event 收尾为 `cancelled`；
- message part 中内嵌的 activity 状态同步为 `cancelled`；
- `AIApprovalRequest.status = cancelled`，`decision` 保持空值；
- 待审批 `AITaskDraft.status = cancelled`；
- approval、draft 和 human-input 对应 part 同步取消状态；
- `AIAgentRun.error/error_code` 不保存用户取消原因。

前端取消活动使用中性状态和“已取消这次任务”文案，不显示红色“执行失败”。

## 9. 前端统一取消控制

新增跨主工作台与小灶复用的取消状态 hook，按 run 管理：

```ts
type AiRunCancellationPhase =
  | 'idle'
  | 'requesting'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
```

每个 run 维护 AbortController、正在执行的 cancel Promise、后端 outcome、可见错误和状态确认任务。

### 9.1 单次 in-flight

- cancel Promise 存在时，快速连点复用同一 Promise；
- 不能只依赖 React state 防重；
- in-flight、controller、event 和 error 全部按 run 隔离；
- 两个会话可并行运行和分别取消。

### 9.2 后端确认后再中断

- 点击后先进入 `requesting`；
- API 返回 200/202 后才 abort 对应 SSE/controller；
- 200 才显示“已取消”；
- 202 显示“正在停止…”，通过 live sync 或取消状态 API 等待终态；
- 404/409/500 不 abort、不创建本地假事件、不标记 message 为 cancelled；
- 取消失败显示明确错误并恢复可点击状态；
- 409 触发真实 run/message 刷新。

### 9.3 按钮与可访问性

- `requesting/cancelling` 时按钮 disabled；
- 使用 `aria-busy`、明确 `aria-label` 和 `role=alert` 错误区域；
- 桌面、移动端和小灶停止/发送点击区至少为 44×44px；
- `cancelling` 仍是 busy，最终确认前不能发送下一条消息。

## 10. 统一 AbortError

普通对话、审批恢复、human-input 恢复和小灶 SSE 统一调用共享 helper：

```ts
isExpectedAiStreamAbort(error, {
  signal,
  runId,
  cancellationPhase,
  abortReason,
})
```

预期 abort 仅包括：

- 后端已经接受该 run 的取消请求；
- 组件卸载；
- 会话权限变化后的主动清理；
- 明确的流替换或资源清理。

规则：

- 预期 abort 不追加失败消息或 failed event；
- 取消 API 失败时 controller 不 abort，原流继续；
- 不能只凭错误 message 中包含 `aborted` 就静默吞错；
- 审批后台 Promise catch 与 human-input catch 使用同一 helper；
- human-input 取消竞争后的乐观状态必须由服务端 part 覆盖，不能留下假回答；
- 审批业务写入已完成时保留 operation result，只停止后续 AI 输出。

## 11. 小灶接入

### 11.1 文字和带播报 SSE

- 前端继续生成稳定 `client_run_id`；
- `stop()` 调用统一取消 hook；
- 200/202 后才停止文本流和 TTS 播放；
- 202 显示“正在停止小灶回复…”；
- 后端确认后显示中性的“已取消这次回复”；
- 取消失败时继续接收回复并显示错误。

### 11.2 实时语音 turn

- `turn_id` 同时作为该 turn 的 `client_run_id`；
- WebSocket `cancel_turn/hangup` 先调用统一后端取消 service，再终止异步 turn；
- 服务端返回取消确认后，客户端关闭或回到 listening；
- 新 turn 替换旧 turn 时，旧 turn 也通过相同取消服务收尾；
- hangup 表示“取消当前 turn 并关闭语音会话”；
- 已执行的页面本地 UI action 不承诺撤销，但停止后续模型输出和语音播放。

## 12. 测试策略

实现严格采用测试先行：先添加能准确表达缺陷的失败测试，确认其因缺少目标行为而失败，再修改生产代码。

### 12.1 后端

- 快速重复取消只产生一条命令和一组取消事件；
- run 尚未落库时先取消，后续请求不调用 provider；
- `pending/running -> cancelling -> cancelled`；
- worker/finalizer 不覆盖取消终态；
- `waiting_approval` 取消同步处理 run、approval、draft、part 和 checkpoint；
- 取消先获得 run 锁时审批不写业务；
- 审批先获得 run 锁时业务恰好写入一次，取消阻止 continuation；
- 审批写入失败整体回滚，独立取消命令仍有效；
- `waiting_input` 取消同步处理 part、message、run/conversation context 和 checkpoint；
- human-input resume 先获得锁时回答一次，随后取消后续执行；
- 取消先获得锁时 resume 不创建回答 artifact；
- 旧 checkpoint 无法绕过 resume guard；
- 刷新查询得到稳定终态；
- 两会话与两家庭互不干扰；
- message/event/approval/draft 使用取消语义；
- 小灶 transient history 清理后保留 run 与取消审计；
- 小灶文字、语音 SSE、实时语音 turn 使用相同取消服务；
- completed/failed/fallback 返回结构化 409；
- 锁冲突和内部失败不留下部分迁移。

### 12.2 前端

- 快速双击只调用一次 cancel API；
- 200 后 abort 并显示已取消；
- 202 只显示正在停止，最终确认后显示已取消；
- run 未落库的 202 正常等待确认；
- 404/409/500 不 abort、不创建假事件，错误可见；
- 普通对话、审批恢复、human-input 恢复的预期 AbortError 不显示失败；
- 非预期断流仍显示错误；
- waiting-input 刷新后不可继续填写；
- 审批与取消竞争保留真实业务结果；
- 两会话 controller、in-flight、事件和按钮隔离；
- 小灶文字/播报仅在后端接受后停止；
- 小灶取消失败后继续回复；
- 实时语音 cancel/hangup 等待服务端确认；
- 桌面和移动端按钮反映单次 in-flight。

## 13. 验证与验收

至少执行：

```bash
backend/.venv/bin/python -m pytest -q <新增和受影响的定向测试>
npm --prefix frontend test -- <新增和受影响的定向测试>
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
npm run frontend:quality
npm run frontend:build
npm --prefix frontend run check:style-tokens
npm run backend:test:ai
npm run backend:migrate
git diff --check
```

响应式人工验收：

- 手机：390×844；
- 平板：768×1024；
- 桌面：1440×900。

若本地数据库、浏览器或服务依赖不可用，最终交付必须明确列出未执行项，不能用静态检查、单测、构建或 smoke 互相替代。

## 14. 非目标与兼容边界

- 不为取消实现业务写入补偿或撤销机制；
- 不改变 `draft -> approval -> service commit` 正式写入边界；
- 不让模型获得正式 write tool；
- 不将小灶 transient conversation 纳入主 AI 历史；
- 不在本次重构无关 AI skill、tool 或页面结构；
- 不依赖单机内存取消标记作为正确性边界；内存 controller/cache 仅用于体验优化。
