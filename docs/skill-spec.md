# Culina AI Skill 机制规范

## 1. 文档定位

本文档定义 Culina AI 工作台当前使用的 Skill 目录、运行时、工具权限和审批规则。

Skill 是由 `SKILL.md` 驱动的受控任务能力包：

- Planner 选择 Skill。
- `ToolCallingSkill` 加载说明并驱动模型调用工具。
- Tool 提供业务读取和草稿校验能力。
- Skill Script 提供不访问业务状态的确定性计算能力，并以 `script.*` 工具暴露给模型。
- LangGraph 负责多 Skill 顺序执行与审批中断。
- Service 在用户确认后执行正式业务写入。

## 2. 核心原则

1. `SKILL.md` 是 Skill 的入口和元数据真源。
2. Skill 目录不包含 `manifest.json` 或业务 `skill.py`。
3. 所有 Skill 使用统一的 `ToolCallingSkill` Runtime。
4. Skill 只能调用 `allowed_tools` 中声明的工具。
5. 模型不能接触 `write` 工具。
6. 正式写入必须经过 `draft -> approval -> commit`。
7. 草稿必须来自 draft tool 的校验结果，不能由模型在最终 JSON 中直接伪造。
8. Planner 只选择 Skill，不负责抽取业务参数或执行工具。
9. 即时推荐和正式餐食计划由同一个 `meal_plan` Skill 根据请求模式处理。
10. 对外继续使用现有 `AIChatResponse`、消息 part、卡片、草稿和审批 DTO。
11. Script 只能做纯计算；数据库读取、草稿创建和正式写入仍必须使用 Tool。

## 3. 当前目录

```text
backend/app/ai/skills/
  base.py
  executor.py
  loader.py
  registry.py
  script_worker.py
  scripts.py
  shared.py
  toolcall.py
  catalog/
    food-profile/
      SKILL.md
    inventory-analysis/
      SKILL.md
    meal-planning/
      SKILL.md
      scripts/
        validate_meal_plan.py
        render_plan_preview.py
      workflows.md
    meal-record/
      SKILL.md
    recipe-draft/
      SKILL.md
    shopping-list/
      SKILL.md
      scripts/
        merge_ingredients.py
        normalize_ingredient.py
      workflows.md
```

只有存在真实分支复杂度的 Skill 才保留 `workflows.md`。简单 Skill 的流程、确认规则和边界直接写在 `SKILL.md` 中。

需要稳定计算、归一化、合并或结构检查时，可以在 Skill 的 `scripts/` 中提供纯函数。涉及数据库、网络、文件读写、草稿持久化或审批的逻辑不能放入 Script。

## 4. `SKILL.md` 格式

每个文件由 YAML frontmatter 和 Markdown 正文组成：

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

字段含义：

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
- `can_continue_from`：允许继续处理的历史 artifact 类型。
- `intent`、`agent_key`：运行记录中的稳定标识。
- `examples`：Planner 路由示例。

以下字段不再使用：

- `runner`
- `version`
- `category`
- `risk_level`
- `forbidden_tools`
- `requires_confirmation`
- `workflow_files`
- `hitl_files`
- `example_files`
- `output_contract`

Runner 固定为 `toolcall`。确认要求由 `approval_policy`、`draft_types` 和 draft tool 的 `requires_confirmation` 联合确定。

## 5. Skill 职责矩阵

| Skill key | 职责 | 卡片 | 草稿 |
| --- | --- | --- | --- |
| `inventory_analysis` | 库存、临期、低库存查询 | `inventory_summary` | 无 |
| `meal_plan` | 即时餐食推荐；餐食计划创建和修改 | `today_recommendation` | `meal_plan` |
| `shopping_list` | 独立购物清单、从计划派生、修改清单 | 无 | `shopping_list` |
| `meal_log` | 记录已经发生的用餐 | 无 | `meal_log` |
| `recipe_draft` | 创建结构化菜谱草稿 | 无 | `recipe` |
| `food_profile` | 创建或补全食物资料 | 无 | `food_profile` |

### 5.1 即时推荐与正式计划

`meal_plan` 有两个互斥模式。

即时推荐模式：

- 触发语义包括“今天吃什么”“今晚吃什么”“推荐一餐”。
- `quick_task=today_recommendation` 必须确定性路由到 `meal_plan`。
- 返回 `today_recommendation` 卡片。
- 不调用 `meal_plan.create_draft`。
- 不创建草稿或审批。

正式计划模式：

- 触发语义包括“安排、制定、生成、修改餐食计划”。
- 用户给出日期、天数或餐别范围时也进入该模式。
- 调用 `meal_plan.create_draft`。
- 返回 `meal_plan` 草稿并中断等待用户确认。

`today_recommendation` 不再是独立 Skill key，但 `quick_task=today_recommendation` 和 `today_recommendation` 卡片类型继续作为兼容协议保留。

## 6. Planner

Planner 位于：

```text
backend/app/ai/planning/planner.py
```

Planner 输入完整对话和 `SkillManifest.to_planner_record()`，输出最多 4 个有序 Skill key。

Planner 不负责：

- 判断具体 create、modify 或 derive 参数。
- 调用 Tool。
- 创建草稿。
- 回答用户问题。

普通聊天返回空 Skill 列表。`WorkspaceGraphRunner` 对 `quick_task=today_recommendation` 使用确定性 `["meal_plan"]` 计划，避免快捷入口依赖模型猜测。

## 7. Runtime

加载流程：

1. `SkillDirectoryLoader` 扫描 `catalog/*/SKILL.md`。
2. 解析 frontmatter 并构建 `SkillManifest`。
3. 加载 `SKILL.md` 正文。
4. 如果同目录存在 `workflows.md`，按约定自动追加。
5. 校验 `script_files`，从公开函数签名生成模型 Tool Schema。
6. 创建统一的 `ToolCallingSkill`。

frontmatter 不会重复注入模型提示词。

`ToolCallingSkill`：

- 向模型暴露当前 Skill 的工具白名单和 JSON Schema。
- 将声明的公开脚本函数与业务 Tool 一起暴露给模型。
- 支持工具调用前、调用间和调用后的可见文本流式输出。
- 捕获 draft tool 的真实输出作为草稿。
- 校验卡片类型、草稿类型和最终结构化结果。

流式双通道协议：

```text
<visible_text>用户可见文本</visible_text>
<structured_result>{SkillResult JSON}</structured_result>
```

每个可见文本块结束时输出换行。Runtime 会避免将 structured result 或重复 fallback 文本发送给用户。

### 7.1 Script Runtime

Script 调用协议：

```text
script.validate_meal_plan({"plan": [...]})
  -> {"result": {"valid": true, "errors": []}}
```

约束：

- `script_files` 路径必须位于当前 Skill 的 `scripts/` 目录。
- 只暴露不以下划线开头的同步函数。
- 函数参数和返回类型由 Python 类型注解转换为 JSON Schema。
- 输入和输出都必须通过 JSON Schema 校验并可 JSON 序列化。
- 脚本在独立的 `python -I` 子进程执行，默认超时 2 秒。
- 加载阶段拒绝未授权 import、`open`、`eval`、`exec`、`compile`、`input`、`__import__`、装饰器和可执行顶层语句。
- Script 不接收数据库 Session、家庭上下文、Token 或 ToolExecutor。
- 每次调用记录为 `permission=skill:script`、`side_effect=read`，并产生统一 progress 事件。
- 同一 Skill 内公开函数名不能重复。

Script Runtime 是受限的进程隔离执行器，不替代系统级容器沙箱。因此只允许提交到代码库并经过评审的脚本，不接受用户上传或模型生成的任意 Python 源码。

## 8. Tool 与 Script 权限

Tool 注册在：

```text
backend/app/ai/tools/catalog/
```

工具副作用：

- `read`：读取家庭范围内的业务数据。
- `draft`：校验并归一化草稿，不写正式业务表。
- `write`：正式写入能力，不暴露给模型。

`SkillExecutor` 根据 `approval_policy` 创建 Tool 作用域：

- `none`：只允许 `read`。
- `draft_then_confirm`：允许 `read` 和 `draft`。

Script 固定为纯计算 `read` 能力，不进入全局 ToolRegistry，也不受 `approval_policy` 扩权。模型只能看到当前 Skill 在 `script_files` 中声明的函数。

购物清单草稿工具统一使用：

```text
shopping.create_draft
```

旧别名 `shopping_list.create_draft` 已移除。

## 9. 草稿与审批

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

用户确认后不再次调用模型判断。

HITL 规则没有移入 Script。`SKILL.md` 描述何时生成草稿，draft tool 负责校验草稿，`SkillExecutor` 和 LangGraph 负责审批中断，用户确认后由 Service 正式写入。Script 只能在进入 draft tool 前辅助校验或整理参数。

## 10. 稳定协议

内部优化不得改变：

- Skill keys：`inventory_analysis`、`meal_plan`、`shopping_list`、`meal_log`、`recipe_draft`、`food_profile`
- `meal_plan_agent` 和 `meal_plan` intent
- `today_recommendation`、`inventory_summary` 等结果卡片类型
- `recipe`、`shopping_list`、`meal_plan`、`meal_log`、`food_profile` 草稿类型
- `AIChatResponse`、消息 parts、SSE `message_delta` 和 progress 事件格式
- 审批、重试、拒绝和正式写入行为

## 11. 测试要求

最低验收：

1. Registry 只加载 6 个 Skill，不包含 `today_recommendation` key。
2. `meal_plan.output_types` 包含 `today_recommendation`。
3. 快捷任务和自然语言即时推荐都执行 `meal_plan`，返回推荐卡片且不创建草稿。
4. 正式餐食计划仍创建 `meal_plan` 草稿和审批。
5. `meal_plan -> shopping_list` 组合执行和 artifact 传递正常。
6. 未声明工具、非法卡片和非法草稿会被 Runtime 拒绝。
7. 五种草稿确认后能写入对应业务实体。
8. 工具调用期间的可见文本保持真实流式输出并按块换行。
9. 后端和前端卡片、草稿类型契约保持一致。

验证命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```
