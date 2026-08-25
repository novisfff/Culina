# AI 助手规范

更新时间：2026-08-26

本文档定义 Culina AI 助手、Skill 机制、Tool 权限、草稿审批和前后端稳定协议。AI 助手是家庭饮食管理的受控辅助能力，不是拥有直接写权限的自由代理。

## 1. 文档定位

Culina AI 工作台由 LangGraph Orchestrator、Skill Runtime、Tool、Skill Script 和业务 Service 组成：

- `WorkspaceOrchestratorAgent` 是默认主路径，负责直接回复、按需注入一个或多个 Skill，并在同一个模型工具循环中调度工具。
- Skill 是能力包和上下文注入单元，不是独立子 agent；注入后本 run 内持续可见，状态使用 `injected_skill_keys` 和注入历史，不使用单选 `activeSkill`。
- `CatalogSkill` 是 Skill catalog 包的运行时表示，承载 manifest、instructions 和 scripts；AI workspace 不再保留 Planner、`ToolCallingSkill` 或单 Skill runtime 路径。
- Tool 提供家庭范围内的业务读取和草稿校验能力。
- Skill Script 提供不访问业务状态的确定性计算能力，并以 `script.*` 工具暴露给模型。
- LangGraph 负责 orchestrator 节点循环、approval interrupt、human input interrupt 和恢复。
- `AIApplicationService` 是应用门面，负责连接 API、会话、运行生命周期和 `WorkspaceGraphRunner`。
- `backend/app/services/ai_operations/` 承载通过 commit gate 后的领域写入、草稿归一化、恢复信息、结果卡片和组合操作执行。

AI 结果必须基于当前家庭上下文。没有家庭上下文时，不能返回库存、餐食计划、推荐、购物清单或家庭成员相关内容。

## 2. 核心原则

1. `SKILL.md` 是标准 Skill 入口，`skill.yaml` 是 Culina runtime contract。
2. 工作台路径统一使用 `WorkspaceOrchestratorAgent`；不再保留旧 Planner 或单 Skill runtime。
3. 主 agent 只能调用基础工具和已注入 Skill 的 `allowed_tools` / scripts。
4. 模型不能接触 `write` 工具。
5. 正式写入必须经过 `draft -> server policy commit gate -> service commit`；是否需要真实用户确认由服务端策略决定，模型没有决定权。
6. 草稿必须来自 draft tool 的校验结果，不能由模型在最终 JSON 中直接伪造。
7. Orchestrator 负责选择是否注入 Skill、调用工具、组织回复；Skill 不接管流程控制。
8. 即时推荐和正式餐食计划由同一个 `meal_plan` Skill 根据请求模式处理。
9. 对外响应使用 `AIChatResponse`、消息 part、卡片、草稿和审批 DTO。
10. Script 只能做纯计算；数据库读取、草稿创建和正式写入必须使用 Tool。
11. `workspace_service.py` 只能作为应用门面和兼容调度层；新的领域写入、审批执行、结果卡片和恢复逻辑必须进入 `services/ai_operations/`。
12. 不允许用后置 fallback、静默吞错、结果反修正或按单个异常形状硬编码恢复来掩盖 Skill/Tool/审批契约问题；必须先修正根因，只有历史兼容或外部系统降级等场景才允许可观测、可测试的兜底。

## 3. 目录与职责

```text
backend/app/ai/
  runtime/         # 模型 provider、工具调用接口和运行时 schema
  workflows/       # LangGraph Runner、会话运行、checkpoint 和 Orchestrator runtime
    orchestrator/  # Orchestrator agent loop、profile、prompt、tool gateway、completion policy
    runner_support/# Runner 消息 part、审批恢复和 run summary 纯辅助函数
  skills/          # Skill loader、registry、runtime、script worker
  tools/           # Tool registry、executor、schemas、validation
  images/          # AI 图片生成任务
  kitchen/         # 厨房上下文和菜谱草稿能力
  observability/   # Trace、LLM exchange、脱敏和结构化错误码
  evals/           # 确定性 Skill 评测用例、评分和阈值模型
  workspace_service.py  # AIApplicationService 应用门面

backend/app/services/ai_operations/
  approvals / drafts / executor / recovery / messages / artifacts
  inventory / recipe_cook / recipes / meal_plans / shopping / meal_logs
  foods / ingredients / composite
```

`observability/` 负责记录可审计的运行事实、错误码和脱敏后的诊断信息；追踪写入不得改变业务提交结果或泄露家庭数据。`evals/` 负责确定性 Skill 评测的数据加载、评分和阈值判断；评测 case、报告和阈值是发布门禁的一部分，不属于 Provider 的线上业务逻辑。

Skill catalog：

```text
backend/app/ai/skills/catalog/
  cooking-assistant/
    SKILL.md
    skill.yaml
  food-profile/
    SKILL.md
    skill.yaml
  ingredient-profile/
  inventory-analysis/
  meal-planning/
  meal-record/
  recipe-cook/
  recipe-draft/
  shopping-list/
```

`cooking_assistant` 只在 `recipe_cook_page` 固定 Profile 中使用，不属于主工作台允许动态注入的 8 个业务 Skill；它只读取做菜现场并提出 `ui.propose_actions`，不生成业务草稿。

存在真实分支复杂度的 Skill 可以使用 `references/workflows.md`。简单 Skill 的流程、确认规则和边界直接写在 `SKILL.md` 中。

## 4. Skill 包格式

每个 catalog Skill 目录使用 v3 包格式；Loader 仍可读取 v2 包，用于分阶段升级和存量测试，但当前九个正式 Skill 都必须声明 `version: 3`：

```text
<skill-slug>/
  SKILL.md
  skill.yaml
  references/
  scripts/
```

`SKILL.md` 只承载标准 Skill 入口信息和 Markdown 指令：

```yaml
---
name: meal-planning
description: 处理即时餐食推荐以及餐食计划的创建和修改。
---
```

`skill.yaml` 承载 Culina 运行时字段：

```yaml
version: 3
key: meal_plan
display_name: 餐食安排
allowed_tools:
  - inventory.read_available_items
  - meal_plan.create_draft
context_policy:
  - inventory
script_files:
  - scripts/validate_meal_plan.py
  - scripts/render_plan_preview.py
output_types:
  - today_recommendation
draft_types:
  - meal_plan
approval_policy: draft_then_confirm
intent: meal_plan
agent_key: meal_plan_agent
examples:
  - 今晚吃什么？
  - 安排三天晚餐。
routing:
  modes: [query, create, update]
  include_examples:
    - 今晚吃什么？
    - 安排三天晚餐。
  exclude_examples:
    - 记录昨晚吃了番茄炒蛋。
    - 按菜谱做菜并扣库存。
    - 新增盒装牛奶食物资料。
  conflict_rules:
    - with: meal_log
      when: 用户描述已经发生的用餐
      route_to: meal_log
handoffs:
  missing_food:
    target_skill: food_profile
    required_draft_type: food_profile
    resume_skill: meal_plan
    state_schema: meal_missing_food.v1
attachment_policy:
  accepted_kinds: []
  usages: []
  bindable_fields: []
  current_message_only: true
  explicit_user_intent_required: true
```

字段要求：

- `SKILL.md:name`：目录 slug，必须与目录名一致。
- `SKILL.md:description`：Orchestrator catalog 使用的路由摘要，必须明确适用和不适用范围。
- `skill.yaml:version`：正式 catalog 当前为 `3`；Loader 兼容 `2` 和 `3`，v2 只使用默认 routing 且不声明 handoff。
- `skill.yaml:key`：Orchestrator 和 Runtime 使用的稳定 Skill key。
- `skill.yaml:display_name`：进度事件中的用户可见名称。
- `skill.yaml:allowed_tools`：模型可以调用的工具白名单。
- `skill.yaml:script_files`：模型可以调用的 Skill 私有脚本白名单；公开函数以 `script.<函数名>` 暴露。
- `skill.yaml:context_policy`：提供给 Orchestrator catalog 和诊断接口的上下文标签，不触发 Runtime 自动预读。
- `skill.yaml:output_types`：允许返回的结果卡片类型。
- `skill.yaml:draft_types`：允许返回的草稿类型。
- `skill.yaml:approval_policy`：`none`、`draft_then_confirm` 或 `draft_then_policy`。
- `skill.yaml:intent`、`skill.yaml:agent_key`：兼容诊断标识；默认 run 的 `agent_key` 为 `workspace_orchestrator`，`intent` 由注入 Skill 推导。
- `skill.yaml:examples`：保留的用户示例；v3 的机器路由边界以 `routing` 为准。
- `skill.yaml:routing`：必须提供非空 `modes`、`include_examples`、至少三个 `exclude_examples` 和 `conflict_rules`；include/exclude 不得重叠。
- `skill.yaml:handoffs`：按 reason code 声明 `target_skill`、`required_draft_type`、`resume_skill` 和 `state_schema`。Registry 构建时校验目标/恢复 Skill、目标草稿类型和 continuation state schema，任一引用无效都启动失败。
- `skill.yaml:attachment_policy`：声明可接受附件类型、用途和可绑定字段。只有 `food_profile`、`ingredient_profile`、`recipe_draft`、`meal_log` 可以绑定图片；绑定必须限定当前消息并要求用户有明确意图。

`SKILL.md` frontmatter 不放 Culina runtime 字段，例如 `allowed_tools`、`script_files`、`output_types`、`draft_types`、`approval_policy`、`intent`、`agent_key`。这些字段必须进入 `skill.yaml`。

Runner 固定为 `toolcall`。所有 draft tool 继续声明 `requires_confirmation=True`，表示 Draft 必须进入服务端 commit gate；`approval_policy` 再决定它始终等待用户，还是允许服务端低风险策略免确认提交。

### Routing Record 与 Execution Record

Skill manifest 对模型提供两种记录，不能混用：

- Routing Record 只用于初始 catalog，包含 Skill key、展示名、description、routing modes/examples/conflicts、输出/草稿类型、route hints 和是否需要审批；不得包含工具白名单、预算、draft contract 或 handoff 执行细节。
- Execution Record 只在 Skill 注入后提供，在 Routing Record 基础上增加 `contractVersion`、`allowedTools`、`scriptFiles`、`toolBudget`、`completionPolicy`、`draftContract`、`approvalPolicy`、`handoffs` 和 `attachmentPolicy`。

初始 prompt 使用 Routing Record 控制体积和路由泄漏；注入后的同一 Orchestrator tool loop 使用完整 Execution Record 执行。`to_catalog_record()` 只保留为兼容 alias，新代码应显式选择 record 类型。

## 5. Skill 职责矩阵

| Skill key | 职责 | 卡片 | 草稿 |
| --- | --- | --- | --- |
| `inventory_analysis` | 库存查询；入库、消耗和销毁确认 | `inventory_summary` | `inventory_operation` |
| `meal_plan` | 即时餐食推荐；餐食计划创建和修改 | `today_recommendation` | `meal_plan` |
| `shopping_list` | 独立购物清单、从计划派生、修改清单；单项/批量采购完成与原子入库 | 无 | `shopping_list`、`shopping_intake` |
| `meal_log` | 记录已经发生的用餐 | 无 | `meal_log` |
| `recipe_draft` | 创建、更新和删除菜谱草稿 | 无 | `recipe` |
| `food_profile` | 创建、更新或收藏食物资料 | 无 | `food_profile` |
| `ingredient_profile` | 创建或更新食材档案 | 无 | `ingredient_profile` |
| `recipe_cook` | 预览并确认做菜、库存扣减和计划完成 | 无 | `recipe_cook` |

### 即时推荐与正式计划

`meal_plan` 有两个互斥模式：

- 即时推荐模式：触发语义包括“今天吃什么”“今晚吃什么”“推荐一餐”；调用明确返回 `card` 的推荐工具产出 `today_recommendation` 卡片；不调用 `meal_plan.create_draft`；不创建草稿或审批。
- 正式计划模式：触发语义包括“安排、制定、生成、修改餐食计划”；用户给出日期、天数或餐别范围时也进入该模式；调用 `meal_plan.create_draft`；返回 `meal_plan` 草稿并进入服务端 commit gate。只有满足 `meal_plan.simple_create` 白名单的低风险新增可按策略免确认，其他计划创建或修改等待人工确认。

`quick_task=today_recommendation` 必须路由到 `meal_plan`，`today_recommendation` 只作为结果卡片类型使用。

## 6. Orchestrator 与 Runtime

默认主路径位于 `backend/app/ai/workflows/orchestrator/` 包入口，`WorkspaceOrchestratorAgent` 的当前实现位于 `backend/app/ai/workflows/orchestrator/agent.py`，并由 `WorkspaceGraphRunner` 调用。

Orchestrator 输入完整对话、Routing Records、已注入 Skill 的 Execution Records 和当前 run artifacts。它可以直接输出普通 assistant 文本，也可以调用工具。需要新能力时，主 agent 调用 `skill.inject` control tool 注入一个或多个 Skill；注入后，同一个 provider tool loop 的下一轮获得该 Skill 的 `SKILL.md` instructions 和完整执行契约，并继续由同一个主 agent 调用工具。

Runtime 加载流程：

1. `SkillDirectoryLoader` 扫描 `catalog/*/SKILL.md`。
2. 同目录必须存在 `skill.yaml`，并按 v2/v3 runtime contract 解析；正式 v3 catalog 的 routing、handoff 和 attachment 引用在 registry 构建完成后统一校验，缺失或无效时启动失败。
3. 加载 `SKILL.md` 正文。
4. 如果同目录存在 `references/workflows.md`，按约定自动追加；根目录 `workflows.md` 不再读取。
5. 校验 `script_files`，从公开函数签名生成模型 Tool Schema。
6. 创建统一的 Skill catalog 包，供 Orchestrator 注入 instructions、tools、scripts 和输出契约。

Orchestrator scoped injection 负责暴露工具白名单、执行脚本和业务 Tool、通过 `generate_with_tools()` 让模型在已授权工具内自主选择工具、捕获 draft tool 的真实输出和显式 tool card 输出，并由程序状态判断 run 是否 completed、waiting_input、waiting_approval 或 failed。

`WorkspaceGraphRunner` 执行 LangGraph orchestrator 节点，并负责运行状态、SSE 进度、消息持久化、draft 持久化、approval interrupt、human input interrupt 和恢复。不要因为前端时间戳相同就假设后端并行执行多个 Tool。

模型输出协议：

```text
普通 assistant 文本
provider tool call
```

Runtime 不再解析 `<visible_text>` 或 `<structured_result>`。普通 assistant 文本直接进入 `message_delta`，工具调用结果由程序状态和 message part 持久化。

## 7. Tool、Script 与权限

Tool 注册在 `backend/app/ai/tools/catalog/`。

工具副作用：

- `read`：读取家庭范围内的业务数据。
- `draft`：校验并归一化草稿，不写正式业务表。
- `write`：正式写入能力，不暴露给模型。
- `control`：控制 agent loop，例如注入 Skill 或请求用户补充信息，不写正式业务表。

通用 control 工具：

- `skill.inject`：按需注入一个或多个 Skill；调用后同一个 provider tool loop 的下一轮暴露对应工具集合。
- `human.request_input`：信息不足、需要用户选择候选项或补充自由文本时使用。它只收集信息，不代表批准写入。

通用上下文读取工具：

- `workspace.read_artifact`：按 ID 读取当前家庭、当前会话中的完整 AI 草稿或审批详情。Orchestrator 传给模型的历史 artifact 默认是摘要索引；模型需要复用完整草稿内容时必须显式调用该工具，不能根据摘要补全完整 payload。

Orchestrator 根据已注入 Skill 的 `approval_policy` 创建 Tool 作用域：

- 未注入业务 Skill：只允许基础 control 工具，例如 `skill.inject`、`human.request_input`。
- 已注入 Skill 且 `approval_policy: none`：允许基础 control 工具、该 Skill 声明的 `read` 工具和 scripts。
- 已注入 Skill 且 `approval_policy: draft_then_confirm`：允许基础 control 工具、该 Skill 声明的 `read`、`draft` 工具和 scripts。
- 已注入 Skill 且 `approval_policy: draft_then_policy`：模型侧权限与 `draft_then_confirm` 相同，只允许 control、read、draft 和 scripts；免确认资格只由服务端 commit gate 判断。
- `write` 工具永远不暴露给模型。

Script 约束：

- `script_files` 路径必须位于所属 Skill 的 `scripts/` 目录。
- 只暴露不以下划线开头的同步函数。
- 输入和输出都必须通过 JSON Schema 校验并可 JSON 序列化。
- 脚本在独立的 `python -I` 子进程执行，默认超时 5 秒。
- 加载阶段拒绝未授权 import、`open`、`eval`、`exec`、`compile`、`input`、`__import__`、装饰器和可执行顶层语句。
- Script 不接收数据库 Session、家庭上下文、Token 或 ToolExecutor。
- Script 只能做纯计算，不访问数据库、网络、文件系统或正式业务写入能力。

## 8. 草稿、服务端 commit gate 与撤销

### 8.1 两种草稿提交策略

草稿型 Skill 必须声明至少一个 `draft_types`、至少一个允许的 draft tool，并且 draft tool 自身设置 `requires_confirmation=True`。这个字段不是“所有草稿都必须由用户点确认”的同义词，而是要求所有 Draft 都进入可信的服务端 commit gate：

> 模型始终只生成 Draft，并且模型不获得正式 Write Tool。`requires_confirmation=True` 表示 Draft 必须进入服务端 commit gate：`draft_then_confirm` 始终等待真实用户决定；`draft_then_policy` 只有在离散意图证据、当前成员/家庭授权、动作白名单、版本、限制和已注册撤销适配器全部通过时，才由服务端策略直接提交。其他情况降级人工确认。

`draft_then_confirm` 与 `draft_then_policy` 在模型侧拥有完全相同的最小权限；两者都不能看见或调用正式 Write Tool。`draft_then_policy` 不是模型自批，也不能由 Skill 文案、模型置信度或前端开关直接绕过 gate。`Composite 与 Continuation 始终人工确认`：`composite_operation`、带 continuation 的 Draft、做菜、删除、媒体或其他外部副作用均不得走免确认路径。

服务端执行顺序固定为：

```text
模型调用 requires_confirmation=True 的 draft tool
  -> Tool 校验并归一化业务 payload，Runtime 分离 intentEvidence
  -> WorkspaceGraphRunner 持久化 AITaskDraft
  -> route_draft 取得并锁定 Run，执行服务端 policy preflight
  -> 不满足策略：创建唯一 AIApprovalRequest，等待真实用户决定
  -> 满足策略：锁定授权与目标并复核，标记本消息的单次门禁
  -> 两条路径统一进入 DraftCommitCoordinator
  -> 领域 Service 在事务内写入，记录 AIOperation
  -> 以同一 Draft key 原位写入 operation_result 卡片
```

每条用户消息最多一个免确认 Draft。实现以该消息对应 Run 上持久化的 `auto_execution_attempted` 为单次门禁；成功、无变化和已落库的失败都会消费名额，第二个 Draft 降级人工确认。并发请求必须先锁 Run，不能依赖前端串行调用。

人工与策略提交共享 `DraftCommitCoordinator`、同一领域 executor、事务、锁顺序、`draft_id + draft_version` 幂等键和结果投影，不维护第二套“自动写入”业务逻辑。人工提交必须引用状态和决定均为 `approved` 的真实 `AIApprovalRequest`，并逐项核对家庭、会话、Draft、Draft version、审批人及提交值；策略提交必须引用原 Run 执行人、锁定 Draft payload hash、最终策略版本和锁后授权快照。以下事实一经写入不得在重放时改写：

- `committed_payload_json`、Draft ID/version/payload hash 和执行模式；
- `actor_user_id`、`approval_request_id` 或策略授权来源；
- member preference、family policy、consent notice、catalog 和 policy 的版本快照；
- `policy_key`、`policy_version`、reason codes、operation idempotency key 与结果。

同一 Draft/version 不得切换人工/策略语义，也不得提交不同 payload。审批失败或 stale `baseUpdatedAt` 冲突时，应返回结构化 `currentValue` 和 `recoveryHint`；不要静默重建草稿、覆盖原审批事实或自动改写用户提交值。

连接级临时数据库失败可以把原 Draft 标记为 `pending_retry`。`pending_retry 不重新调用模型`：重试入口在任何 prompt/provider replay 前拦截，重新锁定同一 Run、同一 Draft、同一 payload hash、同一 Operation 和当前授权/目标，只恢复原领域提交；人工路径则只恢复唯一的 `.retry` 审批。若授权、版本、操作者、目标或幂等事实已变化，必须拒绝重试。

### 8.2 意图清晰度与逐值证据

`intentEvidence` 是模型可见、服务端验证的证据输入，必须与归一化业务 payload 分开保存；正式 payload 中出现 `intentEvidence` 必须拒绝。模型只能按 schema 选择一个档位，不生成置信度，四档定义原样对模型可见：

- `explicit_complete`：当前用户明确要求该操作，并直接给出唯一目标和全部关键值。
- `explicit_context_resolved`：当前用户明确要求该操作；只有唯一目标或指代来自当前 UI、本轮 Tool 结果或可信 Artifact，且没有关键默认值。
- `explicit_incomplete`：用户要求了操作，但关键值或目标缺失、歧义、冲突或依赖默认值。
- `inferred`：用户没有直接要求写入；事实陈述、称赞或可能的未来打算都不是操作指令。

模型不得因为 Draft 看起来合理而升级档位；缺少证据、非法枚举或省略 `intentEvidence` 一律按 `inferred`/缺证据处理并降级人工确认。只有 `explicit_complete` 和 `explicit_context_resolved` 有资格继续策略评估。

证据字段固定为 `sourceQuotes`、`resolutionSources`、`ambiguityCodes` 和 `defaultedFields`。`sourceQuotes` 必须是当前用户消息中的真实连续文本；`resolutionSources` 只接受同家庭的 `current_ui_context`、本轮受信 Tool 结果或成功读取的 `conversation_artifact`，并绑定 reference、entity 和 row version。通配数组路径不能证明所有项目；歧义或关键默认值会关闭免确认。

服务端按动作策略生成关键字段清单，然后进行逐值验证，不采信“模型声称已覆盖该字段”：每个具体 payload 路径都必须从 quote 或可信 source 得出唯一 canonical value，再按字段类型与归一化业务 payload 的期望值比较。数量/份数/评分使用精确十进制比较，单位先做服务端别名归一化，日期、餐别、布尔方向、动作、实体 ID 和文本分别使用其 canonical matcher。只有值相等的路径进入服务端 `verified_values`；证据原文、服务端验证值/reason codes 与业务 payload 分栏持久化。

购物清单按 payload 模式使用不同证据字段，不能用一个笼统的“购物意图”覆盖全部值：

- `shopping_list.v1` 新增：验证顶层 `action=create`，逐项验证 `items[i].ingredient_id` 或 `food_id`；数量型项目还必须逐项验证 `quantity` 和 `unit`。
- `shopping_list_operation.v1` 的 `create`：逐项验证 `operations[i].action`、payload 的目标 ID；数量型项目再验证 `quantity`、`unit`。
- 单项 `update`：验证 `operations[0].action`、`targetId`，并只对实际变化的 `quantity`、`unit`、`reason` 逐值取证；服务端同时核对未改变的身份、标题、数量模式和 row version。
- 恢复待买 `set_done:false`：逐项验证 action、`targetId` 和 `payload.done=false`。标记买到、删除或入库不在白名单内。

### 8.3 动作白名单、限制与授权

免确认动作只允许以下五个稳定 action key；任何未唯一匹配的 Draft 都返回 `action_not_allowed` 并降级人工确认：

| Action key | 允许范围与硬限制 | 额外排除 | 授权 | Revert adapter / cache scopes |
| --- | --- | --- | --- | --- |
| `food.set_favorite` | 一个既有食物，只设置 `favorite` 布尔值 | 不修改食物资料或图片；必须匹配 `baseUpdatedAt` | 当前成员 opt-in | `food.favorite.v1` / `food`, `ai_conversation` |
| `meal_log.rate_food` | 一次评分或取消评分最多 5 个餐食 food entry；评分为 `0.5..5` 或 `null` | 只允许记录创建者或参与者；不修改餐食组成、参与人或图片 | 当前成员 opt-in | `meal_log.rating.v1` / `meal_log`, `ai_conversation` |
| `shopping_list.safe_write` | 新增或恢复待买最多 5 项；修改恰好 1 项 | 不删除、不标记买到、不入库；只允许既有食材或 readyMade/instant/packaged 食物，并校验数量模式与版本 | 当前成员 opt-in + 当前家庭 Owner 开启 family policy | `shopping_list.safe_write.v1` / `shopping_list`, `ai_conversation` |
| `meal_log.simple_create` | 使用最多 5 个既有食物新增一餐，参与者只能是当前执行人 | 不扣库存、不关联计划、不添加媒体；食物 ID/name/type 必须由服务端重读 | 当前成员 opt-in | `meal_log.simple_create.v1` / `meal_log`, `ai_conversation` |
| `meal_plan.simple_create` | 使用最多 5 个既有食物新增 planned 项 | 不更新状态、不联动购物清单；日期/餐别/food/recipe 必须由服务端复核 | 当前成员 opt-in | `meal_plan.simple_create.v1` / `meal_plan`, `ai_conversation` |

五项能力全部要求当前家庭的有效 membership 和当前用户自己的 member preference；Owner 也不能跳过自己的 opt-in。`shopping_list.safe_write` 还要求当前家庭 policy 已由当前 Owner 开启，普通 Member 只读该 family switch。开启 preference/policy 必须提交当前 consent notice version；旧 notice 使 `effective_enabled=false` 并要求重新同意。commit 前按固定顺序锁 family policy、member preference、Operation 与领域目标，并复核 row version、catalog version、policy version、notice version 和授权快照；任一变化都关闭免确认。

策略还会统一拒绝 external side effect、Continuation、Composite、重复自动执行、缺失已注册 revert adapter、部分目标已满足但部分未满足，以及动作自身的数量、身份、版本或领域限制失败。完全已满足的目标必须在领域锁下再次证明，才返回 `policy_no_change`；无法锁定或锁后变化则降级人工确认。

### 8.4 公开结果、时间与缓存

正式结果只公开安全投影。顶层 public fields 固定为：`draft_id`、`operation_id`、`result_status`、`execution_mode`、`operation_status`、`execution_explanation`、`revert_availability`、`revertible_until`、`revert_blocked_code`、`server_now`、`entities`、`cache_scopes`。每个 entity 只允许 `id`、`label`、`operation`、`operationLabel`、`updatedAt`。完整业务 payload、intent 原文、authorization snapshot、内部错误、revert context 和内部 artifact 不得进入公开卡片；失败只使用稳定安全文案。

结果卡 ID 固定为 `operation-result:{draft_id}`，message part 固定为 `operation-result-part:{draft_id}`，artifact 固定为 `ai_operation_result:{draft_id}`；审批、自动执行、失败、永久阻塞和撤销都原位替换同一 Draft-keyed 结果，不追加第二张卡。

`server_now` 是每次 HTTP 响应级的新鲜服务端时间，不是业务执行时钟或持久化倒计时起点。消息/会话序列化必须递归刷新 operation result card、projection 和 artifact 中的 `server_now`，并在服务端时间已越界时把 `available` 水合为 `expired`；revert HTTP 响应也必须在 commit 后重新水合。前端用新鲜 `server_now` 计算客户端偏移，同时始终以持久化的绝对 `revertible_until` 为截止时间；刷新页面不得把剩余 30 分钟重新变成 1 小时。

`cache_scopes` 只允许 `food`、`meal_log`、`meal_plan`、`shopping_list`、`inventory`、`ai_conversation`，去重后必须包含 `ai_conversation`。成功提交/撤销按 adapter 返回的领域 scope 精确失效，不得用全局清缓存代替。

普通 approval mutation 和撤销通过 HTTP 响应更新发起 caller；不发送跨请求 SSE 广播。SSE 只描述其所属 run 的实时进度，其他已打开页面依靠既有 query invalidation、轮询或重新获取消息收敛。

### 8.5 一小时 AI 撤销合同

支持的 AI Operation 在 commit 时记录不可变 revert adapter key、版本化 revert context 和 `revertible_until = committed_at + 1 小时`。边界为 inclusive：`now == revertible_until` 仍可撤销，只有 `now > revertible_until` 才返回过期。该窗口只属于统一 AI Operation 撤销；普通页面的领域 undo 仍为 15 分钟，不得借 AI 一小时规则延长页面 undo。

撤销 API 只能读取当前家庭中的 Operation，并在锁下重新读取当前有效 membership。允许原执行人或当前 Owner；请求传入或缓存的角色不构成授权，跨家庭、已离开家庭、普通 Member 撤销他人操作均拒绝。`client_request_id` 是全局幂等键：同键同 Operation 重放已保存的公开结果并返回 `replayed=true`，同键指向不同 Operation 必须冲突，不能第二次执行 adapter。

七个稳定错误码如下；永久阻塞必须把同一 Draft 卡原位更新为 `blocked`，并在 409 detail 中返回完整安全 projection/card/cache scopes/fresh `server_now`，使 HTTP caller 收敛：

| Code | HTTP | 语义 |
| --- | --- | --- |
| `operation_not_revertible` | 409；目标不存在时 404 | 状态、上下文或 adapter 不满足撤销条件 |
| `revert_expired` | 409 | 已越过一小时 inclusive 边界 |
| `revert_forbidden` | 403 | 不是原执行人或当前 Owner |
| `revert_target_changed` | 409，永久 | 目标值或版本后来变化 |
| `revert_dependency_exists` | 409，永久 | 已存在后续依赖，补偿会破坏数据 |
| `revert_adapter_version_unsupported` | 409，永久 | 持久化 context schema 与 adapter 版本不兼容 |
| `revert_request_id_reused` | 409 | 幂等请求 ID 已被其他 Operation 使用 |

注册表当前只允许六个 adapter key：`food.favorite.v1`、`meal_log.rating.v1`、`shopping_list.safe_write.v1`、`meal_log.simple_create.v1`、`meal_plan.simple_create.v1`、`inventory.operation_ref.v1`。adapter 必须在同一事务内重新校验目标、版本和依赖，返回安全 entities 与 cache scopes；未注册 key 失败关闭，不能按字符串动态导入。

做菜、删除、媒体绑定/生成、Composite 与 Continuation 不提供统一一小时撤销；它们始终人工确认，并使用各领域既有修正或补偿流程。缺少 adapter/context/deadline 的 Operation 显示 `unsupported`，过期显示 `expired`，依赖或目标冲突显示 `blocked`，已经撤销显示 `reverted`。

### Typed continuation 与审批恢复

新 draft tool 的模型 schema 只暴露 `continuation`，字段固定为：

- `workflowId`、`stepKey`：工作流和当前步骤的稳定幂等标识。
- `reasonCode`：必须匹配某个已注入来源 Skill 的 handoff。
- `nextSkillKey`、`resumeSkillKey`、`requiredDraftType`、`stateSchema`：必须与 handoff 声明完全一致。
- `state`：由 `backend/app/ai/skills/state_schemas.py` 中注册的严格 Pydantic model 校验，只保存恢复所需的紧凑编排状态，不复制完整菜谱、计划或购物 payload。

Runtime 在 draft capture 时确定唯一来源 Skill，校验 Profile 允许的目标/恢复 Skill，并归一化 state。合法 continuation 存入 `AITaskDraft.ai_metadata["continuation"]`。审批结果生成稳定的 `workflow.continuation` artifact：

- 审批成功且业务 commit 成功后为 `status=ready`，携带去重后的 `businessEntityIds`，再按 Profile 和 Skill budget 恢复 `resumeSkillKey`。
- 拒绝为 `status=rejected`，不注入恢复 Skill，也不推进下一草稿。
- commit 冲突不产生 ready continuation；恢复权限或预算失败时保留已经成功的业务 commit，把 artifact 标为 failed 并停止新的模型 round。
- 同一 approval 重放时 artifact、注入 key 和注入历史都必须去重，保证 exactly-once resume。

continuation 只恢复能力和上下文，Runtime 不得自动生成或提交下一个草稿。旧数据库中已经持久化的 `afterApproval` metadata 仍由 approval resume 兼容读取，以便部署前创建的待审批草稿完成；新的模型 tool schema、Skill 文档、provider payload 和草稿持久化路径不得再写入该字段。

字段合法性的最终真相源是 draft tool JSON Schema 和 continuation state Pydantic model。Skill Markdown 负责流程、候选和审批语义，不得自行扩展或覆盖字段约束。

## 9. 跨 Skill 产品闭环

本规范只定义跨 Skill 的稳定边界：业务实体必须重新按 `family_id` 读取；continuation 只恢复能力和紧凑上下文，不能替代下一次草稿审批；拒绝、取消或失败不得自动生成下一份草稿，也不得把前一阶段成功误报为整个目标已完成。

具体触发条件、reason code、state 字段、卡片文案与接收方步骤属于来源和目标 Skill 的 `SKILL.md` 或 `references/workflows.md`。字段合法性的最终真相源仍是 draft tool JSON Schema、Pydantic state schema 和 `skill.yaml` handoff 声明，不在本文件重复维护。

| 闭环 | 来源与步骤真相 | 接收方与步骤真相 |
| --- | --- | --- |
| 购物完成后入库 | `shopping-list` workflow | `inventory-analysis` 或 `food-profile` Skill |
| 做菜缺料转购物 | `recipe-cook` Skill | `shopping-list` Skill |
| 餐食记录可选扣成品库存 | `meal-record` Skill | 同一 `meal_log` 审批事务 |
| 当前消息图片绑定 | `recipe-draft`、`meal-record`、`food-profile`、`ingredient-profile` Skill | 既有 media service 绑定 |
| 冰箱照片或小票入库 | `inventory-analysis` Skill | `ingredient-profile` 补档后恢复库存流程 |
| 库存餐食想法 | `meal-planning` Skill | `recipe-draft` Skill |

修改上述闭环时，同一 PR 必须同步更新来源与目标 Skill 文档、`skill.yaml` handoff、state schema/draft tool、相关 `ai_infra` 测试与评测 case；任何一个环节不一致都不能以 prompt 兜底。

## 10. 稳定接口

以下接口属于前后端共享契约，修改时必须同步后端测试、前端 AI workspace contract 和 UI 渲染：

- Skill keys：`inventory_analysis`、`ingredient_profile`、`meal_plan`、`shopping_list`、`meal_log`、`recipe_draft`、`recipe_cook`、`food_profile`
- `workspace_orchestrator` run agent key；`meal_plan`、`multi_skill`、`general_chat` 等 run intent
- `today_recommendation`、`inventory_summary` 等结果卡片类型
- `operation_result` 的安全投影、Draft-keyed 卡片/part/artifact ID、fresh `server_now`、`cache_scopes` 和审批失败恢复信息中的 `currentValue`、`recoveryHint`
- `recipe`、`ingredient_profile`、`shopping_list`、`shopping_intake`、`meal_plan`、`meal_log`、`food_profile`、`recipe_cook`、`inventory_operation`、`composite_operation` 草稿类型
- `AIChatResponse`、消息 parts、`human_input_request`、SSE `message_delta` 和 progress 事件格式
- `approval_policy` 的 `none`、`draft_then_confirm`、`draft_then_policy` 语义，以及 member preference、family policy、consent notice 与五个 action key
- `POST /api/ai/operations/{operation_id}/revert` 的幂等请求、HTTP 结果替换、稳定错误和一小时 inclusive 边界
- 人工审批、服务端策略提交、`pending_retry`、拒绝和正式写入行为

`composite_operation` 属于正式 draft / approval 合同，但当前不属于任何 Skill 的 `draft_types`，也不开放给模型直接生成。后续如需开放，必须先新增专用组合 draft tool，由 tool 负责把已校验的基础草稿组合为复合审批。

### 主 AI 会话所有权与公开协作

- 主 AI 持久化会话默认归创建者私有；家庭 Owner 不自动获得查看权。
- 创建者可将会话公开给当前家庭。公开后家庭成员可继续对话和处理审批，但只有创建者可取消公开或删除。
- 所有消息、运行、审批和调试接口必须从子资源反查会话并执行相同权限校验。
- 同一会话只允许一个活动 run；不同会话允许并行，前端状态必须按 conversation/run 隔离。
- 做菜页继续使用 `persist_history=false`，不进入主 AI 历史与公开机制。

## 11. 测试要求

### Skill 评估与发布门禁

- 新增或修改 Skill、Tool、handoff、草稿类型或附件策略时，必须在同一 PR 更新 `backend/tests/ai_evals/cases/core.jsonl` 的合成场景。
- 评估用例只能使用家庭中性的合成数据，不得包含生产家庭名、成员名、图片、Token 或持久实体 ID。
- 修改既有用例必须在 PR 描述中记录原因。降低 `backend/ai_eval_thresholds.json` 的阈值需要审阅者明确批准，并附修改前后的报告。
- 阻塞 PR 的 `scripted` 评估不得调用付费或非确定性 Provider；`real_provider` 观察使用相同报告结构，只用于趋势复核，不能替代或阻塞确定性门禁。
- 评估报告必须保留分子、分母和四位小数率；空分母返回 `null`，不能解释为 0% 或 100%。

核心验收：

1. Registry 加载 catalog 中声明的 Skill，并且不把结果卡片类型注册为 Skill。
2. `meal_plan.output_types` 包含 `today_recommendation`。
3. 快捷任务和自然语言即时推荐都执行 `meal_plan`，返回推荐卡片且不创建草稿。
4. 正式餐食计划创建 `meal_plan` 草稿并进入服务端 commit gate；只有命中 `meal_plan.simple_create` 白名单的低风险新增可按已开启策略免确认。
5. `meal_plan -> shopping_list` 组合执行和 artifact 传递正常。
6. 未声明工具、非法卡片和非法草稿会被 Runtime 拒绝。
7. 所有草稿类型通过 commit gate 后能由共享 `DraftCommitCoordinator` 写入对应业务实体；人工确认和策略免确认保持同一领域语义与幂等事实。
8. 工具调用期间的可见文本保持真实流式输出并按块换行。
9. 后端和前端卡片、草稿类型契约保持一致。
10. 库存查询不创建草稿；入库、消耗和销毁必须生成 `inventory_operation` 草稿并等待确认。
11. 库存操作只能引用当前家庭真实食材和库存批次，消费量与销毁量分开记录。
12. 家庭库存查询可以同时展示食材库存和成品/速食食物库存；食材库存写操作仍走 `inventory_operation`，成品/速食库存字段属于 `food_profile`，包括 `stock_quantity`、`stock_unit`、`expiry_date` 和 `storage_location`，不能把食物库存伪装成食材库存批次。

推荐命令：

```bash
npm run backend:test:ai
CULINA_AI_EVAL_REPORT_PATH=.artifacts/ai-skill-eval-report.json npm run backend:test:ai-evals
npm run backend:check:ai-evals
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```
