# AI 助手 Agent Loop 可观测性改造方案

更新时间：2026-06-25

## 1. 背景

当前 AI 工作台已经统一到 `WorkspaceOrchestratorAgent` 主路径，由 `WorkspaceGraphRunner` 驱动 LangGraph orchestrator loop，并通过 provider tool calling 调用 Skill、Tool、Script、草稿审批和 human input。

现有链路的问题不是完全没有日志，而是日志和进度事件分散在不同层：

- `AIRunEvent` / `run_activity` 主要服务前端展示“正在调用工具”“生成草稿”“等待用户补充信息”。
- 后端 `logger.info/warning` 分散在 Runner、Provider、ToolExecutor 等位置，缺少统一 trace id、round id、span id。
- Provider 每轮最终发给 AI 的完整 messages、tools、tool result 上下文和 AI 原始响应没有持久化。
- 出错时只能看到最终 fallback 或局部异常，很难还原“第几轮、发了什么、模型回了什么、哪个工具失败、状态为什么切到 failed / waiting”。

本方案目标是建立一套能支撑日常开发、线上排查和 agent loop 调试的可观测体系。

## 2. 目标

1. 每个 `AIAgentRun` 都有统一 `trace_id`，能串起 Runner、Orchestrator、Provider、Tool、Script、Draft、Approval、Human Input 和持久化步骤。
2. 能按 `run_id` 查看完整 agent loop 时间线，包括每轮 provider round、tool call、script call、状态切换和错误。
3. 能查看每次最终发送给 AI provider 的完整内容，以及 AI provider 的完整响应，方便调试 prompt、工具 schema、tool result 上下文和模型 tool call 行为。
4. 用户可见进度和开发调试 trace 分离，避免把敏感 payload 暴露到普通对话 UI。
5. trace 写入失败不能影响 AI 主流程。
6. 默认生产环境安全脱敏，开发环境可配置开启 full payload。

## 3. 非目标

- 不改变 AI 安全边界：模型仍只能读、算、生成草稿，正式写入必须 `draft -> approval -> commit`。
- 不把 write tool 暴露给模型。
- 不用 `AIRunEvent` 承载完整调试 payload。
- 不要求第一阶段立即完成前端调试 UI。
- 不把 provider API key、HTTP headers、图片 base64、密钥或未脱敏 token 写入普通日志。

## 4. 核心设计

整体拆成三层：

```text
用户可见层：
  AIRunEvent / run_activity / SSE progress
  只展示简短进度、工具名称、状态和用户可理解文案。

内部 trace 层：
  AIRunTraceSpan
  记录 run、graph node、orchestrator round、provider round、tool、script、draft、approval、人机交互和持久化 span。

LLM exchange 层：
  AIRunLLMExchange
  记录每次最终发送给 AI provider 的完整 request messages / tools / options，以及 provider response message / tool calls / text / error。
```

`AIRunEvent` 继续服务前端实时体验；`AIRunTraceSpan` 和 `AIRunLLMExchange` 服务调试和审计。

## 5. 数据模型

### 5.1 `ai_run_trace_spans`

新增 ORM model：`AIRunTraceSpan`

建议字段：

```text
id                  String(64), primary key
family_id           FK families.id, index, not null
run_id              FK ai_agent_runs.id, index, not null
conversation_id     FK ai_conversations.id, nullable, index
trace_id            String(64), index, not null
span_id             String(64), index, not null
parent_span_id      String(64), nullable, index
span_type           String(64), index, not null
name                String(120), not null
status              String(32), index, not null
round_index         Integer, nullable
attempt_index       Integer, nullable
started_at          DateTime(timezone=True), not null
ended_at            DateTime(timezone=True), nullable
duration_ms         Integer, default 0, not null
input_summary       JSON, default dict, not null
output_summary      JSON, default dict, not null
error_code          String(80), nullable, index
error_message       Text, nullable
exception_type      String(120), nullable
payload             JSON, default dict, not null
created_by          String(64), nullable
```

`span_type` 第一阶段固定枚举：

- `run`
- `graph_node`
- `orchestrator_round`
- `provider_round`
- `provider_attempt`
- `tool_call`
- `script_call`
- `skill_injection`
- `draft_publish`
- `approval_wait`
- `approval_resume`
- `human_input_wait`
- `human_input_resume`
- `message_persist`
- `stream_checkpoint`
- `finalize`

`status` 第一阶段固定值：

- `running`
- `completed`
- `failed`
- `waiting`
- `cancelled`
- `skipped`

索引建议：

- `(family_id, run_id, started_at)`
- `(trace_id, started_at)`
- `(run_id, span_type, started_at)`
- `(run_id, status, started_at)`

### 5.2 `ai_run_llm_exchanges`

新增 ORM model：`AIRunLLMExchange`

这张表专门存 provider 请求/响应，不混入普通 trace span。

建议字段：

```text
id                  String(64), primary key
family_id           FK families.id, index, not null
run_id              FK ai_agent_runs.id, index, not null
conversation_id     FK ai_conversations.id, nullable, index
trace_id            String(64), index, not null
span_id             String(64), nullable, index
provider_round      Integer, not null
attempt_index       Integer, not null
mode                String(32), not null       # stream / blocking / generate
model               String(120), not null
request_messages    JSON, default list, not null
request_tools       JSON, default list, not null
request_options     JSON, default dict, not null
response_message    JSON, default dict, not null
response_text       Text, nullable
response_tool_calls JSON, default list, not null
stream_chunks       JSON, default list, not null
status              String(32), index, not null
error_code          String(80), nullable, index
error_message       Text, nullable
started_at          DateTime(timezone=True), not null
ended_at            DateTime(timezone=True), nullable
duration_ms         Integer, default 0, not null
created_by          String(64), nullable
```

索引建议：

- `(family_id, run_id, provider_round, attempt_index)`
- `(trace_id, provider_round, attempt_index)`
- `(run_id, status, started_at)`

### 5.3 迁移要求

新增 Alembic migration，不能修改旧 migration。

迁移需要：

- 创建 `ai_run_trace_spans`
- 创建 `ai_run_llm_exchanges`
- 添加上述索引
- 外键 `family_id` 使用 `ondelete=CASCADE`
- `run_id` 使用 `ondelete=CASCADE`
- `conversation_id` 使用 `ondelete=SET NULL`

## 6. 配置

新增配置项，放入 `backend/app/core/config.py`：

```env
AI_TRACE_ENABLED=true
AI_TRACE_CAPTURE_LLM_EXCHANGES=true
AI_TRACE_CAPTURE_STREAM_CHUNKS=false
AI_TRACE_CAPTURE_IMAGE_BYTES=false
AI_TRACE_PAYLOAD_MODE=redacted
AI_TRACE_RETENTION_DAYS=7
AI_TRACE_MAX_REQUEST_BYTES=1048576
AI_TRACE_MAX_RESPONSE_BYTES=1048576
```

语义：

- `AI_TRACE_ENABLED`：是否记录 trace span。
- `AI_TRACE_CAPTURE_LLM_EXCHANGES`：是否记录完整 LLM request/response。
- `AI_TRACE_CAPTURE_STREAM_CHUNKS`：是否记录每个 streaming chunk；默认关闭，避免体积过大。
- `AI_TRACE_CAPTURE_IMAGE_BYTES`：是否记录图片 data URL/base64；默认关闭。
- `AI_TRACE_PAYLOAD_MODE`：
  - `summary`：只记录 keys、数量、长度和短摘要。
  - `redacted`：记录完整结构，但脱敏敏感字段和图片 bytes。
  - `full`：记录完整 payload，仅允许开发环境或显式 debug 环境。
- `AI_TRACE_RETENTION_DAYS`：trace 保留天数。
- `AI_TRACE_MAX_REQUEST_BYTES` / `AI_TRACE_MAX_RESPONSE_BYTES`：单次 exchange 最大落库大小，超过则截断并记录 `truncated=true`。

生产默认建议：

```env
AI_TRACE_ENABLED=true
AI_TRACE_CAPTURE_LLM_EXCHANGES=true
AI_TRACE_CAPTURE_STREAM_CHUNKS=false
AI_TRACE_CAPTURE_IMAGE_BYTES=false
AI_TRACE_PAYLOAD_MODE=redacted
AI_TRACE_RETENTION_DAYS=7
```

本地开发可临时开启：

```env
AI_TRACE_PAYLOAD_MODE=full
AI_TRACE_CAPTURE_STREAM_CHUNKS=true
```

## 7. 后端模块设计

新增目录：

```text
backend/app/ai/observability/
  __init__.py
  tracer.py
  llm_exchange.py
  redaction.py
  error_codes.py
  serializers.py
```

### 7.1 `AIRunTracer`

`tracer.py` 提供 `AIRunTracer`：

```python
class AIRunTracer:
    def start_span(
        self,
        span_type: str,
        name: str,
        *,
        parent_span_id: str | None = None,
        round_index: int | None = None,
        attempt_index: int | None = None,
        input_summary: dict | None = None,
        payload: dict | None = None,
    ) -> TraceSpanContext: ...

    def record_event(
        self,
        span_type: str,
        name: str,
        *,
        status: str = "completed",
        payload: dict | None = None,
    ) -> None: ...
```

使用方式：

```python
with tracer.start_span("tool_call", tool_name, input_summary={"inputKeys": sorted(payload.keys())}) as span:
    output = tool_executor.call(...)
    span.set_output_summary({"outputKeys": sorted(output.keys())})
```

约束：

- trace 写入失败必须被捕获，不能中断 AI run。
- span 结束时写 `ended_at`、`duration_ms`、`status`。
- 异常时写 `status=failed`、`error_code`、`error_message`、`exception_type`，然后重新抛给业务流程。
- tracer 不持有长事务；优先使用当前 db session flush，必要时在 stream checkpoint 时一起 commit。

### 7.2 `LLMExchangeRecorder`

`llm_exchange.py` 提供：

```python
class LLMExchangeRecorder:
    def start_exchange(...): ...
    def finish_exchange(...): ...
    def fail_exchange(...): ...
```

记录范围：

- `system` + `user` 转换后的最终 provider messages。
- 当前 provider round 暴露给模型的 tool schemas。
- provider options，例如 `temperature`、`max_rounds`、`tool_count`、`supports_vision`。
- AI response message 原始结构。
- AI tool calls 原始结构和归一化结构。
- streaming 模式下拼出的 response text。
- 可选 stream chunks。

采集位置必须在 `backend/app/ai/runtime/provider.py`：

- `OpenAICompatibleChatProvider.generate()`
- `OpenAICompatibleChatProvider.generate_with_tools()`
- `_generate_with_tools_blocking()`

因为这里才能保证记录的是“最终真的发给 AI provider 的内容”，而不是 Orchestrator 中间态。

### 7.3 `redaction.py`

脱敏规则：

- 不记录 API key、authorization header、cookie、token、secret、password。
- 图片默认不记录 base64/data URL，只保留：
  - `media_id`
  - `content_type`
  - `filename`
  - `byte_size`
  - `sha256`
  - `redacted=true`
- 文本默认按配置保留完整内容；超过最大字节数时截断并记录：
  - `truncated=true`
  - `original_size`
  - `stored_size`
- tool input/output 默认可记录完整 JSON，但需要递归脱敏敏感字段。
- provider exception 不记录 request headers。

敏感字段名匹配：

```text
api_key
authorization
cookie
token
secret
password
access_token
refresh_token
credential
```

## 8. 埋点位置

### 8.1 Runner

文件：`backend/app/ai/workflows/runner.py`

埋点：

- `_initialize_step`
  - `span_type=run`
  - 记录 `conversation_id`、`client_run_id`、`quick_task`、是否有 attachments。
- `_orchestrator_step`
  - `span_type=graph_node`
  - name=`orchestrator`
  - 记录输入状态：`agent_rounds`、`injected_skill_keys`、`run_artifact_count`。
  - 记录输出状态：`result.status`、`draft_count`、`card_count`、`tool_call_count`。
- `_route_after_orchestrator`
  - 记录 route 决策：`running`、`waiting_approval`、`waiting_input`、`completed`、`failed`。
- `_approval_interrupt_step`
  - 记录 pending approval id、draft type。
- human input interrupt / resume 相关方法
  - 记录 request id、是否成功恢复。
- `_persist_assistant_result`
  - 记录 message id、parts 类型、draft/card 数量。
- `_persistent_progress_writer`
  - 不写完整 payload，只记录 progress event 创建/更新失败。
- `_finalize_graph`
  - 记录最终 run status、duration、error。

### 8.2 Orchestrator

文件：`backend/app/ai/workflows/orchestrator.py`

埋点：

- `WorkspaceOrchestratorAgent.run()`
  - `span_type=orchestrator_round`
  - 记录 active skills、initial injected skills、tool budget、historical tool signature 数量。
- `refresh_tools()`
  - 记录当前暴露 tool names、script tool names。
- `inject_skills()`
  - `span_type=skill_injection`
  - 记录 requested / added / alreadyInjected / availableTools。
- `call_tool()`
  - 不在这里代替 ToolExecutor 记录工具执行，但要记录 agent loop 层面的 gating：
    - unavailable tool
    - tool budget exhausted
    - same read tool loop detected
    - draft budget exhausted
    - human input budget exhausted
    - `__tool_loop_stop__`
- provider result 处理
  - 记录 provider status、model、error、text length、draft/card validation 结果。

### 8.3 Provider

文件：`backend/app/ai/runtime/provider.py`

埋点：

- 每次 provider round 创建 `span_type=provider_round`。
- 每次 streaming attempt 创建 `span_type=provider_attempt`。
- 在 `client.stream(messages)` 前记录 LLM exchange request。
- 在 stream 完成、无 chunks、异常、fallback blocking 前更新 exchange。
- 每个 AI tool call 记录：
  - model tool name
  - mapped internal tool name
  - arg keys
  - call id
  - preview event id
- `_generate_with_tools_blocking()` 同样记录 exchange。
- `generate()` 非 tool 模式也记录 exchange。

LLM request 必须包含：

- `messages`：最终传入 LangChain client 的 messages 序列化结果。
- `tools`：最终 bind_tools 的 tool schemas。
- `options`：
  - model
  - temperature
  - max_rounds
  - round index
  - attempt index
  - tool count
  - mode
- `request_digest`：对最终 request 做 sha256，用于确认前端导出的内容和数据库记录一致。
- `request_bytes`：截断前的 request 字节数。
- `request_truncated`：是否因 `AI_TRACE_MAX_REQUEST_BYTES` 被截断。

LLM response 必须包含：

- 原始 assistant message 可 JSON 化结构。
- `content`
- `tool_calls`
- `tool_call_chunks`，如可用。
- 拼接后的 `response_text`
- status / error。
- `response_digest`：对最终 response 做 sha256。
- `response_bytes`：截断前的 response 字节数。
- `response_truncated`：是否因 `AI_TRACE_MAX_RESPONSE_BYTES` 被截断。

采集契约：

- “最终发送给 AI 的完整内容”以 provider 层实际调用 client 前的 payload 为准，包括系统消息、用户消息、历史 assistant/tool 消息、图片引用占位、tool schema 和 provider options。
- Orchestrator、Runner 或前端提交的中间态只能作为 span summary，不能替代 `ai_run_llm_exchanges.request_messages`。
- 每次 retry、stream fallback、blocking fallback 都必须独立生成一条 exchange，不能覆盖上一条失败 exchange。
- 如果开启 `summary` 或触发最大字节截断，接口必须显式返回 `truncated=true`、原始大小和摘要，避免调试人员误以为拿到了完整 payload。
- 如果开启 `redacted`，结构必须尽量完整保留，只替换敏感字段值和图片 bytes，方便定位 prompt 顺序、tool schema、tool result 上下文是否正确。

### 8.4 ToolExecutor

文件：`backend/app/ai/tools/executor.py`

埋点：

- `span_type=tool_call`
- name=`definition.name`
- input summary：
  - `side_effect`
  - `permission`
  - `input_keys`
  - `allowed_tools` 是否命中
  - `allowed_side_effects`
- output summary：
  - `status`
  - `duration_ms`
  - `output_keys`
- 失败：
  - unknown tool -> `tool_unknown`
  - forbidden tool -> `tool_permission_denied`
  - undeclared tool -> `tool_permission_denied`
  - side effect rejected -> `tool_side_effect_denied`
  - input validation -> `tool_input_validation_failed`
  - output validation -> `tool_output_validation_failed`
  - handler failed -> `tool_handler_failed`

### 8.5 ScriptExecutor

文件：`backend/app/ai/skills/scripts.py`

埋点：

- `span_type=script_call`
- name=`tool_name`
- input summary：
  - script path basename
  - function name
  - input keys
  - timeout seconds
- output summary：
  - result keys/type
  - duration
- 失败：
  - input validation failed
  - subprocess timeout
  - non-zero exit
  - output validation failed

## 9. 错误码

新增 `backend/app/ai/observability/error_codes.py`。

第一阶段标准错误码：

```text
provider_unavailable
provider_empty_response
provider_stream_failed
provider_blocking_failed
provider_tool_handler_failed
provider_max_rounds_exceeded
tool_unknown
tool_permission_denied
tool_side_effect_denied
tool_input_validation_failed
tool_output_validation_failed
tool_handler_failed
tool_budget_exhausted
tool_loop_detected
script_input_validation_failed
script_timeout
script_execution_failed
script_output_validation_failed
skill_injection_unknown
skill_budget_exhausted
draft_budget_exhausted
draft_validation_failed
draft_without_approval
approval_waiting
approval_resume_failed
human_input_waiting
human_input_resume_failed
message_persist_failed
stream_checkpoint_failed
cancelled
unexpected_error
```

要求：

- `AIAgentRun.error_code` 后续应尽量落这些标准值。
- trace span 使用同一套错误码。
- provider / tool / script 的旧日志可以保留，但新日志必须带标准错误码。

## 10. API 设计

### 10.1 Trace Timeline

新增：

```http
GET /api/ai/runs/{run_id}/trace
```

响应：

```json
{
  "runId": "agent_run_xxx",
  "traceId": "ai_trace_xxx",
  "status": "failed",
  "spans": [
    {
      "id": "ai_span_xxx",
      "spanId": "ai_span_xxx",
      "parentSpanId": null,
      "spanType": "orchestrator_round",
      "name": "orchestrator",
      "status": "failed",
      "roundIndex": 2,
      "attemptIndex": null,
      "startedAt": "...",
      "endedAt": "...",
      "durationMs": 1234,
      "inputSummary": {},
      "outputSummary": {},
      "errorCode": "tool_output_validation_failed",
      "errorMessage": "..."
    }
  ]
}
```

### 10.2 Trace Tree

新增：

```http
GET /api/ai/runs/{run_id}/trace/tree
```

后端按 `parent_span_id` 组装树，方便前端调试抽屉直接渲染。

### 10.3 LLM Exchanges

新增：

```http
GET /api/ai/runs/{run_id}/llm-exchanges
```

响应：

```json
{
  "runId": "agent_run_xxx",
  "traceId": "ai_trace_xxx",
  "exchanges": [
    {
      "id": "ai_llm_exchange_xxx",
      "providerRound": 1,
      "attemptIndex": 1,
      "mode": "stream",
      "model": "gpt-...",
      "requestMessages": [],
      "requestTools": [],
      "requestOptions": {},
      "responseMessage": {},
      "responseText": "...",
      "responseToolCalls": [],
      "streamChunks": [],
      "status": "completed",
      "errorCode": null,
      "errorMessage": null,
      "durationMs": 1450
    }
  ]
}
```

权限要求：

- 必须按当前 membership 的 `family_id` 过滤。
- 普通家庭成员不应默认看到完整 LLM exchange。
- 第一阶段可以限制为 Owner，后续可加 debug role。
- 生产环境如果 `AI_TRACE_PAYLOAD_MODE=summary`，接口也只能返回 summary。

## 11. 前端调试入口

第一阶段不强制实现 UI。

后续建议在开发态或 Owner 模式下给 AI 消息增加“调试”入口：

- Run Timeline：按时间展示 span。
- LLM Exchanges：按 provider round 展示 request / response。
- Tool Calls：展示 tool input/output 摘要。
- Errors：高亮 failed span 和 error code。
- Export：下载 trace JSON。

入口不要出现在普通移动端主体验中，避免干扰家庭日常使用。

## 12. 日志规范

保留现有 logging，但新增结构化字段。

关键日志必须包含：

```text
trace_id
span_id
run_id
conversation_id
family_id
round_index
attempt_index
span_type
name
status
duration_ms
error_code
```

示例：

```python
logger.warning(
    "AI provider stream failed",
    extra={
        "trace_id": trace_id,
        "span_id": span_id,
        "run_id": run_id,
        "conversation_id": conversation_id,
        "family_id": family_id,
        "round_index": round_index,
        "attempt_index": attempt_index,
        "error_code": "provider_stream_failed",
    },
    exc_info=True,
)
```

不要在普通 logger 中打印完整 prompt、完整 tool output 或图片 base64。完整内容只进入 `ai_run_llm_exchanges`，并受配置、权限和保留策略控制。

## 13. 数据保留与清理

新增清理服务：

```text
backend/app/services/ai_operations/trace_retention.py
```

功能：

- 删除超过 `AI_TRACE_RETENTION_DAYS` 的 `ai_run_trace_spans`。
- 删除超过 `AI_TRACE_RETENTION_DAYS` 的 `ai_run_llm_exchanges`。
- 保留 `AIAgentRun`、`AIRunEvent`、`AIMessage` 等业务记录。

落地入口：

```bash
npm run backend:prune-ai-trace -- --dry-run
npm run backend:prune-ai-trace -- --retention-days 14
```

部署时可以把该脚本接入 cron、容器定时任务或平台调度器。

## 14. 测试策略

后端新增测试集中放在 `backend/tests/ai_infra/`。

建议新增文件：

```text
backend/tests/ai_infra/test_ai_observability.py
backend/tests/ai_infra/test_llm_exchange_capture.py
```

覆盖场景：

1. 成功普通问答会创建 run span、orchestrator span、provider exchange。
2. tool calling 成功时会创建 provider round、tool call span，并记录 request tools。
3. tool input validation 失败时 span 标记 failed，error code 为 `tool_input_validation_failed`。
4. provider stream 失败并 fallback blocking 时，两次 exchange 都可查。
5. draft tool 成功后记录 draft publish span，并进入 `waiting_approval`。
6. human.request_input 成功后记录 human input wait span。
7. 图片输入默认不记录 base64，只记录 media id、content type、size/hash。
8. `AI_TRACE_CAPTURE_LLM_EXCHANGES=false` 时不创建 exchange，但 trace span 仍可创建。
9. trace 写入失败不影响 AI run 主流程。
10. trace API 按 `family_id` 隔离，不能跨家庭读取。

推荐验证命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_llm_exchange_capture.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
npm run backend:test
```

## 15. 分阶段落地

### Phase 1：后端最小闭环

范围：

- 新增 ORM model 和 Alembic migration。
- 新增 `observability` 模块。
- Runner / Orchestrator / Provider / ToolExecutor / ScriptExecutor 关键埋点。
- 新增 trace API 和 LLM exchange API。
- 新增后端测试。

验收：

- 任意 AI run 可通过 API 查到 trace timeline。
- 每次 provider round 可查到最终 request messages、tools、options 和 response。
- tool/script/provider 失败有标准 error code。
- trace 写入失败不影响 AI run。

### Phase 2：前端调试抽屉

范围：

- 开发态或 Owner 可见调试入口。
- Timeline 树状展示。
- LLM exchange request/response JSON 查看。
- failed span 高亮。
- 导出 JSON。

验收：

- 不影响普通移动端 AI 对话体验。
- 可以从一条失败消息直接定位到 provider request、tool call 和 error code。

### Phase 3：质量指标和清理

范围：

- trace retention job。
- 按 error code 聚合失败率。
- provider round 耗时、tool 耗时、平均 round 数。
- 接入现有 `ai_quality` 的 `/api/ai/quality-metrics`，通过 `trace_metrics` 返回 trace span、LLM exchange、错误码和耗时聚合；后续如信息量继续增长，再拆新增内部诊断页。

验收：

- 可以回答“最近 7 天 AI 失败主要是 provider、tool validation 还是审批恢复问题”。
- trace 表不会无限增长。

## 16. 实现注意事项

1. `AIRunEvent` DTO 当前不暴露 `payload`，不要为了 debug 直接把 payload 暴露给普通进度接口。
2. LLM exchange 捕获必须放在 provider 层，不能只在 Orchestrator 层记录 user payload，否则不是最终发送给 AI 的内容。
3. 图片 data URL 默认必须脱敏；家庭照片不应长期进入 debug 表。
4. `AI_TRACE_PAYLOAD_MODE=full` 必须受环境约束，生产不建议开启。
5. Tool input/output 可能包含家庭库存、菜谱、用餐记录，完整 exchange 接口必须有 family 隔离和权限控制。
6. trace 写入不要包住主业务事务导致回滚 AI 正常结果；写入失败要降级为 logger。
7. 如果 provider streaming 已经输出了部分文本，后续 retry/fallback 的 exchange 必须记录清楚，避免调试时误判重复回复。
8. 对已存在的 `AIAgentRun.tool_calls` 不做破坏性迁移；它可以继续作为轻量摘要，完整调试信息进入新表。

## 17. 推荐文件变更清单

后端：

```text
backend/app/models/domain.py
backend/alembic/versions/<revision>_add_ai_run_observability.py
backend/app/schemas/ai.py
backend/app/services/serializers.py
backend/app/api/ai.py
backend/app/core/config.py
backend/app/ai/observability/__init__.py
backend/app/ai/observability/tracer.py
backend/app/ai/observability/llm_exchange.py
backend/app/ai/observability/redaction.py
backend/app/ai/observability/error_codes.py
backend/app/ai/observability/serializers.py
backend/app/ai/workflows/runner.py
backend/app/ai/workflows/orchestrator.py
backend/app/ai/runtime/provider.py
backend/app/ai/tools/executor.py
backend/app/ai/skills/scripts.py
backend/tests/ai_infra/test_ai_observability.py
backend/tests/ai_infra/test_llm_exchange_capture.py
```

前端 Phase 2：

```text
frontend/src/api/types.ts
frontend/src/api/aiApi.ts
frontend/src/api/queryKeys.ts
frontend/src/components/ai/AiRunDebugDrawer.tsx
frontend/src/components/ai/AiConversationThread.tsx
frontend/src/components/ai/AiWorkspace.tsx
frontend/src/styles/06-food-workspace.css
frontend/src/api/aiApi.test.ts
frontend/src/components/ai/AiWorkspace.test.tsx
```

## 18. 最终验收标准

一次失败的 AI run 应该能被这样排查：

1. 通过 `run_id` 打开 trace timeline。
2. 看到第几轮 orchestrator 失败。
3. 看到该轮最终发给 AI 的完整 messages 和 tool schemas。
4. 看到 AI 原始响应文本和 tool calls。
5. 看到具体 tool/script/provider span 失败。
6. 看到标准 error code、异常类型、耗时和摘要 payload。
7. 确认是否进入 waiting approval / waiting input / failed / cancelled。

如果能做到以上 7 点，就说明 agent loop 对开发调试是可观测的。
