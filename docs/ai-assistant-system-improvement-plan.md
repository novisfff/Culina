# AI 助手系统改进说明

更新时间：2026-06-05

本文用于指导 Culina AI 助手从“固定场景触发器”升级为“可对话完成任务的厨房工作台”。本轮改造不追求一次性替换所有业务智能体，也不直接重写现有 draft、approval、operation 写入闭环，而是先搭建三层核心基础：总控 Planner、Skill 能力层、Tool 工具层。后续库存、菜谱、餐食计划、购物清单、餐食记录、食物资料、生图等能力再逐步接入。

Phase A 当前状态：基础框架已落地到后端主链路。`AIApplicationService` 已从旧 `WorkspaceOrchestrator` 切换为 `WorkspacePlanner -> SkillExecutor -> ToolExecutor`，并保留现有 HITL draft/approval/operation 写入闭环。旧 workspace orchestration 代码已清除，仍保留的旧 agent 生成函数仅作为未完全迁移 skill 的兼容实现。

Phase B 当前状态：已优先打磨 `meal_plan -> shopping_list` 标杆链路。餐食计划 skill 由模型自行判断创建、修改或澄清，并生成包含使用库存、缺失食材和来源说明的结构化计划。购物清单 skill 由模型选择来源计划并生成采购需求，代码负责重复项合并、数量计算和库存/家庭边界校验。Provider 不可用时明确失败，不再生成规则化业务结果。

Planner 模型化简状态：Planner 已收敛为“基于完整对话选择有序 Skill 列表”，不再判断 create/modify/derive、抽取 slots 或指定目标草稿。对话中的真实 `AITaskDraft` 会挂在产生它的 assistant 消息下。Planner 必须依赖模型结构化输出，失败后只重试一次，仍失败则返回 `planner_failed`，不再进入关键词 fallback。`meal_plan` 与 `shopping_list` 已自行判断内部 operation、选择源 artifact 并生成结构化草稿。

OpenAI-compatible 兼容说明：结构化请求按 `json_schema -> json_object -> text` 顺序尝试。Planner 接受裸 JSON 或单一完整 `json` Markdown 代码块，但拒绝代码块外解释文字；业务 Schema、Skill 白名单和重复项约束仍必须全部通过。

Skill 目录化状态：工作台 Skill 已迁入 `backend/app/ai/skills/catalog/<skill_key>/`。每个目录以 `manifest.json` 作为运行时能力声明，以 `SKILL.md` 作为标准化说明入口。执行入口采用目录约定：存在 `skill.py` 时使用自定义 Python Skill；不存在 `skill.py` 时由 `MarkdownInstructionSkill` 读取 `SKILL.md`、manifest、对话上下文和只读工具结果后调用模型执行。Catalog 不再使用 `order.json` 或 `workflow.json`；Registry 扫描目录并按目录名字母序稳定加载，实际执行顺序只由 Planner 输出决定。`general_chat` 不再作为 Skill 注册，Planner 返回空 `skills` 时走系统通用对话路径。复杂业务 Skill 继续保留 `skill.py`，模型化 Skill 的 prompt 和 JSON Schema 也保存在自身目录。不再依赖集中式 `skills/workspace.py` 或 `agents/workspace.py`。

Tool 平台化状态：工具实现已按 inventory、meal plan、meal log、food、recipe、shopping 等领域拆入 `backend/app/ai/tools/catalog/`，Registry 只负责汇总注册。ToolExecutor 会校验真实 input/output schema、记录执行摘要，并由 SkillExecutor 按 manifest 工具白名单和 approval policy 创建 scoped executor。无审批 Skill 只能调用 read 工具，草稿确认型 Skill 可以调用 read/draft 工具，write 工具不向工作台 Skill 开放。

## 1. 背景与当前问题

当前 AI 工作台已经具备比较完整的产品外壳和生命周期基础：

- 前端有聊天页面、历史会话、流式展示、运行进度、结果卡片、确认面板、重试和局部重生成。
- 后端有 `/api/ai/chat`、conversation、message、run、run event、draft、approval、operation 等基础结构。
- 草稿确认后写入业务表的 HITL 流程已经可用，能保护用户对数据写入的控制权。

但当前核心智能层仍偏固定：

- 总控主要靠 `quick_task` 和关键词匹配决定 intent。
- 槽位抽取只覆盖少量固定词，例如几天、餐别、清淡、临期、不要。
- 多数业务 agent 直接写 SQL 和规则逻辑，不是真正通过统一工具层执行。
- Tool Registry 当前更像工具名称清单，没有统一 handler、输入输出 schema、权限、审计和执行边界。
- 复杂需求无法自然拆解。例如“用临期食材安排三天晚餐，别太辣，顺便生成采购清单”应该是多步骤任务，但当前通常只能命中单个场景。
- 多轮上下文弱。用户说“第二天换一个”“那顺便生成购物清单”时，系统只能依赖最近草稿卡片做很有限的续接。

因此，下一阶段的重点不是继续堆更多关键词，而是先把 AI 执行平台的三层基础搭起来。

## 2. 改造目标

### 2.1 产品目标

- 用户可以用自然语言表达目标，而不是必须说中固定关键词。
- AI 能理解当前对话状态，支持新建任务、修改草稿、基于草稿继续派生任务。
- AI 能把复合需求拆成多个可解释步骤，并把结果以结构化草稿和确认卡呈现。
- AI 默认只生成草稿，不直接写库；写库继续走用户确认。
- 用户能看到 AI 为什么给出建议，包括使用了哪些上下文和工具。

### 2.2 技术目标

- 用模型化 Planner 替代硬编码关键词路由，但保留后端白名单和安全校验。
- 用 Skill Manifest 声明业务能力，避免总控和业务 agent 互相耦合。
- 用真实 Tool Registry 统一封装业务读取、草稿生成、校验和审计。
- 让现有 `AIApplicationService`、`AIMessage.parts`、draft、approval、operation 继续作为稳定协议层。
- 第一阶段只搭建基础骨架，逐步迁移现有 agent，不一次性大爆炸重构。

## 3. 总体架构

目标结构如下：

```text
AIWorkspace
  -> /api/ai/chat 或 /api/ai/chat/stream
  -> AIApplicationService
  -> WorkspacePlanner
      -> 读取 ConversationTaskState
      -> 模型化理解用户目标
      -> 规范化 slots / missing fields / requested actions
      -> 选择 skills 并生成 plan steps
  -> SkillExecutor
      -> 按 plan steps 调用 skill
      -> skill 通过 ToolExecutor 读取上下文和生成草稿
  -> ResponseBuilder
      -> text / cards / drafts / approvals / events
  -> HITL Approval
      -> 用户编辑确认
      -> AIOperation 写入业务表
```

这套结构里，各层职责必须清晰：

- Planner 负责理解目标、维护任务状态、选择能力、拆步骤、判断是否追问。
- Skill 负责一个业务能力的任务实现，例如餐食计划、购物清单、菜谱草稿。
- Tool 负责受控业务能力调用，例如读取库存、搜索菜谱、创建草稿、校验引用。
- Operation 负责确认后的真实写库，模型和普通 skill 不能绕过 approval 直接写业务表。

## 4. 总控 Planner 改造

### 4.1 当前总控的问题

当前总控核心是 `_detect_intent()`。它的问题不是没有功能，而是扩展方式错误：

- 每加一种说法都要补关键词。
- 用户复合需求会被压成单 intent。
- 追问逻辑只能针对少量场景写死。
- 多轮修改依赖“当前是否有 currentDraft + 是否包含修改词”，语义很窄。
- 模型只在 fallback 或少数生成场景参与，没有承担“理解用户目标”的职责。

### 4.2 新总控职责

新总控建议命名为 `WorkspacePlanner`。它不是超级 agent，不直接写业务逻辑，而是负责规划。

核心职责：

- 读取包含历史消息和嵌套 artifacts 的完整对话。
- 根据 Skill Registry 选择一个或多个 skill。
- 输出有序 skill 列表；列表顺序就是执行顺序。
- 不判断 skill 内部 operation，不抽取 slots，不选择具体草稿。

### 4.3 Planner 输入

建议定义：

```python
class PlannerRequest(BaseModel):
    family_id: str
    user_id: str
    conversation_id: str | None
    conversation: list[dict] = []
    available_skills: list[dict] = []
```

其中 `available_skills` 不应暴露内部实现细节，只给模型看适合理解任务的 manifest 摘要，例如：

```json
{
  "key": "meal_plan",
  "name": "餐食计划",
  "description": "生成或修改多天餐食计划草稿",
  "examples": ["帮我安排三天晚餐", "第二天不要鸡肉"],
  "outputs": ["meal_plan_draft"],
  "canContinueFrom": ["meal_plan_draft"]
}
```

### 4.4 Planner 输出

建议定义受控 JSON：

```python
class PlannerResult(BaseModel):
    skills: list[str]
    raw_response: str | None = None
    attempts: int = 0
    error: str | None = None
```

示例：

```json
{
  "skills": ["meal_plan", "shopping_list"]
}
```

### 4.5 Planner 的安全边界

Planner 可以由模型生成结构化理解，但结果必须经过后端规范化：

- `skills` 必须为 1 到 4 个已注册 skill，且不能重复。
- Planner 必须使用 JSON Schema 输出；非法结果携带校验错误重试一次。
- 第二次仍失败时返回 `planner_failed`，不得使用关键词路由替代模型。
- 模型不能直接决定写库，不能返回业务表写入操作。
- Skill 引用 artifact 时必须由后端校验类型和家庭边界。

### 4.6 ConversationTaskState

为了支持多轮对话，需要维护轻量任务状态。第一版可以放在 conversation context 或独立字段中，后续再决定是否建表。

建议结构：

```json
{
  "activeTask": "meal_plan",
  "activeDraftType": "meal_plan",
  "activeDraftId": "ai_draft_xxx",
  "activeApprovalId": "ai_approval_xxx",
  "slots": {
    "days": 3,
    "mealTypes": ["dinner"],
    "constraints": ["light", "use_expiring_ingredients"],
    "avoidItems": ["鸡肉"]
  },
  "lastSkillResults": [
    {
      "skillKey": "meal_plan",
      "draftType": "meal_plan",
      "draftId": "ai_draft_xxx"
    }
  ],
  "pendingClarification": null
}
```

典型多轮：

```text
用户：安排三天晚餐
Planner: new_task -> meal_plan.create_draft

用户：第二天不要鸡肉，整体清淡一点
Planner: modify_current_draft -> meal_plan.modify_draft

用户：那顺便生成购物清单
Planner: derive_from_current_draft -> shopping_list.create_from_meal_plan
```

### 4.7 追问策略

不要所有缺字段都追问。建议按风险分级：

- 低风险草稿：可以使用默认值，但要在回复中说明。
- 高风险或用户要求精确：缺字段就追问。
- 用户说“默认”“你看着安排”“先来一版”：直接生成草稿。
- 用户说“严格按照”“具体到某天”“不要猜”：缺字段必须追问。

示例：

```text
用户：帮我做菜单
回复：我可以先按未来 3 天晚餐安排。你要我直接生成，还是改成一周或包含早餐午餐？

用户：先按默认帮我安排菜单
执行：meal_plan.create_draft(days=3, mealTypes=["dinner"])
```

## 5. Skill 能力层改造

### 5.1 为什么需要 Skill

Skill 是“AI 能做什么”的业务能力声明和执行单元。它解决的问题是：

- 总控不需要知道每个业务怎么查库、怎么生成、怎么校验。
- 新能力不需要继续改一堆关键词路由。
- 复合任务可以由多个 skill 串联。
- 每个 skill 可以独立定义输入、上下文、输出、审批策略和续接规则。

这里的 Skill 是内部能力层，不是外部插件市场，也不是动态安装机制。

### 5.2 Skill Manifest

建议定义：

```python
class SkillManifest(BaseModel):
    key: str
    name: str
    description: str
    examples: list[str]
    actions: list[str]
    required_slots: dict[str, list[str]]
    optional_slots: list[str]
    context_policy: list[str]
    tools: list[str]
    output_types: list[str]
    draft_types: list[str]
    approval_policy: str
    can_continue_from: list[str]
```

示例：

```json
{
  "key": "meal_plan",
  "name": "餐食计划",
  "description": "生成或修改多天餐食计划草稿",
  "examples": ["帮我安排三天晚餐", "第二天不要鸡肉", "用临期食材安排一周菜单"],
  "actions": ["create_draft", "modify_draft"],
  "requiredSlots": {
    "create_draft": ["days", "mealTypes"],
    "modify_draft": ["sourceDraftId"]
  },
  "optionalSlots": ["constraints", "avoidItems", "preferredFoods"],
  "contextPolicy": ["inventory", "meal_logs", "foods", "recipes", "meal_plan"],
  "tools": [
    "inventory.read_expiring_items",
    "meal_log.read_recent",
    "food.search",
    "recipe.search",
    "meal_plan.create_draft"
  ],
  "outputTypes": ["meal_plan_draft"],
  "draftTypes": ["meal_plan"],
  "approvalPolicy": "draft_then_confirm",
  "canContinueFrom": ["meal_plan"]
}
```

### 5.3 Skill 接口

建议第一版接口：

```python
class BaseSkill:
    manifest: SkillManifest

    def run(self, context: SkillContext) -> SkillResult:
        ...
```

`SkillContext`：

```python
class SkillContext(BaseModel):
    family_id: str
    user_id: str
    conversation_id: str
    run_id: str
    conversation: list[dict]
    current_message: str
    previous_results: list[SkillResult]
    tool_executor: ToolExecutor
    provider: BaseChatProvider | None
```

`SkillResult`：

```python
class SkillResult(BaseModel):
    text: str
    cards: list[dict] = []
    drafts: list[dict] = []
    events: list[dict] = []
    tool_calls: list[dict] = []
    state_patch: dict = {}
    status: str = "completed"
    error: str | None = None
```

### 5.4 第一批 Skill

第一阶段不需要全部智能化，但要先把现有能力迁入统一框架。

建议第一批：

- `inventory_analysis`
  - 回答库存、临期、低库存问题。
  - 输出库存摘要卡。
- `recipe_draft`
  - 复用现有结构化菜谱生成。
  - 输出菜谱 draft 和 approval。
- `meal_plan`
  - 先迁移现有规则生成。
  - 后续升级为模型结构化生成。
- `shopping_list`
  - 先支持从当前 meal_plan draft 派生购物草稿。
  - 后续支持低库存、菜谱缺口合并。
- `meal_log`
  - 先迁移现有餐食记录草稿。
- `food_profile`
  - 先迁移现有食物资料草稿。

### 5.5 Skill 与 Approval 的关系

Skill 只生成 draft，不直接写业务表。

规则：

- `approvalPolicy = none`：只读问答或建议，不生成 approval。
- `approvalPolicy = draft_then_confirm`：生成 `AITaskDraft` 和 `AIApprovalRequest`。
- `approvalPolicy = explicit_confirm_before_draft`：极少数高风险场景可先追问，再生成草稿。

真实写入仍由现有 approval decision 触发：

```text
SkillResult.drafts
  -> AIApplicationService 创建 AITaskDraft / AIApprovalRequest
  -> 用户编辑确认
  -> AIOperation
  -> Business Service 写库
```

## 6. Tool 工具层改造

### 6.1 当前 Tool 的问题

当前 Tool Registry 已经从“名称清单”升级为带 handler 的受控工具层，并已按领域拆到 `backend/app/ai/tools/catalog/`。`ToolExecutor` 会统一执行、校验 schema、记录调用摘要，并且 SkillExecutor 会按当前 Skill 的 manifest 创建 scoped executor。

仍需要持续注意的问题：

- 新增工具必须提供真实 input/output schema，不能退回泛型 object。
- 复杂 Skill 必须通过 `context.tool_executor.call()` 调用工具，不能手工伪造 `tool_calls`。
- 写入类工具仍不对普通 Skill 开放，真实写库继续由 approval decision 后的 operation 层完成。

### 6.2 Tool 的定位

Tool 是后端受控业务 API 层，不是给模型随便调用的函数集合。

职责：

- 封装业务读操作。
- 封装草稿生成和校验操作。
- 统一权限、家庭隔离、schema 校验。
- 统一记录 tool call。
- 为 SkillExecutor 提供稳定能力。

### 6.3 ToolDefinition

建议定义：

```python
class ToolDefinition(BaseModel):
    name: str
    description: str
    input_schema: dict
    output_schema: dict
    permission: str
    side_effect: Literal["read", "draft", "write"]
    requires_confirmation: bool
    handler: Callable[[ToolContext, dict], dict]
```

`ToolContext`：

```python
class ToolContext(BaseModel):
    db: Session
    family_id: str
    user_id: str
    conversation_id: str
    run_id: str
```

调用方式：

```python
result = context.tool_executor.call("inventory.read_expiring_items", {"days": 7})
```

SkillExecutor 会在执行每个 Skill 前创建 scoped executor：

- `allowed_tools = skill.manifest.tools`
- `approval_policy == "none"`：只允许 `read`
- `approval_policy == "draft_then_confirm"`：允许 `read` 和 `draft`
- `write` 默认不允许被工作台 Skill 调用

### 6.4 Tool 分类

第一类：只读工具。

```text
inventory.read_summary
inventory.read_expiring_items
inventory.read_available_items
meal_log.read_recent
recipe.search
food.search
shopping.read_pending
meal_plan.read_existing
```

第二类：草稿工具。

```text
recipe.create_draft
meal_plan.create_draft
shopping.create_draft
shopping_list.create_draft
meal_log.create_draft
food_profile.create_draft
```

第三类：写入工具。

```text
暂不注册到工作台 ToolRegistry
```

写入工具不能被 Planner 或普通 Skill 直接调用，只能由 approval decision 后的 operation 层调用。

### 6.5 Tool Call 记录

每次工具调用都应该形成标准记录：

```json
{
  "name": "inventory.read_expiring_items",
  "input": {"days": 7},
  "status": "completed",
  "outputSummary": {"count": 4},
  "durationMs": 32,
  "error": null
}
```

完整 output 不一定全部写入 `AIAgentRun.tool_calls`，避免 run 记录过大。建议记录摘要，详细上下文由 message/cards/drafts 承载。

### 6.6 Tool 安全规则

- 所有 tool 必须校验 `family_id`。
- 所有资源 ID 必须验证归属当前家庭。
- Python Skill 只能调用自己 manifest 声明过的工具。
- `approvalPolicy = none` 的 Skill 只能调用 read tool。
- `approvalPolicy = draft_then_confirm` 的 Skill 可以调用 read/draft tool。
- read tool 不允许产生业务副作用。
- draft tool 可以创建 AI draft，但不能写业务表。
- write tool 必须有已批准 approval 和幂等 key。
- 模型不能直接决定调用 write tool。
- tool 入参必须按 schema 校验，失败返回结构化错误。
- tool 错误必须进入 run event 和 error recovery。

## 7. 新执行流程

### 7.1 单 Skill 任务

```text
用户：快过期食材怎么处理？
Planner:
  action = new_task
  skillSteps = [inventory_analysis.answer]

SkillExecutor:
  inventory_analysis
    -> inventory.read_expiring_items
    -> recipe.search
    -> 输出库存建议卡

ResponseBuilder:
  text + inventory_summary / recommendation card
```

### 7.2 多 Skill 复合任务

```text
用户：用快过期食材安排三天晚餐，顺便生成购物清单
Planner:
  step1 = meal_plan.create_draft
  step2 = shopping_list.create_from_meal_plan depends_on step1

SkillExecutor:
  meal_plan
    -> inventory.read_expiring_items
    -> meal_log.read_recent
    -> food.search / recipe.search
    -> meal_plan.create_draft
  shopping_list
    -> shopping.read_pending
    -> inventory.read_available_items
    -> shopping_list.create_from_meal_plan

ResponseBuilder:
  text
  meal_plan_draft card
  shopping_list_draft card
  approvals
```

### 7.3 多轮修改任务

```text
用户：第二天不要鸡肉，整体清淡一点
Planner:
  action = modify_current_draft
  skill = meal_plan
  sourceDraftId = activeDraftId
  slots.patch = {avoidItems: ["鸡肉"], constraints: ["light"]}

SkillExecutor:
  meal_plan.modify_draft
    -> draft.read_current
    -> meal_plan.modify_draft
    -> 生成新 draft version 或新 draft

ResponseBuilder:
  展示修改后的计划草稿和新的确认卡
```

第一版可以先生成新 draft，后续再优化为 draft version 增量更新。

## 8. 与现有代码的集成策略

### 8.1 保留的稳定部分

以下部分应尽量保留：

- `/api/ai/chat` 和 `/api/ai/chat/stream` 对外接口。
- `AIApplicationService` 作为应用层入口。
- `AIMessage.parts` 作为唯一主渲染顺序。
- `included` 作为辅助实体集合。
- `AITaskDraft`、`AIApprovalRequest`、`AIUserApproval`、`AIOperation` 的 HITL 写入闭环。
- 前端现有 message/card/approval 渲染结构。

### 8.2 替换和新增的部分

建议新增：

```text
backend/app/ai/planning/
  schemas.py
  planner.py
  prompts.py
  normalizer.py

backend/app/ai/skills/
  base.py
  registry.py
  inventory.py
  recipe.py
  meal_plan.py
  shopping.py
  meal_log.py
  food_profile.py

backend/app/ai/tools/
  base.py
  registry.py
  executor.py
  inventory.py
  recipes.py
  foods.py
  meal_logs.py
  meal_plan.py
  shopping.py
```

建议逐步替换：

- `WorkspaceOrchestrator._detect_intent()` -> `WorkspacePlanner.plan()`。
- `build_tool_registry()` 的纯元信息 -> 带 handler 的 registry。
- `backend/app/ai/agents/workspace.py` 中直接 SQL 和规则生成 -> Skill + Tool。

### 8.3 兼容策略

Planner 不再保留规则 fallback：

```text
Planner 模型成功
  -> 执行有序 Skill 列表

Planner 模型失败或输出非法
  -> 携带错误重试一次
  -> 仍失败则返回 planner_failed

Skill 未迁移
  -> 调用现有 agent handler adapter
```

可以先写 adapter：

```python
class LegacyAgentSkillAdapter(BaseSkill):
    def run(...):
        return existing_agent_handler(...)
```

这样不用一次性重写全部 agent。

## 9. 第一阶段落地范围

第一阶段目标是搭基础，不追求业务智能全面升级。

### 9.1 必做

- 新增 Planner schema。
- 新增 WorkspacePlanner。
- 新增 SkillManifest、BaseSkill、SkillRegistry。
- 新增 ToolDefinition、ToolContext、ToolExecutor。
- 让现有 `inventory.read_*`、`meal_log.read_recent`、`food.search`、`recipe.search` 成为真实 read tool。
- 让 `meal_plan` 和 `shopping_list` 至少通过 SkillExecutor 串起来。
- 保留现有 draft/approval/operation。
- 保留现有关键词路由作为 fallback。

### 9.2 暂不做

- 不做外部插件系统。
- 不做用户自定义 skill。
- 不让模型直接 function calling 所有工具。
- 不让 skill 直接写业务表。
- 不一次性重写所有业务 agent。
- 不改变前端主渲染协议。

### 9.3 推荐优先场景

优先打通一个复合任务：

```text
用临期食材安排三天晚餐，并生成购物清单
```

原因：

- 覆盖 Planner 的复合任务理解。
- 覆盖 Skill 串联。
- 覆盖只读 tool 和草稿 tool。
- 覆盖多个 draft/approval。
- 用户感知提升明显。

第二个场景：

```text
安排三天晚餐 -> 第二天不要鸡肉 -> 那生成购物清单
```

原因：

- 覆盖 ConversationTaskState。
- 覆盖多轮修改。
- 覆盖从当前草稿派生新任务。

## 10. 验收标准

### 10.1 架构验收

- Planner 输出结构化 `PlannerResult`，不再只返回 intent 字符串。
- Skill Registry 能列出可用 skill manifest。
- Tool Registry 中至少一批 read tool 有真实 handler。
- Skill 执行不直接散落 SQL，至少核心路径通过 ToolExecutor。
- run 记录里能看到真实 tool call 摘要。

### 10.2 产品验收

以下输入能自然工作：

```text
用快过期食材安排三天晚餐，顺便生成购物清单
```

预期：

- AI 识别为复合任务。
- 输出餐食计划草稿。
- 输出购物清单草稿。
- 两类草稿都需要用户确认后才写库。

```text
第二天不要鸡肉，整体清淡一点
```

预期：

- AI 识别为修改当前 meal_plan draft。
- 不重新开始无关任务。
- 输出修改后的草稿。

```text
那顺便生成购物清单
```

预期：

- AI 识别为基于当前 meal_plan draft 派生 shopping_list。
- 购物项能说明来源。

### 10.3 安全验收

- 模型输出未知 skill 时必须拒绝或 fallback。
- 模型输出非法 slot 时必须规范化或追问。
- 引用资源 ID 必须校验家庭归属。
- 未经 approval 不允许写业务表。
- approval 重复提交仍然被拒绝。
- tool 执行失败能产生 error recovery。

## 11. 测试建议

后端测试：

- Planner schema validation。
- Planner 模型输出非法 JSON 时 fallback。
- Planner 识别复合任务。
- Planner 识别修改当前草稿。
- Skill Registry manifest 完整性。
- ToolExecutor schema 校验和 family scope 校验。
- `meal_plan -> shopping_list` 串联任务。
- approval 后写入仍保持幂等和版本校验。

前端测试：

- 多 draft/card 渲染顺序仍按 `AIMessage.parts`。
- 同一回复内展示多个确认卡。
- pending approval 恢复仍可用。
- 运行进度展示多个 tool step。

端到端验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py
npm --prefix frontend run build
```

根据实际改造范围补充更细的单测和 smoke。

## 12. 风险与注意事项

- 不要让 Planner 变成业务巨石。Planner 只规划，不写具体业务。
- 不要让 Skill 绕过 Tool 直接大量查表，否则工具层会再次空心化。
- 不要让模型直接调用 write tool。写库必须走 approval。
- 不要把所有业务一次性改完。先用 adapter 兼容现有 agent。
- 不要为了支持复合任务牺牲响应协议稳定性。前端仍以 `AIMessage.parts` 为准。
- 不要只做 prompt，不做 schema、校验、fallback 和审计。

## 13. 推荐实施路线

### Phase A：基础框架

- 新建 planning、skills、tools 包。
- 定义 PlannerResult、SkillManifest、ToolDefinition。
- 接入 ToolExecutor 的只读工具。
- Planner 只输出模型选择的有序 Skill 列表，失败重试一次后明确报错。

### Phase B：首个复合任务

- 实现 `MealPlanSkill` adapter。
- 实现 `ShoppingListSkill` adapter。
- 支持 Planner 返回 `meal_plan -> shopping_list` 有序 Skill 列表。
- run event 展示每个 skill/tool step。

### Phase C：多轮任务状态

- 引入 ConversationTaskState。
- 支持修改当前 meal_plan draft。
- 支持从当前 draft 派生 shopping list。
- 更新 pending draft/approval 恢复逻辑。

### Phase D：业务智能升级

- 将 meal_plan、shopping_list 从规则生成升级为模型结构化生成。
- 将 meal_log、food_profile 迁入 skill。
- 接入 image prompt draft。
- 扩展更多跨模块任务。

## 14. 结论

本轮改造的核心不是“再加几个智能体”，而是先把 AI 工作台的执行平台搭起来：

- 总控 Planner 只负责基于完整对话选择有序 Skill 列表。
- Skill 负责理解内部操作、选择 artifact 并执行业务能力。
- Tool 负责受控、可审计、可校验的业务调用。
- Approval 继续负责用户确认后的真实写入。

这三层建立后，Culina AI 助手才能从固定场景触发器，逐步变成能理解目标、组合能力、多轮完成任务的家庭厨房 AI 工作台。
