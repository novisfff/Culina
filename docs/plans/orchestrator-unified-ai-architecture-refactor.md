# Orchestrator 统一 AI 架构重构计划

状态：当前轮剩余 Phase 已收口，保留非阻断兼容 backlog
更新时间：2026-06-30

## 背景

Culina AI 工作台已经迁移到单一 `WorkspaceOrchestratorAgent` 主路径：LangGraph Runner 调用 Orchestrator，Orchestrator 按需注入 Skill，Skill 通过 `skill.yaml` 声明工具、脚本、卡片、草稿和审批策略，正式写入仍走 `draft -> approval -> commit`。

最近的重构已经把主系统提示词抽到 `backend/app/ai/workflows/orchestrator/prompts.py`，并把运行期状态和工具网关从 `WorkspaceOrchestratorAgent.run()` 中拆出。当前架构已经具备统一骨架，并已完成主助手 profile 化、显式 profile registry、`skill.inject` 动态 schema、profile-scoped capability exposure、Draft Operation Registry 基础 adapter、Completion Policy / Terminal Guard 基础版、profile-scoped budget config 基础版，以及 profile route hints 基础版。Skill-level 运行策略和模块边界仍需继续优化。

本文目标是定义后续重构方向：提高代码质量和设计规范，同时把 Orchestrator 演进为通用 AI 架构。重构必须保持现有主 AI 助手、小灶、已上线 Skill、审批、SSE、消息 part 和前端响应合同不变。

## 目标

- 建立清晰的三层配置模型：
  - `workflows/orchestrator/prompts.py`：全局 Orchestrator 行为合同和运行协议。
  - `workflows/orchestrator/profiles.py`：入口、场景、产品人格和初始 Skill 注入策略。
  - `skill.yaml` / `SKILL.md`：具体 AI 能力包的业务合同、工具、草稿、卡片、示例和完成约束。
- 让新增非写入型能力尽量只需要新增 Skill catalog、工具或脚本配置。
- 让不同入口只暴露必要能力：主 AI 工作台可以动态注入 Skill；小灶这类页面助手只暴露固定页面能力，不接收全量 catalog、动态注入 schema 或无关 draft 合同。
- 让新增写入型能力只需要新增确定性业务 handler 并注册到统一 registry，不再分散修改 normalizer、approval config、executor、恢复逻辑等多处 if/elif。
- 用通用 Terminal Output Guard 和 follow-up contract 替代单个 Skill 特例，避免中间工具调用后误判为 `completed`。
- 保留现有 AI 对外契约：`AIChatResponse`、message parts、SSE `message_delta`、progress event、draft、approval、result card 和 run intent 语义不破坏。
- 强化测试和质量门禁，让 Orchestrator 能作为长期统一架构承载主 AI 助手、小灶和未来页面级助手。

## 非目标

- 不把正式写入交给模型自由执行。所有写入仍必须由后端 service 在审批后确定性执行。
- 不移除现有 `skill.yaml`、`SKILL.md` 或工具白名单机制。
- 不在一次改造中重写 LangGraph Runner、前端 AI workspace 或所有现有 Skill。
- 不为了配置化牺牲家庭数据隔离、审批、schema 校验、媒体归属和事务一致性。

## 当前状态与主要差距

### 已具备的统一架构基础

- `WorkspaceGraphRunner` 已经只通过 `WorkspaceOrchestratorAgent` 执行主 AI 路径，并根据 Orchestrator 返回状态进入 `finalize`、`approval_interrupt` 或 `human_input_interrupt`。
- `SkillDirectoryLoader` 已经从 catalog 加载 `SKILL.md` 和 `skill.yaml`，并校验工具存在、write tool 不暴露、draft tool 必须 require confirmation。
- Orchestrator 已经通过 `SkillInjectionManager` 和 scoped tool executor 控制工具可见性，模型只能调用基础 control 工具和已注入 Skill 的 read/draft/script 工具。
- Prompt、profile、Skill instructions 已经分层：全局 prompt 由 `workflows/orchestrator/prompts.py` 构建，主 AI 助手和小灶由 `workflows/orchestrator/profiles.py` 追加 profile addon，具体业务说明来自 Skill catalog。
- Profile 已经有显式 `OrchestratorProfileRegistry` 和 matcher 基础，支持按 `quick_task`、`subject.source`、`subject.extra.surface` 匹配，并回退到主 AI 助手 profile；profile key 重复会在注册阶段失败。
- `skill.inject` 的模型 schema 已经由 Orchestrator 按当前 `SkillRegistry` 动态生成；基础 registry 只保留 string schema 和运行时校验，不再维护静态 Skill key 枚举。
- Profile 已经能控制 provider 可见能力面：主 AI 工作台保留动态注入和全量 catalog，小灶只暴露固定 `cooking_assistant` 能力，不暴露 `skill.inject`、全量 catalog 或 draft 合同。
- Draft Operation Registry 已经有基础 adapter，现有 draft type 的 normalizer、approval config、executor、preview summary、审批结果文案、审批成功后置 hook 和失败恢复 current value loader 已经通过 `draft_operation_registry` 查找；旧函数入口仍保留兼容。
- 审批链路仍由 `WorkspaceGraphRunner` 持久化 draft 和 approval，再由 `services/ai_operations` 执行正式写入，模型不参与 commit 决策。

### 需要继续优化的架构点

1. 写入型能力 registry 已经落地到 adapter 层，approval value shape、审批结果展示元数据、失败恢复提示和 current value loader 已并入 `DraftOperationSpec`。后续新增写入型 draft 仍要写确定性 service，但目标是只新增一个 spec 和对应 service/test，不再散落修改 normalizer、approval config、executor、recovery、result card 多处逻辑。
2. Completion Policy / Terminal Guard 已有基础版，能识别 tool output 的 `requires_followup`、`terminal_output` 和 `followup_hint`，并阻止中间工具输出后无用户可见终态结果时误标 `completed`。剩余工作不是继续造框架，而是给真实 read/preview tool 补业务完成条件，并用测试覆盖“必须继续解释/追问/生成 draft”的边界。
3. Prompt、profile、Skill instructions 已经分层，预算策略已有 profile-scoped 基础版，quick task / route hint 到初始 Skill 的映射也已进入 profile route hints。剩余工作是给真实高风险/高成本 Skill 补 `tool_budget`、`completion_policy` 和更准确的 `route_hints`，并把 profile 外置配置作为后续独立阶段评估。
4. Orchestrator runtime 已经整理为 `workflows/orchestrator/` 包，`WorkspaceOrchestratorAgent` 主循环约 300 行，不再是当前最大维护风险。后续除非出现明确职责膨胀，不继续“为了拆而拆” Orchestrator。
5. 当前最大代码质量风险已经转移到 `WorkspaceGraphRunner`：`runner.py` 仍约 3600 行，混合了消息准备、附件加载、审批/人机恢复、LangGraph 节点、assistant message 持久化、SSE stream bridge、live stream cache、checkpoint 和 response 组装。Runner 需要按稳定边界拆，而不是一次性大搬家。
6. Tool contract 已有 `requires_followup`、`terminal_output`、`followup_hint`、`output_types` 和 `draft_types` 基础元数据。后续可扩展 terminal condition、可观测诊断和 schema 覆盖，但必须由真实失败场景或新增 Skill 需求驱动，避免预先设计过度抽象。
7. `quick_task` 已经通过 profile route hints 映射到初始 Skill。后续新增页面入口 hint 优先写入对应 Skill 的 `skill.yaml.route_hints` 或明确的 profile matcher，不再回写主 profile 的大分支。

### 当前收口状态总览

当前轮按以下顺序完成收口：

1. **文档收敛与执行规则**：Phase 9 已完成，Phase 10.1 已完成，Phase 10.2-10.4 已按真实 Tool contract 缺口执行。
2. **Runner 分步拆分**：Phase 9 已完成；`runner.py` 继续作为唯一 orchestration owner，`runner_support/` 只承载低风险 helper。
3. **真实 Skill 配置补齐**：高风险 Skill 的 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract` 已补齐；当前轮把稳定共享语义下沉到 ToolDefinition 默认 contract。
4. **兼容 wrapper 清理**：旧入口和薄 wrapper 已分类并继续收口；仍保留 Orchestrator 包级公共入口，Runner 内部纯转发 wrapper、`ai_operations.__init__` 宽 re-export 和 registry 旧类型转导出已删除。
5. **最终验证**：以完整 `backend/tests/ai_infra`、AiWorkspace 前端测试、AI py_compile 和 `git diff --check` 作为当前轮收口门禁。

## 目标架构

### 1. 全局 Orchestrator Contract

`workflows/orchestrator/prompts.py` 只保留所有 Orchestrator 都必须遵守的底层运行合同：

- Skill 注入规则。
- 工具作用域和 write tool 禁止。
- draft approval 规则。
- result card 必须来自 tool。
- artifact summary 需要 `workspace.read_artifact` 复读。
- 一轮最多一个 draft。
- 不输出 XML、JSON 状态对象或 structured_result。
- 普通 assistant 文本进入 message part，工具结果由程序状态持久化。

不应在这里放某个入口的产品人格，例如“小灶”或“主 AI 助手”的口吻。

### 2. Profile Registry

`workflows/orchestrator/profiles.py` 演进为 profile registry，而不是单个 resolver 分支：

- 每个 profile 声明：
  - `key`
  - `matchers`：`quick_task`、`subject.source`、`subject.extra.surface`、可选 route hint。
  - `initial_skill_keys`
  - `system_prompt_addon`
  - `response_style`
  - `allowed_surface`
  - `capability_policy`
  - 可选 `tool_budget` / `skill_budget`
- Profile 配置输入可以使用 Python/YAML 友好的 `snake_case`，例如 `capability_policy.skill_injection`、`budget_config.max_total_tool_calls_per_run`；运行态 `to_state()`、prompt metadata 和前端可见 summary 仍输出既有 `camelCase`，保持兼容。
- 新增 `MAIN_WORKSPACE_PROFILE`，把主 AI 助手的产品身份和表达风格从全局 prompt 中分离出来：
  - Culina 主 AI 助手。
  - 默认简体中文。
  - 服务家庭日常饮食管理。
  - 不做医疗或营养诊断承诺。
  - 信息不足时先读取或追问，不编造库存、计划、食材或菜谱。
  - 适合工作台展示，必要时用短段落、列表、编号步骤和加粗关键词。
- `DEFAULT_ORCHESTRATOR_PROFILE` 指向 `MAIN_WORKSPACE_PROFILE`，而不是空 profile。
- 小灶继续作为 `recipe_cook_page` profile，保留短句、页面动作和做菜现场边界。

### 3. Profile-scoped Capability Policy

动态配置能力必须按 profile 暴露，不能所有 Orchestrator 实例都看到同一套 catalog、draft 和注入工具。建议在 `OrchestratorProfile` 上增加 `capability_policy`：

```text
capability_policy:
  skill_injection: dynamic | fixed | disabled
  catalog_scope: all | initial_only | hidden
  draft_contract: auto | exposed | hidden
  artifact_context: all | without_drafts | hidden
  allowed_skill_keys: list[str]
  base_tools: list[str]
```

字段语义：

- `skill_injection=dynamic`：允许模型调用 `skill.inject`，并根据当前 `SkillRegistry` 或 `allowed_skill_keys` 动态生成 schema。主 AI 工作台使用这个模式。
- `skill_injection=fixed`：只注入 profile 声明的 `initial_skill_keys`，不向模型暴露 `skill.inject`，也不暴露全量 Skill catalog。小灶使用这个模式。
- `skill_injection=disabled`：完全不注入业务 Skill，仅允许普通对话或极少数 base tools，适合未来纯解释型入口。
- `catalog_scope=all`：prompt 中展示全部 catalog records，适合主 AI 工作台自主路由。
- `catalog_scope=initial_only`：只展示已注入 Skill 的 manifest 和 instructions，不展示其他可注入能力。
- `catalog_scope=hidden`：不展示 catalog records，只保留 profile prompt 和已授权工具 schema；适合强页面助手，避免模型思考“我还能调用哪些别的能力”。
- `draft_contract=auto`：只有当前 profile/Skill 暴露 draft tool 或允许写入时，才在 prompt 中加入 draft approval 合同和 `allowedDraftTypes`。
- `draft_contract=hidden`：当前入口不允许 draft 时，不给模型任何写入型草稿说明；小灶做页面动作时不应该看到“生成草稿等待审批”的主工作台规则。
- `artifact_context=all`：历史 conversation artifacts、previous results 和 current run artifacts 可完整摘要给模型，主 AI 工作台使用该模式。
- `artifact_context=without_drafts`：过滤 draft、approval decision 和 approval-resume artifacts，只保留普通 result card、tool call、人机补充等非写入上下文；小灶这类固定页面助手使用该模式。
- `artifact_context=hidden`：不提供 artifact/previous result/current run artifact 摘要，适合未来极窄的解释型或页面内无状态助手。

推荐 profile 配置：

```text
MAIN_WORKSPACE_PROFILE:
  initial_skill_keys: []
  capability_policy:
    skill_injection: dynamic
    catalog_scope: all
    draft_contract: auto
    artifact_context: all
    allowed_skill_keys: []
    base_tools: [skill.inject, human.request_input]

COOKING_ASSISTANT_PROFILE:
  initial_skill_keys: [cooking_assistant]
  capability_policy:
    skill_injection: fixed
    catalog_scope: initial_only
    draft_contract: hidden
    artifact_context: without_drafts
    allowed_skill_keys: [cooking_assistant]
    base_tools: [human.request_input]
```

这样小灶的 Orchestrator 仍复用同一套运行框架、stream、trace、tool gateway 和 result assembly，但 provider 看到的能力只有做菜页面所需内容：

- 不暴露 `skill.inject`。
- 不暴露其他 Skill catalog。
- 不暴露动态 draft type 列表。
- 不注入主工作台的写入型 draft 合同。
- 只暴露 `cooking_assistant` manifest 声明的 read/control tools，例如页面动作、当前菜谱读取和计时相关动作。

这不是削弱统一架构，而是把统一架构做成“同一 runtime，不同 capability surface”。主工作台是开放路由 surface，小灶是固定页面助手 surface。

#### Capability Surface 可见性矩阵

后续凡是改成动态配置的能力，都必须先判断它属于“runtime registry 能力”还是“当前 profile 可见能力”。Registry 可以全局存在，但 prompt、tool schema 和 user payload 只能暴露当前 profile 允许的部分。

| 能力 | 主 AI 工作台 | 小灶做菜页 | 设计要求 |
| --- | --- | --- | --- |
| `skill.inject` tool | 暴露 | 不暴露 | 只有 `skill_injection=dynamic` 才生成 tool definition 和 prompt 合同。 |
| 全量 Skill catalog | 暴露 | 不暴露 | `catalog_scope=all` 才输出 catalog records；`initial_only` 只输出已注入 Skill。 |
| 动态 Skill key enum/schema | 暴露 | 不暴露 | enum 由 `SkillRegistry.keys()` 或 `allowed_skill_keys` 生成，但固定 profile 不需要看到。 |
| `allowedDraftTypes` | 仅已注入 draft-capable Skill 后动态输出 | 不输出 | `draft_contract=auto` 且当前没有 draft 能力时不输出空数组；`hidden` 时始终不输出。 |
| draft approval prompt 合同 | 仅已注入 draft-capable Skill 后输出 | 不输出 | 没有写入型草稿能力的入口，不向模型解释审批流。 |
| draft/approval 历史 artifacts | 输出摘要，可通过 `workspace.read_artifact` 复读 | 过滤 | `artifact_context=without_drafts` 时不把 draft、approval decision、approval resume 摘要放进 provider payload。 |
| artifact context prompt 合同 | 提示摘要可复读完整草稿/审批 | 提示上下文已过滤，不提复读草稿/审批 | prompt、payload 和 tool surface 必须一致；没有 `workspace.read_artifact` 的入口不能被提示去读完整草稿。 |
| Draft Operation Registry | 后端可用 | 后端可用但不可见 | registry 是确定性执行层，不等于模型可调用能力；是否可见仍由 profile 和 Skill 决定。 |
| write/commit executor | 不暴露给模型 | 不暴露给模型 | 所有 profile 都只能通过 approval 后 service 执行正式写入。 |

实现边界：

- Runtime 层可以统一注册所有 Skill、Tool、Draft handler，但 provider 层只能接收 filtered tools、filtered catalog 和 filtered prompt sections。
- `OrchestratorRunState` 保存 profile policy，后续恢复同一个 run 时必须继续使用原 policy，不能因为入口变化突然扩大工具面。
- 续跑时 `injected_skill_keys` 必须重新经过当前 run 持久化的 profile policy 过滤；即使 checkpoint 或恢复 state 中混入未授权 Skill key，prompt、provider tool list 和 user payload 也只能看到当前 profile 允许的能力。
- `SkillResult.context_summary.orchestrator` 应输出 `profileKey`、`responseStyle`、`capabilityPolicy` 和 budget，方便诊断当前 run 实际使用的能力面。
- `/api/ai/registry` 应同时暴露 profile registry 的只读诊断信息，包括 matcher、initial skills、capability policy、budget、运行时合并后的 route hints 和默认 profile，方便确认不同入口的真实能力面。
- `SkillInjectionManager` 只负责“有哪些能力”和“某 profile 允许哪些能力”的交集，不把主工作台默认能力泄漏给固定页面助手。
- `build_orchestrator_system_prompt()` 只接收已经过滤过的 records，并通过显式开关决定是否输出 dynamic injection、draft contract、allowed draft types 和 artifact context contract。
- `OrchestratorPromptPayloadBuilder` 必须按 profile 过滤 artifact context；固定页面助手不应因为全局 registry 存在而看到主工作台 draft/approval 历史。
- `OrchestratorCapabilityPolicy.from_state()` 和 `OrchestratorBudgetConfig.from_state()` 应同时接受 snake_case / camelCase，避免后续 profile 外置到 YAML 或 DB 时被前端字段风格绑死。
- `fixed` profile 如果未显式声明 `allowed_skill_keys`，运行时会默认收紧为 `initial_skill_keys`；`disabled` profile 会清空初始业务 Skill，避免配置外置后因为漏配 allowed skills 而退化成允许所有 Skill。
- Runner 初始化时应校验 profile registry 和当前 SkillRegistry 的一致性：profile 的 `initial_skill_keys`、静态 `route_hints.initial_skill_keys` 和 `allowed_skill_keys` 必须引用存在的 Skill，且所有引用都必须在当前 profile capability policy 允许范围内。
- `current_tool_names` 必须来自 profile-filtered tool definitions；即使模型伪造未暴露工具名，也要返回结构化错误，不能执行。

推荐把未来能力按以下方式接入：

1. 新增读/卡片/草稿能力时，先注册全局 Skill 和 Tool。
2. 再决定哪些 profile 可以看见它：主工作台通常通过 dynamic injection 看见，小灶默认不可见。
3. 如果页面助手只需要一个固定能力，配置 `initial_skill_keys` 和 `allowed_skill_keys`，不要给它 `skill.inject`。
4. 如果页面助手不允许创建草稿，设置 `draft_contract=hidden`，并确保 prompt、payload、tool list 三处都不出现 draft 信息。
5. 对每个 profile 补最小回归：provider tool names、system prompt、user payload 三处都符合可见性预期。

### 4. Skill Runtime Contract

`skill.yaml` 继续作为能力包的稳定运行合同，并逐步增加架构级字段：

- `completion_policy`：
  - `terminal_text_allowed`
  - `requires_terminal_output`
  - `terminal_tools`
  - `followup_required_tools`
- `tool_budget`：
  - `max_tool_calls`
  - `max_same_read_calls`
- `route_hints`：
  - quick task 或入口 hint 到初始 Skill 的映射；只对允许动态路由的 profile 生效，fixed/disabled profile 不自动吃全局 catalog hints。
- `draft_contract`：
  - draft type、schema version、approval config key、commit handler key。

新增字段要向后兼容：缺失时使用现有默认行为，不影响当前 Skill。

### 5. Dynamic Skill Injection Schema

`skill.inject` 的模型 schema 不再维护静态 key 列表：

- 推荐方案：在 Orchestrator 构造 tool definitions 时，根据当前 `SkillRegistry` 动态生成 `skill.inject` 的 enum schema。
- 兼容方案：`skill.inject.skills.items` 放宽为 string，Orchestrator runtime 根据 catalog records 校验未知 key，并返回结构化错误。
- 保留 prompt 中“必须使用 skill.yaml:key，不要用 slug”的规则。
- 测试覆盖新增假 Skill 后无需改 `intent.py` 即可注入。

### 6. Draft Operation Registry

把写入型能力相关分支收敛到统一 registry，例如 `services/ai_operations/registry.py`：

```text
draft_type -> DraftOperationSpec
  normalizer
  executor
  approval_config
  preview_summary
  recovery_loader
  result_metadata
```

落地后：

- `drafts.py` 不再维护长 if/elif，而是查 registry 调用 normalizer。
- `executor.py` 不再维护长 if/elif，而是查 registry 调用 executor。
- 审批配置通过 registry spec 暴露 lookup，并支持按 payload action 派生 approval type；旧 `approval_config.py` facade 已删除。
- 恢复信息、预览摘要、approval result card 的工作区名称、数量文案、fallback label、默认操作和 current value loader 使用同一 spec，减少 draft type 漂移。
- 新增正式写入能力仍必须写确定性 service，但只需要在 registry 注册一次。

### 7. Terminal Output Guard 与 Follow-up Contract

引入通用终态判断，避免“无 draft 即 completed”误判：

- ToolDefinition 或 Skill runtime 可声明：
  - 当前工具输出是否是 terminal result。
  - 调用后是否必须继续调用某个 draft tool、card tool、human input 或输出总结。
  - 如果工具返回 `requires_followup=true`，Orchestrator 不能直接 completed。
- Orchestrator 在 provider loop 结束后统一检查：
  - 是否有 pending follow-up。
  - 是否有用户可见 terminal text、result card、draft 或 human input。
  - 如果没有 terminal output，但存在中间工具输出，返回 failed 或 waiting_input，而不是静默 completed。
- 该机制必须通用，不写 `recipe_cook`、`meal_plan` 等单 Skill 特例。

### 8. Orchestrator 模块拆分

Orchestrator runtime 已从 `backend/app/ai/workflows/orchestrator.py` 平铺文件整理为 `backend/app/ai/workflows/orchestrator/` 包：

```text
workflows/orchestrator/
  __init__.py                  # 兼容导出 WorkspaceOrchestratorAgent 等公共入口
  agent.py                     # WorkspaceOrchestratorAgent 主循环
  state.py                     # OrchestratorRunState
  tools.py                     # OrchestratorToolGateway
  skill_injection.py           # SkillInjectionManager / capability surface
  skill_runtime.py             # skill.inject 执行
  prompts.py                   # 全局 prompt contract
  payloads.py                  # profile state / prompt / user payload 构造
  profiles.py                  # profile registry
  results.py                   # result assembly / validation
  completion.py                # terminal guard / follow-up policy
  tool_*.py                    # tool schema、budget、contract 和 output metadata

workflows/runner_support/
  approval_resume.py           # 审批恢复 state patch / resume artifact
  message_parts.py             # assistant message part 构造与聚合
  run_summary.py               # run context summary / metrics 纯函数
```

结构整理后保持 import 兼容：外部仍从 `app.ai.workflows.orchestrator` 导入 `WorkspaceOrchestratorAgent` 和主要 Orchestrator 类型；细分模块使用 `app.ai.workflows.orchestrator.*`，Runner 专属辅助函数使用 `app.ai.workflows.runner_support.*`。

### 9. Runner 拆分边界

`WorkspaceGraphRunner` 是 LangGraph 和应用持久化边界，不应该被拆成多个互相调 DB transaction 的小 runner。拆分目标是降低单文件复杂度，同时保留一个清晰的 orchestration owner：

- `runner.py` 继续保留：
  - 对外入口：`invoke_user_message()`、`stream_user_message()`、`resume_approval()`、`resume_human_input()`、stream resume 入口。
  - LangGraph graph 构建和节点路由：`_build_graph()`、`_initialize()`、`_orchestrator_step()`、interrupt step、`_finalize()`。
  - 跨步骤事务顺序和 checkpoint 提交决策。
- `runner_support/` 只承载：
  - 无副作用纯 helper，例如 message part、run summary、state patch、payload 构造。
  - 边界清晰且可单测的服务型 helper，例如附件规范化、stream event drain、approval resume state 构造。
- 不拆出的内容：
  - 不把 `WorkspaceGraphRunner` 拆成多个可独立启动的 runner。
  - 不改变 LangGraph node name、SSE event shape、message part shape、run status、approval/human interrupt payload。
  - 不把审批 commit、正式写入或 checkpoint 顺序藏进难以追踪的通用抽象。

#### Runner 当前职责分组

当前 `runner.py` 约 3600 行，职责可以按以下稳定边界拆分：

| 现有职责 | 代表方法 | 目标归属 |
| --- | --- | --- |
| 用户消息准备与会话创建 | `_prepare_user_message()`、`_prepared_existing_run()`、`_message_summary()` | `runner_support/message_preparation.py` |
| 附件规范化和 provider image input | `_normalize_chat_attachments()`、`_load_ai_message_attachment_assets()`、`_attachment_summaries()`、`_build_user_message_parts()`、`_provider_images_for_attachments()` | `runner_support/attachments.py` |
| 审批入口和 fast decision | `resume_approval()`、`apply_approval_decision_fast()`、`stream_resume_approval()` | 入口留在 `runner.py`，纯 state patch 留在 `runner_support/approval_resume.py` |
| 人机补充恢复 | `resume_human_input()`、`stream_resume_human_input()`、`_resume_pending_human_input()`、`_human_input_answer_summary()` | 后续 `runner_support/human_input_resume.py` |
| 审批恢复内部状态 | `_resume_pending_approval()`、`_resume_recorded_approval_decision()`、`_consume_resume_after_approval()` | 已部分进入 `runner_support/approval_resume.py`，剩余 DB 编排暂留 Runner |
| assistant message 持久化 | `_persist_assistant_result()`、`_ensure_progressive_assistant_message()`、`_append_text_to_assistant_message()`、`_sync_message_parts_with_current_approval_state()` | 分两步进入 `runner_support/message_persistence.py`，但 DB 写入顺序必须显式 |
| streaming worker bridge | `_make_stream_worker_runner()`、`_enqueue_stream_event()`、`_drain_stream_graph()`、`_handle_stream_worker_exception()`、`_consume_stream_graph_worker()`、`_stream_graph_events()` | `runner_support/stream_bridge.py` |
| live stream cache / progress writer | `_persistent_progress_writer()`、`_cache_live_message_delta()`、`_cache_live_activity_part()`、`_cache_live_message_part()`、`_base_assistant_parts_from_live_stream()` | `runner_support/live_parts.py` 或保留，拆分前需补专门测试 |
| approval follow-up 文本追加 | `_stream_approval_followup()`、`_append_approval_followup_fallback()`、`_approval_followup_fallback_text()` | `runner_support/approval_followup.py` |
| final response 组装 | `_chat_response()`、interrupt payload、`_new_progress_events()` | 可进入 `runner_support/responses.py`，但 serializer 调用和 DB refresh 要保持显式 |

#### Runner 拆分原则

每一步拆分必须满足：

1. **先纯后重**：优先移动纯函数、payload 构造、message part 聚合；后移动带 DB 查询/flush/commit/checkpoint 的代码。
2. **入口稳定**：前端/API 仍只通过 `AIApplicationService` 和 `WorkspaceGraphRunner`，不新增外部可见 runner 类型。
3. **状态稳定**：不得改变 `WorkspaceGraphState` 字段、LangGraph node name、run status、conversation status、message part type、SSE event name。
4. **审批优先**：涉及 approval resume 的改动必须证明“审批 commit 和 checkpoint 先完成，再续跑 Orchestrator”，不能把这段顺序隐藏到通用 helper 里。
5. **stream 语义不变**：客户端断开只代表 SSE subscriber 脱离，不取消后端 graph run；这条语义必须在 stream bridge 拆分测试里保留。
6. **小步验收**：每个步骤只移动一类职责，完成后更新本文档的 Phase 状态和已跑验证。
7. **不做清理型大改名**：除非正在修改对应职责，不顺手重命名大量方法或调整无关测试。

## 分阶段实施计划

### Phase 0：文档与测试基线

- 固化当前行为测试：
  - 主 AI 助手 default profile 不预注入业务 Skill。
  - 小灶 profile 继续预注入 `cooking_assistant`。
  - 小灶 profile 不暴露 `skill.inject`、全量 catalog 和无关 draft prompt。
  - `skill.inject` 使用 skill.yaml key。
  - draft tool 后进入 `waiting_approval`。
  - result card 只来自 tool 输出。
  - summarized artifact 必须通过 `workspace.read_artifact` 复读。
- 每次重构按风险选择验证：
  - 纯文档变更：人工审阅 + `git diff --check`。
  - 纯 helper / 单职责小迁移：运行对应 `backend/tests/ai_infra` 相关文件和 `py_compile`。
  - 结构迁移、stream、approval、message persistence：运行完整 `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q`。
  - 风险较大或跨 service/API 时再运行 `npm run backend:test`。

### Phase 1：主 AI 助手 profile 化（已落地）

- 新增 `MAIN_WORKSPACE_PROFILE`。
- `DEFAULT_ORCHESTRATOR_PROFILE = MAIN_WORKSPACE_PROFILE`。
- 从全局 prompt 中迁出主 AI 助手的产品风格，只保留底层运行合同。
- 保持现有主 AI 助手行为：
  - 默认简体中文。
  - Markdown 友好但不强制。
  - 家庭上下文约束。
  - 不做医疗和营养诊断承诺。
- 更新测试断言：主 prompt 由 global contract + main profile 拼成；小灶仍覆盖默认风格。

### Phase 2：Profile Registry（已落地基础版）

- 用 `OrchestratorProfileMatcher` 替代硬编码 resolver 分支。
- 用显式 `OrchestratorProfileRegistry` 管理 profile 注册、解析和按 key 查询；profile key 重复或 default profile 未注册时启动期失败。
- profile 按注册顺序匹配，最后 fallback 到 main workspace。
- 支持 `quick_task`、`subject.source`、`subject.extra.surface`。
- 旧 `resolve_orchestrator_profile(quick_task, subject)` 兼容函数已删除；运行时和测试统一使用 `ORCHESTRATOR_PROFILE_REGISTRY.resolve(...)`。
- 为后续库存页助手、菜谱页助手等入口预留 profile 配置方式。
- `OrchestratorCapabilityPolicy` 的 `allowed_skill_keys` 和 `base_tools` 已规范为不可变 tuple，对外 `to_state()` 仍输出 list，保持 run state / prompt metadata 兼容。
- `OrchestratorCapabilityPolicy.from_state()`、`OrchestratorBudgetConfig.from_state()` 和 `OrchestratorPromptPayloadBuilder` 已支持 snake_case 与 camelCase 两种输入；这为后续 profile 外置配置留出空间，同时不改变当前 `to_state()` 输出。
- `OrchestratorProfileMatcher.from_state()`、`OrchestratorRouteHint.from_state()`、`OrchestratorProfile.from_state()` 和 `OrchestratorProfileRegistry.from_state()` 已提供 profile 外置配置解析入口：
  - 支持 snake_case / camelCase 的 matcher、route hints、capability policy 和 budget config。
  - fixed profile 会继续自动把 initial skills / route hint skills 收敛为 allowed skill keys。
  - disabled profile 仍会清空 initial skills，避免外置配置误扩大能力面。
  - registry 解析会校验默认 profile key 必须存在；当前运行仍使用内存 Python profile 常量，外置加载可后续接入。
- `OrchestratorProfile` 初始化阶段已增加 profile policy 归一化：
  - `fixed` profile 漏配 `allowed_skill_keys` 时，默认只允许 `initial_skill_keys`。
  - 如果 fixed profile 只有静态 route hints，也会把 `route_hints.initial_skill_keys` 纳入默认 allowed skills。
  - `disabled` profile 会清空配置里的初始业务 Skill。
  这能避免未来 profile 外置到 YAML/DB 时，漏配能力白名单导致页面助手意外看到主工作台能力。
- `WorkspaceGraphRunner` 初始化阶段已调用 `validate_orchestrator_profile_registry()`，让 profile registry 与当前 SkillRegistry 的不一致在 AI runtime 启动路径提前失败：
  - `allowed_skill_keys` 引用未知 Skill 会失败。
  - `initial_skill_keys` 或静态 route hints 引用未知 Skill 会失败。
  - profile 引用了 capability policy 不允许的 Skill 会失败。
- `/api/ai/registry.profiles[]` 已输出当前 profile registry 的只读诊断，并使用与 Runner 一致的 `profile_with_skill_route_hints()` 合并 Skill-level route hints：
  - `key`
  - `initial_skill_keys`
  - `response_style`
  - `allowed_surface`
  - `matcher`
  - `capability_policy`
  - `budget_config`
  - `route_hints`
  - `default`
  这样未来新增页面助手或外置 profile 配置时，可以通过同一个诊断接口确认运行时真实注册状态；主工作台能看到来自 Skill catalog 的动态 route hints，小灶这类 fixed profile 仍不会吃全局 catalog hints。

### Phase 3：Dynamic Skill Injection（已落地基础版）

- 从静态 `SKILL_INJECT_SKILL_KEYS` 迁移到 registry 生成 schema。
- `skill.inject` tool definition 应能拿到当前 SkillRegistry 的 keys。
- Orchestrator 运行态的 `skill.inject.skills.maxItems` 应按当前 profile/Skill budget 的剩余可注入空间生成，避免 provider schema 和 runtime budget 不一致；全局 registry 诊断仍保留宽松 string schema，由运行态负责按当前能力面收紧。
- 未知 key 仍由 Orchestrator runtime 返回结构化错误，不暴露异常堆栈。
- `skill.inject.skills` 运行时严格按 schema 接收非空数组；缺失、非数组、空数组、非字符串项或空字符串项都会返回结构化 `invalid_skill_inject_payload`，不再把错误形态静默转成空注入或单元素列表。
- 消除新增 Skill 必须改 `intent.py` 的维护点。
- 增加测试：Orchestrator 暴露给 provider 的 `skill.inject` schema 使用当前 `SkillRegistry.keys()`，并继续拒绝短横线 slug。

### Phase 4：Profile-scoped Capability Exposure（已落地基础版）

- 新增 profile 级 `capability_policy`，先以内存 Python 配置落地，后续再评估是否外置到 yaml。
- Orchestrator 根据 profile policy 构造 provider 可见的 prompt sections 和 tool definitions：
  - 主 AI 工作台保留 `skill.inject`、全量 catalog、动态 draft context。
  - 小灶只暴露 `cooking_assistant` 的已授权工具和说明，不暴露 `skill.inject`。
  - 小灶 provider payload 会过滤 draft、approval decision 和 approval-resume artifacts，只保留普通卡片、人机补充和页面工具上下文。
  - 小灶 system prompt 只说明上下文已按 profile 过滤，不输出 `workspace.read_artifact` 或“复用历史草稿/审批完整内容”的主工作台合同。
  - 动态 profile 如果配置 `allowed_skill_keys`，system prompt 中的 catalog records 也按同一 policy 过滤，避免 prompt、tool schema 和 runtime 校验的能力面不一致。
  - `skill_injection=disabled` 的 profile 不允许初始注入任何业务 Skill，且即使未显式配置 `base_tools` 也不会暴露 `skill.inject`；它只保留 profile 允许的非注入 base tools，例如 `human.request_input`。
  - `base_tools` 只能配置 Orchestrator 控制工具；runtime 会拒绝把 read/draft/write 业务工具作为 base tool 暴露，避免绕过 Skill 注入和 allowed tools 合同。
  - 恢复/续跑路径继续使用 checkpoint 中持久化的 `orchestrator_profile`，并对已有 `injected_skill_keys` 再做 profile policy 过滤；fixed/disabled profile 不会因为恢复 state 混入其他 Skill key 而扩大工具面。
  - `draft_contract=auto` 时，没有已注入 draft-capable Skill 的 round 不输出 draft approval 合同和空 `allowedDraftTypes` 噪音。
  - 动态注入 draft-capable Skill 后，`skill.inject` 工具结果会返回 `draftTypes` 和 `approvalPolicy`，当前 active Skill 的后续 prompt/payload 才暴露 draft approval 合同。
- `SkillInjectionManager.allowed_tool_names()` 从固定 base tools 改为接收 profile policy，避免所有 profile 默认携带 `skill.inject`。
- `build_orchestrator_system_prompt()` 支持按 policy 选择：
  - 是否输出 Catalog records。
  - 是否输出 draft contract。
  - 是否输出 allowed draft types。
  - 是否输出 dynamic injection contract。
- 对小灶补回归：
  - provider tools 不包含 `skill.inject`。
  - system prompt 不包含其他 Skill catalog。
  - system prompt 不包含“生成 draft 后等待 approval”这类主工作台写入合同。
  - system prompt 不包含 `workspace.read_artifact` 或复读完整草稿/审批的提示。
  - user payload 不包含 draft/approval 历史 artifacts。
  - `ui.propose_actions`、当前菜谱读取和小灶原有回复逻辑保持不变。
- 对主工作台补回归：
  - provider tools 仍包含 `skill.inject`。
  - `skill.inject` schema 仍来自 `SkillRegistry.keys()`。
  - 动态注入、draft approval、result card 既有测试保持通过。

### Phase 5：Draft Operation Registry（已落地基础版）

- 新增 `DraftOperationSpec`。
- 先把现有 draft type 以不改变行为的方式注册进去：
  - `recipe`
  - `recipe_cook`
  - `shopping_list`
  - `meal_plan`
  - `meal_log`
  - `food_profile`
  - `ingredient_profile`
  - `inventory_operation`
  - `composite_operation`
- 审批配置、审批值校验和草稿执行入口已收敛到 registry lookup；仅保留正式服务仍使用的明确业务入口。
- 已删除 normalizer、approval config、executor 中的大段 draft type if/elif，改由 `DraftOperationSpec` 注册。
- 运行时“是否支持该 draft type”的判断已统一通过 `draft_operation_registry.supports(...)`；旧 `DRAFT_APPROVAL_CONFIG` 兼容导出已删除。
- `DraftOperationRegistry` 初始化时会拒绝重复 `draft_type`，避免新增写入型能力时后注册 spec 静默覆盖已有正式写入、审批配置或恢复逻辑。
- 已将 approval value shape validation 并入 `DraftOperationSpec.validate_approval_value`：
  - `approval_values.py` 不再按 draft type 分支校验确认值，统一调用 `draft_operation_registry.validate_approval_value(...)`。
  - 旧的 `validate_inventory_operation_shape`、`validate_operation_draft_shape` 和 `validate_single_target_operation_shape` 兼容 wrapper 已删除；测试直接验证 `draft_operation_registry.validate_approval_value(...)`。
- 已将 recovery current value loader、recovery hint、result artifact label/count/fallback/default action 文案并入 spec。
- 已将 operation result 卡片的默认动作、动作文案和业务实体 artifact 拆解规则并入 `DraftOperationRegistry` / `DraftResultMetadata`；`artifacts.py` 只保留卡片组装和面向当前调用方的查询 helper，避免新增 draft type 时继续修改结果展示分支。
- 已将审批执行成功后的 draft-type-specific 后置动作并入 `DraftOperationSpec.after_success`；当前 `inventory_operation` 的库存结果卡刷新不再写在审批主流程的 draft type 分支里。
- `compact_context.py` 的 draft artifact 类型集合和摘要优先使用 `draft_operation_registry.keys()` / `preview_summary()`，新增 draft type 时不再需要额外维护历史上下文摘要分支；异常或未知类型仍回退到通用 label。
- 已将 Draft Operation Registry 继续拆成三层：
  - `registry_types.py`：只承载 `DraftOperationSpec`、`DraftOperationRegistry`、上下文 dataclass、result metadata 和通用 artifact 记录 fallback。
  - `draft_specs/`：按领域承载当前业务 draft type 的 normalizer、executor adapter、approval copy、preview summary、recovery loader 和 spec 构造。
    - `draft_specs/common.py`：共享 approval base config、operation copy builder、通用 approval value validator 和 `_spec(...)` helper。
    - `draft_specs/recipes.py`：`recipe` / `recipe_cook`。
    - `draft_specs/planning.py`：`shopping_list` / `meal_plan` / `meal_log`。
    - `draft_specs/profiles.py`：`food_profile` / `ingredient_profile`。
    - `draft_specs/inventory.py`：`inventory_operation`。
    - `draft_specs/composite.py`：`composite_operation`。
  - `registry_specs.py`：只聚合各领域 spec list，保持一个 `build_draft_operation_specs()` 入口。
  - `registry.py`：只保留 `draft_operation_registry` 实例入口；registry 类型、context dataclass 和基础配置不再经由该文件兼容转导出。
- 新增写入型能力的确定性落点变为：
  1. 领域 service / tool validation 实现正式业务规则。
  2. 在对应 `draft_specs/<domain>.py` 增加一个 `_spec(...)` 注册项和必要 adapter；只有跨领域聚合规则变化时才改 `registry_specs.py`。
  3. 在对应 Skill `skill.yaml.draft_contract` 声明 draft type、schema version、approval config key 和 commit handler key。
  4. 补 registry / approval / recovery / result card 定向测试。
- 回归所有 approval、retry、recovery、operation_result 测试。

### Phase 6：Completion Policy 与 Terminal Guard（已落地基础版）

- 已通过 tool output 和 `ToolDefinition` 支持通用 follow-up 元数据。
- 已支持最小集合：
  - `requires_followup`
  - `terminal_output`
  - `followup_hint`
  - `output_types`
  - `draft_types`
- `ToolDefinition` 可声明工具级默认 completion contract；未声明时保持现有行为不变。
- `ToolDefinition.output_types` / `draft_types` 可声明工具级产物 contract；这些字段只做诊断和加载期校验，不替代 Skill output/draft policy、draft validation 或 approval registry。
- tool output 中的同名元数据优先级高于 `ToolDefinition` 默认值，允许单次调用按真实结果覆盖工具默认策略。
- Orchestrator 完成前统一检查 pending follow-up 和 terminal output：
  - 普通 assistant 文本是合法 terminal output。
  - result card、draft、human input 继续作为合法 terminal output。
  - tool output 可通过 `terminal_output=true` 声明自己已经是终态。
  - tool output 可通过 `requires_followup=true` 声明模型必须继续输出总结、追问、card 或 draft。
  - 如果本轮有工具输出但没有文本、card、draft、human input 或 terminal tool output，则返回 `failed`，不再静默 `completed`。
- 对现有中间工具逐步声明 contract，例如 preview/read 后是否需要解释、追问或 draft。
- 已补测试覆盖：
  - 中间 read/preview 后模型无文本时不能误标 completed。
  - 正常普通问答仍可 completed。
  - follow-up tool 后有普通文本时可 completed。
  - tool output 显式声明 `terminal_output` 时可无文本 completed。
  - `ToolDefinition` 声明 `requires_followup` / `terminal_output` 时无需每次在 output 重复声明。
  - tool output 可覆盖 `ToolDefinition` 默认 follow-up 策略。
  - 既有 result card、draft、human input 行为保持通过。
- Tool registry 诊断接口已暴露工具级 completion contract：
  - `/api/ai/registry.tools[]` 输出 `requires_followup`、`terminal_output`、`followup_hint`、`output_types` 和 `draft_types`。
  - 这反映 ToolDefinition 自身默认合同；Skill-level `completion_policy` 仍在运行时按当前 active Skill 合并到 provider 可见 tool definition。
- Tool registry 已补产物 contract 加载期校验：
  - draft tool 必须声明 `draft_types`；非 draft tool 不能声明 `draft_types`。
  - 当 output schema 明确 `card.type.enum` 时，`output_types` 必须覆盖这些 card 类型。
  - 第一批真实工具已声明产物合同：`inventory.read_summary -> inventory_summary`、`meal_plan.recommend_today -> today_recommendation`、`ui.propose_actions -> ui_actions`，以及所有 draft tool 对应的 `recipe`、`recipe_cook`、`shopping_list`、`meal_plan`、`meal_log`、`food_profile`、`ingredient_profile`、`inventory_operation`。
- Skill loader 已补 Skill/Tool 产物合同一致性校验：
  - Skill 暴露的工具如果声明了 `output_types`，这些类型必须包含在该 Skill 的 `skill.yaml.output_types` 中。
  - Skill 暴露的 draft tool 如果声明了 `draft_types`，这些类型必须包含在该 Skill 的 `skill.yaml.draft_types` 中。
  - 这样新增 card/draft 工具时，Tool contract、Skill manifest 和 Orchestrator 运行期允许产物不会静默分叉。

### Phase 7：Budget 与 Routing 配置化（基础版已落地）

- 已将 Orchestrator 全局预算常量升级为 profile-scoped `budget_config`：
  - `max_business_skills_per_run = 4`
  - `max_total_tool_calls_per_run = 32`
  - `max_same_read_tool_calls_per_run = 3`
- 已将 skill budget 和 `skill_injection` policy 组合起来：fixed/disabled profile 运行时 skill budget 固定为 0，dynamic profile 才允许按预算注入。
- dynamic profile 的业务 Skill slot 用完后，provider 可见 tool list 和 `skill.inject` 返回的 `availableTools` 都会移除 `skill.inject`；如果模型或测试伪造调用，runtime 仍返回结构化 `skill_budget_exhausted`，不执行任何额外能力注入。
- 小灶 profile 显式配置 `max_business_skills_per_run=0`，继续只使用固定预注入能力。
- 已补测试覆盖：
  - 主工作台默认预算等同现状。
  - 小灶 profile 运行时 budget 不暴露动态 skill 注入空间。
  - 自定义 profile skill budget 能阻止继续注入业务 Skill。
  - 自定义 profile total tool budget 能阻止工具执行。
  - 自定义 profile same read budget 能阻止重复读取。
- 已新增 route hints，并迁移为以 Skill catalog 为主的动态汇总：
  - `meal_plan` / `meal_planning` / `today_recommendation -> meal_plan`
  - `recipe` / `recipe_draft -> recipe_draft`
  - `recipe_cook` / `cook_recipe -> recipe_cook`
  - `inventory` / `inventory_analysis` / `inventory_summary` / `inventory_operation -> inventory_analysis`
  - `food` / `food_profile -> food_profile`
  - `ingredient` / `ingredient_profile -> ingredient_profile`
  - `meal_log` / `meal_record -> meal_log`
  - `shopping` / `shopping_list -> shopping_list`
- `WorkspaceGraphRunner` 初始化 run state 时统一使用 `profile.initial_skill_keys_for(quick_task, subject)`，不再直接读取静态 `profile.initial_skill_keys` 作为全部入口映射。
- 初始 route hint 注入会继续发出 skill progress，保持流式进度和既有前端体验。
- route hint 同时支持 `quick_task`、`subject.routeHint`、`subject.route_hint`、`subject.extra.routeHint` 和 `subject.extra.route_hint`。
- 已接入 Skill-level `route_hints` 基础版：
  - `SkillManifest` 从 `skill.yaml.route_hints` / `routeHints` 读取 route hint。
  - `WorkspaceGraphRunner` 在 resolve profile 后，用当前 `SkillRegistry` 将 catalog route hints 追加到 dynamic profile 的初始路由表。
  - fixed/disabled profile 不吃 catalog route hints，小灶仍只使用固定预注入 `cooking_assistant`。
  - dynamic profile 会校验当前可见 Skill 的 catalog route hints；同一个 route hint 如果同时指向多个 Skill，会在 profile registry 校验或 route hint 合并阶段失败，避免 quick task 隐式预注入多个业务能力。需要多 Skill 初始注入时，应显式写 profile route hint。
  - 现有 catalog 已补充与当前静态映射一致的 `route_hints`，当前主 AI 助手行为不变。
- 已将主工作台 profile 中的业务语义 route hints 迁出到 `skill.yaml`：
  - `MAIN_WORKSPACE_PROFILE` 不再硬编码 `meal_plan`、`today_recommendation`、`recipe`、`recipe_draft`、`recipe_cook`、`shopping`、`meal_log`、`meal_record`、`food`、`food_profile`、`ingredient`、`ingredient_profile`、`inventory`、`inventory_summary` 和 `inventory_operation` 这些业务路由。
  - 主工作台运行时仍通过 `profile_with_skill_route_hints()` 从当前 `SkillRegistry` 动态补回初始 Skill 映射。
- 已接入 Skill-level `tool_budget` 基础版：
  - `SkillManifest` 从 `skill.yaml.tool_budget` / `toolBudget` 读取 `max_tool_calls` 和 `max_same_read_calls`。
  - 初始注入 Skill 和运行中动态注入 Skill 后，Orchestrator 都会把 profile budget 与已注入 Skill budgets 取更严格值。
  - 现有 catalog Skill 都已声明 `max_tool_calls` 和 `max_same_read_calls: 2`；后者只限制同一 read tool + 同一参数签名的重复读取循环，不限制读取不同对象或不同列表。
  - `recipe_cook` 已配置保守 `max_tool_calls: 12`，覆盖搜索、读取、预览、库存读取、计划读取和生成做菜草稿等正常路径，同时避免做菜预览类任务无界循环。
  - 已为其余 Skill 补充第一轮保守预算，作为防循环 guardrail，不替代工具 schema、draft validation 或审批 service：
    - `cooking_assistant.max_tool_calls: 8`，覆盖做菜页面读取当前菜谱、库存和提出 UI 动作。
    - `food_profile.max_tool_calls: 10`，覆盖食物检索/读取、artifact 复读、必要追问和食物资料草稿。
    - `ingredient_profile.max_tool_calls: 10`，覆盖食材检索/读取、artifact 复读、必要追问和食材档案草稿。
    - `inventory_analysis.max_tool_calls: 14`，覆盖食材检索、库存摘要、临期/过期/低库存/可用库存读取和库存操作草稿。
    - `meal_log.max_tool_calls: 10`，覆盖食物检索、近期/单条用餐读取、artifact 复读、必要追问和用餐记录草稿。
    - `meal_plan.max_tool_calls: 18`，覆盖库存、近期用餐、食物/菜谱检索、已有计划读取、今日推荐和计划草稿。
    - `recipe_draft.max_tool_calls: 16`，覆盖食材候选召回、菜谱检索/读取、脚本 lint 和菜谱草稿。
    - `shopping_list.max_tool_calls: 14`，覆盖 artifact 读取、食材检索、待购清单读取、库存读取和购物清单草稿。
- 已接入 Skill-level `completion_policy` 基础版：
  - `SkillManifest` 从 `skill.yaml.completion_policy` / `completionPolicy` 读取 `requires_terminal_output`、`terminal_text_allowed`、`followup_required_tools` 和 `terminal_tools`。
  - `SkillManifest.to_catalog_record()`、`skill.inject` 注入结果和 `/api/ai/registry` 诊断接口都会暴露 `completionPolicy` / `completion_policy`，让配置层、模型可见上下文和诊断视图保持一致。
  - Orchestrator 为当前 active skills 生成运行期 `ToolDefinition` 时，将 Skill completion policy 合并到工具级 `requires_followup` / `terminal_output` / `followup_hint`。
  - Skill loader 已校验 `completion_policy.terminal_tools` 和 `completion_policy.followup_required_tools` 只能引用当前 Skill 声明的 `allowed_tools` 或 `script_files` 暴露出的 `script.*` 工具，避免配置拼写错误静默失效。
  - Orchestrator run state 会聚合当前 active skills 的终态策略：任一 Skill 要求 terminal output 时，本轮必须产出文本、card、draft、human input 或 terminal tool output；任一 Skill 禁止普通文本作为终态时，普通文本不计入 terminal output。
  - 动态注入 Skill 后会在同一 provider tool loop 内刷新 completion policy state，避免新注入 Skill 的终态合同延迟到下一轮才生效。
  - Runtime 合并只作用于当前 profile-filtered tool definitions；小灶这类 fixed profile 不会看到或继承未注入 Skill 的 completion policy。
  - Skill completion policy 已同时作用于业务 Tool 和 Skill 私有脚本 Tool；脚本不再绕过 `followup_required_tools` / `terminal_tools`。
  - tool output 元数据仍可覆盖 `ToolDefinition` / Skill policy 的默认值，保留单次工具调用按真实结果调整完成策略的能力。
  - 第一批真实卡片型工具已显式配置为 `terminal_tools`：
    - `cooking_assistant.ui.propose_actions`：页面操作建议卡可作为小灶页面动作终态。
    - `inventory_analysis.inventory.read_summary`：库存概览卡可作为库存查询终态。
    - `meal_plan.meal_plan.recommend_today`：即时餐食推荐卡可作为今日推荐模式终态。
  - 第一批真实列表读取工具已显式配置为 `followup_required_tools`：
    - `inventory.read_expiring_items`
    - `inventory.read_expired_items`
    - `inventory.read_low_stock_items`
    - `inventory.read_available_items`
  - 第二批真实业务读取工具已显式配置为 `followup_required_tools`：
    - 小灶：`recipe.read_by_id`、`inventory.read_available_items`
    - 库存查看与处理：`ingredient.search`、`ingredient.read_by_id`、`workspace.read_artifact`
    - 食物/食材档案：`food.search`、`food.read_by_id`、`ingredient.search`、`ingredient.read_by_id`、`workspace.read_artifact`
    - 餐食安排：库存、近期用餐、食物、菜谱、已有计划和 artifact 读取工具
    - 用餐记录：食物检索、近期/单条用餐读取和 artifact 读取工具
    - 购物清单：食材、待购清单、库存和 artifact 读取工具
    - 菜谱整理：食材候选、菜谱和 artifact 读取工具
    - 按菜谱做菜：菜谱、库存、已有计划和 artifact 读取工具
  - `recipe_cook` 已将真实中间工具 `recipe.preview_cook` 声明为 `followup_required_tools`，预览后必须继续说明缺料、请求补充信息，或在库存充足时生成 `recipe_cook` 草稿。
  - `recipe_draft` 已将 `script.lint_recipe_draft` 声明为 `followup_required_tools`，lint 后必须继续修正草稿、请求补充信息，或调用 `recipe.create_draft`。
  - `meal_plan` 已将 `script.expand_meal_slots`、`script.validate_meal_plan` 和 `script.render_plan_preview` 声明为 `followup_required_tools`，脚本输出后必须继续说明、追问或进入 `meal_plan` 草稿路径。
  - 已补 catalog 级测试门禁：每个 Skill 的非 draft、非 `human.request_input` 授权工具以及 Skill 私有脚本工具都必须出现在 `terminal_tools` 或 `followup_required_tools`，避免新增 read/preview/control/script 工具时漏掉终态合同。
  - Skill loader 已将同一规则下沉为加载期校验：当加载器拿到 `ToolRegistry` 时，非 draft、非 `human.request_input` 的授权业务工具和 Skill 私有脚本工具如果没有出现在 `terminal_tools` 或 `followup_required_tools`，catalog 会直接加载失败；纯 draft tool 不强制配置 completion policy，因为草稿审批中断本身由 draft/approval contract 处理。
- 已接入 Skill-level `draft_contract` 基础版：
  - `SkillManifest` 从 `skill.yaml.draft_contract` / `draftContract` 读取 draft type、schema version、approval config key 和 commit handler key。
  - `SkillManifest.to_catalog_record()`、`skill.inject` 注入结果和 `/api/ai/registry` 诊断接口都会暴露 `draftContract` / `draft_contract`。
- Skill loader 会校验 `draft_contract` 只能引用当前 Skill 声明的 `draft_types`，避免写入型能力合同和可生成草稿类型分叉。
- Skill loader 已进一步校验 `approval_policy: draft_then_confirm` 的 Skill 必须为每个 `draft_type` 声明完整 `draft_contract`，且每个 contract 必须包含 `schemaVersion`、`approvalConfigKey` 和 `commitHandlerKey`，避免配置缺失到运行期才暴露。
- Skill loader 已将关键 runtime contract 改为严格解析：
  - `tool_budget` 必须是 mapping，`max_tool_calls` / `max_same_read_calls` 必须是非负整数。
  - `allowed_tools`、`context_policy`、`script_files`、`output_types`、`draft_types`、`route_hints`、`examples` 和 `instruction_files` 必须是 list，且同一字段内不允许重复值。
  - `completion_policy` 必须是 mapping；`requires_terminal_output` / `terminal_text_allowed` 如果显式配置，必须是真布尔值；`terminal_tools` 和 `followup_required_tools` 也必须是 mapping，tool key 不能为空，hint 必须是非空字符串。
  - `draft_contract` 必须是 mapping，且每个 draft type entry 也必须是 mapping。
  配置格式错误会在 Skill catalog 加载阶段失败，不再被静默忽略。
- `SkillRegistry.register()` 已拒绝重复 Skill key，避免后加载的 catalog 静默覆盖先加载能力，造成路由、工具白名单或 profile 权限不可预测。
- 当前所有写入型 catalog Skill 都已声明对应 draft contract，并通过测试校验这些 draft type 已存在于 `DraftOperationRegistry`。
  - 该字段是只读能力合同和诊断配置，不改变正式写入路径；用户确认后的 commit 仍由 `services/ai_operations` 的确定性 registry/service 执行。
- 待继续：
  - 继续根据真实 trace 调整各 Skill 的 `tool_budget`，尤其是 `max_tool_calls` 和 `max_same_read_calls` 的具体阈值，避免过松导致循环、过紧导致正常多步骤任务被提前截断。
  - 继续为其他真实 preview/read 工具补充业务合适的 `completion_policy`，例如预览后必须解释、追问或进入 draft 的能力。
  - 后续新增业务入口 hint 优先写入对应 Skill 的 `skill.yaml.route_hints`，不要再回写主 profile；如果一个入口 hint 需要跨 Skill 共享语义，先设计更明确的二级 hint 或 profile matcher，避免把模糊路由塞回主 profile。

### Phase 8：模块拆分与清理（状态、工具、结果与完成判断模块已抽出）

- 已抽出 `backend/app/ai/workflows/orchestrator/state.py`：
  - `OrchestratorRunState` 从原平铺 Orchestrator 入口迁出。
  - `workflows/orchestrator/__init__.py` 继续兼容导出 `OrchestratorRunState`，外部旧导入路径不变。
  - 未改变 `WorkspaceOrchestratorAgent.run()`、runner state、SSE、draft、card 或 approval 行为。
- 已抽出 `backend/app/ai/workflows/orchestrator/tools.py`：
  - `OrchestratorToolGateway` 从原平铺 Orchestrator 入口迁出。
  - `workflows/orchestrator/__init__.py` 继续兼容导出工具网关相关名称，测试和旧调用方不需要同步改导入路径。
  - 保持 profile-scoped capability exposure 行为不变：主工作台仍可动态注入，小灶仍不暴露 `skill.inject`、全量 catalog 或 draft contract。
  - `OrchestratorToolGateway` 不再反向依赖完整 `WorkspaceOrchestratorAgent`；工具执行、预算检查、草稿捕获、progress event 和 completion metadata 状态记录集中在工具网关内。
- 已抽出 `backend/app/ai/workflows/orchestrator/skill_injection.py`：
  - `SkillInjectionBundle`、`SkillInjectionManager` 和 `DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES` 从 `orchestrator/tools.py` 继续拆出。
  - Skill key 规范化、catalog filtering、profile-scoped allowed tools、Skill-level budget 合并、Skill-level completion policy 合并、scoped executor 构造和 draft type 推断集中在注入模块。
  - `orchestrator/tools.py` 保留兼容导入，外部仍可从包入口取到这些名称。
  - 该拆分让工具网关更聚焦“执行 provider 请求的工具调用”，让新增 Skill 配置和 profile 能力面相关逻辑更容易单独测试和维护。
- 已抽出 `backend/app/ai/workflows/orchestrator/tool_schemas.py`：
  - `remaining_skill_slots()` 统一计算当前 profile/run 还能动态注入多少业务 Skill。
  - `provider_visible_tools()` 统一过滤 provider 可见工具，并在 Skill slot 用尽时移除 `skill.inject`。
  - `with_runtime_tool_schema()` 统一按当前 `SkillRegistry`、`allowed_skill_keys` 和剩余 Skill slot 生成运行期 `skill.inject` schema。
- 已抽出 `backend/app/ai/workflows/orchestrator/skill_runtime.py`：
  - `skill_injection_request()` 统一解析并校验 `skill.inject.skills` payload。
  - `execute_skill_injection()` 统一处理 unknown skill、skill budget、active skill 更新、budget / completion policy 重新合并、progress event、trace event 和注入结果 payload。
  - `OrchestratorToolGateway` 不再内联 dynamic schema 和 `skill.inject` 运行逻辑，只负责路由 control tool 调用并记录 completion metadata。
- 已抽出 `backend/app/ai/workflows/orchestrator/tool_budget.py`：
  - `evaluate_tool_budget()` 统一处理总工具调用预算和同一 read tool 重复读取 loop guard。
  - 预算拒绝输出仍保持原有 `tool_budget_exhausted` / `tool_loop_detected` 结构，避免改变 provider 和测试契约。
- 已抽出 `backend/app/ai/workflows/orchestrator/draft_capture.py`：
  - `prepare_tool_payload()` 统一处理 draft tool payload 包装差异和 `afterApproval` 提取。
  - `enforce_single_draft_per_call()` 统一保证一轮最多一个 draft 的审批中断规则。
  - `capture_draft_output()` 统一捕获 draft tool 的真实输出、schema version、progressive draft publisher 结果和 draft 去重 key。
- 已抽出 `backend/app/ai/workflows/orchestrator/tool_outputs.py`：
  - `capture_tool_contract_metadata()` 统一记录 tool output keys、pending follow-up 和 terminal tool output。
  - `OrchestratorToolGateway` 继续负责工具调度顺序，但不再内联预算判断、draft 捕获和 completion metadata 状态更新细节。
- 已抽出 `backend/app/ai/workflows/orchestrator/progress.py`：
  - `preview_tool_call_progress()` 统一处理 provider preview callback 的 event id、script/tool event type 和 progress event emit。
  - `tool_progress_message()` 统一生成工具进度文案，保留 `human.request_input` waiting、draft 生成和失败状态文案。
- 已抽出 `backend/app/ai/workflows/orchestrator/human_input.py`：
  - `repeated_human_input_output()` 统一生成一轮内重复请求用户补充信息的结构化错误。
  - `raise_human_input_request()` 统一标记本轮已请求人机补充、生成 `human_input` id 并抛出 `HumanInputRequired`。
  - `OrchestratorToolGateway` 不再内联 human input interrupt request 构造。
- 已抽出 `backend/app/ai/workflows/orchestrator/results.py`：
  - `OrchestratorResultAssembler` 承载 completed、approval、human input、terminal guard failed 和 provider failed result 组装。
  - draft/card validation、orchestrator context summary 和 program context summary 从原平铺 Orchestrator 入口迁出。
  - `workflows/orchestrator/agent.py` 保留同名私有方法作为薄代理，避免测试和调试入口在本阶段被迫同步迁移。
- 已抽出 `backend/app/ai/workflows/orchestrator/completion.py`：
  - `OrchestratorCompletionGuard` 承载 Terminal Output Guard / follow-up 判断。
  - `OrchestratorCompletionDecision` 明确表达是否已有终态输出以及失败原因。
  - `workflows/orchestrator/__init__.py` 继续兼容导出 `OrchestratorCompletionGuard`，`OrchestratorResultAssembler` 只负责把判断结果组装成 `SkillResult`。
- 已抽出 `backend/app/ai/workflows/orchestrator/signatures.py`：
  - `tool_signature()` 统一 Orchestrator runtime 去重和 Runner 持久化 tool call artifact 的签名格式。
  - `historical_tool_signatures()` 统一从 current run artifacts 恢复历史 tool signature。
  - `workflows/orchestrator/agent.py` 继续保留 `_tool_signature()` / `_historical_tool_signatures()` 薄代理，避免旧调试入口断裂。
- 已抽出 `backend/app/ai/workflows/orchestrator/tool_contracts.py`：
  - `ToolCompletionMetadata` 和 `tool_completion_metadata()` 承载工具完成契约元数据解析。
  - `ToolDefinition` 默认值、tool output 顶层字段和 `metadata` / `_meta` / `orchestrator` / `orchestratorMetadata` 嵌套字段的合并规则从 `OrchestratorToolGateway` 迁出。
  - `OrchestratorToolGateway` 只负责记录状态和执行工具，不再内联解析 `requires_followup`、`terminal_output` 和 `followup_hint`。
  - 已补纯函数测试，覆盖工具定义默认合同、顶层输出覆盖和嵌套 metadata 覆盖。
- 已在 system prompt 中加入机器可读的 `Prompt contract metadata`，包含 profile key、capability policy、catalog/dynamic injection/draft contract 开关、catalog keys、injected skill keys 和 allowed draft types。
- 已抽出 `backend/app/ai/workflows/orchestrator/payloads.py`：
  - `OrchestratorPromptPayloadBuilder` 承载 profile state、capability policy、budget config、system prompt、user payload 和 multimodal provider input 构造。
  - `workflows/orchestrator/agent.py` 保留 `_system_prompt()`、`_user_payload()`、`_provider_user_input()` 等薄代理，兼容既有测试和调试入口。
  - 该拆分只移动纯构造逻辑，不改变主工作台、小灶、dynamic injection、draft contract 或 multimodal message 运行行为。
- 已将高脆弱 profile/draft contract 测试迁移到解析 `Prompt contract metadata`，减少对具体中文提示词句子的依赖；后续继续把剩余 prompt 文案断言区分为“产品文案意图测试”和“能力面合同测试”。
- 已将 profile/capability surface 诊断信息纳入 `SkillResult.context_summary.orchestrator`：
  - `profileKey`
  - `responseStyle`
  - `capabilityPolicy`
  - `budget`
  这样失败、等待审批、人机补充和正常完成路径都能从结果 summary 看到当前 run 的真实能力面。
- 已抽出 `backend/app/ai/workflows/orchestrator/streaming.py`：
  - `emit_visible_delta()` 统一构造 Orchestrator 可见文本的 `message_delta` SSE event。
  - `workflows/orchestrator/agent.py` 保留 `_emit_visible_delta()` 薄代理，避免旧测试和调试入口断裂。
  - 该拆分只移动事件构造逻辑，不改变 `message_id`、`conversation_id`、`run_id`、`part_id`、`delta` 或 draft 生成期间暂停可见 delta 的行为。
- 已补固定 profile 续跑污染回归：
  - 如果恢复 state 中混入 `meal_plan`、`recipe_draft` 等非小灶 Skill key，Orchestrator 会按小灶 profile 过滤为 `cooking_assistant`。
  - provider tool list 不出现 `skill.inject`、`meal_plan.create_draft` 或 `recipe.create_draft`。
  - system prompt metadata、user payload 和 result context summary 三处的 injected skill surface 保持一致。
- 已将 Orchestrator 入口处的 injection history source 区分为首轮 `initial` 和续跑 `existing`，避免恢复后把既有能力误记成新入口初始注入。
- 已收紧 profile 外置配置解析：
  - `OrchestratorProfileRegistry.from_state()` 不再静默跳过非 mapping profile 条目。
  - `OrchestratorProfile.from_state()` 对显式配置的 `route_hints`、`matcher`、`capability_policy` 和 `budget_config` 做结构校验，错误配置在加载 profile registry 时直接失败。
  - Runtime 读取 checkpoint/prompt state 的 `profile_state_value()` 和 `OrchestratorCapabilityPolicy.from_state()` 仍保留兼容解析，避免历史 run state 因缺字段无法恢复。
- 已将 Runner 首轮 profile 初始化收敛到单一 helper：
  - 同步 `invoke_user_message()` 和流式 `_stream_prepared_user_message()` 共用同一套 resolve profile、合并 Skill-level route hints、计算 initial skill keys 的逻辑。
  - 后续 profile matcher、dynamic route hints 或 capability policy 规则调整时，不需要分别修改同步和流式入口。
- 已抽出 `backend/app/ai/workflows/runner_support/approval_resume.py`：
  - `approval_resume_payload_from_metadata()` 统一处理 draft `afterApproval` payload，保留历史行为：即使没有显式 `afterApproval`，只要 draft 存在，也会给审批后 Orchestrator 续跑生成默认 instruction。
  - `approval_resume_artifact()` 统一生成 `draft_after_approval` run artifact。
  - `approval_waiting_state_patch()`、`approval_failed_state_patch()` 和 `approval_resolved_state_patch()` 统一构造 approval resume 的 LangGraph state patch，避免 `_resume_pending_approval()` 与 `_resume_recorded_approval_decision()` 分支重复手写 pending approval、pending human input、injected skills 和 run artifacts 字段。
  - Runner 仍负责 DB 查询、run/conversation 状态、审批提交、stream checkpoint 和 follow-up streaming；该拆分只移动纯数据构造，不改变 `draft -> approval -> commit` 边界。
- 已抽出 `backend/app/ai/workflows/runner_support/message_parts.py`：
  - `draft_message_part()` 和 `approval_request_message_part()` 统一生成 draft / approval message part，progressive draft publish 和最终 assistant 持久化复用同一 shape。
  - `result_card_message_part()`、`human_input_request_message_part()`、`text_message_part()`、`append_progressive_draft_metadata()`、`aggregate_text_from_parts()`、`result_cards_from_parts()` 和 `terminal_message_text()` 承载纯 message part 构造、聚合与终态文本兜底。
  - `_persist_assistant_result()`、`_append_text_to_assistant_message()` 和 `_finalize()` 不再内联这些 part shape、text/card 聚合和终态兜底规则，降低前后端 message part 契约漂移风险。
- 已抽出 `backend/app/ai/workflows/runner_support/run_summary.py`：
  - `result_context_summary()` 统一计算 Orchestrator result 写回 `AIAgentRun.context_summary` 时的 routing、skill executions、run metrics、clarification stats 和 last human input result。
  - `record_skill_observation()` 与 `record_approval_outcome_summary()` 承载纯 metrics 更新，Runner 只保留兼容薄代理和 DB 字段赋值。
  - `_persist_assistant_result()` 后半段不再内联 summary/metrics 细节，减少后续新增 profile、Skill 或审批指标时的主流程改动面积。

### Phase 9：Runner 分步拆分（已完成）

本阶段目标是降低 `WorkspaceGraphRunner` 单文件复杂度，但不改变 LangGraph、SSE、审批、message part 或前端响应合同。后续必须严格按以下顺序推进；每个子步骤完成后更新本节状态和验证结果。

#### Phase 9.0：拆分前基线确认

状态：已完成（2026-06-30）。

执行内容：

- 读取 `runner.py` 当前方法列表和本节职责分组，确认本次只做一个子步骤。
- 记录当前 `runner.py` 行数、目标迁移方法和目标文件。
- 跑一次 AI infra 基线，确认不是在红测试上继续拆。

实际结果：

- 当前 `runner.py` 为 `3598` 行；Runner 仍保留 LangGraph 入口、审批/人机恢复、assistant message 持久化、stream bridge、finalize、response/live cache 等职责。
- 当前 `runner_support/` 已存在 `approval_resume.py`、`message_parts.py`、`run_summary.py`；`Phase 9.1` 起新增的目标文件仍是 `attachments.py` 与 `message_preparation.py`，本步骤不提前创建其他 helper。
- 基线方法清单已重新核对：
  - `Phase 9.1` 目标迁移：`_normalize_chat_attachments()`、`_message_summary()`、`_attachment_summaries()`、`_build_user_message_parts()`、`_provider_images_for_attachments()` -> `runner_support/attachments.py` / `runner_support/message_preparation.py`
  - `Phase 9.2` 目标迁移：`_make_stream_worker_runner()`、`_enqueue_stream_event()`、`_drain_stream_graph()`、`_handle_stream_worker_exception()`、`_consume_stream_graph_worker()` -> `runner_support/stream_bridge.py`
  - `Phase 9.3` 目标迁移：`_human_input_answer_summary()` 及 human input resume 纯构造逻辑 -> `runner_support/human_input_resume.py`
  - `Phase 9.4` 目标迁移：approval resume payload/follow-up 文本与 part 构造 -> `runner_support/approval_resume.py` / `runner_support/approval_followup.py`
  - `Phase 9.5` 目标迁移：assistant message metadata、part 去重与 summary payload helper -> `runner_support/message_persistence.py`

验证结果：

- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `307 passed, 154 subtests passed`
- `git diff --check` -> 通过

验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
git diff --check
```

#### Phase 9.1：附件与用户消息准备拆分

状态：已完成（2026-06-30）。

目标文件：

- `backend/app/ai/workflows/runner_support/attachments.py`
- `backend/app/ai/workflows/runner_support/message_preparation.py`

可迁移方法：

- `_normalize_chat_attachments()`
- `_message_summary()`
- `_attachment_summaries()`
- `_build_user_message_parts()`
- `_provider_images_for_attachments()`

暂不迁移：

- `_prepare_user_message()`：它创建 conversation/run/message，涉及 DB 写入和幂等逻辑，第一步只让它调用 helper，不把整个方法搬走。
- `_load_ai_message_attachment_assets()`：涉及 media 读取和归属校验，先保留在 Runner，后续如果要迁移必须补 multimodal 附件测试。

实际改动：

- 新增 `backend/app/ai/workflows/runner_support/attachments.py`，下沉了 `normalize_chat_attachments()`、`attachment_summaries()`、`build_user_message_parts()` 和 `provider_images_for_attachments()`。
- 新增 `backend/app/ai/workflows/runner_support/message_preparation.py`，下沉了 `message_summary()`。
- `WorkspaceGraphRunner` 仍保留 `_prepare_user_message()`、`_load_ai_message_attachment_assets()` 和现有 DB/媒体绑定顺序；本步骤只把附件与用户消息准备的纯构造逻辑改为调用 helper。
- `runner.py` 从 `3598` 行降到 `3530` 行；附件相关逻辑转移到新 helper 后，当前入口、message part shape 和 provider image input shape 保持不变。后续 Phase 11 已将剩余 Runner 附件纯转发 wrapper 删除，并把测试改为直接覆盖 helper。

验证结果：

- `backend/.venv/bin/python -m py_compile $(find backend/app/ai/workflows -type f -name '*.py')` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_workspace_chat.py -q` -> `19 passed, 2 subtests passed`
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py -q` -> `65 passed`

验收标准：

- message content、parts、attachment summary、provider image input 结构不变。
- 多模态附件路径仍通过现有 media 归属和读取逻辑，不绕过 `services/media.py`。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_workspace_chat.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py -q
```

#### Phase 9.2：stream bridge 拆分

状态：已完成（2026-06-30）。

目标文件：

- `backend/app/ai/workflows/runner_support/stream_bridge.py`

可迁移方法：

- `_make_stream_worker_runner()`
- `_enqueue_stream_event()`
- `_drain_stream_graph()`
- `_handle_stream_worker_exception()`
- `_consume_stream_graph_worker()`

暂不迁移：

- `_stream_graph_events()`：保留在 Runner 作为 stream orchestration 入口，第一步只把 worker、queue、drain 和 exception 处理下沉。
- live stream cache 相关方法：本阶段不碰 `_cache_live_*` 和 `_base_assistant_parts_from_live_stream()`。

实际改动：

- 新增 `backend/app/ai/workflows/runner_support/stream_bridge.py`，下沉了 `make_stream_worker_runner()`、`enqueue_stream_event()`、`drain_stream_graph()`、`handle_stream_worker_exception()` 和 `consume_stream_graph_worker()`。
- `WorkspaceGraphRunner._stream_graph_events()` 继续保留线程启动、SSE subscriber 断开处理和 `_STREAM_DONE` 消费逻辑；本步骤没有改动 `progress` / `message_delta` / `response` / `error` 事件出口。
- `runner.py` 从 `3530` 行降到 `3469` 行；stream bridge 相关方法在 Runner 中保留薄 wrapper，继续复用既有调用入口。
- 拆分后补了一个兼容修正：当测试或调用方通过 `runner_factory` 直接复用一个轻量 `WorkspaceGraphRunner` 实例时，helper 包装不再提前强读 `self.provider`，从而保持“断开 SSE 订阅但 worker 继续执行”的测试场景不变。

验证结果：

- `backend/.venv/bin/python -m py_compile $(find backend/app/ai/workflows -type f -name '*.py')` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py::AIWorkspaceStreamingTestCase::test_graph_stream_disconnect_continues_worker_without_blocking_close -q` -> `1 passed`
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `307 passed, 154 subtests passed`

必须保留的语义：

- 客户端断开只停止当前 SSE subscriber，不取消后台 graph run。
- `progress`、`message_delta`、`response`、`error` event shape 不变。
- worker exception 必须仍能落到 run/conversation failed 状态。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_ai_observability.py -q
```

#### Phase 9.3：human input resume 拆分

状态：已完成（2026-06-30）。

目标文件：

- `backend/app/ai/workflows/runner_support/human_input_resume.py`

可迁移内容：

- `_human_input_answer_summary()` 这类纯摘要逻辑。
- human input request part 的状态更新 helper。
- `_resume_pending_human_input()` 中不直接触发 DB commit/checkpoint 的 payload 和 state patch 构造。

暂不迁移：

- `resume_human_input()`、`stream_resume_human_input()` 对外入口。
- DB 查询、run/conversation 状态切换、checkpoint 提交。

实际改动：

- 新增 `backend/app/ai/workflows/runner_support/human_input_resume.py`，下沉了 `human_input_answer_summary()`、`human_input_response_payload()`、`human_input_result_artifact()`、`completed_human_input_request_parts()`、`human_input_message_metadata()`、`human_input_conversation_context()` 和 `human_input_resume_state_patch()`。
- `WorkspaceGraphRunner._resume_pending_human_input()` 继续保留 assistant message 查询、run/conversation 状态切换和 `db.flush()`；本步骤只把 human input 的纯 payload、artifact、part 更新和 state patch 构造改为调用 helper。
- `runner.py` 从 `3469` 行降到 `3443` 行；human input resume 的返回 state shape、artifact shape 和消息 part 更新时机保持不变。

验证结果：

- `backend/.venv/bin/python -m py_compile $(find backend/app/ai/workflows -type f -name '*.py')` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_workspace_orchestrator_human_input_interrupt_resumes_same_run backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_human_input_response_stream_returns_message_deltas -q` -> `2 passed`
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q` -> `26 passed`

验收标准：

- 同一个 run 恢复，不创建新 run。
- human input part 状态从 pending 正确变为 completed。
- 恢复后 stream 仍发新的 `message_delta`，且顺序在 human input request 之后。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_workspace_orchestrator_human_input_interrupt_resumes_same_run -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_human_input_response_stream_returns_message_deltas -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py -q
```

#### Phase 9.4：approval resume / follow-up 拆分收敛

状态：已完成（2026-06-30）。

目标文件：

- 扩展 `backend/app/ai/workflows/runner_support/approval_resume.py`
- 新增 `backend/app/ai/workflows/runner_support/approval_followup.py`

可迁移内容：

- `_approval_followup_fallback_text()`
- `_approval_resume_payload()` 的剩余薄 wrapper。
- `_stream_approval_followup()` 和 `_append_approval_followup_fallback()` 中可纯函数化的 message text/part 构造。

暂不迁移：

- `resume_approval()`、`apply_approval_decision_fast()`、`stream_resume_approval()` 对外入口。
- `_resume_pending_approval()` 和 `_resume_recorded_approval_decision()` 的 DB 状态编排主体。
- `_commit_stream_checkpoint()` 调用位置。

实际改动：

- 扩展 `backend/app/ai/workflows/runner_support/approval_resume.py`，新增 `approval_resume_draft_id()`；Runner 中保留的 DB 读取逻辑已改名为 `_approval_resume_payload_from_decision()`，不再保留旧 `_approval_resume_payload()` 兼容方法名。
- 新增 `backend/app/ai/workflows/runner_support/approval_followup.py`，下沉了 `approval_followup_fallback_text()` 和 `approval_followup_delta_event()`。
- `WorkspaceGraphRunner` 继续保留审批应用、`db.flush()`、`_commit_stream_checkpoint()` 和续跑决策；本步骤只把 approval follow-up 的纯文本/事件构造改为调用 helper。
- `runner.py` 从 `3443` 行降到 `3431` 行；approval result card、message part shape 和 follow-up fallback 输出保持不变。

验证结果：

- `backend/.venv/bin/python -m py_compile $(find backend/app/ai/workflows -type f -name '*.py')` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `307 passed, 154 subtests passed`

必须保留的语义：

- 审批应用和 DB flush 后，必须先成功提交 checkpoint，再允许后续 Orchestrator resume 继续。
- 审批失败、拒绝、成功无续跑、成功需续跑四类状态 patch 不变。
- approval result card 和 message part shape 不变。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_approvals.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py::AIWorkspaceStreamingTestCase::test_ai_workspace_stream_approval_commits_image_job_before_resume_finishes -q
```

#### Phase 9.5：assistant message persistence 拆分

状态：已完成（2026-06-30）。此步骤风险最高，已在 9.1 到 9.4 通过后执行。

目标文件：

- `backend/app/ai/workflows/runner_support/message_persistence.py`

可迁移内容：

- assistant message metadata 合并 helper。
- progressive draft part 去重 helper。
- run/conversation summary payload 构造 helper。
- `_sync_message_parts_with_current_approval_state()` 如果迁移，必须保持 serializer 输出不变。

暂不迁移：

- `_persist_assistant_result()` 整体方法第一轮不搬。先让它调用 helper，保留 DB 写入顺序可读。
- `_finalize()` 中 run/conversation 状态最终落库逻辑。

实际改动：

- 新增 `backend/app/ai/workflows/runner_support/message_persistence.py`，下沉了：
  - `initial_assistant_message_metadata()`
  - `merge_assistant_skill_metadata()`
  - `message_metadata_with_draft_ids()`
  - `dedupe_message_parts()`
  - `sync_message_parts_with_current_approval_state()`
  - `run_output_payload()`
  - `conversation_context_with_state_patch()`
- `WorkspaceGraphRunner._persist_assistant_result()` 继续保留 assistant message 创建/查找、draft/approval 持久化、run/conversation 状态落库和 `db.flush()` 顺序；本步骤只把 metadata 合并、part 去重/同步、run output payload 和 conversation state patch 构造改为调用 helper。
- `runner.py` 从 `3431` 行降到 `3398` 行；draft/approval part 顺序、`waiting_approval` 切换、run `output/context_summary/tool_calls` 和 conversation `last_run_status` 保持不变。

验证结果：

- `backend/.venv/bin/python -m py_compile $(find backend/app/ai/workflows -type f -name '*.py')` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `307 passed, 154 subtests passed`

验收标准：

- draft 后仍进入 `waiting_approval`。
- real draft/approval part 不重复。
- result card、human input request、text part 顺序不变。
- run `output`、`context_summary`、`tool_calls`、conversation `last_run_status` 不变。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_approvals.py -q
```

#### Phase 9.6：response / live cache 边界评估

状态：已评估，暂不执行（2026-06-30）。

原因：

- `_chat_response()`、`_new_progress_events()`、`_persistent_progress_writer()`、`_cache_live_*()` 和 `_base_assistant_parts_from_live_stream()` 与 stream 恢复、前端工作区显示、response included 数据强相关。
- 如果没有明确 bug、测试缺口或继续增长压力，不为了降低行数强拆。

评估结论：

- 9.6 的前置条件已满足：
  - backend `test_workspace_chat.py`、`test_workspace_streaming.py` 已覆盖 response `included.result_cards/drafts/approvals`
  - backend streaming + frontend `AiWorkspace` 测试已覆盖 live/approval restore 相关行为
  - 当前拆分边界仍保持 `runner.py` 作为唯一对外 orchestration owner
- 但本轮没有发现 `_chat_response()`、live cache 或 progress writer 的明确 bug、测试缺口或继续膨胀压力；继续为了降行数强拆会把 stream 恢复和前端 contract 风险拉高，不符合本计划“非默认执行”的约束。
- 因此 9.6 本次记录为“已评估，暂不执行”，后续只有在出现真实缺陷、覆盖缺口或职责继续膨胀时再单独开启。

验证结果：

- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_chat.py -q` -> `43 passed, 2 subtests passed`
- `npm --prefix frontend run test -- AiWorkspace` -> `6 files passed, 56 tests passed`

只有满足以下条件才执行：

- 已有测试覆盖 response `included.result_cards/drafts/approvals`。
- 已有测试覆盖 live text part 去重、progress activity part、approval restore。
- 拆分方案能保持 `runner.py` 作为唯一对外 orchestration owner。

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_workspace_streaming.py backend/tests/ai_infra/test_workspace_chat.py -q
npm --prefix frontend run test -- AiWorkspace
```

#### Phase 9 完成标准

Phase 9 不是以“Runner 行数最少”为完成标准，而是以职责边界清晰和行为稳定为标准：

- `runner.py` 保留对外入口、LangGraph 节点、事务/checkpoint 顺序。
- 构造型、摘要型、stream bridge 型 helper 已移出并有测试覆盖。
- 完整 `backend/tests/ai_infra -q` 通过。
- 文档记录每个已执行子步骤、验证命令和仍保留在 Runner 中的原因。

### Phase 10：真实 Skill 配置补齐（已完成当前轮收口）

状态：10.1、10.2、10.3、10.4 已完成（2026-06-30）。

本阶段目标不是再造新的 Orchestrator 框架，而是用当前真实 Skill / Tool 配置把高风险能力补齐到“更少重复、更不易误判 completed、更容易给新增入口复用”的状态。

#### 本次审计结论

- 当前 `backend/app/ai/skills/catalog/*/skill.yaml` 的基础字段整体已经补齐：
  - `tool_budget`：9 个 catalog Skill 全部已声明。
  - `completion_policy`：9 个 catalog Skill 全部已声明。
  - `route_hints`：除固定页面助手 `cooking_assistant` 外，其余业务 Skill 都已声明；`cooking_assistant` 作为 fixed profile 页面能力，当前无 route hint 是合理的。
  - `draft_contract`：所有 draft-capable Skill 均已声明，非草稿型 `cooking_assistant` 无该字段是合理的。
- 当前 Skill-level `completion_policy` 覆盖也已经成型：每个 Skill 的非 draft、非 `human.request_input` 业务工具，以及 Skill 私有脚本工具，都已落在 `terminal_tools` 或 `followup_required_tools` 中，没有发现明显漏配的业务 Skill。
- 当前 ToolDefinition 层面的产物合同也已经基本补齐：
  - 所有 draft tool 都已声明 `draft_types`。
  - 当前真实 card tool 已声明 `output_types`：`inventory.read_summary`、`meal_plan.recommend_today`、`ui.propose_actions`。
- 当前主要剩余缺口不在 `skill.yaml` 是否“有没有字段”，而在 ToolDefinition 默认 completion contract 仍然偏薄：
  - 大多数真实 read / preview / card tool 的 ToolDefinition 仍未声明默认 `requires_followup`、`terminal_output`、`followup_hint`。
  - 这些语义目前主要重复写在各 Skill 的 `completion_policy` 里；对当前路径可用，但对未来复用、跨 Skill 一致性和诊断透明度仍不够理想。
- 因此 Phase 10 的重点应从“补空字段”转成“收敛真实高风险 Skill 的 completion / budget / route hint 配置，并把稳定共性的 Tool contract 从 Skill 层下沉到 ToolDefinition 默认值”。

#### Phase 10.1：inventory_analysis 与库存共享工具合同收敛

状态：已完成（2026-06-30）。

目标：

- 优先收敛库存相关共享读取工具的默认 ToolDefinition contract，减少后续新增 Skill 时重复抄写 follow-up 语义。
- 保持 `inventory_analysis` 当前 `route_hints`、`tool_budget`、`draft_contract` 和前端 contract 不变，避免无收益重写。

当前审计判断：

- `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml` 已完整声明 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract`。
- 风险点不在 Skill 缺字段，而在 `backend/app/ai/tools/catalog/inventory.py` 的共享读取工具默认 contract 仍为空：
  - `inventory.read_summary` 已有 `output_types=inventory_summary`，但 ToolDefinition 默认层未声明 terminal contract。
  - `inventory.read_expiring_items`、`inventory.read_expired_items`、`inventory.read_low_stock_items`、`inventory.read_available_items` 仍主要依赖 Skill-level `followup_required_tools`。

实际改动：

- 保持 `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml` 不变：`route_hints`、`tool_budget`、`draft_contract` 和现有 Skill-level `completion_policy` 未重写，避免把 10.1 扩成 inventory Skill 清理。
- 在 `backend/app/ai/tools/catalog/inventory.py` 为 5 个库存共享读取工具补了默认 ToolDefinition contract：
  - `inventory.read_summary`
    - `terminal_output=True`
    - `followup_hint="库存概览卡可作为库存查询的终态输出。"`
  - `inventory.read_expiring_items`
    - `requires_followup=True`
    - `followup_hint="临期列表读取后必须总结重点、请求补充信息，或生成库存处理草稿。"`
  - `inventory.read_expired_items`
    - `requires_followup=True`
    - `followup_hint="过期列表读取后必须总结风险、请求补充信息，或生成库存处理草稿。"`
  - `inventory.read_low_stock_items`
    - `requires_followup=True`
    - `followup_hint="低库存列表读取后必须总结补货重点、请求补充信息，或生成库存处理草稿。"`
  - `inventory.read_available_items`
    - `requires_followup=True`
    - `followup_hint="可用库存读取后必须总结可用食材、请求补充信息，或生成库存处理草稿。"`
- 同步更新了只反映“原始 ToolDefinition 诊断值”的测试：
  - `backend/tests/ai_infra/test_tool_registry.py`
  - `backend/tests/ai_infra/test_registry_and_metrics.py`
  - 测试重点保持在共享 Tool contract 的布尔语义和元数据存在性：
    - `inventory.read_summary` 必须声明 `terminal_output=True`
    - 库存列表类读取工具必须声明 `requires_followup=True`
    - 诊断接口和 registry 都要能暴露对应的 `followup_hint`
  - 不再逐字断言每条中文 `followup_hint` 文案，避免把正常文案微调误报成 contract 回归。

验证结果：

- `backend/.venv/bin/python -m py_compile backend/app/ai/tools/catalog/inventory.py backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_registry_and_metrics.py` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_registry_and_metrics.py backend/tests/ai_infra/test_foundation.py backend/tests/ai_infra/test_workspace_chat.py -q` -> `111 passed, 33 subtests passed`

执行范围记录：

- `backend/app/ai/skills/catalog/inventory-analysis/skill.yaml`
  - 当前轮未改；仅在未来真实 trace 证明需要收紧文案或预算时再微调。
- `backend/app/ai/tools/catalog/inventory.py`
  - 已将 `inventory.read_summary` 的终态语义下沉到 ToolDefinition 默认 `terminal_output` / `followup_hint`。
  - 已将库存列表类读取工具的默认 `requires_followup` / `followup_hint` 下沉到 ToolDefinition。
- 测试文件
  - `backend/tests/ai_infra/test_foundation.py`
  - `backend/tests/ai_infra/test_workspace_chat.py`
  - 如涉及 registry 诊断，再补 `backend/tests/ai_infra/test_registry_and_metrics.py`

建议验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py backend/tests/ai_infra/test_workspace_chat.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_registry_and_metrics.py -q
```

#### Phase 10.2：meal_plan 与推荐/计划双模式合同校准

状态：已完成（2026-06-30）。

目标：

- 明确 `meal_plan` 中“即时推荐终态”和“正式计划必须继续追问/生成草稿”的边界。
- 把可以跨 Skill 复用的默认终态/追问语义尽量下沉到 ToolDefinition，减少 `meal_plan` 对 Skill-level 重复配置的依赖。

当前审计判断：

- `backend/app/ai/skills/catalog/meal-planning/skill.yaml` 已完整声明 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract`。
- 风险点在于它依赖的真实工具较多，当前仍主要通过 Skill-level `completion_policy` 串起来：
  - `meal_plan.recommend_today` 已有 `output_types=today_recommendation`，但 ToolDefinition 默认 terminal contract 仍为空。
  - `meal_plan.read_existing`、`meal_plan.read_by_id`、`meal_log.read_recent`、`food.search`、`food.read_by_id`、`recipe.search`、`recipe.read_by_id` 的 follow-up 语义主要仍在 `skill.yaml`。
  - `script.expand_meal_slots`、`script.validate_meal_plan`、`script.render_plan_preview` 属于 Skill 私有脚本，继续保留在 Skill-level contract 更合理。

实际改动：

- 保持 `backend/app/ai/skills/catalog/meal-planning/skill.yaml` 的 route hints、draft contract、approval flow 和 tool budget 不变；脚本类 follow-up 继续留在 Skill-level contract。
- 在 `backend/app/ai/tools/catalog/meal_plan.py` 下沉默认 ToolDefinition contract：
  - `meal_plan.recommend_today`
    - `terminal_output=True`
    - `output_types=["today_recommendation"]`
    - `followup_hint="即时餐食推荐卡可作为今日推荐模式的终态输出。"`
  - `meal_plan.read_existing`
    - `requires_followup=True`
    - `followup_hint="读取已有餐食计划后必须总结冲突/空档、请求补充信息，或继续生成推荐/计划草稿。"`
  - `meal_plan.read_by_id`
    - `requires_followup=True`
    - `followup_hint="读取餐食计划详情后必须说明可调整项、请求补充信息，或继续生成计划草稿。"`
- 扩展 `backend/app/ai/tools/catalog/common.py` 的 `register_tool(...)` helper，支持传入 `requires_followup`、`terminal_output` 和 `followup_hint`，避免每个 catalog 工具手写 `ToolDefinition`。
- 更新 `backend/tests/ai_infra/test_tool_registry.py` 和 `backend/tests/ai_infra/test_registry_and_metrics.py`，覆盖 meal_plan 推荐卡终态合同和计划读取 follow-up 诊断。

验证结果：

- `backend/.venv/bin/python -m py_compile backend/app/ai/tools/catalog/common.py backend/app/ai/tools/catalog/meal_plan.py backend/app/ai/tools/catalog/recipe.py backend/app/ai/tools/catalog/food.py backend/app/ai/tools/catalog/ingredient.py backend/app/ai/tools/catalog/shopping.py backend/app/ai/tools/catalog/meal_log.py backend/app/ai/tools/catalog/workspace.py backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_registry_and_metrics.py` -> 通过
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_tool_registry.py backend/tests/ai_infra/test_registry_and_metrics.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_catalog_completion_policy_applies_to_real_tool_definitions backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_catalog_completion_policy_applies_to_business_read_tools backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_orchestrator_fails_when_followup_tool_has_no_terminal_output backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_recipe_cook_preview_requires_followup_from_skill_yaml_policy -q` -> `59 passed, 120 subtests passed`

后续非阻断建议：

- 如果后续真实 trace 证明 ToolDefinition 默认文案已经覆盖所有场景，可评估删减 `meal-planning/skill.yaml` 中重复的 read tool follow-up 文案；当前保留 Skill-level 细化文案以保证运行期语义不倒退。

#### Phase 10.3：recipe_cook 高风险 preview/continue 语义收敛

状态：已完成（2026-06-30）。

目标：

- 优先处理最容易出现“中间 preview/read 工具输出后误判 completed”的做菜确认链路。
- 把 `recipe.preview_cook` 的 follow-up contract 从仅靠 Skill-level 文案，逐步收敛成更稳的 ToolDefinition 默认合同。

当前审计判断：

- `backend/app/ai/skills/catalog/recipe-cook/skill.yaml` 已完整声明 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract`。
- 它是当前最值得优先实现的 Skill：
  - `recipe.preview_cook` 是典型 preview tool，直接决定后续是解释缺料、继续追问，还是生成 `recipe_cook` 草稿。
  - `recipe.read_by_id`、`inventory.read_available_items`、`meal_plan.read_existing` 也都影响“做不做得成”的终态判断。
  - 当前这些关键语义仍主要挂在 Skill-level `followup_required_tools`，未来若被其他入口复用，最容易重新出现 completed 误判。

实际改动：

- 保持 `backend/app/ai/skills/catalog/recipe-cook/skill.yaml` 的预算、route hints、draft contract、approval flow 和 recipe_cook commit 行为不变。
- 在 `backend/app/ai/tools/catalog/recipe.py` 下沉默认 ToolDefinition contract：
  - `recipe.preview_cook`
    - `requires_followup=True`
    - `followup_hint="做菜预览后必须说明库存扣减和缺料情况、请求补充信息，或生成 recipe_cook 草稿。"`
  - `recipe.read_by_id`
    - `requires_followup=True`
    - `followup_hint="读取菜谱详情后必须说明可用信息、请求补充信息，或继续预览/生成草稿。"`
  - `recipe.search`
    - `requires_followup=True`
    - `followup_hint="菜谱检索后必须说明候选、请求用户选择，或继续读取详情/生成草稿。"`
- `inventory.read_available_items` 已在 10.1 完成，不重复改。
- `meal_plan.read_existing` 已在 10.2 完成，recipe_cook 运行期仍可通过 Skill-level policy 覆盖为更具体的做菜语义。
- 更新测试覆盖 recipe read/preview 的 ToolDefinition 默认 follow-up contract，同时保留 `test_recipe_cook_preview_requires_followup_from_skill_yaml_policy`，证明 Skill-level 细化语义仍能覆盖默认值。

验证结果：

- 同 Phase 10.2 窄验证：`59 passed, 120 subtests passed`

后续非阻断建议：

- 只有在真实 trace 显示 `recipe_cook.max_tool_calls` 偏紧或偏松时，再单独调整 `recipe-cook/skill.yaml` 的预算；当前不做无依据预算变更。

#### Phase 10.4：draft-capable skills 一致性收尾

状态：已完成（2026-06-30）。

覆盖范围：

- `shopping_list`
- `recipe_draft`
- `meal_log`
- `food_profile`
- `ingredient_profile`

目标：

- 不做“把所有 skill.yaml 再重写一遍”的大改，而是检查这些草稿型 Skill 是否只剩共享 ToolDefinition contract 缺口。
- 明确哪些语义应该继续留在 Skill-level，哪些已经足够稳定可以下沉到 ToolDefinition 默认值。

当前审计判断：

- 这组 Skill 的 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract` 已全部到位。
- `recipe_draft` 的 `script.lint_recipe_draft` 属于 Skill 私有脚本，继续保留在 Skill-level `completion_policy` 更合适，不建议强行做成全局 ToolDefinition 模式。
- 当前主要可收敛的共性仍集中在共享 read tool：
  - `workspace.read_artifact`
  - `ingredient.search`
  - `ingredient.read_by_id`
  - `food.search`
  - `food.read_by_id`
  - `recipe.search`
  - `recipe.read_by_id`
  - `shopping.read_pending`
  - `shopping.read_by_id`
  - `meal_log.read_recent`
  - `meal_log.read_by_id`
- 这些共享 read tool 目前在 ToolDefinition 层多数仍无默认 `requires_followup` / `followup_hint`，而是在多个 Skill 的 `completion_policy` 中重复配置。

实际改动：

- 保持以下 Skill 的 `tool_budget`、`completion_policy`、`route_hints`、`draft_contract` 和 approval flow 不变：
  - `shopping_list`
  - `recipe_draft`
  - `meal_log`
  - `food_profile`
  - `ingredient_profile`
- Skill 私有脚本继续只留在 Skill-level contract：
  - `recipe_draft.script.lint_recipe_draft`
  - `meal_plan.script.expand_meal_slots`
  - `meal_plan.script.validate_meal_plan`
  - `meal_plan.script.render_plan_preview`
- 为共享 read tool 下沉默认 ToolDefinition `requires_followup` / `followup_hint`：
  - `workspace.read_artifact`
  - `ingredient.search`
  - `ingredient.read_by_id`
  - `food.search`
  - `food.read_by_id`
  - `recipe.search`
  - `recipe.read_by_id`
  - `shopping.read_pending`
  - `shopping.read_by_id`
  - `meal_log.read_recent`
  - `meal_log.read_by_id`
- 这些默认合同只表达“读完必须继续总结、追问、读取详情或生成/调整草稿”，具体业务文案仍由当前 active Skill 的 `completion_policy` 覆盖。
- 更新 registry 和工具测试，确保 `/api/ai/registry.tools[]` 能暴露这些共享默认合同。

验证结果：

- 同 Phase 10.2 窄验证：`59 passed, 120 subtests passed`

后续非阻断建议：

- 当前保留各 draft-capable Skill 的 Skill-level completion policy，不做字段全量重写；未来只有在新增 Skill 复用共享 read tool 且重复文案明显增加时，再评估删减重复配置。

#### Phase 10 执行原则

- 本阶段优先处理真实高风险 Skill，不做“字段全量搬运式”清理。
- 优先把跨 Skill 可复用的默认 completion contract 下沉到 ToolDefinition；Skill 私有脚本和强业务语义继续留在 `skill.yaml.completion_policy`。
- 当前轮已按 10.1 -> 10.2 -> 10.3 -> 10.4 顺序完成收口；没有改 Runner、Orchestrator runtime、审批 commit 或正式写入逻辑。

### Phase 11：兼容 wrapper / 死代码清理（已完成清理）

状态：已完成清理（2026-06-30）。

审计范围：

- Orchestrator 包入口和旧代理方法。
- Draft Operation Registry 兼容 facade / wrapper。
- Runner 中测试或旧调用方仍使用的薄 wrapper。

实际结论：

- `backend/app/ai/workflows/orchestrator/__init__.py` 继续兼容导出 `WorkspaceOrchestratorAgent`、`SkillInjectionManager`、`OrchestratorRunState` 等公共入口；`runner.py`、`backend/tests/ai_infra/_support.py` 和现有测试仍合理使用包入口，保留。
- 已删除 `resolve_orchestrator_profile()` 兼容函数；`WorkspaceGraphRunner` 和 profile 测试统一改为 `ORCHESTRATOR_PROFILE_REGISTRY.resolve(...)`。
- 已删除 `WorkspaceOrchestratorAgent` 内的 `_system_prompt()`、`_user_payload()`、`_provider_user_input()`、`_emit_visible_delta()`、`_tool_signature()`、`_historical_tool_signatures()`、结果组装、draft/card 校验和 latest output 相关私有薄代理；`run()` 直接调用 payload builder、result assembler、streaming 和 signature helper。
- 已删除 `backend/app/services/ai_operations/approval_config.py` 兼容 facade；正式审批请求、审批值校验、审批决策和 message 组装直接调用 `draft_operation_registry.approval_config_for_payload(...)`。
- 已删除 `DRAFT_APPROVAL_CONFIG`、`validate_inventory_operation_shape()`、`validate_operation_draft_shape()`、`validate_single_target_operation_shape()` 等旧导出和测试依赖；测试改为直接验证 `draft_operation_registry`。
- 已删除 Runner 中 `_normalize_chat_attachments()`、`_message_summary()`、`_attachment_summaries()`、`_build_user_message_parts()`、`_provider_images_for_attachments()`、`_human_input_answer_summary()`、`_approval_followup_fallback_text()`、`_dedupe_message_parts()`、`_sync_message_parts_with_current_approval_state()`、`_human_input_question_types()`、`_skill_result_clarification_question_types()`、`_record_skill_observation()`、`_record_approval_outcome()` 和 stream bridge 纯代理；Runner 内部直接调用 `runner_support` helper。
- 已将 `_approval_resume_payload()` 旧方法名收敛为 `_approval_resume_payload_from_decision()`；该方法仍负责 DB 读取 draft metadata，不属于纯转发 wrapper。
- 已删除 `app.services.ai_operations` package `__init__.py` 的宽 re-export facade；`workspace_service.py` 和 `run_lifecycle.py` 改为直接从具体 ai_operations 模块导入。
- 已缩窄 `services/ai_operations/registry.py`，只保留 `draft_operation_registry` 实例入口；`Draft*Context` / `DraftOperationSpec` / `DraftOperationRegistry` 等类型改从 `registry_types.py` 导入，`DRAFT_APPROVAL_BASE_CONFIGS` 不再从 registry 转导出。
- 已删除源码树中的 Python `__pycache__` / `.pyc` 生成产物。
- 已补同步 `invoke_user_message()` 的 graph runtime exception 落库保护；`graph.invoke(...)` 抛异常后复用统一失败持久化路径，写入 failed assistant message、failed run、error event，并清理 conversation `activeRunId`。
- 已补 agent round 上限保护：`MAX_AGENT_ROUNDS = 30`；达到上限仍为 `running` 时路由进入 finalize，并以 failed 状态收口，避免被误判 completed 或继续循环。

保留 backlog：

- 继续保留 `workflows/orchestrator/__init__.py` 的包入口导出，因为这是当前 `runner.py` 和测试使用的稳定导入面。
- 继续保留 `draft_operation_registry.approval_config_for_payload(...)`，它不是兼容 wrapper，而是当前 registry 的正式查询 API。

追加验证：

- `backend/.venv/bin/python -m py_compile backend/app/ai/workflows/runner.py backend/app/ai/workspace_service.py backend/app/ai/workflows/run_lifecycle.py backend/app/services/ai_operations/__init__.py backend/app/services/ai_operations/registry.py backend/app/services/ai_operations/registry_specs.py backend/app/services/ai_operations/draft_specs/__init__.py backend/app/services/ai_operations/draft_specs/inventory.py backend/app/services/ai_operations/executor.py backend/app/services/ai_operations/drafts.py backend/app/services/ai_operations/approval_decisions.py backend/app/services/ai_operations/approval_values.py backend/app/services/ai_operations/messages.py backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_registry_and_metrics.py` -> 通过。
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_multimodal_attachments.py backend/tests/ai_infra/test_registry_and_metrics.py -q` -> `14 passed, 33 subtests passed`。
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `307 passed, 172 subtests passed`。
- `backend/.venv/bin/python -m py_compile $(find backend/app/ai -type f -name '*.py')` -> 通过。
- `git diff --check` -> 通过。
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_sync_invoke_runtime_exception_marks_run_failed backend/tests/ai_infra/test_foundation.py::AIFoundationTestCase::test_agent_round_limit_finalizes_running_state_as_failed -q` -> `2 passed`。
- `backend/.venv/bin/python -m pytest backend/tests/ai_infra -q` -> `309 passed, 172 subtests passed`。

## 兼容与风险控制

- 保留现有稳定接口：
  - `WorkspaceOrchestratorAgent.run()`
  - `SkillInjectionManager`
  - `SkillResult`
  - `WorkspaceGraphState` 字段：`injected_skill_keys`、`injection_history`、`pending_human_input`、`pending_approval_id`
- 任何阶段不得修改现有 draft type、card type、message part type、SSE event shape。
- 新 registry 是当前正式路径；旧审批配置 facade 和旧 validator wrapper 已删除。
- 所有新增配置字段默认不改变当前行为。
- 不能通过 prompt 兜底替代后端 schema、tool、service 校验。
- 每个阶段都应能独立合入和回滚。
- 后续继续重构时，必须先声明执行本文档中的具体 Phase 和子步骤；如果发现当前代码与文档不一致，先更新文档再动代码。
- 不允许为了降低行数连续拆多个职责。每次最多处理一个 Phase 9 子步骤，并在最终回复中说明实际验证命令。

## 验证计划

基础验证：

```bash
backend/.venv/bin/python -m py_compile $(find backend/app/ai -type f -name '*.py')
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_foundation.py backend/tests/ai_infra/test_orchestrator_profiles.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
npm --prefix frontend run test -- AiWorkspace
git diff --check
```

高风险阶段追加：

```bash
npm run backend:test
```

涉及前端共享契约时追加：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
```

重点验收：

- 主 AI 助手普通问答、Skill 注入、draft approval、human input、result card 行为不变。
- 小灶 profile 仍能短句回应，并能调用 `ui.propose_actions`。
- 新增 Skill 不需要修改静态注入 key 列表。
- 新增 draft type 只通过 registry 增加一个 spec，不再散落多个 if/elif。
- 中间工具调用后没有合法终态输出时不会误判 completed。
- 所有查询和正式写入仍按 `family_id` 隔离，write tool 仍不暴露给模型。

## 后续维护边界

当前轮不再继续拆 Runner，也不继续做无目标的配置搬运。后续只在出现真实需求或缺陷时按以下边界推进：

1. 新增非写入型能力：优先新增 Skill catalog、read/card ToolDefinition contract 和最小 AI infra 测试。
2. 新增写入型能力：必须新增确定性 service / draft spec / approval 测试，仍走 `draft -> approval -> commit`。
3. 新增页面助手：先配置 profile capability surface，确认 prompt、tool schema 和 user payload 三处都只暴露该入口需要的能力。
4. 调整预算或 completion policy：必须基于真实 trace、失败测试或明确产品流程，不做全量字段重写。
5. 删除兼容 wrapper：只有调用方和测试都迁出后单独处理；不和业务能力改动混在一起。

## 预期结果

重构完成后，Culina AI 架构应满足：

- Orchestrator 是唯一主 agent loop。
- Profile 决定入口身份和初始上下文，不污染全局运行合同。
- Skill catalog 决定业务能力、工具权限、脚本和输出合同。
- Tool / draft / approval / commit 都有注册式 contract。
- 新能力接入路径清晰：配置 Skill，注册必要工具和确定性业务 handler，补对应测试。
- 当前主 AI 助手和小灶运行逻辑保持兼容，前端响应形状不变。
