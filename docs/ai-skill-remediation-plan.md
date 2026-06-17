# AI Skill 基础业务操作覆盖整改报告

更新时间：2026-06-16

状态：已完成

配套交付：

- 详细整改报告：`docs/ai-skill-remediation-report.md`
- Skill 手动测试说明：`docs/ai-skill-manual-test-guide.md`

当前快照：

- 已完成：`ingredient_profile`、`recipe_cook`、餐食计划/购物清单操作草稿、更新并发校验、后端领域执行器拆分、审批成功结果卡片、桌面/移动端欢迎建议统一。
- 已完成：草稿归一化、确认阶段操作结构校验和草稿摘要已从 `workspace_service.py` 下沉到 `backend/app/services/ai_operations/drafts.py`，`workspace_service.py` 继续收敛为审批事务编排层。
- 已完成：审批配置、审批类型/按钮文案推导已从 `workspace_service.py` 下沉到 `backend/app/services/ai_operations/approval_config.py`。
- 已完成：`AITaskDraft` / `AIApprovalRequest` 创建和重试审批对象构造已下沉到 `backend/app/services/ai_operations/approval_requests.py`。
- 已完成：审批决策事务编排、正式写入、失败重试审批、结果卡和 artifact 持久化已下沉到 `backend/app/services/ai_operations/approval_decisions.py`，`workspace_service.py` 仅保留兼容入口委托。
- 已完成：审批表单值校验、字段类型校验和确认阶段草稿 shape 校验已下沉到 `backend/app/services/ai_operations/approval_values.py`。
- 已完成：审批失败摘要、失败项定位和恢复提示已下沉到 `backend/app/services/ai_operations/recovery.py`，与当前业务值读取逻辑归并。
- 已完成：审批消息 part 同步、审批结果卡片追加和 confirmed artifact 持久化已下沉到 `backend/app/services/ai_operations/messages.py`，`workspace_service.py` 保留兼容薄包装。
- 已完成：推荐卡选择回写、库存结果卡快捷生成草稿等体验交互已下沉到 `backend/app/services/ai_operations/experience.py`，避免继续扩大 `workspace_service.py` 的卡片状态处理职责。
- 已完成：AI 结果卡归一化已下沉到 `backend/app/ai/workflows/result_cards.py`，Planner 结果的 `agent_key` / `intent` 推导已下沉到 `backend/app/ai/workflows/plan_metadata.py`，Planner timeline 构造已下沉到 `backend/app/ai/workflows/timeline.py`，会话、subject 和幂等 run 查找已下沉到 `backend/app/ai/workflows/conversations.py`，run 取消/重试/局部重生成参数构造已下沉到 `backend/app/ai/workflows/run_lifecycle.py`，`workspace_service.py` 继续收敛为对外兼容 facade。
- 已完成：跨 Skill 的 confirmed business artifact 基础链路，确认后的正式实体可继续供后续 Skill 使用。
- 已完成：run 级 routing / skill / clarification / approval 基础统计已写入 `AIAgentRun.context_summary`，并新增 `GET /api/ai/quality-metrics` 家庭维度只读聚合接口；前端改为点击桌面 AI 状态胶囊后打开隐藏诊断弹窗，可输出/展示状态、意图、路由 Skill、澄清原因、审批结果和 Skill 诊断分布。
- 已完成：Tool JSON schema 已与 operation draft 运行时能力对齐，`meal_plan` 支持 `set_status`、`shopping_list` 支持 `set_done`，`recipe.create_draft` 可接收菜谱新增草稿和菜谱操作草稿两种输入形态。
- 已完成：`composite_operation.v1` 已接入正式审批合同，能校验步骤结构、领域白名单、依赖图无环、生成拓扑执行顺序，并解析 `$step.entityId` 形式的声明依赖引用；已补后端执行器、正式审批 DTO / 草稿归一化 / 前端分步预览，正式执行走统一领域 executor，覆盖食材、库存、食物、菜谱、做菜、餐食计划、购物清单和餐食记录等已接入基础业务域；已验证“食材 -> 库存”和“食物 -> 餐食计划”的依赖解析、同事务执行和失败回滚。
- 已完成决策：`composite_operation.v1` 当前不开放给 Skill 或自然语言直接生成；先作为后端正式审批合同和未来受控 tool 入口保留，避免模型在缺少专用组合 draft tool、提示约束和回滚体验设计时生成任意复合写入。
- 下面各章节保留了整改背景、问题分析和目标设计，阅读时以上述状态为准。

## 1. 文档目的

本文档针对 Culina 当前 AI Workspace 的 Skill、Tool、Draft、Approval 和正式业务写入能力进行整改设计。

整改目标不是把 AI 变成拥有无限写权限的通用代理，而是在继续遵守 `draft -> approval -> commit` 安全边界的前提下，让用户可以通过自然语言快速完成菜谱、食材、库存、食物、餐食计划、购物清单和餐食记录的基础操作。

本文档重点回答以下问题：

1. 当前 AI Skill 实际覆盖了哪些业务操作。
2. 哪些能力声明与真实写入行为不一致。
3. 为覆盖基础操作需要新增或调整哪些 Skill、Tool 和 Draft。
4. 修改、删除和复合操作应如何审批和执行。
5. 如何分阶段实施，并通过测试证明整改有效。

## 2. 整改范围

本次整改覆盖以下核心业务域：

- 食材档案 `Ingredient`
- 库存批次 `InventoryItem`
- 食物资料 `Food`
- 菜谱 `Recipe`
- 餐食计划 `FoodPlanItem`
- 购物清单 `ShoppingListItem`
- 餐食记录 `MealLog`
- 菜谱烹饪与库存扣减

暂不作为本轮基础覆盖目标的能力：

- 家庭成员和权限管理
- 登录、邀请和账号设置
- 食物场景的完整 AI 管理
- 图片生成模型和媒体编辑
- 开放式营养诊断或医疗建议

## 3. 当前架构评估

### 3.1 已有基础

当前架构已经具备较好的安全和扩展基础：

- Planner 只选择 Skill，不直接执行写操作。
- Skill 只能调用 `allowed_tools` 中声明的 Tool。
- 模型不能访问 `write` Tool。
- 正式写入必须经过草稿、用户确认和 Service 提交。
- Draft Tool 会对家庭归属、真实业务 ID 和字段结构进行校验。
- LangGraph 支持多 Skill 顺序执行和审批中断。
- Tool、Draft、Approval 和正式写入都有运行记录。
- 库存入库、消耗和销毁已经形成相对完整的受控链路。

这些机制应当保留，不应为了提高操作速度而绕过审批或直接向模型开放写权限。

### 3.2 当前 Skill 清单

| Skill key | 当前职责 | 当前正式写入 |
| --- | --- | --- |
| `inventory_analysis` | 库存查询、入库、消耗、销毁 | 库存操作 |
| `ingredient_profile` | 搜索、读取、创建和更新食材档案 | 新建/更新食材 |
| `meal_plan` | 即时推荐、读取计划、创建/更新/删除/状态变更餐食计划草稿 | 餐食计划操作 |
| `shopping_list` | 独立清单、从计划派生清单、更新/完成/恢复/删除购物项 | 购物清单操作 |
| `meal_log` | 整理餐食记录、详情补充、评分 | 餐食记录操作 |
| `recipe_draft` | 创建、更新、删除和收藏菜谱 | 菜谱操作 |
| `recipe_cook` | 烹饪预览、确认扣库存、完成计划和生成餐食记录 | 菜谱烹饪操作 |
| `food_profile` | 创建、更新和收藏食物资料 | 食物资料操作 |

### 3.3 当前基础操作覆盖矩阵

| 业务对象 | 查询 | 新增 | 修改 | 删除/撤销 | 状态操作 |
| --- | --- | --- | --- | --- | --- |
| 食材档案 | `search` / `read_by_id` | 支持 | 支持 | 暂不支持 | 不适用 |
| 库存 | 支持 | 支持入库 | 不支持批次资料修改 | 支持销毁 | 支持消耗 |
| 食物资料 | `search` / `read_by_id` | 支持 | 支持 | 暂不支持 | 支持收藏 |
| 菜谱 | `search` / `read_by_id` | 支持 | 支持 | 支持删除 | 支持收藏、烹饪 |
| 餐食计划 | `read_existing` / `read_by_id`，按家庭本地日期和当前用户过滤 | 支持 | 支持 | 支持删除 | 支持完成、跳过等状态变更 |
| 购物清单 | `read_pending` / `read_by_id` | 支持 | 支持 | 支持删除 | 支持完成、恢复 |
| 餐食记录 | `read_recent` / `read_by_id` | 支持 | 支持详情补充 | 暂不支持 | 支持评分 |

当前系统已经从“查询和新增草稿助手”推进到 operation draft + approval commit 的基础操作模型；剩余重点是补齐未支持的删除/批次修改类动作、补强跨端验收矩阵，以及逐项证明第 17 节完成定义。

## 4. 历史主要问题与整改要求

本节保留整改启动时的主要问题和验收要求，作为审计背景。是否已经完成以顶部“当前快照”、第 3.3 节当前能力矩阵和第 16 节优先级状态为准。

### 4.1 Skill 声明修改，但提交端始终执行新增

`meal_plan` 和 `shopping_list` 的 Skill 文档声明支持修改已有草稿或计划，但当前 Draft Schema 没有正式业务对象 ID，审批类型也是固定的：

- `meal_plan.create`
- `shopping_list.create`

正式提交端对每个项目都创建新实体，不会更新或删除原实体。

可能产生的错误行为：

1. 用户说“把明天晚餐换成番茄炒蛋”。
2. AI 生成一份看似修改后的完整计划草稿。
3. 用户确认。
4. 系统新增一条番茄炒蛋计划，但原计划仍然存在。

这会形成重复计划，并且用户看到的“修改”语义与真实结果不一致。

整改要求：

- 在整改完成前，不应继续把正式业务数据更新描述为“修改”。
- 修改类草稿必须引用正式业务对象 ID。
- 提交端必须根据 `action` 执行 `create`、`update`、`delete` 或状态变更。
- 测试必须同时断言旧实体被更新或删除，不能只断言产生了新草稿。

### 4.2 缺少食材档案 Skill

库存操作要求引用当前家庭已有 `Ingredient`。当用户请求：

> 新增鸡胸肉食材，默认冷冻保存，再入库 500 克。

当前 AI 只能发现鸡胸肉不存在，然后要求用户先去其他页面建立食材档案。

这破坏了 AI 快速操作的核心目标，也阻断了以下常见链路：

- 新食材 -> 入库
- 菜谱缺失食材 -> 创建食材档案
- 购物项 -> 匹配或创建食材 -> 入库
- 识别图片或自然语言 -> 建立食材档案

整改要求：

- 新增 `ingredient_profile` Skill。
- 支持食材查询、创建和更新。
- 创建后能够把确认结果作为 artifact 传给库存 Skill。
- 已有库存时修改主单位必须遵守现有业务限制。

### 4.3 Search Tool 实际只是有限列表读取

当前 `food.search`、`ingredient.search` 和 `recipe.search` 主要只接受 `limit`，并不接受真正的搜索条件。

风险：

- 超过默认数量的实体无法被模型发现。
- 同名或近似名称匹配不稳定。
- 页面已经提供 `subject` ID 时，Skill 仍可能依赖列表遍历。
- AI 可能错误地提示“资料不存在”。
- 修改和删除操作无法可靠定位唯一目标。

整改要求：

- 所有业务实体提供统一搜索输入。
- 对确定目标提供 `read_by_id`，不要依赖模糊搜索。
- 搜索结果必须返回足够的消歧字段。
- 对同名结果不得自动选择，必须要求用户确认目标。

建议统一搜索输入：

```json
{
  "query": "番茄",
  "ids": [],
  "exact": false,
  "category": null,
  "limit": 20,
  "offset": 0
}
```

### 4.4 餐食计划读取的时区和数据范围不一致

AI 的计划读取使用服务器日期，并按 `family_id` 查询。正式业务 API 则按当前用户读取计划。

可能产生的问题：

- 家庭时区跨日时，AI 看到的“今天”与页面不一致。
- AI 可能读取到其他家庭成员的个人计划。
- 修改操作可能定位到错误成员的计划项。

整改要求：

- 使用 `today_for_family()`。
- 明确 `FoodPlanItem` 是个人计划还是家庭共享计划。
- 如果保持个人计划，Tool 必须同时约束 `family_id` 和当前 `user_id`。
- 如需家庭共享计划，应先修改业务模型和权限定义，而不是仅放宽 AI 查询。

### 4.5 修改和删除缺少并发保护

当前草稿版本只保护 AI Draft 自身，没有保护正式业务实体。

场景：

1. AI 读取了某条购物项。
2. 另一位家庭成员修改了这条购物项。
3. 原用户确认旧草稿。
4. AI 提交覆盖了新值。

整改要求：

- 修改和删除草稿必须携带 `baseUpdatedAt` 或业务版本号。
- 提交时重新锁定并校验目标实体。
- 如果版本不一致，操作失败并生成新的重试审批。
- 冲突提示需要显示当前值与草稿值。

### 4.6 草稿类型只表达业务域，没有表达操作语义

例如 `meal_plan` 草稿只能表达一组计划项，不能区分：

- 新增计划
- 更新某条计划
- 删除某条计划
- 标记完成
- 标记跳过

整改要求：

- 业务草稿升级为操作草稿。
- 每个操作必须显式声明 `action`。
- 操作目标和提交行为由后端决定，不能依赖模型文本推断。

## 5. 目标能力模型

### 5.1 统一原则

每个业务域应具备以下能力层次：

1. `search`：按名称和条件查找候选实体。
2. `read_by_id`：读取确定实体的完整上下文。
3. `create_operation_draft`：生成新增操作草稿。
4. `update_operation_draft`：生成修改操作草稿。
5. `delete_operation_draft`：生成删除操作草稿。
6. `status_operation_draft`：生成收藏、完成、跳过等状态操作草稿。
7. approval commit：用户确认后调用业务 Service 正式执行。

可以根据业务复杂度把多个 Draft Tool 合并为一个领域操作 Draft Tool，但 Draft 内必须有明确的 `action`。

### 5.2 推荐操作草稿结构

```json
{
  "draftType": "meal_plan_operation",
  "schemaVersion": "meal_plan_operation.v1",
  "operations": [
    {
      "action": "update",
      "targetId": "food-plan-123",
      "baseUpdatedAt": "2026-06-14T08:30:00Z",
      "before": {
        "date": "2026-06-15",
        "mealType": "dinner",
        "foodId": "food-chicken"
      },
      "payload": {
        "date": "2026-06-15",
        "mealType": "dinner",
        "foodId": "food-tomato-egg",
        "note": "按用户要求改为清淡晚餐"
      }
    }
  ]
}
```

字段约束：

- `action`：必须是该业务域允许的固定枚举。
- `targetId`：更新、删除和状态操作必填。
- `baseUpdatedAt`：更新、删除和状态操作必填。
- `before`：后端根据真实实体补齐，模型不能伪造。
- `payload`：只允许该操作可修改的字段。
- `reason`：高风险删除、销毁或批量修改时必填。
- `source`：记录来源 Skill、上游 artifact 和用户请求。

### 5.3 审批语义

审批类型不能再全部固定为 `*.create`，建议使用：

- `ingredient.create`
- `ingredient.update`
- `food.create`
- `food.update`
- `food.favorite`
- `recipe.create`
- `recipe.update`
- `recipe.delete`
- `recipe.cook`
- `meal_plan.apply`
- `shopping_list.apply`
- `meal_log.create`
- `meal_log.update`
- `inventory.operation`

批量混合操作可以统一使用 `*.apply`，但审批面板必须逐项展示真实动作。

## 6. Skill 目录整改

### 6.1 新增 `ingredient_profile`

建议目录：

```text
backend/app/ai/skills/catalog/ingredient-profile/
  SKILL.md
  workflows.md
```

建议 Manifest：

```yaml
name: ingredient-profile
key: ingredient_profile
display_name: 食材档案
description: 查询、创建和修改家庭食材档案；不处理库存数量变化。
allowed_tools:
  - ingredient.search
  - ingredient.read_by_id
  - ingredient.create_operation_draft
context_policy:
  - ingredients
output_types:
  - ingredient_summary
draft_types:
  - ingredient_operation
approval_policy: draft_then_confirm
intent: ingredient_profile
agent_key: ingredient_profile_agent
```

需要支持：

- “新增鸡胸肉食材，默认单位克，冷冻保存。”
- “把番茄默认保质期改成 7 天。”
- “查询鸡蛋支持哪些单位。”
- “把土豆的别名统一为马铃薯。”此类请求必须先确认真实目标和产品是否允许改名。

后端校验：

- 创建时检查当前家庭同名食材。
- 更新时校验 `targetId` 和 `baseUpdatedAt`。
- 已有库存时不允许修改主单位，沿用现有业务规则。
- 单位换算继续复用 `ingredient_units` Service。
- 媒体 ID 必须属于当前家庭。

### 6.2 整改 `inventory_analysis`

保留当前 Skill key，避免稳定协议变化。

需要补充：

- 按食材名称或 ID 查询库存。
- 按存储位置、状态、到期范围筛选。
- 读取指定库存批次。
- 从 `ingredient_operation` 确认结果继续执行入库。
- 批量消耗和批量销毁继续使用现有草稿机制。

暂不建议开放：

- 直接覆盖库存总量。
- 直接修改 `consumed_quantity` 或 `disposed_quantity`。
- 删除历史库存批次。

库存数量应继续通过入库、消耗和销毁流水变化，避免破坏审计语义。

建议新增 Tool：

```text
inventory.search_items
inventory.read_item_by_id
```

`inventory.read_available_items`、`read_expiring_items` 等场景 Tool 可以保留，供结果卡片快速读取。

### 6.3 整改 `food_profile`

保留当前 Skill key。

需要增加：

- `food.read_by_id`
- 食物资料更新操作
- 收藏和取消收藏操作
- 精确搜索和同名消歧

建议 Draft：

```text
food_profile_operation.v1
```

允许动作：

```text
create
update
set_favorite
```

不建议在没有业务 API 的情况下增加删除。若产品确定需要删除食物，必须先设计：

- 已有关联餐食记录如何处理。
- 已有餐食计划如何处理。
- 自做菜与菜谱同步关系如何处理。
- 是否允许软删除。

菜谱同步产生的 `selfMade` 食物只能更新现有 API 允许的资料字段，不能解除 `recipe_id` 关系。

### 6.4 整改 `recipe_draft`

短期保留 `recipe_draft` key，避免前后端稳定协议大范围迁移；显示名称可调整为“菜谱管理”。

需要增加：

- `recipe.search` 真正支持查询条件。
- `recipe.read_by_id` 返回完整步骤、食材、媒体和关联食物。
- 菜谱更新操作。
- 菜谱删除操作。
- 查询菜谱可做性。
- 收藏和取消收藏。

建议 Draft：

```text
recipe_operation.v1
```

允许动作：

```text
create
update
delete
set_favorite
```

删除审批必须显示影响：

- 将删除的菜谱名称。
- 是否存在同步食物资料。
- 是否存在计划项或历史烹饪记录。
- 同步食物是否会被删除。
- 媒体绑定将如何处理。

建议把烹饪单独拆成 `recipe_cook`，避免菜谱资料编辑和多实体库存写入混在同一个 Skill。

### 6.5 新增 `recipe_cook`

职责：

- 查询菜谱可做性。
- 按人数换算需求量。
- 展示库存扣减预览。
- 展示缺失食材。
- 确认后扣减库存。
- 可选创建餐食记录。
- 可选完成关联餐食计划。

建议 Tool：

```text
recipe.read_by_id
recipe.preview_cook
recipe.create_cook_draft
inventory.read_available_items
meal_plan.read_existing
```

建议 Draft：

```text
recipe_cook_operation.v1
```

审批中必须展示：

- 菜谱和份数。
- 每种食材预计扣减量。
- 实际扣减批次。
- 缺失食材。
- 是否创建餐食记录。
- 是否完成计划项。

存在缺料时默认不允许正式烹饪提交；可以继续生成购物清单草稿。

### 6.6 整改 `meal_plan`

即时推荐模式保持不变，仍然只返回卡片，不产生审批。

正式计划模式改为操作草稿：

允许动作：

```text
create
update
delete
set_status
```

`set_status` 状态范围：

```text
planned
cooked
skipped
```

具体要求：

- `read_existing` 使用家庭本地日期。
- 查询必须限制当前用户。
- 支持日期范围和餐别过滤。
- 返回计划项 `id`、`updatedAt`、`status` 和关联食物/菜谱。
- 更新必须引用真实 `FoodPlanItem.id`。
- “完整替换计划”应转换为逐项 create/update/delete 操作，不能简单再创建一份。
- 已完成且关联餐食记录的计划项不得被普通修改覆盖。
- 删除计划必须显式审批。

建议新增确定性脚本：

```text
scripts/diff_meal_plan.py
```

输入旧计划和目标计划，输出：

- 保留项
- 新增项
- 更新项
- 删除项
- 冲突和重复日期餐别

### 6.7 整改 `shopping_list`

购物项需要从自由文本升级为可追踪业务对象。

建议优先调整业务模型或 Draft，使项目可以携带：

- `targetId`
- `ingredientId`
- `title`
- `quantity`
- `unit`
- `reason`
- `done`
- `baseUpdatedAt`

允许动作：

```text
create
update
set_done
delete
```

具体要求：

- 修改已有项目时必须引用真实购物项 ID。
- “鸡蛋买到了”应生成 `set_done`。
- “鸡蛋还没买，恢复一下”应生成 `set_done=false`。
- “把牛奶改成两盒”应生成 `update`，不能新增重复项。
- “清理已完成项目”属于批量删除，必须显示删除数量。
- 从餐食计划派生时，必须保留来源计划项和食材来源。
- 已有库存和待采购扣除必须通过确定性 Service 或 Script 完成。

当前三个固定别名不足以支撑长期归一化。建议：

- 优先通过真实 `Ingredient` 匹配规范名称。
- 固定别名表只作为辅助。
- 单位换算复用 `ingredient_units`。
- 无法换算的不同单位不得直接合并。

### 6.8 整改 `meal_log`

需要增加：

- 详细读取餐食记录。
- 按日期和餐别搜索。
- 补充参与人、备注、心情、媒体。
- 更新食物评分。
- 与计划项关联。
- 从烹饪结果创建餐食记录。

建议动作：

```text
create
update_details
rate_food
```

当前正式 API 没有删除餐食记录，整改初期不应让 Skill 宣称支持删除。

`meal_log.read_recent` 应返回：

- 餐食记录 ID
- 日期和餐别
- 食物项及食物项 ID
- 份数
- 评分
- 参与人
- 备注和心情
- 媒体摘要
- 更新时间

创建餐食记录后产生的库存扣减建议可以继续由现有业务逻辑生成，AI 不应直接假设已经完成库存扣减。

## 7. Tool 层整改

### 7.1 Tool 命名规范

建议统一：

```text
<domain>.search
<domain>.read_by_id
<domain>.create_operation_draft
```

示例：

```text
ingredient.search
ingredient.read_by_id
ingredient.create_operation_draft
recipe.search
recipe.read_by_id
recipe.create_operation_draft
meal_plan.search
meal_plan.create_operation_draft
```

旧 Tool 可以在迁移期保留，但新 Skill 应逐步切换到操作草稿。

### 7.2 查询 Tool 输入

所有搜索 Tool 至少支持：

```json
{
  "query": "",
  "ids": [],
  "exact": false,
  "limit": 20,
  "offset": 0
}
```

领域过滤器按需增加，不能把所有字段塞进通用 Schema。

### 7.3 查询 Tool 输出

查询结果应包含：

- `id`
- 用户可见名称
- 关键消歧字段
- `updatedAt`
- 必要的关联 ID
- `count`
- `hasMore`

修改和删除所需的 `updatedAt` 必须来自 Tool 真实结果。

### 7.4 Draft Tool 校验

Draft Tool 必须完成：

- 当前家庭归属校验。
- 当前用户范围校验。
- 目标实体存在性校验。
- 操作枚举校验。
- 可修改字段白名单校验。
- 单位和数量校验。
- 关联实体校验。
- `baseUpdatedAt` 格式和目标版本校验。
- 删除影响分析。
- `before` 数据补齐。

模型提供的 `before` 不可信，后端应覆盖为数据库真实值。

### 7.5 Clarification Tool

当前 Registry 已注册 `intent.request_clarification`，但 Skill Manifest 没有统一使用。

建议：

- 所有需要业务目标消歧的 Skill 允许调用该 Tool。
- Tool 输入增加候选摘要和待确认问题类型。
- Runtime 把 clarification 转换为稳定的用户可见交互，而不是只依赖模型自由文本。

典型消歧：

- 同名食材。
- 同一天同餐别存在多条计划。
- 多个相似菜谱。
- 用户没有说明操作数量。
- 删除对象存在关联数据。

## 8. Approval 和提交服务整改

### 8.1 Approval 配置重构

当前 `DRAFT_APPROVAL_CONFIG` 按草稿类型固定一个操作类型，无法表达同领域多种操作。

建议调整为：

```python
DRAFT_APPROVAL_CONFIG = {
    "meal_plan_operation": {
        "approval_type": "meal_plan.apply",
        "operation_type": "meal_plan.apply",
        "business_entity_type": "FoodPlanItem",
    },
}
```

标题、说明和按钮文案应根据 operations 动态生成：

- 只有新增：“确认添加餐食计划”
- 只有修改：“确认修改餐食计划”
- 包含删除：“确认应用餐食计划变更”
- 混合操作：“确认应用 5 项计划调整”

### 8.2 正式执行入口

建议把 `_execute_draft_operation` 拆到领域 Service：

```text
backend/app/services/ai_operations/
  ingredients.py
  foods.py
  recipes.py
  inventory.py
  meal_plans.py
  shopping.py
  meal_logs.py
```

`workspace_service.py` 只负责：

- 对外兼容入口和 API facade。
- 调用 LangGraph runner。
- 兼容旧测试和旧调用的会话、草稿创建、当前值读取等薄包装。
- 旧版菜谱草稿生成入口。

审批决策事务编排、AIOperation 记录、领域执行、失败重试审批、结果卡和 artifact 持久化已下沉到 `backend/app/services/ai_operations/approval_decisions.py`。后续如继续清理，应优先评估旧版 `generate_recipe_draft` 是否迁移到独立 kitchen workflow/service，而不是把已下沉逻辑搬回 `workspace_service.py`。

领域执行器负责：

- 锁定目标实体。
- 校验版本。
- 调用现有业务 Service。
- 维护审计字段。
- 记录活动日志。
- 返回受影响实体。

不要直接复用 FastAPI 路由函数。应抽取路由和 AI 都可复用的业务 Service。

### 8.3 批量操作事务

同一个审批中的操作必须在同一事务中执行：

- 任意一项失败则全部回滚。
- AIOperation 标记为失败。
- Draft 进入 `pending_retry`。
- 新审批显示具体失败项。

禁止出现计划改了一半、购物项只创建了一部分的状态。

### 8.4 幂等

继续保留基于审批 ID、操作类型和 Draft 版本的幂等键。

另外建议：

- 每个 operation 增加稳定 `operationId`。
- 执行器记录每项操作的目标和结果。
- 重试时不得重复执行已经在同一事务中成功提交的旧操作。

## 9. 多 Skill 复合操作整改

### 9.1 目标场景

应支持：

> 新增鸡胸肉食材，默认冷冻，再入库 500 克。

执行链：

```text
ingredient_profile
  -> ingredient_operation draft
  -> 用户确认并创建 Ingredient
  -> confirmed artifact
inventory_analysis
  -> 使用确认后的 Ingredient ID 创建入库草稿
  -> 用户确认并入库
```

第二阶段可进一步优化为一次复合审批。

### 9.2 Artifact 要求

确认后的 artifact 应包含：

- `type`
- `kind=business_entity`
- 正式业务实体 ID
- 当前版本或 `updatedAt`
- 来源 Draft ID
- 来源 Operation ID
- 可供下游 Skill 使用的标准摘要

不能让下游 Skill 继续使用 `in_run:*` 草稿 ID 作为正式业务 ID。

### 9.3 一次性复合审批

在单领域操作稳定后，再引入：

```text
composite_operation.v1
```

示例：

```json
{
  "steps": [
    {
      "stepId": "create-ingredient",
      "domain": "ingredient",
      "operation": {}
    },
    {
      "stepId": "restock",
      "domain": "inventory",
      "dependsOn": ["create-ingredient"],
      "operation": {
        "ingredientRef": "$create-ingredient.entityId"
      }
    }
  ]
}
```

复合审批必须满足：

- 依赖图无环。
- 每步都能独立校验。
- 整体事务一致。
- 前端展示每一步的影响。
- 任一步失败全部回滚。

在这些条件完成前，不应急于实现通用复合操作。

当前状态：

- 已完成 `validate_composite_operation_plan` 协议校验，覆盖 `stepId` 唯一性、支持领域、依赖存在性和依赖图无环。
- 已完成 `composite_execution_order` 和 `resolve_composite_step_operation` 准备层，后续执行器可按拓扑顺序执行 step，并只允许 step 引用已声明依赖的结果。
- 已完成 `execute_composite_operation_plan` 执行器，复用统一领域 executor，覆盖已接入基础业务域；库存步骤保留专用结果补全，并通过 savepoint 保证后续步骤失败时回滚已完成步骤；历史 `limited` 命名仅作为兼容入口保留。
- 已完成 `build_composite_operation_step_previews` 后端分步影响预览，按拓扑顺序输出 step 标题、领域/动作文案、依赖引用、影响摘要和预计写入类型，供后续正式审批 DTO 与前端展示复用。
- 已完成 `AiCompositeOperationPreview` 前端只读预览组件，审批面板可展示合成或未来 DTO 中的 step preview，但当前仍不主动生成或提交正式复合审批。
- `composite_operation` 已注册为正式 draft / approval 合同，但仍未注册为 Skill tool；当前决策是不开放给模型直接生成，避免通用复合写入绕过专用 draft tool 的字段校验、候选消歧和用户提示约束。
- 后续如果要开放，应先新增受控组合 draft tool，由 tool 负责把多个已校验基础草稿组合为 `composite_operation.v1`，并补提示约束、领域白名单、回滚体验和端到端测试，而不是让模型直接拼接复合操作 JSON。

## 10. Planner 和 Skill 指令整改

### 10.1 Planner 描述

Planner 仍只负责选择 Skill，但 Skill description 和 examples 要覆盖：

- 查询
- 新增
- 修改
- 删除
- 状态变更
- 复合操作

每个 description 必须写清“不适用范围”，减少错误路由。

### 10.2 Skill 执行规则

每个 `SKILL.md` 应增加统一章节：

```text
适用范围
不适用范围
操作模式
目标定位规则
信息缺失规则
查询规则
草稿规则
确认规则
冲突规则
下游 Skill 衔接
示例
```

### 10.3 目标定位规则

建议所有写操作遵守：

1. 页面 `subject` 提供确定 ID 时优先使用 ID。
2. 没有 ID 时使用精确名称搜索。
3. 精确名称无结果时再使用模糊搜索。
4. 多个候选时必须追问。
5. 找不到目标时不得生成 update/delete 草稿。
6. 新增前检查同名或近似重复项。

## 11. 前端整改

### 11.1 Draft 类型和契约

同步更新：

- `frontend/src/api/types.ts`
- `frontend/src/lib/aiWorkspaceContracts.ts`
- AI Workspace contract tests

迁移期可同时支持旧 Draft 和新 Operation Draft，待后端全部切换后再移除旧类型。

### 11.2 审批面板

审批面板应以操作列表展示：

- 动作类型。
- 目标实体。
- 修改前值。
- 修改后值。
- 删除影响。
- 冲突提示。

高风险动作使用明确按钮：

- “删除菜谱”
- “移除 3 条计划”
- “清理 8 个已完成采购项”

不要把全部结构化草稿退化为 JSON 文本框。

### 11.3 快捷入口

当前欢迎页主要突出推荐、计划、临期和采购。整改后建议增加按能力动态生成的示例：

- 新增食材
- 食材入库
- 修改计划
- 完成购物项
- 修改菜谱
- 记录餐食
- 开始烹饪

桌面端和移动端应复用同一份 suggestion 配置，避免两套文案和能力入口长期漂移。

### 11.4 操作结果反馈

审批成功后应明确显示：

- 成功执行了什么。
- 影响了多少实体。
- 哪些实体被创建、更新或删除。
- 可进入哪个业务页面查看。

失败时应显示：

- 哪一项失败。
- 是否发生版本冲突。
- 当前业务值。
- 可重新生成还是直接修改草稿重试。

## 12. 具体文件改造建议

### 12.1 后端新增文件

```text
backend/app/ai/skills/catalog/ingredient-profile/SKILL.md
backend/app/ai/skills/catalog/ingredient-profile/workflows.md
backend/app/ai/skills/catalog/recipe-cook/SKILL.md
backend/app/ai/skills/catalog/recipe-cook/workflows.md
backend/app/ai/tools/catalog/operation_schemas.py
backend/app/ai/workflows/conversations.py
backend/app/ai/workflows/plan_metadata.py
backend/app/ai/workflows/result_cards.py
backend/app/ai/workflows/run_lifecycle.py
backend/app/ai/workflows/timeline.py
backend/app/services/ai_operations/__init__.py
backend/app/services/ai_operations/approval_config.py
backend/app/services/ai_operations/approval_decisions.py
backend/app/services/ai_operations/approval_requests.py
backend/app/services/ai_operations/approval_values.py
backend/app/services/ai_operations/drafts.py
backend/app/services/ai_operations/ingredients.py
backend/app/services/ai_operations/foods.py
backend/app/services/ai_operations/recipes.py
backend/app/services/ai_operations/inventory.py
backend/app/services/ai_operations/meal_plans.py
backend/app/services/ai_operations/shopping.py
backend/app/services/ai_operations/meal_logs.py
backend/app/services/ai_operations/composite.py
backend/app/services/ai_operations/recovery.py
backend/app/services/ai_operations/executor.py
backend/app/services/ai_operations/experience.py
backend/app/services/ai_operations/messages.py
backend/app/services/ai_quality.py
```

### 12.2 后端重点修改文件

```text
backend/app/ai/skills/catalog/*/SKILL.md
backend/app/ai/skills/catalog/*/workflows.md
backend/app/ai/tools/catalog/food.py
backend/app/ai/tools/catalog/ingredient.py
backend/app/ai/tools/catalog/inventory.py
backend/app/ai/tools/catalog/meal_log.py
backend/app/ai/tools/catalog/meal_plan.py
backend/app/ai/tools/catalog/recipe.py
backend/app/ai/tools/catalog/shopping.py
backend/app/ai/tools/schemas.py
backend/app/ai/tools/draft_validation.py
backend/app/ai/skills/toolcall.py
backend/app/ai/workspace_service.py
backend/app/ai/workflows/runner.py
backend/tests/test_ai_agent_infra.py
```

### 12.3 前端重点修改文件

```text
frontend/src/api/aiApi.ts
frontend/src/api/queryKeys.ts
frontend/src/api/types.ts
frontend/src/lib/aiWorkspaceContracts.ts
frontend/src/components/ai/AiApprovalPanel.tsx
frontend/src/components/ai/AiCompositeOperationPreview.tsx
frontend/src/components/ai/AiQualityDiagnosticsCard.tsx
frontend/src/components/ai/AiResultCards.tsx
frontend/src/components/ai/AiWorkspace.tsx
frontend/src/components/ai/AiMobilePage.tsx
frontend/src/components/ai/AiWorkspace.test.tsx
frontend/src/lib/aiWorkspaceContracts.test.ts
```

建议把欢迎页建议提取到：

```text
frontend/src/components/ai/AiWorkspaceOptions.ts
```

## 13. 数据模型和迁移判断

第一阶段可以使用实体 `updated_at` 做并发保护，不一定需要数据库迁移。

以下能力可能需要后续 migration：

- 购物项增加 `ingredient_id`。
- 购物项需要软删除或完成时间。
- AI 操作需要逐项结果明细表。
- 正式业务实体增加整数版本号。
- 餐食计划从个人计划调整为家庭共享计划。

任何 migration 必须新增版本文件，不修改旧 migration。

## 14. 测试整改

### 14.1 当前测试不足

当前测试较好地覆盖了：

- Skill Registry。
- Tool 白名单。
- Draft Tool 调用要求。
- 审批中断。
- 创建类写入。
- 跨家庭引用拒绝。
- 多 Skill 顺序执行。

但对“基础操作完整覆盖”的证明不足：

- 没有证明计划修改不会新增重复项。
- 没有证明购物项能真实更新和完成。
- 没有食材创建 Skill 流程。
- 没有菜谱更新、删除和烹饪审批。
- 没有正式实体并发冲突测试。
- 没有完整 CRUD 能力矩阵测试。

### 14.2 每个领域必须覆盖的测试

每个操作至少覆盖：

1. 正常生成草稿。
2. 用户拒绝后不写业务表。
3. 用户确认后执行正确动作。
4. 重复确认返回冲突。
5. 跨家庭目标被拒绝。
6. 不存在目标被拒绝。
7. `baseUpdatedAt` 过期被拒绝。
8. 未声明 Tool 被拒绝。
9. Draft 编辑后重新校验。
10. 活动日志和审计字段正确。

### 14.3 关键业务验收用例

#### 食材和库存

- “新增鸡胸肉，默认单位克，冷冻保存”创建食材。
- “入库鸡胸肉 500 克”创建库存批次。
- 组合请求按审批顺序完成两个动作。
- 已有库存时修改主单位被拒绝。

#### 餐食计划

- “把明天晚餐换成番茄炒蛋”更新原计划，不新增第二条。
- “取消后天早餐”删除正确计划项。
- “明天晚餐跳过”只更新状态。
- 不允许修改其他用户的个人计划。

#### 购物清单

- “鸡蛋买到了”更新原购物项 `done=true`。
- “牛奶改成两盒”更新数量，不新增同名项目。
- “清理已完成采购项”删除正确项目。

#### 菜谱

- “把番茄炒蛋改为三人份”更新原菜谱及同步食物。
- “删除测试菜谱”显示影响并在确认后删除。
- “收藏番茄炒蛋”只创建收藏关系。
- “做两人份番茄炒蛋”先预览扣减，再确认烹饪。

#### 餐食记录

- “记录今晚吃了番茄炒蛋”创建记录。
- “补充刚才这餐心情很好”更新已有记录。
- “给番茄炒蛋打 4 分”更新正确食物项评分。

### 14.4 推荐验证命令

实现阶段按改动范围执行：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q
npm --prefix frontend run test -- src/lib/aiWorkspaceContracts.test.ts src/components/ai/AiWorkspace.test.tsx
npm --prefix frontend run check:size
npm --prefix frontend run build
npm --prefix frontend run smoke
```

涉及业务 API Service 抽取时，还应运行：

```bash
npm run backend:test
```

## 15. 分阶段实施计划

### 阶段一：修正语义和基础定位

目标：先消除“看似修改、实际新增”和目标查找不可靠的问题。

任务：

1. 为 food、ingredient、recipe、meal plan、shopping 和 meal log 增加真实搜索条件。
2. 增加 `read_by_id`。
3. 修正餐食计划家庭时区和用户范围。
4. 新增 `ingredient_profile`。
5. 定义 operation draft 通用字段。
6. `meal_plan` 先支持真实 create/update/delete。
7. 增加并发版本校验。
8. 增加对应后端和前端 contract 测试。

阶段验收：

- AI 可以创建食材并继续入库。
- 修改计划不会产生重复项。
- 删除计划会删除指定实体。
- 模糊目标会要求用户消歧。
- 跨家庭和跨用户计划操作被拒绝。

### 阶段二：补齐各领域基础操作

目标：覆盖核心业务对象的常用管理动作。

任务：

1. `food_profile` 支持更新和收藏。
2. `shopping_list` 支持更新、完成、恢复和删除。
3. `meal_log` 支持详情补充和评分。
4. `recipe_draft` 支持更新、删除和收藏。
5. 将正式执行逻辑拆到领域 Service。
6. 审批面板展示 before/after。
7. 建立 CRUD 能力矩阵测试。

阶段验收：

- 用户可以通过对话完成常用基础操作。
- 所有修改和删除都有真实目标 ID。
- 所有操作均有活动日志。
- 所有正式写入均可追踪到 Draft、Approval 和 AIOperation。

### 阶段三：烹饪和复合工作流

目标：打通从菜谱决策到库存和餐食记录的业务闭环。

任务：

1. 新增 `recipe_cook`。
2. 支持烹饪预览和确认扣库存。
3. 支持创建餐食记录和完成计划项。
4. 支持缺料后生成购物清单。
5. 定义 confirmed business artifact。
6. 评估一次性复合审批。

阶段验收：

- 菜谱烹饪前能准确显示缺料和扣减批次。
- 确认后库存、烹饪日志、餐食记录和计划状态保持一致。
- 任一环节失败时整体回滚。

### 阶段四：体验和可观测性

目标：降低用户输入和确认成本，提升问题定位能力。

任务：

1. 欢迎页覆盖完整能力示例。
2. 桌面和移动端复用快捷入口配置。
3. 增加操作成功结果卡片。
4. 增加冲突恢复 UI。
5. 增加 Skill 路由成功率和草稿确认率指标。
6. 记录常见 clarification 原因。

## 16. 优先级清单

### P0

- 已完成：修复餐食计划修改实际新增，餐食计划 operation draft 支持真实目标和状态操作。
- 已完成：修复购物清单修改实际新增，购物清单 operation draft 支持更新、完成、恢复和删除。
- 已完成：增加真实搜索和 `read_by_id`，已覆盖 food、ingredient、recipe、meal plan、shopping 和 meal log 等核心读路径。
- 已完成：增加 `ingredient_profile`。
- 已完成：修正餐食计划时区和用户范围，AI 读取使用 `today_for_family()` 并按当前 `user_id` 过滤。
- 已完成：为 update/delete 增加目标 ID 和版本校验，确认阶段通过 `baseUpdatedAt` 重新校验目标实体。

### P1

- 已完成：购物项完成、恢复、更新、删除。
- 已完成：食物资料更新和收藏。
- 已完成：菜谱更新、删除和收藏。
- 已完成：餐食记录详情补充和评分。
- 已完成：正式写入逻辑拆到领域 Service，并新增审批决策编排 service。
- 已完成：审批面板展示操作差异，支持各 operation 的 `before` / payload 对比和失败 current value 展示。

### P2

- 已完成：跨 Skill 正式业务 artifact。
- 一次性复合审批已接入正式合同和统一领域 executor；当前决策是不开放给 Skill 直接生成，后续仅通过专用组合 draft tool 评估受控开放。
- 本轮不纳入完成定义：动态快捷入口和能力发现。当前已完成桌面/移动端共享欢迎建议配置、隐藏诊断弹窗和后端 registry/quality metrics；后续若要动态入口，应作为独立产品设计项，避免把普通用户入口变成调试型能力列表。
- 基于 run 级统计的隐藏诊断弹窗已完成，入口收敛到桌面 AI 状态胶囊，避免占用普通用户的会话侧栏。
- 如果后续继续收敛烹饪链路，可再单独补充 `recipe_cook` 的更细粒度体验项。

## 17. 完成定义

只有同时满足以下条件，才能认为“AI 覆盖系统基础操作”的整改完成：

1. 核心业务对象的支持能力有明确矩阵。
2. Skill 描述与真实正式写入行为一致。
3. 修改和删除均引用真实业务 ID。
4. 更新操作具有并发冲突保护。
5. 用户确认前不写正式业务表。
6. 用户拒绝后不产生业务副作用。
7. 所有操作限制在当前家庭和正确用户范围。
8. 所有业务写入维护审计字段和活动日志。
9. 每种支持动作都有正常、拒绝、冲突和跨家庭测试。
10. 前端审批面板可以清楚展示动作及影响。
11. 桌面端和移动端都能发起并确认关键操作。
12. 文档、后端 Registry 和前端 contract 保持一致。

### 17.1 完成定义审计表

| # | 完成定义 | 当前结论 | 已有证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
| 1 | 核心业务对象的支持能力有明确矩阵 | 已证明 | 第 3.3 节能力矩阵覆盖食材、库存、食物、菜谱、餐食计划、购物清单、餐食记录和做菜链路。 | 库存批次资料修改、食材/食物/餐食记录删除仍按“不支持”记录。 |
| 2 | Skill 描述与真实正式写入行为一致 | 已证明 | Skill 文档已声明只能通过 draft tool 生成草稿；`test_skill_catalog_scans_skill_markdown_and_enforces_platform_contracts`、`test_approval_config_matrix_maps_supported_actions_to_real_approval_types` 覆盖声明和审批映射。 | 新增 Skill 时仍需继续跑 catalog contract 测试。 |
| 3 | 修改和删除均引用真实业务 ID | 已证明 | `draft_validation.py` 对 update/delete/status 操作加载真实目标；`test_draft_tools_reject_or_normalize_catalog_bound_fields` 和 `test_operation_draft_tools_reject_cross_family_targets` 覆盖目标归属。 | 不支持删除的领域不得在 Skill 中宣称删除。 |
| 4 | 更新操作具有并发冲突保护 | 已证明 | operation draft 统一携带 `baseUpdatedAt`；正式执行使用 `assert_updated_at_matches`；`test_ai_workspace_approval_rejects_stale_draft_version` 和 retry approval 测试覆盖冲突恢复。 | 未来新增 action 必须同步接入 `baseUpdatedAt`。 |
| 5 | 用户确认前不写正式业务表 | 已证明 | Tool side effect 区分 read/draft/write；Skill 执行器禁止未声明和 forbidden write；审批前只生成 `AITaskDraft` / `AIApprovalRequest`。 | 需继续禁止模型直接调用正式 Service。 |
| 6 | 用户拒绝后不产生业务副作用 | 已证明 | `test_ai_workspace_reject_does_not_validate_broken_recipe_payload`、`test_ai_workspace_approval_rejection_stream_returns_result_to_model` 覆盖拒绝路径。 | 拒绝后的用户提示仍可继续优化。 |
| 7 | 所有操作限制在当前家庭和正确用户范围 | 已证明 | search/read_by_id 按 `family_id` 过滤；餐食计划按 `user_id` 过滤；新增 `test_operation_draft_tools_reject_cross_family_targets` 覆盖 operation draft 跨家庭/跨用户目标拒绝。 | 家庭共享计划若产品定义变更，需要同步更新 AI Tool 范围。 |
| 8 | 所有业务写入维护审计字段和活动日志 | 已证明 | `test_ai_approval_business_writes_record_audit_fields_and_activity_logs` 通过正式 `_create_draft_approval -> _apply_approval_decision` 路径覆盖食材、食物、菜谱、餐食计划、购物清单、餐食记录、库存和做菜写入，逐项断言业务实体 `created_by` / `updated_by`、`AIUserApproval`、`AIOperation` 和 `ActivityLog`。 | 未来新增写入领域必须同步加入该矩阵。 |
| 9 | 每种支持动作都有正常、拒绝、冲突和跨家庭测试 | 已证明 | 正常路径由各领域 operation 测试和 `test_ai_approval_business_writes_record_audit_fields_and_activity_logs` 覆盖；拒绝路径由 `test_ai_workspace_reject_does_not_validate_broken_recipe_payload`、`test_ai_workspace_approval_rejection_stream_returns_result_to_model` 覆盖；正式业务目标并发冲突由 `test_target_bound_operation_approvals_create_retry_on_stale_base_updated_at` 覆盖食材、食物、菜谱、餐食计划、购物清单、餐食记录和做菜；跨家庭/跨用户目标由 `test_operation_draft_tools_reject_cross_family_targets`、`test_inventory_operation_draft_normalizes_real_entities_and_rejects_cross_family_items` 和 `test_ai_workspace_phase3_rejects_cross_family_food_in_meal_plan` 覆盖。 | create 类动作没有 `targetId` / `baseUpdatedAt`，冲突与跨家庭主要通过其引用的食材、食物、计划等业务 ID 校验体现。 |
| 10 | 前端审批面板可以清楚展示动作及影响 | 已证明 | `AiApprovalPanel.tsx` 覆盖 recipe、recipe_cook、meal_plan、shopping_list、meal_log、food_profile、ingredient_profile、inventory_operation、composite_operation 的结构化展示；`AiWorkspace.test.tsx` 和 `AiResultCards.test.tsx` 覆盖 before/after、结果卡和诊断弹窗。 | 新增 draftType 时需同步前端渲染和 contract 测试。 |
| 11 | 桌面端和移动端都能发起并确认关键操作 | 已证明 | `AI_WELCOME_SUGGESTIONS` 在 `AiWorkspace.tsx` 和 `AiMobilePage.tsx` 共享；`aiWelcomeSuggestions.test.ts` 覆盖整改能力快捷入口配置。 | 移动端端到端 smoke 仍应在发布前跑。 |
| 12 | 文档、后端 Registry 和前端 contract 保持一致 | 已证明 | `test_ai_registry_endpoint_exposes_skill_and_tool_contracts`、`frontend/src/lib/aiWorkspaceContracts.test.ts` 覆盖 registry/type 字面量一致性。 | 后续 schema 新增字段仍需同步前后端 contract。 |

## 18. 实施注意事项

- 不应一次性引入一个无边界的通用 CRUD Skill。
- 不应把 FastAPI 路由直接作为 AI Tool handler。
- 不应允许模型自由决定正式操作类型。
- 不应仅依赖实体名称执行修改或删除。
- 不应让修改类草稿继续复用创建提交逻辑。
- 不应为了减少确认次数绕过审批。
- 不应先做复合操作，再补单领域幂等和事务。
- 不应把业务校验只写进 `SKILL.md`；关键规则必须由后端强制执行。

推荐先从 `ingredient_profile` 和 `meal_plan_operation` 两条链路开始实施。前者补齐当前最大的实体能力空白，后者可以验证新的 create/update/delete 操作模型是否正确，再逐步推广到其他业务域。
