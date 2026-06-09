# Culina 大模型 Skill 机制规范

## 1. 文档定位

本文档定义 Culina AI 工作台后续重构后的 Skill 机制。

重构目标是把大模型能力拆成多个可维护、可路由、可控制的任务能力包，同时让当前系统已有的 Planner、ToolExecutor、LangGraph HITL、审批落库和前后端协议可以平滑迁移到新的 Skill 文件结构。

本文档中的 Skill 目录结构以重构目标为准，不以当前 `backend/app/ai/skills/catalog/*/manifest.json` 与 skill 目录下 `skill.py` 的实现为准。当前实现中已有这些文件，但它们不是新规范推荐结构。

---

## 2. 设计目标

Culina 的 Skill 机制用于解决三类问题：

1. 让大模型任务边界可见：每个 Skill 明确适用场景、禁用场景、可用工具和输出约束。
2. 让业务写入可控：AI 只生成建议、卡片、草稿和确认请求，正式写入必须经过用户确认。
3. 让系统可演进：Planner 负责选择 Skill，Runtime 负责加载 Skill 文档与权限控制，Tool 负责确定性业务能力，Service 负责最终写入。

重构后的核心原则：

- `SKILL.md` 是 Skill 入口，也是机器可读元数据真源。
- Skill 不承载业务代码，不直接读写数据库，不直接调用业务接口。
- Skill 目录下不放 `manifest.json`，也不放每个 Skill 独立的 `skill.py`。
- Tool 统一在后端工具目录注册，Skill 只能声明自己允许使用哪些工具。
- 复杂流程拆到 `workflows.md`，确认规则拆到 `hitl.md`，示例拆到 `examples.md`。
- `scripts/` 只放纯计算、校验、格式转换脚本，不接触业务数据。
- 所有影响正式业务数据的操作遵循 `draft -> approval -> commit`。

---

## 3. 当前系统基础

Culina 当前 AI 架构已经具备以下基础，重构 Skill 时应复用这些能力。

### 3.1 API 层

AI 入口位于：

```text
backend/app/api/ai.py
```

主要接口：

```text
GET  /api/ai/registry
POST /api/ai/chat
POST /api/ai/chat/stream
GET  /api/ai/conversations/{conversation_id}/approvals/pending
POST /api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision
```

对前端公开的主要 DTO 位于：

```text
backend/app/schemas/ai.py
```

当前前端 API 契约不是直接暴露内部 `SkillExecutionResult`，而是：

```text
AIChatResponse
AIMessageDTO
AIMessagePartDTO
AIResultCardDTO
AITaskDraftDTO
AIApprovalRequestDTO
AIRunDTO
AIRunEventDTO
AIApprovalDecisionResponse
```

### 3.2 Planner

当前 Planner 位于：

```text
backend/app/ai/planning/planner.py
```

`WorkspacePlanner` 当前职责很窄：

- 根据完整对话和可用 Skill 摘要，选择零个、一个或多个 Skill。
- 返回有序 Skill key 列表。
- 不抽取参数。
- 不判断 create、modify、derive 的具体业务操作。
- 不提交草稿。
- 不执行工具。
- 不写正式业务数据。

这个职责边界应保留。重构后的 Skill 规范不应把 Planner 变成业务解析器。

### 3.3 LangGraph 执行链路

当前工作台执行器位于：

```text
backend/app/ai/workflows/runner.py
```

当前 LangGraph 主流程：

```text
initialize
  -> planner
  -> general_chat 或 skill_step
  -> finalize
```

其中：

- `initialize` 创建用户消息和 `AIAgentRun`。
- `planner` 调用 `WorkspacePlanner` 选择 Skill。
- `general_chat` 处理无需 Skill 的普通回答。
- `skill_step` 逐个执行 Planner 选出的 Skill，并处理审批中断。
- `finalize` 生成最终响应。

重构后可以继续沿用这条主链路，但 `skill_step` 应从新的 `SKILL.md` 结构加载 Skill 元信息与指令，而不是依赖每个 Skill 自带 `manifest.json` 或 `skill.py`。

### 3.4 Tool 系统

当前工具系统位于：

```text
backend/app/ai/tools/
backend/app/ai/tools/catalog/
```

核心类型：

```text
ToolDefinition
ToolContext
ToolExecutor
ToolSideEffect = read | draft | write
```

当前工具注册入口：

```text
backend/app/ai/tools/registry.py
```

现有工具包括：

```text
intent.request_clarification
inventory.read_summary
inventory.read_expiring_items
inventory.read_available_items
ingredient.search
food.search
food_profile.create_draft
recipe.search
recipe.create_draft
meal_log.read_recent
meal_log.create_draft
meal_plan.read_existing
meal_plan.create_draft
shopping.read_pending
shopping.create_draft
shopping_list.create_draft
```

重构后 Tool 仍由后端统一注册，Skill 只声明 `allowed_tools` 和 `forbidden_tools`。

### 3.5 审批与正式写入

当前审批与正式写入位于：

```text
backend/app/ai/workspace_service.py
```

关键模型位于：

```text
backend/app/models/domain.py
```

相关表模型：

```text
AITaskDraft
AIApprovalRequest
AIUserApproval
AIOperation
AIGraphCheckpoint
AIGraphWrite
```

当前流程：

```text
SkillResult.drafts
  -> AIApplicationService._create_draft_approval
  -> AITaskDraft + AIApprovalRequest
  -> LangGraph interrupt
  -> 用户提交 approval decision
  -> AIApplicationService._apply_approval_decision
  -> 后端 service 写正式业务数据
  -> AIOperation 记录结果
```

这个机制已经符合 `draft -> approval -> commit`，重构 Skill 时应继续使用。

---

## 4. 核心概念

### 4.1 Skill

Skill 是任务能力包，负责描述某一类任务应该如何处理。

Skill 负责：

- 描述适用场景。
- 描述不适用场景。
- 声明可用工具。
- 声明禁止工具。
- 规定工具使用条件。
- 规定推荐 workflow。
- 规定 human-in-the-loop 规则。
- 规定输出类型和草稿类型。
- 提供示例。

Skill 不负责：

- 直接查数据库。
- 直接写数据库。
- 直接调用业务 service。
- 直接提交正式数据。
- 替代 Tool。
- 替代 Planner。
- 替代审批系统。

### 4.2 Tool

Tool 是确定性能力函数，由后端注册。

Tool 负责：

- 查询库存、菜谱、食物、餐食记录等上下文。
- 校验草稿输入。
- 生成草稿级输出。
- 在用户确认后，由后端 service 执行正式写入。

Tool 不负责：

- 判断整体用户意图。
- 路由到哪个 Skill。
- 自己决定是否绕过确认。
- 在未授权 Skill 下执行。

### 4.3 Workflow

Workflow 是某个 Skill 下的具体执行流程说明。

Workflow 不是业务代码，而是给模型和 runtime 使用的任务剧本。

它规定：

- 常规流程。
- 简化流程。
- 分支流程。
- 强制步骤。
- 中断条件。
- 需要用户确认的节点。

### 4.4 Human-in-the-loop

Human-in-the-loop 是用户确认机制。

所有会改变正式业务数据的操作，都必须遵循：

```text
draft -> approval -> commit
```

AI 可以生成草稿和确认请求，但不能直接提交高风险写操作。

---

## 5. 目标目录结构

重构后的 Skill 目录结构以 `SKILL.md` 为中心：

```text
backend/app/ai/skills/
  inventory-analysis/
    SKILL.md
    workflows.md
    examples.md

  meal-planning/
    SKILL.md
    workflows.md
    hitl.md
    examples.md
    scripts/
      validate_meal_plan.py
      render_plan_preview.py

  shopping-list/
    SKILL.md
    workflows.md
    hitl.md
    examples.md
    scripts/
      merge_ingredients.py
      normalize_ingredient.py

  meal-record/
    SKILL.md
    workflows.md
    hitl.md
    examples.md
```

规范要求：

- 每个 Skill 必须有 `SKILL.md`。
- 不使用 `manifest.json`。
- 不在 Skill 目录下放业务执行用的 `skill.py`。
- 复杂流程可拆 `workflows.md`。
- 用户确认规则可拆 `hitl.md`。
- 示例可拆 `examples.md`。
- 确定性纯计算可放 `scripts/`。

当前系统中已有 `backend/app/ai/skills/catalog/<skill_key>/manifest.json` 和部分 `skill.py`，这是现状实现，不是本规范的目标结构。重构时应迁移为上面的结构。

---

## 6. `SKILL.md` 标准格式

`SKILL.md` 由 YAML frontmatter 和 Markdown 正文组成。

frontmatter 是机器可读元数据真源，正文是给模型和维护者看的行为说明。

### 6.1 Frontmatter 字段

```yaml
---
name: meal-planning
display_name: 餐食规划
version: 1.0.0
description: 当用户想安排餐食、制定菜单、根据库存推荐吃什么、生成未来几天饮食计划时使用。
category: planning
runner: meal_plan
risk_level: medium
allowed_tools:
  - inventory.read_available_items
  - inventory.read_expiring_items
  - meal_log.read_recent
  - food.search
  - recipe.search
  - meal_plan.read_existing
  - meal_plan.create_draft
forbidden_tools:
  - meal_plan.commit
  - shopping_list.commit
  - inventory.consume
requires_confirmation:
  - meal_plan.create
  - meal_plan.update
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files:
  - scripts/validate_meal_plan.py
output_contract: SkillExecutionResult
output_types:
  - meal_plan_draft
draft_types:
  - meal_plan
can_continue_from:
  - meal_plan
intent: meal_plan
agent_key: meal_plan_agent
---
```

字段说明：

- `name`：Skill 唯一名，使用 kebab-case，例如 `meal-planning`。
- `display_name`：面向用户和日志的中文名。
- `version`：Skill 文档版本。
- `description`：给 Planner 使用的摘要。
- `category`：能力分类，例如 `planning`、`inventory`、`recording`。
- `runner`：后端 Skill runtime 名称，例如 `markdown`、`meal_plan`。普通聊天不注册 Skill，仍由 Planner 返回空 Skill 后进入 `general_chat` 分支。
- `risk_level`：`low`、`medium`、`high`。
- `allowed_tools`：当前 Skill 允许调用的工具。
- `forbidden_tools`：即使全局存在也禁止调用的工具。
- `requires_confirmation`：需要用户确认的业务动作。
- `workflow_files`：按需加载的 workflow 文档。
- `hitl_files`：按需加载的确认规则文档。
- `example_files`：示例文档。
- `script_files`：纯计算脚本。
- `output_contract`：内部聚合结果结构，默认 `SkillExecutionResult`。
- `output_types`：可能返回的卡片或结果类型。
- `draft_types`：可能生成的草稿类型。
- `can_continue_from`：可基于哪些已有草稿继续。
- `intent`：写入 `AIAgentRun.intent` 的业务意图。
- `agent_key`：写入 `AIAgentRun.agent_key` 的执行器标识。

### 6.2 正文结构

推荐正文结构：

```markdown
# 餐食规划 Skill

## 目标

## 适用场景

## 不适用场景

## 可用工具

## 工具使用规则

## 执行策略

## Human-in-the-loop 规则

## 输出格式

## 示例
```

正文要求：

- 说明任务边界，不写业务实现代码。
- 写清楚工具什么时候能用，什么时候不能用。
- 写清楚是否需要生成草稿。
- 写清楚哪些情况要追问。
- 写清楚输出必须可被后端结构化处理。

---

## 7. 为什么需要 `workflows.md`

`SKILL.md` 是入口，应保持简洁。

当一个 Skill 内有多个流程时，应该拆出 `workflows.md`。

适合拆 `workflows.md` 的情况：

- `SKILL.md` 超过 200-300 行。
- 一个 Skill 内有 3 个以上流程。
- 流程有明显分支。
- 流程经常调整。
- 多个开发者协作维护。

例如 `meal-planning` 可能有：

```text
简单推荐流程
正式餐食计划流程
修改已有计划流程
带购物清单流程
临期食材优先消耗流程
异常处理流程
```

这些内容不应全部塞进 `SKILL.md`。

---

## 8. Skill 脚本规范

Skill 下可以有脚本，但脚本只做纯计算、校验、格式转换。

适合放到 `scripts/` 的能力：

- 合并购物清单。
- 食材名称归一。
- 单位换算。
- JSON 结构校验。
- 餐食计划格式校验。
- 草稿预览渲染。
- 菜谱解析。
- 去重、排序、分组。

不允许脚本做：

- 直接查数据库。
- 直接写数据库。
- 直接删除数据。
- 直接调用业务接口。
- 直接 commit 正式数据。
- 绕过 approval 机制。

区分：

```text
Skill 文档：告诉 AI 怎么做
Skill script：帮 AI 做稳定的小计算
Tool：帮 AI 调用系统能力
Runtime：控制加载、权限、流程和审批
Service：执行最终业务写入
```

Runtime 会加载 `script_files` 的内容作为确定性辅助参考，但脚本不得直接读写业务数据，也不得绕过 Tool 和审批机制。

---

## 9. Runtime 重构目标

当前系统的 `SkillDirectoryLoader` 从 `manifest.json` 加载 Skill，并可选加载 skill 目录下 `skill.py`。

重构目标：

- `SkillDirectoryLoader` 扫描 `backend/app/ai/skills/*/SKILL.md`。
- 从 `SKILL.md` YAML frontmatter 构建 Skill 元数据。
- 按需加载 `workflows.md`、`hitl.md`、`examples.md`。
- 按需加载 `script_files`，作为只读辅助参考。
- 不加载每个 Skill 自带的业务执行 `skill.py`。
- Skill 执行交给统一 runner 或统一 SkillRuntime。
- Runtime 按 Skill 声明的 `allowed_tools` 过滤工具。
- Runtime 按 `risk_level`、`requires_confirmation` 和 Tool side effect 强制执行确认策略。

推荐执行链路：

```text
用户输入
  -> WorkspaceGraphRunner.initialize
  -> WorkspacePlanner 选择 Skill 列表
  -> SkillRuntime 加载 SKILL.md 与必要附加文档
  -> ToolExecutor 按 allowed_tools 和 side effect 建立作用域
  -> 模型基于 Skill 文档、上下文、工具结果生成 SkillExecutionResult
  -> Runtime 校验结果
  -> 如有 draft，创建 AITaskDraft + AIApprovalRequest
  -> LangGraph interrupt 等待确认
  -> 用户确认后 AIApplicationService._apply_approval_decision
  -> Service 写正式业务数据并记录 AIOperation
  -> API 返回 AIChatResponse
```

---

## 10. Tool 规范

### 10.1 Tool 注册位置

Tool 仍注册在：

```text
backend/app/ai/tools/catalog/
```

工具注册入口：

```text
backend/app/ai/tools/registry.py
```

### 10.2 ToolDefinition

当前 Tool 应继续使用 `ToolDefinition`：

```python
ToolSideEffect = Literal["read", "draft", "write"]

@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    permission: str
    side_effect: ToolSideEffect
    handler: ToolHandler
    requires_confirmation: bool = False
```

### 10.3 Side effect 规则

`read`：

- 可读取家庭范围内的上下文。
- 不写业务表。
- 例如 `inventory.read_available_items`、`recipe.search`。

`draft`：

- 可生成草稿级输出。
- 不写正式业务表。
- 例如 `meal_plan.create_draft`、`shopping.create_draft`。

`write`：

- 会写正式业务数据。
- 不暴露给模型。
- 只能在用户确认后由后端 service 执行。

### 10.4 Tool 权限控制

Runtime 必须双重检查：

1. 工具名必须在当前 Skill 的 `allowed_tools` 中。
2. 工具 side effect 必须被当前 Skill 风险策略允许。
3. 工具名不能在当前 Skill 的 `forbidden_tools` 中，即使误写进 `allowed_tools` 也必须拒绝。
4. 返回草稿的 Skill 必须声明 `approval_policy=draft_then_confirm`、`draft_types` 和 `requires_confirmation`。

例如：

```text
risk_level=low
  -> 只允许 read

risk_level=medium 且需要草稿
  -> 允许 read + draft

write
  -> 不暴露给模型，只能由审批通过后的后端流程调用
```

不能只依赖 Prompt 约束工具权限。

当前实现中：

- `SkillDirectoryLoader` 会校验 `risk_level`、`approval_policy`、`allowed_tools` 与 `forbidden_tools` 冲突。
- `SkillExecutor` 会在执行前再次校验 Skill manifest 与工具 side effect。
- `ToolExecutor` 会在每次调用时检查 `allowed_tools`、`forbidden_tools` 和 `allowed_side_effects`。
- `SkillExecutor` 会在执行后校验 `SkillResult.drafts` 是否属于当前 Skill 声明的 `draft_types`。

### 10.5 Context Policy

`context_policy` 是 Skill 声明式读取上下文的入口。

当前映射：

```text
inventory   -> inventory.read_summary, inventory.read_expiring_items, inventory.read_available_items
meal_logs   -> meal_log.read_recent
foods       -> food.search
recipes     -> recipe.search
meal_plan   -> meal_plan.read_existing
shopping    -> shopping.read_pending
ingredients -> ingredient.search
artifacts   -> conversation.artifacts
```

`artifacts` 不走 Tool Registry，而是由 runtime 从当前对话、当前 run 内产物和已执行 Skill 结果中整理为只读上下文。

### 10.6 RunArtifact

Runtime 会把 Skill 输出的草稿和结果卡片规范化为 run 内 artifact，供后续 Skill 只读引用。

RunArtifact 是内部上下文结构，不是前端 API 契约。

```python
{
    "id": "in_run:meal_plan:meal_plan:1",
    "type": "meal_plan",
    "kind": "draft",
    "version": 1,
    "status": "proposed",
    "payload": {...},
    "schemaVersion": "meal_plan.v1",
    "sourceSkill": "meal_plan",
}
```

合并顺序：

```text
conversation artifacts
  -> current_run_artifacts
  -> previous_results 兼容路径
```

规则：

- 下游 Skill 可以只读引用 `status=proposed` 的 run 内 artifact。
- run 内 artifact 不代表正式写入，也不代表用户已确认。
- 任何正式写入仍必须走 `AITaskDraft -> AIApprovalRequest -> AIOperation`。
- 如果下游草稿来自 run 内 artifact，应在 payload source 中保留来源 id，例如 `sourceDraftId=in_run:meal_plan:meal_plan:1`。

---

## 11. Planner 规范

Planner 继续保持当前系统的窄职责。

Planner 输入：

- 最近对话。
- 当前用户消息。
- 可用 Skill 摘要。
- 已有草稿 artifacts。

Planner 输出：

```json
{
  "skills": ["meal-planning", "shopping-list"]
}
```

Planner 不做：

- 不抽业务字段。
- 不生成草稿。
- 不调用 Tool。
- 不判断审批。
- 不写数据库。
- 不替代 Skill 内部 workflow。

普通聊天、做饭技巧、能力介绍、无需工具或草稿的回答，应返回空 Skill 列表，由 `general_chat` 处理。

---

## 12. SkillExecutionResult

`SkillExecutionResult` 是后端内部聚合结果，不是前端直接 API 契约。

建议结构：

```python
@dataclass(slots=True)
class SkillExecutionResult:
    text: str
    cards: list[dict]
    drafts: list[dict]
    events: list[dict]
    tool_calls: list[dict]
    context_summary: dict
    state_patch: dict
    status: str
    model: str
    error: str | None = None
```

其中：

- `text`：给用户看的自然语言回复。
- `cards`：结果卡片，例如今日推荐、库存概览。
- `drafts`：待确认草稿 payload，不直接写业务数据。
- `events`：运行事件。
- `tool_calls`：工具调用记录。
- `context_summary`：运行上下文摘要，写入 `AIAgentRun.context_summary`。
- `state_patch`：对 conversation context 的任务状态补丁。
- `status`：`completed`、`failed`、`waiting_approval` 等。
- `model`：模型名。
- `error`：失败原因。

API 层应把内部结果转换为：

```text
AIChatResponse
AIMessageDTO
AIMessagePartDTO
AITaskDraftDTO
AIApprovalRequestDTO
AIRunDTO
AIRunEventDTO
```

---

## 13. Human-in-the-loop 机制

### 13.1 基本原则

AI 只能生成：

```text
建议
结果卡片
草稿
确认请求
```

AI 不能直接执行：

```text
正式创建
正式修改
正式删除
库存扣减
偏好修改
```

### 13.2 当前系统流程

当前系统已经使用以下流程：

```text
SkillResult.drafts
  -> _create_draft_approval
  -> AITaskDraft
  -> AIApprovalRequest
  -> message.parts 添加 draft 和 approval_request
  -> LangGraph interrupt
  -> 用户提交 decision
  -> _apply_approval_decision
  -> _execute_draft_operation
  -> AIOperation
```

这条流程应作为重构后的 HITL 基线。

### 13.3 用户确认后不要再让 AI 判断

用户点击确认后，后端应直接执行：

```text
approval_id
  -> 校验 family_id、conversation_id
  -> 校验 approval 状态
  -> 校验 draft 状态
  -> 校验 draft_version
  -> 校验提交 values
  -> 执行业务 service 写入
  -> 写入 AIOperation
  -> 返回结果
```

不要再把“用户确认了什么”交给大模型重新理解。

---

## 14. Draft / Commit 两阶段机制

### 14.1 Draft

Skill 可以通过 draft tool 生成草稿。

例如：

```text
recipe.create_draft
meal_plan.create_draft
shopping.create_draft
shopping_list.create_draft
meal_log.create_draft
food_profile.create_draft
```

Draft tool 只能校验和返回草稿级结果，不写正式业务数据。

### 14.2 Approval

后端根据 `draft_type` 创建确认请求。

当前支持的草稿类型包括：

```text
recipe
shopping_list
meal_plan
meal_log
food_profile
```

确认请求包含：

- `approval_type`
- `draft_id`
- `draft_version`
- `field_schema`
- `initial_values`
- `approve_label`
- `reject_label`

### 14.3 Commit

Commit 不暴露给模型。

正式写入由 `AIApplicationService._apply_approval_decision` 触发，并委托后端 service 或 ORM 流程执行。

写入结果必须记录到 `AIOperation`。

---

## 15. Workflow 设计原则

### 15.1 不要完全让 AI 自由发挥

不建议只写：

```text
你可以使用库存工具、菜谱工具和购物清单工具，请自行完成任务。
```

这样容易出现：

- 漏查库存。
- 漏生成草稿。
- 顺序混乱。
- 提前写入。
- 输出不稳定。

### 15.2 也不要完全写死流程

用户只是问：

```text
鸡蛋快过期了今晚吃啥？
```

这时不需要完整跑餐食计划和购物清单流程。

### 15.3 推荐方式

采用：

```text
强制步骤 + 推荐步骤 + AI 自主判断
```

强制步骤：

- 涉及写入必须生成草稿。
- 涉及删除必须确认。
- 涉及库存扣减必须确认。
- 用户未确认不得 commit。

推荐步骤：

- 餐食规划通常先查库存、临期、最近餐食，再查食物和菜谱。
- 购物清单通常先读取已有待采购项和当前库存，再合并缺口。

AI 自主判断：

- 是否需要追问。
- 是否需要生成草稿。
- 是否只返回建议。
- 推荐几个选项。

---

## 16. Meal Planning 示例

目录：

```text
backend/app/ai/skills/meal-planning/
  SKILL.md
  workflows.md
  hitl.md
  examples.md
  scripts/
    validate_meal_plan.py
    render_plan_preview.py
```

`SKILL.md` 示例：

```markdown
---
name: meal-planning
display_name: 餐食规划
version: 1.0.0
description: 基于库存、最近餐食和已有菜谱生成或修改可编辑餐食计划草稿。
category: planning
risk_level: medium
allowed_tools:
  - inventory.read_expiring_items
  - inventory.read_available_items
  - meal_log.read_recent
  - food.search
  - recipe.search
  - meal_plan.read_existing
  - meal_plan.create_draft
forbidden_tools:
  - meal_plan.commit
  - inventory.consume
requires_confirmation:
  - meal_plan.create
  - meal_plan.update
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files:
  - scripts/validate_meal_plan.py
output_contract: SkillExecutionResult
output_types:
  - meal_plan_draft
draft_types:
  - meal_plan
can_continue_from:
  - meal_plan
intent: meal_plan
agent_key: meal_plan_agent
---

# 餐食规划 Skill

## 目标

根据家庭库存、临期食材、最近餐食、已有食物和菜谱，生成可执行的餐食建议或可确认的餐食计划草稿。

## 适用场景

- 今晚吃什么
- 帮我安排明天晚餐
- 帮我做三天菜单
- 根据冰箱里的东西推荐菜
- 修改刚才的餐食计划

## 不适用场景

- 用户只是问库存状态，应使用 inventory-analysis。
- 用户只是问某道菜怎么做，通常由 Planner 返回空 Skill 进入普通聊天；需要结构化草稿时走 recipe-draft。
- 用户只是记录吃过的东西，应使用 meal-record。

## 工具使用规则

- 生成计划前应读取当前可用库存和临期食材。
- 修改计划时必须引用真实存在的 meal_plan 草稿 artifact。
- 只允许调用 meal_plan.create_draft 生成草稿。
- 不得写正式 FoodPlanItem。

## Human-in-the-loop 规则

创建或修改正式餐食计划必须生成草稿并等待用户确认。

## 输出格式

必须返回 SkillExecutionResult。若生成草稿，draft_type 必须是 meal_plan。
```

`workflows.md` 示例：

```markdown
# 餐食规划 Workflow

## 简单推荐流程

适用于“今晚吃什么”“现有食材能做什么”。

1. 读取可用库存。
2. 读取临期食材。
3. 结合最近餐食避免重复。
4. 返回 2-3 个建议。
5. 不生成草稿。

## 正式计划流程

适用于“安排明天晚餐”“做三天菜单”。

1. 读取库存、临期、最近餐食、食物和菜谱。
2. 生成完整 meal_plan 草稿。
3. 校验草稿结构。
4. 调用 meal_plan.create_draft。
5. 返回待确认草稿。

## 修改已有计划流程

1. 从 conversation artifacts 找到 meal_plan 草稿。
2. 校验用户要修改的是该草稿。
3. 生成完整替换版草稿，不返回 diff。
4. 返回新的待确认草稿。
```

---

## 17. Shopping List 示例

目录：

```text
backend/app/ai/skills/shopping-list/
  SKILL.md
  workflows.md
  hitl.md
  examples.md
  scripts/
    merge_ingredients.py
    normalize_ingredient.py
```

规则要点：

- 可从 meal_plan 草稿派生购物清单。
- 可读取待采购项和当前库存。
- 必须合并重复项。
- 必须标注来源餐食或原因。
- 只能生成 shopping_list 草稿。
- 不得直接写 `ShoppingListItem`。

---

## 18. 第一阶段重构范围

第一阶段建议重构：

```text
1. SkillDirectoryLoader：从 SKILL.md frontmatter 加载元数据。
2. SkillRegistry：注册新的文档型 Skill。
3. SkillRuntime：统一加载 SKILL.md / workflows.md / hitl.md。
4. SkillExecutor：继续负责按 Skill 执行，但不依赖 skill.py。
5. ToolExecutor：保留当前 allowed_tools + side_effect 强制过滤。
6. WorkspacePlanner：继续只选择 Skill 列表。
7. HITL：复用当前 AITaskDraft / AIApprovalRequest / interrupt / AIOperation。
```

第一阶段 Skill：

```text
inventory-analysis
today-recommendation
recipe-draft
meal-planning
shopping-list
meal-record
food-profile
```

命名迁移建议：

```text
today_recommendation -> today-recommendation
inventory_analysis -> inventory-analysis
recipe_draft -> recipe-draft
meal_plan -> meal-planning
shopping_list -> shopping-list
meal_log -> meal-record
food_profile -> food-profile
```

---

## 19. 测试与验收

文档级验收：

- `SKILL.md` 被明确为 Skill 入口和元数据真源。
- `manifest.json` 不再作为目标结构。
- skill 目录下业务 `skill.py` 不再作为目标结构。
- Planner 职责被限制为选择 Skill 列表。
- Tool 权限基于 `allowed_tools` 和 side effect。
- HITL 明确复用当前 `AITaskDraft`、`AIApprovalRequest`、LangGraph `interrupt`、`AIOperation`。
- API 契约明确为 `AIChatResponse` 等 DTO，而不是直接暴露内部结果。

后续代码重构验收：

- 新 loader 能从 `SKILL.md` frontmatter 加载 Skill。
- 无 `manifest.json` 也能启动 registry。
- 无 skill 目录下 `skill.py` 也能执行文档型 Skill。
- 未声明工具无法调用。
- `write` side effect 不会暴露给模型。
- 草稿必须生成 approval。
- 用户确认后不再调用模型判断，直接执行后端写入流程。

---

## 20. 关键原则总结

1. Skill 是任务能力包，不是普通 Prompt。
2. `SKILL.md` 是入口，也是元数据真源。
3. Skill 不放 `manifest.json`。
4. Skill 不放业务执行用 `skill.py`。
5. Tool 是确定性系统能力，不是 workflow。
6. Workflow 是任务剧本，不是业务代码。
7. Script 只做纯计算、校验和格式转换。
8. 所有业务读写必须走 Tool 或 Service。
9. Runtime 必须强制工具权限和 side effect 权限。
10. Commit 类能力不暴露给模型。
11. 写操作必须 `draft -> approval -> commit`。
12. 用户确认后由后端执行写入，不再让模型重新判断。
13. Planner 只选择 Skill，不承担业务抽参和写入。
14. API 对外返回当前系统 DTO，内部结果可继续使用 `SkillExecutionResult`。

一句话总结：

Culina 的 Skill 应该是一个由 `SKILL.md` 驱动的受控任务剧本。Planner 只负责选择剧本，Runtime 负责加载剧本和限制工具，Tool 负责确定性能力，HITL 负责拦截所有正式写入，Service 负责最终 commit。
