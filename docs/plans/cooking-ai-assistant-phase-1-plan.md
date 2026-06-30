# 做菜 AI 助手一阶段落地方案

更新时间：2026-06-29

状态：一阶段已落地，实现了后端 profile/Skill/UI action 协议，以及做菜页文字助手入口、上下文快照、流式回复和白名单页面动作执行。

落地备注：

- 后端仍复用 `WorkspaceOrchestratorAgent`，通过 profile 预注入 `cooking_assistant`。
- 页面动作通过 `ui_actions` result card 返回，由前端按菜谱、会话和 `sessionRevision` 校验后执行。
- 前端不再做自然语言关键词命令分支；“下一步”“暂停计时”等文字命令也统一发送给 AI，由 `ui.propose_actions` 返回动作 proposal。
- 低风险动作可自动执行；`reset_cook_session`、`delete_timer`、`finish_cooking`、`open_shopping_dialog` 必须二次确认。
- `finish_cooking` 在确认后只打开现有完成烹饪确认弹窗，不直接扣库存、完成计划或记录餐食。
- 一阶段仅支持文字输入输出；语音输入、语音播报和实时对话仍属于后续阶段。

## 1. 背景

做菜页面已经是 Culina 里一个独立的烹饪工作区，包含：

- 当前菜谱和步骤进度。
- 食材清单、勾选状态和库存缺料预览。
- 一个或多个计时器。
- 做菜会话恢复。
- 完成烹饪后的库存扣减、计划完成和餐食记录入口。

用户在做饭时更需要一个“懂当前现场”的助手，而不是进入完整 AI 工作台重新描述上下文。这个助手应知道当前菜谱、当前步骤、食材准备状态、计时器状态和缺料情况，并能回答烹饪相关问题，也能帮助用户操作页面，例如下一步、切换食材清单、开始或暂停计时器、增加计时。

同时，Culina 现有 AI 架构已经统一到 `WorkspaceOrchestratorAgent`、Skill 注入、Tool 白名单、SSE 流式输出和 draft approval 流程。做菜 AI 助手不应另写一套 Orchestrator，也不应绕过现有 AI 安全边界。

## 2. 一阶段目标

一阶段只做文字输入和文字输出，不考虑语音输入、语音播报、实时音视频对话。

目标：

1. 在做菜页面嵌入轻量 AI 助手。
2. 助手能读取当前做菜页面上下文，包括菜谱、当前步骤、食材状态、缺料状态和计时器状态。
3. 助手能回答烹饪过程中的短问题，风格口语化、响应快、直接可用。
4. 助手能提出并触发白名单内的页面动作，例如下一步、上一步、切换 tab、开始或暂停计时器、设置计时器。
5. 复用现有 `/api/ai/chat/stream`、AI message、SSE、Skill、Tool 和 Orchestrator 主路径。
6. 通过 Orchestrator profile 机制支持“预注入做菜助手 Skill”和“入口定制提示词”，避免新建一个做菜专用 Orchestrator。

## 3. 非目标

一阶段不做：

- 语音输入。
- 语音输出。
- 实时双向语音对话。
- 视频识别或锅中状态识别。
- 让模型直接扣库存、完成计划、写餐食记录。
- 绕过现有 `recipe_cook` 草稿审批链路。
- 把完整 AI 工作台复制到做菜页面。
- 做通用浏览器自动化或任意页面操作。

## 4. 核心设计结论

采用一套主路径：

```text
RecipeCookView
  -> CookingAssistantPanel
  -> aiApi.streamChatAi('/api/ai/chat/stream')
  -> WorkspaceGraphRunner
  -> WorkspaceOrchestratorAgent
  -> initial skill: cooking_assistant
  -> read tools / ui action proposal tool
  -> SSE text + optional UI action part
  -> frontend validates and executes page actions
```

关键点：

- 仍然只有一个 `WorkspaceOrchestratorAgent`。
- 做菜助手通过 `quick_task` / `subject.source` 选择 Orchestrator profile。
- Profile 负责提供初始注入 Skill 和额外系统提示词。
- 新增 `cooking_assistant` Skill，负责做菜中问答和页面动作建议。
- 页面动作通过结构化 proposal 返回，前端按白名单执行。
- 正式业务写入仍走现有 `recipe_cook` draft approval，不进入页面动作通道。

## 5. 用户体验形态

### 5.1 移动端

移动端是主体验。建议在做菜页面底部操作区或右下角加入“问助手”入口。

打开后展示底部抽屉：

- 高度默认为视口的 45% 到 55%。
- 不遮挡顶部当前步骤标题和关键计时状态。
- 输入框固定在抽屉底部，处理安全区。
- 消息区只展示当前做菜会话内的简短对话，不展示完整 AI 工作台历史列表。
- 助手回复应短句优先，避免长 Markdown。

快捷问题示例：

- 这一步做到什么程度？
- 下一步要先准备什么？
- 没有这个食材怎么办？
- 帮我开始计时 3 分钟
- 下一步

### 5.2 桌面端

桌面端建议放在 `recipe-cook-side-panel` 内，作为一个可折叠的助手卡片。

原则：

- 不抢占当前步骤主区域。
- 不影响计时器和食材清单。
- 页面动作执行后，在助手消息里显示一条简短反馈。

## 6. 做菜上下文协议

前端每次发送消息时，构造一个当前页面快照，放入 `subject.extra`。

建议字段：

```ts
type CookingAssistantSubject = {
  source: 'recipe_cook_page';
  recipe_id: string;
  extra: {
    surface: 'recipe_cook_page';
    cookSessionId: string;
    sessionRevision: number;
    recipeTitle: string;
    servings: number;
    currentStepIndex: number;
    currentStep: CookingStepSnapshot | null;
    previousStep: CookingStepSnapshot | null;
    nextStep: CookingStepSnapshot | null;
    totalSteps: number;
    checkedIngredientIds: string[];
    ingredients: CookingIngredientSnapshot[];
    shortages: CookingShortageSnapshot[];
    timers: CookingTimerSnapshot[];
    activeTimerId: string | null;
    activeMobileTab?: 'step' | 'ingredients';
  };
};
```

示例：

```json
{
  "source": "recipe_cook_page",
  "recipe_id": "recipe_123",
  "extra": {
    "surface": "recipe_cook_page",
    "cookSessionId": "cook_session_recipe_123",
    "sessionRevision": 8,
    "recipeTitle": "番茄炒蛋",
    "servings": 2,
    "currentStepIndex": 1,
    "currentStep": {
      "title": "炒鸡蛋",
      "text": "热锅下油，倒入蛋液，凝固后盛出。",
      "estimatedMinutes": 3,
      "tip": "不要炒太老"
    },
    "nextStep": {
      "title": "炒番茄",
      "text": "下番茄炒出汁。"
    },
    "totalSteps": 4,
    "checkedIngredientIds": ["recipe_ingredient_egg"],
    "shortages": [],
    "timers": [
      {
        "id": "timer-main",
        "name": "当前步骤",
        "mode": "countdown",
        "durationSeconds": 180,
        "seconds": 42,
        "running": true
      }
    ],
    "activeTimerId": "timer-main"
  }
}
```

注意：

- `subject.recipe_id` 会被后端按家庭校验。
- `subject.extra` 是页面现场快照，不是可信业务事实。
- 涉及真实库存、菜谱详情和计划项时，后端 Skill 仍应通过 tool 读取和校验。
- 前端不应把完整大对象全部塞入 subject，只传当前问答需要的摘要。

## 7. Orchestrator Profile 机制

### 7.1 设计目标

做菜助手需要：

- 一开始就注入 `cooking_assistant` Skill。
- 有做菜页面专属提示词。
- 回复更短、更口语化。
- 能返回页面动作 proposal。
- 不要另写一个 Orchestrator。

因此建议新增通用 profile 层，而不是增加 `CookingOrchestratorAgent`。

### 7.2 Profile 数据结构

新增文件建议：

```text
backend/app/ai/workflows/orchestrator_profiles.py
```

示意：

```python
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class OrchestratorProfile:
    key: str
    initial_skill_keys: list[str] = field(default_factory=list)
    system_prompt_addon: str = ""
    response_style: str = ""
    allowed_surface: str | None = None

    def to_state(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "initialSkillKeys": list(self.initial_skill_keys),
            "systemPromptAddon": self.system_prompt_addon,
            "responseStyle": self.response_style,
            "allowedSurface": self.allowed_surface,
        }
```

默认 profile：

```python
DEFAULT_ORCHESTRATOR_PROFILE = OrchestratorProfile(key="default")
```

做菜 profile：

```python
COOKING_ASSISTANT_PROFILE = OrchestratorProfile(
    key="recipe_cook_page",
    initial_skill_keys=["cooking_assistant"],
    allowed_surface="recipe_cook_page",
    response_style="short_spoken",
    system_prompt_addon="""
你嵌入在 Culina 做菜页面中。
优先围绕当前菜谱、当前步骤、食材准备、缺料和计时器回答。
回答要短、口语化、像厨房里直接提醒，不要长篇科普。
如果用户要求操作页面，只能调用 ui.propose_actions 返回页面动作建议。
不能声称已经完成页面操作；动作是否执行由前端根据白名单和当前会话状态决定。
正式扣库存、完成计划、记录餐食必须走 recipe_cook 草稿审批，不属于页面动作。
"""
)
```

Resolver：

```python
def resolve_orchestrator_profile(
    *,
    quick_task: str | None,
    subject: dict[str, Any] | None,
) -> OrchestratorProfile:
    source = str((subject or {}).get("source") or "")
    extra = (subject or {}).get("extra") if isinstance((subject or {}).get("extra"), dict) else {}
    surface = str(extra.get("surface") or "")
    if quick_task == "cooking_assistant" or source == "recipe_cook_page" or surface == "recipe_cook_page":
        return COOKING_ASSISTANT_PROFILE
    return DEFAULT_ORCHESTRATOR_PROFILE
```

### 7.3 Runner 接入点

当前 `WorkspaceGraphRunner` 初始化 graph state 时写死：

```python
"injected_skill_keys": [],
```

一阶段改为：

```python
profile = resolve_orchestrator_profile(
    quick_task=quick_task,
    subject=prepared["subject"],
)

"injected_skill_keys": profile.initial_skill_keys,
"orchestrator_profile": profile.to_state(),
```

同步修改两个入口：

- 非流式 `invoke`。
- 流式 `stream`。

`WorkspaceGraphState` 增加：

```python
orchestrator_profile: dict[str, Any]
```

`SkillContext` 增加：

```python
orchestrator_profile: dict[str, Any] = field(default_factory=dict)
```

`WorkspaceOrchestratorAgent._system_prompt()` 增加 profile addon：

```python
profile_addon = str(context.orchestrator_profile.get("systemPromptAddon") or "")
...
base_prompt + "\n\nSurface profile instructions:\n" + profile_addon
```

为了避免 `_system_prompt(active_skill_keys)` 参数越来越多，可以改为：

```python
def _system_prompt(self, context: SkillContext, active_skill_keys: list[str]) -> str:
    ...
```

### 7.4 为什么这是通用优化

这个机制不只服务做菜页面。后续可以复用到：

- 食材详情页助手。
- 菜谱编辑助手。
- 库存处理助手。
- 家庭菜单页助手。

每个页面只需要定义 profile：

- 初始 Skill。
- 页面专属提示词。
- 页面动作 surface。
- 回复风格。

Orchestrator、LangGraph、ToolExecutor、审批和 SSE 都保持一套。

## 8. `cooking_assistant` Skill

### 8.1 新增目录

```text
backend/app/ai/skills/catalog/cooking-assistant/
  SKILL.md
  skill.yaml
```

### 8.2 `skill.yaml`

建议：

```yaml
version: 2
key: cooking_assistant
display_name: 做菜助手
intent: cooking_assistant
agent_key: cooking_assistant_agent
context_policy:
  - recipes
  - inventory
allowed_tools:
  - recipe.read_by_id
  - inventory.read_available_items
  - ui.propose_actions
script_files: []
output_types:
  - ui_actions
draft_types: []
approval_policy: none
examples:
  - 这一步做到什么程度？
  - 帮我进入下一步。
  - 这个计时器暂停一下。
  - 没有葱可以不放吗？
  - 焖煮帮我计时 3 分钟。
```

### 8.3 `SKILL.md` 要点

Skill 指令应强调：

- 当前助手嵌入在做菜页面。
- `subject.extra` 是当前页面快照，优先用来理解用户说的“这一步”“当前计时器”“这个食材”。
- 如果要核对真实菜谱详情，调用 `recipe.read_by_id`。
- 如果要核对真实库存，调用 `inventory.read_available_items`。
- 普通烹饪解释直接用文本回答。
- 页面动作必须通过 `ui.propose_actions`，不要输出 JSON 让前端猜。
- 不处理正式业务写入。
- 用户要求“扣库存、完成计划、记录餐食”时，说明需要走完成烹饪确认，不要自己生成写入结果。
- 对食品安全问题给保守提醒，例如明显变质、异味、未熟风险，建议不要食用或继续加热到安全状态；不要做医疗承诺。

### 8.4 与 `recipe_cook` 的边界

`cooking_assistant`：

- 问答。
- 步骤解释。
- 食材替代建议。
- 当前页面动作建议。
- 只读工具。
- `approval_policy: none`。

`recipe_cook`：

- 按已有菜谱实际做一次。
- 预览库存扣减。
- 生成 `recipe_cook` 草稿。
- 等待用户确认。
- 确认后由 service 正式扣库存、完成计划、写做菜日志或餐食记录。

不要把普通烹饪问答塞进 `recipe_cook`，否则容易误触发做菜草稿和审批。

## 9. 页面动作协议

### 9.1 设计原则

模型不能直接改 React state。模型只能提出结构化动作 proposal，前端校验后执行。

动作 proposal 必须包含：

- surface。
- recipeId。
- cookSessionId。
- sessionRevision。
- actions。
- 用户可见说明。

### 9.2 Tool 名称

建议使用通用 tool：

```text
ui.propose_actions
```

第一阶段只支持：

```text
surface = recipe_cook_page
```

这样以后其他页面也能复用同一个 tool，增加 surface schema 即可。

### 9.3 Tool 输入

```json
{
  "surface": "recipe_cook_page",
  "recipeId": "recipe_123",
  "cookSessionId": "cook_session_recipe_123",
  "sessionRevision": 8,
  "actions": [
    {
      "type": "go_next_step"
    }
  ]
}
```

### 9.4 Tool 输出

```json
{
  "card": {
    "type": "ui_actions",
    "data": {
      "surface": "recipe_cook_page",
      "recipeId": "recipe_123",
      "cookSessionId": "cook_session_recipe_123",
      "sessionRevision": 8,
      "actions": [
        {
          "type": "go_next_step"
        }
      ],
      "requiresConfirmation": false
    }
  }
}
```

Tool 本身不执行动作，只做 schema 校验和返回 card。用户可见语言由 agent loop 在工具调用前后输出，`ui_actions` 不承载话术字段。

### 9.5 一阶段动作白名单

低风险动作，可自动执行：

```ts
type CookPageAction =
  | { type: 'go_next_step' }
  | { type: 'go_previous_step' }
  | { type: 'jump_to_step'; stepIndex: number }
  | { type: 'switch_tab'; tab: 'step' | 'ingredients' }
  | { type: 'start_timer'; timerId?: string }
  | { type: 'pause_timer'; timerId?: string }
  | { type: 'reset_timer'; timerId?: string }
  | { type: 'add_timer_seconds'; timerId?: string; seconds: number }
  | { type: 'set_timer'; timerId?: string; seconds: number; name?: string };
```

需要确认或一阶段暂不执行：

```ts
type CookPageHighRiskAction =
  | { type: 'reset_cook_session' }
  | { type: 'delete_timer'; timerId: string }
  | { type: 'finish_cooking' }
  | { type: 'open_shopping_dialog' };
```

一阶段建议：

- `open_shopping_dialog` 可以只打开采购弹窗，不自动创建采购项。
- `finish_cooking` 不自动执行正式写入；确认后只打开页面现有“完成烹饪”确认弹窗。
- `reset_cook_session` 和 `delete_timer` 必须二次确认。

### 9.6 前端执行校验

执行前必须校验：

- `surface === 'recipe_cook_page'`。
- `recipeId === activeCookCard.recipe.id`。
- `cookSessionId` 与当前会话一致。
- `sessionRevision` 未过期，或允许在轻微过期时只展示“状态已变化，请再说一遍”。
- action type 在白名单中。
- `stepIndex` 在范围内。
- `seconds` 在合理范围内，例如 1 到 6 小时。
- `timerId` 存在；如果缺省，默认当前 active timer。
- 当前页面仍处于 cook mode。

执行结果要给用户明确反馈：

- 成功：`已进入下一步。`
- 失败：`刚才页面状态变了，我没有执行。你可以再说一次。`
- 需要确认：展示确认按钮。

## 10. 前端落点

### 10.1 文件建议

新增：

```text
frontend/src/components/recipes/CookingAssistantPanel.tsx
frontend/src/components/recipes/useCookingAssistantState.ts
frontend/src/components/recipes/useCookingAssistantStream.ts
frontend/src/components/recipes/cookingAssistantModel.ts
frontend/src/components/recipes/cookingAssistantModel.test.ts
```

修改：

```text
frontend/src/components/recipes/RecipeCookView.tsx
frontend/src/components/recipes/useRecipeCookState.ts
frontend/src/components/recipes/RecipeWorkspaceModel.ts
frontend/src/api/types.ts
frontend/src/styles/03-recipe-workspace.css
frontend/src/styles/07-mobile.css
```

如需复用 AI message 渲染，可从 `frontend/src/components/ai/` 抽轻量组件，但不要把 `AiWorkspace` 整体嵌进做菜页。

### 10.2 Hook 职责

`useCookingAssistantState`：

- 控制助手面板展开/收起。
- 管理输入 draft。
- 维护待确认页面动作。
- 维护动作确认后的本地反馈。

`useCookingAssistantStream`：

- 调用 `aiApi.streamChatAi`。
- 维护当前嵌入式 conversation id。
- 维护本页面助手消息列表。
- 维护发送中、进度提示、取消状态。
- 处理 `message_delta`。
- 处理 `message_part` 中的 `ui_actions`。
- 暴露 cancel。

`cookingAssistantModel.ts`：

- 构造 `subject` 快照。
- 生成 `cookSessionId`。
- 维护 `sessionRevision`。
- 校验 UI action。
- 把 UI action 映射成前端 handler 参数。

### 10.3 与 `RecipeCookView` 的连接

`RecipeCookViewProps` 需要增加页面动作 handler 或直接传现有 handler：

- `jumpToCookStep`
- `moveCookStep`
- `completeCurrentCookStepAndContinue`
- `selectTimer`
- `toggleTimerById`
- `resetCookTimer`
- `addCookTimerSeconds`
- `startTimerById`
- `pauseTimerById`
- `resetTimerById`
- `addTimerSecondsById`
- `setTimerById`
- `addTimer`
- `openCookFinishDialog`
- `openShoppingDialog`

如果 `activeMobileTab` 要被 AI 切换，需要把它从 `RecipeCookView` 内部局部 state 下沉到 `useRecipeCookState`，或给 `CookingAssistantPanel` 一个 `setActiveMobileTab` 回调。

### 10.4 页面命令统一走 AI

为了保证“页面操作也是 AI 助手能力”的语义一致，一阶段不在前端做自然语言关键词命令分支。

- 用户输入“下一步”“上一步”“暂停计时”“开始计时”“加30秒”等命令时，仍通过 `quick_task=cooking_assistant` 发送给后端。
- `cooking_assistant` Skill 根据当前 `subject.extra` 决定是否调用 `ui.propose_actions`。
- 前端只负责校验并执行 AI 返回的 `ui_actions`，不根据用户原文自行推断意图。

这样后续接入语音和实时对话时，文字、语音和工具调用都复用同一条 Orchestrator + Skill + Tool 链路。

## 11. 后端落点

新增：

```text
backend/app/ai/workflows/orchestrator_profiles.py
backend/app/ai/skills/catalog/cooking-assistant/SKILL.md
backend/app/ai/skills/catalog/cooking-assistant/skill.yaml
backend/app/ai/tools/catalog/ui.py
backend/tests/ai_infra/test_orchestrator_profiles.py
backend/tests/ai_infra/test_cooking_assistant_skill.py
```

修改：

```text
backend/app/ai/workflows/state.py
backend/app/ai/workflows/runner.py
backend/app/ai/workflows/orchestrator.py
backend/app/ai/skills/loader.py    # 如 loader 已自动扫描 catalog，可无需修改
backend/app/ai/tools/catalog/__init__.py
backend/app/ai/tools/registry.py
backend/app/ai/tools/schemas.py    # 如果统一放 schema，或需要同步导出工具 schema
backend/app/schemas/ai.py          # 增加 ui_actions result card DTO 时需要
backend/app/services/serializers.py # 只有 result card 统一走 serializer 时才需要
frontend/src/api/types.ts
frontend/src/lib/aiWorkspaceContracts.ts
frontend/src/lib/aiWorkspaceContracts.test.ts
```

### 11.1 `ui.propose_actions` Tool

注册到 tool registry：

```python
register_tool(
    registry,
    name="ui.propose_actions",
    display_name="页面操作建议",
    description="返回可由前端校验并执行的页面动作建议；不写入业务数据。",
    side_effect="control",
    handler=ui_propose_actions,
    input_schema=UI_ACTIONS_INPUT_SCHEMA,
    output_schema=UI_ACTIONS_OUTPUT_SCHEMA,
)
```

`side_effect` 建议为 `control`，因为它不读写数据库，只控制 agent 和前端交互。

### 11.2 Result card 类型

新增 result card：

```text
ui_actions
```

后端 DTO、前端类型、contract test 都要同步。

如果不想扩大 `AIResultCardType`，也可以使用 `message_part` 的新类型 `ui_actions`。但一阶段更建议复用 result card 机制，因为现有前端已经有 result card part 的渲染和流式合并经验。

## 12. 响应速度策略

一阶段的速度来自四层：

1. Profile 预注入 `cooking_assistant`，省掉模型第一轮 `skill.inject`。
2. 页面把当前步骤和计时器快照直接放进 `subject.extra`，普通问题不用再读数据库。
3. 前端对高频明确页面命令做本地快速执行。
4. SSE 继续使用 `message_delta` 流式展示，先出短回答，再展示工具动作。

需要避免：

- 每个问题都强制 `recipe.read_by_id`。
- 每个问题都读取完整库存。
- 回复过长。
- 在做菜页面加载完整 AI 历史侧栏。

## 13. 安全边界

1. 页面动作只影响前端做菜会话 state，不直接写业务表。
2. 模型不能直接扣库存、完成计划、写餐食记录。
3. 正式写入仍必须走 `recipe_cook` draft approval。
4. `subject.extra` 不可信，后端不能基于它执行业务写入。
5. `ui.propose_actions` 只返回 action proposal，不执行 action。
6. 前端执行 action 前必须校验 recipe、session、revision 和参数范围。
7. 高风险动作必须二次确认。
8. 食品安全类回答要保守，不做医疗或营养诊断承诺。

## 14. 测试计划

### 14.1 后端测试

新增或覆盖：

- `resolve_orchestrator_profile()` 能按 `quick_task=cooking_assistant` 返回做菜 profile。
- `subject.source=recipe_cook_page` 能返回做菜 profile。
- 默认 AI 工作台请求仍返回 default profile。
- Graph 初始 state 能带入 `cooking_assistant`。
- Orchestrator system prompt 包含 profile addon。
- `cooking_assistant` Skill 注册成功。
- `cooking_assistant` 不允许 draft tool。
- `ui.propose_actions` 只接受合法 surface 和 action。
- `ui.propose_actions` 不写数据库。
- 非做菜 surface 的 action 被拒绝或暂不支持。

建议命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_orchestrator_profiles.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_cooking_assistant_skill.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_registry_and_metrics.py -q
```

风险较高时补：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
```

### 14.2 前端测试

新增或覆盖：

- `buildCookingAssistantSubject()` 正确生成当前步骤、前后步骤、计时器和缺料摘要。
- `validateCookingUiActions()` 拒绝跨 recipe、过期 revision、非法 stepIndex、非法 seconds。
- 低风险动作能调用正确 handler。
- 高风险动作不会直接执行。
- 面板发送消息时带 `quick_task=cooking_assistant` 和 `subject.source=recipe_cook_page`。
- 流式 delta 能更新助手消息。
- `ui_actions` result card 能触发动作执行或确认 UI。

建议命令：

```bash
npm --prefix frontend run test -- CookingAssistant
npm --prefix frontend run test -- RecipeCook
npm --prefix frontend run build
```

如涉及移动端布局或底部抽屉：

```bash
npm --prefix frontend run smoke
```

## 15. 分阶段实施任务

### Phase 1A：后端 profile 和 Skill 基础

1. 新增 `orchestrator_profiles.py`。
2. Runner 初始化 state 时接入 profile。
3. `WorkspaceGraphState` 和 `SkillContext` 增加 profile 字段。
4. Orchestrator system prompt 拼接 profile addon。
5. 新增 `cooking_assistant` Skill。
6. 新增 registry 测试和 profile 测试。

验收：

- `quick_task=cooking_assistant` 时初始已注入 `cooking_assistant`。
- 默认 AI 工作台行为不变。

### Phase 1B：UI action proposal 协议

1. 新增 `ui.propose_actions` tool。
2. 新增 `ui_actions` result card 类型。
3. 后端 DTO、serializer、前端 API 类型同步。
4. 增加 tool schema 测试和 contract 测试。

验收：

- AI 可以返回页面动作 proposal。
- proposal 不产生数据库写入。
- 非法 action 被 schema 或 handler 拒绝。

### Phase 1C：做菜页嵌入式助手 UI

1. 新增 `CookingAssistantPanel`。
2. 新增 `useCookingAssistantState` 和 `useCookingAssistantStream`。
3. 新增 `cookingAssistantModel`。
4. 接入 `RecipeCookView`。
5. 移动端底部抽屉和桌面侧栏卡片样式。
6. 增加前端单测。

验收：

- 做菜页能打开助手。
- 能发送文字问题。
- 回复流式出现。
- 当前步骤、食材和计时器上下文随请求发送。

### Phase 1D：页面动作执行

1. 实现低风险 action 白名单。
2. 实现 session revision 校验。
3. 实现动作成功、失败、需确认的反馈。
4. 增加 action model 单测。

验收：

- “下一步”能进入下一步。
- “暂停计时”能暂停当前计时器。
- “焖 3 分钟”能设置或新增计时器。
- 状态过期时不执行。
- 高风险动作不自动执行。

## 16. 风险与取舍

### 16.1 AI 误操作页面

风险：模型误解用户意图，触发错误动作。

控制：

- 前端 action 白名单。
- session revision 校验。
- 高风险动作确认。
- 对含糊请求优先追问或只回答。

### 16.2 上下文过大

风险：每次发送完整菜谱导致 token 增长，响应变慢。

控制：

- 只传当前步骤、前后步骤、食材摘要、计时器摘要。
- 完整菜谱由 `recipe.read_by_id` 按需读取。
- 助手 prompt 要求短回答。

### 16.3 与 `recipe_cook` 职责混淆

风险：普通问答误触发库存扣减草稿。

控制：

- `cooking_assistant` 不开放 `recipe.create_cook_draft`。
- 扣库存、完成计划、记录餐食必须提示走完成烹饪确认。
- `recipe_cook` 继续只负责真实做菜执行审批。

### 16.4 Orchestrator profile 侵入主路径

风险：为做菜助手改动通用 Orchestrator，影响 AI 工作台。

控制：

- profile 默认为空，不改变默认行为。
- profile 只改变 initial skills 和 prompt addon。
- 测试覆盖 default profile。
- 不新增第二个 Orchestrator。

## 17. 后续演进

一阶段稳定后，再考虑：

- 语音输入：STT 后仍走同一个 `quick_task + subject`。
- 语音输出：对 assistant 短句做 TTS。
- 实时对话：复用 `cooking_assistant` Skill 和 UI action 协议，只替换输入输出通道。
- 图片辅助：复用现有 AI attachments、media 归属校验和 provider vision 输入。
- 更多页面助手：复用 Orchestrator profile 和 `ui.propose_actions` surface。

## 18. 推荐验收清单

- 做菜页助手不会影响原有做菜流程。
- 默认 AI 工作台行为不变。
- 做菜助手首轮无需 `skill.inject` 即可获得做菜助手能力。
- 用户能问当前步骤相关问题。
- 用户能让 AI 执行低风险页面动作。
- 页面动作不会跨菜谱、跨会话或在过期状态下执行。
- AI 不能直接写正式业务数据。
- 移动端不遮挡关键步骤、计时器和完成按钮。
- 流式回复在网络正常时有明显即时反馈。

## 19. 当前落地验证记录

已执行并通过：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_orchestrator_profiles.py backend/tests/ai_infra/test_cooking_assistant_skill.py backend/tests/ai_infra/test_skill_loader.py backend/tests/ai_infra/test_registry_and_metrics.py -q
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

验证结果：

- 后端 targeted AI infra：`24 passed, 15 subtests passed`。
- 前端 Vitest：`48 passed, 327 tests passed`。
- 前端 build 通过；bundle budget 检查存在既有 warning，但命令通过。
- smoke 通过登录、桌面工作区 tab、`390x844`、`768x1024`、`1112x834`、`1180x820` 响应式检查。
