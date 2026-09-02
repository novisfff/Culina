# AI 对话有序事件协议设计

## 状态

- 分支：`refactor/ai-message-event-protocol`
- 日期：2026-09-03
- 范围：主 AI 会话的实时消息、历史恢复、审批/人机输入恢复和运行活动展示
- 目标：彻底移除基于到达顺序、时间戳和多份数组猜测的消息排序逻辑，建立服务端拥有唯一排序权的事件协议，同时保持当前桌面端和移动端对话体验不变。

## 1. 背景与问题

当前一条对话同时存在四个顺序来源：

1. SSE 在单条连接上的到达顺序。
2. 进程内 `LiveAIStreamCache` 的 parts 数组顺序。
3. `AIMessage.parts` 的最终 JSON 快照顺序。
4. 独立 `AIRunEvent` 加载后由前端推断出的活动顺序。

`AIMessage.parts` 还同时承担快照、时间线、流缓存和卡片状态四种职责；前端又把服务端消息、本地流消息、progress 和最终 response 分开维护，再通过 ID、文本长度、卡片类型和“插入第一个输出卡片之前”等规则合并。结果卡片、审批恢复和异步历史加载会改变其中一份事实的到达时机，于是出现以下现象：

- 实时看到的顺序和刷新后的顺序不同；
- 结果卡片跑到草稿/占位之前；
- 文本暂时出现第二行，最终快照合并时又消失；
- 只有结构化结果存在时发生错位，普通文字看起来正常；
- SSE 断线后只能等待刷新或最终快照，无法精确补回缺失事件。

这些现象是同一个协议缺陷的不同触发方式，而不是需要继续添加的独立 UI 特判。

## 2. 目标

### 2.1 必须达到

- 服务端为每个会话分配严格递增的 `sequence`，客户端不再用 `created_at` 或网络到达时刻排序。
- 每一个可见变化只有一个 canonical event；实时 SSE、历史恢复和断线重连使用同一事件格式。
- 事件先在数据库中以 append-only 形式提交，再发送给客户端；客户端永远不会看到不可恢复的“幽灵事件”。
- 事件具备稳定 `event_id`，重复投递可幂等处理。
- 客户端检测到 sequence gap 时主动补拉，不继续猜测或追加本地副本。
- 用户消息和 assistant 占位消息在 run 开始前就拥有正式 ID 和顺序位置；流期间不再创建 `local-assistant-*` 这类伪消息。
- 文本、运行活动、草稿、审批、人机输入和结果卡片都通过同一 reducer 应用；更新只替换原位置，不删除后重新追加。
- 刷新、切换会话、审批恢复和人机输入恢复后，视觉顺序与实时状态一致。
- 保留现有消息卡片、文字样式、审批动作、停止/重试、滚动和桌面/移动端信息架构。
- `persist_history=false` 的做菜助手继续保持临时会话语义，不写入主会话事件日志。

### 2.2 不做

- 不重写 LangGraph、Provider、Skill catalog、Tool 权限和 draft commit gate 的业务规则。
- 不引入 CRDT 或多人同时编辑同一条消息的协作模型；当前会话仍遵守“一个活动 run”的约束。
- 不保留旧的实时 overlay、历史 fallback 或排序兼容分支。仓库中的旧 migration 文件保持不可变，但运行时代码只实现新协议。
- 不修改 AI 卡片视觉规格、文案语气、审批语义或业务操作结果。

## 3. 核心不变量

### 3.1 唯一排序权

`AIConversationEvent.sequence` 是某个 `conversation_id` 内唯一的可见事件顺序。它由服务端在同一事务中分配，客户端、SSE 到达时间、数据库 `created_at` 和随机 ID 都不能参与排序。

会话增加 `timeline_version` 作为分配器：事件写入事务先锁定会话行，读取当前版本，递增一次，再写入事件和快照。事务回滚时版本和事件同时回滚；只有提交成功的事件才允许进入 SSE。

### 3.2 单一事件事实源

所有用户可见变化必须经过 `AITimelineService.append()` 或 `AITimelineService.replace()`：

- `message.created`：创建用户消息或 assistant 占位消息；
- `part.appended`：在消息中插入新的文字段、图片、草稿、审批、人机输入、结果卡或运行活动；
- `part.delta`：向已有文字段追加文本；
- `part.replaced`：以相同 `part_id` 更新审批状态、活动状态或卡片内容，位置不变；
- `message.status`：更新 running、waiting、completed、failed、cancelled；
- `run.terminal`：标记本次 run 的最终状态并携带最终 cursor。

`AIMessage.parts` 只作为由这些事件物化出的快照，禁止工作流直接通过 `message.parts = ...` 改写时间线。`AIRunEvent` 可以继续作为内部观测投影，但不再被消息 UI 用来推断位置。

### 3.3 稳定身份与原位更新

- 每个可见 part 有稳定 `part_id`。
- 活动状态变化使用同一个逻辑 `part_id`，只产生 `part.replaced`，不能“删旧活动、把新活动追加到末尾”。
- Draft/approval/result card 使用业务稳定键生成 part ID；审批成功、失败、撤销和阻塞均原位替换。
- 文本段在第一次出现时分配一个新的 `part_id`；后续 delta 只能追加到该 ID，不能依靠文本内容去重。

### 3.4 提交先于推送

事件和物化快照在同一个数据库事务中提交。提交成功后，事件才进入 stream queue。若提交后进程在发送前崩溃，重连仍能用 cursor 读取事件；若提交失败，客户端不会收到该事件。

### 3.5 幂等和 gap

客户端 reducer 维护 `lastSequence` 和 `seenEventIds`：

- 已见 `event_id`：忽略；
- `sequence <= lastSequence`：忽略；
- `sequence == lastSequence + 1`：应用；
- `sequence > lastSequence + 1`：暂停应用并请求缺口事件；
- 缺口补齐后按序继续；补拉失败时保留当前稳定快照并显示现有的非侵入式重连状态。

服务端 replay 接口按 `after_sequence` 返回严格升序事件；不会根据请求方的“最后一条消息”猜测起点。

## 4. 数据模型

### 4.1 `AIConversation`

新增：

- `timeline_version: BIGINT NOT NULL DEFAULT 0`：当前已分配的最大会话序号。

事件分配器锁定会话行后执行 `timeline_version += 1`。该字段不是展示时间，也不替代 `last_message_at`。

### 4.2 `AIMessage`

新增：

- `timeline_position: BIGINT NOT NULL`：对应 `message.created` 事件的 sequence；同一会话唯一。
- `snapshot_sequence: BIGINT NOT NULL DEFAULT 0`：最后一个改变该消息快照的事件 sequence。

保留 `parts` JSON 作为物化快照，以避免同时重写所有卡片 DTO；但只允许 timeline service 更新。删除以下运行时 metadata：`liveStreaming`、`livePartIds`、`liveTextPartIds`、`streamOrderCanonical`。

### 4.3 `AIConversationEvent`

```text
id                 VARCHAR(64)       primary key       # event_id
family_id          VARCHAR(64)       not null
conversation_id    VARCHAR(64)       not null
run_id             VARCHAR(64)       nullable
message_id         VARCHAR(64)       nullable
sequence           BIGINT            not null
event_type         VARCHAR(64)       not null
operation          VARCHAR(32)       not null          # append/delta/replace/status/terminal
part_id            VARCHAR(128)      nullable
payload            JSON              not null
created_at         DATETIME          not null
created_by         VARCHAR(64)       nullable
```

约束和索引：

- `UNIQUE(conversation_id, sequence)`；
- `INDEX(conversation_id, sequence)`；
- `INDEX(run_id, sequence)`；
- `INDEX(message_id, sequence)`；
- `family_id`、`conversation_id`、`run_id` 使用现有家庭隔离和级联规则。

事件 payload 只保存前端所需的安全投影；内部 provider 输入、授权快照和完整业务 payload 继续留在现有 trace/draft/operation 记录中。

### 4.4 `AIRunEvent`

保留其内部观测职责和现有调试字段，但新增可选 `timeline_event_id` 与 `timeline_sequence`，用于排查“内部活动”和“用户可见活动”的对应关系。主消息 UI 不再读取 `/runs/{run_id}/events` 来拼接时间线。

## 5. 服务端组件

新增 `backend/app/services/ai_timeline.py`，提供唯一写入入口：

```python
class AITimelineService:
    def create_message(...)->AIMessageEvent: ...
    def append_part(...)->AIMessageEvent: ...
    def append_delta(...)->AIMessageEvent: ...
    def replace_part(...)->AIMessageEvent: ...
    def update_message_status(...)->AIMessageEvent: ...
    def terminal(...)->AIMessageEvent: ...
    def snapshot(...)->ConversationSnapshot: ...
    def replay(..., after_sequence: int)->list[AIMessageEvent]: ...
```

写入口负责：

1. 校验当前家庭、会话、run 和 message 的归属；
2. 以稳定锁顺序锁定会话和消息；
3. 分配 sequence；
4. 校验事件类型和 part 状态转换；
5. 更新 `AIMessage.parts` 物化快照；
6. 写入 `AIConversationEvent`；
7. 返回已提交前的事件对象供 worker 在 commit 后发布。

事件 reducer 的纯函数部分放在 `backend/app/ai/workflows/runner_support/timeline_reducer.py`，这样可在不启动数据库的情况下验证：重复 part、delta 追加、原位替换、terminal 后拒绝新事件和未知 part 等规则。

## 6. 端到端生命周期

### 6.1 新消息

`UserMessagePreparer` 在一次事务中创建：

1. 用户 `AIMessage`；
2. assistant 空占位 `AIMessage(status=running)`；
3. 两个 `message.created` 事件；
4. run 与 conversation 的 active 状态。

事件按用户消息、assistant 占位的顺序分配。前端收到 assistant 占位事件后仍显示现有 thinking/占位视觉，但不再生成本地伪消息。

### 6.2 普通文字

模型输出的第一个可见文字创建 `text` part；后续 chunk 产生 `part.delta`。若模型在卡片之后继续输出，服务端创建新的 text part 并通过 sequence 明确其位置，不能将所有文字拼成一个后置字符串。

### 6.3 运行活动

每个逻辑 tool/skill 活动创建一个 `run_activity` part。状态从 running 到 completed 时使用相同 part ID 的 `part.replaced`。这保持当前 UI 的折叠/摘要文案和位置，不需要前端按时间戳重新插入。

### 6.4 草稿、审批和结果卡

progressive draft publisher、approval resume 和 auto execution 都通过 timeline service 写 part。结果卡和占位/审批卡使用稳定业务键，先写入事件和快照，再发送 `message_part`。因此“占位先消失、结果后出现”由服务端事件序列和状态转换决定，不由 React 渲染时机决定。

### 6.5 完成、失败和取消

Run finalizer、runtime failure persister 和 cancellation service 都更新已有 assistant message，并追加 `message.status` 与 `run.terminal`。不再创建第二个错误 assistant message，也不再清理内存 cache 来决定客户端显示内容。

### 6.6 审批/人机输入恢复

恢复请求沿用原 assistant `message_id`，新的 run 只追加到同一消息的事件序列。用户提交后的 response part、后续文字和终态都按 sequence 写入；拒绝、冲突和失败只更新对应 part/状态，不生成隐藏的临时副本。

## 7. API 契约

### 7.1 事件 envelope

所有可见 SSE 事件统一使用：

```json
{
  "event_id": "evt_01J...",
  "conversation_id": "conversation_01J...",
  "run_id": "run_01J...",
  "message_id": "message_01J...",
  "sequence": 42,
  "event_type": "part.delta",
  "operation": "delta",
  "part_id": "part_01J...",
  "payload": {"delta": "下一段文字"},
  "is_terminal": false
}
```

服务器同时写 SSE 标准 `id: event_id` 行。`response` 是一个 terminal envelope，其 payload 包含最终 message snapshot、run 状态和 `snapshot_sequence`；它不再作为一套独立排序事实。

### 7.2 历史快照

`GET /api/ai/conversations/{conversation_id}/messages` 改为返回：

```json
{
  "conversation_id": "...",
  "snapshot_sequence": 42,
  "messages": [/* 按 timeline_position 升序 */]
}
```

不再异步为每条 assistant message 单独拼接 run events。消息中的活动 part 已经在快照中有确定位置。

### 7.3 Replay

新增：

```text
GET /api/ai/conversations/{conversation_id}/events?after_sequence=41
GET /api/ai/conversations/{conversation_id}/events/stream?after_sequence=41
```

两个接口都执行同一会话访问校验，返回严格升序事件。run 级调试接口可以继续存在，但不承担主消息恢复职责。

### 7.4 新 stream 请求

`POST /api/ai/chat/stream`、approval stream、human-input stream 和 voice stream 统一接受可选 `after_sequence`，并在 SSE 头中支持 `Last-Event-ID`。重连时先回放缺失事件，再继续发送 live 事件；若 run 已终止，返回 terminal event 和快照后关闭连接。

## 8. 前端状态机

新增 `frontend/src/components/ai/aiTimelineReducer.ts`：

```ts
type AiTimelineState = {
  conversationId: string;
  messagesById: Record<string, AiMessage>;
  messageOrder: string[];
  lastSequence: number;
  seenEventIds: Set<string>;
  activeRunId: string | null;
  gap: { from: number; to: number } | null;
};

type ApplyResult = {
  state: AiTimelineState;
  needsReplay: boolean;
};

function applyAiTimelineEvent(
  state: AiTimelineState,
  event: AiTimelineEvent,
): ApplyResult;
```

Reducer 行为：

- `message.created` 按 `timeline_position/sequence` 插入一次；
- `part.appended` 追加到指定 message 的 parts；
- `part.delta` 只更新指定 part 的 text；
- `part.replaced` 保留数组索引，只替换 payload；
- `message.status` 和 terminal 只更新状态；
- 未知 message/part、非法状态跃迁或 gap 触发 snapshot/replay 请求，不创建猜测对象。

Workspace 只保留按 conversation 隔离的 timeline state、composer 草稿和 UI 展示状态。删除 `localMessagesByConversationKey` 与 `runEventsById` 作为消息事实源；本地发送中的用户文本可以保留为单独 pending composer 状态，收到 `message.created` 后按 `client_message_id` 一次性确认，不参与排序。

## 9. 体验保持合同

重构后必须保持：

- 用户发送后立即看到自己的消息；
- assistant 占位/思考提示出现位置和当前一致；
- 文字仍然逐段流式出现，停止、重试和错误文案不变；
- skill/tool 活动摘要、草稿、审批、人机输入和结果卡视觉组件不变；
- 结果卡不会抢在其占位/审批边界前显示；
- 审批确认后沿用原消息位置，不新增“第二条 assistant 消息”；
- 刷新、切换历史、移动端和桌面端都保持同一消息顺序；
- 自动确认仍显示结果卡；
- 滚动只在真正新增 canonical event 时推进，不因历史活动异步补拉而跳动；
- `persist_history=false` 继续不污染主会话历史。

不改变现有 AI 视觉规范：消息卡、结果卡、审批卡、活动摘要和 composer 仍使用当前组件与 token；本次不新增视觉样式。

## 10. 删除项

完成切换后删除以下旧事实源和启发式：

- `backend/app/ai/workflows/live_stream_cache.py` 及其所有调用；
- `merge_message_part_timelines`、`dedupe_message_parts` 中用于修补实时/持久化顺序的逻辑；
- 前端 `mergeRemoteAndLocalMessage`、`mergeMessageParts`、`normalizeStreamEventForFinalRun`；
- `createMessageTimelineItems` 中按第一个卡片插入 run events、移动审批后文字的规则；
- `runEventsById`、`streamProgressByRunId` 作为消息排版数据；
- `liveStreaming`、`livePartIds`、`liveTextPartIds` 等 metadata；
- 文本内容重复检测作为顺序补偿的逻辑；
- 只为旧快照/旧卡片形状服务的兼容分支和测试。

保留 `AIRunEvent` 的原因是它服务运行审计、取消和调试；但它只作为 timeline event 的投影，不再被 UI 当作第二条时间线。

## 11. 验证策略

### 后端

- 纯 reducer 测试覆盖 append、delta、replace、重复 event、gap、terminal 后事件和非法 part。
- 数据库测试覆盖两个并发 writer 获得不同连续 sequence、事务回滚不产生可见 gap、同一 event 重放幂等、家庭隔离和 replay 升序。
- 流测试覆盖普通文字、文字-卡片-文字、progressive draft、approval resume、human-input resume、取消、失败和断线后 replay。
- API contract 测试断言 SSE `id`、envelope 字段、history `snapshot_sequence` 和 `after_sequence`。

### 前端

- reducer 测试覆盖乱序输入、重复输入、缺口补齐、原位替换和多会话隔离。
- API 测试覆盖 SSE `id` 解析、terminal response、replay 和 reconnect。
- Workspace/Thread 测试覆盖实时与刷新后的顺序完全相同、结果卡位置、第二行闪现不发生、审批恢复和 mobile props。
- 继续运行 AI contract、前端 quality、build、P0 smoke，并检查 375×812、390×844、430×932、768×1024、1024×768、1440×900 视口。

验收标准是：同一组 canonical events 无论以实时顺序、完整历史快照、分段 replay 或重复/乱序到达的输入喂给客户端，最终都得到同一个消息数组和 part 数组；不会依赖时间戳、网络到达顺序或文本相似度。

## 12. 实施顺序

1. 先建立模型、纯 reducer 和事件服务测试，再接入任何现有 producer。
2. 预创建 assistant 占位并接通后端事件写入，确保每个 stream 事件可持久化和 replay。
3. 切换历史和 SSE API 到统一 envelope。
4. 接入前端 reducer，删除本地/远端 merge 和 run event 注入。
5. 删除 live cache、旧 metadata 和 fallback 测试，更新文档和 schema。
6. 运行完整验证；只有 canonical event 链路全部通过后才认为重构完成。

