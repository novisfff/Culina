# AI 助手 Agent Run Loop 改造设计

更新时间：2026-06-23

## 1. 背景与目标

当前 AI 工作台已经统一到 `WorkspaceOrchestratorAgent` 主路径，具备 Skill 注入、Tool 调用、草稿审批、SSE 流式文本、live message part 和 progressive draft publish 能力。progressive draft publish 已经能做到 draft tool 成功后立即把真实 `draft` / `approval_request` 插入对话，但它只解决了“展示晚”的问题，没有解决“AI 一口气连续做完多个动作”的体验问题。

现在的典型行为是：

```text
用户请求
  -> Orchestrator 一次 provider.generate_with_tools()
  -> 模型连续调用多个 tool / draft tool
  -> 后端逐个推送 draft / approval
  -> 最终 response
  -> 进入 waiting_approval
```

用户虽然能更早看到 draft，但 AI 仍然像一次性批处理，而不是像 Codex / OpenClaw 这类 agent 一样边理解、边调用工具、边输出进展、边根据结果继续推进。

本设计目标是把现有 run 改造成 **Agent Run Loop**：

- 一个用户请求仍然对应一个 `AIAgentRun`。
- 不新增用户可感知的 `run_step` 模式。
- 不在请求开始时强制分类 ordinary / step。
- 不先生成完整 TaskPlan。
- AI 在同一个 run 内按普通 agent loop 持续推进：观察上下文、调用工具、输出进度、发布草稿、遇到 approval 或 human input 时暂停，恢复后继续。
- 简单任务自然一轮完成；复杂任务自然多轮推进。
- 保持 Culina 的安全边界：模型只能读、算、生成草稿；正式写入仍必须 `draft -> approval -> commit`。

## 2. 核心结论

不要引入独立的 `run_step` 架构。更合适的方案是：

```text
WorkspaceGraphRunner._orchestrator_step()
  -> 调用 WorkspaceOrchestratorAgent.run()
  -> run() 每次只推进一个有边界的 next action
  -> 如果还要继续，返回 status=running
  -> LangGraph 现有 orchestrator -> orchestrator 循环继续下一轮
```

这里的关键不是新增 step 状态机，而是让现有 `run()` 从“尽量一次完成整个任务”改成“每轮推进一个 bounded next action”。

最终体验不是：

```text
Step 1 / Step 2 / Step 3
```

而是更自然的：

```text
我先看一下库存和最近的用餐记录。
[读取了库存和偏好]

我先生成三天晚餐计划草稿。
[已生成晚餐计划草稿]

接下来我根据这个计划整理购物清单。
[已生成购物清单草稿]
```

## 3. 非目标

本改造不引入模型直接写数据库的能力，不把 write tool 暴露给模型。

本改造不要求前端实现复杂任务树、甘特图、显式步骤列表或项目管理 UI。第一阶段只需要在现有对话流中呈现自然进展、工具活动、draft 卡片和 approval 状态。

本改造不以重做 `AIChatResponse`、`AiMessagePartDTO`、`AiApprovalRequestDTO` 为前提。第一阶段优先复用现有 SSE 事件和 message parts；当跨端恢复、approval 依赖展示或更稳定的进度 UI 需要时，可以按向后兼容原则增加可选字段或 included 数据。

## 4. 设计原则

### 4.1 一个 run，不分模式

所有用户请求都进入同一套 run loop。

```text
简单问答 = 一个 run，一轮完成
只读分析 = 一个 run，一轮或少数几轮完成
单 draft = 一个 run，生成 draft 后等待 approval
多 draft = 一个 run，确认一个 draft 后再继续生成下一个 draft
approval 后继续 = 同一个 run resume 后继续 loop
```

这样避免两套路径：

- 不需要在开始时判断 ordinary run 还是 run_step。
- 不需要维护两个 Orchestrator 语义。
- 不需要为分类错误做复杂升级/降级。
- 用户也不会感知“现在切到了另一个模式”。

### 4.2 不做完整 upfront planning

不建议在请求开始时让模型输出完整 TaskPlan。原因：

- 首屏等待变长。
- 输出 JSON 越长越容易 schema retry。
- 复杂家庭饮食任务经常依赖中间 tool 结果、approval 结果或用户补充信息，完整计划很容易过早承诺。
- Culina 的业务安全边界本来就要求运行时根据 draft、approval、commit 结果动态推进。

更好的方式是普通 agent loop：

```text
决定下一小步
执行这一小步
把结果写回上下文
再决定下一小步
```

### 4.3 每轮动作有预算

Agent loop 不等于无限自由循环。每轮 Orchestrator 调用必须有 action budget。

第一阶段建议：

- 每轮最多成功发布 1 个主要 draft。
- 每轮最多触发 1 个 human input request。
- 每轮允许多个 read tool 和 script，但要有 tool call 上限。
- 每轮可以输出短文本进度。
- 每个 run 有最大 agent round、最大 draft 数、最大 tool call 数。

这能保留 agent 的自然推进感，同时避免一次性连续生成多个 draft 或陷入工具循环。

### 4.4 Approval 是自然暂停点

draft tool 成功后就是硬暂停点：

- 只要本轮生成了 draft / approval，Runner 必须进入 `waiting_approval`。
- pending approval 期间不继续调用 Orchestrator 生成后续 draft。
- 如果复杂任务还没完成，Orchestrator 在 `state_patch.resumeAfterApproval` 写入确认后的下一步说明。
- 用户确认通过后，Runner 消费并清理 `resumeAfterApproval`，再把它作为 `resume_after_approval` artifact 交回 Orchestrator。

前端可以提前展示 approval，但提交能力必须由后端 run 状态和 pending approval 顺序决定。

### 4.5 进度表达靠对话流，不靠显式 step UI

用户想要的是“AI 正在工作”的感觉，不一定需要看到结构化 step timeline。

优先使用：

- `message_delta`：AI 的自然语言说明。
- `run_activity`：工具、读取、生成、校验等活动摘要。
- `message_part`：draft、approval、card 等结构化产物。

后续如果要做可靠 timeline，再扩展只读 DTO 或 included 数据。

## 5. Agent Run Loop 模型

### 5.1 Loop 形态

```text
initialize
  -> orchestrator_loop
      -> assemble context
      -> model next action
      -> stream text delta
      -> execute tools
      -> publish tool activity
      -> publish draft / approval if any
      -> persist result artifacts
      -> route:
          running -> orchestrator_loop
          waiting_approval -> approval_interrupt
          waiting_input -> human_input_interrupt
          completed -> finalize
```

当前 LangGraph 已经有 `orchestrator -> orchestrator` 的循环能力，因此第一阶段不需要大改图结构。重点是改变 `_orchestrator_step()` 中调用的 Orchestrator 语义。

### 5.2 每轮 next action

这里的 next action 不是新增 DB 表，也不是前端 step。它只是本轮模型要推进的一个小目标。

常见 next action：

- 直接回答一个问题。
- 读取库存、菜谱、最近用餐。
- 生成一个结果卡片。
- 生成一个 draft。
- 请求用户补充信息。
- 在 approval commit 后继续后续动作。
- 总结当前 run 并结束。

### 5.3 状态仍沿用现有 run status

不新增对外状态枚举。内部 loop 继续使用：

- `running`
- `waiting_approval`
- `waiting_input`
- `completed`
- `failed`
- `cancelled`

语义：

- `running`：本 run 还可以继续推进，Graph 会回到 orchestrator。
- `waiting_approval`：必须等待用户处理当前 pending approval。
- `waiting_input`：必须等待用户回答 human input。
- `completed`：run 已完成，无需继续。

## 6. Orchestrator 改造

### 6.1 `run()` 的新语义

保留方法名：

```python
WorkspaceOrchestratorAgent.run(...)
```

但语义从“完成整个任务”调整为：

```text
推进当前 run 的下一次 bounded agent action。
```

返回 `SkillResult`：

- `status="completed"`：任务完成。
- `status="running"`：本轮完成，但任务还可继续，Runner 应再次进入 orchestrator。
- `status="waiting_input"`：需要用户补充信息。
- `status="failed"` / `cancelled`：终止。
- 如果本轮生成 draft，Runner 根据 pending approval 和 barrier 判断是否进入 `waiting_approval` 或继续。

### 6.2 System prompt 改造

当前 prompt 倾向让模型完成整轮任务，需要改成 next-action 约束：

```text
你是 Culina AI 助手的受控 agent。
每次只推进一个下一步动作。

你可以：
- 解释当前要做什么；
- 调用 read tool 或 script 获取上下文；
- 生成一个 result card；
- 生成一个 draft；
- 请求用户补充信息；
- 在任务完成时总结。

限制：
- 本轮最多生成一个 draft。
- 生成 draft 后不要继续生成第二个 draft。
- 生成 draft 后如果任务还需要继续，在 `state_patch.resumeAfterApproval` 写清确认后的下一步。
- 没有生成 draft 的读取、分析或普通多步任务，才可以返回 `status=running` 继续下一轮。
- 不要声称已经正式写入；正式写入必须等用户确认后由系统执行。
```

### 6.3 Tool handler 预算

在 `WorkspaceOrchestratorAgent.run()` 内部增加 per-call budget：

```python
draft_created = False
human_input_requested = False
tool_call_count = 0
```

规则：

- read tool：允许调用，但计入 tool call 上限。
- script：允许调用，但计入 tool call 上限。
- `human.request_input`：本轮只允许一次，触发后立即返回 `waiting_input`。
- draft tool：本轮第一个 draft 成功后立即 progressive publish。
- 第二个 draft tool：不执行正式 draft 创建，返回可恢复错误给模型，要求结束本轮并等待当前 draft 确认。

伪代码：

```python
def call_tool(name, payload):
    nonlocal draft_created, human_input_requested, tool_call_count
    tool_call_count += 1
    ensure_budget(tool_call_count)

    definition = scoped_executor.registry.get(name)

    if name == "human.request_input":
        if human_input_requested:
            return {"error": "本轮已经请求过用户输入，请结束当前动作。"}
        human_input_requested = True
        raise HumanInputRequired(request)

    if definition.side_effect == "draft":
        if draft_created:
            return {
                "error": "本轮已经生成一个草稿。请结束当前动作，等待用户确认后再继续生成后续草稿。"
            }
        output = scoped_executor.call(name, payload)
        draft_created = True
        publish_draft(output)
        return output

    return scoped_executor.call(name, payload)
```

### 6.4 本轮是否继续

模型通过 structured result 返回 `status`。

建议约束：

- 本轮有 draft，且还有非阻塞后续动作：`status=running`。
- 本轮有 draft，后续依赖 commit：`status=completed` 或 `running` 均可，Runner 根据 barrier / pending approval 进入 `waiting_approval`。
- 本轮没有 draft，只是读和答复：可 `completed`。
- 本轮读完发现还要生成 draft：可 `running`，下一轮继续。

Runner 是最终裁判：只要有 pending approval 且当前不能继续，就进入 `waiting_approval`。

## 7. Draft 与 Approval Gate

### 7.1 Draft 发布

沿用 progressive draft publisher：

```text
draft tool success
  -> Tool 校验并归一化 payload
  -> 创建真实 AITaskDraft
  -> 创建 AIApprovalRequest
  -> 推送 draft message_part
  -> 推送 approval_request message_part
  -> 记录 draft.published artifact
```

最终持久化继续按 part id / draft id / approval id 去重，避免 structured result retry 或 loop retry 重复创建。

### 7.2 Draft 后续动作如何继续

每个 draft 都是硬暂停点：

| 当前动作 | 行为 |
| --- | --- |
| 生成第一个 draft | 立即进入 `waiting_approval` |
| 同轮尝试生成第二个 draft | tool handler 返回 `draft_budget_exhausted` |
| approval 通过且有 `resumeAfterApproval` | 回到 Orchestrator 继续下一步 |
| approval 通过但没有 `resumeAfterApproval` | 当前 run 完成 |
| approval 被拒绝 | 作为 `approval_decision` 工具结果回到 Orchestrator，由 AI 判断结束、调整重做或继续下一项 |

例子：

```text
安排三天晚餐，并整理购物清单
```

执行顺序：

```text
轮 1: 生成 meal_plan draft
进入 waiting_approval
用户确认，commit meal_plan
轮 2: 基于 resumeAfterApproval 和 commit 结果生成 shopping_list draft
进入 waiting_approval
```

例子：

```text
创建一道红烧牛肉菜谱，然后安排到明天晚餐
```

必须：

```text
轮 1: 生成 recipe draft -> waiting_approval
用户确认，commit recipe，得到 recipe_id
轮 2: 基于 recipe_id 生成 meal_plan draft -> waiting_approval
```

### 7.3 确认后继续的信息从哪里来

第一阶段不做完整计划，但 draft 之后如果任务还没完成，需要把确认后的下一步写成短提示。

来源：

1. Orchestrator 根据当前用户目标、tool 结果和已生成 draft 决定是否需要继续。
2. 如果需要继续，在 structured result 的 `state_patch.resumeAfterApproval` 写下一步。
3. Runner 在 approval 通过后消费并清理该字段，作为 `resume_after_approval` artifact 传给下一次 Orchestrator。

建议内部 state patch：

```json
{
  "state_patch": {
    "resumeAfterApproval": {
      "instruction": "确认餐食计划后，继续根据计划生成购物清单草稿。",
      "nextDraftType": "shopping_list"
    }
  }
}
```

这不是前端 DTO。它只帮助 Runner 在 approval 通过后决定是否回到 Orchestrator。

保守规则：

- 只要生成 draft，就必须等待 approval。
- approval 被拒绝时不写入正式业务数据，但不在 Runner 里强制停止；拒绝结果回到 Orchestrator 后由 AI 判断是否继续。
- approval 通过且存在 `resumeAfterApproval` 时优先继续。
- 如果无法判断后续动作，默认不写 `resumeAfterApproval`，让本 run 在 commit 后完成。

### 7.4 Approval 提交顺序

前端可以展示多个 pending approvals，但提交能力必须受控：

- run 仍在 `running`：approval 可查看，不可提交。
- run 进入 `waiting_approval`：只允许当前第一个 pending approval 提交。
- 后续 pending approval 可查看，但显示“等待前一个确认”。
- 后端提交接口必须校验当前 `pending_approval_id`，不能只依赖前端禁用按钮。

后续如果需要明确表达依赖，可增加可选字段：

- `dependsOnApprovalIds`
- `submitState`
- `blockedReason`

这些字段必须向后兼容。

## 8. Human Input Gate

`human.request_input` 是另一个自然暂停点。

行为：

```text
模型发现信息不足
  -> 调用 human.request_input
  -> Runner 持久化 pendingHumanInput
  -> run.status = waiting_input
  -> 前端展示问题
  -> 用户回答
  -> resume_human_input
  -> 写入 human.input_result artifact
  -> run.status = running
  -> 回到 orchestrator loop
```

约束：

- 一个 Orchestrator 轮次最多触发一次 human input。
- human input 只收集信息，不代表批准写入。
- 用户回答后，模型可以继续读取、生成 draft 或结束。

## 9. Loop Guard

普通 agent loop 必须有防护，否则模型可能重复读同一个工具或反复生成相同草稿。

### 9.1 Run 级预算

建议默认：

```text
max_agent_rounds = 8
max_total_tool_calls = 32
max_drafts_per_run = 5
max_same_tool_calls = 3
```

超过预算时：

- 如果已有 pending approval：进入 `waiting_approval`。
- 如果已有可展示结果：总结当前已完成部分并 `completed`。
- 如果没有有效产物：`failed`，提示用户缩小任务范围。

### 9.2 重复工具检测

记录 tool signature：

```text
tool_name + normalized_payload_hash
```

如果同一 run 内重复调用同一 read tool 且结果没有变化：

- 第一次允许。
- 后续给模型返回提示：已有相同工具结果，请基于现有结果继续。
- 超过阈值终止本轮，避免循环。

### 9.3 重复 draft 检测

draft 去重键：

```text
run_id + draft_type + normalized_payload_hash
```

如果同一 run 内出现相同 draft：

- 复用已有 draft / approval。
- 不重复推送 message part。
- 在 structured result retry 时保持幂等。

## 10. Runner 改造设计

### 10.1 图结构

当前图可基本保留：

```text
initialize
  -> orchestrator
  -> approval_interrupt
  -> human_input_interrupt
  -> finalize
```

关键是 `_route_after_orchestrator()`：

```python
if state.status == "waiting_approval":
    return "approval_interrupt"
if state.status == "waiting_input":
    return "human_input_interrupt"
if state.status == "running":
    return "orchestrator"
return "finalize"
```

也就是继续利用已有 `orchestrator -> orchestrator` 循环。

### 10.2 `_orchestrator_step()`

当前 `_orchestrator_step()` 做的事情很多，第一阶段不需要拆成新模式，只需要增强 loop 状态：

```python
def _orchestrator_step(state):
    if cancel_requested:
        return {"status": "cancelled"}

    if has_pending_human_input:
        return {"status": "waiting_input", ...}

    if has_pending_approval and not can_continue_before_approval(state):
        return {"status": "waiting_approval", ...}

    result = WorkspaceOrchestratorAgent(...).run(
        context,
        run_loop_budget=budget_from_state(state),
        run_artifacts=state.run_artifacts,
    )

    persist_result(result)
    update_artifacts(result)

    if result.status == "waiting_input":
        return waiting_input

    if should_wait_for_approval(state, result):
        return waiting_approval

    if result.status == "running" and budget_remaining:
        return running

    return final_status
```

### 10.3 Approval resume

当前 approval resume 后已经能回到 orchestrator。改造后语义更明确：

```text
apply approval decision
  -> 写入 approval_decision artifact
  -> 如果 conversation.context.taskState.resumeAfterApproval 存在：消费并清理，写入 resume_after_approval artifact，Graph 回到 orchestrator loop
  -> 如果没有 resumeAfterApproval：completed
```

拒绝策略：

- 单 draft 任务：通常由 Orchestrator 输出“不会写入，可继续调整或重新整理”，然后完成。
- 多 draft 任务：Orchestrator 根据用户原始目标、拒绝原因和后续依赖判断是否跳过当前项、重新生成当前项或继续下一项。
- 不要在拒绝后静默提交任何业务写入；如果要继续生成草稿，仍必须走新的 draft approval。

## 11. Orchestrator Structured Result 调整

不需要完整 TaskPlan，但需要让模型告诉 Runner：没有 draft 的普通动作是否继续，以及 draft 确认后是否还有下一步。

建议内部 structured result 使用已有 `state_patch`：

```json
{
  "status": "running|completed|failed",
  "text": "...",
  "cards": [],
  "drafts": [],
  "state_patch": {
    "resumeAfterApproval": {
      "instruction": "确认餐食计划后，继续根据计划生成购物清单草稿。",
      "nextDraftType": "shopping_list"
    }
  }
}
```

兼容策略：

- 没有 draft 且 `status=running`：Runner 可继续 loop。
- 有 draft：无论 `status` 是 `running` 还是 `completed`，Runner 都进入 `waiting_approval`。
- 有 draft 且写入 `state_patch.resumeAfterApproval`：只在 approval 通过后继续。
- Runner 会在消费后清理 `resumeAfterApproval`，避免重复执行同一后续动作。

## 12. 前端体验设计

### 12.1 对话流

前端继续消费现有事件：

- `message_delta`
- `message_part`
- `run_activity`
- `response`

需要优化的是渲染体验：

- activity 不要像 debug log，要像“AI 做了什么”的轻量摘要。
- draft / approval 出现后不要等最终 response。
- running 状态下 approval 可展开查看但不可提交。
- waiting_approval 状态下只允许当前 approval 提交。

### 12.2 活动文案

建议由后端按工具和状态生成稳定文案：

```text
正在读取库存和偏好
读取了 12 个可用食材
正在生成晚餐计划草稿
已生成晚餐计划草稿
正在整理购物清单
已生成购物清单草稿
等待你确认晚餐计划
```

避免把 provider 原始工具名直接暴露给用户，除非前端有对应的中文 label。

### 12.3 Work-in-progress 文本

AI 的自然语言不需要很多，但要及时：

```text
我先看一下家里现在有哪些可用食材。
```

```text
我先把三天晚餐计划整理成草稿，确认后再继续整理购物清单。
```

```text
这个计划草稿已经好了，等你确认后我再整理需要补买的食材。
```

这些文本用 `message_delta` 流出，形成类似 Codex 的连续工作感。

## 13. DTO 与接口演进

第一阶段优先不改外部 DTO：

- SSE 事件名继续使用现有事件。
- message part 类型继续复用现有类型。
- approval 提交流程继续使用现有接口。

但不要把“不改 DTO”写死。以下场景允许向后兼容扩展：

- 前端刷新后需要可靠恢复 run loop 进度。
- approval 之间存在依赖，需要展示锁定原因。
- 多端打开同一个 conversation，需要一致展示当前可提交 approval。
- 后续要支持局部重规划、失败重试或更明确的后台继续执行。

扩展要求：

- 只新增可选字段或 included 数据。
- 不修改旧字段语义。
- 旧客户端忽略新字段仍能完成基本查看和 approval。
- 同步更新后端 schema、前端类型、contract tests 和 AI workspace tests。

## 14. 与当前代码的落点

### 14.1 保留

- `WorkspaceGraphRunner`
- `WorkspaceOrchestratorAgent`
- `SkillContext`
- `SkillResult`
- `run_artifacts`
- `progressive_draft_publisher`
- `approval_interrupt`
- `human_input_interrupt`
- `LiveAIStreamCache.append_part`

### 14.2 调整

`WorkspaceOrchestratorAgent.run()`：

- 增加 action budget。
- prompt 改成 next-action agent prompt。
- 限制每轮最多发布一个主要 draft。
- draft 后续动作写入 `state_patch.resumeAfterApproval`。
- 返回 `status=running` 只代表无 draft 的普通动作还要继续；生成 draft 时 Runner 仍会等待 approval。

`WorkspaceGraphRunner._orchestrator_step()`：

- 当 result.status 为 `running` 且预算未耗尽时，路由回 orchestrator。
- pending approval 一律进入 `waiting_approval`，不在 approval 前继续生成 draft。
- approval resume 后只根据 `taskState.resumeAfterApproval` 判断是否继续 loop。

`_persist_assistant_result()`：

- 继续识别 progressive 已发布 draft，避免重复创建。
- 合并 live parts 和 final parts 时按 part id 去重。
- message status 要能表达 running 下已有 draft / approval parts 的情况。

前端：

- 保持 live message dedupe 以 `run_id` 为主。
- running 状态下 approval 面板只读。
- waiting_approval 状态下只允许当前 pending approval 提交。
- activity 文案和顺序要稳定，避免 final response 合并后重复闪烁。

## 15. 分阶段落地计划

### Phase 1：Run loop 语义调整

- 改造 Orchestrator prompt：每轮只推进一个 next action。
- 增加 action budget：每轮最多一个 draft。
- result.status 支持 `running` 作为继续 loop 信号。
- Runner 复用现有 `orchestrator -> orchestrator` 循环。

验收：

- 简单问答仍能一轮完成。
- 单 draft 任务仍能生成 approval。
- 多 draft 任务不再同一 provider tool loop 内一口气生成多个 draft。

### Phase 2：Confirmation-gated continuation

- draft publish 后记录 `draft.published` artifact。
- 增加 `resumeAfterApproval` hint。
- draft 后一律等待 approval。
- 支持 meal_plan draft -> approval -> shopping_list draft 这类确认后继续生成。
- 支持 recipe draft -> approval -> meal_plan draft 这类 commit 依赖。

验收：

- “安排三天晚餐并生成购物清单”先展示餐食计划 draft，确认后再生成购物清单 draft。
- “创建菜谱然后安排到晚餐”必须确认菜谱后才继续。

### Phase 3：Loop guard 与幂等

- 增加 run 级预算。
- 增加重复 tool detection。
- 增加重复 draft detection。
- structured result retry 不重复发布 draft。

验收：

- provider 重试或模型重复调用工具不会产生重复 approval。
- 工具循环会被中止并给出可理解结果。

### Phase 4：前端体验润色

- 优化 run_activity 中文文案。
- running approval readonly 提示。
- waiting_approval 当前 approval 可提交。
- final response 合并后不重复、不闪烁。

验收：

- 用户能看到类似 Codex 的连续工作流。
- 已生成 draft 能提前查看。
- 提交按钮状态和后端 run 状态一致。

## 16. 测试计划

### 16.1 后端

更新 `backend/tests/ai_infra/test_workspace_streaming.py`：

- provider 尝试连续调用两个 draft tool，第一轮只发布第一个，后续轮次再发布第二个。
- SSE 中 draft / approval_request 早于 final response。
- meal_plan draft 后必须 waiting_approval，approval resume 后才生成 shopping_list draft。
- recipe draft 后必须 waiting_approval，approval resume 后才生成 meal_plan draft。
- human.request_input 后进入 waiting_input，用户回答后继续 run loop。
- structured result retry 不重复创建 draft / approval。
- repeated tool call 超过阈值会被 guard 拦截。
- cancel run 会取消 pending approvals，不回滚已 commit operation。

建议命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_foundation.py -q
```

### 16.2 前端

更新 `frontend/src/components/ai/AiWorkspace.test.tsx`：

- 多轮 running assistant message 按 `run_id` 合并。
- streamed activity 顺序稳定。
- running 状态下 approval 可见但不可提交。
- waiting_approval 状态下只有当前 pending approval 可提交。
- final response 合并后不丢失本地已流式展示的 draft / approval parts。
- 不重复显示 activity、draft 或 approval。

建议命令：

```bash
npm --prefix frontend run test -- AiWorkspace.test.tsx aiApi.test.ts
npm --prefix frontend run check:size
npm --prefix frontend run build
```

## 17. 风险与取舍

### 17.1 模型不按 next-action 约束停止

风险：模型仍尝试在一轮里连续生成多个 draft。

控制：

- prompt 约束。
- tool handler budget 硬限制。
- 第二个 draft tool 返回可恢复错误。
- run loop 下一轮继续。

### 17.2 复杂任务没有 upfront plan，方向可能漂移

风险：模型每轮只看下一步，可能遗漏用户的整体目标。

控制：

- 每轮 prompt 都带原始用户目标、conversation 摘要和 run artifacts。
- 每轮结束写入简短 progress artifact。
- 复杂任务可在第一轮用自然语言说明整体处理方向，但不需要完整结构化 TaskPlan。

### 17.3 approval 前继续生成导致后续草稿失效

风险：后续 draft 基于未确认的前序 draft，用户拒绝前序 draft 后后续 draft 不再适用。

控制：

- 生成 draft 后一律进入 `waiting_approval`。
- 不再支持 pending approval 期间继续生成后续 draft。
- 前序 rejected 后不写入正式数据，但会把拒绝作为 HumanInLoop 工具结果交回 Orchestrator。
- Orchestrator 必须基于拒绝结果判断：结束、重新生成当前草稿，或继续处理不依赖被拒绝草稿的下一项。

### 17.4 run loop 增加模型调用次数

风险：复杂任务耗时和成本上升。

控制：

- 简单任务一轮完成，不额外 classifier 或 upfront planner。
- 每轮输出短进度，让用户看到正在做什么。
- 常见 read tool 可在一轮内完成，不拆得过细。
- 加 run 级预算。

## 18. 推荐最终架构

```text
AIApplicationService
  -> WorkspaceGraphRunner
      -> Agent Run Loop
          -> WorkspaceOrchestratorAgent.run()
          -> ToolExecutor / ScriptExecutor
          -> ProgressiveDraftPublisher
          -> LiveAIStreamCache
      -> ApprovalInterrupt
      -> HumanInputInterrupt
      -> Finalize
```

长期方向：

- `run()` 是唯一执行入口。
- 简单和复杂任务都使用同一套 loop。
- 不引入显式 `run_step` 分支。
- 不先做完整 TaskPlan。
- 用 bounded tool/action budget 保证 agent 行为可控。
- 用 activity + message_delta + message_part 打造连续工作感。
- 用 approval / human input interrupt 保证安全边界和可恢复执行。

这个方案比 `run_step + TaskPlan` 更轻，更贴近 Codex / OpenClaw 的普通 agent 体验，也更容易在 Culina 当前 Orchestrator 架构上渐进落地。
