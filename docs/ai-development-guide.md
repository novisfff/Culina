# AI 功能开发指南

更新时间：2026-05-28

本文用于指导后续 Culina AI 功能开发。目标是让 AI 功能保持清晰分层：通用运行架构不掺业务，厨房业务复用架构，生图能力统一收在 AI 模块下。

## 当前架构

AI 代码统一放在 `backend/app/ai` 下，分为三块：

```text
backend/app/ai/
  runtime/   # 通用 agent 运行架构
  kitchen/   # Culina 厨房业务 agent
  images/    # AI 生图能力
```

请求主链路：

```text
API
  -> ai.kitchen.service
      -> ai.runtime.AgentRuntime
          -> ai.kitchen.graph
              -> context / tools / prompts / provider / finalize
      -> 持久化 AIAgentRun、AIConversation、AIRecommendation
```

生图主链路：

```text
API
  -> ai.images.jobs
      -> ai.images.generation.ImageGenerationClient
      -> provider 生成图片结果
  -> services.media 保存 MediaAsset 和文件
```

## 分层职责

### `ai/runtime`

`runtime` 是通用 AI 运行层，只能放和业务无关的能力。

当前文件：

- `provider.py`：模型供应商抽象，例如 disabled、OpenAI-compatible。
- `schemas.py`：通用 `AgentRunRequest`、`AgentRunResult`、`AgentToolCall`、`AgentState`。
- `runner.py`：通用 graph 执行器，负责 provider 注入、执行 graph、记录耗时。

约束：

- 不要 import `app.models.domain` 中的具体业务模型。
- 不要依赖 `AiMode`、库存、食材、菜谱、家庭餐食等业务概念。
- 不要写数据库。
- 不要拼业务 prompt。

### `ai/kitchen`

`kitchen` 是 Culina 厨房业务 AI 层。

当前文件：

- `service.py`：厨房 AI 对外入口，负责调用 runtime，并保存 `AIAgentRun`、`AIConversation`、`AIRecommendation`。
- `graph.py`：厨房 agent graph，定义 load context -> tools -> agent -> finalize。
- `context.py`：按家庭加载库存、餐食、食物、食材、推荐候选。
- `tools.py`：厨房只读工具。
- `prompts.py`：普通问答、库存问答、推荐类 prompt。
- `formatters.py`：库存快照、餐食快照、食物上下文等格式化。
- `fallbacks.py`：模型不可用或空响应时的本地兜底。
- `recommendations.py`：推荐候选排序和 `AIRecommendation` 构造。
- `recipe_drafts.py`：AI 菜谱草稿 schema、prompt、JSON 解析、质量校验和生图 payload。

约束：

- 可以依赖业务模型和业务枚举。
- Graph 节点尽量只产出状态，不直接 commit，也不要自行控制事务。
- 数据库写入集中在 `service.py` 或更明确的持久化模块。
- Tools 默认只读；如果未来要加写工具，需要单独设计权限、审计、幂等和回滚策略。

### `ai/images`

`images` 是 AI 生图能力层。

当前文件：

- `generation.py`：生图 prompt、provider、client、`ImageGenerationRequest`、`ImageGenerationResult`。
- `jobs.py`：进程内异步生图任务、状态、结果 claim/finalize。

约束：

- 生图 provider、prompt、请求/结果类型放这里。
- 媒体文件保存、文件删除、`MediaAsset` 落库仍属于 `services/media.py`。
- `jobs.py` 当前是内存队列，生产化前应迁到数据库任务表或队列系统。

## 新增 AI 功能放哪里

新增普通厨房问答模式：

1. 在业务枚举和 schema 中增加模式。
2. 在 `kitchen/context.py` 决定需要加载哪些上下文。
3. 在 `kitchen/tools.py` 增加只读工具或调整 tool 选择。
4. 在 `kitchen/prompts.py` 增加 mode instruction。
5. 在 `kitchen/fallbacks.py` 增加模型不可用时的兜底。
6. 在 `kitchen/graph.py` 的 finalize 里处理特殊输出。
7. 补 `backend/tests/test_ai_agent_infra.py` 测试。

新增结构化生成能力：

1. 优先新建独立业务模块，例如 `kitchen/meal_plan_drafts.py`。
2. 在模块内定义 JSON schema、prompt builder、normalize/validate 函数。
3. Graph 中只调用该模块，不把解析逻辑写在 `graph.py` 里。
4. provider 失败或返回非法 JSON 时要返回明确 `failed` 状态，不要悄悄生成低质量本地假数据。

新增模型供应商：

1. 放在 `ai/runtime/provider.py`。
2. 实现 `BaseChatProvider.generate()`。
3. 返回统一 `ChatProviderResult`。
4. 网络异常要转成 `fallback` 或 `failed`，不要把 provider 原始异常直接冒到 API。
5. 补 provider 单测，使用 fake client，不访问真实网络。

新增生图 provider：

1. 放在 `ai/images/generation.py`。
2. 保持 `ImageGenerationClient` 对外接口稳定。
3. provider 输出统一转换成 `ImageGenerationResult`。
4. 外部 API key、base URL、model 都从 settings 读取。
5. 测试中 patch `app.ai.images.generation.httpx.Client` 或 provider client，不能打真实接口。

## 代码规范

### 依赖方向

允许：

```text
api -> ai.kitchen.service
api -> ai.images.jobs/generation
ai.kitchen -> ai.runtime
ai.kitchen -> app.models/app.services
ai.images -> app.core
```

禁止：

```text
ai.runtime -> ai.kitchen
ai.runtime -> app.models.domain
ai.runtime -> app.services.*
ai.images -> services.media
graph/tools -> commit_session
graph/tools -> db.commit()
```

### Graph 节点规范

- `load_context`：只加载上下文和构造内存态。
- `tools`：只执行只读工具。
- `agent`：只调用 provider。
- `finalize`：只整理输出状态，不提交事务。
- 持久化由 `kitchen/service.py` 完成。

### Prompt 规范

- Prompt builder 放在 `prompts.py` 或具体结构化生成模块。
- Prompt 必须明确数据边界：只能依据传入上下文回答。
- 用户输入只能作为上下文片段进入 prompt，不要拼成系统规则。
- 结构化输出必须有 schema 和 normalize 校验。
- 不要在 API 层拼大段 prompt。

### Tool 规范

- Tool 名称使用稳定 snake_case。
- Tool 输出必须可 JSON 序列化。
- Tool 默认只读，不做写库和文件写入。
- Tool 异常要转换成 `AgentToolCall(status="failed", error=...)`，不能中断整个 graph。
- Tool 输出不要暴露跨家庭数据，所有查询必须带 `family_id`。

### 持久化规范

- `AIAgentRun` 必须记录 prompt、mode、subject、responseFormat、context 摘要、输出、tool calls、status、error、duration。
- conversation 是否持久化由 `AgentRunRequest.persist_conversation` 控制。
- recommendation 等业务模型由 `kitchen/service.py` 统一 `db.add()`。
- API 层负责 `commit_session(db)`。

### 错误处理规范

- provider 不可用：普通问答可以 `fallback`，结构化生成应返回 `failed`。
- 空响应：普通问答进入 fallback；结构化生成 failed。
- 非法 JSON：结构化生成 failed，并记录明确 error。
- 工具失败：记录 tool call failed，graph 继续执行。
- 数据库提交失败：由 API 的 `commit_session()` rollback。

## 测试要求

每个新增 AI 功能至少覆盖：

- provider disabled/fallback 路径。
- provider 正常返回路径。
- 工具或上下文的家庭隔离。
- `AIAgentRun` 是否记录关键字段。
- API 响应 shape 是否保持稳定。

结构化生成额外覆盖：

- fenced JSON。
- JSON 前后有解释文本。
- 非法 JSON。
- 低质量内容拒绝。
- 跨家庭资源 ID 被过滤。

生图额外覆盖：

- text/reference 两种模式。
- provider endpoint、key、model、size 标准化。
- 伪造或缺失 reference media。
- 同一个 job 重复轮询不重复落库。

运行命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py backend/tests/test_media_security.py -q
backend/.venv/bin/python -m pytest -q
npm --prefix frontend run test
npm --prefix frontend run build
```

## 当前已知后续优化

- `ai/images/jobs.py` 仍是进程内队列，生产环境建议迁到数据库任务表或队列系统。
- 登录限流、AI 调用限流和成本控制还未统一建设。
- `runtime` 目前保持轻量，没有做 agent registry；等出现第二个非 kitchen agent 后再评估。
- 旧 PBKDF2 兼容测试会触发 `passlib` 的 Python 3.13 弃用警告，等存量 hash 迁移后可移除 legacy 验证。
