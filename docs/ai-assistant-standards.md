# AI 助手规范

更新时间：2026-06-16

本文档定义 Culina AI 助手、Skill 机制、Tool 权限、草稿审批和前后端稳定协议。AI 助手是家庭饮食管理的受控辅助能力，不是拥有直接写权限的自由代理。

## 1. 文档定位

Culina AI 工作台由 Planner、Skill Runtime、Tool、Skill Script、LangGraph 和业务 Service 组成：

- Planner 选择一个或多个 Skill。
- `ToolCallingSkill` 加载 `SKILL.md` 并驱动模型调用白名单工具。
- Tool 提供家庭范围内的业务读取和草稿校验能力。
- Skill Script 提供不访问业务状态的确定性计算能力，并以 `script.*` 工具暴露给模型。
- LangGraph 负责多 Skill 顺序执行与审批中断。
- Service 在用户确认后执行正式业务写入。

AI 结果必须基于当前家庭上下文。没有家庭上下文时，不能返回库存、餐食计划、推荐、购物清单或家庭成员相关内容。

## 2. 核心原则

1. `SKILL.md` 是 Skill 的入口和元数据真源。
2. 所有 Skill 使用统一的 `ToolCallingSkill` Runtime。
3. Skill 只能调用 `allowed_tools` 中声明的工具。
4. 模型不能接触 `write` 工具。
5. 正式写入必须经过 `draft -> approval -> commit`。
6. 草稿必须来自 draft tool 的校验结果，不能由模型在最终 JSON 中直接伪造。
7. Planner 只选择 Skill，不负责抽取业务参数或执行工具。
8. 即时推荐和正式餐食计划由同一个 `meal_plan` Skill 根据请求模式处理。
9. 对外响应使用 `AIChatResponse`、消息 part、卡片、草稿和审批 DTO。
10. Script 只能做纯计算；数据库读取、草稿创建和正式写入必须使用 Tool。

## 3. 目录与职责

```text
backend/app/ai/
  planning/        # Planner 与路由决策
  workflows/       # LangGraph 状态、runner、checkpoint
  skills/          # Skill loader、registry、runtime、script worker
  tools/           # Tool registry、executor、schemas、validation
  images/          # AI 图片生成任务
  kitchen/         # 厨房上下文和菜谱草稿能力
  workspace_service.py
```

Skill catalog：

```text
backend/app/ai/skills/catalog/
  food-profile/
  inventory-analysis/
  meal-planning/
  meal-record/
  recipe-draft/
  shopping-list/
```

存在真实分支复杂度的 Skill 可以使用 `workflows.md`。简单 Skill 的流程、确认规则和边界直接写在 `SKILL.md` 中。

## 4. `SKILL.md` 格式

每个 `SKILL.md` 由 YAML frontmatter 和 Markdown 正文组成：

```yaml
---
name: meal-planning
key: meal_plan
display_name: 餐食计划
description: 处理即时餐食推荐以及餐食计划的创建和修改。
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
can_continue_from:
  - meal_plan
intent: meal_plan
agent_key: meal_plan_agent
examples:
  - 今晚吃什么？
  - 安排三天晚餐。
---
```

字段要求：

- `name`：目录 slug，必须与目录名一致。
- `key`：Planner 和 Runtime 使用的稳定 Skill key。
- `display_name`：进度事件中的用户可见名称。
- `description`：Planner 使用的路由摘要，必须明确适用和不适用范围。
- `allowed_tools`：模型可以调用的工具白名单。
- `script_files`：模型可以调用的 Skill 私有脚本白名单；公开函数以 `script.<函数名>` 暴露。
- `context_policy`：提供给 Planner 和诊断接口的上下文标签，不触发 Runtime 自动预读。
- `output_types`：允许返回的结果卡片类型。
- `draft_types`：允许返回的草稿类型。
- `approval_policy`：`none` 或 `draft_then_confirm`。
- `can_continue_from`：允许接续处理的 artifact 类型。
- `intent`、`agent_key`：运行记录中的稳定标识。
- `examples`：Planner 路由示例。

Runner 固定为 `toolcall`。确认要求由 `approval_policy`、`draft_types` 和 draft tool 的 `requires_confirmation` 联合确定。

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

- 即时推荐模式：触发语义包括“今天吃什么”“今晚吃什么”“推荐一餐”；返回 `today_recommendation` 卡片；不调用 `meal_plan.create_draft`；不创建草稿或审批。
- 正式计划模式：触发语义包括“安排、制定、生成、修改餐食计划”；用户给出日期、天数或餐别范围时也进入该模式；调用 `meal_plan.create_draft`；返回 `meal_plan` 草稿并中断等待确认。

`quick_task=today_recommendation` 必须路由到 `meal_plan`，`today_recommendation` 只作为结果卡片类型使用。

## 6. Planner 与 Runtime

Planner 位于 `backend/app/ai/planning/planner.py`。

Planner 输入完整对话和 `SkillManifest.to_planner_record()`，输出最多 4 个有序 Skill key。Planner 不负责判断 create、modify 或 derive 参数，不调用 Tool，不创建草稿，也不直接回答用户问题。

Runtime 加载流程：

1. `SkillDirectoryLoader` 扫描 `catalog/*/SKILL.md`。
2. 解析 frontmatter 并构建 `SkillManifest`。
3. 加载 `SKILL.md` 正文。
4. 如果同目录存在 `workflows.md`，按约定自动追加。
5. 校验 `script_files`，从公开函数签名生成模型 Tool Schema。
6. 创建统一的 `ToolCallingSkill`。

`ToolCallingSkill` 负责暴露工具白名单、执行脚本和业务 Tool、捕获 draft tool 的真实输出、校验卡片类型、草稿类型和最终结构化结果。

流式双通道协议：

```text
<visible_text>用户可见文本</visible_text>
<structured_result>{SkillResult JSON}</structured_result>
```

Runtime 必须避免把 structured result 或重复 fallback 文本发送给用户。

## 7. Tool、Script 与权限

Tool 注册在 `backend/app/ai/tools/catalog/`。

工具副作用：

- `read`：读取家庭范围内的业务数据。
- `draft`：校验并归一化草稿，不写正式业务表。
- `write`：正式写入能力，不暴露给模型。

`SkillExecutor` 根据 `approval_policy` 创建 Tool 作用域：

- `none`：只允许 `read`。
- `draft_then_confirm`：允许 `read` 和 `draft`。

Script 约束：

- `script_files` 路径必须位于所属 Skill 的 `scripts/` 目录。
- 只暴露不以下划线开头的同步函数。
- 输入和输出都必须通过 JSON Schema 校验并可 JSON 序列化。
- 脚本在独立的 `python -I` 子进程执行，默认超时 2 秒。
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
  -> Runtime 捕获 Tool 输出
  -> WorkspaceGraphRunner 持久化 AITaskDraft
  -> 创建 AIApprovalRequest
  -> LangGraph interrupt
  -> 用户确认
  -> AIApplicationService 执行正式写入
  -> 记录 AIOperation
```

用户确认后由 Service 执行正式写入，模型不参与 commit 决策。HITL 规则由 `SKILL.md`、draft tool、`SkillExecutor` 和 LangGraph 共同约束：`SKILL.md` 描述何时生成草稿，draft tool 负责校验草稿，`SkillExecutor` 和 LangGraph 负责审批中断。

## 9. 稳定接口

以下接口属于前后端共享契约，修改时必须同步后端测试、前端 AI workspace contract 和 UI 渲染：

- Skill keys：`inventory_analysis`、`ingredient_profile`、`meal_plan`、`shopping_list`、`meal_log`、`recipe_draft`、`recipe_cook`、`food_profile`
- `meal_plan_agent` 和 `meal_plan` intent
- `today_recommendation`、`inventory_summary` 等结果卡片类型
- `recipe`、`ingredient_profile`、`shopping_list`、`meal_plan`、`meal_log`、`food_profile`、`recipe_cook`、`inventory_operation`、`composite_operation` 草稿类型
- `AIChatResponse`、消息 parts、SSE `message_delta` 和 progress 事件格式
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

推荐命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```
