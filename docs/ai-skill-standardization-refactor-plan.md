# Culina Skill 标准化与主智能体改造方案

更新时间：2026-06-18

本文档记录 Culina AI 工作台向主流 Agent Skill / Codex Skill 形态靠拢的改造方案。目标不是把 AI 助手改成不受约束的自由代理，而是把 Skill 作者体验和包结构标准化，同时保留 Culina 现有的家庭数据隔离、工具白名单、草稿审批和正式写入边界。

## 1. 背景与目标

当前 Culina AI 工作台的核心链路是：

```text
用户消息
  -> WorkspacePlanner 输出 skills[]
  -> WorkspaceGraphRunner 顺序执行 SkillExecutor
  -> ToolCallingSkill 加载 SKILL.md 并调用 scoped tools
  -> draft -> approval -> commit
```

这套机制已经具备可控运行时，但 Skill 心智仍偏向后端内部 catalog 配置：`SKILL.md` frontmatter 同时承载通用说明和 Culina 专属运行时字段，例如 `allowed_tools`、`draft_types`、`approval_policy`、`output_types`。这会让 Skill 与 Codex / Agent Skills 等主流能力包规范不够一致，也不利于后续复用、审计和迁移。

改造目标：

- 将 Skill 作者体验调整为标准能力包：`SKILL.md` 负责通用元数据和能力说明，运行时扩展放到独立配置。
- 引入 LangGraph 主智能体 orchestrator，让主智能体按 action loop 决定直接回答、调用 Skill、追问或结束。
- 保留 Culina 安全运行时：模型默认不能获得未注入 Skill 的工具，不能接触 `write` tool，正式写入仍必须经过 `draft -> approval -> commit`。
- 保持后端运行时真源不变：`backend/app/ai/skills/catalog` 继续作为产品内 Skill catalog。

不采用的方向：

- 不把主智能体做成脱离 LangGraph 的普通 while-loop。
- 不在会话开始时无差别注入全部 Skill instructions 和全部 tools；Skill 必须由 orchestrator 按需注入。
- 不取消 scoped ToolExecutor、draft tool 校验、approval interrupt 或 service 层正式写入。

## 2. 目标架构

目标形态是“标准能力包 + Culina 安全运行时”：

```text
LangGraph WorkspaceGraphRunner
  -> orchestrator 主智能体节点
    -> direct_answer
    -> inject_skill(skill_key)
    -> tool_call
    -> human.request_input
    -> finalize

inject_skill
  -> 将 Skill 的 SKILL.md instructions / references 注入当前 run 上下文
  -> 将 skill.yaml runtime contract 合并进当前 run 的允许能力集合
  -> Skill 注入后本次 run 内持续可见，不自动卸载

tool_call
  -> orchestrator 在同一个模型工具循环中直接调用基础 tools 和已注入 Skill 暴露的 tools/scripts
  -> runtime 根据基础 tool contract 和所有 injected skills 的 contract 校验工具、草稿、卡片和审批策略

human input
  -> orchestrator 调用通用 human.request_input 工具
  -> LangGraph interrupt 暂停会话
  -> 用户选择选项或输入文本
  -> human.input_result artifact 回到 orchestrator

draft approval
  -> LangGraph interrupt
  -> 用户确认
  -> services/ai_operations 执行正式写入
  -> approval result artifact 回到 orchestrator
```

Skill 包结构 v2：

```text
backend/app/ai/skills/catalog/<skill-slug>/
  SKILL.md
  skill.yaml
  scripts/
  references/
```

`SKILL.md` 只保留主流 Agent Skill 入口字段：

```yaml
---
name: meal-planning
description: 处理“今天/今晚吃什么”的即时餐食推荐，以及未来或指定日期餐食计划的创建、修改、删除和状态变更；不记录已吃餐食、不执行做菜扣库存、不生成购物清单或菜谱正文。
---
```

`skill.yaml` 是 Culina runtime contract：

```yaml
version: 2
key: meal_plan
display_name: 餐食计划
intent: meal_plan
agent_key: meal_plan_agent
context_policy:
  - inventory
  - meal_logs
  - foods
  - recipes
  - meal_plan
allowed_tools:
  - inventory.read_expiring_items
  - inventory.read_available_items
  - meal_plan.create_draft
script_files:
  - scripts/expand_meal_slots.py
output_types:
  - today_recommendation
draft_types:
  - meal_plan
approval_policy: draft_then_confirm
examples:
  - 今晚吃什么？
  - 安排三天晚餐。
```

字段边界：

- `SKILL.md`：通用 skill 名称、description、正文 instructions、适用范围、决策边界、执行建议。
- `skill.yaml`：Culina 运行时可验证字段，包括 key、工具白名单、脚本、输出卡片、草稿类型、审批策略、intent 和 agent key。
- `references/`：较长的流程、例子、领域说明或评估样例。现有 `workflows.md` 可迁移为 `references/workflows.md`。
- `scripts/`：继续存放只读纯计算脚本，由运行时校验并以 `script.*` 暴露。

注入语义：

- Skill 是上下文和能力注入包，不是独立子 agent。
- 同一个 run 可以注入多个 Skill。
- Skill 注入后持续生效，直到 run 结束或上下文压缩重新构建；不提供常规“取消注入”动作。
- orchestrator 在同一个 agent loop 中统一推理、统一调用工具、统一组织用户回复。
- 可用工具是所有 injected skills 声明工具的并集，但 `write` tool 仍不暴露，正式写入仍由 approval service 执行。
- `human.request_input` 是 orchestrator 基础工具，不属于任何单个 Skill 的 `allowed_tools`；主 agent 可以在未注入 Skill 或已注入多个 Skill 时随时调用它来补齐信息。

## 3. 改造细节

### 3.1 Skill 包格式 v2

新增 `skill.yaml` 后，loader 应按以下优先级读取：

1. 如果目录内存在 `skill.yaml`，按 v2 加载。
2. 如果不存在 `skill.yaml`，短期兼容旧版 `SKILL.md` frontmatter。
3. 内置 catalog 必须全部迁移到 v2；旧版兼容只服务灰度和测试 fixture。

`SKILL.md` frontmatter 标准化后，不再放 Culina runtime 字段：

- 不放 `allowed_tools`
- 不放 `script_files`
- 不放 `output_types`
- 不放 `draft_types`
- 不放 `approval_policy`
- 不放 `intent`
- 不放 `agent_key`

这些字段统一放入 `skill.yaml`，并由 loader 做强校验。

### 3.2 Loader / Registry 改造

Loader 需要拆分两类数据：

- Authoring metadata：来自 `SKILL.md`，用于通用 skill 展示和正文注入。
- Runtime contract：来自 `skill.yaml`，用于 Culina 运行时约束。

建议新增 `SkillCatalogRecord`，供 orchestrator 做 progressive disclosure：

```json
{
  "key": "meal_plan",
  "name": "meal-planning",
  "displayName": "餐食计划",
  "description": "...",
  "examples": ["今晚吃什么？"],
  "contextPolicy": ["inventory", "meal_logs"],
  "outputTypes": ["today_recommendation"],
  "draftTypes": ["meal_plan"],
  "approvalPolicy": "draft_then_confirm",
  "skillPath": "backend/app/ai/skills/catalog/meal-planning/SKILL.md"
}
```

保留现有 `SkillManifest` 的稳定运行时字段，避免一次性改动过大。`to_planner_record()` 可先保留为兼容方法，但内部应转向新的 catalog record 生成逻辑。

loader 校验继续保留：

- `allowed_tools` 必须存在于 workspace tool registry。
- `write` tool 不允许出现在任何 Skill 的 `allowed_tools`。
- `approval_policy: none` 只能暴露 `read` tool。
- `approval_policy: draft_then_confirm` 必须声明 `draft_types`，且至少暴露一个 `requires_confirmation=True` 的 draft tool。
- `script_files` 必须位于该 Skill 的 `scripts/` 下，并通过现有 AST 和子进程安全检查。

### 3.3 Orchestrator Agent Loop Schema

将 `WorkspacePlanner` 的主路径升级为 `WorkspaceOrchestratorAgent`。orchestrator 不再只输出 `skills[]`，也不把 Skill 当作独立子流程调用，而是在同一个模型工具循环中按需注入 Skill，并直接调用基础 tools 与已注入 Skill 暴露的 tools/scripts。

建议每轮模型输出仍使用双通道协议：`<visible_text>` 用于用户可见流式回复，`<structured_result>` 用于 runtime 解析本轮 agent 状态。结构化 schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "action": {
      "type": "string",
      "enum": ["continue", "finalize"]
    },
    "injectSkills": {
      "type": "array",
      "items": {"type": "string"},
      "uniqueItems": true
    },
    "text": {
      "type": "string"
    },
    "task": {
      "type": "string"
    },
    "cards": {
      "type": "array",
      "items": {"type": "object"}
    },
    "statePatch": {
      "type": "object"
    },
    "reason": {
      "type": "string"
    }
  },
  "required": ["action"]
}
```

action 含义：

- `continue`：继续本轮 agent 工作；可以注入新的 Skill，也可以在已有 injected skills 上继续调用工具。
- `finalize`：任务已经完成，进入 finalize。

`injectSkills` 含义：

- 可以为空，表示不新增 Skill 注入。
- 可以包含一个或多个 Skill key。
- 只能注入 catalog 中存在的 Skill。
- 已注入 Skill 再次出现时视为 no-op，不重复注入正文。
- 注入后的 Skill 在本次 run 内持续可见，后续 agent step 不需要重新声明。

通用 human input 不通过 structured result 的 `action` 直接发起，而是通过工具调用发起。这样它和其他工具调用一样进入统一 agent loop，但 runtime 会把它识别为需要暂停的 Human-in-the-loop 请求。

运行约束：

- 每个 run 最多 12 个 agent tool-call round，避免模型循环。
- orchestrator 初始只看 catalog record、对话、artifacts、approval decision 和基础工具说明；只有在 `injectSkills` 后才获得对应 Skill 的完整 instructions、references、scripts 和 tools。
- 基础工具集合默认只包含不触发业务写入的 orchestrator tools，例如 `human.request_input`；业务 read/draft tools 必须来自已注入 Skill。
- injected skills 的工具集合按并集合并，再叠加基础工具集合，但仍过滤掉 `write` side effect。
- card / draft / approval contract 按 injected skills 的 `output_types`、`draft_types` 和 `approval_policy` 并集校验。
- `quick_task=today_recommendation` 可在 orchestrator 初始上下文中提示优先注入 `meal_plan`，保持现有前端快捷入口兼容。

### 3.4 LangGraph Runner 改造

当前图：

```text
initialize -> planner -> general_chat / skill_step -> finalize
skill_step -> skill_step / finalize
```

目标图：

```text
initialize -> orchestrator
orchestrator -> human_input_interrupt / approval_interrupt / finalize
human_input_interrupt -> orchestrator
approval_interrupt -> orchestrator / finalize
finalize -> END
```

`WorkspaceGraphState` 建议新增：

```python
injected_skill_keys: list[str]
injection_history: list[dict[str, Any]]
agent_rounds: int
run_artifacts: list[dict[str, Any]]
last_structured_result: dict[str, Any] | None
last_decision: dict[str, Any] | None
pending_human_input: dict[str, Any] | None
last_human_input_result: dict[str, Any] | None
```

orchestrator 节点职责：

- 构造本轮 system prompt：基础 orchestrator instructions + catalog record + 基础工具说明 + 已注入 Skill 的完整 instructions/references + 已注入 Skill 的 runtime contract。
- 构造 tools：基础工具集合 + 所有 injected skills 的 `allowed_tools` 并集 + `script.*` tools，并通过 `ToolExecutor.scoped()` 执行。
- 如果模型输出 `injectSkills`，先加载并追加 Skill instructions，再进入下一轮工具循环。
- 如果模型调用 tool，runtime 执行工具并记录 tool result。
- 如果模型调用 `human.request_input`，runtime 持久化 pending input 并进入 human input interrupt。
- 如果 draft tool 返回 draft，runtime 捕获 draft 并进入 approval interrupt。
- 如果模型 finalize，持久化 assistant message、cards、artifacts 和 run 状态。

### 3.5 Skill 调用协议

Skill 不再作为独立小 agent 过程执行。`ToolCallingSkill` 应逐步降级为兼容层，新的主路径由 `WorkspaceOrchestratorAgent` 统一完成模型循环、工具调用、结果解析和持久化。

建议新增 `SkillInjectionManager`：

职责：

- 根据 catalog record 加载 `SKILL.md` 正文。
- 加载 `references/` 中声明或默认约定的补充说明。
- 加载 `skill.yaml` runtime contract。
- 构建当前 run 的 injected instruction bundle。
- 构建当前 run 的 allowed tool schema：基础工具集合 + injected skills 工具并集，并过滤 `write` tools。
- 构建当前 run 的 allowed output/draft/approval contract。

orchestrator prompt 需要强调：

- Skill instructions 是当前 run 的能力上下文，注入后持续生效。
- 可以同时遵循多个 injected skills，但需要按用户目标决定当前调用哪些工具。
- 只能调用基础工具、已注入 Skill 暴露的 scoped tools 和 `script.*`。
- 不能调用未注入 Skill 的工具；如果需要新能力，先在 structured result 中声明 `injectSkills`。
- 信息不足时优先调用 `human.request_input` 暂停会话并等待用户选择或输入，不要用普通文本假装进入等待状态。
- 如果生成草稿，必须调用 draft tool，不能只在最终 JSON 编造 drafts。
- 不得声称已经完成正式写入。

继续保留：

- visible / structured 双通道协议。
- draft tool 输出捕获。
- card type、draft type 和 final JSON schema 校验。
- read output 派生卡片和 clarification card 的 runtime normalization。

### 3.6 通用 Human Input Tool

新增 Orchestrator 级通用工具：

```text
human.request_input
```

该工具用于信息不足、需要用户选择候选项或补充自由文本的场景。它不是业务 Skill 私有工具，而是 orchestrator 基础工具；任何已注入 Skill 的 instructions 都可以要求主 agent 在信息不足时调用它。

建议输入 schema：

```json
{
  "question": "你想按哪个番茄批次扣库存？",
  "inputMode": "choice | text | choice_or_text",
  "options": [
    {
      "id": "inventory-item-1",
      "label": "番茄 2 个，明天到期",
      "description": "冷藏，剩余 2 个"
    }
  ],
  "allowMultiple": false,
  "required": true,
  "reason": "需要确认扣减哪个库存批次",
  "sourceSkills": ["inventory_analysis"],
  "resumeHint": {
    "expectedField": "inventoryItemId",
    "resumeTool": "inventory.create_operation_draft"
  }
}
```

运行语义：

- orchestrator 判断用户信息不足时调用 `human.request_input`。
- runtime 持久化 `pendingHumanInput`，生成 `human_input_request` message part/card。
- LangGraph 通过 `interrupt()` 暂停会话，run 状态进入 `waiting_input`。
- 用户可以选择一个或多个 options，也可以按 `inputMode` 输入自由文本。
- 用户响应后，runtime 生成 `human.input_result` artifact。
- orchestrator 恢复后看到 `human.input_result`，继续使用已有 injected skills，必要时再注入新 Skill。

`human.request_input` 和 approval 必须严格区分：

- `human.request_input` 只补充信息，不代表批准写入。
- approval request 用于确认草稿正式写入，批准后进入 commit service。
- 用户选择某个库存批次、食材候选或日期范围，只能作为后续 draft tool 的参数，不能直接触发正式业务写入。

用户响应 artifact 建议结构：

```json
{
  "type": "human.input_result",
  "requestId": "input-123",
  "selectedOptionIds": ["inventory-item-1"],
  "text": "就扣明天到期的那批",
  "submittedAt": "2026-06-18T10:00:00Z"
}
```

恢复规则：

- `human.input_result` 追加到 `run_artifacts`，不直接写入业务表。
- orchestrator 看到结果后自行判断是否还需要追问、注入新 Skill、调用 read tool 或调用 draft tool。
- 如果用户答复仍不足，orchestrator 可以再次调用 `human.request_input`，但必须受最大 round 和最大连续追问次数限制。

`intent.request_clarification` 迁移策略：

- 新主路径使用 `human.request_input`。
- 旧 `intent.request_clarification` 可短期保留为兼容别名，内部转成 `human.request_input` 的同等请求。
- 现有 `pendingClarification` 建议迁移为 `pendingHumanInput`；兼容期读取两者，但写入新字段。
- 前端统一渲染 `human_input_request`，支持单选、多选、自由输入和选项加自由输入。

### 3.7 审批恢复

审批链路不改安全模型：

```text
模型调用 draft tool
  -> Tool 校验并归一化草稿
  -> Runtime 捕获 draft
  -> WorkspaceGraphRunner 持久化 AITaskDraft
  -> 创建 AIApprovalRequest
  -> LangGraph interrupt
  -> 用户确认
  -> services/ai_operations 正式写入
  -> 生成 approval decision artifact
  -> 回到 orchestrator 判断下一步
```

行为约定：

- 审批通过后，如果还有复合任务，orchestrator 可以继续调用后续 Skill，例如 `meal_plan -> shopping_list`。
- 审批拒绝后默认结束当前 run，并通过 follow-up 文本说明未写入。
- 审批失败或 stale `baseUpdatedAt` 冲突仍返回 `currentValue` 和 `recoveryHint`，由前端恢复，不在末端静默重建草稿。

### 3.8 文档与测试同步

进入实现阶段时，需要同步更新：

- `docs/ai-assistant-standards.md`：从 Planner/Skill Runtime 旧叙述更新为 orchestrator + Skill v2。
- `backend/tests/ai_infra/test_skill_loader.py`：验证 v2 包格式和旧版兼容。
- `backend/tests/ai_infra/test_foundation.py`：将 planner 行为测试改为 orchestrator agent loop 和 Skill 注入测试。
- `backend/tests/ai_infra/test_workspace_phase_flows.py`：覆盖多 Skill 同 run 持久注入和串联工具调用。
- `backend/tests/ai_infra/test_workspace_approvals.py`：覆盖 approval resume 后回到 orchestrator。
- `frontend/src/lib/aiWorkspaceContracts.test.ts`：如新增 progress 类型或消息 part 结构，补充前端契约测试。

## 4. 实施步骤

### Phase 1：Skill v2 文档与 loader 兼容

- 新增 `skill.yaml` schema 和解析逻辑。
- loader 支持 v2 优先、v1 兼容。
- 保持 `SkillManifest` 对外稳定，降低第一阶段改动面。
- 增加测试覆盖：
  - v2 skill 加载成功。
  - v1 fixture 仍可加载。
  - 内置 catalog 后续必须使用 v2。
  - 无效 tool、无效 approval_policy、危险 script 仍被拒绝。

### Phase 2：迁移内置 8 个 Skill

- 将 8 个 catalog skill 的 Culina runtime 字段从 `SKILL.md` 移到 `skill.yaml`。
- `SKILL.md` frontmatter 只保留 `name` 和 `description`。
- 现有 `workflows.md` 迁移到 `references/workflows.md`，或通过 `skill.yaml` 显式声明 instruction references。
- 更新 loader tests，确保内置 catalog 不再使用旧版 runtime frontmatter。

### Phase 3：引入 Orchestrator Agent Loop

- 新增 `WorkspaceOrchestratorAgent`、agent structured result schema 和 `SkillInjectionManager`。
- LangGraph 节点从 `planner` 替换为 `orchestrator`。
- `WorkspaceGraphState` 增加 injected skill keys、injection history、agent rounds、last structured result 等字段。
- 暂时保留 `WorkspacePlanner` 或兼容 adapter 仅用于回滚、诊断和旧 fixture；默认 AI workspace 主路径必须进入 orchestrator。
- 将 provider fallback、invalid JSON retry、unknown skill injection、max round exceeded 等测试迁移到 orchestrator。
- 明确不引入单一 `activeSkill` 状态；状态中只保留 `injected_skill_keys` 和注入历史。

### Phase 4：迁移工具调用主路径

- orchestrator 直接调用 provider `generate_with_tools()`。
- 可用工具由基础工具集合和所有 injected skills 的 `allowed_tools` 并集生成。
- `script.*` 继续由现有 `SkillScriptExecutor` 或其提取出的通用 script runtime 执行。
- draft 捕获、read output 记录、card/draft 校验从 `ToolCallingSkill` 迁入 orchestrator runtime。
- `ToolCallingSkill` 仅保留为旧测试、灰度回滚或分步迁移兼容层，内置主路径不再依赖它。
- 移除“调用某个 Skill 后进入 Skill 内部流程”的主路径语义；Skill 只注入 instructions、references、scripts 和 runtime contract。

### Phase 5：Human Input、审批恢复、多 Skill 串联

- 新增 `human.request_input` 通用工具和 `human.input_result` artifact。
- 新增 `waiting_input` run 状态或复用现有可表达暂停的状态，并在 API/前端契约中明确。
- 将 `intent.request_clarification` 兼容到 `human.request_input`。
- 用户响应 human input 后回到同一个 orchestrator agent loop。
- approval resume 后把 decision result 写入 artifacts。
- 通过后回到同一个 orchestrator agent loop，而不是固定终止。
- 覆盖 `meal_plan -> approval -> shopping_list`。
- 覆盖候选项选择、自由文本输入、用户回答后继续调用 draft tool。
- 覆盖拒绝审批、重试审批、stale draft 冲突。
- 确认 SSE message delta、progress、human input part、draft part、approval part、operation result card 与前端契约一致。

### Phase 6：清理旧 Planner 文档和测试命名

- 若 orchestrator 已稳定，清理旧 planner-only 叙述。
- 将 `PlannerResult` 相关命名收敛到兼容层或删除。
- 更新 `docs/ai-assistant-standards.md` 中的架构图和测试要求。
- 删除只服务旧 `skills[]` 顺序执行的测试 fixture。

## 5. 测试计划

建议分层验证。

### Loader / Skill 包格式

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_skill_loader.py -q
```

覆盖：

- v2 `skill.yaml` 加载。
- `SKILL.md` 标准 frontmatter。
- 旧版兼容路径。
- unknown tool、draft tool without approval、unsafe script、script timeout。

### Orchestrator 基础行为

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py -q
```

覆盖：

- direct answer。
- single skill injection。
- 多 skill 同 run 注入。
- 已注入 Skill 在后续 round 持续生效。
- 已注入 Skill 重复注入是 no-op。
- 调用 `human.request_input` 后 run 暂停。
- 用户选项或文本响应后以 `human.input_result` 恢复。
- 用户答复不足时允许再次调用 `human.request_input`，但受 round 限制。
- invalid action retry。
- provider fallback。
- unknown skill injection 被拒绝。
- 未注入 Skill 的工具调用被拒绝。
- `quick_task=today_recommendation` 优先注入 `meal_plan`。

### 工作流与审批

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_phase_flows.py backend/tests/ai_infra/test_workspace_approvals.py -q
```

覆盖：

- 正式餐食计划创建草稿和审批。
- 信息不足时生成 human input request，不创建草稿。
- 用户补充信息后继续原 run 的 injected skills。
- 审批通过后继续购物清单。
- 审批拒绝后不写入正式业务数据。
- stale draft 冲突返回恢复信息。

### AI infra 全量回归

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
```

### 前端契约

```bash
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```

如新增 `orchestrator` progress 类型或调整消息 part，需要同步更新前端契约测试。

## 6. 验收场景

- “今晚吃什么”：orchestrator 注入 `meal_plan`，返回 `today_recommendation` 卡片，不创建草稿。
- “安排三天晚餐，顺便生成购物清单”：先注入 `meal_plan` 并生成计划审批，审批通过后继续在同一 run 注入 `shopping_list` 并生成购物清单审批。
- “新增鸡胸肉食材，默认单位克”：注入 `ingredient_profile`，生成 `ingredient_profile` 审批草稿。
- “库存怎么样”：注入 `inventory_analysis`，返回 `inventory_summary` 卡片，不创建草稿。
- “做饭用了番茄，但有多个库存批次”：orchestrator 调用 `human.request_input` 让用户选择批次；用户选择后继续调用库存 draft tool，而不是直接扣库存。
- “鸡胸肉入库 2 袋，每袋多少克不清楚”：orchestrator 调用 `human.request_input` 请求用户输入换算比例；用户输入后继续生成 draft。
- “普通做饭建议”：不调用业务 Skill，直接回答。
- 同一 run 先后注入的 `meal_plan` 和 `shopping_list` instructions 都持续可见，orchestrator 可以基于两个 Skill 的上下文组织最终回复。
- 同一 run 没有 `activeSkill` 单选锁；主 agent 可以在任意 round 注入一个或多个新 Skill，并继续使用此前已注入 Skill 的工具。
- 模型试图调用未声明工具、返回未声明卡片、伪造 draft：后端拒绝并记录失败。

## 7. 默认假设

- 本方案只描述后续实现，不在本文档阶段修改后端代码。
- 改造落地前，现行 AI 工作台开发标准仍以 `docs/ai-assistant-standards.md` 为准；本文档用于指导后续重构目标和实施顺序。
- canonical Skill 真源保留在 `backend/app/ai/skills/catalog`。
- `skill.yaml` 是 Culina runtime contract。
- `SKILL.md` 标准化后不再承载 Culina runtime 字段。
- orchestrator 是 LangGraph 节点，不是脱离 graph 的 while-loop。
- Skill 是持久注入机制：同一 run 可注入多个 Skill，注入后不自动取消。
- 不设置互斥的 `activeSkill`；如果需要表达当前任务焦点，只能作为 transient planning note，不参与权限收窄。
- 第一阶段也按 Codex 风格做主 agent 统一工具循环，不再把 Skill 当作独立子 agent 过程。
- 询问用户信息统一走 `human.request_input`，并通过 LangGraph interrupt 暂停会话。
- `human.request_input` 不是 approval，用户回答不代表批准写入。
- `write` tool 不暴露给模型，正式写入仍由 `services/ai_operations` 执行。
- 现有前端消息 part、草稿、审批和结果卡片协议尽量保持兼容。
