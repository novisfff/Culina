# Culina AI 助手与多智能体能力设计方案

更新时间：2026-05-30

本文用于设计 Culina 的 AI 页面与系统整体 AI 能力。核心判断是：AI 页面不应只是一个聊天窗口，而应该是面向家庭厨房管理的任务型 AI 工作台。用户用自然语言表达目标，AI 助手负责理解意图、收集上下文、调用 LangGraph 智能体、生成可确认的任务结果，并在用户确认后帮助完成系统内操作。

## 1. 设计目标

### 1.1 产品目标

- 降低用户完成复杂厨房任务的成本，例如从“我今晚想吃点清淡的”直接得到可执行菜谱、购物清单和餐食计划。
- 把库存、菜谱、食物、餐食记录、购物清单、生图等分散能力用 AI 串起来，形成跨模块任务入口。
- 让 AI 输出尽量结构化、可编辑、可确认，而不是只给一段泛泛建议。
- 保持用户对数据写入的控制权，AI 默认生成草稿，用户确认后再写入系统。

### 1.2 技术目标

- 在保留页面级 AI 能力的基础上，新增系统级 AI 工作台。页面级 AI 功能继续服务单一场景和轻量任务，工作台级 AI 负责跨页面、跨模块、多轮任务编排。
- 以 LangGraph 作为智能体编排核心，重新设计“总控助手 + 多业务智能体 + 可确认执行层”的平台化架构。
- 建立统一的 conversation、message、agent、tool、draft、approval、run event 抽象，让 AI 能支持跨页面、跨模块、多轮任务。
- 页面级 AI 与工作台级 AI 并行：已有页面内 AI 功能继续正常使用，新 AI 工作台不以页面级 mode、接口或单一 graph 为核心。
- 所有 AI 操作必须满足家庭数据隔离、权限校验、审计、幂等和失败可恢复。

## 2. AI 页面产品设计

### 2.1 页面定位

页面名称建议为“AI 厨房助手”或“智能助手”。它不是营销页，也不是独立于业务之外的问答页，而是用户完成厨房任务的统一入口。

AI 页面承担三类职责：

- 问答入口：回答库存、菜谱、食物、餐食记录相关问题。
- 任务入口：根据用户目标生成菜谱、菜单、购物清单、餐食记录等结构化草稿。
- 编排入口：跨模块组合任务，例如“用快过期食材安排未来三天晚餐，并生成购物清单”。

### 2.2 页面布局

建议使用三栏工作台布局，移动端降级为主聊天区优先。

- 左侧历史会话栏
  - 展示最近 AI 会话，按时间倒序。
  - 每条会话展示标题、最近一条摘要、任务类型、状态。
  - 支持新建会话、继续会话、收藏重要会话。
  - 初期可只展示已有 `/api/ai/conversations` 数据，后续扩展为完整消息历史。

- 中间主对话区
  - 展示用户消息、AI 回复、运行进度、结果卡片。
  - AI 回复不只渲染纯文本，也要支持菜谱卡片、购物项草稿、餐食计划表、库存提醒卡片。
  - 复杂任务显示执行步骤，例如“读取库存 -> 筛选临期食材 -> 匹配菜谱 -> 生成建议”。
  - 底部固定输入框，支持自然语言、快捷指令和当前对象引用。

- 右侧上下文面板
  - 展示本次 AI 正在使用的关键上下文。
  - 可包括库存摘要、临期食材、最近餐食、选中的菜谱、选中的食物、计划日期范围。
  - 用户从其他页面唤起 AI 时，右侧显示被引用对象，帮助用户确认 AI 理解的是哪个对象。

- 顶部状态区
  - 展示当前家庭、AI 可用状态、当前任务状态。
  - 可展示 provider 是否启用、当前是否有长任务运行。
  - 提供“新会话”按钮。

### 2.3 输入体验

输入框需要支持三类输入：

- 自然语言：用户直接输入“今晚用快过期食材做点什么？”。
- 快捷任务：用户点击“今日吃什么”“生成三天菜单”等入口自动填充提示词或直接发起任务。
- 对象引用：从食物、菜谱、库存项、餐食记录页面进入 AI 时，自动携带 `subject`，例如 `foodId`、`recipeId`、`ingredientIds`。

对于信息不足的任务，AI 应先追问，而不是生成低质量结果。例如用户说“帮我做菜单”，但没有说明天数和餐别时，可以给出默认建议并允许用户一键确认：“我先按未来 3 天晚餐来安排，可以吗？”

### 2.4 AI 回复形态

AI 回复应按任务类型选择结构，而不是统一长文本。

- 普通文本：适合解释、问答、建议。
- 结果卡片：适合菜谱、食物、库存项、购物项。
- 计划表：适合多天菜单和采购计划。
- 草稿确认条：展示将要创建或修改的数据，提供编辑、确认、拒绝。
- 进度时间线：展示用户可理解的任务进度，例如“正在查看库存”“正在生成推荐方案”，不要直接暴露 LangGraph 节点名。
- 错误恢复卡片：说明失败原因，提供重试、修改输入、转人工编辑入口。

### 2.5 快捷任务

AI 页面默认提供任务快捷入口，降低用户不知道如何提问的门槛。

- 今日吃什么
  - 输入：当前库存、临期食材、最近餐食、已有菜谱。
  - 输出：2 到 3 个推荐菜品，可进入菜谱详情或生成购物清单。

- 快过期处理
  - 输入：库存过期日期、状态、存放位置。
  - 输出：临期食材清单和可执行做法。

- 一键生成菜谱
  - 输入：菜名、食材、口味、份量、难度、场景。
  - 输出：结构化菜谱草稿和可选图片生成 payload。

- 三天菜单
  - 输入：日期范围、餐别、库存、最近餐食、已有食物。
  - 输出：按日期和餐别组织的餐食计划草稿。

- 补货建议
  - 输入：库存低量、常用食材、餐食计划、菜谱缺口。
  - 输出：购物清单草稿，包含数量、单位和原因。

- 记录餐食
  - 输入：用户一句话描述，例如“今晚吃了番茄炒蛋和米饭，两人份”。
  - 输出：结构化餐食记录草稿。

- 整理食物资料
  - 输入：食物名称、图片、用户描述、已有菜谱关联。
  - 输出：食物类型、分类、标签、来源、备注草稿。

- 生成菜品图片
  - 输入：菜谱或食物描述。
  - 输出：复用 `backend/app/ai/images` 生成图片任务。

## 3. 核心 AI 能力

### 3.1 总控助手 Agent

总控助手是 AI 页面背后的入口 agent，负责理解用户意图，为后端规则路由提供结构化输入。

职责：

- 识别用户意图，例如库存问答、菜谱生成、餐食计划、购物清单、食物资料整理、生图。
- 抽取任务槽位，例如天数、餐别、人数、食材约束、引用对象。
- 判断是否需要追问用户。
- 给出意图置信度和缺失字段。

总控助手不直接决定权限、写入行为、上下文范围或最终 agent。模型只做意图理解和槽位抽取，后端根据 `INTENT_CONFIG` 决定 context、agent、output type 和 confirmation requirement。

输出建议为结构化 JSON：

```json
{
  "intent": "meal_plan",
  "confidence": 0.86,
  "slots": {
    "days": 3,
    "mealTypes": ["dinner"],
    "constraints": ["use_expiring_ingredients"]
  },
  "missingFields": []
}
```

### 3.2 库存智能体

职责：

- 回答库存相关问题。
- 找出临期、低库存、已开封、冷冻等重点食材。
- 提供食材替代建议。
- 根据库存生成补货或消耗建议。

可读数据：

- `InventoryItem`
- `Ingredient`
- 单位换算规则
- 保质期和存放位置
- 最近餐食消耗记录

产出：

- 库存摘要
- 临期食材清单
- 可用食材组合
- 补货草稿
- 可做菜品建议

### 3.3 菜谱智能体

职责：

- 根据菜名、食材、口味、份量、难度生成菜谱草稿。
- 根据已有菜谱改写份量、难度或步骤。
- 补全缺失的步骤标题、技巧、预计耗时。
- 将自然语言菜谱整理为系统结构化数据。

可读数据：

- `Ingredient`
- `Recipe`
- `RecipeIngredient`
- `RecipeStep`
- `FoodScene`
- 最近做过的菜

产出：

- 菜谱草稿
- 食材明细
- 步骤明细
- 场景标签
- tips
- 图片生成 payload

结构化生成必须校验 JSON schema。非法 JSON、低质量结果或跨家庭资源 ID 必须返回 failed，不能静默降级为假数据。

### 3.4 餐食计划智能体

职责：

- 生成一天或多天餐食计划。
- 避免最近重复吃同样菜品。
- 优先使用临期和已有库存。
- 将用户偏好、家庭人数、日期范围、餐别纳入计划。

可读数据：

- `MealLog`
- `Food`
- `Recipe`
- `InventoryItem`
- `FoodPlanItem`

产出：

- 按日期和餐别组织的计划草稿
- 每餐推荐原因
- 缺失食材列表
- 可选购物清单草稿

### 3.5 购物清单智能体

职责：

- 根据菜谱、餐食计划、低库存和用户自然语言生成购物清单。
- 合并重复项。
- 使用家庭默认单位和低库存阈值。
- 标注每个购物项的原因。

可读数据：

- `ShoppingListItem`
- `InventoryItem`
- `Ingredient`
- `RecipeIngredient`
- 餐食计划草稿

产出：

- 购物清单草稿
- 数量和单位
- 来源原因
- 是否可能已在库存中存在的提示

### 3.6 食物资料智能体

职责：

- 根据描述或图片辅助补全食物资料。
- 推断食物类型、分类、口味标签、来源、备注。
- 关联已有菜谱或建议创建菜谱。

可读数据：

- `Food`
- `Recipe`
- `FoodScene`
- `MediaAsset`

产出：

- 食物资料草稿
- 标签建议
- 关联菜谱建议
- 封面图生成建议

### 3.7 生图智能体

职责：

- 为菜谱、食物、家庭头像、场景生成图片。
- 根据已有结构化信息生成稳定 prompt。
- 管理 reference image 和 text-to-image 两种模式。

实现原则：

- 复用现有 `backend/app/ai/images`。
- 生图 agent 不决定业务数据，只接收业务 agent 生成或用户确认的描述。
- 生图结果通过 `MediaAsset` 保存和绑定。
- 当前内存 job 机制后续应迁移到数据库任务表或队列系统。

### 3.8 确认执行层

确认执行层不是一个让模型自由写库的 agent，而是 human-in-the-loop 之后的确定性业务执行层。

职责：

- 接收已确认草稿。
- 调用确定的业务 service 或 API。
- 记录审计、幂等 key、执行状态。
- 失败时返回可恢复错误。

写操作必须满足：

- 用户已确认，且存在有效 `AIApprovalRequest`。
- 当前用户有权限。
- 所有资源 ID 属于当前家庭。
- payload 通过 schema 校验。
- 操作具备幂等能力，避免重复创建。

## 4. 交互模型

### 4.1 四类输出与执行边界

- Answer：只读回答
  - 示例：“冰箱里有什么快过期？”
  - AI 可以直接读取上下文并回答。
  - 不产生待确认草稿。

- Recommendation：推荐结果
  - 示例：“今晚推荐你做青椒炒蛋和番茄鸡蛋面。”
  - 推荐是可操作建议，但还不是业务草稿。
  - 推荐卡片必须包含推荐理由和依据，例如使用了哪些临期库存、参考了哪些最近餐食。

- Draft：可确认草稿
  - 示例：“帮我生成三天晚餐计划。”
  - AI 生成结构化草稿，但不写业务表。
  - 用户可以编辑、确认、拒绝。

- Operation：确认后的执行
  - 示例：“把这些加入购物清单。”
  - 如果上一步已有草稿，AI 展示执行摘要。
  - 用户确认后，后端 service 执行写入，Agent 不直接写业务表。

执行边界：

```text
AI 可以生成 Answer、Recommendation、Draft。
只有用户确认 Draft 后，系统才创建 Operation。
Operation 由确定性的业务 Service 执行，不由 Agent 直接写库。
```

### 4.2 Human-in-the-loop 确认机制

可编辑、可确认的 AI 结果需要引入 human-in-the-loop 机制。它不是额外的弱提示，而是 AI 工作台执行写操作前的强制安全边界。

适用场景：

- 创建或修改菜谱、餐食计划、购物清单、餐食记录、食物资料。
- 修改库存数量、状态、存放位置、过期日期。
- 生成图片并绑定到业务对象。
- 批量创建、批量修改、删除类操作。
- AI 置信度不足，需要用户补充关键字段。

核心交互：

1. AI 根据用户目标生成 Draft。
2. 后端创建 `AIApprovalRequest`，状态为 `pending`。
3. 前端在当前 assistant 消息内展示确认卡片。
4. 用户可以直接修改字段、确认、拒绝，必要时填写拒绝原因。
5. 用户确认后，后端校验提交值和资源归属，创建 `AIUserApproval` 和 `AIOperation`。
6. `AIOperation` 调用确定性业务 service 写入数据。
7. 执行结果回写对话消息、draft 状态、operation 状态，并刷新对应业务 query。

确认卡片不应只是一个“确定/取消”按钮，而应携带可编辑字段 schema：

```ts
type AIApprovalRequest = {
  id: string
  conversationId: string
  messageId: string
  runId: string
  draftId: string
  draftVersion: number
  draftSchemaVersion: string
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired"
  title: string
  instruction: string
  approveLabel: string
  rejectLabel: string
  requireRejectComment: boolean
  fieldSchema: AIApprovalField[]
  initialValues: Record<string, unknown>
  submittedValues: Record<string, unknown>
  decision: "approved" | "rejected" | null
  comment: string | null
}
```

字段 schema 可参考 MindAtlas 的 human-in-loop 卡片，但按 Culina 的业务字段收敛：

```ts
type AIApprovalField = {
  name: string
  label: string
  type: "string" | "number" | "integer" | "boolean" | "array"
  widget: "input" | "textarea" | "switch" | "select" | "radio" | "checkbox_group" | "tag_selector" | "date" | "time"
  options?: Array<string | { value: string; label: string; description?: string }>
  allowCustom?: boolean
  placeholder?: string
  required?: boolean
}
```

提交协议：

```ts
type AIApprovalDecisionRequest = {
  decision: "approved" | "rejected"
  draftVersion: number
  values: Record<string, unknown>
  comment?: string
}
```

后端必须对 `values` 做二次校验：

- 只接受 `fieldSchema` 中声明过的字段，拒绝未知字段。
- 按字段类型和 widget 转换数据。
- required 字段不能为空。
- select、radio、checkbox_group 必须使用允许选项。
- date、time 必须符合标准格式。
- 所有业务资源 ID 必须属于当前家庭。
- 提交的 `draftVersion` 必须等于当前 `AITaskDraft.version`。
- draft 已过期、已确认、已拒绝或已取消时不能重复提交。

版本绑定规则非常关键：

- `AIApprovalRequest` 必须绑定 `draft_id`、`draft_version`、`draft_schema_version`。
- 用户提交 decision 时必须带上当时确认卡对应的 `draftVersion`。
- 如果提交的 `draftVersion != AITaskDraft.version`，后端拒绝提交，并提示“草稿已更新，请重新确认”。
- 多轮修改草稿时，每次修改都生成新的 draft version；旧 approval 应标记为 `cancelled` 或在提交时因版本不匹配被拒绝。

与 MindAtlas 的差异：

- MindAtlas 的 workflow human-in-loop 会在运行时创建 approval 并阻塞等待用户决策，适合通用 workflow engine。
- Culina 的厨房任务更偏业务系统写入，第一版建议采用异步审批模型：run 生成 draft 和 approval 后即可进入 `waiting_approval` 或 `completed_with_pending_approval` 状态，不长时间占用后端线程。
- 如果后续需要“审批后继续执行复杂 graph”，再增加 resumable run，而不是 Phase 1 就引入阻塞等待模型。

### 4.3 多轮任务状态

一次会话中 AI 应维护任务状态：

- 当前意图
- 已引用对象
- 已加载上下文摘要
- 已生成草稿
- 待确认 approval
- 待用户确认的问题
- 最近一次 agent run

例如：

1. 用户：“用快过期食材安排三天晚餐。”
2. AI 生成三天晚餐计划草稿。
3. 用户：“第二天不要吃鸡肉。”
4. AI 修改草稿，而不是重新开始。
5. 用户：“确认，并生成购物清单。”
6. 系统写入餐食计划，再生成购物清单草稿。

### 4.4 上下文引用

AI 入口应支持从任意业务页面携带上下文。

推荐 subject 结构：

```json
{
  "source": "recipe_detail",
  "recipeId": "recipe_xxx",
  "foodId": null,
  "ingredientIds": [],
  "dateRange": {
    "start": "2026-05-30",
    "end": "2026-06-01"
  },
  "extra": {}
}
```

后端只把 subject 视为资源引用，加载前必须校验家庭归属。模型输出的 ID 也必须二次校验，不能直接信任。

## 5. 技术架构

### 5.1 架构升级原则

现有 AI 架构主要服务于各个页面里的局部辅助能力，例如库存问答、推荐、菜谱草稿、生图任务。这些页面级 AI 能力是正常产品能力，适合任务明确、上下文较窄、入口贴近业务页面的场景。新的 AI 工作台不是替代它们，而是补齐系统级任务编排能力：当用户需要跨库存、菜谱、餐食计划、购物清单、生图等多个模块协作时，由 AI 工作台承接。

升级原则：

- 页面级 AI 能力继续正常使用，工作台级 AI 单独设计架构边界。
- 不被现有 mode、接口形态、单轮对话模型锁死。
- 把单轮、单页面、单功能调用升级为多轮、跨页面、跨模块任务。
- 把“直接返回回答”升级为“回答 + 结构化草稿 + 用户确认执行”。
- 把分散工具函数升级为可声明、可审计、可权限控制的 tool registry。
- 从目标业务任务出发设计总控 graph 和多个业务 subgraph。
- 把普通 conversation 记录升级为完整 message、run event、draft、approval 生命周期。

### 5.2 目标架构分层

建议把 AI 能力分为五层，并在第一阶段就打通主链路：

```text
Frontend AI Workspace
  -> AI Chat / Task API
      -> AI Application Service
          -> Agent Orchestration Layer (LangGraph)
              -> Business Agent Layer
                  -> Tool / Domain Service Layer
```

各层职责：

- Frontend AI Workspace
  - 负责聊天、快捷任务、上下文引用、草稿确认、进度展示。
  - 不承载复杂 agent 状态，不直接拼业务 prompt。

- AI Chat / Task API
  - 提供面向 AI 工作台的新接口，例如 chat、messages、runs、draft confirm。
  - 工作台级能力优先走统一 chat/task API，不以页面级 `/api/ai/query` 和 `/api/ai/recipes/draft` 的 mode 设计为核心。

- AI Application Service
  - 管理会话、消息、run、draft、approval 生命周期。
  - 决定是否调用 agent、是否保存草稿、是否执行确认后的写入。
  - 是数据库事务和审计的主要边界。
  - Controller 不直接调用模型，Agent 不直接写业务表，所有工作台级 AI 请求都经过这一层。

- Agent Orchestration Layer
  - 基于 LangGraph 编排意图识别、上下文规划、agent 路由、结果校验。
  - 不直接提交数据库事务。

- Business Agent Layer
  - 放库存、菜谱、餐食计划、购物清单、食物资料、生图等业务智能体。
  - 每个 agent 专注一个任务域。

- Tool / Domain Service Layer
  - read tool 负责安全读取。
  - draft tool 负责生成可校验草稿。
  - operation executor 或 domain service 只处理用户确认后的确定性写入，不由模型自由调用。

Phase 1 的目标不是做很多 AI 功能，而是让下面这条链路稳定：

```text
AI Workspace
  -> /api/ai/chat
  -> AIApplicationService
  -> Orchestrator
  -> Agent Registry
  -> Tool Registry
  -> Agent Handler
  -> Output Schema Validation
  -> AIMessage / AIAgentRun / AITaskDraft
  -> AIApprovalRequest
  -> Result Card / Draft Approval UI
  -> AIUserApproval / AIOperation
```

### 5.3 代码组织建议

现有 AI 代码结构可以保留，但应允许升级：

```text
backend/app/ai/
  runtime/       # 通用 provider、runner、registry、event schema
  orchestration/ # 总控 graph、intent router、context planner
  agents/        # 面向业务域的 agent 定义，新 AI 工作台的核心业务层
  page/          # 页面级 AI 能力，服务单一页面或单一任务
  images/        # AI 生图能力
  drafts/        # 草稿 schema、校验、确认执行适配
```

职责边界：

- `ai/runtime`
  - 放 provider、runner、agent registry、tool registry、通用 schema。
  - 不 import 业务模型，不写数据库，不拼业务 prompt。

- `ai/orchestration`
  - 放总控 graph、意图识别、上下文规划、agent 路由。
  - 可以依赖 runtime 的 registry，但不直接写业务表。

- `ai/agents`
  - 放按业务域拆分的 agent，例如 inventory、recipe、meal_plan、shopping、food_profile。
  - AI 工作台的业务智能体都应放在这里，围绕跨模块任务设计。

- `ai/page`
  - 可选目录，用于组织页面级 AI 能力，例如某个页面内的问答、推荐、草稿生成。
  - 如果保留 `ai/kitchen`，也应把它定位为页面级或业务局部 AI 能力模块，而不是 AI 工作台的主编排层。
  - 页面级能力可以继续迭代，但工作台级能力不应依赖它的 mode、prompt、graph 形态。

- `ai/images`
  - 放生图 provider、prompt、job 管理。
  - 媒体保存仍由 `services/media.py` 负责。

### 5.4 LangGraph 编排

新的系统级 AI 应以总控 graph 为入口：

```text
start
  -> load_session
  -> detect_intent
  -> plan_context
  -> load_context
  -> route_agent
  -> run_subgraph
  -> validate_result
  -> build_response
  -> end
```

总控 graph 不直接完成所有业务任务，而是负责把任务拆给合适的 subgraph。这样可以避免一个超大 prompt 或超大 graph 把所有业务逻辑耦合在一起。

子 graph 按业务拆分：

- `inventory_graph`
- `recipe_graph`
- `meal_plan_graph`
- `shopping_graph`
- `food_profile_graph`
- `image_graph`

每个 graph 节点职责保持单一：

- `load_context`：加载当前家庭内必要数据。
- `tools`：执行只读工具。
- `agent`：调用模型 provider。
- `validate`：校验结构化输出。
- `finalize`：整理返回结果，不提交事务。

写操作不进入 graph 的自动执行链路。用户确认后由 service 层调用业务逻辑。

路由策略应降低模型的权限。模型可以负责意图理解和槽位抽取，但后端规则决定加载哪些上下文、调用哪个 agent、是否需要确认、是否允许写入。

模型输出示例：

```json
{
  "intent": "meal_plan",
  "confidence": 0.86,
  "slots": {
    "days": 3,
    "mealTypes": ["dinner"],
    "constraints": ["use_expiring_ingredients"]
  },
  "missingFields": []
}
```

后端配置示例：

```python
INTENT_CONFIG = {
    "meal_plan": {
        "required_context": ["inventory", "meal_logs", "recipes", "food_plan"],
        "agent_key": "meal_plan_agent",
        "output_type": "draft",
        "requires_confirmation": True,
    }
}
```

这样可以避免模型自行决定权限、写行为或跨家庭资源访问，测试也更稳定。

### 5.5 页面级 AI 与工作台级 AI 的关系

页面级 AI 功能和工作台级 AI 功能是并行关系，不是淘汰关系。页面级 AI 适合嵌在具体页面里解决单一问题；工作台级 AI 适合承接跨模块、多步骤、需要确认执行的任务。

- 页面级 AI 能力
  - `/api/ai/query` 可以继续支持页面内问答或推荐。
  - `/api/ai/recipes/draft` 继续支持菜谱页草稿生成。
  - 这些能力可以继续迭代，但重点是把单一页面任务做好，不承担跨模块总控编排。

- 工作台级 AI 能力
  - AI 工作台优先走 `/api/ai/chat`、messages、runs、drafts。
  - 工作台入口按 conversation/message/run/draft 生命周期设计。
  - 工作台入口直接调用 `ai/orchestration` 和 `ai/agents`，不把页面级 assistant 作为过渡核心。

- 业务 agent 建设
  - 根据目标任务直接设计 inventory、recipe、meal_plan、shopping、food_profile、image agent。
  - 可以参考页面级能力中的 context loader、formatter、provider 调用方式，但不要复制页面 mode 驱动的设计。
  - 跨模块任务从一开始交给 orchestration graph 编排。

- 统一运行记录
  - 页面级 AI 和工作台级 AI 都可以写 `AIAgentRun`。
  - 工作台级入口额外写 `AIMessage`、`AITaskDraft`、run events。

### 5.6 Agent Registry

系统级 AI 工作台应从一开始设计 agent registry，避免工作台能力继续堆成单一页面助手。

建议字段：

```python
@dataclass(slots=True)
class AgentDefinition:
    key: str
    name: str
    description: str
    supported_intents: list[str]
    output_schema: Any
    graph_builder: Callable
    requires_confirmation: bool
```

作用：

- Orchestrator 可以根据 intent 和后端配置找到候选 agent。
- API 可以返回当前系统支持的 AI 能力。
- 测试可以枚举所有 agent 并检查基础约束。
- 第一阶段可以只注册 `today_recommendation_agent`、`recipe_draft_agent`、`fallback_chat_agent`，后续再增加库存、餐食计划、购物清单、食物资料和生图 agent。

### 5.7 Tool Registry

工具需要从散落函数逐步演进到声明式 registry。

建议字段：

```python
@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict
    output_schema: dict
    permission: str
    side_effect: Literal["read", "draft", "operation"]
    requires_confirmation: bool
```

工具分级：

- read tools：只读查询，例如查询库存、菜谱、餐食记录。
- draft tools：生成结构化草稿，不写数据库。
- operation executors：只处理用户确认后的 payload，调用确定业务服务；它们不暴露给模型自由调用。

第一阶段可以参考现有只读工具的实现方式，但 AI 工作台应尽早定义 tool registry，避免工作台能力继续堆在页面级函数里。

第一阶段工具数量要少，但标准要完整。建议先支持：

- `inventory.read_summary`
- `inventory.read_expiring_items`
- `meal_log.read_recent`
- `recipe.search_available`
- `recipe.create_draft`

### 5.8 后端接口规划

页面级 AI 能力可以继续使用现有接口：

- `POST /api/ai/query`
- `POST /api/ai/recipes/draft`
- `GET /api/ai/conversations`

AI 工作台建议新增统一接口，并以这些接口作为新能力的主入口：

- `POST /api/ai/chat`
  - 发送用户消息。
  - 创建或继续会话。
  - 返回 assistant message、run id、草稿信息。

- `GET /api/ai/conversations`
  - 查询会话列表。
  - 查询 AI 工作台会话列表，包含标题、最近摘要、最近状态。

- `GET /api/ai/conversations/{id}/messages`
  - 查询完整消息历史。

- `GET /api/ai/runs/{id}/events`
  - 获取运行进度。
  - 初期可轮询，后续升级 SSE。

- `PATCH /api/ai/drafts/{id}`
  - 用户编辑 AI 草稿。
  - 只保存草稿内容，不执行确认写入。

- `GET /api/ai/conversations/{id}/approvals/pending`
  - 查询当前会话内待处理的确认卡片，用于页面刷新后恢复 pending 状态。

- `POST /api/ai/conversations/{id}/approvals/{approval_id}/decision`
  - 用户提交确认或拒绝。
  - 请求体包含 `decision`、编辑后的 `values` 和可选 `comment`。
  - 后端校验 approval、draft、字段 schema、家庭数据归属和幂等状态。

`POST /api/ai/chat` 的响应不应让前端解析自然语言来猜 UI 类型。后端应返回结构化协议：

```ts
type AIResponse = {
  conversationId: string
  message: AIMessageDTO
  run?: AIRunDTO
  events?: AIRunEventDTO[]
  included?: {
    resultCards?: AIResultCardDTO[]
    drafts?: AITaskDraftDTO[]
    approvals?: AIApprovalRequestDTO[]
  }
}
```

`AIMessage.parts` 是唯一的主渲染顺序和长期渲染数据源。`included.resultCards`、`included.drafts`、`included.approvals` 只能用于缓存更新、实体归一化和快速索引，不能单独作为页面渲染结构。它们必须由同一份后端结果构造，避免前端出现 message 与 card 状态不一致。

Result card 建议使用明确类型：

```ts
type AIResultCard =
  | TodayRecommendationCard
  | InventoryInsightCard
  | RecipeDraftCard
  | MealPlanDraftCard
  | ShoppingListDraftCard
  | ApprovalRequestCard
  | ErrorRecoveryCard
```

运行事件面向用户时也要产品化，避免直接暴露 `detect_intent`、`route_agent` 这类内部节点名。事件结构建议同时保留内部代码和用户文案：

```ts
type AIRunEvent = {
  id: string
  runId: string
  type: string
  internalCode: string
  userMessage: string
  status: "pending" | "running" | "completed" | "failed"
  createdAt: string
}
```

示例用户文案：

- 正在理解你的需求
- 正在查看你的库存
- 正在找出优先处理的食材
- 正在生成推荐方案
- 已生成可操作建议

### 5.9 数据模型规划

现有模型继续使用：

- `AIConversation`
  - 作为工作台会话列表的基础。
  - 建议字段包括 `family_id`、`created_by`、`title`、`summary`、`status`、`last_message_at`、`last_run_status`。

- `AIAgentRun`
  - 继续作为每次 agent 执行的审计记录。
  - 建议字段包括 `conversation_id`、`message_id`、`agent_key`、`intent`、`status`、`input_summary`、`context_summary`、`tool_calls`、`output_summary`、`error_code`、`error_message`、`model`、`latency_ms`、`token_usage`、`completed_at`。
  - 生产环境默认不完整保存明文 prompt 和完整上下文，优先保存 prompt template version、脱敏输入、上下文摘要、tool call summary 和模型元数据。

- `AIRecommendation`
  - 当前推荐能力继续使用。
  - 后续可作为推荐类 result card 的数据来源。

建议新增模型：

- `AIMessage`
  - 记录 `conversation_id`、`role`、`content`、`content_type`、`parts`、`run_id`、`status`、`metadata`、`client_message_id`。
  - 支持完整多轮对话，而不是只保存单轮 conversation。
  - `parts` 用于承载文本、推荐卡片、菜谱卡片、计划表、购物清单草稿、错误恢复卡片等结构化内容。

- `AITaskDraft`
  - 记录待确认草稿。
  - 字段包括 `draft_type`、`payload`、`preview_summary`、`status`、`version`、`schema_version`、`validation_errors`、`idempotency_key`、`source_run_id`、`expires_at`。
  - `draft_type` 可包括 `recipe`、`shopping_list`、`meal_plan`、`meal_log`、`food_profile`。
  - Phase 1 可以只实现 `recipe`，但模型结构要允许后续扩展。

- `AIApprovalRequest`
  - 记录 human-in-the-loop 确认请求，是 Draft 到 Operation 之间的审批对象。
  - 字段包括 `conversation_id`、`message_id`、`run_id`、`draft_id`、`draft_version`、`draft_schema_version`、`approval_type`、`status`、`request_payload`、`field_schema`、`initial_values`、`submitted_values`、`decision`、`comment`、`resolved_at`、`expires_at`。
  - `status` 建议包括 `pending`、`approved`、`rejected`、`cancelled`、`expired`。
  - `request_payload` 存确认卡片标题、说明、按钮文案、是否要求拒绝原因。
  - `field_schema` 和 `initial_values` 驱动前端生成可编辑表单。
  - 索引建议覆盖 `(conversation_id, status)`、`(run_id, status)`、`draft_id`。
  - 提交确认时必须校验 `draft_version`，防止用户在旧确认卡上确认已被修改的草稿。

- `AIUserApproval`
  - 记录用户对 approval 的决策审计事件，不作为当前状态源。
  - 字段包括 `approval_request_id`、`draft_id`、`approved_by`、`approved_at`、`approval_payload`、`operation_summary`。
  - 拒绝也应记录，字段可包括 `decision` 和 `comment`，不要只记录通过。

- `AIOperation`
  - 建议新增，用于区分“用户确认”和“实际执行结果”。
  - 字段包括 `approval_request_id`、`draft_id`、`operation_type`、`status`、`business_entity_type`、`business_entity_ids`、`idempotency_key`、`error_message`、`completed_at`。
  - 这样可以排查“用户已确认，但业务写入失败”的问题。

- `AIToolExecution`
  - 可选。
  - 如果后续需要独立查询工具执行记录，再从 `AIAgentRun.tool_calls` 拆出。

状态源约定：

- Draft 当前状态以 `AITaskDraft.status` 为准。
- Approval 当前状态以 `AIApprovalRequest.status` 为准。
- Operation 当前状态以 `AIOperation.status` 为准。
- `AIUserApproval` 是审计记录，不能反向作为 approval 当前状态判断依据。

标准状态机：

```text
AITaskDraft: pending
  -> AIApprovalRequest: pending

用户拒绝:
  -> AIApprovalRequest: rejected
  -> AITaskDraft: rejected
  -> AIUserApproval: created(decision=rejected)
  -> 不创建 AIOperation

用户确认:
  -> 校验 draft_version
  -> AIApprovalRequest: approved
  -> AIUserApproval: created(decision=approved)
  -> AIOperation: pending/running

业务写入成功:
  -> AIOperation: succeeded
  -> AITaskDraft: confirmed

业务写入失败:
  -> AIOperation: failed
  -> AITaskDraft: confirmation_failed 或 pending_retry
```

`AIApprovalRequest.status == approved` 只代表用户授权，不代表业务写入成功。只有 `AIOperation.status == succeeded` 后，业务操作才算最终完成。

### 5.10 前端实现

建议新增或拆分以下组件：

- `AiWorkspace`
  - AI 页面根组件。
  - 负责布局、会话状态、消息加载。

- `ChatThread`
  - 渲染用户和 assistant 消息。
  - 支持文本、卡片、计划表、错误恢复卡片。

- `AiComposer`
  - 输入框、发送按钮、快捷指令、对象引用提示。

- `TaskShortcutGrid`
  - 快捷任务入口。

- `ContextSummaryBar`
  - 第一版优先做轻量上下文摘要，例如“已参考 6 个库存食材、3 个临期提醒、最近 7 条餐食记录”。
  - 桌面端可以保留右侧上下文面板的空间，但不必第一版做得很重。

- `ContextPanel`
  - 展示当前家庭上下文和引用对象，适合作为第二阶段增强。

- `AiResultCard`
  - 通用结果卡片容器。

- `DraftApprovalPanel`
  - 展示待确认草稿，支持编辑、确认、拒绝。
  - 根据后端返回的 `AIApprovalRequest.fieldSchema` 渲染表单。
  - pending 状态允许编辑和提交；approved、rejected、cancelled、expired 状态只读展示。
  - 拒绝时按 `requireRejectComment` 判断是否必须填写原因。
  - 提交后更新当前消息内的 approval 状态，并刷新 pending approval 列表。

- `DraftEditor`
  - 复杂草稿使用专用编辑器，不强行用通用 `fieldSchema` 渲染所有字段。
  - `draft_type = "recipe"` 使用 `RecipeDraftEditor`。
  - `draft_type = "meal_plan"` 使用 `MealPlanDraftEditor`。
  - `draft_type = "shopping_list"` 使用 `ShoppingListDraftEditor`。
  - `draft_type = "food_profile"` 使用 `FoodProfileDraftEditor`。
  - Approval 负责确认流程，DraftEditor 负责复杂编辑体验。

- `RunProgressTimeline`
  - 展示执行进度。

状态管理沿用当前 React Query 风格。AI 页面不应成为独立状态孤岛，确认写入后要 invalidate 对应业务 query，例如购物清单、菜谱、餐食记录。

前端状态建议把 approval 挂在 assistant message 上，而不是单独漂浮在页面外。这样用户能清楚看到“这张确认卡是对哪一次 AI 回复的确认”。页面刷新或重新进入会话时，通过 pending approval 接口恢复仍待处理的确认卡。

通用 `fieldSchema` 只适合简单 approval 表单，例如标题、日期、份量、备注、是否确认。复杂业务草稿不要完全依赖通用表单：

- 菜谱包含食材数组和步骤数组，需要菜谱专用编辑器。
- 餐食计划包含日期 x 餐别 x 菜品，需要计划表编辑器。
- 购物清单包含分组 item、数量、单位、原因，需要清单编辑器。
- 食物资料包含标签、图片、关联菜谱，需要资料编辑器。

确认卡可以嵌入专用 DraftEditor，提交时仍统一走 approval decision 协议。

## 6. 安全与控制

### 6.1 数据隔离

- 所有 context loader 和 tool 查询必须带 `family_id`。
- 所有 subject 中的资源 ID 必须校验属于当前家庭。
- 模型输出中的资源 ID 必须二次校验。
- 不允许 AI 根据用户输入拼 SQL。
- tool 输出不能包含其他家庭数据。

### 6.2 用户确认

以下操作必须确认：

- 创建菜谱
- 创建或修改购物项
- 创建餐食记录
- 修改库存数量或状态
- 创建食物资料
- 生成图片并绑定到业务对象
- 删除或批量修改任何数据

Human-in-the-loop 是这些操作的标准实现方式：AI 先生成 Draft 和 `AIApprovalRequest`，前端展示确认卡片，用户编辑后批准或拒绝。没有有效 approval 的写操作不能进入 `AIOperation`。

确认前，AI 必须展示：

- 将要创建或修改的对象类型。
- 关键字段摘要。
- 影响范围。
- 可编辑草稿。

确认提交后，后端必须执行：

- 校验 approval 状态仍为 `pending`。
- 校验 draft 状态、版本和 schema version。
- 校验提交的 `draftVersion` 等于当前 draft version。
- 校验用户仍属于当前家庭且有操作权限。
- 校验提交字段和业务资源归属。
- 使用 `idempotency_key` 防止重复执行。
- 写入 `AIUserApproval` 和 `AIOperation`。
- 操作失败时保留 draft 和 approval 记录，返回可恢复错误。

推荐和草稿也应提供依据。推荐卡片至少包含 `reason`，复杂推荐应包含 `evidence`：

```json
{
  "title": "青椒炒鸡蛋",
  "reason": "优先使用已临期的青椒和鸡蛋，做法简单，适合晚餐",
  "evidence": [
    {
      "type": "inventory_item",
      "label": "青椒",
      "status": "expiring"
    }
  ]
}
```

### 6.3 Prompt 安全

- 系统 prompt 明确模型只能依据传入上下文回答。
- 用户输入只能作为 user content，不拼入系统规则。
- 外部文本、备注、菜谱内容、用户上传内容均视为不可信上下文。
- 工具结果以结构化 JSON 提供，避免模型把工具输出误认为系统指令。
- 结构化输出必须做 schema 校验和业务校验。
- 模型只负责意图理解、内容生成和解释，不负责最终权限决策、上下文范围决策或写入决策。

### 6.4 成本与稳定性

- 每次 run 记录模型、耗时、状态、错误、token 估算。
- 按用户或家庭做 AI 调用限流。
- provider fallback 按任务定义，不能所有任务一刀切。
- 普通问答 provider 不可用时可以 fallback。
- 今日推荐类任务可用规则兜底，例如临期食材 + 最近未吃过的菜。
- 临期处理类任务可直接列临期清单和通用处理建议。
- 结构化菜谱生成 provider 不可用或返回非法 JSON 时必须 failed，不伪造菜谱。
- 购物清单类任务可在有明确餐食计划和库存缺口时用规则生成。
- 长任务支持取消和重试。
- 生图任务应保持 job 化，后续迁移到数据库任务表或队列。
- 日志按环境分级：debug 环境可记录较完整内容，production 默认只记录摘要和脱敏内容；家庭饮食习惯、备注、图片描述、成员信息等敏感内容不应进入普通日志。

## 7. 开发计划

### Phase 1：AI 工作台平台骨架 MVP

目标：搭建长期可扩展的 AI 工作台主链路，用 1 到 2 个样例任务验证架构。Phase 1 要“大架子”，不要“大功能”：架构链路完整，接口协议稳定，数据生命周期打通；智能体数量少，工具数量少，写入范围小，交互复杂度低。

Phase 1 建议拆成内部两个交付阶段，降低一次性交付风险。

#### Phase 1A：AI 工作台基础链路

目标：先证明用户发消息后，可以经过统一工作台链路返回结构化回复和结果卡片。

范围：

- 新增 AI Workspace 页面。
- 新增统一 `/api/ai/chat`，所有工作台级请求都经过 AIApplicationService 和 Orchestrator。
- 建立 AIApplicationService、轻量 Orchestrator、Agent Registry、Tool Registry。
- 建立 AIConversation、AIMessage、AIAgentRun、RunEvent 的基础生命周期。
- 定义 AIResponse、AIMessage.parts、ResultCard、RunEvent 前后端协议。
- 实现 `today_recommendation_agent` 和 `fallback_chat_agent`。
- 支持 TodayRecommendationCard 和 ErrorRecoveryCard。
- 展示历史会话、聊天区、快捷任务、基础结果卡片和轻量 ContextSummaryBar。
- 不做 Draft、Approval、Operation、业务写入和 pending approval 恢复。

验收：

- 用户可以在 AI 工作台发送自然语言消息。
- 请求经过 `/api/ai/chat`、AIApplicationService、Orchestrator、Agent Registry。
- “今日吃什么”能返回带 reason/evidence 的 TodayRecommendationCard。
- fallback_chat_agent 能处理无法识别或暂不支持的问题。
- AIMessage、AIAgentRun、RunEvent 有基础持久化。
- 新增 result card type 时 contract test 能发现前端缺少渲染组件。

#### Phase 1B：Draft + Approval + Operation

目标：在 Phase 1A 基础链路上补齐可编辑、可确认、可写入的 human-in-the-loop 闭环。

范围：

- 建立 AITaskDraft、AIApprovalRequest、AIUserApproval、AIOperation 的基础生命周期。
- 实现 `recipe_draft_agent`。
- 支持 RecipeDraftCard 和 RecipeDraftEditor。
- 菜谱草稿可以创建、展示确认卡片、编辑、拒绝、确认。
- 支持 approval decision 接口、draft version 校验、幂等写入。
- 确认写入可以先只支持菜谱一种类型。
- 支持 pending approval 恢复。
- 不做全部业务智能体、复杂多智能体协作、完整 SSE、成本分析平台、所有 draft 类型确认写入、生图主流程。

验收：

- 所有 AI 工作台请求都经过统一 chat API 和 Orchestrator。
- 新增 agent 不需要改动页面主结构和 chat API。
- 菜谱草稿可以被创建、编辑、拒绝、确认。
- message、run、draft、approval 有基础持久化。
- 页面刷新后仍能恢复 pending approval。
- 没有 pending approval 或 approval 已处理时，确认接口不能重复写入。
- approval decision 的 draftVersion 与当前 draft version 不一致时必须拒绝。
- AIOperation 成功后业务菜谱才真正创建。
- provider 失败时有统一错误恢复卡片。

### Phase 2：核心业务 Agent 扩展

目标：在 Phase 1 骨架上添加核心厨房业务智能体。

范围：

- 扩展 `inventory_agent`、`meal_plan_agent`、`shopping_agent`、`meal_log_agent`。
- 增加更多 read tools 和 draft tools。
- 增强 intent routing、槽位抽取和缺失信息追问。
- 支持多轮草稿修改。
- AIAgentRun 记录完整路由和 tool calls。

验收：

- 用户不选择模式也能被路由到正确 agent。
- “用快过期食材安排三天晚餐”能调用库存和餐食计划能力。
- “基于这个计划生成购物清单”能生成购物草稿。
- 用户可以要求修改已有草稿，而不是重新开始。
- 意图识别失败时能追问用户，而不是胡乱执行。

### Phase 3：草稿与确认执行

目标：让 AI 可以安全地辅助写入系统。

范围：

- 支持购物清单草稿、餐食计划草稿、餐食记录草稿、食物资料草稿。
- 前端展示确认面板，支持编辑、确认、拒绝。
- 后端 service 层执行写入。
- 支持 meal_plan、shopping_list、meal_log、food_profile 等 draft confirm。
- 写入必须具备幂等 key。
- 记录用户审批、业务 operation 和审计。
- 写入成功后刷新对应业务 query。

验收：

- AI 生成草稿后不会直接写库。
- 用户确认后才创建业务数据。
- 重复点击确认不会重复创建。
- 草稿中的跨家庭资源 ID 会被拒绝。
- 写入失败可恢复，用户能看到失败原因并重试。

### Phase 4：流式体验与任务进度

目标：提升复杂任务体验。

范围：

- 引入 run events。
- 初期用轮询，后续升级 SSE。
- 前端展示执行进度时间线。
- 支持长任务取消、失败重试、局部重生成。
- 多轮对话能围绕同一个草稿持续修改。

验收：

- 用户能看到 AI 正在执行哪一步。
- 长任务失败后可以重试。
- 用户可以说“第二天不要吃鸡肉”并修改已有菜单草稿。

### Phase 5：生产化

目标：让 AI 能力可观测、可控、可持续运营。

范围：

- 调用限流。
- 成本统计。
- 模型配置管理。
- AI 评估集。
- 监控告警：失败率、耗时、fallback 率、用户确认率。
- 生图内存队列迁移到数据库任务表或队列系统。
- 日志脱敏和隐私字段治理。

验收：

- 可以按家庭和用户查看 AI 调用量。
- 可以监控 provider 失败率。
- 典型任务有评估用例。
- 日志不记录敏感明文。

## 8. 测试计划

### 8.1 后端单测

- 意图识别正确路由到对应 agent。
- 每个 read tool 都按 `family_id` 隔离数据。
- provider completed、fallback、failed 三类状态。
- 结构化输出 JSON 校验。
- 非法 JSON 返回 failed。
- 草稿确认前不写业务表，但可以写 AIMessage、AITaskDraft、AIApprovalRequest 等 AI 工作台表。
- 用户确认后写入正确业务表。
- 重复确认具备幂等能力。
- AIAgentRun 记录 agent、intent、context summary、tool calls、status、error。
- AIApplicationService 覆盖创建会话、保存 user message、创建 run、保存 assistant message、保存 draft 的主链路。
- `/api/ai/chat` 返回结构化 AIResponse，前端不需要解析自然语言判断卡片类型。
- Run event 同时包含内部 code 和用户可读文案。
- 路由测试覆盖：模型只输出 intent/slots，后端规则决定 agent、context 和确认要求。
- 生产日志测试覆盖敏感字段脱敏或不落日志。
- AIApprovalRequest 字段校验：未知字段、错误类型、非法选项、缺失 required 字段都应拒绝。
- approval 状态机测试：pending 可以提交；approved、rejected、cancelled、expired 不能重复提交。
- approval 与 conversation、message、run、draft 的归属校验。
- approval 确认后创建 AIOperation，拒绝时不创建业务写入 Operation。

### 8.2 前端测试

- AI 页面空状态、加载状态、错误状态。
- 发送消息后消息列表更新。
- 快捷任务生成正确请求 payload。
- 结果卡片正确展示菜谱、购物项、餐食计划。
- 推荐卡片展示 reason 和 evidence。
- 草稿确认、编辑、取消流程正确。
- 确认卡片支持编辑字段、批准、拒绝、拒绝原因。
- 页面刷新后能重新加载 pending approval 并挂回对应 assistant message。
- RunProgressTimeline 展示用户可理解的进度文案，不暴露内部节点名。
- ContextSummaryBar 展示轻量上下文摘要。
- 移动端布局不遮挡输入框和确认按钮。
- 业务写入成功后对应页面数据刷新。

### 8.3 API / Schema Contract Tests

AI 工作台是 schema 驱动的系统，必须单独增加契约测试，避免后端新增类型后前端静默不显示。

- 所有 `AIMessage.parts.type` 都有前端渲染组件。
- 所有 `AIResultCard.type` 都有前端渲染组件。
- 所有 `draft_type` 都有对应 schema version。
- 所有复杂 `draft_type` 都有对应 DraftEditor 或明确降级展示。
- 所有 `AIApprovalRequest.fieldSchema.widget` 都有对应表单控件。
- 后端新增 card type、message part type、draft type、approval widget 时，前端 contract test 必须失败，直到补齐渲染。
- 旧版本 draft 打开时能迁移、只读展示，或明确提示已过期。
- 前端渲染顺序只以 `AIResponse.message.parts` 为准。
- `AIResponse.included.resultCards`、`included.drafts`、`included.approvals` 只允许用于缓存更新和实体索引，不能被前端直接重复渲染。
- `AIResponse.message.parts` 与 `included` 中的实体必须来自同一结果源，不允许同一对象状态冲突。
- approval decision 的 `draftVersion` 与当前 draft version 不一致时，API 必须返回明确冲突错误。

### 8.4 集成验收场景

- “冰箱里快过期的东西能做什么？”
- “帮我生成一份番茄鸡蛋面的菜谱，2 人份。”
- “基于这份菜谱生成购物清单。”
- “帮我安排未来 3 天晚餐，尽量用掉现有库存。”
- “记录今晚吃了红烧牛肉和米饭，两人份。”
- “把这个食物资料补全一下，顺便生成一张封面图。”

## 9. 推荐落地顺序

建议不要被现有页面级 AI 架构限制。最佳路径是“Phase 1 搭平台骨架，做少量样例能力；Phase 2 之后在稳定骨架上持续添加智能体、工具和任务闭环”。

1. Phase 1A 先搭 AI 工作台基础链路：统一 chat API、AIApplicationService、轻量 Orchestrator、Agent Registry、Tool Registry、Message、Run、ResultCard、RunEvent。
2. 用“今日吃什么”和 fallback chat 验证结构化回复主链路。
3. Phase 1B 再补 Draft、Approval、Operation，用“生成菜谱草稿”验证 human-in-the-loop 和幂等写入。
4. Phase 2 开始注册更多核心业务 agent 和 tools，而不是新增零散接口。
5. Phase 3 扩展更多确认执行和业务写入闭环，让 AI 安全完成系统操作。
6. 最后补流式事件、长期记忆、成本控制、评估和监控。

这个顺序可以让产品尽快出现可用体验，同时给系统级 AI 能力留下足够的架构空间。现有实现中能复用的 provider、生图、运行记录等基础能力继续复用；适合页面内单点任务的接口、mode、单轮会话模型继续服务页面级 AI，但不进入工作台级 AI 的主编排核心。
