# AI 助手规范

更新时间：2026-07-10

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
- `backend/app/services/ai_operations/` 承载审批确认后的领域写入、草稿归一化、恢复信息、结果卡片和组合操作执行。

AI 结果必须基于当前家庭上下文。没有家庭上下文时，不能返回库存、餐食计划、推荐、购物清单或家庭成员相关内容。

## 2. 核心原则

1. `SKILL.md` 是标准 Skill 入口，`skill.yaml` 是 Culina runtime contract。
2. 工作台路径统一使用 `WorkspaceOrchestratorAgent`；不再保留旧 Planner 或单 Skill runtime。
3. 主 agent 只能调用基础工具和已注入 Skill 的 `allowed_tools` / scripts。
4. 模型不能接触 `write` 工具。
5. 正式写入必须经过 `draft -> approval -> commit`。
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
  workspace_service.py  # AIApplicationService 应用门面

backend/app/services/ai_operations/
  approvals / drafts / executor / recovery / messages / artifacts
  inventory / recipe_cook / recipes / meal_plans / shopping / meal_logs
  foods / ingredients / composite
```

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
- `skill.yaml:approval_policy`：`none` 或 `draft_then_confirm`。
- `skill.yaml:intent`、`skill.yaml:agent_key`：兼容诊断标识；默认 run 的 `agent_key` 为 `workspace_orchestrator`，`intent` 由注入 Skill 推导。
- `skill.yaml:examples`：保留的用户示例；v3 的机器路由边界以 `routing` 为准。
- `skill.yaml:routing`：必须提供非空 `modes`、`include_examples`、至少三个 `exclude_examples` 和 `conflict_rules`；include/exclude 不得重叠。
- `skill.yaml:handoffs`：按 reason code 声明 `target_skill`、`required_draft_type`、`resume_skill` 和 `state_schema`。Registry 构建时校验目标/恢复 Skill、目标草稿类型和 continuation state schema，任一引用无效都启动失败。
- `skill.yaml:attachment_policy`：声明可接受附件类型、用途和可绑定字段。只有 `food_profile`、`ingredient_profile`、`recipe_draft`、`meal_log` 可以绑定图片；绑定必须限定当前消息并要求用户有明确意图。

`SKILL.md` frontmatter 不放 Culina runtime 字段，例如 `allowed_tools`、`script_files`、`output_types`、`draft_types`、`approval_policy`、`intent`、`agent_key`。这些字段必须进入 `skill.yaml`。

Runner 固定为 `toolcall`。确认要求由 `approval_policy`、`draft_types` 和 draft tool 的 `requires_confirmation` 联合确定。

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
| `shopping_list` | 独立购物清单、从计划派生、修改清单 | 无 | `shopping_list` |
| `meal_log` | 记录已经发生的用餐 | 无 | `meal_log` |
| `recipe_draft` | 创建、更新、删除和收藏菜谱草稿 | 无 | `recipe` |
| `food_profile` | 创建、更新或收藏食物资料 | 无 | `food_profile` |
| `ingredient_profile` | 创建或更新食材档案 | 无 | `ingredient_profile` |
| `recipe_cook` | 预览并确认做菜、库存扣减和计划完成 | 无 | `recipe_cook` |

### 即时推荐与正式计划

`meal_plan` 有两个互斥模式：

- 即时推荐模式：触发语义包括“今天吃什么”“今晚吃什么”“推荐一餐”；调用明确返回 `card` 的推荐工具产出 `today_recommendation` 卡片；不调用 `meal_plan.create_draft`；不创建草稿或审批。
- 正式计划模式：触发语义包括“安排、制定、生成、修改餐食计划”；用户给出日期、天数或餐别范围时也进入该模式；调用 `meal_plan.create_draft`；返回 `meal_plan` 草稿并中断等待确认。

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
- `write` 工具永远不暴露给模型。

Script 约束：

- `script_files` 路径必须位于所属 Skill 的 `scripts/` 目录。
- 只暴露不以下划线开头的同步函数。
- 输入和输出都必须通过 JSON Schema 校验并可 JSON 序列化。
- 脚本在独立的 `python -I` 子进程执行，默认超时 5 秒。
- 加载阶段拒绝未授权 import、`open`、`eval`、`exec`、`compile`、`input`、`__import__`、装饰器和可执行顶层语句。
- Script 不接收数据库 Session、家庭上下文、Token 或 ToolExecutor。
- Script 只能做纯计算，不访问数据库、网络、文件系统或正式业务写入能力。

## 8. 草稿与审批

草稿型 Skill 必须满足：

- `approval_policy: draft_then_confirm`
- 至少一个 `draft_types`
- 至少一个声明在 `allowed_tools` 中的 draft tool
- draft tool 自身设置 `requires_confirmation=True`

执行顺序：

```text
模型调用 draft tool
  -> Tool 校验并归一化草稿
  -> Orchestrator Runtime 捕获 Tool 输出
  -> WorkspaceGraphRunner 持久化 AITaskDraft
  -> 创建 AIApprovalRequest
  -> LangGraph interrupt
  -> 用户确认
  -> AIApplicationService 调用 services/ai_operations 执行正式写入
  -> 记录 AIOperation
  -> 追加 operation_result 卡片或结构化恢复信息
```

用户确认后由 Service 执行正式写入，模型不参与 commit 决策。HITL 规则由 `SKILL.md`、`skill.yaml`、draft tool、Orchestrator scoped runtime 和 LangGraph 共同约束：`SKILL.md` 描述何时生成草稿，draft tool 负责校验草稿，Orchestrator 和 LangGraph 负责审批中断与恢复。

审批失败或 stale `baseUpdatedAt` 冲突时，应返回结构化 `currentValue` 和 `recoveryHint` 供前端恢复。不要在审批链路末端静默重建草稿或自动改写用户提交值；需要恢复时必须保留原始失败原因，并让用户重新确认。

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

## 9. 稳定接口

以下接口属于前后端共享契约，修改时必须同步后端测试、前端 AI workspace contract 和 UI 渲染：

- Skill keys：`inventory_analysis`、`ingredient_profile`、`meal_plan`、`shopping_list`、`meal_log`、`recipe_draft`、`recipe_cook`、`food_profile`
- `workspace_orchestrator` run agent key；`meal_plan`、`multi_skill`、`general_chat` 等 run intent
- `today_recommendation`、`inventory_summary` 等结果卡片类型
- `operation_result` 结果卡片和审批失败恢复信息中的 `currentValue`、`recoveryHint`
- `recipe`、`ingredient_profile`、`shopping_list`、`meal_plan`、`meal_log`、`food_profile`、`recipe_cook`、`inventory_operation`、`composite_operation` 草稿类型
- `AIChatResponse`、消息 parts、`human_input_request`、SSE `message_delta` 和 progress 事件格式
- 审批、重试、拒绝和正式写入行为

`composite_operation` 属于正式 draft / approval 合同，但当前不属于任何 Skill 的 `draft_types`，也不开放给模型直接生成。后续如需开放，必须先新增专用组合 draft tool，由 tool 负责把已校验的基础草稿组合为复合审批。

## 10. 测试要求

核心验收：

1. Registry 加载 catalog 中声明的 Skill，并且不把结果卡片类型注册为 Skill。
2. `meal_plan.output_types` 包含 `today_recommendation`。
3. 快捷任务和自然语言即时推荐都执行 `meal_plan`，返回推荐卡片且不创建草稿。
4. 正式餐食计划创建 `meal_plan` 草稿和审批。
5. `meal_plan -> shopping_list` 组合执行和 artifact 传递正常。
6. 未声明工具、非法卡片和非法草稿会被 Runtime 拒绝。
7. 所有草稿类型确认后能写入对应业务实体。
8. 工具调用期间的可见文本保持真实流式输出并按块换行。
9. 后端和前端卡片、草稿类型契约保持一致。
10. 库存查询不创建草稿；入库、消耗和销毁必须生成 `inventory_operation` 草稿并等待确认。
11. 库存操作只能引用当前家庭真实食材和库存批次，消费量与销毁量分开记录。
12. 家庭库存查询可以同时展示食材库存和成品/速食食物库存；食材库存写操作仍走 `inventory_operation`，成品/速食库存字段属于 `food_profile`，包括 `stock_quantity`、`stock_unit`、`expiry_date` 和 `storage_location`，不能把食物库存伪装成食材库存批次。

推荐命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```
